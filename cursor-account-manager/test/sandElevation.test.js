'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cli = require('../src/sandCli');
const elevation = require('../src/sandElevation');

const CLI_PATH = path.join(__dirname, '..', 'src', 'sandCli.js');
const OPERATION_ID = 'apply-elevation-test-0001';
const NONCE = 'nonce-elevation-test-000000000001';

function removePrepared(prepared) {
  fs.rmSync(prepared.tempDir, { recursive: true, force: true });
}

function successEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    ok: true,
    operation: 'apply',
    operationId: OPERATION_ID,
    nonce: NONCE,
    result: {
      changed: true,
      operationId: OPERATION_ID,
      nonce: NONCE
    },
    ...overrides
  };
}

test('CLI argument parsing is strict and has no force option', () => {
  assert.throws(
    () => cli.parseArgs(['restore', '--force']),
    (error) => error && error.code === 'INVALID_ARGUMENT'
  );
  assert.throws(
    () => cli.parseArgs(['apply', '--app-root']),
    (error) => error && error.code === 'INVALID_ARGUMENT'
  );
  assert.throws(
    () => cli.parseArgs(['apply', '--dry-run', '--dry-run']),
    (error) => error && error.code === 'INVALID_ARGUMENT'
  );
  assert.throws(
    () => cli.parseArgs(['restore', '--dry-run']),
    (error) => error && error.code === 'INVALID_ARGUMENT'
  );
  assert.throws(
    () => cli.parseArgs(['status', '--state-root', '/tmp/state']),
    (error) => error && error.code === 'INVALID_ARGUMENT'
  );

  const special = '/tmp/Cursor app;$(touch nope) "quoted"';
  const parsed = cli.parseArgs([
    'apply',
    '--app-root',
    special,
    '--operation-id',
    OPERATION_ID,
    '--nonce',
    NONCE,
    '--json'
  ]);
  assert.equal(parsed.appRoot, path.resolve(special));
  assert.equal(parsed.operationId, OPERATION_ID);
  assert.equal(parsed.nonce, NONCE);
});

test('CLI emits one structured JSON error document', () => {
  let output = '';
  const exitCode = cli.main(['not-a-command'], {
    write(data) {
      output += data.toString();
    }
  });
  assert.equal(exitCode, 1);
  const envelope = JSON.parse(output);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.operation, 'unknown');
  assert.equal(envelope.error.code, 'INVALID_ARGUMENT');
});

test('Linux elevation preserves special arguments as argv without a shell', () => {
  const specialRoot = '/tmp/Cursor app;$(touch injected) "quoted" \\ trailing';
  const prepared = elevation.prepareElevation({
    cliPath: CLI_PATH,
    args: ['apply', '--app-root', specialRoot, '--state-root', '/tmp/state with spaces'],
    operationId: OPERATION_ID,
    nonce: NONCE,
    platform: 'linux'
  });
  try {
    assert.equal(prepared.invocation.executable, '/usr/bin/pkexec');
    assert.equal(prepared.invocation.args[0], '/usr/bin/env');
    assert.equal(prepared.invocation.args[1], 'ELECTRON_RUN_AS_NODE=1');
    assert.equal(prepared.invocation.args[2], fs.realpathSync(process.execPath));
    assert.equal(prepared.invocation.args[3], fs.realpathSync(CLI_PATH));
    assert.equal(prepared.invocation.args[6], specialRoot);
    assert.equal(prepared.invocation.args.includes('bash'), false);
    assert.equal(prepared.invocation.args.includes('-c'), false);
  } finally {
    removePrepared(prepared);
  }
});

test('macOS and Windows launchers keep user text out of generated scripts', () => {
  const marker = '"; touch SHOULD_NOT_RUN; $("bad")';
  const darwin = elevation.prepareElevation({
    cliPath: CLI_PATH,
    args: ['apply', '--app-root', marker],
    operationId: OPERATION_ID,
    nonce: NONCE,
    platform: 'darwin'
  });
  try {
    assert.equal(darwin.invocation.executable, '/usr/bin/osascript');
    const script = fs.readFileSync(darwin.invocation.args[0], 'utf8');
    assert.equal(script.includes(marker), false);
    assert.equal(darwin.invocation.args.includes(marker), true);
    assert.match(script, /quoted form/);
  } finally {
    removePrepared(darwin);
  }

  const win32 = elevation.prepareElevation({
    cliPath: CLI_PATH,
    args: ['apply', '--app-root', marker],
    operationId: OPERATION_ID,
    nonce: NONCE,
    platform: 'win32'
  });
  try {
    assert.match(win32.invocation.executable, /powershell\.exe$/i);
    assert.equal(win32.invocation.args.some((arg) => /\.cmd$/i.test(arg)), false);
    const scriptPath = win32.invocation.args.at(-2);
    const payloadPath = win32.invocation.args.at(-1);
    const script = fs.readFileSync(scriptPath, 'utf8');
    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    assert.equal(script.includes(marker), false);
    assert.match(script, /ELECTRON_RUN_AS_NODE/);
    assert.equal(payload.arguments.includes(marker), true);
  } finally {
    removePrepared(win32);
  }
});

test('generated elevation helpers are reverified immediately before launch', () => {
  const prepared = elevation.prepareElevation({
    cliPath: CLI_PATH,
    args: ['apply', '--app-root', '/tmp/cursor-app'],
    operationId: OPERATION_ID,
    nonce: NONCE,
    platform: 'darwin',
    execFile() {
      throw new Error('must not launch');
    }
  });
  try {
    fs.appendFileSync(prepared.invocation.args[0], '\n-- tampered\n');
    assert.throws(
      () => elevation.invokePrepared(prepared),
      (error) => error && error.code === 'INTEGRITY_FAILED'
    );
  } finally {
    removePrepared(prepared);
  }
});

test('elevated result validation rejects empty, malformed, duplicate, and mismatched output', () => {
  const expected = {
    operation: 'apply',
    operationId: OPERATION_ID,
    nonce: NONCE
  };
  assert.throws(
    () => elevation.validateElevatedResult('', expected),
    (error) => error && error.code === 'EMPTY_ELEVATION_RESULT'
  );
  assert.throws(
    () => elevation.validateElevatedResult('{bad json', expected),
    (error) => error && error.code === 'MALFORMED_ELEVATION_RESULT'
  );
  assert.throws(
    () => elevation.validateElevatedResult('{"schemaVersion":1,"schemaVersion":1}', expected),
    (error) => error && error.code === 'MALFORMED_ELEVATION_RESULT'
  );
  assert.throws(
    () => elevation.validateElevatedResult(
      JSON.stringify(successEnvelope({ nonce: 'nonce-elevation-test-999999999999' })),
      expected
    ),
    (error) => error && error.code === 'ELEVATION_IDENTITY_MISMATCH'
  );
  assert.throws(
    () => elevation.validateElevatedResult(
      JSON.stringify({ ...successEnvelope(), unexpected: true }),
      expected
    ),
    (error) => error && error.code === 'MALFORMED_ELEVATION_RESULT'
  );
  assert.deepEqual(
    elevation.validateElevatedResult(JSON.stringify(successEnvelope()), expected),
    successEnvelope().result
  );
});

test('runElevated requires a secure, identity-bound result file', async () => {
  let observedOptions;
  const fakeExecFile = (_executable, args, options, callback) => {
    observedOptions = options;
    const outputPath = args[args.indexOf('--result-file') + 1];
    fs.writeFileSync(outputPath, `${JSON.stringify(successEnvelope())}\n`, { mode: 0o600 });
    fs.chmodSync(outputPath, 0o600);
    callback(null);
  };
  const result = await elevation.runElevated({
    cliPath: CLI_PATH,
    args: ['apply', '--app-root', '/tmp/app with spaces'],
    operationId: OPERATION_ID,
    nonce: NONCE,
    platform: 'linux',
    execFile: fakeExecFile
  });
  assert.equal(result.changed, true);
  assert.equal(observedOptions.shell, false);

  await assert.rejects(
    elevation.runElevated({
      cliPath: CLI_PATH,
      args: ['apply', '--app-root', '/tmp/app'],
      operationId: OPERATION_ID,
      nonce: NONCE,
      platform: 'linux',
      execFile: (_executable, _args, _options, callback) => callback(null)
    }),
    (error) => error && error.code === 'EMPTY_ELEVATION_RESULT'
  );
});

test('residual elevation risk is explicit and does not claim complete safety', () => {
  assert.equal(elevation.residualRisk.level, 'best-effort');
  assert.match(elevation.residualRisk.statement, /not a complete security boundary/i);
  assert.ok(elevation.residualRisk.items.length >= 4);
});

test('secure result output rejects pre-existing files and non-0700 parents', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sand-cli-output-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.chmodSync(base, 0o755);
  const output = path.join(base, `result-${OPERATION_ID}.json`);
  assert.throws(
    () => cli.secureWriteResult(output, Buffer.from('{}\n'), OPERATION_ID),
    (error) => error && error.code === 'UNSAFE_RESULT_PATH'
  );
});
