'use strict';

const crypto = require('crypto');
const { createCursorHttpClient, CursorHttpError } = require('./cursorHttp');

const DEFAULT_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 4000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_POLLS = 150;
const TOKEN_LIMIT_BYTES = 64 * 1024;

class CursorOAuthError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CursorOAuthError';
    this.code = code;
    this.category = details && details.category || 'oauth';
    this.retryable = !!(details && details.retryable);
    this.shouldLogout = !!(details && details.shouldLogout);
    if (details && Number.isInteger(details.status))
      this.status = details.status;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      shouldLogout: this.shouldLogout,
      status: this.status
    };
  }
}

function integerOption(value, fallback, minimum, maximum, name) {
  const resolved = value == null ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum)
    throw new TypeError(name + '超出允许范围');
  return resolved;
}

function normalizeRandom(random) {
  if (typeof random !== 'function')
    return Math.random;
  return () => {
    const value = Number(random());
    if (!Number.isFinite(value))
      return 0.5;
    return Math.min(1, Math.max(0, value));
  };
}

function abortFailure() {
  return {
    ok: false,
    error: 'cancelled',
    code: 'ERR_ABORTED',
    category: 'cancelled',
    retryable: false,
    cancelled: true,
    shouldLogout: false
  };
}

function signalIsValid(signal) {
  return signal == null ||
    (typeof signal === 'object' &&
     typeof signal.aborted === 'boolean' &&
     typeof signal.addEventListener === 'function');
}

function defaultSleep(ms, signal) {
  if (signal && signal.aborted)
    return Promise.reject(new CursorOAuthError('ERR_ABORTED', 'OAuth 操作已取消', {
      category: 'cancelled'
    }));
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CursorOAuthError('ERR_ABORTED', 'OAuth 操作已取消', {
        category: 'cancelled'
      }));
    };
    if (signal)
      signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      if (signal)
        signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

function normalizeClock(clock) {
  if (typeof clock === 'function') {
    return {
      now: clock,
      sleep: defaultSleep
    };
  }
  if (clock && typeof clock === 'object') {
    return {
      now: typeof clock.now === 'function' ? clock.now.bind(clock) : Date.now,
      sleep: typeof clock.sleep === 'function' ? clock.sleep.bind(clock) : defaultSleep
    };
  }
  return {
    now: Date.now,
    sleep: defaultSleep
  };
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function validateVerifier(verifier) {
  return typeof verifier === 'string' &&
    /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
}

function derivePkceChallenge(verifier, cryptoImpl) {
  if (!validateVerifier(verifier))
    throw new TypeError('PKCE verifier 格式无效');
  const implementation = cryptoImpl || crypto;
  return base64Url(implementation.createHash('sha256').update(verifier, 'ascii').digest());
}

function fallbackUuid(cryptoImpl) {
  const bytes = Buffer.from(cryptoImpl.randomBytes(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

function createPkce(options) {
  const settings = options || {};
  const cryptoImpl = settings.crypto || crypto;
  if (!cryptoImpl ||
      typeof cryptoImpl.randomBytes !== 'function' ||
      typeof cryptoImpl.createHash !== 'function') {
    throw new TypeError('crypto 实现无效');
  }
  const verifier = base64Url(cryptoImpl.randomBytes(32));
  if (!validateVerifier(verifier))
    throw new Error('无法生成安全的 PKCE verifier');
  const challenge = derivePkceChallenge(verifier, cryptoImpl);
  const uuid = typeof cryptoImpl.randomUUID === 'function'
    ? cryptoImpl.randomUUID()
    : fallbackUuid(cryptoImpl);
  if (typeof uuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uuid))
    throw new Error('无法生成安全的登录 UUID');
  return Object.freeze({ verifier, challenge, uuid });
}

function buildDeepLoginUrl(options) {
  const pkce = createPkce(options);
  const url = new URL('https://cursor.com/loginDeepControl');
  url.searchParams.set('challenge', pkce.challenge);
  url.searchParams.set('uuid', pkce.uuid);
  url.searchParams.set('mode', 'login');
  const loginUrl = url.toString();
  return Object.freeze({
    loginUrl,
    url: loginUrl,
    uuid: pkce.uuid,
    verifier: pkce.verifier,
    challenge: pkce.challenge
  });
}

function jsonOf(value) {
  return value && typeof value.json === 'object' && value.json !== null
    ? value.json
    : {};
}

function safeStatus(value) {
  if (value && Number.isInteger(value.status))
    return value.status;
  return 0;
}

function classifyOAuthFailure(value) {
  const status = safeStatus(value);
  const json = jsonOf(value);
  const oauthCode = typeof json.error === 'string'
    ? json.error.toLowerCase()
    : '';
  const code = value && typeof value.code === 'string' ? value.code : '';
  const category = value && typeof value.category === 'string' ? value.category : '';

  if (code === 'ERR_ABORTED' || category === 'cancelled')
    return abortFailure();

  if (oauthCode === 'invalid_grant' ||
      json.shouldLogout === true ||
      status === 401 ||
      status === 403) {
    return {
      ok: false,
      error: 'refresh_token_invalid',
      code: oauthCode === 'invalid_grant' ? 'invalid_grant' : 'ERR_AUTH_REJECTED',
      category: 'auth',
      retryable: false,
      shouldLogout: true,
      status
    };
  }

  if (status === 429) {
    return {
      ok: false,
      error: 'rate_limited',
      code: 'ERR_RATE_LIMITED',
      category: 'rate_limit',
      retryable: true,
      shouldLogout: false,
      status
    };
  }

  if (status >= 500 && status <= 599) {
    return {
      ok: false,
      error: 'server_error',
      code: 'ERR_SERVER',
      category: 'server',
      retryable: true,
      shouldLogout: false,
      status
    };
  }

  if (code === 'ERR_TIMEOUT' || category === 'timeout') {
    return {
      ok: false,
      error: 'timeout',
      code: 'ERR_TIMEOUT',
      category: 'timeout',
      retryable: true,
      shouldLogout: false,
      status
    };
  }

  if (code === 'ERR_NETWORK' ||
      code === 'ERR_RESPONSE_ABORTED' ||
      category === 'network') {
    return {
      ok: false,
      error: 'network_error',
      code: code || 'ERR_NETWORK',
      category: 'network',
      retryable: true,
      shouldLogout: false,
      status
    };
  }

  if (category === 'policy' || code.startsWith('ERR_POLICY') || code === 'ERR_NETWORK_OFF') {
    return {
      ok: false,
      error: 'network_policy',
      code: code || 'ERR_POLICY',
      category: 'policy',
      retryable: false,
      shouldLogout: false,
      status
    };
  }

  if (status >= 400 && status <= 499) {
    return {
      ok: false,
      error: 'oauth_client_error',
      code: oauthCode || 'ERR_OAUTH_CLIENT',
      category: 'client',
      retryable: false,
      shouldLogout: false,
      status
    };
  }

  if (value instanceof CursorHttpError) {
    return {
      ok: false,
      error: 'http_error',
      code: value.code,
      category: value.category || 'http',
      retryable: !!value.retryable,
      shouldLogout: false,
      status
    };
  }

  return {
    ok: false,
    error: 'oauth_error',
    code: code || 'ERR_OAUTH',
    category: category || 'oauth',
    retryable: false,
    shouldLogout: false,
    status
  };
}

function retryAfterMs(response, now) {
  const header = response && response.headers && response.headers['retry-after'];
  if (typeof header !== 'string')
    return 0;
  if (/^\d+$/.test(header))
    return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function computeRetryDelay(attempt, options) {
  const settings = options || {};
  const baseDelayMs = settings.baseDelayMs == null
    ? DEFAULT_BASE_DELAY_MS
    : settings.baseDelayMs;
  const maxDelayMs = settings.maxDelayMs == null
    ? DEFAULT_MAX_DELAY_MS
    : settings.maxDelayMs;
  const randomValue = Number.isFinite(settings.randomValue)
    ? Math.min(1, Math.max(0, settings.randomValue))
    : 0.5;
  const retryAfter = Number.isFinite(settings.retryAfterMs)
    ? Math.max(0, settings.retryAfterMs)
    : 0;
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt)));
  const jittered = Math.floor(exponential * (0.5 + randomValue));
  return Math.min(maxDelayMs, Math.max(jittered, retryAfter));
}

function validToken(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= TOKEN_LIMIT_BYTES &&
    !/[\0\r\n]/.test(value);
}

function parseJwtExpiry(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]))
    return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) && payload.exp > 0 ? Math.floor(payload.exp) : 0;
  }
  catch {
    return 0;
  }
}

function normalizeRefreshArguments(accountOrOptions, refreshToken, options) {
  if (accountOrOptions && typeof accountOrOptions === 'object' && !Array.isArray(accountOrOptions))
    return { ...accountOrOptions };
  const extra = options && typeof options === 'object' ? options : {};
  const result = {
    ...extra,
    accountId: accountOrOptions
  };
  if (typeof refreshToken === 'function')
    result.getRefreshToken = refreshToken;
  else
    result.refreshToken = refreshToken;
  return result;
}

function normalizePollArguments(uuidOrOptions, verifier, options) {
  if (uuidOrOptions && typeof uuidOrOptions === 'object' && !Array.isArray(uuidOrOptions))
    return { ...uuidOrOptions };
  return {
    ...(options && typeof options === 'object' ? options : {}),
    uuid: uuidOrOptions,
    verifier
  };
}

function refreshFlightKey(accountId, input, defaultClientId) {
  const clientId = String(input.clientId || defaultClientId).trim();
  const intent = String(input.intent || 'manual');
  if (validToken(input.refreshToken)) {
    const digest = crypto.createHash('sha256')
      .update(input.refreshToken, 'utf8')
      .digest('hex');
    return `${accountId}\0${clientId}\0${intent}\0${digest}`;
  }
  return `${accountId}\0${clientId}\0${intent}\0dynamic-${crypto.randomBytes(16).toString('hex')}`;
}

function resolveHttpRequest(http) {
  if (typeof http === 'function')
    return http;
  if (http && typeof http.request === 'function')
    return http.request.bind(http);
  if (http && typeof http.requestJson === 'function')
    return http.requestJson.bind(http);
  throw new TypeError('http 必须是请求函数或客户端');
}

class CursorOAuth {
  constructor(options) {
    const settings = options || {};
    this._http = resolveHttpRequest(settings.http || createCursorHttpClient());
    this._policy = settings.policy || null;
    if (this._policy &&
        (typeof this._policy.run !== 'function' ||
         typeof this._policy.beginRequest !== 'function')) {
      throw new TypeError('policy 必须是 NetworkPolicy');
    }
    this._clock = normalizeClock(settings.clock);
    this._random = normalizeRandom(settings.random);
    this._clientId = String(settings.clientId || DEFAULT_CLIENT_ID).trim();
    if (!/^[A-Za-z0-9._~-]{1,256}$/.test(this._clientId))
      throw new TypeError('OAuth clientId 格式无效');
    this._maxAttempts = integerOption(
      settings.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
      1,
      6,
      'maxAttempts'
    );
    this._baseDelayMs = integerOption(
      settings.baseDelayMs,
      DEFAULT_BASE_DELAY_MS,
      0,
      30000,
      'baseDelayMs'
    );
    this._maxDelayMs = integerOption(
      settings.maxDelayMs,
      DEFAULT_MAX_DELAY_MS,
      this._baseDelayMs,
      60000,
      'maxDelayMs'
    );
    this._crypto = settings.crypto || crypto;
    this._singleFlight = new Map();
  }

  buildDeepLoginUrl() {
    return buildDeepLoginUrl({ crypto: this._crypto });
  }

  get inFlightAccounts() {
    return this._singleFlight.size;
  }

  _joinRefreshFlight(flight, signal) {
    if (signal && signal.aborted)
      return Promise.resolve(abortFailure());
    flight.waiters++;
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled)
          return;
        settled = true;
        if (signal)
          signal.removeEventListener('abort', onAbort);
        flight.waiters--;
        if (flight.waiters === 0 && !flight.settled)
          flight.controller.abort();
        resolve(value);
      };
      const onAbort = () => finish(abortFailure());
      if (signal)
        signal.addEventListener('abort', onAbort, { once: true });
      flight.promise.then(finish);
    });
  }

  _sleep(ms, signal) {
    if (signal && signal.aborted)
      return Promise.reject(new CursorOAuthError('ERR_ABORTED', 'OAuth 操作已取消', {
        category: 'cancelled'
      }));
    return Promise.resolve(this._clock.sleep(ms, signal)).then(value => {
      if (signal && signal.aborted)
        throw new CursorOAuthError('ERR_ABORTED', 'OAuth 操作已取消', {
          category: 'cancelled'
        });
      return value;
    });
  }

  async _policyRequest(meta, readSecret, send) {
    if (this._policy)
      return this._policy.run(meta, readSecret, send);
    if (meta.signal && meta.signal.aborted)
      throw new CursorOAuthError('ERR_ABORTED', 'OAuth 操作已取消', {
        category: 'cancelled'
      });
    const secret = await readSecret({ signal: meta.signal });
    if (meta.signal && meta.signal.aborted)
      throw new CursorOAuthError('ERR_ABORTED', 'OAuth 操作已取消', {
        category: 'cancelled'
      });
    return send(secret, { signal: meta.signal, intent: meta.intent });
  }

  refresh(accountOrOptions, refreshToken, options) {
    return this.refreshAccount(accountOrOptions, refreshToken, options);
  }

  refreshToken(accountOrOptions, refreshToken, options) {
    return this.refreshAccount(accountOrOptions, refreshToken, options);
  }

  refreshAccount(accountOrOptions, refreshToken, options) {
    const input = normalizeRefreshArguments(accountOrOptions, refreshToken, options);
    const rawAccountId = input.accountId == null ? input.id : input.accountId;
    const accountId = String(rawAccountId == null ? '' : rawAccountId).trim();
    if (!accountId || accountId.length > 256 || /[\0-\x1f\x7f]/.test(accountId)) {
      return Promise.resolve({
        ok: false,
        error: 'invalid_account_id',
        code: 'ERR_INVALID_ACCOUNT',
        category: 'validation',
        retryable: false,
        shouldLogout: false
      });
    }
    if (!signalIsValid(input.signal)) {
      return Promise.resolve({
        ok: false,
        error: 'invalid_signal',
        code: 'ERR_INVALID_SIGNAL',
        category: 'validation',
        retryable: false,
        shouldLogout: false
      });
    }
    if (input.signal && input.signal.aborted)
      return Promise.resolve(abortFailure());
    const flightKey = refreshFlightKey(accountId, input, this._clientId);
    const existing = this._singleFlight.get(flightKey);
    if (existing)
      return this._joinRefreshFlight(existing, input.signal);

    const controller = new AbortController();
    const flight = {
      controller,
      promise: null,
      settled: false,
      waiters: 0
    };
    const promise = this._runRefresh({
      ...input,
      signal: controller.signal
    })
      .catch(error => classifyOAuthFailure(error))
      .finally(() => {
        flight.settled = true;
        if (this._singleFlight.get(flightKey) === flight)
          this._singleFlight.delete(flightKey);
      });
    flight.promise = promise;
    this._singleFlight.set(flightKey, flight);
    return this._joinRefreshFlight(flight, input.signal);
  }

  async _runRefresh(input) {
    const intent = input.intent || 'manual';
    if (intent !== 'manual' && intent !== 'automatic') {
      return {
        ok: false,
        error: 'invalid_intent',
        code: 'ERR_INVALID_INTENT',
        category: 'validation',
        retryable: false,
        shouldLogout: false
      };
    }
    const clientId = String(input.clientId || this._clientId).trim();
    if (!/^[A-Za-z0-9._~-]{1,256}$/.test(clientId)) {
      return {
        ok: false,
        error: 'invalid_client_id',
        code: 'ERR_INVALID_CLIENT',
        category: 'validation',
        retryable: false,
        shouldLogout: false
      };
    }
    if (typeof input.getRefreshToken !== 'function' && !validToken(input.refreshToken)) {
      return {
        ok: false,
        error: 'empty_refresh_token',
        code: 'ERR_EMPTY_REFRESH_TOKEN',
        category: 'validation',
        retryable: false,
        shouldLogout: false
      };
    }

    let cachedRefreshToken;
    const readRefreshToken = async context => {
      if (cachedRefreshToken)
        return cachedRefreshToken;
      const value = typeof input.getRefreshToken === 'function'
        ? await input.getRefreshToken(context)
        : input.refreshToken;
      if (!validToken(value))
        throw new CursorOAuthError('ERR_EMPTY_REFRESH_TOKEN', 'refresh token 无效', {
          category: 'validation'
        });
      cachedRefreshToken = value;
      return cachedRefreshToken;
    };

    for (let attempt = 0; attempt < this._maxAttempts; attempt++) {
      let response;
      try {
        response = await this._policyRequest({
          host: 'api2.cursor.sh',
          intent,
          signal: input.signal
        }, readRefreshToken, (token, context) => this._http({
          host: 'api2.cursor.sh',
          method: 'POST',
          path: '/oauth/token',
          intent,
          signal: context.signal,
          timeoutMs: input.timeoutMs,
          maxResponseBytes: input.maxResponseBytes,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Cursor-Account-Manager'
          },
          body: {
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: token
          }
        }));
      }
      catch (error) {
        const failure = classifyOAuthFailure(error);
        failure.attempts = attempt + 1;
        if (!failure.retryable || attempt + 1 >= this._maxAttempts)
          return failure;
        const delay = computeRetryDelay(attempt, {
          baseDelayMs: this._baseDelayMs,
          maxDelayMs: this._maxDelayMs,
          randomValue: this._random()
        });
        try {
          await this._sleep(delay, input.signal);
        }
        catch (sleepError) {
          return classifyOAuthFailure(sleepError);
        }
        continue;
      }

      const body = jsonOf(response);
      if (response && response.status >= 200 && response.status < 300) {
        if (body.shouldLogout === true ||
            (typeof body.error === 'string' &&
             body.error.toLowerCase() === 'invalid_grant')) {
          const invalid = classifyOAuthFailure({
            status: response.status,
            json: body
          });
          invalid.attempts = attempt + 1;
          return invalid;
        }
        const accessToken = body.access_token || body.accessToken;
        if (!validToken(accessToken)) {
          return {
            ok: false,
            error: 'missing_access_token',
            code: 'ERR_MISSING_ACCESS_TOKEN',
            category: 'protocol',
            retryable: false,
            shouldLogout: false,
            status: response.status,
            attempts: attempt + 1
          };
        }
        const rotated = body.refresh_token || body.refreshToken;
        const nextRefreshToken = validToken(rotated)
          ? rotated
          : cachedRefreshToken;
        const expiresIn = Number.isFinite(body.expires_in) &&
          body.expires_in > 0 &&
          body.expires_in <= 315360000
          ? Math.floor(body.expires_in)
          : (Number.isFinite(body.expiresIn) &&
             body.expiresIn > 0 &&
             body.expiresIn <= 315360000
            ? Math.floor(body.expiresIn)
            : 0);
        const jwtExpiry = parseJwtExpiry(accessToken);
        const now = Number(this._clock.now());
        const expiresAt = expiresIn > 0
          ? (Number.isFinite(now) ? Math.floor(now) : Date.now()) + expiresIn * 1000
          : (jwtExpiry <= Number.MAX_SAFE_INTEGER / 1000 ? jwtExpiry * 1000 : 0);
        return {
          ok: true,
          accessToken,
          refreshToken: nextRefreshToken,
          rotated: nextRefreshToken !== cachedRefreshToken,
          expiresIn,
          expiresAt,
          expiresAtSeconds: expiresAt > 0 ? Math.floor(expiresAt / 1000) : 0,
          attempts: attempt + 1,
          status: response.status
        };
      }

      const failure = classifyOAuthFailure(response);
      failure.attempts = attempt + 1;
      if (!failure.retryable || attempt + 1 >= this._maxAttempts)
        return failure;
      const delay = computeRetryDelay(attempt, {
        baseDelayMs: this._baseDelayMs,
        maxDelayMs: this._maxDelayMs,
        randomValue: this._random(),
        retryAfterMs: retryAfterMs(response, this._clock.now())
      });
      try {
        await this._sleep(delay, input.signal);
      }
      catch (sleepError) {
        return classifyOAuthFailure(sleepError);
      }
    }

    return {
      ok: false,
      error: 'oauth_error',
      code: 'ERR_OAUTH',
      category: 'oauth',
      retryable: false,
      shouldLogout: false
    };
  }

  async pollDeepLogin(uuidOrOptions, verifier, options) {
    const input = normalizePollArguments(uuidOrOptions, verifier, options);
    if (!signalIsValid(input.signal))
      return classifyOAuthFailure({ code: 'ERR_INVALID_SIGNAL', category: 'validation' });
    const uuid = String(input.uuid == null ? '' : input.uuid);
    const pollVerifier = String(input.verifier == null ? '' : input.verifier);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uuid) || !validateVerifier(pollVerifier)) {
      return {
        ok: false,
        error: 'invalid_poll_credentials',
        code: 'ERR_INVALID_POLL',
        category: 'validation',
        retryable: false,
        shouldLogout: false
      };
    }
    const intent = input.intent || 'manual';
    if (intent !== 'manual' && intent !== 'automatic') {
      return {
        ok: false,
        error: 'invalid_intent',
        code: 'ERR_INVALID_INTENT',
        category: 'validation',
        retryable: false,
        shouldLogout: false
      };
    }

    for (let attempt = 0; attempt < this._maxAttempts; attempt++) {
      let response;
      try {
        response = await this._policyRequest({
          host: 'api2.cursor.sh',
          intent,
          signal: input.signal
        }, () => pollVerifier, (secret, context) => {
          const path = '/auth/poll?uuid=' + encodeURIComponent(uuid) +
            '&verifier=' + encodeURIComponent(secret);
          return this._http({
            host: 'api2.cursor.sh',
            method: 'GET',
            path,
            intent,
            signal: context.signal,
            timeoutMs: input.timeoutMs,
            maxResponseBytes: input.maxResponseBytes,
            headers: {
              Accept: 'application/json',
              'User-Agent': 'Cursor-Account-Manager'
            }
          });
        });
      }
      catch (error) {
        const failure = classifyOAuthFailure(error);
        failure.attempts = attempt + 1;
        if (!failure.retryable || attempt + 1 >= this._maxAttempts)
          return failure;
        const delay = computeRetryDelay(attempt, {
          baseDelayMs: this._baseDelayMs,
          maxDelayMs: this._maxDelayMs,
          randomValue: this._random()
        });
        try {
          await this._sleep(delay, input.signal);
        }
        catch (sleepError) {
          return classifyOAuthFailure(sleepError);
        }
        continue;
      }

      const body = jsonOf(response);
      if (response && response.status >= 200 && response.status < 300) {
        const accessToken = body.accessToken || body.access_token;
        const nextRefreshToken = body.refreshToken || body.refresh_token;
        if (validToken(accessToken) && validToken(nextRefreshToken)) {
          return {
            ok: true,
            pending: false,
            accessToken,
            refreshToken: nextRefreshToken,
            authId: typeof body.authId === 'string' ? body.authId : '',
            attempts: attempt + 1,
            status: response.status
          };
        }
        return {
          ok: false,
          pending: true,
          error: 'pending',
          code: 'PENDING',
          category: 'pending',
          retryable: false,
          shouldLogout: false,
          attempts: attempt + 1,
          status: response.status
        };
      }

      if (response && (response.status === 404 || response.status === 408)) {
        return {
          ok: false,
          pending: true,
          error: 'pending',
          code: 'PENDING',
          category: 'pending',
          retryable: false,
          shouldLogout: false,
          attempts: attempt + 1,
          status: response.status
        };
      }

      const failure = classifyOAuthFailure(response);
      failure.attempts = attempt + 1;
      if (!failure.retryable || attempt + 1 >= this._maxAttempts)
        return failure;
      const delay = computeRetryDelay(attempt, {
        baseDelayMs: this._baseDelayMs,
        maxDelayMs: this._maxDelayMs,
        randomValue: this._random(),
        retryAfterMs: retryAfterMs(response, this._clock.now())
      });
      try {
        await this._sleep(delay, input.signal);
      }
      catch (sleepError) {
        return classifyOAuthFailure(sleepError);
      }
    }
    return classifyOAuthFailure({});
  }

  poll(uuidOrOptions, verifier, options) {
    return this.pollDeepLogin(uuidOrOptions, verifier, options);
  }

  async waitForDeepLogin(input) {
    const options = input && typeof input === 'object' ? input : {};
    const maxPolls = integerOption(
      options.maxPolls,
      DEFAULT_MAX_POLLS,
      1,
      DEFAULT_MAX_POLLS,
      'maxPolls'
    );
    const intervalMs = integerOption(
      options.intervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      0,
      30000,
      'intervalMs'
    );
    for (let poll = 0; poll < maxPolls; poll++) {
      const result = await this.pollDeepLogin(options);
      if (result.ok || result.cancelled)
        return result;
      if (!result.pending && !result.retryable)
        return result;
      if (poll + 1 < maxPolls) {
        try {
          await this._sleep(intervalMs, options.signal);
        }
        catch (error) {
          return classifyOAuthFailure(error);
        }
      }
    }
    return {
      ok: false,
      error: 'poll_timeout',
      code: 'ERR_POLL_TIMEOUT',
      category: 'timeout',
      retryable: false,
      shouldLogout: false
    };
  }
}

function createCursorOAuth(options) {
  return new CursorOAuth(options);
}

const defaultOAuth = createCursorOAuth();

function refreshCursorAccessToken(accountOrOptions, refreshToken, options) {
  return defaultOAuth.refreshAccount(accountOrOptions, refreshToken, options);
}

function pollCursorDeepLogin(uuidOrOptions, verifier, options) {
  return defaultOAuth.pollDeepLogin(uuidOrOptions, verifier, options);
}

module.exports = {
  CursorOAuth,
  CursorOAuthError,
  DEFAULT_CLIENT_ID,
  DEFAULT_MAX_ATTEMPTS,
  buildDeepLoginUrl,
  classifyOAuthFailure,
  computeRetryDelay,
  createCursorOAuth,
  createPkce,
  derivePkceChallenge,
  pollCursorDeepLogin,
  refreshCursorAccessToken
};
