'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseStringPromise } = require('xml2js');
const yauzl = require('yauzl');
const {
  assertPackageFileList,
  assertSafePackageSources,
  expectedFiles,
  expectedVsixFiles,
  vsixFileName
} = require('./check-package-files');

const root = path.resolve(__dirname, '..');
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

function safeEntryName(value) {
  const name = String(value || '');
  if (!name ||
      name !== name.normalize('NFC') ||
      name.includes('\\') ||
      /[\0-\x1f\x7f]/.test(name) ||
      name.startsWith('/'))
    throw new Error(`unsafe VSIX entry name: ${JSON.stringify(name)}`);
  const core = name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = core.split('/');
  if (segments.some(segment =>
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes(':') ||
    /[. ]$/.test(segment)))
    throw new Error(`unsafe VSIX entry path: ${name}`);
  return name;
}

function assertZipEntryType(entry) {
  const madeBy = Number(entry.versionMadeBy) || 0;
  const platform = (madeBy >>> 8) & 0xff;
  const attributes = Number(entry.externalFileAttributes) >>> 0;
  const mode = (attributes >>> 16) & 0xffff;
  const type = mode & 0o170000;
  const directory = String(entry.fileName || '').endsWith('/');
  if (type === 0o120000)
    throw new Error(`VSIX symbolic link entry is not allowed: ${entry.fileName}`);
  if ((attributes & 0x400) !== 0)
    throw new Error(`VSIX reparse-point entry is not allowed: ${entry.fileName}`);
  if (directory || (attributes & 0x10) !== 0)
    throw new Error(`VSIX directory entry is not allowed: ${entry.fileName}`);
  if (platform !== 3 || type !== 0o100000)
    throw new Error(`VSIX special file entry is not allowed: ${entry.fileName}`);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function vsixSnapshot(file) {
  const handle = await fs.promises.open(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new Error('VSIX path is not a standalone regular file');
    const data = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        data.length !== after.size) {
      throw new Error('VSIX changed while being read');
    }
    return {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      sha256: sha256(data)
    };
  }
  finally {
    await handle.close();
  }
}

function sameVsixSnapshot(left, right) {
  return !!left && !!right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256;
}

function assertVsixEntries(entries, expectedExtensionFiles) {
  for (const entry of entries) {
    safeEntryName(entry.fileName);
    assertZipEntryType(entry);
    if (entry.fileName.endsWith('/'))
      throw new Error(`VSIX directory entries are not allowed: ${entry.fileName}`);
  }
  const allNames = entries.map(entry => entry.fileName);
  if (new Set(allNames).size !== allNames.length)
    throw new Error('VSIX contains duplicate entries');
  const portableNames = allNames.map(name => name.normalize('NFC').toLowerCase());
  if (new Set(portableNames).size !== portableNames.length)
    throw new Error('VSIX contains names that collide on a portable filesystem');
  const names = entries
    .filter(entry => !String(entry.fileName || '').endsWith('/'))
    .map(entry => entry.fileName);
  const rootFiles = names.filter(name => !name.startsWith('extension/')).sort();
  const expectedRoot = ['[Content_Types].xml', 'extension.vsixmanifest'];
  if (JSON.stringify(rootFiles) !== JSON.stringify(expectedRoot))
    throw new Error(`unexpected VSIX root files: ${JSON.stringify(rootFiles)}`);
  const extensionFiles = names
    .filter(name => name.startsWith('extension/'))
    .map(name => name.slice('extension/'.length));
  assertPackageFileList(extensionFiles, expectedExtensionFiles);
  return names;
}

function xmlLocalName(name) {
  const text = String(name || '');
  const colon = text.lastIndexOf(':');
  return colon === -1 ? text : text.slice(colon + 1);
}

function directXmlChildren(node, localName) {
  if (!node || typeof node !== 'object')
    return [];
  return Object.entries(node)
    .filter(([name]) => name !== '$' && name !== '_' && xmlLocalName(name) === localName)
    .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
}

function xmlText(node) {
  if (typeof node === 'string')
    return node;
  if (node && typeof node._ === 'string')
    return node._;
  return '';
}

function exactStringMap(actual, expected, label) {
  const normalized = Object.fromEntries(
    Object.entries(actual || {}).map(([key, value]) => [key, String(value)])
  );
  if (JSON.stringify(Object.entries(normalized).sort()) !==
      JSON.stringify(Object.entries(expected).sort())) {
    throw new Error(`VSIX manifest ${label} does not match package.json`);
  }
}

async function assertXmlNamespaces(xml, rootLocalName, expectedUri, label) {
  let parsed;
  try {
    parsed = await parseStringPromise(xml, {
      explicitArray: true,
      strict: true,
      xmlns: true,
      trim: false,
      normalize: false,
      normalizeTags: false
    });
  }
  catch (error) {
    throw new Error(`${label} namespace parse failed: ${error.message}`);
  }
  const roots = Object.entries(parsed)
    .filter(([name]) => xmlLocalName(name) === rootLocalName);
  if (roots.length !== 1 || Object.keys(parsed).length !== 1)
    throw new Error(`${label} namespace root is invalid`);
  const visit = node => {
    if (!node || typeof node !== 'object')
      return;
    if (!node.$ns || node.$ns.uri !== expectedUri)
      throw new Error(`${label} contains an element in an unexpected namespace`);
    for (const [name, value] of Object.entries(node)) {
      if (name === '$' || name === '_' || name === '$ns')
        continue;
      for (const child of Array.isArray(value) ? value : [value])
        visit(child);
    }
  };
  visit(roots[0][1]);
}

async function assertManifestIdentity(xml, manifest) {
  if (typeof xml !== 'string' ||
      !xml.trim() ||
      /<!DOCTYPE/i.test(xml) ||
      /<!ENTITY/i.test(xml)) {
    throw new Error('VSIX manifest is missing or unsafe');
  }
  await assertXmlNamespaces(
    xml,
    'PackageManifest',
    'http://schemas.microsoft.com/developer/vsx-schema/2011',
    'VSIX manifest'
  );
  let parsed;
  try {
    parsed = await parseStringPromise(xml, {
      explicitArray: true,
      strict: true,
      trim: false,
      normalize: false,
      normalizeTags: false
    });
  }
  catch (error) {
    throw new Error(`VSIX manifest XML is invalid: ${error.message}`);
  }
  const rootEntries = Object.entries(parsed)
    .filter(([name]) => xmlLocalName(name) === 'PackageManifest');
  if (rootEntries.length !== 1 || Object.keys(parsed).length !== 1)
    throw new Error('VSIX manifest root must be PackageManifest');
  const packageManifest = rootEntries[0][1];
  const rootNamespace = packageManifest && packageManifest.$ &&
    (packageManifest.$.xmlns || packageManifest.$['xmlns']);
  if (rootNamespace !== 'http://schemas.microsoft.com/developer/vsx-schema/2011')
    throw new Error('VSIX manifest namespace is invalid');
  const rootChildNames = Object.keys(packageManifest)
    .filter(name => name !== '$' && name !== '_')
    .map(xmlLocalName)
    .sort();
  if (JSON.stringify(rootChildNames) !==
      JSON.stringify(['Assets', 'Dependencies', 'Installation', 'Metadata'])) {
    throw new Error('VSIX manifest has unexpected root elements');
  }
  exactStringMap(packageManifest.$, {
    Version: '2.0.0',
    xmlns: 'http://schemas.microsoft.com/developer/vsx-schema/2011',
    'xmlns:d': 'http://schemas.microsoft.com/developer/vsx-schema-design/2011'
  }, 'root attributes');
  const metadataKeys = Object.keys(packageManifest)
    .filter(name => name !== '$' && xmlLocalName(name) === 'Metadata');
  const metadataNodes = metadataKeys.flatMap(name => packageManifest[name]);
  if (metadataNodes.length !== 1)
    throw new Error('VSIX manifest must contain exactly one Metadata element');
  const metadata = metadataNodes[0];
  const identityKeys = Object.keys(metadata || {})
    .filter(name => name !== '$' && xmlLocalName(name) === 'Identity');
  const identities = identityKeys.flatMap(name => metadata[name]);
  if (identities.length !== 1)
    throw new Error('VSIX manifest must contain exactly one Identity element');
  const attributes = identities[0] && identities[0].$;
  if (!attributes ||
      attributes.Id !== manifest.name ||
      attributes.Version !== manifest.version ||
      attributes.Publisher !== manifest.publisher) {
    throw new Error('VSIX manifest identity does not match package.json');
  }
  exactStringMap(attributes, {
    Language: 'en-US',
    Id: manifest.name,
    Version: manifest.version,
    Publisher: manifest.publisher
  }, 'Identity attributes');

  const textValue = name => {
    const nodes = directXmlChildren(metadata, name);
    if (nodes.length !== 1)
      throw new Error(`VSIX manifest Metadata/${name} is missing or duplicated`);
    return xmlText(nodes[0]);
  };
  if (textValue('DisplayName') !== manifest.displayName ||
      textValue('Description') !== manifest.description ||
      textValue('Tags') !== (manifest.keywords || []).join(',') ||
      textValue('Categories') !== (manifest.categories || []).join(',') ||
      textValue('GalleryFlags') !== 'Public' ||
      textValue('License') !== 'extension/LICENSE.txt' ||
      textValue('Icon') !== `extension/${manifest.icon}`) {
    throw new Error('VSIX manifest metadata does not match package.json');
  }
  const metadataChildNames = Object.keys(metadata)
    .filter(name => name !== '$' && name !== '_')
    .map(xmlLocalName)
    .sort();
  if (JSON.stringify(metadataChildNames) !== JSON.stringify([
    'Categories',
    'Description',
    'DisplayName',
    'GalleryFlags',
    'Icon',
    'Identity',
    'License',
    'Properties',
    'Tags'
  ])) {
    throw new Error('VSIX manifest has unexpected Metadata elements');
  }

  const propertiesNodes = directXmlChildren(metadata, 'Properties');
  if (propertiesNodes.length !== 1)
    throw new Error('VSIX manifest Properties is missing or duplicated');
  const properties = {};
  for (const property of directXmlChildren(propertiesNodes[0], 'Property')) {
    if (!property.$ ||
        typeof property.$.Id !== 'string' ||
        typeof property.$.Value !== 'string' ||
        Object.prototype.hasOwnProperty.call(properties, property.$.Id)) {
      throw new Error('VSIX manifest contains an invalid Property');
    }
    properties[property.$.Id] = property.$.Value;
  }
  const repositoryUrl = manifest.repository && manifest.repository.url;
  const repositoryBase = String(repositoryUrl || '').replace(/\.git$/i, '');
  exactStringMap(properties, {
    'Microsoft.VisualStudio.Code.Engine': manifest.engines.vscode,
    'Microsoft.VisualStudio.Code.ExtensionDependencies': (manifest.extensionDependencies || []).join(','),
    'Microsoft.VisualStudio.Code.ExtensionPack': (manifest.extensionPack || []).join(','),
    'Microsoft.VisualStudio.Code.ExtensionKind': 'workspace',
    'Microsoft.VisualStudio.Code.LocalizedLanguages': '',
    'Microsoft.VisualStudio.Code.EnabledApiProposals': (manifest.enabledApiProposals || []).join(','),
    'Microsoft.VisualStudio.Code.ExecutesCode': 'true',
    'Microsoft.VisualStudio.Services.Links.Source': repositoryUrl,
    'Microsoft.VisualStudio.Services.Links.Getstarted': repositoryUrl,
    'Microsoft.VisualStudio.Services.Links.GitHub': repositoryUrl,
    'Microsoft.VisualStudio.Services.Links.Support': `${repositoryBase}/issues`,
    'Microsoft.VisualStudio.Services.Links.Learn': `${repositoryBase}#readme`,
    'Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown': 'true',
    'Microsoft.VisualStudio.Services.Content.Pricing': 'Free'
  }, 'Properties');

  const installation = directXmlChildren(packageManifest, 'Installation');
  const targets = installation.length === 1
    ? directXmlChildren(installation[0], 'InstallationTarget')
    : [];
  if (targets.length !== 1)
    throw new Error('VSIX manifest InstallationTarget is missing or duplicated');
  exactStringMap(targets[0].$, {
    Id: 'Microsoft.VisualStudio.Code'
  }, 'InstallationTarget');

  const dependencies = directXmlChildren(packageManifest, 'Dependencies');
  if (dependencies.length !== 1 ||
      Object.keys(dependencies[0] || {}).some(name => name !== '$' && name !== '_')) {
    throw new Error('VSIX manifest Dependencies does not match package.json');
  }

  const assetsNodes = directXmlChildren(packageManifest, 'Assets');
  if (assetsNodes.length !== 1)
    throw new Error('VSIX manifest Assets is missing or duplicated');
  const assets = {};
  for (const asset of directXmlChildren(assetsNodes[0], 'Asset')) {
    if (!asset.$ ||
        typeof asset.$.Type !== 'string' ||
        Object.prototype.hasOwnProperty.call(assets, asset.$.Type)) {
      throw new Error('VSIX manifest contains an invalid Asset');
    }
    assets[asset.$.Type] = `${asset.$.Path}|${asset.$.Addressable}`;
  }
  exactStringMap(assets, {
    'Microsoft.VisualStudio.Code.Manifest': 'extension/package.json|true',
    'Microsoft.VisualStudio.Services.Content.Details': 'extension/readme.md|true',
    'Microsoft.VisualStudio.Services.Content.License': 'extension/LICENSE.txt|true',
    'Microsoft.VisualStudio.Services.Icons.Default': `extension/${manifest.icon}|true`
  }, 'Assets');
}

async function assertContentTypes(xml, entryNames) {
  if (typeof xml !== 'string' ||
      !xml.trim() ||
      /<!DOCTYPE/i.test(xml) ||
      /<!ENTITY/i.test(xml)) {
    throw new Error('VSIX content types XML is missing or unsafe');
  }
  await assertXmlNamespaces(
    xml,
    'Types',
    'http://schemas.openxmlformats.org/package/2006/content-types',
    'VSIX content types'
  );
  let parsed;
  try {
    parsed = await parseStringPromise(xml, {
      explicitArray: true,
      strict: true,
      trim: false,
      normalize: false,
      normalizeTags: false
    });
  }
  catch (error) {
    throw new Error(`VSIX content types XML is invalid: ${error.message}`);
  }
  const roots = Object.entries(parsed)
    .filter(([name]) => xmlLocalName(name) === 'Types');
  if (roots.length !== 1 || Object.keys(parsed).length !== 1)
    throw new Error('VSIX content types root must be Types');
  const types = roots[0][1];
  exactStringMap(types.$, {
    xmlns: 'http://schemas.openxmlformats.org/package/2006/content-types'
  }, 'content types root attributes');
  const childNames = Object.keys(types)
    .filter(name => name !== '$' && name !== '_')
    .map(xmlLocalName);
  if (childNames.some(name => name !== 'Default'))
    throw new Error('VSIX content types contains unexpected elements');
  const actual = {};
  for (const item of directXmlChildren(types, 'Default')) {
    if (!item.$ ||
        typeof item.$.Extension !== 'string' ||
        typeof item.$.ContentType !== 'string' ||
        Object.prototype.hasOwnProperty.call(actual, item.$.Extension)) {
      throw new Error('VSIX content types contains an invalid Default');
    }
    exactStringMap(item.$, {
      Extension: item.$.Extension,
      ContentType: item.$.ContentType
    }, 'content type attributes');
    actual[item.$.Extension] = item.$.ContentType;
  }
  const known = {
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.vsixmanifest': 'text/xml',
    '.xml': 'text/xml'
  };
  const expected = {};
  for (const name of entryNames) {
    if (name === '[Content_Types].xml')
      continue;
    const extension = path.extname(name).toLowerCase();
    if (!extension || !known[extension])
      throw new Error(`VSIX file extension has no approved content type: ${name}`);
    expected[extension] = known[extension];
  }
  exactStringMap(actual, expected, 'content types');
}

async function expectedContentHashes(baseRoot = root) {
  const sourceNames = await expectedFiles(baseRoot);
  await assertSafePackageSources(sourceNames, baseRoot);
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(baseRoot, 'package.json'), 'utf8')
  );
  const repositoryUrl = manifest.repository && manifest.repository.url;
  const repositoryBase = typeof repositoryUrl === 'string'
    ? repositoryUrl.replace(/\.git$/i, '').replace(/\/+$/, '')
    : '';
  const entries = await Promise.all(sourceNames.map(async sourceName => {
    let data = await fs.promises.readFile(path.join(baseRoot, sourceName));
    if (sourceName === 'README.md') {
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(repositoryBase))
        throw new Error('README packaging requires a canonical GitHub repository URL');
      const text = data.toString('utf8').replace(
        /\]\(((?![a-z]+:|#|\/)[^)]+)\)/gi,
        (_match, target) => `](${repositoryBase}/blob/HEAD/${target})`
      );
      data = Buffer.from(text, 'utf8');
    }
    return [vsixFileName(sourceName), sha256(data)];
  }));
  return Object.fromEntries(entries);
}

function assertContentHashes(actual, expected) {
  const actualNames = Object.keys(actual).sort();
  const expectedNames = Object.keys(expected).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
    throw new Error('VSIX content hash set does not match expected files');
  for (const name of expectedNames) {
    if (actual[name] !== expected[name])
      throw new Error(`VSIX content differs from verified source: ${name}`);
  }
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks = [];
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_ENTRY_BYTES) {
          stream.destroy(new Error(`VSIX entry exceeds limit: ${entry.fileName}`));
          return;
        }
        chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function assertLocalHeader(file, entry) {
  if (!Number.isSafeInteger(entry.relativeOffsetOfLocalHeader) ||
      entry.relativeOffsetOfLocalHeader < 0) {
    throw new Error(`VSIX local header offset is invalid: ${entry.fileName}`);
  }
  const handle = await fs.promises.open(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const fixed = Buffer.alloc(30);
    const fixedRead = await handle.read(
      fixed,
      0,
      fixed.length,
      entry.relativeOffsetOfLocalHeader
    );
    if (fixedRead.bytesRead !== fixed.length || fixed.readUInt32LE(0) !== 0x04034b50)
      throw new Error(`VSIX local header is invalid: ${entry.fileName}`);
    const flags = fixed.readUInt16LE(6);
    const compressionMethod = fixed.readUInt16LE(8);
    const fileNameLength = fixed.readUInt16LE(26);
    const extraLength = fixed.readUInt16LE(28);
    if (flags !== entry.generalPurposeBitFlag ||
        compressionMethod !== entry.compressionMethod ||
        fileNameLength !== entry.fileNameRaw.length) {
      throw new Error(`VSIX local and central headers differ: ${entry.fileName}`);
    }
    const variable = Buffer.alloc(fileNameLength + extraLength);
    const variableRead = await handle.read(
      variable,
      0,
      variable.length,
      entry.relativeOffsetOfLocalHeader + fixed.length
    );
    if (variableRead.bytesRead !== variable.length ||
        !variable.subarray(0, fileNameLength).equals(entry.fileNameRaw)) {
      throw new Error(`VSIX local filename differs from central directory: ${entry.fileName}`);
    }
  }
  finally {
    await handle.close();
  }
}

function inspectVsix(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, {
      lazyEntries: true,
      autoClose: true,
      strictFileNames: true
    }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      const entries = [];
      let packageJson = null;
      let vsixManifest = null;
      let contentTypes = null;
      const extensionHashes = {};
      let total = 0;
      let settled = false;
      const fail = error => {
        if (settled)
          return;
        settled = true;
        try { zip.close(); } catch {}
        reject(error);
      };
      zip.once('error', fail);
      zip.on('entry', async entry => {
        try {
          safeEntryName(entry.fileName);
          if (!Buffer.isBuffer(entry.fileNameRaw) ||
              !/^[\x21-\x7e]+$/.test(entry.fileNameRaw.toString('latin1')) ||
              entry.fileNameRaw.toString('ascii') !== entry.fileName) {
            throw new Error(`VSIX raw entry name is not canonical ASCII: ${entry.fileName}`);
          }
          if (entry.fileName.endsWith('/'))
            throw new Error(`VSIX directory entries are not allowed: ${entry.fileName}`);
          await assertLocalHeader(file, entry);
          assertZipEntryType(entry);
          if ((entry.generalPurposeBitFlag & 0x1) !== 0)
            throw new Error(`encrypted VSIX entry is not allowed: ${entry.fileName}`);
          if (entry.uncompressedSize > MAX_ENTRY_BYTES)
            throw new Error(`VSIX entry exceeds limit: ${entry.fileName}`);
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL_BYTES)
            throw new Error('VSIX uncompressed size exceeds limit');
          entries.push(entry);
          if (!entry.fileName.endsWith('/')) {
            const data = await readEntry(zip, entry);
            if (entry.fileName.startsWith('extension/')) {
              const relative = entry.fileName.slice('extension/'.length);
              extensionHashes[relative] = sha256(data);
            }
            if (entry.fileName === 'extension/package.json')
              packageJson = JSON.parse(data.toString('utf8'));
            if (entry.fileName === 'extension.vsixmanifest')
              vsixManifest = data.toString('utf8');
            if (entry.fileName === '[Content_Types].xml')
              contentTypes = data.toString('utf8');
          }
          zip.readEntry();
        }
        catch (error) {
          fail(error);
        }
      });
      zip.once('end', () => {
        if (settled)
          return;
        settled = true;
        resolve({
          contentTypes,
          entries,
          extensionHashes,
          packageJson,
          total,
          vsixManifest
        });
      });
      zip.readEntry();
    });
  });
}

async function verifyVsix(file, options = {}) {
  const baseRoot = path.resolve(options.root || root);
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(baseRoot, 'package.json'), 'utf8')
  );
  file = path.resolve(file);
  const artifact = await vsixSnapshot(file);
  const inspected = await inspectVsix(file);
  const names = assertVsixEntries(inspected.entries, await expectedVsixFiles(baseRoot));
  await assertContentTypes(inspected.contentTypes, names);
  assertContentHashes(inspected.extensionHashes, await expectedContentHashes(baseRoot));
  if (!inspected.packageJson)
    throw new Error('VSIX is missing extension/package.json');
  if (inspected.packageJson.version !== manifest.version ||
      inspected.packageJson.name !== manifest.name ||
      inspected.packageJson.main !== './dist/extension.js') {
    throw new Error('VSIX package metadata does not match source package.json');
  }
  const properties = inspected.packageJson.contributes &&
    inspected.packageJson.contributes.configuration &&
    inspected.packageJson.contributes.configuration.properties || {};
  if (Object.keys(properties).some(key => /manualCursorToken/i.test(key)))
    throw new Error('VSIX still contributes a plaintext manual token setting');
  await assertManifestIdentity(inspected.vsixManifest, manifest);
  const afterVerification = await vsixSnapshot(file);
  if (!sameVsixSnapshot(artifact, afterVerification))
    throw new Error('VSIX changed during verification');
  return {
    artifact,
    file,
    names,
    total: inspected.total
  };
}

async function main() {
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(root, 'package.json'), 'utf8')
  );
  const file = path.resolve(
    process.argv[2] || path.join(root, `${manifest.name}-${manifest.version}.vsix`)
  );
  const verified = await verifyVsix(file, { root });
  process.stdout.write(
    `verified ${path.basename(file)}: ${verified.names.length} files, ${verified.total} bytes uncompressed\n`
  );
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertVsixEntries,
  assertContentHashes,
  assertContentTypes,
  assertLocalHeader,
  assertManifestIdentity,
  assertZipEntryType,
  expectedContentHashes,
  inspectVsix,
  safeEntryName,
  verifyVsix
};
