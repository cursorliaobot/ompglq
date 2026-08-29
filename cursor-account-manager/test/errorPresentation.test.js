'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  presentError,
  sanitizeErrorMessage
} = require('../src/errorPresentation');

test('错误展示会清除 Bearer、JWT、Cookie、查询参数和会话凭据', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.signaturepart';
  const message = [
    `Authorization: Bearer ${jwt}`,
    `cookie=WorkosCursorSessionToken=user_123::${jwt}`,
    `https://cursor.com/?access_token=${jwt}`,
    `refresh_token=${'r'.repeat(120)}`,
    '{"refreshToken":"short-json-secret"}',
    'WorkosCursorSessionToken=short-cookie-secret'
  ].join(' ');
  const sanitized = sanitizeErrorMessage(message);

  assert.equal(sanitized.includes(jwt), false);
  assert.equal(sanitized.includes('r'.repeat(120)), false);
  assert.equal(sanitized.includes('short-json-secret'), false);
  assert.equal(sanitized.includes('short-cookie-secret'), false);
  assert.match(sanitized, /REDACTED/);
});

test('结构化错误只暴露安全代码和恢复、离线、重试状态', () => {
  const source = new Error('request failed with token=super-secret-value');
  source.code = 'network_disabled';
  source.retryable = false;
  source.details = { recoveryRequired: true };
  const shown = presentError(source);

  assert.deepEqual(shown, {
    code: 'NETWORK_DISABLED',
    message: 'request failed with token=[REDACTED]',
    retryable: false,
    recoveryRequired: true,
    offline: true
  });
});

test('真实 NetworkPolicy 错误代码会标记为离线策略拒绝', () => {
  for (const code of ['ERR_NETWORK_OFF', 'ERR_AUTOMATIC_DISABLED', 'ERR_POLICY_CHANGED']) {
    assert.equal(presentError({ code, message: 'denied' }).offline, true, code);
  }
});

test('畸形错误代码和超长消息不会原样进入 UI', () => {
  const shown = presentError({
    code: '<script>',
    message: 'x'.repeat(2000)
  });
  assert.equal(shown.code, 'OPERATION_FAILED');
  assert.ok(shown.message.length <= 1200);
  assert.equal(shown.message, '[REDACTED_SECRET]');
});
