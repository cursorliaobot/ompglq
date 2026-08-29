'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TextDecoder } = require('util');

const HEADER = 'x-cursor-client-type';
const VALUE = 'sand';
const MANIFEST_SCHEMA_VERSION = 2;
const JOURNAL_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_PRODUCT_BYTES = 8 * 1024 * 1024;
const MAX_TARGET_BYTES = 256 * 1024 * 1024;
const MAX_RESULT_ENTRIES = 5;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const IS_WINDOWS = process.platform === 'win32';

const FILE_ID_MAP = Object.freeze({
  main: Object.freeze({ rel: 'out/main.js', order: 10, candidate: true }),
  workbench: Object.freeze({
    rel: 'out/vs/workbench/workbench.desktop.main.js',
    order: 20,
    candidate: true
  }),
  'extension-host-node': Object.freeze({
    rel: 'out/vs/workbench/api/node/extensionHostProcess.js',
    order: 30,
    candidate: true
  }),
  'extension-host-worker': Object.freeze({
    rel: 'out/vs/workbench/api/worker/extensionHostWorkerMain.js',
    order: 40,
    candidate: true
  }),
  product: Object.freeze({ rel: 'product.json', order: 100, candidate: false })
});
const CANDIDATE_IDS = Object.freeze(
  Object.keys(FILE_ID_MAP).filter((id) => FILE_ID_MAP[id].candidate)
);
const CANDIDATE_FILES = Object.freeze(CANDIDATE_IDS.map((id) => FILE_ID_MAP[id].rel));
const PRODUCT_ID = 'product';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const COMMIT_RE = /^[0-9a-f]{7,64}$/i;
const CHECKSUM_RE = /^[A-Za-z0-9+/]{43}$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function sandError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function assertCondition(condition, code, message) {
  if (!condition) throw sandError(code, message);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value, expected, label) {
  assertCondition(isPlainObject(value), 'INVALID_SCHEMA', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assertCondition(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    'INVALID_SCHEMA',
    `${label} has unexpected or missing fields`
  );
}

function assertKnownOptions(options, allowed, label) {
  assertCondition(isPlainObject(options), 'INVALID_ARGUMENT', `${label} options must be an object`);
  for (const key of Object.keys(options)) {
    assertCondition(allowed.includes(key), 'UNKNOWN_OPTION', `Unknown ${label} option: ${key}`);
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function vscodeChecksum(data) {
  return crypto.createHash('sha256').update(data).digest('base64').replace(/=+$/, '');
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(24).toString('hex')}`;
}

function validateOperationId(value, label = 'operationId') {
  assertCondition(typeof value === 'string' && ID_RE.test(value), 'INVALID_ARGUMENT', `Invalid ${label}`);
  return value;
}

function validateNonce(value) {
  assertCondition(
    typeof value === 'string' && ID_RE.test(value) && value.length >= 24,
    'INVALID_ARGUMENT',
    'Invalid nonce'
  );
  return value;
}

function safeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function modeOf(stats) {
  return stats.mode & 0o777;
}

function ownerOf(stats) {
  if (IS_WINDOWS) return { uid: null, gid: null };
  return { uid: stats.uid, gid: stats.gid };
}

function validateIdentifierMetadata(value, label) {
  assertCondition(typeof value === 'string' && value.length > 0 && value.length <= 128, 'INVALID_SCHEMA', `Invalid ${label}`);
  assertCondition(!value.includes('\0'), 'INVALID_SCHEMA', `Invalid ${label}`);
  return value;
}

function scanJsonForDuplicateKeys(text, label) {
  let index = 0;

  function whitespace() {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  }

  function stringToken() {
    assertCondition(text[index] === '"', 'INVALID_JSON', `${label} contains invalid JSON`);
    const start = index;
    index += 1;
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') {
        try {
          return JSON.parse(text.slice(start, index));
        } catch (error) {
          throw sandError('INVALID_JSON', `${label} contains invalid JSON`, error);
        }
      }
      assertCondition(char.charCodeAt(0) >= 0x20, 'INVALID_JSON', `${label} contains invalid JSON`);
      if (char === '\\') {
        assertCondition(index < text.length, 'INVALID_JSON', `${label} contains invalid JSON`);
        const escaped = text[index++];
        if (escaped === 'u') {
          assertCondition(/^[0-9a-fA-F]{4}$/.test(text.slice(index, index + 4)), 'INVALID_JSON', `${label} contains invalid JSON`);
          index += 4;
        } else {
          assertCondition('"\\/bfnrt'.includes(escaped), 'INVALID_JSON', `${label} contains invalid JSON`);
        }
      }
    }
    throw sandError('INVALID_JSON', `${label} contains unterminated JSON text`);
  }

  function value(depth) {
    assertCondition(depth <= 64, 'INVALID_JSON', `${label} exceeds the maximum nesting depth`);
    whitespace();
    const char = text[index];
    if (char === '{') return object(depth + 1);
    if (char === '[') return array(depth + 1);
    if (char === '"') {
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
    assertCondition(number, 'INVALID_JSON', `${label} contains invalid JSON`);
    index += number[0].length;
  }

  function object(depth) {
    assertCondition(depth <= 64, 'INVALID_JSON', `${label} exceeds the maximum nesting depth`);
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
      assertCondition(!keys.has(key), 'INVALID_JSON', `${label} contains duplicate key: ${key}`);
      keys.add(key);
      whitespace();
      assertCondition(text[index] === ':', 'INVALID_JSON', `${label} contains invalid JSON`);
      index += 1;
      value(depth);
      whitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      assertCondition(text[index] === ',', 'INVALID_JSON', `${label} contains invalid JSON`);
      index += 1;
    }
    throw sandError('INVALID_JSON', `${label} contains invalid JSON`);
  }

  function array(depth) {
    assertCondition(depth <= 64, 'INVALID_JSON', `${label} exceeds the maximum nesting depth`);
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
      assertCondition(text[index] === ',', 'INVALID_JSON', `${label} contains invalid JSON`);
      index += 1;
    }
    throw sandError('INVALID_JSON', `${label} contains invalid JSON`);
  }

  whitespace();
  value(0);
  whitespace();
  assertCondition(index === text.length, 'INVALID_JSON', `${label} contains trailing JSON data`);
}

function parseJson(data, label) {
  let text;
  try {
    text = utf8Decoder.decode(data);
  } catch (error) {
    throw sandError('INVALID_JSON', `${label} is not valid UTF-8`, error);
  }
  assertCondition(!text.startsWith('\uFEFF'), 'INVALID_JSON', `${label} must not contain a BOM`);
  scanJsonForDuplicateKeys(text, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw sandError('INVALID_JSON', `${label} contains invalid JSON`, error);
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateRegularStats(stats, label, options = {}) {
  assertCondition(!stats.isSymbolicLink(), 'UNSAFE_FILE', `${label} must not be a symbolic link`);
  assertCondition(stats.isFile(), 'UNSAFE_FILE', `${label} must be a regular file`);
  assertCondition(stats.nlink === 1, 'UNSAFE_FILE', `${label} must not be hard-linked`);
  if (options.maxSize !== undefined) {
    assertCondition(
      Number.isSafeInteger(stats.size) && stats.size >= 0 && stats.size <= options.maxSize,
      'FILE_TOO_LARGE',
      `${label} exceeds the allowed size`
    );
  }
  if (!IS_WINDOWS) {
    if (options.safeMode !== false) {
      assertCondition((modeOf(stats) & 0o022) === 0, 'UNSAFE_MODE', `${label} is group/world writable`);
    }
    if (options.mode !== undefined) {
      assertCondition(modeOf(stats) === options.mode, 'METADATA_MISMATCH', `${label} mode changed`);
    }
    if (options.uid !== undefined && options.uid !== null) {
      assertCondition(stats.uid === options.uid, 'OWNER_MISMATCH', `${label} owner changed`);
    }
    if (options.gid !== undefined && options.gid !== null) {
      assertCondition(stats.gid === options.gid, 'OWNER_MISMATCH', `${label} group changed`);
    }
  }
}

function readSecureFile(filePath, label, options = {}) {
  let before;
  try {
    before = fs.lstatSync(filePath);
  } catch (error) {
    throw sandError(error.code || 'READ_FAILED', `Cannot inspect ${label}: ${filePath}`, error);
  }
  validateRegularStats(before, label, options);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    validateRegularStats(opened, label, options);
    assertCondition(sameFileIdentity(before, opened), 'FILE_RACE', `${label} changed while opening`);
    const data = fs.readFileSync(fd);
    assertCondition(data.length === opened.size, 'FILE_RACE', `${label} changed while reading`);
    return { data, stats: opened };
  } catch (error) {
    if (error && error.code && error.code.startsWith('INVALID_')) throw error;
    if (error && ['UNSAFE_FILE', 'UNSAFE_MODE', 'OWNER_MISMATCH', 'METADATA_MISMATCH', 'FILE_RACE', 'FILE_TOO_LARGE'].includes(error.code)) {
      throw error;
    }
    throw sandError(error.code || 'READ_FAILED', `Cannot securely read ${label}: ${filePath}`, error);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateDirectory(dirPath, label, options = {}) {
  let stats;
  try {
    stats = fs.lstatSync(dirPath);
  } catch (error) {
    throw sandError(error.code || 'READ_FAILED', `Cannot inspect ${label}: ${dirPath}`, error);
  }
  assertCondition(!stats.isSymbolicLink(), 'UNSAFE_PATH', `${label} must not be a symbolic link`);
  assertCondition(stats.isDirectory(), 'UNSAFE_PATH', `${label} must be a directory`);
  if (!IS_WINDOWS) {
    if (options.private) {
      assertCondition(modeOf(stats) === PRIVATE_DIR_MODE, 'UNSAFE_MODE', `${label} must have mode 0700`);
    } else if (options.safeMode !== false) {
      assertCondition((modeOf(stats) & 0o022) === 0, 'UNSAFE_MODE', `${label} is group/world writable`);
    }
    if (options.uid !== undefined && options.uid !== null) {
      assertCondition(stats.uid === options.uid, 'OWNER_MISMATCH', `${label} owner changed`);
    }
  }
  return stats;
}

function canonicalExistingDirectory(input, label) {
  assertCondition(typeof input === 'string' && input.length > 0 && !input.includes('\0'), 'INVALID_ARGUMENT', `Invalid ${label}`);
  const resolved = path.resolve(input);
  validateDirectory(resolved, label);
  let canonical;
  try {
    canonical = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (error) {
    throw sandError(error.code || 'READ_FAILED', `Cannot resolve ${label}`, error);
  }
  validateDirectory(canonical, label);
  return canonical;
}

function assertContained(root, target, label) {
  const relative = path.relative(root, target);
  assertCondition(
    relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
    'PATH_ESCAPE',
    `${label} escapes its trusted root`
  );
}

function targetPath(root, id) {
  const spec = FILE_ID_MAP[id];
  assertCondition(spec, 'INVALID_FILE_ID', `Unknown fixed file ID: ${id}`);
  const result = path.join(root, ...spec.rel.split('/'));
  assertContained(root, result, `Target ${id}`);
  return result;
}

function validateParentChain(root, target, expectedUid, allowMissing = false) {
  assertContained(root, target, target);
  const parent = path.dirname(target);
  const relative = path.relative(root, parent);
  let current = root;
  const segments = relative === '' ? [] : relative.split(path.sep);
  const roots = [root, ...segments.map((segment) => {
    current = path.join(current, segment);
    return current;
  })];
  for (const dir of roots) {
    try {
      validateDirectory(dir, `Parent directory ${dir}`, { uid: expectedUid });
    } catch (error) {
      if (allowMissing && error.cause && error.cause.code === 'ENOENT') return false;
      if (allowMissing && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function validateVersion(value) {
  assertCondition(typeof value === 'string' && value.length <= 64 && VERSION_RE.test(value), 'INVALID_PRODUCT', 'product.json has an invalid Cursor version');
  return value;
}

function validateCommit(value) {
  assertCondition(typeof value === 'string' && COMMIT_RE.test(value), 'INVALID_PRODUCT', 'product.json has an invalid Cursor commit');
  return value;
}

function validateChecksums(checksums) {
  assertCondition(isPlainObject(checksums), 'INVALID_CHECKSUMS', 'product.json checksums must be an object');
  const keys = Object.keys(checksums);
  assertCondition(keys.length <= 200000, 'INVALID_CHECKSUMS', 'product.json contains too many checksums');
  for (const key of keys) {
    assertCondition(
      key.length > 0 &&
        key.length <= 1024 &&
        !key.includes('\0') &&
        !key.includes('\\') &&
        !key.startsWith('/') &&
        !key.split('/').some((part) => part === '' || part === '.' || part === '..'),
      'INVALID_CHECKSUMS',
      `Invalid checksum path: ${key}`
    );
    assertCondition(typeof checksums[key] === 'string' && CHECKSUM_RE.test(checksums[key]), 'INVALID_CHECKSUMS', `Invalid checksum value for ${key}`);
  }
}

function validateProductJson(product) {
  assertCondition(isPlainObject(product), 'INVALID_PRODUCT', 'product.json must contain an object');
  assertCondition(Object.prototype.hasOwnProperty.call(product, 'version'), 'INVALID_PRODUCT', 'product.json is missing version');
  assertCondition(Object.prototype.hasOwnProperty.call(product, 'commit'), 'INVALID_PRODUCT', 'product.json is missing commit');
  assertCondition(Object.prototype.hasOwnProperty.call(product, 'checksums'), 'INVALID_CHECKSUMS', 'product.json is missing checksums');
  validateVersion(product.version);
  validateCommit(product.commit);
  validateChecksums(product.checksums);
}

function deriveInstallId(appRoot) {
  return sha256(Buffer.from(`cursor-sand-install-v2\0${appRoot}`, 'utf8'));
}

function loadInstall(appRoot) {
  const root = canonicalExistingDirectory(appRoot || defaultAppRoot(), 'Cursor app root');
  const productPath = targetPath(root, PRODUCT_ID);
  validateParentChain(root, productPath, undefined);
  const productFile = readSecureFile(productPath, 'product.json', { maxSize: MAX_PRODUCT_BYTES });
  const owner = ownerOf(productFile.stats);
  validateDirectory(root, 'Cursor app root', { uid: owner.uid });
  const outPath = path.join(root, 'out');
  validateDirectory(outPath, 'Cursor out directory', { uid: owner.uid });
  const product = parseJson(productFile.data, 'product.json');
  validateProductJson(product);
  return {
    root,
    installId: deriveInstallId(root),
    owner,
    productPath,
    productRaw: productFile.data,
    productStats: productFile.stats,
    product,
    version: product.version,
    commit: product.commit
  };
}

function assertMayMutateInstall(install) {
  if (IS_WINDOWS || typeof process.geteuid !== 'function') return;
  const euid = process.geteuid();
  if (euid !== 0 && euid !== install.owner.uid) {
    throw sandError('EPERM', `Current user does not own Cursor installation ${install.root}`);
  }
}

function defaultAppRoot() {
  const candidates = [];
  if (process.env.CURSOR_APP_ROOT) candidates.push(process.env.CURSOR_APP_ROOT);
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Cursor.app/Contents/Resources/app');
    candidates.push(path.join(os.homedir(), 'Applications/Cursor.app/Contents/Resources/app'));
  } else if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'cursor', 'resources', 'app'));
    }
  } else {
    candidates.push('/usr/share/cursor/resources/app');
    candidates.push('/opt/Cursor/resources/app');
  }
  for (const candidate of candidates) {
    try {
      return loadInstall(candidate).root;
    } catch {
      // Continue through fixed, conventional locations.
    }
  }
  throw sandError('APP_NOT_FOUND', 'Cursor installation not found. Pass --app-root.');
}

function defaultStateRoot() {
  if (process.env.CURSOR_SAND_ROUTER_STATE) return path.resolve(process.env.CURSOR_SAND_ROUTER_STATE);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor Sand Router');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'Cursor Sand Router');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'cursor-sand-router');
}

function countMatches(text, regex) {
  return Array.from(text.matchAll(regex)).length;
}

function analyzeText(text) {
  const defaultSetter = /\.set\(\s*["']x-cursor-client-type["']\s*,\s*[A-Za-z_$][\w$]*\s*\?\?\s*["']ide["']\s*\)/g;
  const ideSetter = /\.set\(\s*["']x-cursor-client-type["']\s*,\s*["']ide["']\s*\)/g;
  const sandSetter = /\.set\(\s*["']x-cursor-client-type["']\s*,\s*["']sand["']\s*\)/g;
  const ideObject = /["']x-cursor-client-type["']\s*:\s*["']ide["']/g;
  const sandObject = /["']x-cursor-client-type["']\s*:\s*["']sand["']/g;
  return {
    headerMentions: countMatches(text, /x-cursor-client-type/g),
    unpatchedAssignments:
      countMatches(text, defaultSetter) + countMatches(text, ideSetter) + countMatches(text, ideObject),
    sandAssignments: countMatches(text, sandSetter) + countMatches(text, sandObject)
  };
}

function patchText(input) {
  let text = input;
  let replacements = 0;
  const replace = (regex, replacer) => {
    text = text.replace(regex, (...args) => {
      replacements += 1;
      return replacer(...args);
    });
  };
  replace(
    /(\.set\(\s*["']x-cursor-client-type["']\s*,\s*)[A-Za-z_$][\w$]*\s*\?\?\s*["']ide["'](\s*\))/g,
    (_match, prefix, suffix) => `${prefix}"sand"${suffix}`
  );
  replace(
    /(\.set\(\s*["']x-cursor-client-type["']\s*,\s*)["']ide["'](\s*\))/g,
    (_match, prefix, suffix) => `${prefix}"sand"${suffix}`
  );
  replace(
    /(["']x-cursor-client-type["']\s*:\s*)["']ide["']/g,
    (_match, prefix) => `${prefix}"sand"`
  );
  return { text, replacements, analysis: analyzeText(text) };
}

function readCandidate(install, id) {
  const absolute = targetPath(install.root, id);
  if (!validateParentChain(install.root, absolute, install.owner.uid, true)) return null;
  try {
    fs.lstatSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const file = readSecureFile(absolute, FILE_ID_MAP[id].rel, {
    maxSize: MAX_TARGET_BYTES,
    uid: install.owner.uid,
    gid: install.owner.gid
  });
  let text;
  try {
    text = utf8Decoder.decode(file.data);
  } catch (error) {
    throw sandError('INVALID_TARGET', `${FILE_ID_MAP[id].rel} is not valid UTF-8`, error);
  }
  return {
    id,
    rel: FILE_ID_MAP[id].rel,
    abs: absolute,
    data: file.data,
    stats: file.stats,
    text,
    analysis: analyzeText(text)
  };
}

function readCandidates(install) {
  return CANDIDATE_IDS.map((id) => readCandidate(install, id)).filter(Boolean);
}

function classifyCandidates(records, requireKnown = false) {
  let unpatched = 0;
  let patched = 0;
  for (const record of records) {
    const known = record.analysis.unpatchedAssignments + record.analysis.sandAssignments;
    assertCondition(
      record.analysis.headerMentions === known,
      'UNKNOWN_PATCH_STRUCTURE',
      `Unsupported ${HEADER} structure in ${record.rel}`
    );
    assertCondition(known <= 1, 'AMBIGUOUS_PATCH', `Unexpected match count in ${record.rel}`);
    unpatched += record.analysis.unpatchedAssignments;
    patched += record.analysis.sandAssignments;
  }
  if (requireKnown) {
    assertCondition(unpatched + patched > 0, 'PATCH_NOT_FOUND', `No supported ${HEADER} assignment was found`);
  }
  let state = 'absent';
  if (unpatched > 0 && patched === 0) state = 'unpatched';
  else if (patched > 0 && unpatched === 0) state = 'patched';
  else if (patched > 0 && unpatched > 0) state = 'partial';
  return { unpatched, patched, state };
}

function inspectLoaded(install) {
  const records = readCandidates(install);
  const classification = classifyCandidates(records);
  const files = records.map((record) => ({
    id: record.id,
    rel: record.rel,
    sha256: sha256(record.data),
    ...record.analysis
  }));
  return {
    appRoot: install.root,
    installId: install.installId,
    version: install.version,
    commit: install.commit,
    files,
    totals: {
      headerMentions: files.reduce((sum, file) => sum + file.headerMentions, 0),
      unpatchedAssignments: classification.unpatched,
      sandAssignments: classification.patched
    },
    state: classification.state,
    partial: classification.state === 'partial',
    patched: classification.state === 'patched'
  };
}

function inspect(appRoot) {
  return inspectLoaded(loadInstall(appRoot || defaultAppRoot()));
}

function checksumKey(id) {
  const rel = FILE_ID_MAP[id].rel;
  return rel.startsWith('out/') ? rel.slice(4) : null;
}

function assertProductChecksum(product, id, data, label) {
  const key = checksumKey(id);
  assertCondition(key !== null, 'INVALID_CHECKSUMS', `No checksum key for ${id}`);
  assertCondition(
    Object.prototype.hasOwnProperty.call(product.checksums, key),
    'INVALID_CHECKSUMS',
    `${label} is missing checksum ${key}`
  );
  const expected = vscodeChecksum(data);
  assertCondition(product.checksums[key] === expected, 'CHECKSUM_MISMATCH', `${label} checksum mismatch for ${key}`);
}

function metadataFromStats(stats) {
  const owner = ownerOf(stats);
  return { mode: modeOf(stats), uid: owner.uid, gid: owner.gid };
}

function makePlanEntry(id, target, before, after, stats) {
  return {
    id,
    target,
    before,
    after,
    ...metadataFromStats(stats)
  };
}

function entryDescriptor(entry) {
  return {
    id: entry.id,
    originalSha256: sha256(entry.before),
    patchedSha256: sha256(entry.after),
    originalSize: entry.before.length,
    patchedSize: entry.after.length,
    mode: entry.mode,
    uid: entry.uid,
    gid: entry.gid
  };
}

function planApply(install) {
  const records = readCandidates(install);
  const classification = classifyCandidates(records, true);
  assertCondition(classification.state !== 'partial', 'PARTIAL_PATCH_STATE', 'Refusing to apply over a partial Sand state');
  if (classification.state === 'patched') return { alreadyPatched: true, records };
  assertCondition(classification.state === 'unpatched', 'PATCH_NOT_FOUND', 'No patchable assignment was found');

  const entries = [];
  let replacementCount = 0;
  for (const record of records) {
    if (record.analysis.unpatchedAssignments === 0) continue;
    assertProductChecksum(install.product, record.id, record.data, 'product.json');
    const result = patchText(record.text);
    assertCondition(result.replacements === 1, 'AMBIGUOUS_PATCH', `Unexpected replacement count in ${record.rel}`);
    assertCondition(
      result.analysis.headerMentions === 1 &&
        result.analysis.unpatchedAssignments === 0 &&
        result.analysis.sandAssignments === 1,
      'POST_PATCH_STRUCTURE',
      `Patched structure is not exact in ${record.rel}`
    );
    const patched = Buffer.from(result.text, 'utf8');
    assertCondition(patched.length <= MAX_TARGET_BYTES, 'FILE_TOO_LARGE', `${record.rel} patched content is too large`);
    entries.push(makePlanEntry(record.id, record.abs, record.data, patched, record.stats));
    replacementCount += result.replacements;
  }
  assertCondition(entries.length > 0 && entries.length < MAX_RESULT_ENTRIES, 'PATCH_NOT_FOUND', 'No safe patch plan was produced');

  const nextProduct = parseJson(install.productRaw, 'product.json');
  for (const entry of entries) {
    nextProduct.checksums[checksumKey(entry.id)] = vscodeChecksum(entry.after);
  }
  const nextProductRaw = Buffer.from(`${JSON.stringify(nextProduct, null, '\t')}\n`, 'utf8');
  assertCondition(nextProductRaw.length <= MAX_PRODUCT_BYTES, 'FILE_TOO_LARGE', 'Patched product.json is too large');
  const checkedNextProduct = parseJson(nextProductRaw, 'patched product.json');
  validateProductJson(checkedNextProduct);
  for (const entry of entries) assertProductChecksum(checkedNextProduct, entry.id, entry.after, 'patched product.json');
  assertCondition(!install.productRaw.equals(nextProductRaw), 'INVALID_CHECKSUMS', 'product.json checksum update produced no change');
  entries.push(
    makePlanEntry(
      PRODUCT_ID,
      install.productPath,
      install.productRaw,
      nextProductRaw,
      install.productStats
    )
  );
  return { alreadyPatched: false, entries, replacementCount };
}

function resolveStateRoot(input, create) {
  const requested = path.resolve(input || defaultStateRoot());
  if (create) {
    try {
      const existed = fs.existsSync(requested);
      fs.mkdirSync(requested, { recursive: true, mode: PRIVATE_DIR_MODE });
      if (!existed) {
        fs.chmodSync(requested, PRIVATE_DIR_MODE);
        fsyncDirectory(path.dirname(requested));
      }
    } catch (error) {
      throw sandError(error.code || 'STATE_FAILED', `Cannot create state root ${requested}`, error);
    }
  }
  if (!fs.existsSync(requested)) return null;
  return canonicalExistingDirectory(requested, 'Sand state root');
}

function stateChild(stateRoot, ...parts) {
  const result = path.join(stateRoot, ...parts);
  assertContained(stateRoot, result, 'State path');
  return result;
}

function chownTo(filePath, owner) {
  if (IS_WINDOWS || owner.uid === null || typeof process.geteuid !== 'function' || process.geteuid() !== 0) return;
  fs.chownSync(filePath, owner.uid, owner.gid === null ? owner.uid : owner.gid);
}

function ensureContainer(stateRoot, name) {
  const dir = stateChild(stateRoot, name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
    fsyncDirectory(stateRoot);
  }
  validateDirectory(dir, `State container ${name}`);
  return dir;
}

function ensureInstallArea(stateRoot, name, install) {
  const container = ensureContainer(stateRoot, name);
  const dir = path.join(container, install.installId);
  assertContained(stateRoot, dir, `${name} install area`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
    chownTo(dir, install.owner);
    fsyncDirectory(container);
  }
  validateDirectory(dir, `${name} install area`, { private: true, uid: install.owner.uid });
  return dir;
}

function createPrivateDir(dir, owner) {
  fs.mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
  fs.chmodSync(dir, PRIVATE_DIR_MODE);
  chownTo(dir, owner);
  validateDirectory(dir, `Private directory ${dir}`, { private: true, uid: owner.uid });
  fsyncDirectory(path.dirname(dir));
}

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    if (!IS_WINDOWS && !['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeNewArtifact(filePath, data, owner) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE
    );
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    if (!IS_WINDOWS && owner.uid !== null && typeof process.geteuid === 'function' && process.geteuid() === 0) {
      fs.fchownSync(fd, owner.uid, owner.gid === null ? owner.uid : owner.gid);
    }
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(filePath));
  return readSecureFile(filePath, `Artifact ${filePath}`, {
    maxSize: Math.max(MAX_TARGET_BYTES, MAX_PRODUCT_BYTES),
    mode: PRIVATE_FILE_MODE,
    uid: owner.uid,
    gid: owner.gid
  });
}

function atomicArtifactWrite(filePath, data, owner) {
  const parent = path.dirname(filePath);
  validateDirectory(parent, `Artifact parent ${parent}`, { private: true, uid: owner.uid });
  const temp = path.join(parent, `.tmp-${crypto.randomBytes(24).toString('hex')}`);
  try {
    writeNewArtifact(temp, data, owner);
    const existing = readSecureFile(filePath, `Artifact ${filePath}`, {
      maxSize: Math.max(MAX_JOURNAL_BYTES, MAX_MANIFEST_BYTES),
      mode: PRIVATE_FILE_MODE,
      uid: owner.uid,
      gid: owner.gid
    });
    void existing;
    fs.renameSync(temp, filePath);
    fsyncDirectory(parent);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Best-effort cleanup of an uncommitted temporary artifact.
    }
    throw error;
  }
}

function writeJsonNew(filePath, value, owner, maxBytes, label) {
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  assertCondition(data.length <= maxBytes, 'FILE_TOO_LARGE', `${label} is too large`);
  writeNewArtifact(filePath, data, owner);
  return data;
}

function readJsonArtifact(filePath, owner, maxBytes, label) {
  const file = readSecureFile(filePath, label, {
    maxSize: maxBytes,
    mode: PRIVATE_FILE_MODE,
    uid: owner.uid,
    gid: owner.gid
  });
  return { value: parseJson(file.data, label), file };
}

function processStartToken(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return null;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      return fields[19] || null;
    }
    if (process.platform === 'darwin' || process.platform === 'freebsd') {
      const output = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        windowsHide: true
      }).trim();
      return output ? `${process.platform}:${output}` : null;
    }
    if (process.platform === 'win32') {
      const powershell = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      const output = execFileSync(powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[System.Diagnostics.Process]::GetProcessById([int]$args[0]).StartTime.ToUniversalTime().Ticks',
        String(pid)
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        windowsHide: true
      }).trim();
      return output ? `win32:${output}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

function lockOwnerRecord(install, nonce) {
  return {
    schemaVersion: 1,
    pid: process.pid,
    processStart: processStartToken(process.pid),
    hostname: os.hostname(),
    nonce,
    installId: install.installId,
    appRoot: install.root,
    createdAt: new Date().toISOString()
  };
}

function validateLockOwner(owner, install) {
  assertExactKeys(
    owner,
    ['schemaVersion', 'pid', 'processStart', 'hostname', 'nonce', 'installId', 'appRoot', 'createdAt'],
    'lock owner'
  );
  assertCondition(owner.schemaVersion === 1, 'INVALID_LOCK', 'Unsupported lock owner schema');
  assertCondition(Number.isSafeInteger(owner.pid) && owner.pid > 0, 'INVALID_LOCK', 'Invalid lock PID');
  assertCondition(owner.processStart === null ||
    (typeof owner.processStart === 'string' &&
      owner.processStart.length <= 256 &&
      !/[\0\r\n]/.test(owner.processStart)), 'INVALID_LOCK', 'Invalid process start token');
  validateIdentifierMetadata(owner.hostname, 'lock hostname');
  validateNonce(owner.nonce);
  assertCondition(owner.installId === install.installId, 'INVALID_LOCK', 'Lock install ID mismatch');
  assertCondition(owner.appRoot === install.root, 'INVALID_LOCK', 'Lock app root mismatch');
  assertIsoDate(owner.createdAt, 'lock createdAt');
}

function lockIsLive(owner) {
  if (owner.hostname !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
  const currentStart = processStartToken(owner.pid);
  if (owner.processStart !== null && currentStart !== null && owner.processStart !== currentStart) return false;
  return true;
}

function sameDirectoryIdentity(pathname, expected) {
  const current = fs.lstatSync(pathname);
  return current.isDirectory() && sameFileIdentity(current, expected);
}

function readLockOwner(lockPath, install) {
  validateDirectory(lockPath, 'operation lock', { private: true, uid: install.owner.uid });
  const ownerPath = path.join(lockPath, 'owner.json');
  const parsed = readJsonArtifact(ownerPath, install.owner, 16 * 1024, 'lock owner').value;
  validateLockOwner(parsed, install);
  return parsed;
}

function acquireLock(stateRoot, install, nonce) {
  const locks = ensureContainer(stateRoot, 'locks');
  const lockPath = path.join(locks, `${install.installId}.lock`);
  assertContained(stateRoot, lockPath, 'operation lock');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim = path.join(locks, `${install.installId}.claim-${crypto.randomBytes(16).toString('hex')}`);
    createPrivateDir(claim, install.owner);
    writeJsonNew(path.join(claim, 'owner.json'), lockOwnerRecord(install, nonce), install.owner, 16 * 1024, 'lock owner');
    try {
      fs.renameSync(claim, lockPath);
      fsyncDirectory(locks);
      const lockStats = validateDirectory(lockPath, 'operation lock', { private: true, uid: install.owner.uid });
      return { lockPath, lockStats, nonce, install };
    } catch (error) {
      try {
        fs.rmSync(claim, { recursive: true, force: true });
      } catch {
        // The claim never owned the canonical lock path.
      }
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      const existingStats = validateDirectory(lockPath, 'operation lock', {
        private: true,
        uid: install.owner.uid
      });
      const owner = readLockOwner(lockPath, install);
      if (lockIsLive(owner)) {
        throw sandError('LOCKED', `Another Sand operation is active for ${install.root}`);
      }
      assertCondition(sameDirectoryIdentity(lockPath, existingStats), 'LOCK_RACE', 'Operation lock changed during stale-lock recovery');
      const stale = path.join(locks, `${install.installId}.stale-${crypto.randomBytes(16).toString('hex')}`);
      fs.renameSync(lockPath, stale);
      fsyncDirectory(locks);
      fs.rmSync(stale, { recursive: true, force: false });
      fsyncDirectory(locks);
    }
  }
  throw sandError('LOCKED', `Unable to acquire Sand operation lock for ${install.root}`);
}

function releaseLock(lock) {
  const owner = readLockOwner(lock.lockPath, lock.install);
  assertCondition(safeStringEqual(owner.nonce, lock.nonce), 'LOCK_OWNERSHIP_LOST', 'Operation lock nonce changed');
  assertCondition(sameDirectoryIdentity(lock.lockPath, lock.lockStats), 'LOCK_OWNERSHIP_LOST', 'Operation lock was replaced');
  const parent = path.dirname(lock.lockPath);
  const released = path.join(parent, `${path.basename(lock.lockPath)}.released-${crypto.randomBytes(16).toString('hex')}`);
  fs.renameSync(lock.lockPath, released);
  fsyncDirectory(parent);
  fs.rmSync(released, { recursive: true, force: false });
  fsyncDirectory(parent);
}

function withOperationLock(stateRoot, install, nonce, operation) {
  const lock = acquireLock(stateRoot, install, nonce);
  let result;
  let operationError;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  try {
    releaseLock(lock);
  } catch (releaseError) {
    if (operationError) {
      operationError.lockReleaseError = releaseError;
    } else {
      throw releaseError;
    }
  }
  if (operationError) throw operationError;
  return result;
}

function assertIsoDate(value, label) {
  assertCondition(typeof value === 'string' && value.length <= 40, 'INVALID_SCHEMA', `Invalid ${label}`);
  const date = new Date(value);
  assertCondition(!Number.isNaN(date.getTime()) && date.toISOString() === value, 'INVALID_SCHEMA', `Invalid ${label}`);
}

function validateManifestEntry(entry, index) {
  assertExactKeys(
    entry,
    ['id', 'originalSha256', 'patchedSha256', 'originalSize', 'patchedSize', 'mode', 'uid', 'gid'],
    `manifest entry ${index}`
  );
  assertCondition(Object.prototype.hasOwnProperty.call(FILE_ID_MAP, entry.id), 'INVALID_MANIFEST', `Unknown manifest file ID: ${entry.id}`);
  assertCondition(HASH_RE.test(entry.originalSha256) && HASH_RE.test(entry.patchedSha256), 'INVALID_MANIFEST', `Invalid hash in manifest entry ${entry.id}`);
  assertCondition(entry.originalSha256 !== entry.patchedSha256, 'INVALID_MANIFEST', `Manifest entry ${entry.id} does not change`);
  const maximumSize = entry.id === PRODUCT_ID ? MAX_PRODUCT_BYTES : MAX_TARGET_BYTES;
  for (const field of ['originalSize', 'patchedSize']) {
    assertCondition(Number.isSafeInteger(entry[field]) && entry[field] >= 0 && entry[field] <= maximumSize, 'INVALID_MANIFEST', `Invalid ${field} in manifest entry ${entry.id}`);
  }
  assertCondition(Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777 && (IS_WINDOWS || (entry.mode & 0o022) === 0), 'INVALID_MANIFEST', `Invalid mode in manifest entry ${entry.id}`);
  for (const field of ['uid', 'gid']) {
    assertCondition(entry[field] === null || (Number.isSafeInteger(entry[field]) && entry[field] >= 0), 'INVALID_MANIFEST', `Invalid ${field} in manifest entry ${entry.id}`);
  }
}

function validateManifest(manifest, install, expectedOperationId) {
  assertExactKeys(
    manifest,
    ['schemaVersion', 'kind', 'operationId', 'installId', 'createdAt', 'appRoot', 'cursorVersion', 'cursorCommit', 'header', 'value', 'entries'],
    'manifest'
  );
  assertCondition(manifest.schemaVersion === MANIFEST_SCHEMA_VERSION, 'INVALID_MANIFEST', 'Unsupported manifest schema');
  assertCondition(manifest.kind === 'cursor-sand-backup', 'INVALID_MANIFEST', 'Invalid manifest kind');
  validateOperationId(manifest.operationId);
  if (expectedOperationId !== undefined) {
    assertCondition(manifest.operationId === expectedOperationId, 'INVALID_MANIFEST', 'Manifest operation ID mismatch');
  }
  assertCondition(manifest.installId === install.installId, 'INVALID_MANIFEST', 'Manifest install ID mismatch');
  assertIsoDate(manifest.createdAt, 'manifest createdAt');
  assertCondition(manifest.appRoot === install.root, 'APP_ROOT_MISMATCH', 'Manifest app root does not match the canonical installation');
  validateVersion(manifest.cursorVersion);
  validateCommit(manifest.cursorCommit);
  assertCondition(manifest.header === HEADER && manifest.value === VALUE, 'INVALID_MANIFEST', 'Manifest patch identity mismatch');
  assertCondition(Array.isArray(manifest.entries) && manifest.entries.length >= 2 && manifest.entries.length <= MAX_RESULT_ENTRIES, 'INVALID_MANIFEST', 'Manifest entry count is invalid');
  const seen = new Set();
  let previousOrder = -1;
  manifest.entries.forEach((entry, index) => {
    validateManifestEntry(entry, index);
    assertCondition(!seen.has(entry.id), 'INVALID_MANIFEST', `Duplicate manifest file ID: ${entry.id}`);
    seen.add(entry.id);
    const order = FILE_ID_MAP[entry.id].order;
    assertCondition(order > previousOrder, 'INVALID_MANIFEST', 'Manifest entries are not in fixed order');
    previousOrder = order;
  });
  assertCondition(manifest.entries[manifest.entries.length - 1].id === PRODUCT_ID, 'INVALID_MANIFEST', 'product.json must be the last manifest entry');
}

function createManifest(install, operationId, entries, createdAt) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: 'cursor-sand-backup',
    operationId,
    installId: install.installId,
    createdAt,
    appRoot: install.root,
    cursorVersion: install.version,
    cursorCommit: install.commit,
    header: HEADER,
    value: VALUE,
    entries: entries.map(entryDescriptor)
  };
}

const JOURNAL_STATUSES = new Set([
  'prepared',
  'writing',
  'verifying',
  'rolling-back',
  'rollback-failed',
  'rolled-back',
  'committed'
]);

function journalEntry(entry) {
  return {
    id: entry.id,
    beforeSha256: sha256(entry.before),
    afterSha256: sha256(entry.after),
    beforeSize: entry.before.length,
    afterSize: entry.after.length,
    mode: entry.mode,
    uid: entry.uid,
    gid: entry.gid
  };
}

function createJournal(install, operationId, nonce, kind, entries, manifestOperationId, createdAt) {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    operationId,
    installId: install.installId,
    kind,
    status: 'prepared',
    nonceHash: sha256(Buffer.from(nonce, 'utf8')),
    appRoot: install.root,
    cursorVersion: install.version,
    cursorCommit: install.commit,
    manifestOperationId,
    createdAt,
    updatedAt: createdAt,
    order: entries.map((entry) => entry.id),
    written: [],
    activeId: null,
    entries: entries.map(journalEntry)
  };
}

function validateJournalEntry(entry, index) {
  assertExactKeys(
    entry,
    ['id', 'beforeSha256', 'afterSha256', 'beforeSize', 'afterSize', 'mode', 'uid', 'gid'],
    `journal entry ${index}`
  );
  assertCondition(Object.prototype.hasOwnProperty.call(FILE_ID_MAP, entry.id), 'INVALID_JOURNAL', `Unknown journal file ID: ${entry.id}`);
  assertCondition(HASH_RE.test(entry.beforeSha256) && HASH_RE.test(entry.afterSha256), 'INVALID_JOURNAL', `Invalid journal hash for ${entry.id}`);
  assertCondition(entry.beforeSha256 !== entry.afterSha256, 'INVALID_JOURNAL', `Journal entry ${entry.id} does not change`);
  const maximumSize = entry.id === PRODUCT_ID ? MAX_PRODUCT_BYTES : MAX_TARGET_BYTES;
  for (const field of ['beforeSize', 'afterSize']) {
    assertCondition(Number.isSafeInteger(entry[field]) && entry[field] >= 0 && entry[field] <= maximumSize, 'INVALID_JOURNAL', `Invalid ${field} for ${entry.id}`);
  }
  assertCondition(Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777 && (IS_WINDOWS || (entry.mode & 0o022) === 0), 'INVALID_JOURNAL', `Invalid mode for ${entry.id}`);
  for (const field of ['uid', 'gid']) {
    assertCondition(entry[field] === null || (Number.isSafeInteger(entry[field]) && entry[field] >= 0), 'INVALID_JOURNAL', `Invalid ${field} for ${entry.id}`);
  }
}

function validateJournal(journal, install, expectedOperationId) {
  assertExactKeys(
    journal,
    ['schemaVersion', 'operationId', 'installId', 'kind', 'status', 'nonceHash', 'appRoot', 'cursorVersion', 'cursorCommit', 'manifestOperationId', 'createdAt', 'updatedAt', 'order', 'written', 'activeId', 'entries'],
    'journal'
  );
  assertCondition(journal.schemaVersion === JOURNAL_SCHEMA_VERSION, 'INVALID_JOURNAL', 'Unsupported journal schema');
  validateOperationId(journal.operationId);
  assertCondition(journal.operationId === expectedOperationId, 'INVALID_JOURNAL', 'Journal operation ID mismatch');
  assertCondition(journal.installId === install.installId, 'INVALID_JOURNAL', 'Journal install ID mismatch');
  assertCondition(journal.kind === 'apply' || journal.kind === 'restore', 'INVALID_JOURNAL', 'Invalid journal operation kind');
  assertCondition(JOURNAL_STATUSES.has(journal.status), 'INVALID_JOURNAL', 'Invalid journal status');
  assertCondition(HASH_RE.test(journal.nonceHash), 'INVALID_JOURNAL', 'Invalid journal nonce hash');
  assertCondition(journal.appRoot === install.root, 'APP_ROOT_MISMATCH', 'Journal app root mismatch');
  validateVersion(journal.cursorVersion);
  validateCommit(journal.cursorCommit);
  assertCondition(
    (journal.kind === 'apply' && journal.manifestOperationId === journal.operationId) ||
      (journal.kind === 'restore' && typeof journal.manifestOperationId === 'string' && ID_RE.test(journal.manifestOperationId)),
    'INVALID_JOURNAL',
    'Invalid journal manifest operation ID'
  );
  assertIsoDate(journal.createdAt, 'journal createdAt');
  assertIsoDate(journal.updatedAt, 'journal updatedAt');
  assertCondition(Array.isArray(journal.entries) && journal.entries.length >= 2 && journal.entries.length <= MAX_RESULT_ENTRIES, 'INVALID_JOURNAL', 'Invalid journal entry count');
  journal.entries.forEach(validateJournalEntry);
  const ids = journal.entries.map((entry) => entry.id);
  assertCondition(Array.isArray(journal.order) && journal.order.length === ids.length && journal.order.every((id, index) => id === ids[index]), 'INVALID_JOURNAL', 'Journal order does not match entries');
  assertCondition(new Set(ids).size === ids.length && ids[ids.length - 1] === PRODUCT_ID, 'INVALID_JOURNAL', 'Journal file IDs are invalid');
  assertCondition(Array.isArray(journal.written) && new Set(journal.written).size === journal.written.length && journal.written.every((id) => ids.includes(id)), 'INVALID_JOURNAL', 'Journal written set is invalid');
  assertCondition(journal.activeId === null || ids.includes(journal.activeId), 'INVALID_JOURNAL', 'Journal active file ID is invalid');
}

function persistJournal(transactionDir, journal, owner) {
  journal.updatedAt = new Date().toISOString();
  const data = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  assertCondition(data.length <= MAX_JOURNAL_BYTES, 'FILE_TOO_LARGE', 'Journal is too large');
  atomicArtifactWrite(path.join(transactionDir, 'journal.json'), data, owner);
}

function readJournal(transactionDir, install, operationId) {
  validateDirectory(transactionDir, `Transaction ${operationId}`, {
    private: true,
    uid: install.owner.uid
  });
  const parsed = readJsonArtifact(
    path.join(transactionDir, 'journal.json'),
    install.owner,
    MAX_JOURNAL_BYTES,
    'journal'
  ).value;
  validateJournal(parsed, install, operationId);
  return parsed;
}

function listPrivateOperationDirs(base, install) {
  if (!fs.existsSync(base)) return [];
  validateDirectory(base, `Operation area ${base}`, { private: true, uid: install.owner.uid });
  const result = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    assertCondition(entry.isDirectory() && !entry.isSymbolicLink(), 'UNSAFE_PATH', `Unexpected entry in ${base}: ${entry.name}`);
    validateOperationId(entry.name, 'operation directory name');
    const full = path.join(base, entry.name);
    validateDirectory(full, `Operation directory ${entry.name}`, {
      private: true,
      uid: install.owner.uid
    });
    result.push({ operationId: entry.name, path: full });
  }
  return result;
}

function artifactPath(directory, area, id) {
  assertCondition(Object.prototype.hasOwnProperty.call(FILE_ID_MAP, id), 'INVALID_FILE_ID', `Unknown fixed file ID: ${id}`);
  const result = path.join(directory, area, `${id}.bin`);
  assertContained(directory, result, `Artifact ${id}`);
  return result;
}

function validateArtifactArea(directory, area, install) {
  const areaPath = path.join(directory, area);
  assertContained(directory, areaPath, `Artifact area ${area}`);
  validateDirectory(areaPath, `Artifact area ${area}`, {
    private: true,
    uid: install.owner.uid
  });
  return areaPath;
}

function readTransactionArtifact(transactionDir, area, descriptor, install) {
  validateArtifactArea(transactionDir, area, install);
  const file = readSecureFile(
    artifactPath(transactionDir, area, descriptor.id),
    `${area} artifact ${descriptor.id}`,
    {
      maxSize: MAX_TARGET_BYTES,
      mode: PRIVATE_FILE_MODE,
      uid: install.owner.uid,
      gid: install.owner.gid
    }
  );
  const expectedSize = area === 'rollback' ? descriptor.beforeSize : descriptor.afterSize;
  const expectedHash = area === 'rollback' ? descriptor.beforeSha256 : descriptor.afterSha256;
  assertCondition(file.data.length === expectedSize && sha256(file.data) === expectedHash, 'ARTIFACT_CORRUPT', `${area} artifact ${descriptor.id} failed integrity verification`);
  return file.data;
}

function atomicReplaceTarget(install, descriptor, data, expectedCurrent = null) {
  const destination = targetPath(install.root, descriptor.id);
  validateParentChain(install.root, destination, descriptor.uid);
  const current = readSecureFile(destination, `Target ${descriptor.id}`, {
    maxSize: MAX_TARGET_BYTES,
    uid: descriptor.uid,
    gid: descriptor.gid,
    mode: descriptor.mode
  });
  if (expectedCurrent !== null) {
    assertCondition(
      current.data.length === expectedCurrent.size &&
        sha256(current.data) === expectedCurrent.sha256,
      'CURRENT_HASH_MISMATCH',
      `Target ${descriptor.id} changed immediately before replacement`
    );
  }
  const parent = path.dirname(destination);
  const temp = path.join(parent, `.cursor-sand-${crypto.randomBytes(24).toString('hex')}.tmp`);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  let replacementCommitted = false;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE
    );
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, descriptor.mode);
    if (!IS_WINDOWS && descriptor.uid !== null && typeof process.geteuid === 'function' && process.geteuid() === 0) {
      fs.fchownSync(fd, descriptor.uid, descriptor.gid === null ? descriptor.uid : descriptor.gid);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    validateParentChain(install.root, destination, descriptor.uid);
    const finalCurrent = readSecureFile(destination, `Target ${descriptor.id}`, {
      maxSize: MAX_TARGET_BYTES,
      uid: descriptor.uid,
      gid: descriptor.gid,
      mode: descriptor.mode
    });
    if (expectedCurrent !== null) {
      assertCondition(
        finalCurrent.data.length === expectedCurrent.size &&
          sha256(finalCurrent.data) === expectedCurrent.sha256,
        'CURRENT_HASH_MISMATCH',
        `Target ${descriptor.id} changed during replacement preparation`
      );
    }
    fs.renameSync(temp, destination);
    replacementCommitted = true;
    fsyncDirectory(parent);
    const verified = readSecureFile(destination, `Target ${descriptor.id}`, {
      maxSize: MAX_TARGET_BYTES,
      uid: descriptor.uid,
      gid: descriptor.gid,
      mode: descriptor.mode
    });
    assertCondition(verified.data.length === data.length && sha256(verified.data) === sha256(data), 'POST_WRITE_VERIFY_FAILED', `Atomic replacement verification failed for ${descriptor.id}`);
  } catch (error) {
    error.replacementCommitted = replacementCommitted;
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // A successful rename has no temporary file to remove.
    }
    throw error;
  }
}

function prepareTransaction(stateRoot, install, details) {
  const transactionBase = ensureInstallArea(stateRoot, 'transactions', install);
  const transactionDir = path.join(transactionBase, details.operationId);
  const backupBase = details.kind === 'apply' ? ensureInstallArea(stateRoot, 'backups', install) : null;
  const backupDir = backupBase ? path.join(backupBase, details.operationId) : null;
  assertCondition(!fs.existsSync(transactionDir), 'OPERATION_EXISTS', `Operation already exists: ${details.operationId}`);
  if (backupDir) assertCondition(!fs.existsSync(backupDir), 'OPERATION_EXISTS', `Backup already exists: ${details.operationId}`);

  try {
    createPrivateDir(transactionDir, install.owner);
    createPrivateDir(path.join(transactionDir, 'rollback'), install.owner);
    createPrivateDir(path.join(transactionDir, 'stage'), install.owner);
    if (backupDir) {
      createPrivateDir(backupDir, install.owner);
      createPrivateDir(path.join(backupDir, 'files'), install.owner);
    }

    for (const entry of details.entries) {
      writeNewArtifact(artifactPath(transactionDir, 'rollback', entry.id), entry.before, install.owner);
      writeNewArtifact(artifactPath(transactionDir, 'stage', entry.id), entry.after, install.owner);
      if (backupDir) {
        writeNewArtifact(artifactPath(backupDir, 'files', entry.id), entry.before, install.owner);
      }
    }

    if (backupDir) {
      const manifest = createManifest(install, details.operationId, details.entries, details.createdAt);
      validateManifest(manifest, install, details.operationId);
      writeJsonNew(
        path.join(backupDir, 'manifest.json'),
        manifest,
        install.owner,
        MAX_MANIFEST_BYTES,
        'manifest'
      );
    }

    const journal = createJournal(
      install,
      details.operationId,
      details.nonce,
      details.kind,
      details.entries,
      details.manifestOperationId,
      details.createdAt
    );
    validateJournal(journal, install, details.operationId);
    writeJsonNew(
      path.join(transactionDir, 'journal.json'),
      journal,
      install.owner,
      MAX_JOURNAL_BYTES,
      'journal'
    );

    for (const descriptor of journal.entries) {
      readTransactionArtifact(transactionDir, 'rollback', descriptor, install);
      readTransactionArtifact(transactionDir, 'stage', descriptor, install);
      if (backupDir) {
        const backup = readSecureFile(
          artifactPath(backupDir, 'files', descriptor.id),
          `Backup ${descriptor.id}`,
          {
            maxSize: MAX_TARGET_BYTES,
            mode: PRIVATE_FILE_MODE,
            uid: install.owner.uid,
            gid: install.owner.gid
          }
        );
        assertCondition(backup.data.length === descriptor.beforeSize && sha256(backup.data) === descriptor.beforeSha256, 'BACKUP_CORRUPT', `Backup ${descriptor.id} failed verification`);
      }
    }
    return { transactionDir, backupDir, journal };
  } catch (error) {
    try {
      if (fs.existsSync(transactionDir)) fs.rmSync(transactionDir, { recursive: true, force: true });
      if (backupDir && fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    } catch {
      // No installation file has been touched before journal preparation succeeds.
    }
    throw error;
  }
}

function verifyTargetAgainstDescriptor(install, descriptor, side) {
  const data = readSecureFile(targetPath(install.root, descriptor.id), `Target ${descriptor.id}`, {
    maxSize: MAX_TARGET_BYTES,
    uid: descriptor.uid,
    gid: descriptor.gid,
    mode: descriptor.mode
  }).data;
  const expectedHash = side === 'before' ? descriptor.beforeSha256 : descriptor.afterSha256;
  const expectedSize = side === 'before' ? descriptor.beforeSize : descriptor.afterSize;
  assertCondition(data.length === expectedSize && sha256(data) === expectedHash, 'POST_WRITE_VERIFY_FAILED', `Target ${descriptor.id} failed ${side} verification`);
  return data;
}

function verifySemanticState(install, journal, side) {
  const currentInstall = loadInstall(install.root);
  assertCondition(currentInstall.installId === install.installId, 'INSTALL_CHANGED', 'Cursor installation identity changed');
  assertCondition(currentInstall.version === journal.cursorVersion && currentInstall.commit === journal.cursorCommit, 'INSTALL_CHANGED', 'Cursor version or commit changed during operation');
  const candidateDescriptors = journal.entries.filter((entry) => entry.id !== PRODUCT_ID);
  for (const descriptor of candidateDescriptors) {
    const data = verifyTargetAgainstDescriptor(currentInstall, descriptor, side);
    assertProductChecksum(currentInstall.product, descriptor.id, data, 'product.json');
  }
  const status = inspectLoaded(currentInstall);
  const expectedState =
    journal.kind === 'apply'
      ? side === 'after'
        ? 'patched'
        : 'unpatched'
      : side === 'after'
        ? 'unpatched'
        : 'patched';
  assertCondition(status.state === expectedState, 'POST_WRITE_VERIFY_FAILED', `Expected ${expectedState} state, got ${status.state}`);
  return status;
}

function rollbackPreparedTransaction(install, transactionDir, journal) {
  const rollbackData = new Map();
  for (const descriptor of journal.entries) {
    rollbackData.set(
      descriptor.id,
      readTransactionArtifact(transactionDir, 'rollback', descriptor, install)
    );
  }
  const errors = [];
  try {
    journal.status = 'rolling-back';
    persistJournal(transactionDir, journal, install.owner);
  } catch (error) {
    errors.push(error);
  }
  const touched = new Set(journal.written);
  if (journal.activeId !== null) touched.add(journal.activeId);
  for (const descriptor of [...journal.entries].reverse()) {
    if (!touched.has(descriptor.id)) continue;
    try {
      const current = readSecureFile(targetPath(install.root, descriptor.id), `Target ${descriptor.id}`, {
        maxSize: MAX_TARGET_BYTES,
        uid: descriptor.uid,
        gid: descriptor.gid,
        mode: descriptor.mode
      }).data;
      const currentHash = sha256(current);
      if (currentHash === descriptor.beforeSha256 && current.length === descriptor.beforeSize)
        continue;
      assertCondition(
        currentHash === descriptor.afterSha256 &&
          current.length === descriptor.afterSize,
        'ROLLBACK_CONFLICT',
        `Target ${descriptor.id} changed outside this transaction; refusing rollback`
      );
      atomicReplaceTarget(install, descriptor, rollbackData.get(descriptor.id), {
        size: current.length,
        sha256: currentHash
      });
    } catch (error) {
      errors.push(error);
    }
  }
  for (const descriptor of journal.entries) {
    if (!touched.has(descriptor.id)) continue;
    try {
      verifyTargetAgainstDescriptor(install, descriptor, 'before');
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    try {
      journal.status = 'rollback-failed';
      persistJournal(transactionDir, journal, install.owner);
    } catch (error) {
      errors.push(error);
    }
    const failure = sandError('ROLLBACK_FAILED', `Sand transaction rollback failed: ${errors[0].message}`, errors[0]);
    failure.rollbackErrors = errors;
    throw failure;
  }
  journal.status = 'rolled-back';
  journal.activeId = null;
  persistJournal(transactionDir, journal, install.owner);
}

function executeTransaction(install, prepared) {
  const { transactionDir, journal } = prepared;
  try {
    for (const descriptor of journal.entries) {
      const staged = readTransactionArtifact(transactionDir, 'stage', descriptor, install);
      const current = verifyTargetAgainstDescriptor(install, descriptor, 'before');
      void current;
      journal.status = 'writing';
      journal.activeId = descriptor.id;
      try {
        persistJournal(transactionDir, journal, install.owner);
      } catch (error) {
        journal.activeId = null;
        throw error;
      }
      try {
        atomicReplaceTarget(install, descriptor, staged, {
          size: descriptor.beforeSize,
          sha256: descriptor.beforeSha256
        });
      } catch (error) {
        if (error.replacementCommitted === false) journal.activeId = null;
        throw error;
      }
      journal.written.push(descriptor.id);
      journal.activeId = null;
      persistJournal(transactionDir, journal, install.owner);
    }
    journal.status = 'verifying';
    persistJournal(transactionDir, journal, install.owner);
    for (const descriptor of journal.entries) verifyTargetAgainstDescriptor(install, descriptor, 'after');
    const after = verifySemanticState(install, journal, 'after');
    journal.status = 'committed';
    persistJournal(transactionDir, journal, install.owner);
    return after;
  } catch (error) {
    try {
      rollbackPreparedTransaction(install, transactionDir, journal);
    } catch (rollbackError) {
      rollbackError.operationError = error;
      throw rollbackError;
    }
    throw error;
  }
}

function recoverTransaction(install, transactionDir, journal) {
  const rollbackData = new Map();
  const currentSides = new Map();
  const touched = new Set(journal.written);
  if (journal.activeId !== null) touched.add(journal.activeId);
  for (const descriptor of journal.entries) {
    rollbackData.set(
      descriptor.id,
      readTransactionArtifact(transactionDir, 'rollback', descriptor, install)
    );
    const current = readSecureFile(targetPath(install.root, descriptor.id), `Target ${descriptor.id}`, {
      maxSize: MAX_TARGET_BYTES,
      uid: descriptor.uid,
      gid: descriptor.gid,
      mode: descriptor.mode
    }).data;
    const currentHash = sha256(current);
    if (current.length === descriptor.beforeSize && currentHash === descriptor.beforeSha256) {
      currentSides.set(descriptor.id, 'before');
    } else if (
      touched.has(descriptor.id) &&
      current.length === descriptor.afterSize &&
      currentHash === descriptor.afterSha256
    ) {
      currentSides.set(descriptor.id, 'after');
    } else {
      throw sandError('RECOVERY_CONFLICT', `Cannot recover ${journal.operationId}: ${descriptor.id} no longer matches either transaction state`);
    }
  }

  journal.status = 'rolling-back';
  persistJournal(transactionDir, journal, install.owner);
  for (const descriptor of [...journal.entries].reverse()) {
    if (touched.has(descriptor.id) && currentSides.get(descriptor.id) === 'after') {
      atomicReplaceTarget(install, descriptor, rollbackData.get(descriptor.id), {
        size: descriptor.afterSize,
        sha256: descriptor.afterSha256
      });
    }
  }
  for (const descriptor of journal.entries) verifyTargetAgainstDescriptor(install, descriptor, 'before');
  journal.status = 'rolled-back';
  journal.activeId = null;
  persistJournal(transactionDir, journal, install.owner);
}

function cleanupOrphanBackups(stateRoot, install) {
  const backupsContainer = stateChild(stateRoot, 'backups');
  if (!fs.existsSync(backupsContainer)) return;
  validateDirectory(backupsContainer, 'backups container');
  const backupBase = path.join(backupsContainer, install.installId);
  if (!fs.existsSync(backupBase)) return;
  const transactionBase = path.join(
    stateChild(stateRoot, 'transactions'),
    install.installId
  );
  for (const item of listPrivateOperationDirs(backupBase, install)) {
    const transactionDir = path.join(transactionBase, item.operationId);
    const journalPath = path.join(transactionDir, 'journal.json');
    if (fs.existsSync(journalPath)) continue;
    fs.rmSync(item.path, { recursive: true, force: false });
    fsyncDirectory(backupBase);
  }
}

function recoverIncompleteTransactions(stateRoot, install) {
  cleanupOrphanBackups(stateRoot, install);
  const container = stateChild(stateRoot, 'transactions');
  if (!fs.existsSync(container)) return [];
  validateDirectory(container, 'transactions container');
  const base = path.join(container, install.installId);
  if (!fs.existsSync(base)) return [];
  const recovered = [];
  for (const item of listPrivateOperationDirs(base, install)) {
    const journalPath = path.join(item.path, 'journal.json');
    if (!fs.existsSync(journalPath)) {
      fs.rmSync(item.path, { recursive: true, force: false });
      continue;
    }
    const journal = readJournal(item.path, install, item.operationId);
    if (journal.status === 'committed') continue;
    if (journal.status === 'rolled-back') {
      verifySemanticState(install, journal, 'before');
      if (journal.kind === 'apply') {
        const backupBase = path.join(
          stateChild(stateRoot, 'backups'),
          install.installId
        );
        const backupDir = path.join(backupBase, item.operationId);
        if (fs.existsSync(backupDir)) {
          validateDirectory(backupDir, `Rolled-back backup ${item.operationId}`, {
            private: true,
            uid: install.owner.uid
          });
          fs.rmSync(backupDir, { recursive: true, force: false });
          fsyncDirectory(backupBase);
        }
      }
      fs.rmSync(item.path, { recursive: true, force: false });
      fsyncDirectory(base);
      continue;
    }
    recoverTransaction(install, item.path, journal);
    recovered.push(item.operationId);
  }
  return recovered;
}

function readManifestAt(backupDir, install, operationId) {
  validateDirectory(backupDir, `Backup ${operationId}`, {
    private: true,
    uid: install.owner.uid
  });
  const manifest = readJsonArtifact(
    path.join(backupDir, 'manifest.json'),
    install.owner,
    MAX_MANIFEST_BYTES,
    'manifest'
  ).value;
  validateManifest(manifest, install, operationId);
  return manifest;
}

function assertManifestMatchesJournal(manifest, journal) {
  assertCondition(journal.kind === 'apply', 'INVALID_MANIFEST', 'A backup manifest must belong to an apply transaction');
  assertCondition(
    manifest.operationId === journal.operationId &&
      manifest.installId === journal.installId &&
      manifest.appRoot === journal.appRoot &&
      manifest.cursorVersion === journal.cursorVersion &&
      manifest.cursorCommit === journal.cursorCommit &&
      manifest.createdAt === journal.createdAt &&
      journal.manifestOperationId === manifest.operationId,
    'INVALID_MANIFEST',
    'Manifest identity does not match its transaction journal'
  );
  assertCondition(
    manifest.entries.length === journal.entries.length,
    'INVALID_MANIFEST',
    'Manifest entries do not match the transaction journal'
  );
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const backup = manifest.entries[index];
    const transaction = journal.entries[index];
    assertCondition(
      backup.id === transaction.id &&
        backup.originalSha256 === transaction.beforeSha256 &&
        backup.patchedSha256 === transaction.afterSha256 &&
        backup.originalSize === transaction.beforeSize &&
        backup.patchedSize === transaction.afterSize &&
        backup.mode === transaction.mode &&
        backup.uid === transaction.uid &&
        backup.gid === transaction.gid,
      'INVALID_MANIFEST',
      `Manifest entry ${backup.id} does not match its transaction journal`
    );
  }
}

function committedManifests(stateRoot, install) {
  const backupsContainer = stateChild(stateRoot, 'backups');
  if (!fs.existsSync(backupsContainer)) return [];
  validateDirectory(backupsContainer, 'backups container');
  const backupBase = path.join(backupsContainer, install.installId);
  if (!fs.existsSync(backupBase)) return [];
  const transactionsContainer = stateChild(stateRoot, 'transactions');
  assertCondition(fs.existsSync(transactionsContainer), 'INVALID_JOURNAL', 'Transaction container is missing');
  validateDirectory(transactionsContainer, 'transactions container');
  const transactionBase = path.join(transactionsContainer, install.installId);
  assertCondition(fs.existsSync(transactionBase), 'INVALID_JOURNAL', 'Transaction install area is missing');
  validateDirectory(transactionBase, 'transaction install area', {
    private: true,
    uid: install.owner.uid
  });
  const result = [];
  for (const item of listPrivateOperationDirs(backupBase, install)) {
    const manifestPath = path.join(item.path, 'manifest.json');
    assertCondition(fs.existsSync(manifestPath), 'INVALID_MANIFEST', `Backup ${item.operationId} has no manifest`);
    const manifest = readManifestAt(item.path, install, item.operationId);
    const transactionDir = path.join(transactionBase, item.operationId);
    if (!fs.existsSync(transactionDir) || !fs.existsSync(path.join(transactionDir, 'journal.json'))) {
      continue;
    }
    const journal = readJournal(transactionDir, install, item.operationId);
    assertManifestMatchesJournal(manifest, journal);
    if (
      journal.kind === 'apply' &&
      journal.manifestOperationId === manifest.operationId &&
      journal.status === 'committed'
    ) {
      result.push({ manifest, manifestPath, backupDir: item.path, journal });
    }
  }
  result.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
  return result;
}

function verifyManagedPatchedState(stateRoot, install, records) {
  const candidates = committedManifests(stateRoot, install);
  for (const candidate of candidates) {
    if (
      candidate.manifest.cursorVersion !== install.version ||
      candidate.manifest.cursorCommit !== install.commit
    ) {
      continue;
    }
    let matches = true;
    const byId = new Map(candidate.manifest.entries.map((entry) => [entry.id, entry]));
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const manifestCandidateIds = candidate.manifest.entries
      .filter((entry) => entry.id !== PRODUCT_ID)
      .map((entry) => entry.id);
    const patchedRecordIds = records
      .filter((record) => record.analysis.sandAssignments === 1)
      .map((record) => record.id);
    if (
      manifestCandidateIds.length !== patchedRecordIds.length ||
      manifestCandidateIds.some((id) => !patchedRecordIds.includes(id))
    ) {
      matches = false;
    }
    for (const id of manifestCandidateIds) {
      const entry = byId.get(id);
      const record = recordsById.get(id);
      if (!record || entry.patchedSha256 !== sha256(record.data) || entry.patchedSize !== record.data.length) {
        matches = false;
        break;
      }
    }
    const productEntry = byId.get(PRODUCT_ID);
    if (!productEntry || productEntry.patchedSha256 !== sha256(install.productRaw)) matches = false;
    if (matches) return candidate;
  }
  return null;
}

function validateManifestForRestore(candidate, install) {
  const manifest = candidate.manifest;
  assertCondition(manifest.cursorVersion === install.version, 'VERSION_MISMATCH', `Backup is for Cursor ${manifest.cursorVersion}, current version is ${install.version}`);
  assertCondition(manifest.cursorCommit === install.commit, 'COMMIT_MISMATCH', 'Backup Cursor commit does not match the current installation');
  assertCondition(manifest.appRoot === install.root && manifest.installId === install.installId, 'APP_ROOT_MISMATCH', 'Backup belongs to a different Cursor installation');

  const entries = [];
  const originals = new Map();
  const currents = new Map();
  validateArtifactArea(candidate.backupDir, 'files', install);
  for (const descriptor of manifest.entries) {
    const target = targetPath(install.root, descriptor.id);
    validateParentChain(install.root, target, descriptor.uid);
    const current = readSecureFile(target, `Restore target ${descriptor.id}`, {
      maxSize: MAX_TARGET_BYTES,
      uid: descriptor.uid,
      gid: descriptor.gid,
      mode: descriptor.mode
    }).data;
    assertCondition(
      current.length === descriptor.patchedSize && sha256(current) === descriptor.patchedSha256,
      'CURRENT_HASH_MISMATCH',
      `Refusing restore because ${descriptor.id} does not match the committed patched hash`
    );
    const backup = readSecureFile(
      artifactPath(candidate.backupDir, 'files', descriptor.id),
      `Backup ${descriptor.id}`,
      {
        maxSize: MAX_TARGET_BYTES,
        mode: PRIVATE_FILE_MODE,
        uid: install.owner.uid,
        gid: install.owner.gid
      }
    ).data;
    assertCondition(
      backup.length === descriptor.originalSize && sha256(backup) === descriptor.originalSha256,
      'BACKUP_CORRUPT',
      `Backup integrity check failed for ${descriptor.id}`
    );
    currents.set(descriptor.id, current);
    originals.set(descriptor.id, backup);
    entries.push({
      id: descriptor.id,
      target,
      before: current,
      after: backup,
      mode: descriptor.mode,
      uid: descriptor.uid,
      gid: descriptor.gid
    });
  }

  const currentProduct = parseJson(currents.get(PRODUCT_ID), 'current product.json');
  const originalProduct = parseJson(originals.get(PRODUCT_ID), 'backup product.json');
  validateProductJson(currentProduct);
  validateProductJson(originalProduct);
  assertCondition(currentProduct.version === install.version && currentProduct.commit === install.commit, 'INSTALL_CHANGED', 'Current product identity changed');
  assertCondition(originalProduct.version === manifest.cursorVersion && originalProduct.commit === manifest.cursorCommit, 'BACKUP_CORRUPT', 'Backup product identity does not match its manifest');
  for (const descriptor of manifest.entries.filter((entry) => entry.id !== PRODUCT_ID)) {
    assertProductChecksum(currentProduct, descriptor.id, currents.get(descriptor.id), 'current product.json');
    assertProductChecksum(originalProduct, descriptor.id, originals.get(descriptor.id), 'backup product.json');
  }
  return entries;
}

function applyPatch(options = {}) {
  assertKnownOptions(options, ['appRoot', 'stateRoot', 'dryRun', 'operationId', 'nonce'], 'apply');
  const install = loadInstall(options.appRoot || defaultAppRoot());
  const operationId = options.operationId === undefined ? randomId('apply') : validateOperationId(options.operationId);
  const nonce = options.nonce === undefined ? randomId('nonce') : validateNonce(options.nonce);
  assertCondition(options.dryRun === undefined || typeof options.dryRun === 'boolean', 'INVALID_ARGUMENT', 'dryRun must be boolean');
  if (options.dryRun === true) {
    const planned = planApply(install);
    if (planned.alreadyPatched) {
      const readOnlyStateRoot = resolveStateRoot(options.stateRoot || defaultStateRoot(), false);
      const managed = readOnlyStateRoot
        ? verifyManagedPatchedState(readOnlyStateRoot, install, planned.records)
        : null;
      assertCondition(managed, 'UNMANAGED_PATCH', 'Installation is patched but does not match a committed Sand manifest');
      const status = inspectLoaded(install);
      return {
        changed: false,
        dryRun: true,
        reason: 'already-patched',
        operationId,
        nonce,
        before: status,
        after: status,
        backupDir: managed.backupDir
      };
    }
    return {
      changed: true,
      dryRun: true,
      operationId,
      nonce,
      replacementCount: planned.replacementCount,
      files: planned.entries.filter((entry) => entry.id !== PRODUCT_ID).map((entry) => ({
        id: entry.id,
        rel: FILE_ID_MAP[entry.id].rel,
        replacements: 1
      })),
      before: inspectLoaded(install),
      backupDir: null
    };
  }
  assertMayMutateInstall(install);
  const stateRoot = resolveStateRoot(options.stateRoot || defaultStateRoot(), true);
  return withOperationLock(stateRoot, install, nonce, () => {
    const recovered = recoverIncompleteTransactions(stateRoot, install);
    const freshInstall = loadInstall(install.root);
    const freshPlan = planApply(freshInstall);
    if (freshPlan.alreadyPatched) {
      const managed = verifyManagedPatchedState(stateRoot, freshInstall, freshPlan.records);
      assertCondition(managed, 'UNMANAGED_PATCH', 'Installation is patched but does not match a committed Sand manifest');
      return {
        changed: false,
        reason: 'already-patched',
        operationId,
        nonce,
        recovered,
        before: inspectLoaded(freshInstall),
        after: inspectLoaded(freshInstall),
        backupDir: managed.backupDir
      };
    }
    const createdAt = new Date().toISOString();
    const prepared = prepareTransaction(stateRoot, freshInstall, {
      operationId,
      nonce,
      kind: 'apply',
      entries: freshPlan.entries,
      manifestOperationId: operationId,
      createdAt
    });
    const before = inspectLoaded(freshInstall);
    const after = executeTransaction(freshInstall, prepared);
    return {
      changed: true,
      dryRun: false,
      operationId,
      nonce,
      recovered,
      replacementCount: freshPlan.replacementCount,
      files: freshPlan.entries.filter((entry) => entry.id !== PRODUCT_ID).map((entry) => ({
        id: entry.id,
        rel: FILE_ID_MAP[entry.id].rel,
        replacements: 1
      })),
      before,
      after,
      backupDir: prepared.backupDir
    };
  });
}

function restoreLatest(options = {}) {
  assertKnownOptions(options, ['appRoot', 'stateRoot', 'operationId', 'nonce'], 'restore');
  const install = loadInstall(options.appRoot || defaultAppRoot());
  const operationId = options.operationId === undefined ? randomId('restore') : validateOperationId(options.operationId);
  const nonce = options.nonce === undefined ? randomId('nonce') : validateNonce(options.nonce);
  assertMayMutateInstall(install);
  const stateRoot = resolveStateRoot(options.stateRoot || defaultStateRoot(), true);
  return withOperationLock(stateRoot, install, nonce, () => {
    const recovered = recoverIncompleteTransactions(stateRoot, install);
    const freshInstall = loadInstall(install.root);
    const manifests = committedManifests(stateRoot, freshInstall);
    assertCondition(manifests.length > 0, 'BACKUP_NOT_FOUND', `No committed backup manifest found for ${freshInstall.root}`);
    const selected = manifests[0];
    const entries = validateManifestForRestore(selected, freshInstall);
    const createdAt = new Date().toISOString();
    const prepared = prepareTransaction(stateRoot, freshInstall, {
      operationId,
      nonce,
      kind: 'restore',
      entries,
      manifestOperationId: selected.manifest.operationId,
      createdAt
    });
    const after = executeTransaction(freshInstall, prepared);
    return {
      restored: entries.map((entry) => ({ id: entry.id, rel: FILE_ID_MAP[entry.id].rel })),
      operationId,
      nonce,
      recovered,
      backupDir: selected.backupDir,
      after
    };
  });
}

function findLatestManifest(appRoot, stateRoot) {
  const install = loadInstall(appRoot || defaultAppRoot());
  const root = resolveStateRoot(stateRoot || defaultStateRoot(), false);
  if (!root) return null;
  const manifests = committedManifests(root, install);
  return manifests.length > 0 ? manifests[0].manifestPath : null;
}

module.exports = {
  HEADER,
  VALUE,
  MANIFEST_SCHEMA_VERSION,
  FILE_ID_MAP,
  CANDIDATE_FILES,
  analyzeText,
  applyPatch,
  defaultAppRoot,
  defaultStateRoot,
  deriveInstallId,
  findLatestManifest,
  inspect,
  patchText,
  restoreLatest,
  sha256,
  vscodeChecksum
};
