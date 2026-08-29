'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_WS_FRAME_BYTES,
  WsCdp,
  buildBrowserArgs,
  buildSessionCookie,
  computeWebSocketAccept,
  disposeAll,
  initializeCleanup,
  isValidWebSocketHandshake,
  launchInjectedBrowser,
  parseLoopbackWebSocketUrl,
  validateNavigationUrl,
  validateWebSocketHandshake
} = require('../src/cdpBrowser');

test('WebSocket Accept 按 RFC6455 纯函数计算并严格校验', () => {
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const accept = computeWebSocketAccept(key);
  assert.equal(accept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: keep-alive, Upgrade',
    'Sec-WebSocket-Accept: ' + accept
  ].join('\r\n');

  assert.equal(validateWebSocketHandshake(headers, key), true);
  assert.equal(isValidWebSocketHandshake(headers, key), true);
  assert.equal(
    isValidWebSocketHandshake(headers.replace(accept, 'invalid'), key),
    false
  );
  assert.throws(
    () => validateWebSocketHandshake(headers.replace(accept, 'invalid'), key),
    error => error && error.code === 'ERR_WS_ACCEPT'
  );
});

test('浏览器参数把调试服务固定到 127.0.0.1', () => {
  const args = buildBrowserArgs(path.resolve('/tmp/cdp-profile-test'));
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.equal(
    args.filter(value => value.startsWith('--remote-debugging-address=')).length,
    1
  );
});

test('导航只允许 cursor.com 的 HTTPS origin', () => {
  assert.equal(
    validateNavigationUrl('https://cursor.com/loginDeepControl?mode=login'),
    'https://cursor.com/loginDeepControl?mode=login'
  );
  for (const invalid of [
    'http://cursor.com/loginDeepControl',
    'https://cursor.com.evil.example/',
    'https://cursor.com@evil.example/',
    'https://api2.cursor.sh/',
    'javascript:alert(1)'
  ]) {
    assert.throws(
      () => validateNavigationUrl(invalid),
      error => error && error.code === 'ERR_NAVIGATION_URL'
    );
  }
});

test('仅解析 IP 字面量回环 WebSocket', () => {
  const parsed = parseLoopbackWebSocketUrl(
    'ws://127.0.0.1:9222/devtools/page/target-id'
  );
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, 9222);
  assert.equal(parsed.path, '/devtools/page/target-id');

  for (const invalid of [
    'ws://evil.example:9222/devtools/page/id',
    'ws://localhost:9222/devtools/page/id',
    'wss://127.0.0.1:9222/devtools/page/id',
    'ws://127.0.0.1:9222/not-devtools/id'
  ]) {
    assert.throws(() => parseLoopbackWebSocketUrl(invalid));
  }
});

test('会话 cookie 使用 host-only URL 与完整安全属性', () => {
  const cookie = buildSessionCookie('user%3A%3Atoken');
  assert.equal(cookie.url, 'https://cursor.com/');
  assert.equal(Object.hasOwn(cookie, 'domain'), false);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.throws(() => buildSessionCookie('token;Domain=evil.example'));
});

test('声明超限的服务端 WebSocket 帧会立即关闭连接', () => {
  class FakeSocket extends EventEmitter {
    write() {}
    destroy() {
      this.destroyed = true;
    }
  }
  const socket = new FakeSocket();
  const cdp = new WsCdp(socket);
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(MAX_WS_FRAME_BYTES + 1, 6);
  socket.emit('data', header);
  assert.equal(cdp.closed, true);
  assert.equal(socket.destroyed, true);
});

test('initializeCleanup 创建 0700 容器并清理上次残留 profile', async t => {
  const stateRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'cursor-cdp-test-')
  );
  t.after(async () => {
    await fs.promises.rm(stateRoot, { recursive: true, force: true });
  });

  const first = await initializeCleanup(stateRoot);
  const mode = (await fs.promises.stat(first.root)).mode & 0o777;
  if (process.platform !== 'win32')
    assert.equal(mode, 0o700);

  const stale = path.join(first.root, 'profile-stale123');
  await fs.promises.mkdir(stale, { mode: 0o700 });
  await fs.promises.writeFile(path.join(stale, 'marker'), 'stale');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fs.promises.utimes(stale, old, old);
  const second = await initializeCleanup(stateRoot);
  assert.equal(second.removed, 1);
  await assert.rejects(fs.promises.stat(stale), { code: 'ENOENT' });
});

test('清理残留 profile 只删除符号链接本身且不修改链接目标', async t => {
  const stateRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'cursor-cdp-link-test-')
  );
  const outside = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'cursor-cdp-outside-')
  );
  t.after(async () => {
    await fs.promises.rm(stateRoot, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  });
  await fs.promises.chmod(outside, 0o755);
  const initialized = await initializeCleanup(stateRoot);
  const link = path.join(initialized.root, 'stale-linked');
  try {
    await fs.promises.symlink(outside, link, 'dir');
  }
  catch (error) {
    if (process.platform === 'win32' && error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('当前 Windows 环境不允许创建测试符号链接');
      return;
    }
    throw error;
  }

  const cleaned = await initializeCleanup(stateRoot);
  assert.equal(cleaned.removed, 1);
  await assert.rejects(fs.promises.lstat(link), { code: 'ENOENT' });
  assert.equal((await fs.promises.stat(outside)).mode & 0o777, 0o755);
});

test('清理不会删除其他扩展宿主仍持有的活动 profile', async t => {
  const stateRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'cursor-cdp-live-test-')
  );
  t.after(async () => {
    await fs.promises.rm(stateRoot, { recursive: true, force: true });
  });
  const initialized = await initializeCleanup(stateRoot);
  const live = path.join(initialized.root, 'profile-other-host');
  await fs.promises.mkdir(live, { mode: 0o700 });
  await fs.promises.writeFile(
    path.join(live, 'owner.json'),
    JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      processStart: null,
      hostname: os.hostname(),
      nonce: 'other-host-owner',
      createdAt: new Date().toISOString()
    }),
    { mode: 0o600 }
  );

  const cleaned = await initializeCleanup(stateRoot);
  assert.equal(cleaned.removed, 0);
  assert.equal(cleaned.remaining, 1);
  assert.equal((await fs.promises.stat(live)).isDirectory(), true);
});

test('异步 spawn error 会失败并立即清理临时 profile', async t => {
  const stateRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'cursor-cdp-spawn-test-')
  );
  t.after(async () => {
    await fs.promises.rm(stateRoot, { recursive: true, force: true });
  });
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = undefined;
  child.kill = () => false;

  const resultPromise = launchInjectedBrowser({
    stateRoot,
    browserPath: '/fake/browser',
    startUrl: 'https://cursor.com/loginDeepControl?mode=login',
    cookieValue: 'user%3A%3Atoken',
    launchTimeoutMs: 100,
    spawnImpl() {
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    }
  });
  const result = await resultPromise;
  assert.equal(result.ok, false);

  const initialized = await initializeCleanup(stateRoot);
  const entries = await fs.promises.readdir(initialized.root);
  assert.equal(entries.some(name => name.startsWith('profile-')), false);
});

test('策略取消与浏览器启动交错时不会留下进程或 profile', async t => {
  const stateRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'cursor-cdp-abort-test-')
  );
  t.after(async () => {
    await fs.promises.rm(stateRoot, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = undefined;
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0);
    return true;
  };
  let spawned = 0;
  const result = await launchInjectedBrowser({
    stateRoot,
    browserPath: '/fake/browser',
    startUrl: 'https://cursor.com/loginDeepControl?mode=login',
    cookieValue: 'user%3A%3Atoken',
    launchTimeoutMs: 100,
    signal: controller.signal,
    spawnImpl() {
      spawned++;
      queueMicrotask(() => controller.abort());
      return child;
    }
  });
  assert.equal(spawned, 1);
  assert.equal(result.ok, false);

  const initialized = await initializeCleanup(stateRoot);
  const entries = await fs.promises.readdir(initialized.root);
  assert.equal(entries.some(name => name.startsWith('profile-')), false);
});

test('disposeAll 会取消尚未登记完成的浏览器启动', async t => {
  const stateRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'cursor-cdp-dispose-race-')
  );
  t.after(async () => {
    await fs.promises.rm(stateRoot, { recursive: true, force: true });
  });
  let spawned = 0;
  const launching = launchInjectedBrowser({
    stateRoot,
    browserPath: '/fake/browser',
    startUrl: 'https://cursor.com/dashboard/spending',
    cookieValue: 'user%3A%3Atoken',
    spawnImpl() {
      spawned++;
      throw new Error('must not spawn after disposal');
    }
  });
  await disposeAll();
  const result = await launching;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(spawned, 0);
});
