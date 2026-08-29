'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourceFiles } = require('./build-extension');

const root = path.resolve(__dirname, '..');
const STATIC_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'media/icon.png',
  'media/icon.svg',
  'media/webview.css',
  'media/webview.js',
  'package.json'
]);
const SENSITIVE_NAME = /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|.*\.(?:pem|key|p12|pfx))|token.*fixture/i;
const VSIX_NAME_OVERRIDES = Object.freeze({
  'LICENSE': 'LICENSE.txt',
  'README.md': 'readme.md'
});

function normalizeFile(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function assertPackageFileList(files, expectedFiles) {
  const actual = [...new Set(files.map(normalizeFile).filter(Boolean))].sort();
  const expected = [...new Set(expectedFiles.map(normalizeFile).filter(Boolean))].sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const unexpected = actual.filter(file => !expectedSet.has(file));
  const missing = expected.filter(file => !actualSet.has(file));
  const sensitive = actual.filter(file => SENSITIVE_NAME.test(file));
  if (unexpected.length || missing.length || sensitive.length) {
    throw new Error('package whitelist failed: ' + JSON.stringify({
      unexpected,
      missing,
      sensitive
    }));
  }
  return actual;
}

function vsceCliPath(baseRoot = root) {
  const packagePath = require.resolve('@vscode/vsce/package.json', { paths: [baseRoot] });
  const packageJson = require(packagePath);
  const relative = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin && (packageJson.bin.vsce || Object.values(packageJson.bin)[0]);
  if (!relative)
    throw new Error('@vscode/vsce does not expose a CLI');
  return path.resolve(path.dirname(packagePath), relative);
}

async function expectedFiles(baseRoot = root) {
  const runtime = await sourceFiles(baseRoot);
  return STATIC_FILES.concat(runtime.map(file => `dist/${file.relative}`));
}

function vsixFileName(file) {
  const normalized = normalizeFile(file);
  return VSIX_NAME_OVERRIDES[normalized] || normalized;
}

async function expectedVsixFiles(baseRoot = root) {
  return (await expectedFiles(baseRoot)).map(vsixFileName);
}

async function assertSafePackageSources(files, baseRoot = root) {
  const selectedFiles = files === undefined ? await expectedFiles(baseRoot) : files;
  const canonicalRoot = await fs.promises.realpath(baseRoot);
  for (const relative of selectedFiles) {
    const normalized = normalizeFile(relative);
    const absolute = path.resolve(canonicalRoot, normalized);
    const relation = path.relative(canonicalRoot, absolute);
    if (!relation || relation.startsWith('..' + path.sep) || path.isAbsolute(relation))
      throw new Error(`package source escapes repository: ${normalized}`);
    let current = canonicalRoot;
    for (const segment of relation.split(path.sep)) {
      current = path.join(current, segment);
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`package source contains a symbolic link: ${normalized}`);
    }
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(`package source is not a standalone regular file: ${normalized}`);
    const canonical = await fs.promises.realpath(absolute);
    const canonicalRelation = path.relative(canonicalRoot, canonical);
    if (canonicalRelation.startsWith('..' + path.sep) || path.isAbsolute(canonicalRelation))
      throw new Error(`package source resolves outside repository: ${normalized}`);
  }
  return selectedFiles.map(normalizeFile);
}

async function main() {
  const expected = await expectedFiles();
  await assertSafePackageSources(expected);
  const cli = vsceCliPath();
  const listed = spawnSync(process.execPath, [cli, 'ls', '--no-dependencies'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (listed.error)
    throw listed.error;
  if (listed.status !== 0)
    throw new Error(String(listed.stderr || listed.stdout || 'vsce ls failed').trim());
  const files = String(listed.stdout || '').split(/\r?\n/);
  const actual = assertPackageFileList(files, expected);
  process.stdout.write(`package whitelist verified ${actual.length} files\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  SENSITIVE_NAME,
  STATIC_FILES,
  assertPackageFileList,
  assertSafePackageSources,
  expectedFiles,
  expectedVsixFiles,
  normalizeFile,
  vsixFileName,
  vsceCliPath
};
