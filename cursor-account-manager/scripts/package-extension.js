'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { vsceCliPath } = require('./check-package-files');
const { verifyVsix } = require('./verify-vsix');

const fsp = fs.promises;
const root = path.resolve(__dirname, '..');
const SNAPSHOT_DIRECTORIES = Object.freeze([
  'src',
  'dist',
  'scripts',
  'test',
  'media'
]);
const SNAPSHOT_FILES = Object.freeze([
  '.vscodeignore',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'package-lock.json',
  'package.json'
]);

async function readStableFile(filePath) {
  const handle = await fsp.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new Error(`snapshot input is not a standalone regular file: ${filePath}`);
    const data = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        data.length !== after.size) {
      throw new Error(`snapshot input changed while being read: ${filePath}`);
    }
    return {
      data,
      dev: after.dev,
      ino: after.ino,
      mode: after.mode & 0o777,
      mtimeMs: after.mtimeMs,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      size: after.size
    };
  }
  finally {
    await handle.close();
  }
}

async function copyTree(source, destination, options = {}) {
  const sourceStat = await fsp.lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory())
    throw new Error(`snapshot input directory is unsafe: ${source}`);
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (options.skipBinLinks && entry.name === '.bin')
      continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const stat = await fsp.lstat(from);
    if (stat.isSymbolicLink())
      throw new Error(`snapshot input contains a symbolic link: ${from}`);
    if (stat.isDirectory()) {
      await copyTree(from, to, options);
      continue;
    }
    if (!stat.isFile())
      throw new Error(`snapshot input contains a special file: ${from}`);
    const stable = await readStableFile(from);
    await fsp.writeFile(to, stable.data, {
      flag: 'wx',
      mode: stable.mode || 0o600
    });
  }
}

async function freezeTree(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink())
      throw new Error(`snapshot unexpectedly contains a symbolic link: ${target}`);
    if (stat.isDirectory())
      await freezeTree(target);
    else if (stat.isFile())
      await fsp.chmod(target, 0o400);
    else
      throw new Error(`snapshot unexpectedly contains a special file: ${target}`);
  }
  await fsp.chmod(directory, 0o500);
}

async function thawTree(directory) {
  let entries;
  try {
    await fsp.chmod(directory, 0o700);
    entries = await fsp.readdir(directory, { withFileTypes: true });
  }
  catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory())
      await thawTree(path.join(directory, entry.name));
  }
}

async function createSnapshot() {
  const snapshot = await fsp.mkdtemp(path.join(root, '.package-snapshot-'));
  await fsp.chmod(snapshot, 0o700);
  try {
    for (const directory of SNAPSHOT_DIRECTORIES) {
      await copyTree(path.join(root, directory), path.join(snapshot, directory));
    }
    for (const file of SNAPSHOT_FILES) {
      const stable = await readStableFile(path.join(root, file));
      await fsp.writeFile(path.join(snapshot, file), stable.data, {
        flag: 'wx',
        mode: stable.mode || 0o600
      });
    }
    await copyTree(
      path.join(root, 'node_modules'),
      path.join(snapshot, 'node_modules'),
      { skipBinLinks: true }
    );
    await freezeTree(snapshot);
    return snapshot;
  }
  catch (error) {
    await thawTree(snapshot);
    await fsp.rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

function runNode(script, cwd) {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  if (result.stdout)
    process.stdout.write(result.stdout);
  if (result.stderr)
    process.stderr.write(result.stderr);
  if (result.error)
    throw result.error;
  if (result.status !== 0)
    throw new Error(`${script} failed with exit code ${result.status}`);
}

function runVsce(snapshot, outputPath) {
  const result = spawnSync(process.execPath, [
    vsceCliPath(snapshot),
    'package',
    '--allow-missing-repository',
    '--no-dependencies',
    '--out',
    outputPath
  ], {
    cwd: snapshot,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  if (result.stdout)
    process.stdout.write(result.stdout);
  if (result.stderr)
    process.stderr.write(result.stderr);
  if (result.error)
    throw result.error;
  if (result.status !== 0)
    throw new Error(`vsce package failed with exit code ${result.status}`);
}

async function acquirePackageLock() {
  const lockPath = path.join(root, '.cursor-account-manager-package.lock');
  const nonce = crypto.randomBytes(18).toString('hex');
  let handle;
  try {
    handle = await fsp.open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      nonce,
      createdAt: new Date().toISOString()
    })}\n`, 'utf8');
    await handle.sync();
    return { handle, lockPath, nonce };
  }
  catch (error) {
    if (handle)
      await handle.close().catch(() => {});
    if (error && error.code === 'EEXIST')
      throw new Error('another packaging process is active');
    throw error;
  }
}

async function releasePackageLock(lock) {
  await lock.handle.close();
  const record = JSON.parse(await fsp.readFile(lock.lockPath, 'utf8'));
  if (record.nonce !== lock.nonce)
    throw new Error('package lock ownership changed');
  await fsp.unlink(lock.lockPath);
}

function sameArtifact(left, right) {
  return left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256;
}

async function publishCandidate(candidate, destination, expectedArtifact) {
  const beforePublish = await readStableFile(candidate);
  if (!sameArtifact(beforePublish, expectedArtifact))
    throw new Error('verified VSIX candidate changed before publication');
  let existing;
  try {
    existing = await fsp.lstat(destination);
  }
  catch (error) {
    if (!error || error.code !== 'ENOENT')
      throw error;
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)
      throw new Error(`refusing to replace unsafe VSIX destination: ${destination}`);
  }
  try {
    await fsp.rename(candidate, destination);
  }
  catch (error) {
    if (!existing || !error || !['EEXIST', 'EPERM'].includes(error.code))
      throw error;
    await fsp.unlink(destination);
    await fsp.rename(candidate, destination);
  }
  const published = await readStableFile(destination);
  if (!sameArtifact(published, expectedArtifact)) {
    await fsp.unlink(destination).catch(() => {});
    throw new Error('published VSIX identity does not match the verified candidate');
  }
}

async function main() {
  const lock = await acquirePackageLock();
  let snapshot;
  const candidate = path.join(
    root,
    `.cursor-account-manager-${process.pid}-${crypto.randomBytes(12).toString('hex')}.vsix.tmp`
  );
  try {
    snapshot = await createSnapshot();
    for (const script of [
      'scripts/check-syntax.js',
      'scripts/run-tests.js',
      'scripts/check-dist.js',
      'scripts/check-package-files.js'
    ]) {
      runNode(script, snapshot);
    }
    runVsce(snapshot, candidate);
    const verified = await verifyVsix(candidate, { root: snapshot });
    const manifest = JSON.parse(await fsp.readFile(path.join(snapshot, 'package.json'), 'utf8'));
    const destination = path.join(root, `${manifest.name}-${manifest.version}.vsix`);
    await publishCandidate(candidate, destination, verified.artifact);
    process.stdout.write(
      `verified and published ${path.basename(destination)}: ` +
      `${verified.names.length} files, ${verified.total} bytes uncompressed\n`
    );
  }
  finally {
    await fsp.rm(candidate, { force: true }).catch(() => {});
    if (snapshot) {
      await thawTree(snapshot);
      await fsp.rm(snapshot, { recursive: true, force: true }).catch(() => {});
    }
    await releasePackageLock(lock);
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  copyTree,
  createSnapshot,
  readStableFile
};
