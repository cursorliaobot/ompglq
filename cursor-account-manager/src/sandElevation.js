'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile: defaultExecFile } = require('child_process');
const { TextDecoder } = require('util');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const residualRisk = Object.freeze({
  level: 'best-effort',
  statement: 'Elevation is hardened on a best-effort basis and is not a complete security boundary.',
  items: Object.freeze([
    'The operating-system elevation broker and authorization prompt remain trusted dependencies.',
    'A time-of-check/time-of-use window remains before the privileged runtime opens the verified CLI; in-process hash checks reduce but cannot eliminate it.',
    'macOS administrator execution ultimately uses AppleScript do shell script with quoted-form encoding because it has no general argv-preserving elevation API.',
    'Windows ShellExecute elevation reconstructs a Windows command line from carefully encoded arguments, so runtime-specific parsing differences remain possible.',
    'A caller that already controls the invoking account or the trusted CLI directory may still deny service or race local files.'
  ])
});

function elevationError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function assertElevation(condition, code, message) {
  if (!condition) throw elevationError(code, message);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, expected, label) {
  assertElevation(isPlainObject(value), 'MALFORMED_ELEVATION_RESULT', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assertElevation(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    'MALFORMED_ELEVATION_RESULT',
    `${label} has unexpected or missing fields`
  );
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(24).toString('hex')}`;
}

function validateId(value, label, minimum = 8) {
  assertElevation(
    typeof value === 'string' && value.length >= minimum && ID_RE.test(value),
    'INVALID_ELEVATION_ARGUMENT',
    `Invalid ${label}`
  );
  return value;
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function canonicalPath(filePath, label) {
  assertElevation(
    typeof filePath === 'string' && filePath.length > 0 && !filePath.includes('\0'),
    'INVALID_ELEVATION_ARGUMENT',
    `Invalid ${label} path`
  );
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (error) {
    throw elevationError(error.code || 'INTEGRITY_FAILED', `Cannot resolve ${label}: ${resolved}`, error);
  }
}

function allowedOwner(uid) {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function') return true;
  const current = process.geteuid();
  return uid === 0 || uid === current;
}

function validateCanonicalParents(filePath, label) {
  if (process.platform === 'win32') return;
  const parsed = path.parse(filePath);
  const relative = path.relative(parsed.root, path.dirname(filePath));
  let current = parsed.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current);
    assertElevation(!stats.isSymbolicLink() && stats.isDirectory(), 'INTEGRITY_FAILED', `${label} parent is not canonical`);
    assertElevation((stats.mode & 0o022) === 0, 'INTEGRITY_FAILED', `${label} parent is group/world writable: ${current}`);
    assertElevation(allowedOwner(stats.uid), 'INTEGRITY_FAILED', `${label} parent has an untrusted owner: ${current}`);
  }
}

function trustedFileIdentity(filePath, label, requireExecutable = false) {
  const canonical = canonicalPath(filePath, label);
  validateCanonicalParents(canonical, label);
  let before;
  try {
    before = fs.lstatSync(canonical);
  } catch (error) {
    throw elevationError(error.code || 'INTEGRITY_FAILED', `Cannot inspect ${label}`, error);
  }
  assertElevation(!before.isSymbolicLink() && before.isFile(), 'INTEGRITY_FAILED', `${label} must be a regular file`);
  assertElevation(before.nlink === 1, 'INTEGRITY_FAILED', `${label} must not be hard-linked`);
  if (process.platform !== 'win32') {
    assertElevation((before.mode & 0o022) === 0, 'INTEGRITY_FAILED', `${label} is group/world writable`);
    assertElevation(allowedOwner(before.uid), 'INTEGRITY_FAILED', `${label} has an untrusted owner`);
    if (requireExecutable) {
      assertElevation((before.mode & 0o100) !== 0, 'INTEGRITY_FAILED', `${label} is not owner-executable`);
    }
  }
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    assertElevation(
      opened.dev === before.dev && opened.ino === before.ino,
      'INTEGRITY_FAILED',
      `${label} changed while opening`
    );
    const data = fs.readFileSync(fd);
    assertElevation(data.length === opened.size, 'INTEGRITY_FAILED', `${label} changed while reading`);
    return {
      path: canonical,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      uid: process.platform === 'win32' ? null : opened.uid,
      gid: process.platform === 'win32' ? null : opened.gid,
      mode: opened.mode & 0o777,
      size: opened.size
    };
  } finally {
    fs.closeSync(fd);
  }
}

function temporaryFileIdentity(filePath, tempDir, label) {
  const resolved = path.resolve(filePath);
  const canonicalParent = canonicalPath(tempDir, 'elevation temporary directory');
  assertElevation(
    path.dirname(resolved) === canonicalParent,
    'UNSAFE_TEMPORARY_FILE',
    `${label} is outside the elevation temporary directory`
  );
  const parent = fs.lstatSync(canonicalParent);
  const before = fs.lstatSync(resolved);
  assertElevation(
    !parent.isSymbolicLink() &&
      parent.isDirectory() &&
      !before.isSymbolicLink() &&
      before.isFile() &&
      before.nlink === 1,
    'UNSAFE_TEMPORARY_FILE',
    `${label} metadata is unsafe`
  );
  if (process.platform !== 'win32') {
    assertElevation((parent.mode & 0o777) === PRIVATE_DIR_MODE, 'UNSAFE_TEMPORARY_FILE', 'Elevation temporary directory mode is unsafe');
    assertElevation((before.mode & 0o777) === PRIVATE_FILE_MODE, 'UNSAFE_TEMPORARY_FILE', `${label} mode is unsafe`);
    assertElevation(before.uid === parent.uid, 'UNSAFE_TEMPORARY_FILE', `${label} owner is unsafe`);
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    assertElevation(
      opened.dev === before.dev && opened.ino === before.ino,
      'INTEGRITY_FAILED',
      `${label} changed while opening`
    );
    const data = fs.readFileSync(fd);
    assertElevation(data.length === opened.size, 'INTEGRITY_FAILED', `${label} changed while reading`);
    return {
      path: resolved,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      uid: process.platform === 'win32' ? null : opened.uid,
      gid: process.platform === 'win32' ? null : opened.gid,
      mode: opened.mode & 0o777,
      size: opened.size
    };
  } finally {
    fs.closeSync(fd);
  }
}

function sameIdentity(left, right) {
  return (
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.size === right.size
  );
}

function validateUserArgs(args) {
  assertElevation(Array.isArray(args), 'INVALID_ELEVATION_ARGUMENT', 'CLI arguments must be an array');
  assertElevation(args.length > 0 && args.length <= 64, 'INVALID_ELEVATION_ARGUMENT', 'CLI argument count is invalid');
  assertElevation(['status', 'apply', 'restore'].includes(args[0]), 'INVALID_ELEVATION_ARGUMENT', 'CLI command is invalid');
  const forbidden = new Set([
    '--force',
    '--operation-id',
    '--nonce',
    '--result-file',
    '--integrity'
  ]);
  for (const argument of args) {
    assertElevation(
      typeof argument === 'string' &&
        argument.length > 0 &&
        argument.length <= 8192 &&
        !argument.includes('\0'),
      'INVALID_ELEVATION_ARGUMENT',
      'CLI argument is invalid'
    );
    assertElevation(!forbidden.has(argument), 'INVALID_ELEVATION_ARGUMENT', `Reserved or forbidden CLI argument: ${argument}`);
  }
}

function writePrivateFile(filePath, data) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0),
    PRIVATE_FILE_MODE
  );
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const stats = fs.lstatSync(filePath);
  assertElevation(
    !stats.isSymbolicLink() &&
      stats.isFile() &&
      stats.nlink === 1 &&
      (process.platform === 'win32' || (stats.mode & 0o777) === PRIVATE_FILE_MODE),
    'UNSAFE_TEMPORARY_FILE',
    `Temporary file metadata is unsafe: ${filePath}`
  );
}

function createPrivateTempDir(tmpRoot = os.tmpdir()) {
  const canonicalRoot = canonicalPath(tmpRoot, 'temporary root');
  const rootStats = fs.lstatSync(canonicalRoot);
  assertElevation(!rootStats.isSymbolicLink() && rootStats.isDirectory(), 'UNSAFE_TEMPORARY_FILE', 'Temporary root is unsafe');
  const prefix = path.join(canonicalRoot, `cursor-sand-elevation-${crypto.randomBytes(16).toString('hex')}-`);
  const directory = fs.mkdtempSync(prefix);
  fs.chmodSync(directory, PRIVATE_DIR_MODE);
  const stats = fs.lstatSync(directory);
  assertElevation(
    !stats.isSymbolicLink() &&
      stats.isDirectory() &&
      (process.platform === 'win32' || (stats.mode & 0o777) === PRIVATE_DIR_MODE),
    'UNSAFE_TEMPORARY_FILE',
    'Elevation temporary directory is unsafe'
  );
  return directory;
}

function makeIntegrityToken(cli, runtime, patcher) {
  const payload = {
    schemaVersion: 2,
    cli,
    exec: runtime,
    modules: {
      sandPatcher: patcher
    }
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function appleScriptSource() {
  return [
    'on run argv',
    '  set commandText to ""',
    '  repeat with argumentValue in argv',
    '    if commandText is not "" then set commandText to commandText & " "',
    '    set commandText to commandText & quoted form of (contents of argumentValue)',
    '  end repeat',
    '  do shell script commandText with administrator privileges',
    'end run',
    ''
  ].join('\n');
}

function powershellSource() {
  return [
    'param([Parameter(Mandatory=$true)][string]$PayloadPath)',
    '$ErrorActionPreference = "Stop"',
    '$payload = Get-Content -Raw -Encoding UTF8 -LiteralPath $PayloadPath | ConvertFrom-Json',
    'function Quote-WindowsArgument([string]$Value) {',
    '  if ($Value.Length -gt 0 -and $Value -notmatch \'[\\s"]\') { return $Value }',
    '  $builder = New-Object System.Text.StringBuilder',
    '  [void]$builder.Append(\'"\')',
    '  $slashes = 0',
    '  foreach ($character in $Value.ToCharArray()) {',
    '    if ($character -eq \'\\\') { $slashes += 1; continue }',
    '    if ($character -eq \'"\') {',
    '      [void]$builder.Append(\'\\\' * (($slashes * 2) + 1))',
    '      [void]$builder.Append(\'"\')',
    '      $slashes = 0',
    '      continue',
    '    }',
    '    if ($slashes -gt 0) { [void]$builder.Append(\'\\\' * $slashes); $slashes = 0 }',
    '    [void]$builder.Append($character)',
    '  }',
    '  if ($slashes -gt 0) { [void]$builder.Append(\'\\\' * ($slashes * 2)) }',
    '  [void]$builder.Append(\'"\')',
    '  return $builder.ToString()',
    '}',
    '$env:ELECTRON_RUN_AS_NODE = "1"',
    '$encodedArguments = @($payload.arguments | ForEach-Object { Quote-WindowsArgument ([string]$_) })',
    '$argumentLine = [String]::Join(" ", $encodedArguments)',
    '$child = Start-Process -FilePath ([string]$payload.executable) -ArgumentList $argumentLine -Verb RunAs -Wait -PassThru',
    'exit $child.ExitCode',
    ''
  ].join('\r\n');
}

function launcherPath(platform) {
  if (platform === 'linux') return '/usr/bin/pkexec';
  if (platform === 'darwin') return '/usr/bin/osascript';
  if (platform === 'win32') {
    return path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
  }
  throw elevationError('UNSUPPORTED_PLATFORM', `Elevation is not supported on ${platform}`);
}

function buildPlatformInvocation(platform, runtimePath, cliPath, cliArgs, tempDir) {
  if (platform === 'linux') {
    return {
      executable: launcherPath(platform),
      args: ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', runtimePath, cliPath, ...cliArgs]
    };
  }
  if (platform === 'darwin') {
    const scriptPath = path.join(tempDir, 'elevate.applescript');
    writePrivateFile(scriptPath, Buffer.from(appleScriptSource(), 'utf8'));
    return {
      executable: launcherPath(platform),
      args: [scriptPath, '/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', runtimePath, cliPath, ...cliArgs]
    };
  }
  if (platform === 'win32') {
    const scriptPath = path.join(tempDir, 'elevate.ps1');
    const payloadPath = path.join(tempDir, 'payload.json');
    writePrivateFile(scriptPath, Buffer.from(powershellSource(), 'utf8'));
    writePrivateFile(
      payloadPath,
      Buffer.from(JSON.stringify({ executable: runtimePath, arguments: [cliPath, ...cliArgs] }), 'utf8')
    );
    return {
      executable: launcherPath(platform),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        payloadPath
      ]
    };
  }
  throw elevationError('UNSUPPORTED_PLATFORM', `Elevation is not supported on ${platform}`);
}

function normalizeRunArguments(cliOrOptions, args, options) {
  if (isPlainObject(cliOrOptions)) {
    const allowed = new Set([
      'cliPath',
      'args',
      'operationId',
      'nonce',
      'platform',
      'execFile',
      'timeout',
      'tmpRoot'
    ]);
    for (const key of Object.keys(cliOrOptions)) {
      assertElevation(allowed.has(key), 'INVALID_ELEVATION_ARGUMENT', `Unknown elevation option: ${key}`);
    }
    return { ...cliOrOptions };
  }
  assertElevation(options === undefined || isPlainObject(options), 'INVALID_ELEVATION_ARGUMENT', 'Elevation options must be an object');
  const normalized = { ...(options || {}), cliPath: cliOrOptions, args };
  const allowed = new Set([
    'cliPath',
    'args',
    'operationId',
    'nonce',
    'platform',
    'execFile',
    'timeout',
    'tmpRoot'
  ]);
  for (const key of Object.keys(normalized)) {
    assertElevation(allowed.has(key), 'INVALID_ELEVATION_ARGUMENT', `Unknown elevation option: ${key}`);
  }
  return normalized;
}

function prepareElevation(cliOrOptions, args, options) {
  const input = normalizeRunArguments(cliOrOptions, args, options);
  validateUserArgs(input.args);
  const operationId =
    input.operationId === undefined
      ? randomId(input.args[0])
      : validateId(input.operationId, 'operation ID');
  const nonce =
    input.nonce === undefined ? randomId('nonce') : validateId(input.nonce, 'nonce', 24);
  const cli = trustedFileIdentity(input.cliPath, 'Sand CLI', false);
  const runtime = trustedFileIdentity(process.execPath, 'Node runtime', true);
  const patcher = trustedFileIdentity(
    path.join(path.dirname(cli.path), 'sandPatcher.js'),
    'Sand patcher',
    false
  );
  const tempDir = createPrivateTempDir(input.tmpRoot);
  const outputPath = path.join(tempDir, `result-${operationId}.json`);
  const integrity = makeIntegrityToken(cli, runtime, patcher);
  const cliArgs = [
    ...input.args,
    '--operation-id',
    operationId,
    '--nonce',
    nonce,
    '--result-file',
    outputPath,
    '--integrity',
    integrity
  ];
  if (!cliArgs.includes('--json')) cliArgs.push('--json');
  const platform = input.platform || process.platform;
  try {
    const invocation = buildPlatformInvocation(
      platform,
      runtime.path,
      cli.path,
      cliArgs,
      tempDir
    );
    const helperPaths = platform === 'darwin'
      ? [invocation.args[0]]
      : (platform === 'win32' ? invocation.args.slice(-2) : []);
    const helpers = helperPaths.map((helperPath, index) =>
      temporaryFileIdentity(helperPath, tempDir, `elevation helper ${index + 1}`)
    );
    return {
      operation: input.args[0],
      operationId,
      nonce,
      platform,
      cli,
      patcher,
      runtime,
      tempDir,
      outputPath,
      invocation,
      helpers,
      timeout: input.timeout === undefined ? 120000 : input.timeout,
      execFile: input.execFile || defaultExecFile
    };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function scanJsonForDuplicateKeys(text) {
  let index = 0;
  function whitespace() {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  }
  function stringToken() {
    assertElevation(text[index] === '"', 'MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
    const start = index++;
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, index));
        } catch (error) {
          throw elevationError('MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON', error);
        }
      }
      assertElevation(character.charCodeAt(0) >= 0x20, 'MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
      if (character === '\\') {
        assertElevation(index < text.length, 'MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
        const escaped = text[index++];
        if (escaped === 'u') {
          assertElevation(/^[0-9a-fA-F]{4}$/.test(text.slice(index, index + 4)), 'MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
          index += 4;
        } else {
          assertElevation('"\\/bfnrt'.includes(escaped), 'MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
        }
      }
    }
    throw elevationError('MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
  }
  function value(depth) {
    assertElevation(depth <= 64, 'MALFORMED_ELEVATION_RESULT', 'Elevation result is too deeply nested');
    whitespace();
    if (text[index] === '{') return object(depth + 1);
    if (text[index] === '[') return array(depth + 1);
    if (text[index] === '"') {
      stringToken();
      return;
    }
    const rest = text.slice(index);
    const literal = /^(?:true|false|null)/.exec(rest);
    if (literal) {
      index += literal[0].length;
      return;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    assertElevation(number, 'MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
    index += number[0].length;
  }
  function object(depth) {
    assertElevation(depth <= 64, 'MALFORMED_ELEVATION_RESULT', 'Elevation result is too deeply nested');
    index += 1;
    whitespace();
    const keys = new Set();
    if (text[index] === '}') {
      index += 1;
      return;
    }
    while (index < text.length) {
      whitespace();
      const key = stringToken();
      assertElevation(!keys.has(key), 'MALFORMED_ELEVATION_RESULT', `Elevation result contains duplicate key: ${key}`);
      keys.add(key);
      whitespace();
      assertElevation(text[index++] === ':', 'MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
      value(depth);
      whitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      assertElevation(text[index++] === ',', 'MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
    }
    throw elevationError('MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
  }
  function array(depth) {
    assertElevation(depth <= 64, 'MALFORMED_ELEVATION_RESULT', 'Elevation result is too deeply nested');
    index += 1;
    whitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    while (index < text.length) {
      value(depth);
      whitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      assertElevation(text[index++] === ',', 'MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
    }
    throw elevationError('MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON');
  }
  whitespace();
  value(0);
  whitespace();
  assertElevation(index === text.length, 'MALFORMED_ELEVATION_RESULT', 'Elevation result has trailing data');
}

function validateElevatedResult(raw, expected) {
  assertElevation(
    isPlainObject(expected) &&
      typeof expected.operation === 'string' &&
      typeof expected.operationId === 'string' &&
      typeof expected.nonce === 'string',
    'INVALID_ELEVATION_ARGUMENT',
    'Expected result identity is invalid'
  );
  let data;
  if (Buffer.isBuffer(raw)) data = raw;
  else if (typeof raw === 'string') data = Buffer.from(raw, 'utf8');
  else throw elevationError('MALFORMED_ELEVATION_RESULT', 'Elevation result must be text');
  assertElevation(data.length > 0, 'EMPTY_ELEVATION_RESULT', 'Elevated CLI produced no result');
  assertElevation(data.length <= MAX_OUTPUT_BYTES, 'MALFORMED_ELEVATION_RESULT', 'Elevation result is too large');
  let text;
  try {
    text = utf8Decoder.decode(data);
  } catch (error) {
    throw elevationError('MALFORMED_ELEVATION_RESULT', 'Elevation result is not valid UTF-8', error);
  }
  assertElevation(!text.startsWith('\uFEFF'), 'MALFORMED_ELEVATION_RESULT', 'Elevation result contains a BOM');
  scanJsonForDuplicateKeys(text);
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw elevationError('MALFORMED_ELEVATION_RESULT', 'Elevation result is invalid JSON', error);
  }
  const keys = envelope && envelope.ok === true
    ? ['schemaVersion', 'ok', 'operation', 'operationId', 'nonce', 'result']
    : ['schemaVersion', 'ok', 'operation', 'operationId', 'nonce', 'error'];
  exactKeys(envelope, keys, 'elevation result');
  assertElevation(envelope.schemaVersion === 1, 'MALFORMED_ELEVATION_RESULT', 'Unsupported elevation result schema');
  assertElevation(envelope.ok === true || envelope.ok === false, 'MALFORMED_ELEVATION_RESULT', 'Elevation result status is invalid');
  assertElevation(envelope.operation === expected.operation, 'ELEVATION_IDENTITY_MISMATCH', 'Elevation operation mismatch');
  assertElevation(safeEqual(envelope.operationId, expected.operationId), 'ELEVATION_IDENTITY_MISMATCH', 'Elevation operation ID mismatch');
  assertElevation(safeEqual(envelope.nonce, expected.nonce), 'ELEVATION_IDENTITY_MISMATCH', 'Elevation nonce mismatch');
  if (!envelope.ok) {
    exactKeys(envelope.error, ['code', 'message'], 'elevation error');
    assertElevation(typeof envelope.error.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(envelope.error.code), 'MALFORMED_ELEVATION_RESULT', 'Elevation error code is invalid');
    assertElevation(typeof envelope.error.message === 'string' && envelope.error.message.length > 0 && envelope.error.message.length <= 4096, 'MALFORMED_ELEVATION_RESULT', 'Elevation error message is invalid');
    throw elevationError(envelope.error.code, envelope.error.message);
  }
  assertElevation(isPlainObject(envelope.result), 'MALFORMED_ELEVATION_RESULT', 'Elevation success result must be an object');
  if (expected.operation === 'apply' || expected.operation === 'restore') {
    assertElevation(
      safeEqual(envelope.result.operationId, expected.operationId) &&
        safeEqual(envelope.result.nonce, expected.nonce),
      'ELEVATION_IDENTITY_MISMATCH',
      'Nested operation identity mismatch'
    );
  }
  return envelope.result;
}

function readSecureOutput(prepared) {
  let before;
  try {
    before = fs.lstatSync(prepared.outputPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw elevationError('EMPTY_ELEVATION_RESULT', 'Elevated CLI did not create a result file', error);
    throw error;
  }
  const parent = fs.lstatSync(prepared.tempDir);
  assertElevation(!before.isSymbolicLink() && before.isFile() && before.nlink === 1, 'MALFORMED_ELEVATION_RESULT', 'Elevation result is not a standalone regular file');
  assertElevation(before.size > 0 && before.size <= MAX_OUTPUT_BYTES, before.size === 0 ? 'EMPTY_ELEVATION_RESULT' : 'MALFORMED_ELEVATION_RESULT', 'Elevation result size is invalid');
  if (prepared.platform !== 'win32') {
    assertElevation((before.mode & 0o777) === PRIVATE_FILE_MODE, 'MALFORMED_ELEVATION_RESULT', 'Elevation result mode is not 0600');
    assertElevation(before.uid === parent.uid, 'MALFORMED_ELEVATION_RESULT', 'Elevation result owner is invalid');
  }
  const fd = fs.openSync(prepared.outputPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    assertElevation(opened.dev === before.dev && opened.ino === before.ino, 'MALFORMED_ELEVATION_RESULT', 'Elevation result changed while opening');
    const data = fs.readFileSync(fd);
    assertElevation(data.length === opened.size, 'MALFORMED_ELEVATION_RESULT', 'Elevation result changed while reading');
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

function invokePrepared(prepared) {
  assertElevation(
    Number.isSafeInteger(prepared.timeout) && prepared.timeout >= 1000 && prepared.timeout <= 10 * 60 * 1000,
    'INVALID_ELEVATION_ARGUMENT',
    'Elevation timeout is invalid'
  );
  const currentCli = trustedFileIdentity(prepared.cli.path, 'Sand CLI', false);
  const currentPatcher = trustedFileIdentity(prepared.patcher.path, 'Sand patcher', false);
  const currentRuntime = trustedFileIdentity(prepared.runtime.path, 'Node runtime', true);
  assertElevation(sameIdentity(currentCli, prepared.cli), 'INTEGRITY_FAILED', 'Sand CLI changed before elevation');
  assertElevation(sameIdentity(currentPatcher, prepared.patcher), 'INTEGRITY_FAILED', 'Sand patcher changed before elevation');
  assertElevation(sameIdentity(currentRuntime, prepared.runtime), 'INTEGRITY_FAILED', 'Node runtime changed before elevation');
  assertElevation(Array.isArray(prepared.helpers), 'INVALID_ELEVATION_ARGUMENT', 'Elevation helper list is invalid');
  for (let index = 0; index < prepared.helpers.length; index += 1) {
    const expected = prepared.helpers[index];
    const current = temporaryFileIdentity(
      expected.path,
      prepared.tempDir,
      `elevation helper ${index + 1}`
    );
    assertElevation(sameIdentity(current, expected), 'INTEGRITY_FAILED', `Elevation helper ${index + 1} changed before elevation`);
  }
  if (prepared.platform === process.platform) {
    const launcher = trustedFileIdentity(
      prepared.invocation.executable,
      'elevation launcher',
      true
    );
    assertElevation(
      launcher.path === prepared.invocation.executable,
      'INTEGRITY_FAILED',
      'Elevation launcher path is not canonical'
    );
    if (prepared.platform !== 'win32')
      trustedFileIdentity('/usr/bin/env', 'environment launcher', true);
    if (prepared.platform === 'darwin')
      trustedFileIdentity('/bin/sh', 'AppleScript shell', true);
  }
  assertElevation(typeof prepared.execFile === 'function', 'INVALID_ELEVATION_ARGUMENT', 'execFile implementation is invalid');

  return new Promise((resolve, reject) => {
    prepared.execFile(
      prepared.invocation.executable,
      prepared.invocation.args,
      {
        windowsHide: true,
        timeout: prepared.timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false
      },
      (launchError) => {
        try {
          const raw = readSecureOutput(prepared);
          const result = validateElevatedResult(raw, prepared);
          if (launchError) {
            throw elevationError('ELEVATION_LAUNCH_FAILED', `Elevation launcher failed: ${launchError.message || launchError}`, launchError);
          }
          resolve(result);
        } catch (error) {
          if (launchError && error.code === 'EMPTY_ELEVATION_RESULT') {
            reject(elevationError('ELEVATION_LAUNCH_FAILED', `Elevation launcher failed: ${launchError.message || launchError}`, launchError));
          } else {
            reject(error);
          }
        }
      }
    );
  });
}

async function runElevated(cliOrOptions, args, options) {
  const prepared = prepareElevation(cliOrOptions, args, options);
  try {
    return await invokePrepared(prepared);
  } finally {
    try {
      const parent = path.dirname(prepared.tempDir);
      const canonicalParent = canonicalPath(parent, 'temporary parent');
      assertElevation(path.dirname(prepared.tempDir) === canonicalParent, 'UNSAFE_TEMPORARY_FILE', 'Temporary directory parent changed');
      fs.rmSync(prepared.tempDir, { recursive: true, force: true });
    } catch {
      // Residual files stay in a randomized 0700 directory if safe cleanup cannot be proven.
    }
  }
}

module.exports = {
  buildPlatformInvocation,
  createPrivateTempDir,
  invokePrepared,
  makeIntegrityToken,
  prepareElevation,
  residualRisk,
  runElevated,
  trustedFileIdentity,
  validateElevatedResult
};
