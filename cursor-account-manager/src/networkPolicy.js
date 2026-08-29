'use strict';

const MODES = Object.freeze({
  OFF: 'off',
  MANUAL: 'manual',
  AUTOMATIC: 'automatic'
});

const INTENTS = Object.freeze({
  MANUAL: 'manual',
  AUTOMATIC: 'automatic'
});

const OFFICIAL_HOSTS = Object.freeze(['cursor.com', 'api2.cursor.sh']);
const OFFICIAL_HOST_SET = new Set(OFFICIAL_HOSTS);

class NetworkPolicyError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'NetworkPolicyError';
    this.code = code;
    this.category = 'policy';
    this.retryable = false;
    if (details && details.mode)
      this.mode = details.mode;
    if (details && details.intent)
      this.intent = details.intent;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      mode: this.mode,
      intent: this.intent
    };
  }
}

function normalizeMode(mode) {
  const value = String(mode == null ? '' : mode).trim().toLowerCase();
  if (value === MODES.OFF || value === MODES.MANUAL || value === MODES.AUTOMATIC)
    return value;
  throw new TypeError('网络模式必须是 off、manual 或 automatic');
}

function normalizeIntent(intent) {
  const value = String(intent == null ? '' : intent).trim().toLowerCase();
  if (value === INTENTS.MANUAL || value === INTENTS.AUTOMATIC)
    return value;
  return '';
}

function normalizeOfficialHost(host) {
  if (typeof host !== 'string')
    return '';
  const trimmed = host.trim();
  if (trimmed !== host)
    return '';
  const value = trimmed.toLowerCase();
  if (!value || /[\s/:@\\\0]/.test(value))
    return '';
  return OFFICIAL_HOST_SET.has(value) ? value : '';
}

function isOfficialHost(host) {
  return normalizeOfficialHost(host) !== '';
}

function evaluatePolicy(mode, meta) {
  const normalizedMode = normalizeMode(mode);
  const intent = normalizeIntent(meta && meta.intent);
  const host = normalizeOfficialHost(meta && (meta.host || meta.hostname));

  if (normalizedMode === MODES.OFF) {
    return Object.freeze({
      allowed: false,
      code: 'ERR_NETWORK_OFF',
      mode: normalizedMode,
      intent: intent || undefined,
      host: host || undefined
    });
  }
  if (!intent) {
    return Object.freeze({
      allowed: false,
      code: 'ERR_INVALID_INTENT',
      mode: normalizedMode
    });
  }
  if (!host) {
    return Object.freeze({
      allowed: false,
      code: 'ERR_HOST_NOT_ALLOWED',
      mode: normalizedMode,
      intent
    });
  }
  if (normalizedMode === MODES.MANUAL && intent === INTENTS.AUTOMATIC) {
    return Object.freeze({
      allowed: false,
      code: 'ERR_AUTOMATIC_DISABLED',
      mode: normalizedMode,
      intent,
      host
    });
  }
  return Object.freeze({
    allowed: true,
    code: 'OK',
    mode: normalizedMode,
    intent,
    host
  });
}

function messageForDecision(decision) {
  switch (decision.code) {
    case 'ERR_NETWORK_OFF':
      return '网络访问已关闭';
    case 'ERR_AUTOMATIC_DISABLED':
      return '当前仅允许手动网络操作';
    case 'ERR_HOST_NOT_ALLOWED':
      return '目标主机不在官方允许列表中';
    case 'ERR_INVALID_INTENT':
      return '网络请求意图无效';
    case 'ERR_POLICY_DISPOSED':
      return '网络策略已释放';
    default:
      return '网络请求被策略拒绝';
  }
}

function errorFromDecision(decision) {
  return new NetworkPolicyError(
    decision.code,
    messageForDecision(decision),
    decision
  );
}

function abortError(signal) {
  if (signal && signal.reason instanceof Error)
    return signal.reason;
  return new NetworkPolicyError('ERR_ABORTED', '网络请求已取消');
}

class NetworkPolicy {
  constructor(options) {
    const initial = typeof options === 'string'
      ? options
      : options && options.mode;
    this._mode = normalizeMode(initial == null ? MODES.OFF : initial);
    this._generation = 0;
    this._nextRequestId = 1;
    this._active = new Map();
    this._listeners = new Set();
    this._disposed = false;
  }

  get mode() {
    return this._mode;
  }

  getStatus() {
    let manualInFlight = 0;
    let automaticInFlight = 0;
    for (const entry of this._active.values()) {
      if (entry.intent === INTENTS.MANUAL)
        manualInFlight++;
      else
        automaticInFlight++;
    }
    return Object.freeze({
      mode: this._mode,
      generation: this._generation,
      inFlight: this._active.size,
      manualInFlight,
      automaticInFlight,
      disposed: this._disposed
    });
  }

  onDidChange(listener) {
    if (typeof listener !== 'function')
      throw new TypeError('listener 必须是函数');
    this._listeners.add(listener);
    return Object.freeze({
      dispose: () => this._listeners.delete(listener)
    });
  }

  _emit() {
    const status = this.getStatus();
    for (const listener of this._listeners) {
      try {
        listener(status);
      }
      catch {
        // 策略监听器不能影响请求控制。
      }
    }
  }

  check(meta) {
    if (this._disposed) {
      return Object.freeze({
        allowed: false,
        code: 'ERR_POLICY_DISPOSED',
        mode: this._mode
      });
    }
    return evaluatePolicy(this._mode, meta);
  }

  canRequest(meta) {
    return this.check(meta).allowed;
  }

  assertAllowed(meta) {
    const decision = this.check(meta);
    if (!decision.allowed)
      throw errorFromDecision(decision);
    return decision;
  }

  setMode(mode) {
    if (this._disposed)
      throw new NetworkPolicyError('ERR_POLICY_DISPOSED', '网络策略已释放');
    const nextMode = normalizeMode(mode);
    if (nextMode === this._mode)
      return this.getStatus();

    this._mode = nextMode;
    this._generation++;
    for (const entry of this._active.values()) {
      const decision = evaluatePolicy(nextMode, entry);
      if (!decision.allowed && !entry.controller.signal.aborted) {
        entry.controller.abort(new NetworkPolicyError(
          'ERR_POLICY_CHANGED',
          '网络策略切换已取消进行中的请求',
          { mode: nextMode, intent: entry.intent }
        ));
      }
    }
    this._emit();
    return this.getStatus();
  }

  beginRequest(meta) {
    const decision = this.assertAllowed(meta);
    const externalSignal = meta && meta.signal;
    if (externalSignal != null &&
        (typeof externalSignal !== 'object' ||
         typeof externalSignal.addEventListener !== 'function' ||
         typeof externalSignal.aborted !== 'boolean')) {
      throw new TypeError('signal 必须是 AbortSignal');
    }
    if (externalSignal && externalSignal.aborted)
      throw abortError(externalSignal);

    const id = this._nextRequestId++;
    const controller = new AbortController();
    let finished = false;
    let removeExternal = null;
    const entry = {
      id,
      host: decision.host,
      intent: decision.intent,
      controller,
      generation: this._generation
    };

    const finish = () => {
      if (finished)
        return false;
      finished = true;
      if (removeExternal)
        removeExternal();
      const removed = this._active.delete(id);
      if (removed)
        this._emit();
      return removed;
    };

    if (externalSignal) {
      const onAbort = () => {
        if (!controller.signal.aborted)
          controller.abort(abortError(externalSignal));
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeExternal = () => externalSignal.removeEventListener('abort', onAbort);
    }

    this._active.set(id, entry);
    this._emit();

    return Object.freeze({
      id,
      host: decision.host,
      intent: decision.intent,
      generation: entry.generation,
      signal: controller.signal,
      finish,
      abort: () => {
        if (!controller.signal.aborted)
          controller.abort(new NetworkPolicyError('ERR_ABORTED', '网络请求已取消'));
      }
    });
  }

  begin(meta) {
    return this.beginRequest(meta);
  }

  async run(meta, readSecret, operation) {
    if (typeof readSecret !== 'function')
      throw new TypeError('readSecret 必须是函数');
    if (typeof operation !== 'function')
      throw new TypeError('operation 必须是函数');

    // beginRequest 必须先于 readSecret；off/拒绝路径不会触碰凭证。
    const handle = this.beginRequest(meta);
    try {
      if (handle.signal.aborted)
        throw abortError(handle.signal);
      const secret = await readSecret({ signal: handle.signal });
      if (handle.signal.aborted)
        throw abortError(handle.signal);
      return await operation(secret, {
        signal: handle.signal,
        host: handle.host,
        intent: handle.intent,
        requestId: handle.id
      });
    }
    finally {
      handle.finish();
    }
  }

  withSecret(meta, readSecret, operation) {
    return this.run(meta, readSecret, operation);
  }

  cancelIntent(intent) {
    const normalized = normalizeIntent(intent);
    if (!normalized)
      throw new TypeError('请求意图必须是 manual 或 automatic');
    let cancelled = 0;
    for (const entry of this._active.values()) {
      if (entry.intent === normalized && !entry.controller.signal.aborted) {
        entry.controller.abort(new NetworkPolicyError(
          'ERR_ABORTED',
          '网络请求已取消',
          { mode: this._mode, intent: normalized }
        ));
        cancelled++;
      }
    }
    if (cancelled)
      this._emit();
    return cancelled;
  }

  cancelAll() {
    let cancelled = 0;
    for (const entry of this._active.values()) {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(new NetworkPolicyError(
          'ERR_ABORTED',
          '网络请求已取消',
          { mode: this._mode, intent: entry.intent }
        ));
        cancelled++;
      }
    }
    if (cancelled)
      this._emit();
    return cancelled;
  }

  dispose() {
    if (this._disposed)
      return;
    this.cancelAll();
    this._disposed = true;
    this._mode = MODES.OFF;
    this._generation++;
    this._emit();
    this._listeners.clear();
  }
}

function createNetworkPolicy(options) {
  return new NetworkPolicy(options);
}

function isRequestAllowed(mode, intent, host) {
  return evaluatePolicy(mode, { intent, host }).allowed;
}

module.exports = {
  INTENTS,
  MODES,
  OFFICIAL_HOSTS,
  NetworkPolicy,
  NetworkPolicyError,
  createNetworkPolicy,
  evaluatePolicy,
  isOfficialHost,
  isRequestAllowed,
  normalizeMode,
  normalizeOfficialHost
};
