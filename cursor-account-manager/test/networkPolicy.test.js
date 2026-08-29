'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODES,
  NetworkPolicy,
  evaluatePolicy,
  isOfficialHost
} = require('../src/networkPolicy');

test('off 模式在读取 secret 与发请求前拒绝', async () => {
  const policy = new NetworkPolicy({ mode: MODES.OFF });
  let secretReads = 0;
  let requests = 0;

  await assert.rejects(
    policy.run(
      { host: 'cursor.com', intent: 'manual' },
      async () => {
        secretReads++;
        return 'secret';
      },
      async () => {
        requests++;
      }
    ),
    error => error && error.code === 'ERR_NETWORK_OFF'
  );
  assert.equal(secretReads, 0);
  assert.equal(requests, 0);
});

test('manual 与 automatic 意图按模式隔离', () => {
  assert.equal(evaluatePolicy('manual', {
    host: 'cursor.com',
    intent: 'manual'
  }).allowed, true);
  assert.equal(evaluatePolicy('manual', {
    host: 'cursor.com',
    intent: 'automatic'
  }).code, 'ERR_AUTOMATIC_DISABLED');
  assert.equal(evaluatePolicy('automatic', {
    host: 'cursor.com',
    intent: 'manual'
  }).allowed, true);
  assert.equal(evaluatePolicy('automatic', {
    host: 'api2.cursor.sh',
    intent: 'automatic'
  }).allowed, true);
});

test('仅允许 Cursor 官方主机且匹配不受大小写影响', () => {
  assert.equal(isOfficialHost('cursor.com'), true);
  assert.equal(isOfficialHost('API2.CURSOR.SH'), true);
  assert.equal(isOfficialHost('cursor.com.evil.example'), false);
  assert.equal(isOfficialHost('cursor.com:443'), false);

  const policy = new NetworkPolicy('automatic');
  assert.throws(
    () => policy.beginRequest({ host: 'evil.example', intent: 'manual' }),
    error => error && error.code === 'ERR_HOST_NOT_ALLOWED'
  );
});

test('模式降级会取消不再允许的进行中请求', () => {
  const policy = new NetworkPolicy('automatic');
  const manual = policy.beginRequest({
    host: 'cursor.com',
    intent: 'manual'
  });
  const background = policy.beginRequest({
    host: 'api2.cursor.sh',
    intent: 'automatic'
  });

  policy.setMode('manual');
  assert.equal(manual.signal.aborted, false);
  assert.equal(background.signal.aborted, true);
  assert.equal(background.signal.reason.code, 'ERR_POLICY_CHANGED');

  policy.setMode('off');
  assert.equal(manual.signal.aborted, true);
  assert.equal(policy.getStatus().inFlight, 2);
  manual.finish();
  background.finish();
  assert.equal(policy.getStatus().inFlight, 0);
});

test('cancelAll 可取消请求且 finish 幂等', () => {
  const policy = new NetworkPolicy('automatic');
  const handle = policy.beginRequest({
    host: 'cursor.com',
    intent: 'manual'
  });
  assert.equal(policy.cancelAll(), 1);
  assert.equal(handle.signal.aborted, true);
  assert.equal(handle.finish(), true);
  assert.equal(handle.finish(), false);
});
