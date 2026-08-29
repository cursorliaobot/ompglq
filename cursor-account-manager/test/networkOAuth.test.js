'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CursorHttpError } = require('../src/cursorHttp');
const {
  buildDeepLoginUrl,
  createCursorOAuth,
  derivePkceChallenge
} = require('../src/cursorOAuth');
const { NetworkPolicy } = require('../src/networkPolicy');

test('同账号 refresh 使用 single-flight，并返回旋转 token 与 expires', async () => {
  let calls = 0;
  let release;
  const oauth = createCursorOAuth({
    http: options => {
      calls++;
      assert.equal(options.body.refresh_token, 'refresh-old');
      return new Promise(resolve => {
        release = resolve;
      });
    },
    clock: { now: () => 1_000_000, sleep: async () => {} }
  });

  const first = oauth.refresh({
    accountId: 'account-a',
    refreshToken: 'refresh-old'
  });
  const second = oauth.refresh({
    accountId: 'account-a',
    refreshToken: 'refresh-old'
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);

  release({
    status: 200,
    json: {
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      expires_in: 60
    },
    headers: {}
  });
  const [result, joinedResult] = await Promise.all([first, second]);
  assert.equal(result.ok, true);
  assert.deepEqual(joinedResult, result);
  assert.equal(result.refreshToken, 'refresh-new');
  assert.equal(result.rotated, true);
  assert.equal(result.expiresAt, 1_060_000);
  assert.equal(oauth.inFlightAccounts, 0);
});

test('single-flight 中一个调用方取消不会取消其他调用方', async () => {
  let calls = 0;
  let release;
  const oauth = createCursorOAuth({
    http: options => {
      calls++;
      return new Promise((resolve, reject) => {
        release = resolve;
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.code = 'ERR_ABORTED';
          error.category = 'cancelled';
          reject(error);
        }, { once: true });
      });
    },
    clock: { now: () => 1_000_000, sleep: async () => {} }
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = oauth.refresh({
    accountId: 'shared-account',
    refreshToken: 'refresh-old',
    signal: firstController.signal
  });
  const second = oauth.refresh({
    accountId: 'shared-account',
    refreshToken: 'refresh-old',
    signal: secondController.signal
  });
  await new Promise(resolve => setImmediate(resolve));
  firstController.abort();
  const cancelled = await first;
  assert.equal(cancelled.cancelled, true);
  assert.equal(calls, 1);

  release({
    status: 200,
    json: {
      access_token: 'access-new',
      refresh_token: 'refresh-new'
    },
    headers: {}
  });
  const completed = await second;
  assert.equal(completed.ok, true);
  assert.equal(completed.refreshToken, 'refresh-new');
});

test('同账号不同 refresh token 世代不会错误共用 single-flight', async () => {
  let calls = 0;
  const oauth = createCursorOAuth({
    http: async options => {
      calls++;
      if (options.body.refresh_token === 'refresh-old') {
        return {
          status: 400,
          json: { error: 'invalid_grant' },
          headers: {}
        };
      }
      return {
        status: 200,
        json: {
          access_token: 'access-current',
          refresh_token: 'refresh-current'
        },
        headers: {}
      };
    },
    clock: { now: () => 1_000_000, sleep: async () => {} }
  });

  const [oldResult, currentResult] = await Promise.all([
    oauth.refresh({
      accountId: 'same-account',
      refreshToken: 'refresh-old'
    }),
    oauth.refresh({
      accountId: 'same-account',
      refreshToken: 'refresh-current'
    })
  ]);
  assert.equal(calls, 2);
  assert.equal(oldResult.shouldLogout, true);
  assert.equal(currentResult.ok, true);
  assert.equal(currentResult.accessToken, 'access-current');
});

test('401/403/invalid_grant 均为不可重试的退出分类', async () => {
  for (const response of [
    { status: 401, json: {} },
    { status: 403, json: {} },
    { status: 400, json: { error: 'invalid_grant' } },
    { status: 200, json: { error: 'invalid_grant' } }
  ]) {
    let calls = 0;
    const oauth = createCursorOAuth({
      http: async () => {
        calls++;
        return { ...response, headers: {} };
      },
      clock: { now: () => 0, sleep: async () => {} }
    });
    const result = await oauth.refresh({
      accountId: 'account-' + response.status + '-' + calls,
      refreshToken: 'refresh-token'
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'auth');
    assert.equal(result.shouldLogout, true);
    assert.equal(result.retryable, false);
    assert.equal(calls, 1);
  }
});

test('429 与 5xx 使用有限指数退避和抖动后成功', async () => {
  const responses = [
    { status: 429, json: {}, headers: {} },
    { status: 503, json: {}, headers: {} },
    {
      status: 200,
      json: { access_token: 'access', expires_in: 30 },
      headers: {}
    }
  ];
  const sleeps = [];
  const oauth = createCursorOAuth({
    http: async () => responses.shift(),
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    random: () => 0.5,
    clock: {
      now: () => 5000,
      sleep: async ms => {
        sleeps.push(ms);
      }
    }
  });

  const result = await oauth.refresh({
    accountId: 'account-retry',
    refreshToken: 'refresh-token'
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test('timeout 分类可重试但严格受 maxAttempts 限制', async () => {
  let calls = 0;
  const oauth = createCursorOAuth({
    http: async () => {
      calls++;
      throw new CursorHttpError('ERR_TIMEOUT', 'timeout', {
        category: 'timeout',
        retryable: true
      });
    },
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
    random: () => 0,
    clock: { now: () => 0, sleep: async () => {} }
  });
  const result = await oauth.refresh({
    accountId: 'account-timeout',
    refreshToken: 'refresh-token'
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, 'timeout');
  assert.equal(result.retryable, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test('policy off 在读取 refresh token 前阻断 OAuth', async () => {
  const policy = new NetworkPolicy('off');
  let secretReads = 0;
  let calls = 0;
  const oauth = createCursorOAuth({
    policy,
    http: async () => {
      calls++;
      return { status: 200, json: {}, headers: {} };
    }
  });
  const result = await oauth.refresh({
    accountId: 'account-off',
    intent: 'automatic',
    getRefreshToken: async () => {
      secretReads++;
      return 'refresh-token';
    }
  });
  assert.equal(result.category, 'policy');
  assert.equal(secretReads, 0);
  assert.equal(calls, 0);
});

test('PKCE 登录 URL 使用 SHA-256 challenge 与官方 HTTPS origin', () => {
  const login = buildDeepLoginUrl();
  const url = new URL(login.loginUrl);
  assert.equal(url.origin, 'https://cursor.com');
  assert.equal(url.pathname, '/loginDeepControl');
  assert.equal(url.searchParams.get('mode'), 'login');
  assert.equal(url.searchParams.get('uuid'), login.uuid);
  assert.equal(
    url.searchParams.get('challenge'),
    derivePkceChallenge(login.verifier)
  );
  assert.match(login.verifier, /^[A-Za-z0-9_-]{43}$/);
});

test('deep-login poll 构造受限 URL 并解析 token 对', async () => {
  let requestedPath = '';
  const oauth = createCursorOAuth({
    http: async options => {
      requestedPath = options.path;
      return {
        status: 200,
        json: {
          accessToken: 'access',
          refreshToken: 'refresh',
          authId: 'auth-id'
        },
        headers: {}
      };
    }
  });
  const result = await oauth.pollDeepLogin({
    uuid: 'uuid_123',
    verifier: 'v'.repeat(43)
  });
  assert.equal(result.ok, true);
  assert.equal(result.authId, 'auth-id');
  assert.equal(
    requestedPath,
    '/auth/poll?uuid=uuid_123&verifier=' + 'v'.repeat(43)
  );
});
