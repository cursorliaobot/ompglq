'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sand = require('../src/sandPatcher');

let sequence = 0;

function nextId(prefix) {
  sequence += 1;
  return `${prefix}-test-${String(sequence).padStart(8, '0')}`;
}

function nextNonce() {
  sequence += 1;
  return `nonce-test-${String(sequence).padStart(24, '0')}`;
}

function writeFile(filePath, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, data, { mode });
  fs.chmodSync(filePath, mode);
}

function makeFixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sand-patcher-test-'));
  fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const appRoot = path.join(base, 'app');
  const stateRoot = path.join(base, 'state');
  fs.mkdirSync(path.join(appRoot, 'out'), { recursive: true, mode: 0o700 });
  fs.chmodSync(appRoot, 0o700);
  fs.chmodSync(path.join(appRoot, 'out'), 0o700);

  const originals = new Map();
  const main = Buffer.from('const headers = new Map(); headers.set("x-cursor-client-type", "ide");\n');
  const mainPath = path.join(appRoot, 'out', 'main.js');
  writeFile(mainPath, main);
  originals.set('main', main);

  if (options.twoFiles !== false) {
    const worker = Buffer.from('const requestHeaders = {"x-cursor-client-type":"ide"};\n');
    const workerPath = path.join(
      appRoot,
      'out',
      'vs',
      'workbench',
      'api',
      'worker',
      'extensionHostWorkerMain.js'
    );
    writeFile(workerPath, worker);
    originals.set('extension-host-worker', worker);
    for (
      let current = path.dirname(workerPath);
      current.startsWith(path.join(appRoot, 'out'));
      current = path.dirname(current)
    ) {
      fs.chmodSync(current, 0o700);
      if (current === path.join(appRoot, 'out')) break;
    }
  }

  const checksums = {};
  for (const [id, data] of originals) {
    const rel = sand.FILE_ID_MAP[id].rel.slice('out/'.length);
    checksums[rel] = sand.vscodeChecksum(data);
  }
  const product = {
    nameShort: 'Cursor',
    version: options.version || '1.2.3',
    commit: options.commit || 'a'.repeat(40),
    checksums
  };
  const productRaw = Buffer.from(`${JSON.stringify(product, null, 2)}\n`);
  writeFile(path.join(appRoot, 'product.json'), productRaw);
  originals.set('product', productRaw);
  return { base, appRoot, stateRoot, originals };
}

function applyFixture(fixture) {
  return sand.applyPatch({
    appRoot: fixture.appRoot,
    stateRoot: fixture.stateRoot,
    operationId: nextId('apply'),
    nonce: nextNonce()
  });
}

function restoreFixture(fixture) {
  return sand.restoreLatest({
    appRoot: fixture.appRoot,
    stateRoot: fixture.stateRoot,
    operationId: nextId('restore'),
    nonce: nextNonce()
  });
}

function appSnapshot(fixture) {
  const result = {};
  for (const id of [...fixture.originals.keys()]) {
    result[id] = fs.readFileSync(
      path.join(fixture.appRoot, ...sand.FILE_ID_MAP[id].rel.split('/'))
    );
  }
  return result;
}

function assertSnapshotEqual(actual, expected) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected)) assert.deepEqual(actual[key], expected[key], key);
}

test('manifest v2 uses only fixed file IDs and round-trips transactionally', (t) => {
  const fixture = makeFixture(t);
  const applied = applyFixture(fixture);
  assert.equal(applied.after.state, 'patched');
  assert.equal(applied.after.patched, true);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(applied.backupDir, 'manifest.json'), 'utf8')
  );
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(
    manifest.entries.map((entry) => entry.id),
    ['main', 'extension-host-worker', 'product']
  );
  for (const entry of manifest.entries) {
    assert.equal(Object.hasOwn(entry, 'rel'), false);
    assert.equal(Object.hasOwn(entry, 'backupRel'), false);
  }

  const restored = restoreFixture(fixture);
  assert.equal(restored.after.state, 'unpatched');
  assertSnapshotEqual(appSnapshot(fixture), Object.fromEntries(fixture.originals));
});

test('malicious manifest traversal fields and unknown IDs fail closed', (t) => {
  const fixture = makeFixture(t, { twoFiles: false });
  const applied = applyFixture(fixture);
  const manifestPath = path.join(applied.backupDir, 'manifest.json');
  const originalManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const outside = path.join(fixture.base, 'outside.txt');
  writeFile(outside, Buffer.from('sentinel'));

  const traversing = structuredClone(originalManifest);
  traversing.entries[0].rel = '../../outside.txt';
  fs.writeFileSync(manifestPath, `${JSON.stringify(traversing, null, 2)}\n`);
  const before = appSnapshot(fixture);
  assert.throws(
    () => restoreFixture(fixture),
    (error) => error && error.code === 'INVALID_SCHEMA'
  );
  assertSnapshotEqual(appSnapshot(fixture), before);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');

  const unknown = structuredClone(originalManifest);
  unknown.entries[0].id = '../../outside';
  fs.writeFileSync(manifestPath, `${JSON.stringify(unknown, null, 2)}\n`);
  assert.throws(
    () => restoreFixture(fixture),
    (error) => error && error.code === 'INVALID_MANIFEST'
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');
});

test('symlink and hardlink candidates are rejected without touching their referents', (t) => {
  const symlinkFixture = makeFixture(t, { twoFiles: false });
  const target = path.join(symlinkFixture.appRoot, 'out', 'main.js');
  const outside = path.join(symlinkFixture.base, 'outside.js');
  fs.renameSync(target, outside);
  fs.symlinkSync(outside, target);
  assert.throws(
    () => applyFixture(symlinkFixture),
    (error) => error && error.code === 'UNSAFE_FILE'
  );
  assert.deepEqual(fs.readFileSync(outside), symlinkFixture.originals.get('main'));

  const hardlinkFixture = makeFixture(t, { twoFiles: false });
  const hardTarget = path.join(hardlinkFixture.appRoot, 'out', 'main.js');
  const hardOutside = path.join(hardlinkFixture.base, 'hardlink.js');
  fs.linkSync(hardTarget, hardOutside);
  assert.throws(
    () => applyFixture(hardlinkFixture),
    (error) => error && error.code === 'UNSAFE_FILE'
  );
  assert.deepEqual(fs.readFileSync(hardOutside), hardlinkFixture.originals.get('main'));
});

test('unknown patch structures, unsafe modes, and malformed checksums are rejected', (t) => {
  const unknownFixture = makeFixture(t, { twoFiles: false });
  const target = path.join(unknownFixture.appRoot, 'out', 'main.js');
  writeFile(target, Buffer.from('const name = "x-cursor-client-type";\n'));
  assert.throws(
    () => applyFixture(unknownFixture),
    (error) => error && error.code === 'UNKNOWN_PATCH_STRUCTURE'
  );

  const modeFixture = makeFixture(t, { twoFiles: false });
  fs.chmodSync(path.join(modeFixture.appRoot, 'out', 'main.js'), 0o666);
  assert.throws(
    () => applyFixture(modeFixture),
    (error) => error && error.code === 'UNSAFE_MODE'
  );

  const checksumFixture = makeFixture(t, { twoFiles: false });
  const productPath = path.join(checksumFixture.appRoot, 'product.json');
  const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
  delete product.checksums['main.js'];
  writeFile(productPath, Buffer.from(`${JSON.stringify(product, null, 2)}\n`));
  const before = fs.readFileSync(path.join(checksumFixture.appRoot, 'out', 'main.js'));
  assert.throws(
    () => applyFixture(checksumFixture),
    (error) => error && error.code === 'INVALID_CHECKSUMS'
  );
  assert.deepEqual(fs.readFileSync(path.join(checksumFixture.appRoot, 'out', 'main.js')), before);
});

test('restore performs zero installation writes on version mismatch', (t) => {
  const fixture = makeFixture(t);
  applyFixture(fixture);
  const productPath = path.join(fixture.appRoot, 'product.json');
  const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
  product.version = '9.9.9';
  writeFile(productPath, Buffer.from(`${JSON.stringify(product, null, 2)}\n`));
  const before = appSnapshot(fixture);

  assert.throws(
    () => restoreFixture(fixture),
    (error) => error && error.code === 'VERSION_MISMATCH'
  );
  assertSnapshotEqual(appSnapshot(fixture), before);
});

test('restore performs zero installation writes when a backup is tampered', (t) => {
  const fixture = makeFixture(t);
  const applied = applyFixture(fixture);
  const backup = path.join(applied.backupDir, 'files', 'main.bin');
  writeFile(backup, Buffer.from('attacker-controlled backup'));
  const before = appSnapshot(fixture);

  assert.throws(
    () => restoreFixture(fixture),
    (error) => error && error.code === 'BACKUP_CORRUPT'
  );
  assertSnapshotEqual(appSnapshot(fixture), before);
});

test('restore rejects a symlinked backup directory without installation writes', (t) => {
  const fixture = makeFixture(t);
  const applied = applyFixture(fixture);
  const filesDir = path.join(applied.backupDir, 'files');
  const movedDir = path.join(applied.backupDir, 'files-real');
  fs.renameSync(filesDir, movedDir);
  fs.symlinkSync(movedDir, filesDir);
  const before = appSnapshot(fixture);

  assert.throws(
    () => restoreFixture(fixture),
    (error) => error && error.code === 'UNSAFE_PATH'
  );
  assertSnapshotEqual(appSnapshot(fixture), before);
});

test('restore performs zero installation writes for a partial current state', (t) => {
  const fixture = makeFixture(t);
  applyFixture(fixture);
  const workerPath = path.join(
    fixture.appRoot,
    ...sand.FILE_ID_MAP['extension-host-worker'].rel.split('/')
  );
  writeFile(workerPath, fixture.originals.get('extension-host-worker'));
  const before = appSnapshot(fixture);

  assert.throws(
    () => restoreFixture(fixture),
    (error) => error && error.code === 'CURRENT_HASH_MISMATCH'
  );
  assertSnapshotEqual(appSnapshot(fixture), before);
});

test('a product write fault rolls every earlier file back in reverse transaction order', (t) => {
  const fixture = makeFixture(t);
  const productPath = path.join(fixture.appRoot, 'product.json');
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = function patchedRename(from, to) {
    if (
      !injected &&
      to === productPath &&
      path.basename(from).startsWith('.cursor-sand-')
    ) {
      injected = true;
      const error = new Error('injected product write failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  try {
    assert.throws(
      () => applyFixture(fixture),
      (error) => error && error.code === 'EIO'
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(injected, true);
  assertSnapshotEqual(appSnapshot(fixture), Object.fromEntries(fixture.originals));
  assert.equal(sand.inspect(fixture.appRoot).state, 'unpatched');
});

test('target changed while replacement is staged is never overwritten', (t) => {
  const fixture = makeFixture(t);
  const mainPath = path.join(fixture.appRoot, 'out', 'main.js');
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeFileSync;
  const openedPaths = new Map();
  let injected = false;
  fs.openSync = function patchedOpen(file, ...args) {
    const fd = originalOpen.call(this, file, ...args);
    if (typeof file === 'string')
      openedPaths.set(fd, file);
    return fd;
  };
  fs.writeFileSync = function patchedWrite(file, data, ...args) {
    const result = originalWrite.call(this, file, data, ...args);
    const opened = typeof file === 'number' ? openedPaths.get(file) : '';
    if (!injected &&
        opened &&
        path.dirname(opened) === path.dirname(mainPath) &&
        path.basename(opened).startsWith('.cursor-sand-')) {
      injected = true;
      originalWrite.call(fs, mainPath, 'external concurrent update');
      fs.chmodSync(mainPath, 0o600);
    }
    return result;
  };
  try {
    assert.throws(
      () => applyFixture(fixture),
      (error) => error && error.code === 'CURRENT_HASH_MISMATCH'
    );
  } finally {
    fs.openSync = originalOpen;
    fs.writeFileSync = originalWrite;
  }
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(mainPath, 'utf8'), 'external concurrent update');
});

test('post-write external mutation is preserved and leaves recovery evidence', (t) => {
  const fixture = makeFixture(t);
  const productPath = path.join(fixture.appRoot, 'product.json');
  const mainPath = path.join(fixture.appRoot, 'out', 'main.js');
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = function patchedRename(from, to) {
    const result = originalRename.apply(this, arguments);
    if (
      !injected &&
      to === productPath &&
      path.basename(from).startsWith('.cursor-sand-')
    ) {
      injected = true;
      fs.writeFileSync(mainPath, 'post-write corruption');
      fs.chmodSync(mainPath, 0o600);
    }
    return result;
  };
  try {
    assert.throws(
      () => applyFixture(fixture),
      (error) => error && error.code === 'ROLLBACK_FAILED'
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(mainPath, 'utf8'), 'post-write corruption');
});

test('restore failure rolls back to the complete patched state', (t) => {
  const fixture = makeFixture(t);
  applyFixture(fixture);
  const patched = appSnapshot(fixture);
  const productPath = path.join(fixture.appRoot, 'product.json');
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = function patchedRename(from, to) {
    if (
      !injected &&
      to === productPath &&
      path.basename(from).startsWith('.cursor-sand-')
    ) {
      injected = true;
      const error = new Error('injected restore failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  try {
    assert.throws(
      () => restoreFixture(fixture),
      (error) => error && error.code === 'EIO'
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(injected, true);
  assertSnapshotEqual(appSnapshot(fixture), patched);
  assert.equal(sand.inspect(fixture.appRoot).state, 'patched');
});

test('a nonterminal journal is recovered before the next apply', (t) => {
  const fixture = makeFixture(t);
  const first = applyFixture(fixture);
  const transactionDir = path.join(
    fixture.stateRoot,
    'transactions',
    sand.deriveInstallId(fs.realpathSync(fixture.appRoot)),
    first.operationId
  );
  const journalPath = path.join(transactionDir, 'journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.status = 'writing';
  journal.activeId = 'product';
  journal.written = ['main', 'extension-host-worker'];
  journal.updatedAt = new Date().toISOString();
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  fs.chmodSync(journalPath, 0o600);

  const second = applyFixture(fixture);
  assert.deepEqual(second.recovered, [first.operationId]);
  assert.equal(second.after.state, 'patched');
  const recoveredJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(recoveredJournal.status, 'rolled-back');
});

test('pre-journal crash leftovers remove both transaction and orphan backup directories', (t) => {
  const fixture = makeFixture(t);
  const installId = sand.deriveInstallId(fs.realpathSync(fixture.appRoot));
  const orphanId = nextId('apply');
  const transactionDir = path.join(
    fixture.stateRoot,
    'transactions',
    installId,
    orphanId
  );
  const backupDir = path.join(
    fixture.stateRoot,
    'backups',
    installId,
    orphanId
  );
  fs.mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  for (const directory of [
    fixture.stateRoot,
    path.join(fixture.stateRoot, 'transactions'),
    path.join(fixture.stateRoot, 'transactions', installId),
    transactionDir,
    path.join(fixture.stateRoot, 'backups'),
    path.join(fixture.stateRoot, 'backups', installId),
    backupDir
  ]) {
    fs.chmodSync(directory, 0o700);
  }
  writeFile(path.join(transactionDir, 'partial.bin'), Buffer.from('partial'));
  writeFile(path.join(backupDir, 'partial.bin'), Buffer.from('partial'));

  const applied = applyFixture(fixture);
  assert.equal(applied.after.state, 'patched');
  assert.equal(fs.existsSync(transactionDir), false);
  assert.equal(fs.existsSync(backupDir), false);
});

test('next operation removes verified rolled-back transaction and backup artifacts', (t) => {
  const fixture = makeFixture(t);
  const productPath = path.join(fixture.appRoot, 'product.json');
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = function patchedRename(from, to) {
    if (!injected &&
        to === productPath &&
        path.basename(from).startsWith('.cursor-sand-')) {
      injected = true;
      const error = new Error('injected write failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  try {
    assert.throws(() => applyFixture(fixture), error => error && error.code === 'EIO');
  } finally {
    fs.renameSync = originalRename;
  }
  const installId = sand.deriveInstallId(fs.realpathSync(fixture.appRoot));
  const transactionBase = path.join(fixture.stateRoot, 'transactions', installId);
  const backupBase = path.join(fixture.stateRoot, 'backups', installId);
  const rolledBackIds = fs.readdirSync(transactionBase);
  assert.equal(rolledBackIds.length, 1);
  assert.equal(fs.existsSync(path.join(backupBase, rolledBackIds[0])), true);

  applyFixture(fixture);
  assert.equal(fs.existsSync(path.join(transactionBase, rolledBackIds[0])), false);
  assert.equal(fs.existsSync(path.join(backupBase, rolledBackIds[0])), false);
});

test('a live PID without a verifiable start token is never stolen by age', (t) => {
  const fixture = makeFixture(t, { twoFiles: false });
  const installId = sand.deriveInstallId(fs.realpathSync(fixture.appRoot));
  const lockDir = path.join(fixture.stateRoot, 'locks', `${installId}.lock`);
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(fixture.stateRoot, 0o700);
  fs.chmodSync(path.join(fixture.stateRoot, 'locks'), 0o700);
  fs.chmodSync(lockDir, 0o700);
  writeFile(
    path.join(lockDir, 'owner.json'),
    Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      processStart: null,
      hostname: os.hostname(),
      nonce: 'nonce-live-lock-000000000001',
      installId,
      appRoot: fs.realpathSync(fixture.appRoot),
      createdAt: '2000-01-01T00:00:00.000Z'
    }, null, 2)}\n`)
  );

  assert.throws(
    () => applyFixture(fixture),
    error => error && error.code === 'LOCKED'
  );
  assert.equal(fs.existsSync(lockDir), true);
  assertSnapshotEqual(appSnapshot(fixture), Object.fromEntries(fixture.originals));
});

test('force is not part of the restore API', (t) => {
  const fixture = makeFixture(t, { twoFiles: false });
  assert.throws(
    () => sand.restoreLatest({
      appRoot: fixture.appRoot,
      stateRoot: fixture.stateRoot,
      force: true
    }),
    (error) => error && error.code === 'UNKNOWN_OPTION'
  );
});

test('manifest duplicate keys and oversized content are rejected', (t) => {
  const fixture = makeFixture(t, { twoFiles: false });
  const applied = applyFixture(fixture);
  const manifestPath = path.join(applied.backupDir, 'manifest.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8').trim();
  const duplicate = manifestText.replace(
    '"schemaVersion": 2,',
    '"schemaVersion": 2, "schemaVersion": 2,'
  );
  fs.writeFileSync(manifestPath, `${duplicate}\n`);
  assert.throws(
    () => restoreFixture(fixture),
    (error) => error && error.code === 'INVALID_JSON'
  );

  fs.writeFileSync(manifestPath, Buffer.alloc(300 * 1024, 0x20));
  assert.throws(
    () => restoreFixture(fixture),
    (error) => error && error.code === 'FILE_TOO_LARGE'
  );
});
