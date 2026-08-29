'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const DEBUG_HOST = '127.0.0.1';
const PROFILE_CONTAINER = '.cursor-account-manager-cdp';
const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
const MAX_WS_HANDSHAKE_BYTES = 16 * 1024;
const MAX_WS_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_WS_BUFFER_BYTES = MAX_WS_FRAME_BYTES + 14;
const MAX_COOKIE_BYTES = 16 * 1024;
const PROFILE_STALE_MS = 5 * 60 * 1000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const activeProfiles = new Map();
const knownProfileRoots = new Set();
const rootLocks = new Map();
let lifecycleGeneration = 0;

class CdpBrowserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CdpBrowserError';
    this.code = code;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processStartToken(pid) {
  if (process.platform !== 'linux')
    return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0)
      return null;
    return stat.slice(close + 2).trim().split(/\s+/)[19] || null;
  }
  catch {
    return null;
  }
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  }
  catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

function profileOwnerRecord(pid, nonce) {
  return {
    schemaVersion: 1,
    pid,
    processStart: processStartToken(pid),
    hostname: os.hostname(),
    nonce,
    createdAt: new Date().toISOString()
  };
}

async function writeProfileOwner(directory, record) {
  const target = path.join(directory, 'owner.json');
  const temporary = path.join(directory, `.owner-${crypto.randomBytes(12).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(record) + '\n', 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.promises.rename(temporary, target);
    }
    catch (error) {
      if (process.platform !== 'win32' ||
          !error ||
          !['EEXIST', 'EPERM'].includes(error.code)) {
        throw error;
      }
      await fs.promises.unlink(target).catch(unlinkError => {
        if (!unlinkError || unlinkError.code !== 'ENOENT')
          throw unlinkError;
      });
      await fs.promises.rename(temporary, target);
    }
  }
  finally {
    if (handle)
      await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

async function readProfileOwner(directory) {
  const ownerPath = path.join(directory, 'owner.json');
  let stat;
  try {
    stat = await fs.promises.lstat(ownerPath);
  }
  catch (error) {
    if (error && error.code === 'ENOENT')
      return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024)
    return null;
  try {
    const owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'));
    if (!owner ||
        owner.schemaVersion !== 1 ||
        !Number.isInteger(owner.pid) ||
        owner.pid <= 0 ||
        typeof owner.hostname !== 'string' ||
        typeof owner.nonce !== 'string') {
      return null;
    }
    return owner;
  }
  catch {
    return null;
  }
}

function profileOwnerIsLive(owner) {
  if (!owner)
    return false;
  if (owner.hostname !== os.hostname())
    return true;
  if (!pidIsAlive(owner.pid))
    return false;
  const currentStart = processStartToken(owner.pid);
  return !(owner.processStart && currentStart && owner.processStart !== currentStart);
}

function findBrowserPath() {
  const candidates = [];
  if (process.platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(localAppData, 'Microsoft\\Edge\\Application\\msedge.exe')
    );
  }
  else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  }
  else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge'
    );
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate))
        return candidate;
    }
    catch {
      // 继续检查下一个候选路径。
    }
  }
  return '';
}

function validateNavigationUrl(value) {
  if (typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 4096 ||
      /[\0-\x20\x7f\\]/.test(value)) {
    throw new CdpBrowserError('ERR_NAVIGATION_URL', '导航地址无效');
  }
  let url;
  try {
    url = new URL(value);
  }
  catch {
    throw new CdpBrowserError('ERR_NAVIGATION_URL', '导航地址无效');
  }
  if (url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'cursor.com' ||
      url.origin !== 'https://cursor.com' ||
      url.username ||
      url.password) {
    throw new CdpBrowserError(
      'ERR_NAVIGATION_URL',
      '仅允许导航到 https://cursor.com'
    );
  }
  return url.toString();
}

function validateCookieValue(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_COOKIE_BYTES &&
    !/[\0-\x20\x7f;,]/.test(value);
}

function buildSessionCookie(value) {
  if (!validateCookieValue(value))
    throw new CdpBrowserError('ERR_COOKIE_VALUE', 'Cursor 会话 cookie 格式无效');
  return Object.freeze({
    name: 'WorkosCursorSessionToken',
    value,
    url: 'https://cursor.com/',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax'
  });
}

function buildBrowserArgs(userDataDir) {
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir))
    throw new TypeError('userDataDir 必须是绝对路径');
  return Object.freeze([
    '--remote-debugging-port=0',
    '--remote-debugging-address=' + DEBUG_HOST,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--new-window',
    'about:blank'
  ]);
}

function profileRootFor(stateRoot) {
  const base = stateRoot == null || stateRoot === ''
    ? os.tmpdir()
    : path.resolve(String(stateRoot));
  return path.join(base, PROFILE_CONTAINER);
}

async function ensureSecureDirectory(directory) {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new CdpBrowserError('ERR_PROFILE_ROOT', '临时配置目录不安全');
  if (typeof process.getuid === 'function' &&
      Number.isInteger(stat.uid) &&
      stat.uid !== process.getuid()) {
    throw new CdpBrowserError('ERR_PROFILE_ROOT_OWNER', '临时配置目录不属于当前用户');
  }
  try {
    await fs.promises.chmod(directory, 0o700);
  }
  catch (error) {
    if (process.platform !== 'win32')
      throw error;
  }
}

async function removeDirectoryReliable(directory, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      let stat;
      try {
        stat = await fs.promises.lstat(directory);
      }
      catch (error) {
        if (error && error.code === 'ENOENT')
          return true;
        throw error;
      }
      if (stat.isSymbolicLink() || stat.isFile()) {
        await fs.promises.unlink(directory);
        return true;
      }
      if (!stat.isDirectory())
        return false;
      if (typeof process.getuid === 'function' &&
          Number.isInteger(stat.uid) &&
          stat.uid !== process.getuid())
        return false;
      await fs.promises.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 100
      });
      return true;
    }
    catch {
      if (attempt + 1 >= attempts)
        return false;
      await delay(Math.min(1600, 50 * (2 ** attempt)));
    }
  }
  return false;
}

function withRootLock(root, task) {
  const previous = rootLocks.get(root) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const marker = run.then(() => undefined, () => undefined);
  rootLocks.set(root, marker);
  marker.finally(() => {
    if (rootLocks.get(root) === marker)
      rootLocks.delete(root);
  });
  return run;
}

function trackedProfileName(name) {
  return /^(?:(?:profile|stale)-|\.creating-)[A-Za-z0-9_-]{1,128}$/.test(name);
}

async function cleanupStaleProfiles(root) {
  await ensureSecureDirectory(root);
  knownProfileRoots.add(root);
  let entries = [];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  }
  catch {
    return { root, removed: 0, remaining: 0 };
  }

  let removed = 0;
  let remaining = 0;
  for (const entry of entries) {
    if (!trackedProfileName(entry.name))
      continue;
    const directory = path.join(root, entry.name);
    if (activeProfiles.has(directory)) {
      remaining++;
      continue;
    }
    let stat;
    try {
      stat = await fs.promises.lstat(directory);
    }
    catch {
      remaining++;
      continue;
    }
    if (!stat.isSymbolicLink()) {
      const owner = stat.isDirectory() ? await readProfileOwner(directory) : null;
      if (profileOwnerIsLive(owner) ||
          (!owner && Date.now() - stat.mtimeMs < PROFILE_STALE_MS)) {
        remaining++;
        continue;
      }
    }
    if (await removeDirectoryReliable(directory))
      removed++;
    else
      remaining++;
  }
  return { root, removed, remaining };
}

function initializeCleanup(stateRoot) {
  const root = profileRootFor(stateRoot);
  return withRootLock(root, () => cleanupStaleProfiles(root));
}

async function prepareProfile(stateRoot) {
  const root = profileRootFor(stateRoot);
  return withRootLock(root, async () => {
    await cleanupStaleProfiles(root);
    const staging = await fs.promises.mkdtemp(path.join(root, '.creating-'));
    await fs.promises.chmod(staging, 0o700);
    const nonce = crypto.randomBytes(18).toString('hex');
    await writeProfileOwner(staging, profileOwnerRecord(process.pid, nonce));
    const directory = path.join(root, `profile-${crypto.randomBytes(18).toString('hex')}`);
    await fs.promises.rename(staging, directory);
    let resolveClosed;
    const closed = new Promise(resolve => {
      resolveClosed = resolve;
    });
    const entry = {
      directory,
      root,
      nonce,
      process: null,
      cdp: null,
      cleanupPromise: null,
      closed,
      resolveClosed
    };
    activeProfiles.set(directory, entry);
    return entry;
  });
}

function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null)
    return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const done = () => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', done);
      resolve();
    };
    child.once('exit', done);
    timer = setTimeout(done, timeoutMs);
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid))
    return;
  try {
    child.kill();
  }
  catch {
    // 进程可能已经退出。
  }
  await waitForProcessExit(child, 1500);
  if (child.exitCode === null) {
    try {
      child.kill('SIGKILL');
    }
    catch {
      // Windows 或已退出进程可能不接受 SIGKILL。
    }
    await waitForProcessExit(child, 500);
  }
}

function cleanupProfile(entry, stopBrowser) {
  if (entry.cleanupPromise)
    return entry.cleanupPromise;
  entry.cleanupPromise = (async () => {
    let removed = false;
    try {
      if (entry.cdp) {
        try {
          entry.cdp.close();
        }
        catch {
          // best effort
        }
        entry.cdp = null;
      }
      if (stopBrowser)
        await stopProcess(entry.process);
      removed = await removeDirectoryReliable(entry.directory);
      return removed;
    }
    finally {
      activeProfiles.delete(entry.directory);
      entry.resolveClosed(removed);
    }
  })();
  return entry.cleanupPromise;
}

async function disposeAll() {
  lifecycleGeneration++;
  const entries = Array.from(activeProfiles.values());
  const results = await Promise.all(entries.map(entry => cleanupProfile(entry, true)));
  for (const root of Array.from(knownProfileRoots)) {
    try {
      await initializeCleanup(path.dirname(root));
    }
    catch {
      // 残留目录会在下一次 initializeCleanup 时再次处理。
    }
  }
  return {
    disposed: entries.length,
    removed: results.filter(Boolean).length
  };
}

async function waitForDevToolsPort(
  userDataDir,
  timeoutMs,
  child,
  launchState,
  signal,
  isCancelled
) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((child && child.exitCode !== null) ||
        (launchState && launchState.error) ||
        (signal && signal.aborted) ||
        (isCancelled && isCancelled()))
      return 0;
    try {
      const stat = await fs.promises.stat(portFile);
      if (stat.size > 0 && stat.size <= 1024) {
        const text = await fs.promises.readFile(portFile, 'utf8');
        const firstLine = String(text).split(/\r?\n/, 1)[0].trim();
        if (/^\d{1,5}$/.test(firstLine)) {
          const port = Number(firstLine);
          if (port >= 1 && port <= 65535)
            return port;
        }
      }
    }
    catch {
      // Chrome 还未写完 DevToolsActivePort。
    }
    await delay(100);
  }
  return 0;
}

function httpGetJson(port, pathname, timeoutMs = 3000) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return Promise.reject(new CdpBrowserError('ERR_HTTP_TARGET', '本地调试端口无效'));
  if (pathname !== '/json')
    return Promise.reject(new CdpBrowserError('ERR_HTTP_TARGET', '本地调试路径无效'));

  return new Promise((resolve, reject) => {
    let request;
    let response;
    let timer;
    let settled = false;
    const settle = (error, value) => {
      if (settled)
        return false;
      settled = true;
      clearTimeout(timer);
      if (error)
        reject(error);
      else
        resolve(value);
      return true;
    };
    const destroy = () => {
      try {
        if (response)
          response.destroy();
      }
      catch {
        // best effort
      }
      try {
        if (request)
          request.destroy();
      }
      catch {
        // best effort
      }
    };

    timer = setTimeout(() => {
      if (settle(new CdpBrowserError('ERR_HTTP_TIMEOUT', '本地调试 HTTP 超时')))
        destroy();
    }, timeoutMs);

    try {
      request = http.request({
        hostname: DEBUG_HOST,
        port,
        path: pathname,
        method: 'GET',
        headers: { Accept: 'application/json' },
        maxHeaderSize: 16 * 1024,
        maxHeadersCount: 64
      }, res => {
        response = res;
        const status = res.statusCode || 0;
        if (status !== 200) {
          if (settle(new CdpBrowserError('ERR_HTTP_STATUS', '本地调试 HTTP 返回异常')))
            destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          if (settled)
            return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (size > MAX_HTTP_RESPONSE_BYTES) {
            if (settle(new CdpBrowserError('ERR_HTTP_TOO_LARGE', '本地调试 HTTP 响应过大')))
              destroy();
            return;
          }
          chunks.push(data);
        });
        res.on('aborted', () => {
          settle(new CdpBrowserError('ERR_HTTP_ABORTED', '本地调试 HTTP 响应中断'));
        });
        res.on('error', () => {
          settle(new CdpBrowserError('ERR_HTTP_NETWORK', '本地调试 HTTP 响应失败'));
        });
        res.on('end', () => {
          if (settled)
            return;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
            settle(null, parsed);
          }
          catch {
            settle(new CdpBrowserError('ERR_HTTP_JSON', '本地调试 HTTP JSON 无效'));
          }
        });
      });
      request.on('error', () => {
        settle(new CdpBrowserError('ERR_HTTP_NETWORK', '本地调试 HTTP 请求失败'));
      });
      request.end();
    }
    catch {
      if (settle(new CdpBrowserError('ERR_HTTP_NETWORK', '本地调试 HTTP 请求失败')))
        destroy();
    }
  });
}

function isLoopbackIp(hostname) {
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (host === '::1')
    return true;
  const parts = host.split('.');
  return parts.length === 4 &&
    parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(parts[0]) === 127;
}

function parseLoopbackWebSocketUrl(value) {
  if (typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 8192 ||
      /[\0-\x20\x7f\\]/.test(value)) {
    throw new CdpBrowserError('ERR_WS_URL', 'WebSocket 地址无效');
  }
  let url;
  try {
    url = new URL(value);
  }
  catch {
    throw new CdpBrowserError('ERR_WS_URL', 'WebSocket 地址无效');
  }
  if (url.protocol !== 'ws:' ||
      url.username ||
      url.password ||
      url.hash ||
      !isLoopbackIp(url.hostname) ||
      !url.port ||
      !url.pathname.startsWith('/devtools/')) {
    throw new CdpBrowserError('ERR_WS_NOT_LOOPBACK', '仅允许连接回环 WebSocket');
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new CdpBrowserError('ERR_WS_URL', 'WebSocket 端口无效');
  const requestPath = url.pathname + url.search;
  if (Buffer.byteLength(requestPath, 'utf8') > 4096 ||
      /[^\x21-\x7e]/.test(requestPath)) {
    throw new CdpBrowserError('ERR_WS_URL', 'WebSocket 路径无效');
  }
  const host = url.hostname.startsWith('[')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return Object.freeze({
    host,
    port,
    path: requestPath,
    href: url.toString()
  });
}

function computeWebSocketAccept(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256)
    throw new TypeError('WebSocket key 无效');
  return crypto.createHash('sha1').update(key + WS_GUID, 'ascii').digest('base64');
}

function parseHandshakeHeaders(headerText) {
  if (typeof headerText !== 'string' ||
      Buffer.byteLength(headerText, 'latin1') > MAX_WS_HANDSHAKE_BYTES ||
      /[\0]/.test(headerText)) {
    throw new CdpBrowserError('ERR_WS_HANDSHAKE', 'WebSocket 握手响应无效');
  }
  const lines = headerText.split('\r\n');
  if (!/^HTTP\/1\.1 101(?: |$)/.test(lines.shift() || ''))
    throw new CdpBrowserError('ERR_WS_HANDSHAKE', 'WebSocket 握手状态无效');
  const headers = new Map();
  for (const line of lines) {
    if (!line)
      continue;
    if (/^[ \t]/.test(line))
      throw new CdpBrowserError('ERR_WS_HANDSHAKE', 'WebSocket 握手响应无效');
    const index = line.indexOf(':');
    if (index <= 0)
      throw new CdpBrowserError('ERR_WS_HANDSHAKE', 'WebSocket 握手响应无效');
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name) ||
        /[\0-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw new CdpBrowserError('ERR_WS_HANDSHAKE', 'WebSocket 握手响应无效');
    }
    const values = headers.get(name) || [];
    values.push(value);
    headers.set(name, values);
  }
  return headers;
}

function validateWebSocketHandshake(headerText, key) {
  const headers = parseHandshakeHeaders(headerText);
  const upgrades = headers.get('upgrade') || [];
  const connections = headers.get('connection') || [];
  const accepts = headers.get('sec-websocket-accept') || [];
  if (upgrades.length !== 1 ||
      upgrades[0].toLowerCase() !== 'websocket' ||
      !connections.some(value =>
        value.split(',').some(token => token.trim().toLowerCase() === 'upgrade')) ||
      accepts.length !== 1) {
    throw new CdpBrowserError('ERR_WS_HANDSHAKE', 'WebSocket 握手响应无效');
  }
  const expected = Buffer.from(computeWebSocketAccept(key), 'ascii');
  const actual = Buffer.from(accepts[0], 'ascii');
  if (actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)) {
    throw new CdpBrowserError('ERR_WS_ACCEPT', 'WebSocket 握手校验失败');
  }
  return true;
}

function isValidWebSocketHandshake(headerText, key) {
  try {
    return validateWebSocketHandshake(headerText, key);
  }
  catch {
    return false;
  }
}

class WsCdp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.messageChunks = [];
    this.messageLength = 0;
    this.fragmented = false;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    socket.on('data', chunk => this.onData(chunk));
    socket.on('close', () => this.fail(
      new CdpBrowserError('ERR_WS_CLOSED', '浏览器连接已关闭')
    ));
    socket.on('error', () => this.fail(
      new CdpBrowserError('ERR_WS_NETWORK', '浏览器连接错误')
    ));
  }

  static connect(value, timeoutMs = 15000) {
    const target = typeof value === 'string'
      ? parseLoopbackWebSocketUrl(value)
      : value;
    if (!target ||
        !isLoopbackIp(String(target.host || '')) ||
        !Number.isInteger(target.port) ||
        target.port < 1 ||
        target.port > 65535 ||
        typeof target.path !== 'string' ||
        !target.path.startsWith('/devtools/') ||
        Buffer.byteLength(target.path, 'utf8') > 4096 ||
        /[^\x21-\x7e]/.test(target.path)) {
      return Promise.reject(new CdpBrowserError(
        'ERR_WS_NOT_LOOPBACK',
        '仅允许连接回环 WebSocket'
      ));
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      return Promise.reject(new TypeError('WebSocket 超时无效'));

    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect({ host: target.host, port: target.port });
      socket.setNoDelay(true);
      let settled = false;
      let handshakeBuffer = Buffer.alloc(0);
      let timer;

      const cleanupHandshake = () => {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
      };
      const finish = (error, instance, rest) => {
        if (settled)
          return;
        settled = true;
        cleanupHandshake();
        if (error) {
          try {
            socket.destroy();
          }
          catch {
            // best effort
          }
          reject(error);
          return;
        }
        resolve(instance);
        if (rest && rest.length)
          instance.onData(rest);
      };
      const onError = () => finish(
        new CdpBrowserError('ERR_WS_NETWORK', 'WebSocket 连接失败')
      );
      const onData = chunk => {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const end = handshakeBuffer.indexOf('\r\n\r\n');
        if ((end < 0 && handshakeBuffer.length > MAX_WS_HANDSHAKE_BYTES) ||
            end > MAX_WS_HANDSHAKE_BYTES) {
          finish(new CdpBrowserError(
            'ERR_WS_HANDSHAKE_TOO_LARGE',
            'WebSocket 握手响应过大'
          ));
          return;
        }
        if (end < 0)
          return;
        const headerText = handshakeBuffer.subarray(0, end).toString('latin1');
        try {
          validateWebSocketHandshake(headerText, key);
        }
        catch (error) {
          finish(error);
          return;
        }
        const rest = handshakeBuffer.subarray(end + 4);
        const instance = new WsCdp(socket);
        finish(null, instance, rest);
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.once('connect', () => {
        const hostHeader = target.host.includes(':')
          ? '[' + target.host + ']'
          : target.host;
        const request = [
          'GET ' + target.path + ' HTTP/1.1',
          'Host: ' + hostHeader + ':' + target.port,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: ' + key,
          'Sec-WebSocket-Version: 13',
          '',
          ''
        ].join('\r\n');
        socket.write(request, 'ascii');
      });
      timer = setTimeout(() => finish(
        new CdpBrowserError('ERR_WS_TIMEOUT', 'WebSocket 握手超时')
      ), timeoutMs);
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (this.closed)
      return Promise.reject(new CdpBrowserError('ERR_WS_CLOSED', '连接已关闭'));
    if (typeof method !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(method)) {
      return Promise.reject(new TypeError('CDP 方法无效'));
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      return Promise.reject(new TypeError('CDP 超时无效'));

    const id = this.nextId++;
    let payload;
    try {
      payload = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    }
    catch {
      return Promise.reject(new TypeError('CDP 参数无法序列化'));
    }
    if (payload.length > MAX_WS_FRAME_BYTES) {
      return Promise.reject(new CdpBrowserError(
        'ERR_WS_FRAME_TOO_LARGE',
        'CDP 请求帧过大'
      ));
    }
    const frame = this.encodeFrame(payload, 0x1);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id))
          return;
        this.pending.delete(id);
        reject(new CdpBrowserError('ERR_CDP_TIMEOUT', 'CDP 命令超时'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.write(frame);
      }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpBrowserError('ERR_WS_NETWORK', 'CDP 请求发送失败'));
      }
    });
  }

  encodeFrame(payload, opcode) {
    if (!Buffer.isBuffer(payload) || payload.length > MAX_WS_FRAME_BYTES)
      throw new CdpBrowserError('ERR_WS_FRAME_TOO_LARGE', 'WebSocket 帧过大');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    }
    else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    const masked = Buffer.allocUnsafe(payload.length);
    for (let index = 0; index < payload.length; index++)
      masked[index] = payload[index] ^ mask[index & 3];
    return Buffer.concat([header, mask, masked]);
  }

  onData(chunk) {
    if (this.closed)
      return;
    try {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (incoming.length > MAX_WS_BUFFER_BYTES) {
        throw new CdpBrowserError(
          'ERR_WS_BUFFER_TOO_LARGE',
          'WebSocket 接收缓冲区过大'
        );
      }
      this.buffer = Buffer.concat([
        this.buffer,
        incoming
      ]);
      while (!this.closed) {
        const frame = this.tryParseFrame();
        if (!frame)
          break;
        this.handleFrame(frame);
      }
      if (!this.closed && this.buffer.length > MAX_WS_BUFFER_BYTES) {
        throw new CdpBrowserError(
          'ERR_WS_BUFFER_TOO_LARGE',
          'WebSocket 接收缓冲区过大'
        );
      }
    }
    catch (error) {
      this.fail(error instanceof Error
        ? error
        : new CdpBrowserError('ERR_WS_PROTOCOL', 'WebSocket 协议错误'));
    }
  }

  tryParseFrame() {
    const data = this.buffer;
    if (data.length < 2)
      return null;
    if ((data[0] & 0x70) !== 0)
      throw new CdpBrowserError('ERR_WS_PROTOCOL', 'WebSocket RSV 位无效');

    const fin = (data[0] & 0x80) !== 0;
    const opcode = data[0] & 0x0f;
    const masked = (data[1] & 0x80) !== 0;
    if (masked)
      throw new CdpBrowserError('ERR_WS_PROTOCOL', '服务端 WebSocket 帧不得掩码');
    if (![0x0, 0x1, 0x8, 0x9, 0xA].includes(opcode))
      throw new CdpBrowserError('ERR_WS_PROTOCOL', 'WebSocket opcode 无效');

    let length = data[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (data.length < 4)
        return null;
      length = data.readUInt16BE(2);
      offset = 4;
      if (length < 126)
        throw new CdpBrowserError('ERR_WS_PROTOCOL', 'WebSocket 长度编码非最短');
    }
    else if (length === 127) {
      if (data.length < 10)
        return null;
      const high = data.readUInt32BE(2);
      const low = data.readUInt32BE(6);
      if ((high & 0x80000000) !== 0)
        throw new CdpBrowserError('ERR_WS_PROTOCOL', 'WebSocket 长度无效');
      length = high * (2 ** 32) + low;
      offset = 10;
      if (!Number.isSafeInteger(length) || length < 65536)
        throw new CdpBrowserError('ERR_WS_PROTOCOL', 'WebSocket 长度编码无效');
    }

    const control = opcode >= 0x8;
    if (control && (!fin || length > 125))
      throw new CdpBrowserError('ERR_WS_PROTOCOL', 'WebSocket 控制帧无效');
    if (length > MAX_WS_FRAME_BYTES)
      throw new CdpBrowserError('ERR_WS_FRAME_TOO_LARGE', 'WebSocket 帧过大');
    if (data.length < offset + length)
      return null;

    const payload = data.subarray(offset, offset + length);
    this.buffer = data.subarray(offset + length);
    return { fin, opcode, payload };
  }

  appendMessage(payload) {
    this.messageLength += payload.length;
    if (this.messageLength > MAX_WS_MESSAGE_BYTES)
      throw new CdpBrowserError('ERR_WS_MESSAGE_TOO_LARGE', 'WebSocket 消息过大');
    this.messageChunks.push(payload);
  }

  completeMessage() {
    const text = Buffer.concat(this.messageChunks, this.messageLength).toString('utf8');
    this.messageChunks = [];
    this.messageLength = 0;
    this.fragmented = false;
    let message;
    try {
      message = JSON.parse(text);
    }
    catch {
      throw new CdpBrowserError('ERR_CDP_JSON', 'CDP 响应 JSON 无效');
    }
    this.handleMessage(message);
  }

  handleFrame(frame) {
    if (frame.opcode === 0x8) {
      this.fail(new CdpBrowserError('ERR_WS_CLOSED', '浏览器发送关闭帧'));
      return;
    }
    if (frame.opcode === 0x9) {
      this.socket.write(this.encodeFrame(frame.payload, 0xA));
      return;
    }
    if (frame.opcode === 0xA)
      return;

    if (frame.opcode === 0x1) {
      if (this.fragmented)
        throw new CdpBrowserError('ERR_WS_PROTOCOL', 'WebSocket 分片顺序无效');
      this.appendMessage(frame.payload);
      if (frame.fin)
        this.completeMessage();
      else
        this.fragmented = true;
      return;
    }

    if (!this.fragmented)
      throw new CdpBrowserError('ERR_WS_PROTOCOL', 'WebSocket 续帧无效');
    this.appendMessage(frame.payload);
    if (frame.fin)
      this.completeMessage();
  }

  handleMessage(message) {
    if (!message ||
        !Number.isInteger(message.id) ||
        !this.pending.has(message.id)) {
      return;
    }
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new CdpBrowserError(
        'ERR_CDP_COMMAND',
        'CDP 命令失败：' + pending.method
      ));
    }
    else {
      pending.resolve(message.result);
    }
  }

  fail(error) {
    if (this.closed)
      return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try {
      this.socket.destroy();
    }
    catch {
      // best effort
    }
  }

  close() {
    this.fail(new CdpBrowserError('ERR_WS_CLOSED', 'CDP 连接已关闭'));
  }
}

async function launchInjectedBrowser(options) {
  const opts = options || {};
  const noop = () => Promise.resolve();
  const launchGeneration = lifecycleGeneration;
  const signal = opts.signal;
  if (signal != null &&
      (typeof signal !== 'object' ||
       typeof signal.aborted !== 'boolean' ||
       typeof signal.addEventListener !== 'function')) {
    return { ok: false, error: '浏览器取消信号无效', close: noop };
  }
  if (signal && signal.aborted)
    return { ok: false, error: '浏览器启动已取消', cancelled: true, close: noop };
  let startUrl;
  try {
    startUrl = validateNavigationUrl(opts.startUrl || opts.loginUrl || '');
  }
  catch (error) {
    return { ok: false, error: error.message, close: noop };
  }
  if (!validateCookieValue(opts.cookieValue)) {
    return {
      ok: false,
      error: 'Cursor 会话 cookie 格式无效',
      close: noop
    };
  }

  const executable = opts.browserPath || findBrowserPath();
  if (!executable) {
    return {
      ok: false,
      error: '未找到 Chrome/Edge 浏览器，请安装后重试',
      close: noop
    };
  }

  let entry;
  try {
    entry = await prepareProfile(opts.stateRoot);
  }
  catch {
    return {
      ok: false,
      error: '创建安全临时目录失败',
      close: noop
    };
  }
  if ((signal && signal.aborted) || launchGeneration !== lifecycleGeneration) {
    await cleanupProfile(entry, true);
    return { ok: false, error: '浏览器启动已取消', cancelled: true, close: noop };
  }

  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
  const launchState = { error: null };
  let removeAbort = () => {};
  try {
    entry.process = spawnImpl(executable, buildBrowserArgs(entry.directory), {
      stdio: 'ignore',
      windowsHide: false
    });
    if (!entry.process || typeof entry.process.once !== 'function')
      throw new Error('invalid child process');
    entry.process.once('error', () => {
      launchState.error = true;
      cleanupProfile(entry, true).catch(() => {
        // 残留 profile 会由下次 initializeCleanup 再次处理。
      });
    });
    entry.process.once('exit', () => {
      removeAbort();
      cleanupProfile(entry, false).catch(() => {});
    });
    if (signal) {
      const onAbort = () => {
        launchState.error = true;
        cleanupProfile(entry, true).catch(() => {
          // 残留 profile 会由下次 initializeCleanup 再次处理。
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted)
        onAbort();
    }
    if (Number.isInteger(entry.process.pid) && entry.process.pid > 0) {
      await writeProfileOwner(
        entry.directory,
        profileOwnerRecord(entry.process.pid, entry.nonce)
      );
    }
    if ((signal && signal.aborted) || launchGeneration !== lifecycleGeneration) {
      launchState.error = true;
      await cleanupProfile(entry, true);
    }
  }
  catch {
    removeAbort();
    await cleanupProfile(entry, true);
    return {
      ok: false,
      error: '启动浏览器失败',
      close: noop
    };
  }

  const close = () => {
    removeAbort();
    return cleanupProfile(entry, true);
  };
  try {
    const port = await waitForDevToolsPort(
      entry.directory,
      integerTimeout(opts.launchTimeoutMs, 15000),
      entry.process,
      launchState,
      signal,
      () => launchGeneration !== lifecycleGeneration || !!entry.cleanupPromise
    );
    if (!port)
      throw new CdpBrowserError('ERR_DEVTOOLS_PORT', '浏览器调试端口未就绪');

    let target = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (launchState.error ||
          entry.process.exitCode !== null ||
          (signal && signal.aborted) ||
          launchGeneration !== lifecycleGeneration ||
          entry.cleanupPromise)
        break;
      try {
        const list = await httpGetJson(port, '/json', 3000);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (!item || item.type !== 'page' || typeof item.webSocketDebuggerUrl !== 'string')
              continue;
            try {
              const parsed = parseLoopbackWebSocketUrl(item.webSocketDebuggerUrl);
              if (parsed.port === port) {
                target = parsed;
                break;
              }
            }
            catch {
              // 忽略非回环或格式异常的 target。
            }
          }
        }
      }
      catch {
        // 浏览器 target 列表可能还未就绪。
      }
      if (target)
        break;
      await delay(150);
    }
    if (!target)
      throw new CdpBrowserError('ERR_DEVTOOLS_TARGET', '未找到安全的可调试页面');

    if ((signal && signal.aborted) || launchGeneration !== lifecycleGeneration)
      throw new CdpBrowserError('ERR_ABORTED', '浏览器操作已取消');
    const cdp = await WsCdp.connect(target, 15000);
    entry.cdp = cdp;
    await cdp.send('Network.enable', {});
    if ((signal && signal.aborted) || launchGeneration !== lifecycleGeneration)
      throw new CdpBrowserError('ERR_ABORTED', '浏览器操作已取消');
    const cookieResult = await cdp.send(
      'Network.setCookie',
      buildSessionCookie(opts.cookieValue)
    );
    if (!cookieResult || cookieResult.success !== true) {
      throw new CdpBrowserError(
        'ERR_COOKIE_REJECTED',
        '浏览器拒绝设置安全会话 cookie'
      );
    }
    if ((signal && signal.aborted) || launchGeneration !== lifecycleGeneration)
      throw new CdpBrowserError('ERR_ABORTED', '浏览器操作已取消');
    const navigationResult = await cdp.send('Page.navigate', { url: startUrl });
    if (navigationResult && navigationResult.errorText) {
      throw new CdpBrowserError('ERR_NAVIGATION', '浏览器导航失败');
    }

    if (opts.keepOpen) {
      cdp.close();
      entry.cdp = null;
    }
    return {
      ok: true,
      close,
      closed: entry.closed,
      profileDir: entry.directory
    };
  }
  catch (error) {
    await close();
    return {
      ok: false,
      error: 'CDP 注入失败：' +
        (error && error.message ? error.message : '未知错误'),
      close: noop
    };
  }
}

function integerTimeout(value, fallback) {
  if (value == null)
    return fallback;
  if (!Number.isInteger(value) || value < 100 || value > 60000)
    throw new TypeError('启动超时无效');
  return value;
}

module.exports = {
  CdpBrowserError,
  DEBUG_HOST,
  MAX_HTTP_RESPONSE_BYTES,
  MAX_WS_FRAME_BYTES,
  MAX_WS_HANDSHAKE_BYTES,
  MAX_WS_MESSAGE_BYTES,
  WsCdp,
  buildBrowserArgs,
  buildSessionCookie,
  computeWebSocketAccept,
  disposeAll,
  findBrowserPath,
  initializeCleanup,
  isLoopbackIp,
  isValidWebSocketHandshake,
  launchInjectedBrowser,
  parseLoopbackWebSocketUrl,
  validateNavigationUrl,
  validateWebSocketHandshake
};
