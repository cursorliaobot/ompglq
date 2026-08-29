'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const STAGE_PREFIX = '.dist.stage-';
const PREVIOUS_PREFIX = '.dist.previous-';
const BUILD_LOCK_NAME = '.dist.build.lock';

function slash(value) {
  return value.split(path.sep).join('/');
}

async function walkRegularFiles(directory, relative = '') {
  const absolute = path.join(directory, relative);
  const stat = await fsp.lstat(absolute);
  if (stat.isSymbolicLink())
    throw new Error(`refusing symbolic link in build input: ${slash(relative || '.')}`);
  if (!stat.isDirectory())
    throw new Error(`build input is not a directory: ${absolute}`);

  const files = [];
  const entries = await fsp.readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    const childAbsolute = path.join(directory, childRelative);
    const childStat = await fsp.lstat(childAbsolute);
    if (childStat.isSymbolicLink())
      throw new Error(`refusing symbolic link in build input: ${slash(childRelative)}`);
    if (childStat.isDirectory()) {
      files.push(...await walkRegularFiles(directory, childRelative));
      continue;
    }
    if (!childStat.isFile())
      throw new Error(`refusing non-regular build input: ${slash(childRelative)}`);
    files.push({
      relative: slash(childRelative),
      absolute: childAbsolute,
      mode: childStat.mode & 0o777
    });
  }
  return files;
}

async function sha256(file) {
  const bytes = await fsp.readFile(file);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function sourceFiles(root = DEFAULT_ROOT) {
  const all = await walkRegularFiles(path.join(root, 'src'));
  const files = all.filter(file => file.relative.endsWith('.js'));
  if (!files.some(file => file.relative === 'extension.js'))
    throw new Error('src/extension.js is missing');
  return files;
}

async function compareDist(root = DEFAULT_ROOT, destination) {
  const source = await sourceFiles(root);
  const distRoot = destination || path.join(root, 'dist');
  let output;
  try {
    output = await walkRegularFiles(distRoot);
  }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        ok: false,
        missing: source.map(file => file.relative),
        extra: [],
        changed: []
      };
    }
    throw error;
  }

  const sourceByPath = new Map(source.map(file => [file.relative, file]));
  const outputByPath = new Map(output.map(file => [file.relative, file]));
  const missing = [...sourceByPath.keys()].filter(name => !outputByPath.has(name));
  const extra = [...outputByPath.keys()].filter(name => !sourceByPath.has(name));
  const changed = [];
  for (const name of sourceByPath.keys()) {
    if (!outputByPath.has(name))
      continue;
    const [left, right] = await Promise.all([
      sha256(sourceByPath.get(name).absolute),
      sha256(outputByPath.get(name).absolute)
    ]);
    if (left !== right)
      changed.push(name);
  }
  return {
    ok: missing.length === 0 && extra.length === 0 && changed.length === 0,
    missing,
    extra,
    changed
  };
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, 'r');
    await handle.sync();
  }
  catch (error) {
    if (process.platform !== 'win32')
      throw error;
  }
  finally {
    if (handle)
      await handle.close();
  }
}

async function recoverInterruptedSwap(root, destination) {
  const names = (await fsp.readdir(root))
    .filter(name => name.startsWith(PREVIOUS_PREFIX))
    .sort();
  try {
    await fsp.lstat(destination);
  }
  catch (error) {
    if (!error || error.code !== 'ENOENT')
      throw error;
    const previous = names.pop();
    if (previous)
      await fsp.rename(path.join(root, previous), destination);
  }
}

async function removeBuildLeftovers(root, keep = new Set()) {
  const names = await fsp.readdir(root);
  for (const name of names) {
    if ((!name.startsWith(STAGE_PREFIX) && !name.startsWith(PREVIOUS_PREFIX)) || keep.has(name))
      continue;
    await fsp.rm(path.join(root, name), { recursive: true, force: true });
  }
}

async function acquireBuildLock(root) {
  const lockPath = path.join(root, BUILD_LOCK_NAME);
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
    await fsyncDirectory(root);
    return { handle, lockPath, nonce };
  }
  catch (error) {
    if (handle)
      await handle.close().catch(() => {});
    if (error && error.code === 'EEXIST')
      throw new Error(`another build owns ${BUILD_LOCK_NAME}; remove it only after verifying that build is no longer running`);
    throw error;
  }
}

async function releaseBuildLock(lock) {
  await lock.handle.close();
  const value = JSON.parse(await fsp.readFile(lock.lockPath, 'utf8'));
  if (value.nonce !== lock.nonce)
    throw new Error('build lock ownership changed');
  await fsp.unlink(lock.lockPath);
  await fsyncDirectory(path.dirname(lock.lockPath));
}

async function buildExtensionLocked(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const sourceRoot = path.join(root, 'src');
  const destination = path.join(root, 'dist');
  await recoverInterruptedSwap(root, destination);

  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const stageName = STAGE_PREFIX + nonce;
  const previousName = PREVIOUS_PREFIX + nonce;
  const stage = path.join(root, stageName);
  const previous = path.join(root, previousName);
  await removeBuildLeftovers(root);
  await fsp.mkdir(stage, { mode: 0o700 });

  let previousExists = false;
  try {
    const files = await sourceFiles(root);
    for (const file of files) {
      const target = path.join(stage, file.relative);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await fsp.copyFile(path.join(sourceRoot, file.relative), target, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(target, file.mode || 0o644);
    }
    const staged = await compareDist(root, stage);
    if (!staged.ok)
      throw new Error(`staged dist mismatch: ${JSON.stringify(staged)}`);
    await fsyncDirectory(stage);

    try {
      await fsp.rename(destination, previous);
      previousExists = true;
    }
    catch (error) {
      if (!error || error.code !== 'ENOENT')
        throw error;
    }
    try {
      await fsp.rename(stage, destination);
    }
    catch (error) {
      if (previousExists)
        await fsp.rename(previous, destination);
      throw error;
    }
    await fsyncDirectory(root);
    if (previousExists)
      await fsp.rm(previous, { recursive: true, force: true });
    await removeBuildLeftovers(root);
    return {
      destination,
      files: files.map(file => file.relative)
    };
  }
  catch (error) {
    await fsp.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function buildExtension(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const lock = await acquireBuildLock(root);
  try {
    return await buildExtensionLocked({ ...options, root });
  }
  finally {
    await releaseBuildLock(lock);
  }
}

async function main() {
  const result = await buildExtension();
  process.stdout.write(`built ${result.files.length} files in dist\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildExtension,
  compareDist,
  sourceFiles,
  walkRegularFiles
};
