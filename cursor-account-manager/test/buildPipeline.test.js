'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExtension,
  compareDist
} = require('../scripts/build-extension');
const {
  assertPackageFileList,
  assertSafePackageSources,
  vsixFileName
} = require('../scripts/check-package-files');
const {
  assertContentHashes,
  assertContentTypes,
  assertLocalHeader,
  assertManifestIdentity,
  assertVsixEntries,
  assertZipEntryType,
  safeEntryName
} = require('../scripts/verify-vsix');

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cam-build-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'src', 'extension.js'), '"use strict";\n');
  await fs.promises.writeFile(path.join(root, 'src', 'nested', 'helper.js'), 'module.exports = 1;\n');
  await fs.promises.writeFile(path.join(root, 'src', 'ignored.txt'), 'not runtime code\n');
  await fs.promises.writeFile(path.join(root, 'dist', 'stale.js'), 'stale\n');
  return root;
}

function zipEntry(fileName) {
  return {
    fileName,
    versionMadeBy: 3 << 8,
    externalFileAttributes: 0o100644 << 16
  };
}

test('递归构建通过暂存目录替换 dist，并删除旧文件', async t => {
  const root = await fixture(t);
  const result = await buildExtension({ root });

  assert.deepEqual(result.files, ['extension.js', 'nested/helper.js']);
  assert.equal(
    await fs.promises.readFile(path.join(root, 'dist', 'nested', 'helper.js'), 'utf8'),
    'module.exports = 1;\n'
  );
  await assert.rejects(fs.promises.stat(path.join(root, 'dist', 'stale.js')), { code: 'ENOENT' });
  assert.deepEqual(await compareDist(root), {
    ok: true,
    missing: [],
    extra: [],
    changed: []
  });
});

test('dist 漂移检查分别报告缺失、额外和内容变化', async t => {
  const root = await fixture(t);
  await buildExtension({ root });
  await fs.promises.rm(path.join(root, 'dist', 'nested', 'helper.js'));
  await fs.promises.writeFile(path.join(root, 'dist', 'extension.js'), 'changed\n');
  await fs.promises.writeFile(path.join(root, 'dist', 'extra.js'), 'extra\n');

  const compared = await compareDist(root);
  assert.equal(compared.ok, false);
  assert.deepEqual(compared.missing, ['nested/helper.js']);
  assert.deepEqual(compared.extra, ['extra.js']);
  assert.deepEqual(compared.changed, ['extension.js']);
});

test('构建拒绝源码符号链接，且保留原 dist', async t => {
  const root = await fixture(t);
  try {
    await fs.promises.symlink(
      path.join(root, 'src', 'extension.js'),
      path.join(root, 'src', 'linked.js')
    );
  }
  catch (error) {
    if (process.platform === 'win32' && error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('当前 Windows 环境不允许创建测试符号链接');
      return;
    }
    throw error;
  }

  await assert.rejects(buildExtension({ root }), /symbolic link/);
  assert.equal(await fs.promises.readFile(path.join(root, 'dist', 'stale.js'), 'utf8'), 'stale\n');
});

test('并发构建由同一个生命周期锁串行拒绝', async t => {
  const root = await fixture(t);
  const results = await Promise.allSettled([
    buildExtension({ root }),
    buildExtension({ root })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result =>
    result.status === 'rejected' &&
    /another build owns/.test(result.reason && result.reason.message)
  ).length, 1);
  assert.equal((await compareDist(root)).ok, true);
});

test('打包文件列表必须与白名单完全一致并拒绝敏感文件', () => {
  const expected = ['package.json', 'dist/extension.js', 'media/webview.js'];
  assert.deepEqual(
    assertPackageFileList(expected, expected),
    expected.slice().sort()
  );
  assert.throws(
    () => assertPackageFileList(expected.concat('src/extension.js'), expected),
    /unexpected/
  );
  assert.throws(
    () => assertPackageFileList(expected.concat('.env.production'), expected.concat('.env.production')),
    /sensitive/
  );
});

test('静态打包输入拒绝符号链接，VSCE 重命名显式规范化', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cam-package-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside.js');
  const media = path.join(root, 'media');
  await fs.promises.mkdir(media);
  await fs.promises.writeFile(outside, 'secret\n');
  await fs.promises.symlink(outside, path.join(media, 'webview.js'));

  await assert.rejects(
    assertSafePackageSources(['media/webview.js'], root),
    /symbolic link/
  );
  assert.equal(vsixFileName('LICENSE'), 'LICENSE.txt');
  assert.equal(vsixFileName('README.md'), 'readme.md');
});

test('VSIX 清单只接受固定根文件和 extension 白名单', () => {
  const expected = ['package.json', 'dist/extension.js'];
  const entries = [
    zipEntry('[Content_Types].xml'),
    zipEntry('extension.vsixmanifest'),
    zipEntry('extension/package.json'),
    zipEntry('extension/dist/extension.js')
  ];
  assert.equal(assertVsixEntries(entries, expected).length, 4);
  assert.throws(() => safeEntryName('extension/../secret'), /unsafe/);
  assert.throws(
    () => assertVsixEntries(entries.concat(zipEntry('extension/src/extension.js')), expected),
    /unexpected/
  );
  assert.throws(
    () => assertVsixEntries(entries.concat(zipEntry('extension/package.json')), expected),
    /duplicate/
  );
  assert.throws(
    () => assertVsixEntries(entries.concat(zipEntry('extension/package.json/')), expected),
    /directory entr(?:y|ies)/
  );
});

test('VSIX 校验拒绝符号链接类型及同名内容篡改', () => {
  assert.throws(() => assertZipEntryType({
    fileName: 'extension/dist/extension.js',
    versionMadeBy: 3 << 8,
    externalFileAttributes: 0o120777 << 16
  }), /symbolic link/);
  assert.doesNotThrow(() => assertZipEntryType({
    fileName: 'extension/dist/extension.js',
    versionMadeBy: 3 << 8,
    externalFileAttributes: 0o100644 << 16
  }));
  assert.doesNotThrow(() => assertContentHashes(
    { 'dist/extension.js': 'abc' },
    { 'dist/extension.js': 'abc' }
  ));
  assert.throws(() => assertContentHashes(
    { 'dist/extension.js': 'tampered' },
    { 'dist/extension.js': 'expected' }
  ), /differs/);
});

test('VSIX manifest 通过 XML 结构验证唯一身份节点', async () => {
  const manifest = require('../package.json');
  const repositoryUrl = manifest.repository.url;
  const repositoryBase = repositoryUrl.replace(/\.git$/i, '');
  const properties = {
    'Microsoft.VisualStudio.Code.Engine': manifest.engines.vscode,
    'Microsoft.VisualStudio.Code.ExtensionDependencies': '',
    'Microsoft.VisualStudio.Code.ExtensionPack': '',
    'Microsoft.VisualStudio.Code.ExtensionKind': 'workspace',
    'Microsoft.VisualStudio.Code.LocalizedLanguages': '',
    'Microsoft.VisualStudio.Code.EnabledApiProposals': '',
    'Microsoft.VisualStudio.Code.ExecutesCode': 'true',
    'Microsoft.VisualStudio.Services.Links.Source': repositoryUrl,
    'Microsoft.VisualStudio.Services.Links.Getstarted': repositoryUrl,
    'Microsoft.VisualStudio.Services.Links.GitHub': repositoryUrl,
    'Microsoft.VisualStudio.Services.Links.Support': `${repositoryBase}/issues`,
    'Microsoft.VisualStudio.Services.Links.Learn': `${repositoryBase}#readme`,
    'Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown': 'true',
    'Microsoft.VisualStudio.Services.Content.Pricing': 'Free'
  };
  const propertyXml = Object.entries(properties)
    .map(([Id, Value]) => `<Property Id="${Id}" Value="${Value}"/>`)
    .join('');
  const valid = '<?xml version="1.0"?>' +
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" ' +
    'xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">' +
    '<Metadata>' +
    `<Identity Language="en-US" Publisher="${manifest.publisher}" Version="${manifest.version}" Id="${manifest.name}"/>` +
    `<DisplayName>${manifest.displayName}</DisplayName>` +
    `<Description>${manifest.description}</Description>` +
    `<Tags>${manifest.keywords.join(',')}</Tags>` +
    `<Categories>${manifest.categories.join(',')}</Categories>` +
    '<GalleryFlags>Public</GalleryFlags>' +
    `<Properties>${propertyXml}</Properties>` +
    '<License>extension/LICENSE.txt</License>' +
    `<Icon>extension/${manifest.icon}</Icon>` +
    '</Metadata>' +
    '<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>' +
    '<Dependencies/>' +
    '<Assets>' +
    '<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>' +
    '<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true"/>' +
    '<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/>' +
    `<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${manifest.icon}" Addressable="true"/>` +
    '</Assets></PackageManifest>';
  await assert.doesNotReject(assertManifestIdentity(
    valid,
    manifest
  ));
  await assert.rejects(assertManifestIdentity(
    valid.replace(`Id="${manifest.name}"`, 'Id="wrong"'),
    manifest
  ), /does not match/);
  await assert.rejects(assertManifestIdentity(
    '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]>' +
      valid,
    manifest
  ), /unsafe/);
  await assert.rejects(
    assertManifestIdentity(
      valid.replace('<Metadata>', '<d:Metadata>').replace('</Metadata>', '</d:Metadata>'),
      manifest
    ),
    /unexpected namespace/
  );
});

test('VSIX Content_Types 必须精确覆盖归档扩展名', async () => {
  const xml = '<?xml version="1.0"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension=".json" ContentType="application/json"/>' +
    '<Default Extension=".vsixmanifest" ContentType="text/xml"/>' +
    '</Types>';
  const names = [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/package.json'
  ];
  await assert.doesNotReject(assertContentTypes(xml, names));
  await assert.rejects(
    assertContentTypes(xml.replace('application/json', 'text/plain'), names),
    /does not match/
  );
  await assert.rejects(
    assertContentTypes(xml.replace('<Default', '<xml:Default'), names),
    /unexpected namespace/
  );
});

test('VSIX 本地头文件名必须与中央目录原始字节一致', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cam-zip-header-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'fixture.zip');
  const centralName = Buffer.from('extension/package.json', 'ascii');
  const localName = Buffer.from('extension\\package.json', 'ascii');
  const header = Buffer.alloc(30 + localName.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(localName.length, 26);
  header.writeUInt16LE(0, 28);
  localName.copy(header, 30);
  await fs.promises.writeFile(archive, header);

  await assert.rejects(assertLocalHeader(archive, {
    fileName: 'extension/package.json',
    fileNameRaw: centralName,
    generalPurposeBitFlag: 0,
    compressionMethod: 0,
    relativeOffsetOfLocalHeader: 0
  }), /local filename differs/);
});
