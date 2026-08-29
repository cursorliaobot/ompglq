"use strict";

const SECRET_LABEL_PATTERN = /\b(authorization|cookie|workosCursorSessionToken|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|session[_-]?token|sessionToken|code[_-]?verifier|password|secret|token)\b(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SESSION_PATTERN = /\b(user_[A-Za-z0-9]+|auth0\|[^:\s]+)(?:::|%3A%3A)[A-Za-z0-9._~+/=%-]+/gi;
const QUERY_SECRET_PATTERN = /([?&](?:access_token|refresh_token|session_token|token|code)=)[^&#\s]+/gi;
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9_-]{96,}\b/g;

function sanitizeErrorMessage(value, fallback = "操作失败") {
    let message = "";
    if (value instanceof Error)
        message = value.message;
    else if (value !== undefined && value !== null)
        message = String(value);
    message = message.trim() || fallback;
    message = message
        .replace(BEARER_PATTERN, "Bearer [REDACTED]")
        .replace(JWT_PATTERN, "[REDACTED_TOKEN]")
        .replace(SESSION_PATTERN, "$1::[REDACTED]")
        .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]")
        .replace(SECRET_LABEL_PATTERN, (_match, label, separator) => `${label}${separator}[REDACTED]`)
        .replace(LONG_SECRET_PATTERN, "[REDACTED_SECRET]");
    if (message.length > 1200)
        message = message.slice(0, 1197) + "...";
    return message;
}

function safeCode(value) {
    const code = String(value || "").trim().toUpperCase();
    return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "OPERATION_FAILED";
}

function presentError(error, options = {}) {
    const source = error && typeof error === "object" ? error : {};
    const code = safeCode(source.code || options.code);
    return {
        code,
        message: sanitizeErrorMessage(
            source.message !== undefined ? source.message : error,
            options.fallback || "操作失败"
        ),
        retryable: source.retryable === true || [
            "ETIMEDOUT",
            "ECONNRESET",
            "ECONNREFUSED",
            "SQLITE_BUSY",
            "SQLITE_LOCKED"
        ].includes(code),
        recoveryRequired: source.recoveryRequired === true ||
            source.details && source.details.recoveryRequired === true,
        offline: [
            "NETWORK_DISABLED",
            "NETWORK_MODE_OFF",
            "POLICY_DENIED",
            "ERR_NETWORK_OFF",
            "ERR_AUTOMATIC_DISABLED",
            "ERR_POLICY_CHANGED",
            "ERR_POLICY_DISPOSED"
        ].includes(code)
    };
}

module.exports = {
    sanitizeErrorMessage,
    presentError
};
