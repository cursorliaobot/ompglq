'use strict';

const https = require('https');
const { OFFICIAL_HOSTS, normalizeOfficialHost } = require('./networkPolicy');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const HARD_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;

const ENDPOINT_METHODS = Object.freeze({
  'cursor.com': Object.freeze({
    '/api/usage-summary': Object.freeze(['GET']),
    '/api/auth/stripe': Object.freeze(['GET']),
    '/api/auth/me': Object.freeze(['GET']),
    '/api/auth/sessions': Object.freeze(['GET']),
    '/api/auth/sessions/revoke': Object.freeze(['POST']),
    '/api/dashboard/get-plan-info': Object.freeze(['POST']),
    '/api/dashboard/get-hard-limit': Object.freeze(['POST']),
    '/api/dashboard/get-current-period-usage': Object.freeze(['POST']),
    '/api/dashboard/get-sand-usage-status': Object.freeze(['POST']),
    '/api/dashboard/set-hard-limit': Object.freeze(['POST'])
  }),
  'api2.cursor.sh': Object.freeze({
    '/auth/usage-summary': Object.freeze(['GET']),
    '/auth/poll': Object.freeze(['GET']),
    '/oauth/token': Object.freeze(['POST'])
  })
});

class CursorHttpError extends Error {
  constructor(code, message, options) {
    super(message);
    this.name = 'CursorHttpError';
    this.code = code;
    this.category = options && options.category || 'request';
    this.retryable = !!(options && options.retryable);
    if (options && Number.isInteger(options.status))
      this.status = options.status;
    if (options && typeof options.networkCode === 'string')
      this.networkCode = options.networkCode;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      networkCode: this.networkCode
    };
  }
}

function requestError(code, message) {
  return new CursorHttpError(code, message, {
    category: 'validation',
    retryable: false
  });
}

function validateFiniteInteger(value, fallback, minimum, maximum, label) {
  const resolved = value == null ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum)
    throw requestError('ERR_INVALID_REQUEST', label + '超出允许范围');
  return resolved;
}

function validatePollQuery(url) {
  const keys = Array.from(url.searchParams.keys());
  if (keys.length !== 2 ||
      keys.filter(key => key === 'uuid').length !== 1 ||
      keys.filter(key => key === 'verifier').length !== 1) {
    throw requestError('ERR_PATH_NOT_ALLOWED', '请求查询参数不在允许范围内');
  }
  const uuid = url.searchParams.get('uuid') || '';
  const verifier = url.searchParams.get('verifier') || '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uuid) ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw requestError('ERR_PATH_NOT_ALLOWED', '请求查询参数格式无效');
  }
}

function validateRequestTarget(options) {
  if (!options || typeof options !== 'object')
    throw requestError('ERR_INVALID_REQUEST', '请求参数无效');

  const suppliedHost = options.host == null ? options.hostname : options.host;
  if (options.host != null && options.hostname != null &&
      String(options.host).toLowerCase() !== String(options.hostname).toLowerCase()) {
    throw requestError('ERR_HOST_NOT_ALLOWED', '请求主机不一致');
  }
  const host = normalizeOfficialHost(suppliedHost);
  if (!host)
    throw requestError('ERR_HOST_NOT_ALLOWED', '请求主机不在官方允许列表中');

  if (typeof options.method !== 'string' || !/^[A-Z]+$/.test(options.method))
    throw requestError('ERR_METHOD_NOT_ALLOWED', '请求方法无效');
  const method = options.method;

  if (typeof options.path !== 'string' ||
      !options.path.startsWith('/') ||
      Buffer.byteLength(options.path, 'utf8') > MAX_PATH_BYTES ||
      options.path.includes('#') ||
      options.path.includes('\\') ||
      /[\0-\x20\x7f]/.test(options.path) ||
      /%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)/i.test(options.path)) {
    throw requestError('ERR_PATH_NOT_ALLOWED', '请求路径无效');
  }

  let url;
  try {
    url = new URL('https://' + host + options.path);
  }
  catch {
    throw requestError('ERR_PATH_NOT_ALLOWED', '请求路径无效');
  }
  const rawPathname = options.path.split('?')[0];
  if (url.origin !== 'https://' + host || url.pathname !== rawPathname)
    throw requestError('ERR_PATH_NOT_ALLOWED', '请求路径无效');

  const hostRules = ENDPOINT_METHODS[host];
  const methods = hostRules && hostRules[url.pathname];
  if (!methods)
    throw requestError('ERR_PATH_NOT_ALLOWED', '请求端点不在允许列表中');
  if (!methods.includes(method))
    throw requestError('ERR_METHOD_NOT_ALLOWED', '该端点不允许此请求方法');

  if (url.pathname === '/auth/poll')
    validatePollQuery(url);
  else if (url.search)
    throw requestError('ERR_PATH_NOT_ALLOWED', '该端点不允许查询参数');

  return Object.freeze({
    host,
    method,
    path: url.pathname + url.search,
    pathname: url.pathname
  });
}

function normalizeHeaders(input) {
  if (input == null)
    return {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw requestError('ERR_HEADERS_INVALID', '请求头必须是对象');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw requestError('ERR_HEADERS_INVALID', '请求头对象类型无效');

  const entries = Object.entries(input);
  if (entries.length > MAX_HEADER_COUNT)
    throw requestError('ERR_HEADERS_TOO_LARGE', '请求头数量超限');

  const headers = {};
  const names = new Set();
  let totalBytes = 0;
  for (const [name, originalValue] of entries) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))
      throw requestError('ERR_HEADERS_INVALID', '请求头名称无效');
    const lowerName = name.toLowerCase();
    if (names.has(lowerName))
      throw requestError('ERR_HEADERS_INVALID', '请求头名称重复');
    if (lowerName === 'host' ||
        lowerName === 'connection' ||
        lowerName === 'content-length' ||
        lowerName === 'transfer-encoding' ||
        lowerName === 'upgrade' ||
        lowerName === 'expect') {
      throw requestError('ERR_HEADERS_INVALID', '请求头由客户端管理');
    }
    if (typeof originalValue !== 'string' && typeof originalValue !== 'number')
      throw requestError('ERR_HEADERS_INVALID', '请求头值类型无效');
    const value = String(originalValue);
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (valueBytes > MAX_HEADER_VALUE_BYTES ||
        /[\0-\x1f\x7f]/.test(value)) {
      throw requestError('ERR_HEADERS_INVALID', '请求头值无效');
    }
    totalBytes += Buffer.byteLength(name, 'ascii') + valueBytes + 4;
    if (totalBytes > MAX_HEADER_BYTES)
      throw requestError('ERR_HEADERS_TOO_LARGE', '请求头大小超限');
    names.add(lowerName);
    headers[name] = value;
  }
  return headers;
}

function validateHeaderBoundaries(headers) {
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADER_COUNT)
    throw requestError('ERR_HEADERS_TOO_LARGE', '请求头数量超限');
  let totalBytes = 0;
  for (const [name, value] of entries) {
    const valueBytes = Buffer.byteLength(String(value), 'utf8');
    if (valueBytes > MAX_HEADER_VALUE_BYTES)
      throw requestError('ERR_HEADERS_TOO_LARGE', '请求头大小超限');
    totalBytes += Buffer.byteLength(name, 'ascii') + valueBytes + 4;
    if (totalBytes > MAX_HEADER_BYTES)
      throw requestError('ERR_HEADERS_TOO_LARGE', '请求头大小超限');
  }
}

function serializeBody(body, method, headers, maxRequestBytes) {
  if (body == null)
    return null;

  let data;
  let jsonBody = false;
  try {
    if (Buffer.isBuffer(body))
      data = Buffer.from(body);
    else if (body instanceof Uint8Array)
      data = Buffer.from(body);
    else if (typeof body === 'string')
      data = Buffer.from(body, 'utf8');
    else if (Array.isArray(body) ||
             (typeof body === 'object' &&
              (Object.getPrototypeOf(body) === Object.prototype ||
               Object.getPrototypeOf(body) === null))) {
      data = Buffer.from(JSON.stringify(body), 'utf8');
      jsonBody = true;
    }
    else
      throw new TypeError('unsupported body');
  }
  catch {
    throw requestError('ERR_BODY_INVALID', '请求体无法序列化');
  }

  if (method === 'GET' && data.length > 0)
    throw requestError('ERR_BODY_NOT_ALLOWED', 'GET 请求不允许请求体');
  if (data.length > maxRequestBytes)
    throw requestError('ERR_BODY_TOO_LARGE', '请求体大小超限');

  const lowerNames = new Set(Object.keys(headers).map(name => name.toLowerCase()));
  if (!lowerNames.has('content-type') && (jsonBody || typeof body === 'string'))
    headers['Content-Type'] = 'application/json; charset=utf-8';
  headers['Content-Length'] = String(data.length);
  return data;
}

function normalizeResponseHeaders(headers) {
  const output = {};
  for (const name of ['content-type', 'retry-after', 'request-id', 'x-request-id']) {
    const value = headers && headers[name];
    if (typeof value === 'string' && value.length <= 1024)
      output[name] = value;
  }
  return Object.freeze(output);
}

function abortHttpError() {
  return new CursorHttpError('ERR_ABORTED', '请求已取消', {
    category: 'cancelled',
    retryable: false
  });
}

function networkHttpError(error) {
  const networkCode = error && typeof error.code === 'string'
    ? error.code.slice(0, 64)
    : undefined;
  return new CursorHttpError('ERR_NETWORK', 'HTTPS 请求失败', {
    category: 'network',
    retryable: true,
    networkCode
  });
}

function createCursorHttpClient(clientOptions) {
  const settings = clientOptions || {};
  const requestImpl = settings.requestImpl || https.request.bind(https);
  const policy = settings.policy || null;
  if (typeof requestImpl !== 'function')
    throw new TypeError('requestImpl 必须是函数');
  if (policy && (typeof policy.beginRequest !== 'function' || typeof policy.run !== 'function'))
    throw new TypeError('policy 必须是 NetworkPolicy');

  const defaultTimeoutMs = validateFiniteInteger(
    settings.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
    '默认超时'
  );
  const defaultMaxResponseBytes = validateFiniteInteger(
    settings.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    1,
    HARD_MAX_RESPONSE_BYTES,
    '默认响应上限'
  );
  const defaultMaxRequestBytes = validateFiniteInteger(
    settings.maxRequestBytes,
    DEFAULT_MAX_REQUEST_BYTES,
    0,
    HARD_MAX_REQUEST_BYTES,
    '默认请求体上限'
  );

  function prepare(options, knownTarget) {
    const target = validateRequestTarget(options);
    if (knownTarget &&
        (target.host !== knownTarget.host ||
         target.method !== knownTarget.method ||
         target.path !== knownTarget.path)) {
      throw requestError('ERR_TARGET_CHANGED', '读取凭证后不得更改请求目标');
    }
    const timeoutMs = validateFiniteInteger(
      options.timeoutMs,
      defaultTimeoutMs,
      1,
      MAX_TIMEOUT_MS,
      '请求超时'
    );
    const maxResponseBytes = validateFiniteInteger(
      options.maxResponseBytes,
      defaultMaxResponseBytes,
      1,
      HARD_MAX_RESPONSE_BYTES,
      '响应上限'
    );
    const maxRequestBytes = validateFiniteInteger(
      options.maxRequestBytes,
      defaultMaxRequestBytes,
      0,
      HARD_MAX_REQUEST_BYTES,
      '请求体上限'
    );
    const headers = normalizeHeaders(options.headers);
    const body = serializeBody(options.body, target.method, headers, maxRequestBytes);
    validateHeaderBoundaries(headers);
    const signal = options.signal;
    if (signal != null &&
        (typeof signal !== 'object' ||
         typeof signal.addEventListener !== 'function' ||
         typeof signal.aborted !== 'boolean')) {
      throw requestError('ERR_INVALID_REQUEST', 'signal 必须是 AbortSignal');
    }
    return {
      target,
      timeoutMs,
      maxResponseBytes,
      headers,
      body,
      signal,
      expectJson: options.expectJson !== false
    };
  }

  function perform(prepared) {
    return new Promise((resolve, reject) => {
      const { target, timeoutMs, maxResponseBytes, headers, body, signal, expectJson } = prepared;
      if (signal && signal.aborted) {
        reject(abortHttpError());
        return;
      }

      let req;
      let response;
      let timer;
      let settled = false;
      let removeAbort = null;

      const settle = (error, value) => {
        if (settled)
          return false;
        settled = true;
        if (timer)
          clearTimeout(timer);
        if (removeAbort)
          removeAbort();
        if (error)
          reject(error);
        else
          resolve(value);
        return true;
      };

      const destroySafely = () => {
        try {
          if (response && typeof response.destroy === 'function')
            response.destroy();
        }
        catch {
          // best effort
        }
        try {
          if (req && typeof req.destroy === 'function')
            req.destroy();
        }
        catch {
          // best effort
        }
      };

      const onAbort = () => {
        if (settle(abortHttpError()))
          destroySafely();
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', onAbort);
      }

      timer = setTimeout(() => {
        const error = new CursorHttpError('ERR_TIMEOUT', 'HTTPS 请求超时', {
          category: 'timeout',
          retryable: true
        });
        if (settle(error))
          destroySafely();
      }, timeoutMs);

      const onResponse = res => {
        if (settled) {
          try {
            res.destroy();
          }
          catch {
            // best effort
          }
          return;
        }
        response = res;
        const status = Number.isInteger(res.statusCode) ? res.statusCode : 0;
        if (status >= 300 && status < 400) {
          const error = new CursorHttpError('ERR_REDIRECT_REJECTED', 'HTTPS 重定向已被安全拒绝', {
            category: 'policy',
            retryable: false,
            status
          });
          if (settle(error))
            destroySafely();
          return;
        }
        const contentLength = res.headers && res.headers['content-length'];
        if (typeof contentLength === 'string' &&
            (!/^\d+$/.test(contentLength) ||
             Number(contentLength) > maxResponseBytes)) {
          const error = new CursorHttpError('ERR_RESPONSE_TOO_LARGE', 'HTTPS 响应大小超限', {
            category: 'response',
            retryable: false,
            status
          });
          if (settle(error))
            destroySafely();
          return;
        }

        const chunks = [];
        let received = 0;
        res.on('data', chunk => {
          if (settled)
            return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += data.length;
          if (received > maxResponseBytes) {
            const error = new CursorHttpError('ERR_RESPONSE_TOO_LARGE', 'HTTPS 响应大小超限', {
              category: 'response',
              retryable: false,
              status
            });
            if (settle(error))
              destroySafely();
            return;
          }
          chunks.push(data);
        });
        res.on('aborted', () => {
          settle(new CursorHttpError('ERR_RESPONSE_ABORTED', 'HTTPS 响应被中断', {
            category: 'network',
            retryable: true,
            status
          }));
        });
        res.on('error', error => {
          const wrapped = networkHttpError(error);
          wrapped.status = status;
          settle(wrapped);
        });
        res.on('end', () => {
          if (settled)
            return;
          const raw = Buffer.concat(chunks, received).toString('utf8');
          let json = null;
          if (expectJson && raw.length > 0) {
            try {
              json = JSON.parse(raw);
            }
            catch {
              settle(new CursorHttpError('ERR_INVALID_JSON', 'HTTPS 响应不是有效 JSON', {
                category: 'response',
                retryable: status >= 500,
                status
              }));
              return;
            }
          }
          settle(null, Object.freeze({
            ok: status >= 200 && status < 300,
            status,
            headers: normalizeResponseHeaders(res.headers),
            body: raw,
            raw,
            json
          }));
        });
      };

      try {
        req = requestImpl({
          protocol: 'https:',
          hostname: target.host,
          servername: target.host,
          port: 443,
          path: target.path,
          method: target.method,
          headers,
          maxHeaderSize: MAX_HEADER_BYTES,
          maxHeadersCount: 64
        }, onResponse);
        if (!req || typeof req.on !== 'function' || typeof req.end !== 'function')
          throw new TypeError('invalid request object');
        req.on('error', error => settle(networkHttpError(error)));
        if (settled) {
          destroySafely();
          return;
        }
        if (typeof req.setTimeout === 'function') {
          req.setTimeout(timeoutMs, () => {
            const error = new CursorHttpError('ERR_TIMEOUT', 'HTTPS 请求超时', {
              category: 'timeout',
              retryable: true
            });
            if (settle(error))
              destroySafely();
          });
        }
        if (body && body.length)
          req.write(body);
        req.end();
      }
      catch (error) {
        if (settle(networkHttpError(error)))
          destroySafely();
      }
    });
  }

  async function request(options) {
    let handle = null;
    try {
      const target = validateRequestTarget(options);
      if (policy) {
        handle = policy.beginRequest({
          host: target.host,
          intent: options.intent,
          signal: options.signal
        });
      }
      const prepared = prepare({
        ...options,
        signal: handle ? handle.signal : options.signal
      }, target);
      return await perform(prepared);
    }
    finally {
      if (handle)
        handle.finish();
    }
  }

  function requestWithSecret(meta, readSecret, buildOptions) {
    if (typeof readSecret !== 'function')
      throw new TypeError('readSecret 必须是函数');
    if (typeof buildOptions !== 'function')
      throw new TypeError('buildOptions 必须是函数');
    const target = validateRequestTarget(meta);

    if (policy) {
      return policy.run({
        host: target.host,
        intent: meta.intent,
        signal: meta.signal
      }, readSecret, async (secret, context) => {
        const built = buildOptions(secret) || {};
        const prepared = prepare({
          ...built,
          host: target.host,
          method: target.method,
          path: target.path,
          signal: context.signal
        }, target);
        return perform(prepared);
      });
    }

    return Promise.resolve()
      .then(() => {
        if (meta.signal && meta.signal.aborted)
          throw abortHttpError();
        return readSecret({ signal: meta.signal });
      })
      .then(secret => {
        const built = buildOptions(secret) || {};
        return perform(prepare({
          ...built,
          host: target.host,
          method: target.method,
          path: target.path,
          signal: meta.signal
        }, target));
      });
  }

  return Object.freeze({
    request,
    requestJson: request,
    requestWithSecret,
    guardedRequest: requestWithSecret,
    validateRequestTarget
  });
}

const defaultClient = createCursorHttpClient();

function requestCursor(options) {
  return defaultClient.request(options);
}

module.exports = {
  CursorHttpError,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  ENDPOINT_METHODS,
  HARD_MAX_REQUEST_BYTES,
  HARD_MAX_RESPONSE_BYTES,
  MAX_HEADER_BYTES,
  OFFICIAL_HOSTS,
  createCursorHttpClient,
  requestCursor,
  requestJson: requestCursor,
  validateRequestTarget
};
