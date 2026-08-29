#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const IS_WINDOWS = process.platform === 'win32';

function cliError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function assertCli(condition, code, message) {
  if (!condition) throw cliError(code, message);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, keys, label) {
  assertCli(isPlainObject(value), 'INVALID_INTEGRITY', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assertCli(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    'INVALID_INTEGRITY',
    `${label} fields are invalid`
  );
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(24).toString('hex')}`;
}

function validateId(value, label, minLength = 8) {
  assertCli(
    typeof value === 'string' && value.length >= minLength && ID_RE.test(value),
    'INVALID_ARGUMENT',
    `Invalid ${label}`
  );
  return value;
}

function requireValue(argv, index, option) {
  assertCli(index + 1 < argv.length, 'INVALID_ARGUMENT', `${option} requires a value`);
  const value = argv[index + 1];
  assertCli(
    typeof value === 'string' && value.length > 0 && !value.startsWith('--') && !value.includes('\0'),
    'INVALID_ARGUMENT',
    `${option} requires a valid value`
  );
  assertCli(value.length <= 8192, 'INVALID_ARGUMENT', `${option} value is too long`);
  return value;
}

function parseArgs(input) {
  assertCli(Array.isArray(input), 'INVALID_ARGUMENT', 'argv must be an array');
  const argv = [...input];
  const result = {
    command: 'status',
    appRoot: null,
    stateRoot: null,
    dryRun: false,
    json: false,
    operationId: null,
    nonce: null,
    resultFile: null,
    integrity: null
  };
  const commands = new Set(['status', 'apply', 'restore']);
  let index = 0;
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    assertCli(commands.has(argv[0]), 'INVALID_ARGUMENT', `Unknown command: ${argv[0]}`);
    result.command = argv[0];
    index = 1;
  }
  const seen = new Set();
  const valueOptions = new Map([
    ['--app-root', 'appRoot'],
    ['--state-root', 'stateRoot'],
    ['--operation-id', 'operationId'],
    ['--nonce', 'nonce'],
    ['--result-file', 'resultFile'],
    ['--integrity', 'integrity']
  ]);
  while (index < argv.length) {
    const option = argv[index];
    assertCli(typeof option === 'string' && option.startsWith('--'), 'INVALID_ARGUMENT', `Unexpected positional argument: ${option}`);
    assertCli(!seen.has(option), 'INVALID_ARGUMENT', `Duplicate argument: ${option}`);
    seen.add(option);
    if (valueOptions.has(option)) {
      const value = requireValue(argv, index, option);
      result[valueOptions.get(option)] = value;
      index += 2;
      continue;
    }
    if (option === '--dry-run') result.dryRun = true;
    else if (option === '--json') result.json = true;
    else throw cliError('INVALID_ARGUMENT', `Unknown argument: ${option}`);
    index += 1;
  }

  if (result.appRoot !== null) result.appRoot = path.resolve(result.appRoot);
  if (result.stateRoot !== null) result.stateRoot = path.resolve(result.stateRoot);
  if (result.resultFile !== null) {
    assertCli(path.isAbsolute(result.resultFile), 'INVALID_ARGUMENT', '--result-file must be absolute');
    result.resultFile = path.resolve(result.resultFile);
  }
  if (result.operationId === null) result.operationId = randomId(result.command);
  else validateId(result.operationId, 'operation ID');
  if (result.nonce === null) result.nonce = randomId('nonce');
  else validateId(result.nonce, 'nonce', 24);

  assertCli(!result.dryRun || result.command === 'apply', 'INVALID_ARGUMENT', '--dry-run is only valid with apply');
  assertCli(result.command !== 'status' || result.stateRoot === null, 'INVALID_ARGUMENT', '--state-root is not valid with status');
  assertCli(
    result.resultFile === null || result.integrity !== null,
    'INVALID_ARGUMENT',
    '--result-file requires an integrity token'
  );
  return result;
}

function canonicalFile(filePath, label) {
  const resolved = path.resolve(filePath);
  let canonical;
  try {
    canonical = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (error) {
    throw cliError(error.code || 'INTEGRITY_FAILED', `Cannot resolve ${label}`, error);
  }
  const before = fs.lstatSync(canonical);
  assertCli(!before.isSymbolicLink() && before.isFile() && before.nlink === 1, 'INTEGRITY_FAILED', `${label} is not a standalone regular file`);
  assertCli(IS_WINDOWS || (before.mode & 0o022) === 0, 'INTEGRITY_FAILED', `${label} is group/world writable`);
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    assertCli(opened.dev === before.dev && opened.ino === before.ino, 'INTEGRITY_FAILED', `${label} changed while opening`);
    const data = fs.readFileSync(fd);
    assertCli(data.length === opened.size, 'INTEGRITY_FAILED', `${label} changed while reading`);
    const identity = {
      path: canonical,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      uid: IS_WINDOWS ? null : opened.uid,
      gid: IS_WINDOWS ? null : opened.gid,
      mode: opened.mode & 0o777,
      size: opened.size
    };
    Object.defineProperty(identity, 'data', {
      enumerable: false,
      value: data
    });
    return identity;
  } finally {
    fs.closeSync(fd);
  }
}

function validateIntegrityFile(value, label) {
  exactKeys(value, ['path', 'sha256', 'uid', 'gid', 'mode', 'size'], label);
  assertCli(typeof value.path === 'string' && path.isAbsolute(value.path) && !value.path.includes('\0'), 'INVALID_INTEGRITY', `${label} path is invalid`);
  assertCli(typeof value.sha256 === 'string' && HASH_RE.test(value.sha256), 'INVALID_INTEGRITY', `${label} hash is invalid`);
  for (const field of ['uid', 'gid']) {
    assertCli(value[field] === null || (Number.isSafeInteger(value[field]) && value[field] >= 0), 'INVALID_INTEGRITY', `${label} ${field} is invalid`);
  }
  assertCli(Number.isSafeInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777, 'INVALID_INTEGRITY', `${label} mode is invalid`);
  assertCli(Number.isSafeInteger(value.size) && value.size >= 0, 'INVALID_INTEGRITY', `${label} size is invalid`);
}

function decodeIntegrity(token) {
  assertCli(
    typeof token === 'string' && token.length > 0 && token.length <= 16384 && /^[A-Za-z0-9_-]+$/.test(token),
    'INVALID_INTEGRITY',
    'Integrity token encoding is invalid'
  );
  let data;
  try {
    data = Buffer.from(token, 'base64url');
    assertCli(data.toString('base64url') === token, 'INVALID_INTEGRITY', 'Integrity token is not canonical');
    const value = JSON.parse(data.toString('utf8'));
    exactKeys(value, ['schemaVersion', 'cli', 'exec', 'modules'], 'integrity token');
    assertCli(value.schemaVersion === 2, 'INVALID_INTEGRITY', 'Unsupported integrity token schema');
    validateIntegrityFile(value.cli, 'CLI integrity');
    validateIntegrityFile(value.exec, 'runtime integrity');
    exactKeys(value.modules, ['sandPatcher'], 'integrity modules');
    validateIntegrityFile(value.modules.sandPatcher, 'Sand patcher integrity');
    return value;
  } catch (error) {
    if (error && error.code) throw error;
    throw cliError('INVALID_INTEGRITY', 'Integrity token is malformed', error);
  }
}

function sameMetadata(actual, expected) {
  return (
    actual.path === expected.path &&
    actual.sha256 === expected.sha256 &&
    actual.uid === expected.uid &&
    actual.gid === expected.gid &&
    actual.mode === expected.mode &&
    actual.size === expected.size
  );
}

function verifyInvocationIntegrity(token) {
  const expected = decodeIntegrity(token);
  const mainFile = require.main && require.main.filename ? require.main.filename : __filename;
  const cli = canonicalFile(mainFile, 'Sand CLI');
  const runtime = canonicalFile(process.execPath, 'Node runtime');
  const expectedPatcherPath = path.join(path.dirname(cli.path), 'sandPatcher.js');
  const patcher = canonicalFile(expectedPatcherPath, 'Sand patcher');
  assertCli(sameMetadata(cli, expected.cli), 'INTEGRITY_FAILED', 'Sand CLI identity, owner, mode, or hash changed');
  assertCli(sameMetadata(runtime, expected.exec), 'INTEGRITY_FAILED', 'Node runtime identity, owner, mode, or hash changed');
  assertCli(
    expected.modules.sandPatcher.path === expectedPatcherPath &&
      sameMetadata(patcher, expected.modules.sandPatcher),
    'INTEGRITY_FAILED',
    'Sand patcher identity, owner, mode, or hash changed'
  );
  return {
    expected,
    patcherPath: patcher.path,
    patcherSource: patcher.data
  };
}

function loadPatcher(verified) {
  if (!verified)
    return require('./sandPatcher');
  assertCli(
    Buffer.isBuffer(verified.patcherSource) &&
      typeof verified.patcherPath === 'string',
    'INTEGRITY_FAILED',
    'Verified Sand patcher bytes are unavailable'
  );
  const loaded = new Module(verified.patcherPath, module);
  loaded.filename = verified.patcherPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(verified.patcherPath));
  loaded._compile(verified.patcherSource.toString('utf8'), verified.patcherPath);
  return loaded.exports;
}

function execute(args, verified) {
  const {
    applyPatch,
    defaultAppRoot,
    defaultStateRoot,
    inspect,
    restoreLatest
  } = loadPatcher(verified);
  const appRoot = args.appRoot || defaultAppRoot();
  if (args.command === 'status') return inspect(appRoot);
  const stateRoot = args.stateRoot || defaultStateRoot();
  if (args.command === 'apply') {
    return applyPatch({
      appRoot,
      stateRoot,
      dryRun: args.dryRun,
      operationId: args.operationId,
      nonce: args.nonce
    });
  }
  return restoreLatest({
    appRoot,
    stateRoot,
    operationId: args.operationId,
    nonce: args.nonce
  });
}

function resultEnvelope(args, result) {
  return {
    schemaVersion: 1,
    ok: true,
    operation: args.command,
    operationId: args.operationId,
    nonce: args.nonce,
    result
  };
}

function errorEnvelope(args, error) {
  return {
    schemaVersion: 1,
    ok: false,
    operation: args ? args.command : 'unknown',
    operationId: args ? args.operationId : null,
    nonce: args ? args.nonce : null,
    error: {
      code: typeof error.code === 'string' ? error.code : 'SAND_OPERATION_FAILED',
      message: error && error.message ? error.message : String(error)
    }
  };
}

function secureWriteResult(filePath, data, operationId) {
  const expectedName = `result-${operationId}.json`;
  assertCli(path.basename(filePath) === expectedName, 'UNSAFE_RESULT_PATH', 'Result filename does not match the operation ID');
  const parent = path.dirname(filePath);
  const parentReal = fs.realpathSync.native ? fs.realpathSync.native(parent) : fs.realpathSync(parent);
  assertCli(parentReal === parent, 'UNSAFE_RESULT_PATH', 'Result directory must be canonical');
  const parentStats = fs.lstatSync(parent);
  assertCli(!parentStats.isSymbolicLink() && parentStats.isDirectory(), 'UNSAFE_RESULT_PATH', 'Result parent is not a regular directory');
  if (!IS_WINDOWS) {
    assertCli((parentStats.mode & 0o777) === 0o700, 'UNSAFE_RESULT_PATH', 'Result directory must have mode 0700');
    const delegatedUid = process.env.PKEXEC_UID || process.env.SUDO_UID;
    if (typeof process.geteuid === 'function' && process.geteuid() === 0 && delegatedUid !== undefined) {
      assertCli(String(parentStats.uid) === String(delegatedUid), 'UNSAFE_RESULT_PATH', 'Result directory is not owned by the invoking user');
    }
  }
  assertCli(!fs.existsSync(filePath), 'UNSAFE_RESULT_PATH', 'Result file already exists');
  assertCli(data.length > 0 && data.length <= MAX_OUTPUT_BYTES, 'INVALID_RESULT', 'Result output size is invalid');
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0),
    0o600
  );
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, 0o600);
    if (!IS_WINDOWS && typeof process.geteuid === 'function' && process.geteuid() === 0) {
      fs.fchownSync(fd, parentStats.uid, parentStats.gid);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const output = fs.lstatSync(filePath);
  assertCli(
    !output.isSymbolicLink() &&
      output.isFile() &&
      output.nlink === 1 &&
      (IS_WINDOWS || ((output.mode & 0o777) === 0o600 && output.uid === parentStats.uid)),
    'UNSAFE_RESULT_PATH',
    'Result file metadata validation failed'
  );
}

function emit(args, envelope, output = process.stdout) {
  const data = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
  if (args && args.resultFile) secureWriteResult(args.resultFile, data, args.operationId);
  else output.write(data);
}

function main(argv = process.argv.slice(2), output = process.stdout) {
  let args = null;
  let integrityVerified = false;
  let verifiedPatcher = null;
  let envelope;
  let exitCode = 0;
  try {
    args = parseArgs(argv);
    if (args.integrity !== null) {
      verifiedPatcher = verifyInvocationIntegrity(args.integrity);
      integrityVerified = true;
    }
    const result = execute(args, verifiedPatcher);
    envelope = resultEnvelope(args, result);
  } catch (error) {
    envelope = errorEnvelope(args, error);
    exitCode = 1;
  }

  const safeArgs = args && (args.resultFile === null || integrityVerified) ? args : null;
  try {
    emit(safeArgs, envelope, output);
  } catch (error) {
    output.write(
      Buffer.from(
        `${JSON.stringify(errorEnvelope(null, cliError('RESULT_WRITE_FAILED', error.message || String(error), error)))}\n`,
        'utf8'
      )
    );
    return 1;
  }
  return exitCode;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  canonicalFile,
  decodeIntegrity,
  errorEnvelope,
  execute,
  loadPatcher,
  main,
  parseArgs,
  resultEnvelope,
  secureWriteResult,
  verifyInvocationIntegrity
};
