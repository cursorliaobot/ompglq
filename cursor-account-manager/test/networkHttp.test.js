'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCursorHttpClient,
  validateRequestTarget
} = require('../src/cursorHttp');
const { NetworkPolicy } = require('../src/networkPolicy');

class FakeRequest extends EventEmitter {
  constructor(onEnd) {
    super();
    this.onEnd = onEnd;
    this.body = Buffer.alloc(0);
    this.destroyed = false;
  }

  setTimeout(_ms, callback) {
    this.timeoutCallback = callback;
  }

  write(chunk) {
    this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
  }

  end() {
    if (this.onEnd)
      queueMicrotask(() => this.onEnd(this));
  }

  destroy() {
    this.destroyed = true;
  }
}

function response(status, headers) {
  const stream = new EventEmitter();
  stream.statusCode = status;
  stream.headers = headers || {};
  stream.destroyed = false;
  stream.destroy = () => {
    stream.destroyed = true;
  };
  return stream;
}

function createTransport(handler) {
  const state = { calls: 0, requests: [] };
  state.requestImpl = (options, onResponse) => {
    state.calls++;
    const request = new FakeRequest(req => handler({
      options,
      onResponse,
      request: req
    }));
    state.requests.push(request);
    return request;
  };
  return state;
}

test('HTTP policy off 在读取 headers/body 前拒绝且零建连', async () => {
  const transport = createTransport(() => {});
  const policy = new NetworkPolicy('off');
  let headerReads = 0;
  const options = {
    host: 'cursor.com',
    method: 'GET',
    path: '/api/auth/me',
    intent: 'manual'
  };
  Object.defineProperty(options, 'headers', {
    enumerable: true,
    get() {
      headerReads++;
      return { Authorization: 'Bearer secret' };
    }
  });
  const client = createCursorHttpClient({
    requestImpl: transport.requestImpl,
    policy
  });
  await assert.rejects(
    client.request(options),
    error => error && error.code === 'ERR_NETWORK_OFF'
  );
  assert.equal(headerReads, 0);
  assert.equal(transport.calls, 0);
});

test('严格拒绝非官方 host、未知 path 与错误 method，且不建连', async () => {
  const transport = createTransport(() => {});
  const client = createCursorHttpClient({ requestImpl: transport.requestImpl });

  await assert.rejects(client.request({
    host: 'evil.example',
    method: 'GET',
    path: '/api/auth/me'
  }), error => error && error.code === 'ERR_HOST_NOT_ALLOWED');
  await assert.rejects(client.request({
    host: 'cursor.com',
    method: 'GET',
    path: '/api/not-allowed'
  }), error => error && error.code === 'ERR_PATH_NOT_ALLOWED');
  await assert.rejects(client.request({
    host: 'cursor.com',
    method: 'POST',
    path: '/api/auth/me'
  }), error => error && error.code === 'ERR_METHOD_NOT_ALLOWED');
  assert.equal(transport.calls, 0);
});

test('HTTPS 客户端解析 JSON 并管理 body/header 边界', async () => {
  const transport = createTransport(({ options, onResponse, request }) => {
    assert.equal(options.hostname, 'api2.cursor.sh');
    assert.equal(options.port, 443);
    assert.equal(options.headers['Content-Length'], String(request.body.length));
    const res = response(200, { 'content-type': 'application/json' });
    onResponse(res);
    res.emit('data', Buffer.from('{"ok":true}'));
    res.emit('end');
  });
  const client = createCursorHttpClient({ requestImpl: transport.requestImpl });
  const result = await client.request({
    host: 'api2.cursor.sh',
    method: 'POST',
    path: '/oauth/token',
    headers: { Accept: 'application/json' },
    body: { grant_type: 'refresh_token' }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true });
  assert.equal(transport.calls, 1);
});

test('超时只结算一次，迟到的 socket error 不改变结果', async () => {
  const transport = createTransport(() => {});
  const client = createCursorHttpClient({
    requestImpl: transport.requestImpl,
    timeoutMs: 15
  });

  await assert.rejects(client.request({
    host: 'cursor.com',
    method: 'GET',
    path: '/api/auth/me'
  }), error => error && error.code === 'ERR_TIMEOUT');
  assert.equal(transport.requests[0].destroyed, true);
  transport.requests[0].emit('error', Object.assign(new Error('late'), {
    code: 'ECONNRESET'
  }));
});

test('响应超限会中止请求', async () => {
  const transport = createTransport(({ onResponse }) => {
    const res = response(200);
    onResponse(res);
    res.emit('data', Buffer.from('12345'));
    res.emit('end');
  });
  const client = createCursorHttpClient({ requestImpl: transport.requestImpl });

  await assert.rejects(client.request({
    host: 'cursor.com',
    method: 'GET',
    path: '/api/auth/me',
    maxResponseBytes: 4
  }), error => error && error.code === 'ERR_RESPONSE_TOO_LARGE');
  assert.equal(transport.requests[0].destroyed, true);
});

test('携带凭据的请求明确拒绝重定向且不会发起第二次连接', async () => {
  let redirectedResponse;
  const transport = createTransport(({ onResponse }) => {
    redirectedResponse = response(302, {
      location: 'https://evil.example/collect'
    });
    onResponse(redirectedResponse);
  });
  const client = createCursorHttpClient({ requestImpl: transport.requestImpl });

  await assert.rejects(client.request({
    host: 'cursor.com',
    method: 'GET',
    path: '/api/auth/me',
    headers: { Authorization: 'Bearer secret-token' }
  }), error => error && error.code === 'ERR_REDIRECT_REJECTED');
  assert.equal(transport.calls, 1);
  assert.equal(redirectedResponse.destroyed, true);
});

test('AbortSignal 在建连前及进行中都可取消', async () => {
  const transport = createTransport(() => {});
  const client = createCursorHttpClient({ requestImpl: transport.requestImpl });

  const before = new AbortController();
  before.abort();
  await assert.rejects(client.request({
    host: 'cursor.com',
    method: 'GET',
    path: '/api/auth/me',
    signal: before.signal
  }), error => error && error.code === 'ERR_ABORTED');
  assert.equal(transport.calls, 0);

  const during = new AbortController();
  const pending = client.request({
    host: 'cursor.com',
    method: 'GET',
    path: '/api/auth/me',
    signal: during.signal
  });
  await Promise.resolve();
  during.abort();
  await assert.rejects(pending, error => error && error.code === 'ERR_ABORTED');
  assert.equal(transport.calls, 1);
  assert.equal(transport.requests[0].destroyed, true);
});

test('响应结束后的迟到错误不会造成二次结算', async () => {
  const transport = createTransport(({ onResponse, request }) => {
    const res = response(200);
    onResponse(res);
    res.emit('data', '{"value":1}');
    res.emit('end');
    queueMicrotask(() => request.emit('error', new Error('late error')));
  });
  const client = createCursorHttpClient({ requestImpl: transport.requestImpl });
  const result = await client.request({
    host: 'cursor.com',
    method: 'GET',
    path: '/api/auth/me'
  });
  assert.deepEqual(result.json, { value: 1 });
});

test('deep-login poll 查询参数必须精确受限', () => {
  assert.equal(validateRequestTarget({
    host: 'api2.cursor.sh',
    method: 'GET',
    path: '/auth/poll?uuid=test_1&verifier=' + 'a'.repeat(43)
  }).pathname, '/auth/poll');
  assert.throws(() => validateRequestTarget({
    host: 'api2.cursor.sh',
    method: 'GET',
    path: '/auth/poll?uuid=test&verifier=' + 'a'.repeat(43) + '&next=evil'
  }), error => error && error.code === 'ERR_PATH_NOT_ALLOWED');
});
