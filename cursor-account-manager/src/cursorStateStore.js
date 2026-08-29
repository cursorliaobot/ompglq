'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    AtomicFileError,
    atomicWriteFile,
    atomicWriteJson,
    assertSafeDirectory,
    assertSafeRegularFile,
    durableUnlink,
    fsyncDirectory,
    readFileSnapshot
} = require('./atomicFile');
const { SQLiteAdapter, SQLiteAdapterError } = require('./sqliteAdapter');

const fsp = fs.promises;

const AUTH_SCHEMA_VERSION = 1;
const AUTH_KEYS_BY_VERSION = Object.freeze({
    1: Object.freeze([
        'cursorAuth/accessToken',
        'cursorAuth/refreshToken',
        'cursorAuth/userId',
        'cursorAuth/cachedUserId',
        'cursorAuth/authId',
        'cursorAuth/openIdUserId',
        'cursorAuth/cachedEmail',
        'cursorAuth/email',
        'cursorAuth/user',
        'cursorAuth/workosCursorSessionToken',
        'cursorAuth/cachedWorkosSessionToken',
        'cursorAuth/isLoggedIn',
        'cursorAuth/isAuthenticated',
        'cursorAuth/isAuthorized',
        'cursorAuth/stripeMembershipType',
        'cursorAuth/stripeSubscriptionStatus',
        'cursorAuth/cachedSignUpType',
        'workos.sessionToken',
        'cursor.accessToken',
        'cursor.email',
        'cursor.auth.token',
        'cursor.auth.userId',
        'cursor.auth.email',
        'cursor.auth.lastLogin',
        'cursor.auth.subscriptionType',
        'cursor.currentAccount',
        'cursor.lastAccountSwitch',
        'cursor.appliedByKeepChat',
        'cursor.appliedAt'
    ])
});
const AUTH_KEYS = AUTH_KEYS_BY_VERSION[AUTH_SCHEMA_VERSION];
const AUTH_KEY_SET = new Set(AUTH_KEYS);
const AUTH_SCAN_PREFIXES = Object.freeze(['cursorAuth/', 'cursor.auth.', 'cursor.', 'workos.']);
const CURSOR_AUTH_STEMS = Object.freeze([
    'accesstoken',
    'apitoken',
    'token',
    'refreshtoken',
    'auth',
    'credential',
    'session',
    'userid',
    'email',
    'currentaccount',
    'lastaccountswitch',
    'login',
    'subscription',
    'membership',
    'stripe'
]);
const JOURNAL_VERSION = 1;
const BACKUP_MANIFEST_VERSION = 1;
const JOURNAL_STATES = new Set([
    'prepared',
    'sqlite-written',
    'json-written',
    'verified',
    'committed',
    'aborted',
    'rollback-needed',
    'rolled-back'
]);

class CursorStateStoreError extends Error {
    constructor(code, message, details = {}, cause) {
        super(message);
        this.name = 'CursorStateStoreError';
        this.code = code;
        this.operation = details.operation || 'cursor-state';
        this.recoveryRequired = details.recoveryRequired === true;
        this.rolledBack = details.rolledBack === true;
        this.details = details;
        if (cause !== undefined)
            this.cause = cause;
    }

    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            operation: this.operation,
            recoveryRequired: this.recoveryRequired,
            rolledBack: this.rolledBack,
            details: this.details
        };
    }
}

function storeError(code, message, details = {}, cause) {
    return new CursorStateStoreError(code, message, details, cause);
}

function errorChainHasCode(error, code) {
    const seen = new Set();
    let current = error;
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        if (current.code === code)
            return true;
        current = current.cause;
    }
    return false;
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function isPotentialAuthKey(key) {
    if (typeof key !== 'string')
        return false;
    if (key.startsWith('cursorAuth/') ||
        key.startsWith('cursor.auth.') ||
        key.startsWith('workos.')) {
        return true;
    }
    if (!key.startsWith('cursor.'))
        return false;
    const suffix = key.slice('cursor.'.length).toLowerCase().replace(/[^a-z0-9]/g, '');
    return CURSOR_AUTH_STEMS.some(stem => suffix.startsWith(stem)) ||
        suffix.includes('token') ||
        suffix.includes('credential');
}

function normalizedString(value) {
    if (value == null)
        return '';
    let text = String(value).trim();
    if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed === 'string')
                text = parsed.trim();
        }
        catch { }
    }
    return text;
}

function normalizeUserId(value) {
    return normalizedString(value).replace(/^auth0\|/i, '').trim();
}

function normalizeEmail(value) {
    return normalizedString(value).toLowerCase();
}

function sourceValue(source, ...keys) {
    for (const key of keys) {
        if (hasOwn(source, key) && source[key] != null && normalizedString(source[key]))
            return source[key];
    }
    return '';
}

function flattenTarget(target) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw storeError('INVALID_TARGET', '目标账号必须是对象', {
            operation: 'build-auth-entries'
        });
    }
    return {
        ...(target.authBlob && typeof target.authBlob === 'object' ? target.authBlob : {}),
        ...(target.entries && typeof target.entries === 'object' ? target.entries : {}),
        ...target
    };
}

function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3)
        return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return payload && typeof payload === 'object' ? payload : null;
    }
    catch {
        return null;
    }
}

function validateIdentityAgainstToken(accessToken, userId, email) {
    const payload = decodeJwtPayload(accessToken);
    if (!payload)
        return;
    // Cursor 的 JWT sub 与桌面 WorkOS userId 在部分账号中属于不同命名空间，
    // 不能仅凭 sub 不同拒绝合法切号；只有明确 userId claim 才做强比较。
    const tokenUserId = normalizeUserId(payload.userId || payload.user_id || '');
    if (tokenUserId && userId && tokenUserId !== normalizeUserId(userId)) {
        throw storeError('TARGET_IDENTITY_MISMATCH', 'accessToken 中的用户身份与目标 userId 不一致', {
            operation: 'validate-target-identity'
        });
    }
    const tokenEmail = normalizeEmail(payload.email || '');
    if (email && tokenEmail && tokenEmail !== normalizeEmail(email)) {
        throw storeError('TARGET_EMAIL_MISMATCH', 'accessToken 中的邮箱与目标邮箱不一致', {
            operation: 'validate-target-identity'
        });
    }
}

function buildAuthEntries(target, options = {}) {
    const source = flattenTarget(target);
    const accessToken = normalizedString(sourceValue(source,
        'cursorAuth/accessToken', 'accessToken', 'token'));
    const refreshToken = normalizedString(sourceValue(source,
        'cursorAuth/refreshToken', 'refreshToken'));
    const userId = normalizeUserId(sourceValue(source,
        'cursorAuth/userId', 'cursorAuth/cachedUserId', 'cursorAuth/authId', 'userId', 'authId'));
    let email = normalizeEmail(sourceValue(source,
        'cursorAuth/cachedEmail', 'cursorAuth/email', 'cursor.email', 'email'));
    if (!email && source['cursorAuth/user']) {
        try {
            email = normalizeEmail(JSON.parse(String(source['cursorAuth/user'])).email || '');
        }
        catch { }
    }
    if (!accessToken) {
        throw storeError('TARGET_TOKEN_MISSING', '目标账号缺少 accessToken', {
            operation: 'build-auth-entries'
        });
    }
    if (!userId) {
        throw storeError('TARGET_USER_ID_MISSING', '目标账号缺少 userId', {
            operation: 'build-auth-entries'
        });
    }
    validateIdentityAgainstToken(accessToken, userId, email);

    const timestamp = options.timestamp || new Date().toISOString();
    const plan = normalizedString(sourceValue(source,
        'cursorAuth/stripeMembershipType', 'cursor.auth.subscriptionType', 'type', 'plan'));
    const subscriptionStatus = normalizedString(sourceValue(source,
        'cursorAuth/stripeSubscriptionStatus', 'subscriptionStatus'));
    const signUpType = normalizedString(sourceValue(source,
        'cursorAuth/cachedSignUpType', 'signUpType'));
    const rawSession = `${userId}::${accessToken}`;
    const encodedSession = `${userId}%3A%3A${accessToken}`;
    const entries = {
        'cursorAuth/accessToken': accessToken,
        'cursorAuth/userId': userId,
        'cursorAuth/cachedUserId': userId,
        'cursorAuth/authId': userId,
        'cursorAuth/openIdUserId': userId,
        'cursorAuth/workosCursorSessionToken': encodedSession,
        'cursorAuth/cachedWorkosSessionToken': encodedSession,
        'cursorAuth/isLoggedIn': 'true',
        'cursorAuth/isAuthenticated': 'true',
        'cursorAuth/isAuthorized': 'true',
        'workos.sessionToken': rawSession,
        'cursor.accessToken': accessToken,
        'cursor.auth.token': rawSession,
        'cursor.auth.userId': userId,
        'cursor.auth.lastLogin': timestamp,
        'cursor.lastAccountSwitch': timestamp,
        'cursor.appliedByKeepChat': 'true',
        'cursor.appliedAt': timestamp
    };
    if (refreshToken)
        entries['cursorAuth/refreshToken'] = refreshToken;
    if (email) {
        entries['cursorAuth/cachedEmail'] = email;
        entries['cursorAuth/email'] = email;
        entries['cursorAuth/user'] = JSON.stringify({ email, id: userId, sub: userId });
        entries['cursor.email'] = email;
        entries['cursor.auth.email'] = email;
        entries['cursor.currentAccount'] = email;
    }
    if (plan) {
        entries['cursorAuth/stripeMembershipType'] = plan;
        entries['cursor.auth.subscriptionType'] = plan;
    }
    if (subscriptionStatus)
        entries['cursorAuth/stripeSubscriptionStatus'] = subscriptionStatus;
    if (signUpType)
        entries['cursorAuth/cachedSignUpType'] = signUpType;

    for (const key of Object.keys(entries)) {
        if (!AUTH_KEY_SET.has(key)) {
            throw storeError('AUTH_KEY_NOT_ALLOWED', `构造出了 allowlist 外的鉴权键：${key}`, {
                operation: 'build-auth-entries',
                key
            });
        }
    }
    return entries;
}

function extractAuthEntries(object) {
    const result = {};
    if (!object || typeof object !== 'object')
        return result;
    for (const key of AUTH_KEYS) {
        if (hasOwn(object, key))
            result[key] = object[key];
    }
    return result;
}

function replaceAuthEntries(document, entries) {
    const result = { ...document };
    for (const key of AUTH_KEYS)
        delete result[key];
    for (const key of Object.keys(entries || {})) {
        if (!AUTH_KEY_SET.has(key)) {
            throw storeError('AUTH_KEY_NOT_ALLOWED', `拒绝写入 allowlist 外的键：${key}`, {
                operation: 'replace-json-auth',
                key
            });
        }
        result[key] = entries[key];
    }
    return result;
}

function stableSerialize(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return '[' + value.map(stableSerialize).join(',') + ']';
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return '{' + keys.map(key => JSON.stringify(key) + ':' + stableSerialize(value[key])).join(',') + '}';
    }
    const serialized = JSON.stringify(value);
    return serialized === undefined ? JSON.stringify(String(value)) : serialized;
}

function nonAuthDigest(document) {
    const nonAuth = {};
    for (const key of Object.keys(document || {})) {
        if (!AUTH_KEY_SET.has(key))
            nonAuth[key] = document[key];
    }
    return crypto.createHash('sha256').update(stableSerialize(nonAuth)).digest('hex');
}

function tokenDigest(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function normalizedDatabaseEntries(entries) {
    const result = {};
    for (const key of Object.keys(entries || {})) {
        if (!AUTH_KEY_SET.has(key)) {
            throw storeError('AUTH_KEY_NOT_ALLOWED', `鉴权快照包含 allowlist 外的键：${key}`, {
                operation: 'normalize-auth-snapshot',
                key
            });
        }
        const value = entries[key];
        result[key] = Buffer.isBuffer(value)
            ? value.toString('utf8')
            : (value === null ? null : String(value));
    }
    return result;
}

function exactMismatches(expected, actual) {
    const mismatches = [];
    for (const key of AUTH_KEYS) {
        const expectedHas = hasOwn(expected || {}, key);
        const actualHas = hasOwn(actual || {}, key);
        if (expectedHas !== actualHas) {
            mismatches.push({ key, expected: expectedHas ? 'present' : 'absent', actual: actualHas ? 'present' : 'absent' });
            continue;
        }
        if (expectedHas) {
            const left = expected[key];
            const right = actual[key];
            const equal = left === right ||
                (Buffer.isBuffer(left) ? left.toString('utf8') : String(left)) ===
                (Buffer.isBuffer(right) ? right.toString('utf8') : String(right));
            if (!equal)
                mismatches.push({ key, expected: 'different-value', actual: 'different-value' });
        }
    }
    return mismatches;
}

function identityForEntries(entries, requireAuth) {
    const accessToken = normalizedString(entries && entries['cursorAuth/accessToken']);
    const userId = normalizeUserId(entries && (entries['cursorAuth/userId'] || entries['cursorAuth/cachedUserId']));
    const email = normalizeEmail(entries && (entries['cursorAuth/cachedEmail'] || entries['cursorAuth/email']));
    return {
        requireAuth: requireAuth === true,
        userId,
        email,
        accessTokenHash: accessToken ? tokenDigest(accessToken) : ''
    };
}

function safeBackupName(name) {
    return typeof name === 'string' && /^switch-[0-9A-Za-z._-]{8,160}$/.test(name);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

function processStartToken(pid) {
    try {
        if (process.platform === 'linux') {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const close = stat.lastIndexOf(')');
            if (close < 0)
                return null;
            const fields = stat.slice(close + 2).trim().split(/\s+/);
            return fields[19] || null;
        }
        if (process.platform === 'darwin' || process.platform === 'freebsd') {
            const output = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
                encoding: 'utf8',
                env: { ...process.env, LC_ALL: 'C' },
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 2000,
                windowsHide: true
            }).trim();
            return output ? `${process.platform}:${output}` : null;
        }
        if (process.platform === 'win32') {
            const powershell = path.join(
                process.env.SystemRoot || 'C:\\Windows',
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe'
            );
            const output = execFileSync(powershell, [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                '[System.Diagnostics.Process]::GetProcessById([int]$args[0]).StartTime.ToUniversalTime().Ticks',
                String(pid)
            ], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 3000,
                windowsHide: true
            }).trim();
            return output ? `win32:${output}` : null;
        }
        return null;
    }
    catch {
        return null;
    }
}

function fileIdentity(stat) {
    return {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs
    };
}

function sameFileIdentity(left, right) {
    if (!left || !right)
        return false;
    if (left.ino || right.ino)
        return left.dev === right.dev && left.ino === right.ino;
    return left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs;
}

class CursorStateStore {
    constructor(options = {}) {
        const storageDir = options.storageDir || options.globalStorageDir;
        if (!storageDir || typeof storageDir !== 'string') {
            throw storeError('STORAGE_DIR_REQUIRED', '必须显式提供 Cursor globalStorage 目录', {
                operation: 'construct-store'
            });
        }
        this.storageDir = path.resolve(storageDir);
        this.dbFileName = this._validateSimpleName(options.dbFileName || 'state.vscdb', 'dbFileName');
        this.storageFileName = this._validateSimpleName(options.storageFileName || 'storage.json', 'storageFileName');
        this.backupDirName = this._validateSimpleName(options.backupDirName || '.cursor-account-manager-backups', 'backupDirName');
        this.journalFileName = this._validateSimpleName(options.journalFileName || '.cursor-account-manager-switch-journal.json', 'journalFileName');
        this.lockFileName = this._validateSimpleName(options.lockFileName || '.cursor-account-manager-switch.lock', 'lockFileName');
        this.maxBackups = Number.isInteger(options.maxBackups)
            ? Math.max(1, options.maxBackups)
            : 5;
        this.lockTimeoutMs = Number.isFinite(options.lockTimeoutMs)
            ? Math.max(100, options.lockTimeoutMs)
            : 10000;
        this.lockStaleMs = Number.isFinite(options.lockStaleMs)
            ? Math.max(1000, options.lockStaleMs)
            : 5 * 60 * 1000;
        this.clock = typeof options.clock === 'function' ? options.clock : () => new Date();
        this.onPhase = typeof options.onPhase === 'function' ? options.onPhase : null;
        this.sqlite = options.sqliteAdapter || options.sqlite ||
            (options.loaded ? new SQLiteAdapter(options.loaded, options.sqliteOptions) : null);
        if (!this.sqlite) {
            throw storeError('SQLITE_ADAPTER_REQUIRED', '必须注入 sqliteAdapter 或 loaded descriptor', {
                operation: 'construct-store'
            });
        }
        this._queue = Promise.resolve();
    }

    _validateSimpleName(value, optionName) {
        if (typeof value !== 'string' || !value || value !== path.basename(value) || value === '.' || value === '..') {
            throw storeError('INVALID_FILE_NAME', `${optionName} 必须是不含路径分隔符的文件名`, {
                operation: 'construct-store',
                optionName
            });
        }
        return value;
    }

    _isoNow() {
        const value = this.clock();
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) {
            throw storeError('INVALID_CLOCK', 'clock 返回了无效时间', {
                operation: 'read-clock'
            });
        }
        return date.toISOString();
    }

    async _rootPaths() {
        const root = await assertSafeDirectory(this.storageDir);
        return {
            root: root.path,
            db: path.join(root.path, this.dbFileName),
            storage: path.join(root.path, this.storageFileName),
            backupRoot: path.join(root.path, this.backupDirName),
            journal: path.join(root.path, this.journalFileName),
            lock: path.join(root.path, this.lockFileName),
            lockTakeover: path.join(root.path, `${this.lockFileName}.takeover`)
        };
    }

    async _validatedPaths() {
        const paths = await this._rootPaths();
        const db = await assertSafeRegularFile(paths.db, { root: paths.root });
        const storage = await assertSafeRegularFile(paths.storage, { root: paths.root });
        paths.db = db.path;
        paths.storage = storage.path;
        return paths;
    }

    async _readJsonFile(filePath, root, operation) {
        await assertSafeRegularFile(filePath, { root });
        let text;
        let identity;
        try {
            const snapshot = await readFileSnapshot(filePath);
            text = snapshot.data.toString('utf8');
            identity = {
                dev: snapshot.dev,
                ino: snapshot.ino,
                size: snapshot.size,
                mtimeMs: snapshot.mtimeMs,
                sha256: snapshot.sha256
            };
        }
        catch (error) {
            throw storeError('JSON_READ_FAILED', `无法读取 JSON 文件：${filePath}`, {
                operation,
                path: filePath
            }, error);
        }
        let value;
        try {
            value = JSON.parse(text);
        }
        catch (error) {
            throw storeError('JSON_PARSE_FAILED', `JSON 文件格式无效：${filePath}`, {
                operation,
                path: filePath
            }, error);
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw storeError('JSON_OBJECT_REQUIRED', `JSON 顶层必须是对象：${filePath}`, {
                operation,
                path: filePath
            });
        }
        return { value, text, identity };
    }

    async _readStorage(paths) {
        return this._readJsonFile(paths.storage, paths.root, 'read-storage-json');
    }

    async _writeStorageAuthWithRetry(paths, authEntries, operation, options = {}) {
        for (let attempt = 0; attempt < 4; attempt++) {
            const latest = await this._readStorage(paths);
            await this._assertNoUnknownAuthKeys(paths, latest.value);
            if (options.expectedAuth) {
                const currentAuth = extractAuthEntries(latest.value);
                const conflicts = exactMismatches(options.expectedAuth, currentAuth);
                if (conflicts.length) {
                    throw storeError('CONCURRENT_AUTH_UPDATE', 'storage.json 鉴权键已被其他进程修改', {
                        operation,
                        path: paths.storage,
                        conflicts,
                        retryable: true
                    });
                }
            }
            const next = replaceAuthEntries(latest.value, authEntries);
            try {
                await atomicWriteJson(paths.storage, next, {
                    root: paths.root,
                    mode: 0o600,
                    expectedCurrent: latest.identity
                });
                return {
                    nonAuthDigest: nonAuthDigest(latest.value),
                    attempts: attempt + 1
                };
            }
            catch (error) {
                if (error instanceof AtomicFileError &&
                    error.code === 'TARGET_CHANGED' &&
                    attempt < 3) {
                    continue;
                }
                throw error;
            }
        }
        throw storeError('CONCURRENT_STORAGE_UPDATE', 'storage.json 持续被其他进程修改，已安全放弃写入', {
            operation,
            path: paths.storage,
            retryable: true
        });
    }

    async _sqliteRead(dbPath) {
        if (typeof this.sqlite.readKeys === 'function')
            return normalizedDatabaseEntries(await this.sqlite.readKeys(dbPath, AUTH_KEYS));
        if (typeof this.sqlite.readExactKeys === 'function')
            return normalizedDatabaseEntries(await this.sqlite.readExactKeys(dbPath, AUTH_KEYS));
        throw storeError('SQLITE_READ_UNSUPPORTED', 'sqliteAdapter 未提供 readKeys/readExactKeys', {
            operation: 'sqlite-read'
        });
    }

    async _assertNoUnknownAuthKeys(paths, storageDocument) {
        const jsonUnknown = Object.keys(storageDocument || {})
            .filter(isPotentialAuthKey)
            .filter(key => !AUTH_KEY_SET.has(key));
        let databaseUnknown = [];
        if (typeof this.sqlite.readKeysByPrefixes === 'function' ||
            typeof this.sqlite.readAuthPrefixKeys === 'function') {
            const reader = typeof this.sqlite.readKeysByPrefixes === 'function'
                ? this.sqlite.readKeysByPrefixes.bind(this.sqlite)
                : this.sqlite.readAuthPrefixKeys.bind(this.sqlite);
            const rows = await reader(paths.db, AUTH_SCAN_PREFIXES);
            databaseUnknown = Object.keys(rows || {})
                .filter(isPotentialAuthKey)
                .filter(key => !AUTH_KEY_SET.has(key));
        }
        else {
            throw storeError('SQLITE_PREFIX_SCAN_UNSUPPORTED', 'SQLite 适配器无法检查未知鉴权键', {
                operation: 'scan-auth-keys'
            });
        }
        if (jsonUnknown.length || databaseUnknown.length) {
            throw storeError('UNKNOWN_AUTH_KEYS', '检测到当前版本尚未识别的 Cursor 鉴权键，已拒绝写入', {
                operation: 'scan-auth-keys',
                jsonKeys: jsonUnknown,
                databaseKeys: databaseUnknown
            });
        }
    }

    async _sqliteReplace(dbPath, entries, expectedEntries) {
        const normalized = normalizedDatabaseEntries(entries);
        if (typeof this.sqlite.replaceKeys === 'function')
            return this.sqlite.replaceKeys(dbPath, AUTH_KEYS, normalized, {
                expectedEntries: expectedEntries === undefined
                    ? undefined
                    : normalizedDatabaseEntries(expectedEntries)
            });
        if (expectedEntries !== undefined) {
            throw storeError('SQLITE_CAS_UNSUPPORTED', 'sqliteAdapter 不支持事务内前像校验', {
                operation: 'sqlite-write'
            });
        }
        if (typeof this.sqlite.writeExactKeys === 'function')
            return this.sqlite.writeExactKeys(dbPath, AUTH_KEYS, normalized);
        if (typeof this.sqlite.restoreExactKeys === 'function')
            return this.sqlite.restoreExactKeys(dbPath, AUTH_KEYS, normalized);
        if (typeof this.sqlite.writeKeys === 'function')
            return this.sqlite.writeKeys(dbPath, normalized, { keys: AUTH_KEYS });
        throw storeError('SQLITE_WRITE_UNSUPPORTED', 'sqliteAdapter 未提供精确键写入 API', {
            operation: 'sqlite-write'
        });
    }

    async _sqliteBackup(dbPath, backupPath) {
        if (typeof this.sqlite.backup === 'function')
            return this.sqlite.backup(dbPath, backupPath);
        if (typeof this.sqlite.backupDatabase === 'function')
            return this.sqlite.backupDatabase(dbPath, backupPath);
        throw storeError('SQLITE_BACKUP_UNSUPPORTED', 'sqliteAdapter 未提供一致备份 API', {
            operation: 'sqlite-backup'
        });
    }

    async _sqliteQuickCheck(dbPath) {
        if (typeof this.sqlite.quickCheck === 'function')
            await this.sqlite.quickCheck(dbPath);
    }

    async _phase(name, journal) {
        if (this.onPhase) {
            await this.onPhase(name, {
                operationId: journal.operationId,
                state: journal.state,
                backupName: journal.backupName,
                kind: journal.kind
            });
        }
    }

    async _inspectLock(paths, filePath) {
        const safe = await assertSafeRegularFile(filePath, {
            root: paths.root,
            allowMissing: true
        });
        if (!safe.exists)
            return { exists: false };
        let record = null;
        try {
            record = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        }
        catch {
            // A malformed lock can only become stale by age.
        }
        const age = Date.now() - safe.stat.mtimeMs;
        const ownerPid = Number(record && record.pid);
        let stale;
        if (Number.isInteger(ownerPid) && ownerPid > 0) {
            if (record && record.hostname && record.hostname !== os.hostname()) {
                stale = false;
            }
            else if (!pidIsAlive(ownerPid)) {
                stale = true;
            }
            else {
                const currentStart = processStartToken(ownerPid);
                if (record && record.processStart && currentStart) {
                    stale = record.processStart !== currentStart;
                }
                else {
                    stale = false;
                }
            }
        }
        else {
            stale = age > this.lockStaleMs;
        }
        return {
            exists: true,
            age,
            identity: fileIdentity(safe.stat),
            record,
            stale
        };
    }

    async _createOwnedLock(paths, filePath, lockId, kind) {
        let handle;
        let createdIdentity;
        try {
            handle = await fsp.open(filePath, 'wx', 0o600);
            createdIdentity = fileIdentity(await handle.stat());
            const record = JSON.stringify({
                version: 1,
                kind,
                lockId,
                pid: process.pid,
                processStart: processStartToken(process.pid),
                hostname: os.hostname(),
                createdAt: this._isoNow()
            }) + '\n';
            await handle.writeFile(record, 'utf8');
            await handle.sync();
            await fsyncDirectory(paths.root);
            const heartbeat = setInterval(() => {
                const now = new Date();
                handle.utimes(now, now).catch(() => {
                    // A failed heartbeat makes the lease expire safely.
                });
            }, Math.max(250, Math.floor(this.lockStaleMs / 3)));
            heartbeat.unref?.();
            return { handle, lockId, heartbeat };
        }
        catch (error) {
            if (handle) {
                try {
                    await handle.close();
                }
                catch { }
            }
            if (createdIdentity) {
                try {
                    const safe = await assertSafeRegularFile(filePath, {
                        root: paths.root,
                        allowMissing: true
                    });
                    if (safe.exists &&
                        sameFileIdentity(createdIdentity, fileIdentity(safe.stat))) {
                        await durableUnlink(filePath, { root: paths.root });
                    }
                }
                catch {
                    // Preserve the original lock creation error.
                }
            }
            throw error;
        }
    }

    async _releaseOwnedLock(paths, filePath, lock) {
        if (!lock)
            return;
        if (lock.heartbeat)
            clearInterval(lock.heartbeat);
        try {
            await lock.handle.close();
        }
        catch { }
        try {
            const safe = await assertSafeRegularFile(filePath, {
                root: paths.root,
                allowMissing: true
            });
            if (!safe.exists)
                return;
            const record = JSON.parse(await fsp.readFile(filePath, 'utf8'));
            if (record.lockId === lock.lockId)
                await durableUnlink(filePath, { root: paths.root });
        }
        catch {
            // A changed lock belongs to another process; never remove it.
        }
    }

    async _takeOverStaleLock(paths, observed, lockId) {
        const takeoverId = crypto.randomBytes(18).toString('hex');
        let takeover;
        try {
            takeover = await this._createOwnedLock(
                paths,
                paths.lockTakeover,
                takeoverId,
                'stale-lock-takeover'
            );
        }
        catch (error) {
            if (error && error.code === 'EEXIST')
                return null;
            throw error;
        }

        try {
            const current = await this._inspectLock(paths, paths.lock);
            if (!current.exists || !current.stale ||
                !sameFileIdentity(current.identity, observed.identity)) {
                return null;
            }
            const currentTakeover = await this._inspectLock(paths, paths.lockTakeover);
            if (!currentTakeover.exists ||
                !currentTakeover.record ||
                currentTakeover.record.lockId !== takeoverId) {
                return null;
            }
            await durableUnlink(paths.lock, { root: paths.root });
            try {
                return await this._createOwnedLock(paths, paths.lock, lockId, 'operation');
            }
            catch (error) {
                if (error && error.code === 'EEXIST')
                    return null;
                throw error;
            }
        }
        finally {
            await this._releaseOwnedLock(paths, paths.lockTakeover, takeover);
        }
    }

    async _removeObservedStaleLock(paths, filePath, observed) {
        const quarantine = `${filePath}.stale-${crypto.randomBytes(12).toString('hex')}`;
        await fsp.rename(filePath, quarantine);
        await fsyncDirectory(paths.root);
        const moved = await this._inspectLock(paths, quarantine);
        if (!moved.exists || !sameFileIdentity(moved.identity, observed.identity)) {
            try {
                const replacement = await this._inspectLock(paths, filePath);
                if (!replacement.exists)
                    await fsp.rename(quarantine, filePath);
            }
            catch { }
            throw storeError('LOCK_RACE', '锁在清理过程中发生变化，已拒绝继续', {
                operation: 'recover-stale-lock',
                path: filePath
            });
        }
        await durableUnlink(quarantine, { root: paths.root });
    }

    async _acquireFileLock(paths) {
        const lockId = crypto.randomBytes(18).toString('hex');
        const deadline = Date.now() + this.lockTimeoutMs;
        for (;;) {
            const takeover = await this._inspectLock(paths, paths.lockTakeover);
            if (takeover.exists) {
                if (takeover.stale) {
                    await this._removeObservedStaleLock(
                        paths,
                        paths.lockTakeover,
                        takeover
                    );
                    continue;
                }
                if (Date.now() >= deadline) {
                    throw storeError('OPERATION_LOCKED', '另一个切号/恢复操作仍在进行', {
                        operation: 'acquire-lock',
                        path: paths.lockTakeover
                    });
                }
                await delay(25);
                continue;
            }

            try {
                return await this._createOwnedLock(paths, paths.lock, lockId, 'operation');
            }
            catch (error) {
                if (!error || error.code !== 'EEXIST') {
                    throw storeError('LOCK_ACQUIRE_FAILED', '无法创建切号操作锁', {
                        operation: 'acquire-lock',
                        path: paths.lock
                    }, error);
                }
            }

            const observed = await this._inspectLock(paths, paths.lock);
            if (!observed.exists)
                continue;
            if (observed.stale) {
                try {
                    const acquired = await this._takeOverStaleLock(paths, observed, lockId);
                    if (acquired)
                        return acquired;
                }
                catch (error) {
                    throw storeError('LOCK_TAKEOVER_FAILED', '无法安全接管失效的切号操作锁', {
                        operation: 'acquire-lock',
                        path: paths.lock
                    }, error);
                }
                continue;
            }
            if (Date.now() >= deadline) {
                throw storeError('OPERATION_LOCKED', '另一个切号/恢复操作仍在进行', {
                    operation: 'acquire-lock',
                    path: paths.lock
                });
            }
            await delay(25);
        }
    }

    async _releaseFileLock(paths, lock) {
        await this._releaseOwnedLock(paths, paths.lock, lock);
    }

    async _withOperationLock(operation, callback) {
        const previous = this._queue;
        let releaseQueue;
        this._queue = new Promise(resolve => {
            releaseQueue = resolve;
        });
        await previous.catch(() => { });
        let paths;
        let lock;
        try {
            paths = await this._rootPaths();
            lock = await this._acquireFileLock(paths);
            return await callback(paths);
        }
        catch (error) {
            if (error instanceof CursorStateStoreError || error instanceof SQLiteAdapterError)
                throw error;
            if (error instanceof AtomicFileError) {
                throw storeError(error.code, error.message, {
                    operation,
                    path: error.path
                }, error);
            }
            throw storeError('STATE_OPERATION_FAILED', `${operation} 失败`, {
                operation
            }, error);
        }
        finally {
            if (paths)
                await this._releaseFileLock(paths, lock);
            releaseQueue();
        }
    }

    async _ensureBackupRoot(paths) {
        try {
            await fsp.mkdir(paths.backupRoot, { mode: 0o700 });
            await fsyncDirectory(paths.root);
        }
        catch (error) {
            if (!error || error.code !== 'EEXIST') {
                throw storeError('BACKUP_DIR_CREATE_FAILED', '无法创建备份目录', {
                    operation: 'create-backup-directory',
                    path: paths.backupRoot
                }, error);
            }
        }
        const safe = await assertSafeDirectory(paths.backupRoot, { root: paths.root });
        await fsp.chmod(safe.path, 0o700);
        paths.backupRoot = safe.path;
        return safe.path;
    }

    _newBackupName() {
        const timestamp = this._isoNow().replace(/[-:.]/g, '');
        return `switch-${timestamp}-${crypto.randomBytes(8).toString('hex')}`;
    }

    async _createBackup(paths, before, metadata = {}) {
        const backupRoot = await this._ensureBackupRoot(paths);
        const backupName = this._newBackupName();
        const backupDirectory = path.join(backupRoot, backupName);
        try {
            await fsp.mkdir(backupDirectory, { mode: 0o700 });
            await fsp.chmod(backupDirectory, 0o700);
            await fsyncDirectory(backupRoot);
            const dbBackup = path.join(backupDirectory, this.dbFileName);
            const jsonBackup = path.join(backupDirectory, this.storageFileName);
            await this._sqliteBackup(paths.db, dbBackup);
            await assertSafeRegularFile(dbBackup, { root: backupDirectory });
            await fsp.chmod(dbBackup, 0o600);
            await atomicWriteFile(jsonBackup, before.storageText, {
                root: backupDirectory,
                mode: 0o600,
                encoding: 'utf8'
            });
            const manifest = {
                version: BACKUP_MANIFEST_VERSION,
                authSchemaVersion: AUTH_SCHEMA_VERSION,
                createdAt: this._isoNow(),
                operationId: metadata.operationId || '',
                kind: metadata.kind || 'switch',
                files: {
                    database: this.dbFileName,
                    storage: this.storageFileName
                },
                sourceNonAuthDigest: before.nonAuthDigest
            };
            await atomicWriteJson(path.join(backupDirectory, 'manifest.json'), manifest, {
                root: backupDirectory,
                mode: 0o600
            });
            await fsyncDirectory(backupDirectory);
            await this._cleanupBackups(paths, backupName);
            return { backupName, backupDirectory };
        }
        catch (error) {
            try {
                await this._removeBackupDirectory(backupRoot, backupName);
            }
            catch { }
            throw storeError('BACKUP_FAILED', '备份 state.vscdb/storage.json 失败；未修改登录态', {
                operation: 'create-backup',
                backupName
            }, error);
        }
    }

    async _backupDirectories(paths) {
        try {
            await this._ensureBackupRoot(paths);
            const entries = await fsp.readdir(paths.backupRoot, { withFileTypes: true });
            const result = [];
            for (const entry of entries) {
                if (!entry.isDirectory() || !safeBackupName(entry.name))
                    continue;
                const candidate = path.join(paths.backupRoot, entry.name);
                try {
                    const safe = await assertSafeDirectory(candidate, { root: paths.backupRoot });
                    const stat = await fsp.stat(safe.path);
                    result.push({ name: entry.name, path: safe.path, mtimeMs: stat.mtimeMs });
                }
                catch { }
            }
            return result.sort((left, right) =>
                right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
        }
        catch (error) {
            throw storeError('BACKUP_LIST_FAILED', '无法列出安全备份', {
                operation: 'list-backups',
                path: paths.backupRoot
            }, error);
        }
    }

    async _removeBackupDirectory(backupRoot, backupName) {
        if (!safeBackupName(backupName))
            return false;
        const directoryPath = path.join(backupRoot, backupName);
        let safe;
        try {
            safe = await assertSafeDirectory(directoryPath, { root: backupRoot });
        }
        catch (error) {
            if (error && error.code === 'PATH_NOT_FOUND')
                return false;
            throw error;
        }
        const entries = await fsp.readdir(safe.path, { withFileTypes: true });
        for (const entry of entries) {
            const filePath = path.join(safe.path, entry.name);
            const stat = await fsp.lstat(filePath);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                throw storeError('UNSAFE_BACKUP_CONTENT', '备份目录包含非普通文件，拒绝清理', {
                    operation: 'cleanup-backup',
                    backupName,
                    entry: entry.name
                });
            }
            await fsp.unlink(filePath);
        }
        await fsyncDirectory(safe.path);
        await fsp.rmdir(safe.path);
        await fsyncDirectory(backupRoot);
        return true;
    }

    async _cleanupBackups(paths, keepName) {
        const directories = await this._backupDirectories(paths);
        const keep = new Set();
        if (keepName)
            keep.add(keepName);
        for (const entry of directories) {
            if (keep.size < this.maxBackups)
                keep.add(entry.name);
        }
        for (const entry of directories) {
            if (!keep.has(entry.name)) {
                try {
                    await this._removeBackupDirectory(paths.backupRoot, entry.name);
                }
                catch { }
            }
        }
    }

    async _writeJournal(paths, journal, state) {
        const next = {
            ...journal,
            state,
            updatedAt: this._isoNow()
        };
        await atomicWriteJson(paths.journal, next, {
            root: paths.root,
            mode: 0o600
        });
        return next;
    }

    _validateJournal(journal) {
        if (!journal || typeof journal !== 'object' || Array.isArray(journal) ||
            journal.version !== JOURNAL_VERSION ||
            journal.authSchemaVersion !== AUTH_SCHEMA_VERSION ||
            !JOURNAL_STATES.has(journal.state) ||
            !safeBackupName(journal.backupName) ||
            !journal.before || !journal.target) {
            throw storeError('JOURNAL_INVALID', '切号 journal 格式或版本无效', {
                operation: 'validate-journal'
            });
        }
        journal.before.sqliteAuth = normalizedDatabaseEntries(journal.before.sqliteAuth || {});
        journal.before.jsonAuth = extractAuthEntries(journal.before.jsonAuth || {});
        journal.target.sqliteAuth = normalizedDatabaseEntries(journal.target.sqliteAuth || {});
        journal.target.jsonAuth = extractAuthEntries(journal.target.jsonAuth || {});
        if (!journal.target.identity || typeof journal.target.identity !== 'object')
            journal.target.identity = identityForEntries(journal.target.sqliteAuth, false);
        return journal;
    }

    async _readJournal(paths) {
        const safe = await assertSafeRegularFile(paths.journal, {
            root: paths.root,
            allowMissing: true
        });
        if (!safe.exists)
            return null;
        const read = await this._readJsonFile(paths.journal, paths.root, 'read-journal');
        return this._validateJournal(read.value);
    }

    async _deleteJournal(paths) {
        return durableUnlink(paths.journal, { root: paths.root });
    }

    async _verifyTarget(paths, target, expectedNonAuthDigest, options = {}) {
        const databaseAuth = await this._sqliteRead(paths.db);
        const storage = await this._readStorage(paths);
        const jsonAuth = extractAuthEntries(storage.value);
        const sqliteMismatches = exactMismatches(target.sqliteAuth, databaseAuth);
        const jsonMismatches = exactMismatches(target.jsonAuth, jsonAuth);
        if (sqliteMismatches.length || jsonMismatches.length) {
            throw storeError('AUTH_READBACK_MISMATCH', 'SQLite/JSON 鉴权键读回不一致', {
                operation: 'verify-auth',
                sqliteMismatches,
                jsonMismatches
            });
        }
        const identity = target.identity || {};
        if (identity.requireAuth) {
            for (const [storeName, entries] of [['sqlite', databaseAuth], ['json', jsonAuth]]) {
                const accessToken = normalizedString(entries['cursorAuth/accessToken']);
                const userId = normalizeUserId(entries['cursorAuth/userId'] || entries['cursorAuth/cachedUserId']);
                const email = normalizeEmail(entries['cursorAuth/cachedEmail'] || entries['cursorAuth/email']);
                if (!accessToken || tokenDigest(accessToken) !== identity.accessTokenHash ||
                    !userId || userId !== identity.userId ||
                    (identity.email && email !== identity.email)) {
                    throw storeError('TARGET_IDENTITY_VERIFY_FAILED', `写入后 ${storeName} 目标身份/token 校验失败`, {
                        operation: 'verify-target-identity',
                        store: storeName
                    });
                }
            }
        }
        const digest = nonAuthDigest(storage.value);
        if (options.checkNonAuth !== false && expectedNonAuthDigest && digest !== expectedNonAuthDigest) {
            throw storeError('NON_AUTH_DATA_CHANGED', 'storage.json 非鉴权键摘要发生变化', {
                operation: 'verify-non-auth',
                expectedDigest: expectedNonAuthDigest,
                actualDigest: digest
            });
        }
        return {
            databaseAuth,
            jsonAuth,
            nonAuthDigest: digest
        };
    }

    async _rollback(paths, journal) {
        const databaseAuth = await this._sqliteRead(paths.db);
        const storage = await this._readStorage(paths);
        await this._assertNoUnknownAuthKeys(paths, storage.value);
        const jsonAuth = extractAuthEntries(storage.value);
        const databaseIsBefore = exactMismatches(
            journal.before.sqliteAuth,
            databaseAuth
        ).length === 0;
        const databaseIsTarget = exactMismatches(
            journal.target.sqliteAuth,
            databaseAuth
        ).length === 0;
        const jsonIsBefore = exactMismatches(
            journal.before.jsonAuth,
            jsonAuth
        ).length === 0;
        const jsonIsTarget = exactMismatches(
            journal.target.jsonAuth,
            jsonAuth
        ).length === 0;
        if ((!databaseIsBefore && !databaseIsTarget) ||
            (!jsonIsBefore && !jsonIsTarget)) {
            throw storeError('RECOVERY_CONFLICT', '当前鉴权状态不属于该事务，拒绝覆盖外部登录更新', {
                operation: 'rollback',
                databaseState: databaseIsBefore ? 'before' : databaseIsTarget ? 'target' : 'unknown',
                jsonState: jsonIsBefore ? 'before' : jsonIsTarget ? 'target' : 'unknown',
                recoveryRequired: true
            });
        }
        let databaseRolledBack = false;
        if (!databaseIsBefore) {
            await this._sqliteReplace(
                paths.db,
                journal.before.sqliteAuth,
                journal.target.sqliteAuth
            );
            databaseRolledBack = true;
        }
        let expectedNonAuthDigest = nonAuthDigest(storage.value);
        if (!jsonIsBefore) {
            try {
                const restored = await this._writeStorageAuthWithRetry(
                    paths,
                    journal.before.jsonAuth,
                    'rollback-storage-json',
                    { expectedAuth: journal.target.jsonAuth }
                );
                expectedNonAuthDigest = restored.nonAuthDigest;
            }
            catch (error) {
                if (databaseRolledBack) {
                    try {
                        await this._sqliteReplace(
                            paths.db,
                            journal.target.sqliteAuth,
                            journal.before.sqliteAuth
                        );
                    }
                    catch (compensationError) {
                        throw storeError('RECOVERY_COMPENSATION_FAILED', 'JSON 回滚冲突且 SQLite 补偿失败', {
                            operation: 'rollback-compensation',
                            recoveryRequired: true,
                            originalCode: error && error.code,
                            compensationCode: compensationError && compensationError.code
                        }, compensationError);
                    }
                }
                throw error;
            }
        }
        const restoredTarget = {
            sqliteAuth: journal.before.sqliteAuth,
            jsonAuth: journal.before.jsonAuth,
            identity: identityForEntries(journal.before.sqliteAuth, false)
        };
        await this._verifyTarget(
            paths,
            restoredTarget,
            expectedNonAuthDigest
        );
    }

    async _executeTransaction(paths, target, metadata = {}) {
        paths = await this._validatedPaths();
        const operationId = crypto.randomBytes(18).toString('hex');
        const storage = await this._readStorage(paths);
        const before = {
            sqliteAuth: await this._sqliteRead(paths.db),
            jsonAuth: extractAuthEntries(storage.value),
            nonAuthDigest: nonAuthDigest(storage.value),
            storageText: storage.text
        };
        const backup = await this._createBackup(paths, before, {
            operationId,
            kind: metadata.kind
        });
        let journal = {
            version: JOURNAL_VERSION,
            authSchemaVersion: AUTH_SCHEMA_VERSION,
            operationId,
            kind: metadata.kind || 'switch',
            sourceBackup: metadata.sourceBackup || '',
            state: 'prepared',
            createdAt: this._isoNow(),
            updatedAt: this._isoNow(),
            backupName: backup.backupName,
            before: {
                sqliteAuth: before.sqliteAuth,
                jsonAuth: before.jsonAuth,
                nonAuthDigest: before.nonAuthDigest
            },
            target: {
                sqliteAuth: normalizedDatabaseEntries(target.sqliteAuth),
                jsonAuth: extractAuthEntries(target.jsonAuth),
                identity: target.identity
            }
        };
        let journalPersisted = false;
        try {
            journal = await this._writeJournal(paths, journal, 'prepared');
            journalPersisted = true;
            await this._phase('prepared', journal);

            await this._sqliteReplace(
                paths.db,
                journal.target.sqliteAuth,
                journal.before.sqliteAuth
            );
            journal = await this._writeJournal(paths, journal, 'sqlite-written');
            await this._phase('sqlite-written', journal);

            const storageWrite = await this._writeStorageAuthWithRetry(
                paths,
                journal.target.jsonAuth,
                'write-target-storage-json',
                { expectedAuth: journal.before.jsonAuth }
            );
            journal = await this._writeJournal(paths, journal, 'json-written');
            await this._phase('json-written', journal);

            await this._verifyTarget(
                paths,
                journal.target,
                storageWrite.nonAuthDigest
            );
            journal = await this._writeJournal(paths, journal, 'verified');
            await this._phase('verified', journal);

            journal = await this._writeJournal(paths, journal, 'committed');
            await this._phase('committed', journal);
            try {
                await this._deleteJournal(paths);
            }
            catch {
                return {
                    ok: true,
                    operationId,
                    backupName: backup.backupName,
                    recoveryPending: true
                };
            }
            return {
                ok: true,
                operationId,
                backupName: backup.backupName,
                recoveryPending: false
            };
        }
        catch (error) {
            if (!journalPersisted) {
                throw storeError('SWITCH_PREPARE_FAILED', '无法持久化切号 journal；未修改登录态', {
                    operation: metadata.kind || 'switch',
                    backupName: backup.backupName
                }, error);
            }
            if (journal.state === 'prepared' &&
                errorChainHasCode(error, 'REVISION_CONFLICT')) {
                try {
                    journal = await this._writeJournal(paths, journal, 'aborted');
                    await this._removeBackupDirectory(paths.backupRoot, journal.backupName);
                    await this._deleteJournal(paths);
                }
                catch (cleanupError) {
                    throw storeError('SWITCH_ABORTED_CLEANUP_PENDING', '并发登录更新未被覆盖，但清理中止事务失败', {
                        operation: metadata.kind || 'switch',
                        recoveryRequired: true,
                        journalState: journal.state
                    }, cleanupError);
                }
                throw storeError('CONCURRENT_AUTH_UPDATE', 'SQLite 鉴权状态已变化，未写入并已安全中止', {
                    operation: metadata.kind || 'switch',
                    retryable: true
                }, error);
            }
            if (error && error.simulateCrash === true) {
                throw storeError('SWITCH_INTERRUPTED', '模拟中断：journal 已保留，需 recover()', {
                    operation: metadata.kind || 'switch',
                    recoveryRequired: true,
                    journalState: journal.state
                }, error);
            }
            if (journal.state === 'committed') {
                throw storeError('SWITCH_COMMITTED_RECOVERY_PENDING', '切号已提交，但清理 journal 失败；下次 recover() 将完成清理', {
                    operation: metadata.kind || 'switch',
                    recoveryRequired: true,
                    journalState: journal.state
                }, error);
            }
            try {
                journal = await this._writeJournal(paths, journal, 'rollback-needed');
            }
            catch { }
            try {
                await this._rollback(paths, journal);
                try {
                    journal = await this._writeJournal(paths, journal, 'rolled-back');
                    await this._deleteJournal(paths);
                }
                catch { }
            }
            catch (rollbackError) {
                throw storeError('SWITCH_FAILED_RECOVERY_REQUIRED', '切号失败且即时回滚未完成；journal 已保留，请调用 recover()', {
                    operation: metadata.kind || 'switch',
                    recoveryRequired: true,
                    journalState: journal.state,
                    originalCode: error && error.code,
                    rollbackCode: rollbackError && rollbackError.code
                }, rollbackError);
            }
            throw storeError('SWITCH_FAILED_ROLLED_BACK', '切号失败，原鉴权快照已回滚', {
                operation: metadata.kind || 'switch',
                rolledBack: true,
                originalCode: error && error.code
            }, error);
        }
    }

    async _recoverUnlocked(paths) {
        paths = await this._validatedPaths();
        const journal = await this._readJournal(paths);
        if (!journal)
            return { ok: true, recovered: false };
        if (journal.state === 'committed' || journal.state === 'aborted') {
            try {
                if (journal.state === 'aborted')
                    await this._removeBackupDirectory(paths.backupRoot, journal.backupName);
                else
                    await this._cleanupBackups(paths, journal.backupName);
                await this._deleteJournal(paths);
                return {
                    ok: true,
                    recovered: true,
                    action: journal.state === 'aborted'
                        ? 'finalized-abort'
                        : 'finalized-commit',
                    operationId: journal.operationId
                };
            }
            catch (error) {
                throw storeError(
                    'COMMITTED_CLEANUP_FAILED',
                    '切号已提交；清理恢复标记失败，但不会回滚已提交或后续更新的凭据',
                    {
                        operation: 'recover-committed',
                        recoveryRequired: true,
                        journalState: journal.state
                    },
                    error
                );
            }
        }
        try {
            const recovering = await this._writeJournal(paths, journal, 'rollback-needed');
            await this._rollback(paths, recovering);
            const rolledBack = await this._writeJournal(paths, recovering, 'rolled-back');
            await this._deleteJournal(paths);
            await this._cleanupBackups(paths, rolledBack.backupName);
            return {
                ok: true,
                recovered: true,
                action: 'rolled-back',
                operationId: journal.operationId
            };
        }
        catch (error) {
            throw storeError('RECOVERY_FAILED', 'journal 恢复失败，未删除恢复依据', {
                operation: 'recover',
                recoveryRequired: true,
                journalState: journal.state
            }, error);
        }
    }

    async switchAccount(target) {
        return this._withOperationLock('switch-account', async paths => {
            await this._recoverUnlocked(paths);
            paths = await this._validatedPaths();
            const storage = await this._readStorage(paths);
            await this._assertNoUnknownAuthKeys(paths, storage.value);
            const timestamp = this._isoNow();
            const entries = buildAuthEntries(target, { timestamp });
            const identity = identityForEntries(entries, true);
            return this._executeTransaction(paths, {
                sqliteAuth: entries,
                jsonAuth: entries,
                identity
            }, { kind: 'switch' });
        });
    }

    async recover() {
        return this._withOperationLock('recover', paths => this._recoverUnlocked(paths));
    }

    async _readBackup(paths, backup) {
        const directory = await assertSafeDirectory(backup.path, {
            root: paths.backupRoot
        });
        const manifestPath = path.join(directory.path, 'manifest.json');
        const manifestRead = await this._readJsonFile(
            manifestPath,
            directory.path,
            'read-backup-manifest'
        );
        const manifest = manifestRead.value;
        if (manifest.version !== BACKUP_MANIFEST_VERSION ||
            manifest.authSchemaVersion !== AUTH_SCHEMA_VERSION ||
            !manifest.files ||
            manifest.files.database !== this.dbFileName ||
            manifest.files.storage !== this.storageFileName) {
            throw storeError('BACKUP_MANIFEST_INVALID', '备份 manifest 格式或版本无效', {
                operation: 'read-backup',
                backupName: backup.name
            });
        }
        const dbPath = path.join(directory.path, manifest.files.database);
        const storagePath = path.join(directory.path, manifest.files.storage);
        await assertSafeRegularFile(dbPath, { root: directory.path });
        await assertSafeRegularFile(storagePath, { root: directory.path });
        await this._sqliteQuickCheck(dbPath);
        const sqliteAuth = await this._sqliteRead(dbPath);
        const storage = await this._readJsonFile(
            storagePath,
            directory.path,
            'read-backup-storage'
        );
        return {
            manifest,
            sqliteAuth,
            jsonAuth: extractAuthEntries(storage.value)
        };
    }

    async restoreLatest(options = {}) {
        return this._withOperationLock('restore-latest', async paths => {
            await this._recoverUnlocked(paths);
            paths = await this._validatedPaths();
            const currentStorage = await this._readStorage(paths);
            await this._assertNoUnknownAuthKeys(paths, currentStorage.value);
            const backups = await this._backupDirectories(paths);
            const requested = typeof options === 'string' ? options : options.backupName;
            const candidates = requested
                ? backups.filter(entry => entry.name === requested)
                : backups;
            if (!candidates.length) {
                throw storeError('BACKUP_NOT_FOUND', requested ? '指定备份不存在' : '没有可恢复的备份', {
                    operation: 'restore-latest',
                    backupName: requested || ''
                });
            }
            let selected;
            let snapshot;
            let lastError;
            for (const candidate of candidates) {
                try {
                    snapshot = await this._readBackup(paths, candidate);
                    selected = candidate;
                    break;
                }
                catch (error) {
                    lastError = error;
                    if (requested)
                        break;
                }
            }
            if (!snapshot) {
                throw storeError('NO_VALID_BACKUP', '没有通过校验的可恢复备份', {
                    operation: 'restore-latest',
                    backupName: requested || ''
                }, lastError);
            }
            const result = await this._executeTransaction(paths, {
                sqliteAuth: snapshot.sqliteAuth,
                jsonAuth: snapshot.jsonAuth,
                identity: identityForEntries(snapshot.sqliteAuth, false)
            }, {
                kind: 'restore',
                sourceBackup: selected.name
            });
            return {
                ...result,
                restoredFrom: selected.name
            };
        });
    }

    async listBackups() {
        return this._withOperationLock('list-backups', async paths => {
            const backups = await this._backupDirectories(paths);
            return backups.map(entry => ({
                name: entry.name,
                mtimeMs: entry.mtimeMs
            }));
        });
    }
}

function createCursorStateStore(options) {
    return new CursorStateStore(options);
}

module.exports = {
    AUTH_SCHEMA_VERSION,
    AUTH_KEYS_BY_VERSION,
    AUTH_KEYS,
    CursorStateStore,
    CursorStateStoreError,
    createCursorStateStore,
    buildAuthEntries,
    extractAuthEntries,
    replaceAuthEntries,
    nonAuthDigest
};
