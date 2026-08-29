"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    atomicWriteJson,
    durableUnlink,
    readFileSnapshot
} = require("./atomicFile");

const ACCOUNT_STORAGE_SCHEMA = 2;
const ACCOUNT_SECRET_SCHEMA = 1;
const ACCOUNT_METADATA_KEY = "cursorAccountManager.accounts.v2";
const PRIMARY_PLAINTEXT_ACCOUNT_KEY = "cursorAccountManager.accounts";
const LEGACY_ACCOUNT_METADATA_KEY = "keepchat.accounts";
const ACCOUNT_SECRET_PREFIX = "cursorAccountManager.account.";
const ACCOUNT_SECRET_SLOTS = Object.freeze(["a", "b"]);
const MANUAL_TOKEN_SCHEMA = 1;
const MANUAL_TOKEN_SECRET_KEY = "cursorAccountManager.manualCursorToken.v1";
const PENDING_SECRET_DELETES_KEY = "cursorAccountManager.pendingSecretDeletes.v1";
const REPOSITORY_LOCK_NAME = ".cursor-account-manager-accounts.lock";
const REPOSITORY_METADATA_NAME = "account-metadata-v2.json";
const REPOSITORY_CLEANUP_NAME = "pending-secret-deletes-v1.json";
const LIST_REVISION = Symbol("accountRepositoryRevision");
const RELEASED_REPOSITORY_LOCKS = new Set();
const LOCAL_REPOSITORY_OPERATIONS = new Map();
const fsp = fs.promises;

const CREDENTIAL_STATUS_AVAILABLE = "available";
const CREDENTIAL_STATUS_MISSING = "missing";
const MAX_ACCOUNT_ID_LENGTH = 256;
const MAX_SECRET_BYTES = 4 * 1024 * 1024;

const RESERVED_METADATA_FIELDS = new Set([
    "credentialRef",
    "credentialSlot",
    "credentialStatus"
]);

const EXACT_SENSITIVE_FIELDS = new Set([
    "access_token",
    "accesstoken",
    "authorization",
    "authblob",
    "clientsecret",
    "cookie",
    "password",
    "raw",
    "rawsession",
    "refresh_token",
    "refreshtoken",
    "session",
    "sessiontoken",
    "secret",
    "token"
]);

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class AccountRepositoryError extends Error {
    constructor(code, message, cause) {
        super(message);
        this.name = "AccountRepositoryError";
        this.code = code;
        if (cause !== undefined)
            this.cause = cause;
    }
}

function fail(code, message, cause) {
    return new AccountRepositoryError(code, message, cause);
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, label = "value", seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw fail("ERR_INVALID_VALUE", `${label} contains a non-finite number`);
        return value;
    }
    if (value === undefined)
        return undefined;
    if (typeof value !== "object")
        throw fail("ERR_INVALID_VALUE", `${label} is not JSON-compatible`);
    if (seen.has(value))
        throw fail("ERR_INVALID_VALUE", `${label} contains a circular or repeated object reference`);
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item, index) => {
                const cloned = cloneJson(item, `${label}[${index}]`, seen);
                return cloned === undefined ? null : cloned;
            });
        }
        if (!isPlainObject(value))
            throw fail("ERR_INVALID_VALUE", `${label} must contain only plain objects`);
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            if (UNSAFE_OBJECT_KEYS.has(key))
                throw fail("ERR_INVALID_VALUE", `${label} contains an unsafe object key`);
            const cloned = cloneJson(item, `${label}.${key}`, seen);
            if (cloned !== undefined)
                result[key] = cloned;
        }
        return result;
    }
    finally {
        seen.delete(value);
    }
}

function isSensitiveField(key) {
    const normalized = String(key).replace(/[\s.-]/g, "_").toLowerCase();
    if (EXACT_SENSITIVE_FIELDS.has(normalized))
        return true;
    if (/token$/i.test(normalized))
        return true;
    if (/(?:cookie|secret|password)$/i.test(normalized))
        return true;
    return /(?:^|_)auth_?blob$/i.test(normalized);
}

function splitAccount(account) {
    if (!isPlainObject(account))
        throw fail("ERR_INVALID_ACCOUNT", "each account must be a plain object");

    const credentialEntries = [];

    function visit(node, path, root) {
        if (node === null || typeof node !== "object")
            return cloneJson(node, path.length ? path.join(".") : "account");
        if (Array.isArray(node)) {
            return node.map((item, index) => {
                const cloned = visit(item, path.concat(index), false);
                return cloned === undefined ? null : cloned;
            });
        }
        if (!isPlainObject(node))
            throw fail("ERR_INVALID_ACCOUNT", "account fields must be JSON-compatible");

        const metadata = {};
        for (const [key, value] of Object.entries(node)) {
            if (UNSAFE_OBJECT_KEYS.has(key))
                throw fail("ERR_INVALID_ACCOUNT", "account contains an unsafe object key");
            if (root && RESERVED_METADATA_FIELDS.has(key))
                continue;
            if (isSensitiveField(key)) {
                if (value !== undefined) {
                    credentialEntries.push({
                        path: path.concat(key),
                        value: cloneJson(value, `account.${path.concat(key).join(".")}`)
                    });
                }
                continue;
            }
            const cloned = visit(value, path.concat(key), false);
            if (cloned !== undefined)
                metadata[key] = cloned;
        }
        return metadata;
    }

    const metadata = visit(account, [], true);
    return { metadata, credentialEntries };
}

function assertNoSensitiveMetadata(node, path = "metadata") {
    if (node === null || typeof node !== "object")
        return;
    if (Array.isArray(node)) {
        node.forEach((item, index) => assertNoSensitiveMetadata(item, `${path}[${index}]`));
        return;
    }
    for (const [key, value] of Object.entries(node)) {
        if (isSensitiveField(key))
            throw fail("ERR_PLAINTEXT_METADATA", `${path}.${key} must not be stored in globalState`);
        assertNoSensitiveMetadata(value, `${path}.${key}`);
    }
}

function validateAccountId(value) {
    if (typeof value !== "string" || !value.trim())
        throw fail("ERR_INVALID_ACCOUNT_ID", "account id must be a non-empty string");
    if (Buffer.byteLength(value, "utf8") > MAX_ACCOUNT_ID_LENGTH)
        throw fail("ERR_INVALID_ACCOUNT_ID", "account id is too long");
    return value;
}

function validateSlot(slot) {
    if (!ACCOUNT_SECRET_SLOTS.includes(slot))
        throw fail("ERR_INVALID_SECRET_REF", "credential slot must be 'a' or 'b'");
    return slot;
}

function accountSecretKey(accountId, slot) {
    validateAccountId(accountId);
    validateSlot(slot);
    return `${ACCOUNT_SECRET_PREFIX}${encodeURIComponent(accountId)}.credential.${slot}`;
}

function oppositeSlot(slot) {
    return slot === "a" ? "b" : "a";
}

function credentialRefOf(record) {
    if (!record || record.credentialSlot === undefined)
        return null;
    return {
        slot: validateSlot(record.credentialSlot)
    };
}

function canonicalJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function envelopesEqual(left, right) {
    try {
        return canonicalJson(left) === canonicalJson(right);
    }
    catch {
        return false;
    }
}

function validateEnvelope(raw) {
    if (!isPlainObject(raw) || raw.schemaVersion !== ACCOUNT_STORAGE_SCHEMA || !Array.isArray(raw.accounts))
        throw fail("ERR_INVALID_METADATA", "account metadata has an unsupported format");
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 0)
        throw fail("ERR_INVALID_METADATA", "account metadata revision is invalid");

    const seenIds = new Set();
    const accounts = raw.accounts.map((item, index) => {
        if (!isPlainObject(item))
            throw fail("ERR_INVALID_METADATA", `metadata account ${index} is invalid`);
        const record = cloneJson(item, `metadata.accounts[${index}]`);
        const id = validateAccountId(record.id);
        if (seenIds.has(id))
            throw fail("ERR_DUPLICATE_ACCOUNT_ID", `duplicate account id: ${id}`);
        seenIds.add(id);
        credentialRefOf(record);
        assertNoSensitiveMetadata(record);
        return record;
    });

    return {
        schemaVersion: ACCOUNT_STORAGE_SCHEMA,
        revision: raw.revision,
        accounts
    };
}

function validatePendingSecretDeletes(raw) {
    if (raw === undefined || raw === null)
        return [];
    if (!isPlainObject(raw) ||
        raw.schemaVersion !== 1 ||
        !Array.isArray(raw.keys) ||
        raw.keys.length > 10000) {
        throw fail("ERR_INVALID_CLEANUP_STATE", "pending credential cleanup metadata is invalid");
    }
    const keys = raw.keys.map(key => {
        if (typeof key !== "string" ||
            key.length === 0 ||
            key.length > 2048 ||
            !key.startsWith(ACCOUNT_SECRET_PREFIX) ||
            !/\.credential\.[ab]$/.test(key) ||
            /[\0\r\n]/.test(key)) {
            throw fail("ERR_INVALID_CLEANUP_STATE", "pending credential cleanup key is invalid");
        }
        return key;
    });
    if (new Set(keys).size !== keys.length)
        throw fail("ERR_INVALID_CLEANUP_STATE", "pending credential cleanup keys are duplicated");
    return keys;
}

function serializeCredential(accountId, entries) {
    const payload = {
        schemaVersion: ACCOUNT_SECRET_SCHEMA,
        accountId,
        credentials: entries
    };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SECRET_BYTES)
        throw fail("ERR_SECRET_TOO_LARGE", `credentials for account ${accountId} are too large`);
    return serialized;
}

function parseCredential(serialized, expectedAccountId) {
    if (typeof serialized !== "string")
        throw fail("ERR_INVALID_SECRET", `credentials for account ${expectedAccountId} are not a string`);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SECRET_BYTES)
        throw fail("ERR_SECRET_TOO_LARGE", `credentials for account ${expectedAccountId} are too large`);

    let payload;
    try {
        payload = JSON.parse(serialized);
    }
    catch (error) {
        throw fail("ERR_INVALID_SECRET", `credentials for account ${expectedAccountId} are not valid JSON`, error);
    }
    if (!isPlainObject(payload) ||
        payload.schemaVersion !== ACCOUNT_SECRET_SCHEMA ||
        payload.accountId !== expectedAccountId ||
        !Array.isArray(payload.credentials)) {
        throw fail("ERR_INVALID_SECRET", `credentials for account ${expectedAccountId} have an invalid schema`);
    }

    return payload.credentials.map((entry, index) => {
        if (!isPlainObject(entry) || !Array.isArray(entry.path) || entry.path.length === 0 || entry.path.length > 64)
            throw fail("ERR_INVALID_SECRET", `credential entry ${index} for account ${expectedAccountId} is invalid`);
        const path = entry.path.map(part => {
            if ((typeof part !== "string" && !Number.isSafeInteger(part)) ||
                (typeof part === "string" && UNSAFE_OBJECT_KEYS.has(part))) {
                throw fail("ERR_INVALID_SECRET", `credential path for account ${expectedAccountId} is invalid`);
            }
            return part;
        });
        const leaf = path[path.length - 1];
        if (typeof leaf !== "string" || !isSensitiveField(leaf))
            throw fail("ERR_INVALID_SECRET", `credential path for account ${expectedAccountId} is not sensitive`);
        return {
            path,
            value: cloneJson(entry.value, `credential ${expectedAccountId}[${index}]`)
        };
    });
}

function applyCredentialEntries(metadata, entries) {
    const hydrated = cloneJson(metadata, "metadata");
    for (const entry of entries) {
        let target = hydrated;
        for (let index = 0; index < entry.path.length - 1; index++) {
            const part = entry.path[index];
            const nextPart = entry.path[index + 1];
            if (typeof part === "number") {
                if (!Array.isArray(target) || part < 0 || part > target.length)
                    throw fail("ERR_INVALID_SECRET", "credential path does not match account metadata");
                if (target[part] === null || typeof target[part] !== "object")
                    target[part] = typeof nextPart === "number" ? [] : {};
                target = target[part];
            }
            else {
                if (!isPlainObject(target) && !Array.isArray(target))
                    throw fail("ERR_INVALID_SECRET", "credential path does not match account metadata");
                if (target[part] === null || typeof target[part] !== "object")
                    target[part] = typeof nextPart === "number" ? [] : {};
                target = target[part];
            }
        }
        const leaf = entry.path[entry.path.length - 1];
        if (typeof leaf === "number") {
            if (!Array.isArray(target) || leaf < 0 || leaf > target.length)
                throw fail("ERR_INVALID_SECRET", "credential path does not match account metadata");
            target[leaf] = cloneJson(entry.value, "credential value");
        }
        else {
            target[leaf] = cloneJson(entry.value, "credential value");
        }
    }
    return hydrated;
}

function combineErrors(message, errors) {
    const realErrors = errors.filter(Boolean);
    if (realErrors.length === 1)
        return realErrors[0];
    const combined = new AggregateError(realErrors, message);
    combined.code = "ERR_MULTIPLE_STORAGE_FAILURES";
    return combined;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function processStartToken(pid) {
    try {
        if (process.platform === "linux") {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
            const close = stat.lastIndexOf(")");
            if (close < 0)
                return null;
            return stat.slice(close + 2).trim().split(/\s+/)[19] || null;
        }
        if (process.platform === "darwin" || process.platform === "freebsd") {
            const output = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
                encoding: "utf8",
                env: { ...process.env, LC_ALL: "C" },
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 2000,
                windowsHide: true
            }).trim();
            return output ? `${process.platform}:${output}` : null;
        }
        if (process.platform === "win32") {
            const powershell = path.join(
                process.env.SystemRoot || "C:\\Windows",
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe"
            );
            const output = execFileSync(powershell, [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[System.Diagnostics.Process]::GetProcessById([int]$args[0]).StartTime.ToUniversalTime().Ticks",
                String(pid)
            ], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
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

function pidIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return !!(error && error.code === "EPERM");
    }
}

function accountListClone(accounts, revision) {
    const result = cloneJson(accounts, "accounts");
    Object.defineProperty(result, LIST_REVISION, {
        configurable: false,
        enumerable: false,
        value: revision,
        writable: false
    });
    return result;
}

class AccountRepository {
    constructor(context) {
        if (!context || !context.globalState || !context.secrets)
            throw fail("ERR_INVALID_CONTEXT", "AccountRepository requires context.globalState and context.secrets");
        if (typeof context.globalState.get !== "function" || typeof context.globalState.update !== "function")
            throw fail("ERR_INVALID_CONTEXT", "globalState must implement get() and update()");
        if (typeof context.secrets.get !== "function" ||
            typeof context.secrets.store !== "function" ||
            typeof context.secrets.delete !== "function") {
            throw fail("ERR_INVALID_CONTEXT", "secrets must implement get(), store(), and delete()");
        }

        this.globalState = context.globalState;
        this.secrets = context.secrets;
        this._initialized = false;
        this._initializing = null;
        this._cache = [];
        this._envelope = {
            schemaVersion: ACCOUNT_STORAGE_SCHEMA,
            revision: 0,
            accounts: []
        };
        this._saveTail = Promise.resolve();
        this._manualTail = Promise.resolve();
        this._lockRoot = context.globalStorageUri &&
            typeof context.globalStorageUri.fsPath === "string"
            ? path.resolve(context.globalStorageUri.fsPath)
            : null;
        this._lockTimeoutMs = 10000;
    }

    async _readRepositoryJson(fileName) {
        if (!this._lockRoot)
            return undefined;
        const filePath = path.join(this._lockRoot, fileName);
        let snapshot;
        try {
            snapshot = await readFileSnapshot(filePath);
        }
        catch (error) {
            if (error && error.code === "ENOENT")
                return undefined;
            throw fail("ERR_REPOSITORY_STATE_READ", `failed to read ${fileName}`, error);
        }
        if (snapshot.size <= 0 || snapshot.size > 16 * 1024 * 1024)
            throw fail("ERR_REPOSITORY_STATE_INVALID", `${fileName} has an invalid size`);
        try {
            return JSON.parse(snapshot.data.toString("utf8"));
        }
        catch (error) {
            throw fail("ERR_REPOSITORY_STATE_INVALID", `${fileName} is not valid JSON`, error);
        }
    }

    async _writeRepositoryJson(fileName, value) {
        if (!this._lockRoot)
            return;
        const filePath = path.join(this._lockRoot, fileName);
        await atomicWriteJson(filePath, value, {
            root: this._lockRoot,
            mode: 0o600
        });
    }

    async _readAuthoritativeEnvelope() {
        const value = await this._readRepositoryJson(REPOSITORY_METADATA_NAME);
        return value === undefined ? undefined : validateEnvelope(value);
    }

    async _writeAuthoritativeEnvelope(envelope) {
        if (!this._lockRoot)
            return;
        const validated = validateEnvelope(envelope);
        await this._writeRepositoryJson(REPOSITORY_METADATA_NAME, validated);
        const observed = await this._readAuthoritativeEnvelope();
        if (!envelopesEqual(observed, validated))
            throw fail("ERR_METADATA_VERIFY", "authoritative account metadata did not verify after update");
    }

    async _readAuthoritativePendingDeletes() {
        const value = await this._readRepositoryJson(REPOSITORY_CLEANUP_NAME);
        return value === undefined ? undefined : validatePendingSecretDeletes(value);
    }

    async _writeAuthoritativePendingDeletes(keys) {
        if (!this._lockRoot)
            return;
        const unique = [...new Set(keys)].sort();
        const filePath = path.join(this._lockRoot, REPOSITORY_CLEANUP_NAME);
        if (!unique.length) {
            await durableUnlink(filePath, {
                root: this._lockRoot
            });
            return;
        }
        await this._writeRepositoryJson(REPOSITORY_CLEANUP_NAME, {
            schemaVersion: 1,
            keys: unique
        });
        const observed = await this._readAuthoritativePendingDeletes();
        if (canonicalJson(observed) !== canonicalJson(unique))
            throw fail("ERR_CLEANUP_STATE_COMMIT", "authoritative cleanup metadata did not verify");
    }

    async _readRepositoryLock(lockPath) {
        let stat;
        try {
            stat = await fsp.lstat(lockPath);
        }
        catch (error) {
            if (error && error.code === "ENOENT")
                return { exists: false };
            throw error;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw fail("ERR_UNSAFE_REPOSITORY_LOCK", "account repository lock path is unsafe");
        const ownerPath = path.join(lockPath, "owner.json");
        let owner = null;
        try {
            const ownerStat = await fsp.lstat(ownerPath);
            if (!ownerStat.isSymbolicLink() && ownerStat.isFile() && ownerStat.nlink === 1 &&
                ownerStat.size > 0 && ownerStat.size <= 16 * 1024) {
                owner = JSON.parse(await fsp.readFile(ownerPath, "utf8"));
            }
        }
        catch {
            // A newly-created or interrupted lock is classified by age.
        }
        let released = false;
        if (owner && typeof owner.nonce === "string") {
            try {
                const releasePath = path.join(lockPath, "released.json");
                const releaseStat = await fsp.lstat(releasePath);
                if (!releaseStat.isSymbolicLink() &&
                    releaseStat.isFile() &&
                    releaseStat.nlink === 1 &&
                    releaseStat.size > 0 &&
                    releaseStat.size <= 16 * 1024) {
                    const release = JSON.parse(await fsp.readFile(releasePath, "utf8"));
                    released = release &&
                        release.schemaVersion === 1 &&
                        release.nonce === owner.nonce;
                }
            }
            catch {
                // Missing or malformed release intent is not trusted.
            }
        }
        const age = Date.now() - stat.mtimeMs;
        let stale = age > 30000;
        if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
            if (released || RELEASED_REPOSITORY_LOCKS.has(owner.nonce)) {
                stale = true;
            }
            else if (owner.hostname && owner.hostname !== os.hostname()) {
                stale = false;
            }
            else if (!pidIsAlive(owner.pid)) {
                stale = true;
            }
            else {
                const currentStart = processStartToken(owner.pid);
                if (owner.processStart && currentStart)
                    stale = owner.processStart !== currentStart;
                else
                    stale = false;
            }
        }
        return {
            exists: true,
            stat,
            owner,
            released,
            stale
        };
    }

    async _createRepositoryLock(lockPath, kind = "operation") {
        const nonce = crypto.randomBytes(18).toString("hex");
        let created = false;
        try {
            await fsp.mkdir(lockPath, { mode: 0o700 });
            created = true;
            await fsp.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
                schemaVersion: 1,
                kind,
                pid: process.pid,
                processStart: processStartToken(process.pid),
                hostname: os.hostname(),
                nonce,
                createdAt: new Date().toISOString()
            }) + "\n", {
                flag: "wx",
                mode: 0o600
            });
            const stat = await fsp.lstat(lockPath);
            const heartbeat = setInterval(() => {
                const now = new Date();
                fsp.utimes(lockPath, now, now).catch(() => {
                    // A failed heartbeat lets the lease expire.
                });
            }, 10000);
            heartbeat.unref?.();
            return { lockPath, nonce, dev: stat.dev, ino: stat.ino, heartbeat };
        }
        catch (error) {
            if (created) {
                try {
                    await fsp.rm(lockPath, { recursive: true, force: true });
                }
                catch { }
            }
            throw error;
        }
    }

    async _releaseOwnedRepositoryLock(lock) {
        if (!lock)
            return false;
        const stat = await fsp.lstat(lock.lockPath);
        if (stat.dev !== lock.dev || stat.ino !== lock.ino)
            return false;
        const owner = JSON.parse(await fsp.readFile(path.join(lock.lockPath, "owner.json"), "utf8"));
        if (owner.nonce !== lock.nonce)
            return false;
        const released = `${lock.lockPath}.released-${crypto.randomBytes(12).toString("hex")}`;
        await fsp.rename(lock.lockPath, released);
        await fsp.rm(released, { recursive: true, force: false });
        return true;
    }

    async _persistRepositoryReleaseIntent(lock) {
        const stat = await fsp.lstat(lock.lockPath);
        if (stat.dev !== lock.dev || stat.ino !== lock.ino)
            throw fail("ERR_REPOSITORY_LOCK_RELEASE", "repository lock ownership changed before release intent");
        const owner = JSON.parse(await fsp.readFile(path.join(lock.lockPath, "owner.json"), "utf8"));
        if (owner.nonce !== lock.nonce)
            throw fail("ERR_REPOSITORY_LOCK_RELEASE", "repository lock nonce changed before release intent");
        const releasePath = path.join(lock.lockPath, "released.json");
        let handle;
        try {
            handle = await fsp.open(releasePath, "wx", 0o600);
            await handle.writeFile(JSON.stringify({
                schemaVersion: 1,
                nonce: lock.nonce,
                releasedAt: new Date().toISOString()
            }) + "\n", "utf8");
            await handle.sync();
        }
        catch (error) {
            if (!error || error.code !== "EEXIST")
                throw error;
            const observed = JSON.parse(await fsp.readFile(releasePath, "utf8"));
            if (!observed || observed.nonce !== lock.nonce)
                throw error;
        }
        finally {
            if (handle)
                await handle.close();
        }
    }

    async _takeOverStaleRepositoryLock(lockPath, observed) {
        const takeoverPath = `${lockPath}.takeover`;
        let takeover;
        let acquired;
        try {
            takeover = await this._createRepositoryLock(takeoverPath, "takeover");
        }
        catch (error) {
            if (error && ["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code))
                return null;
            throw error;
        }
        try {
            const current = await this._readRepositoryLock(lockPath);
            if (!current.exists ||
                !current.stale ||
                current.stat.dev !== observed.stat.dev ||
                current.stat.ino !== observed.stat.ino) {
                return null;
            }
            const stalePath = `${lockPath}.stale-${crypto.randomBytes(12).toString("hex")}`;
            await fsp.rename(lockPath, stalePath);
            const moved = await fsp.lstat(stalePath);
            if (moved.dev !== observed.stat.dev || moved.ino !== observed.stat.ino) {
                try {
                    await fsp.rename(stalePath, lockPath);
                }
                catch { }
                throw fail("ERR_REPOSITORY_LOCK_RACE", "account repository lock changed during takeover");
            }
            acquired = await this._createRepositoryLock(lockPath);
            await fsp.rm(stalePath, { recursive: true, force: false });
            return acquired;
        }
        catch (error) {
            await this._releaseRepositoryLock(acquired);
            throw error;
        }
        finally {
            await this._releaseRepositoryLock(takeover);
        }
    }

    async _recoverInterruptedTakeover(lockPath, observedTakeover) {
        const takeoverPath = `${lockPath}.takeover`;
        const staleMainPath = `${lockPath}.interrupted-main`;
        let movedMain = false;
        let recoveryLock = null;
        const existingQuarantine = await this._readRepositoryLock(staleMainPath);
        if (existingQuarantine.exists && !existingQuarantine.stale)
            return null;
        const existingMain = await this._readRepositoryLock(lockPath);
        if (existingQuarantine.exists && existingMain.exists) {
            if (!existingMain.stale)
                return null;
            const retiredQuarantine = `${staleMainPath}.retired-${crypto.randomBytes(12).toString("hex")}`;
            try {
                await fsp.rename(staleMainPath, retiredQuarantine);
                const moved = await fsp.lstat(retiredQuarantine);
                if (moved.dev !== existingQuarantine.stat.dev ||
                    moved.ino !== existingQuarantine.stat.ino) {
                    throw fail("ERR_REPOSITORY_LOCK_RACE", "interrupted-main quarantine changed during recovery");
                }
                await fsp.rm(retiredQuarantine, {
                    recursive: true,
                    force: false
                });
            }
            catch (error) {
                if (!error || error.code !== "ENOENT")
                    throw error;
            }
            return null;
        }
        if (!existingQuarantine.exists) {
            const main = existingMain;
            if (main.exists) {
                if (!main.stale)
                    return null;
                try {
                    await fsp.rename(lockPath, staleMainPath);
                }
                catch (error) {
                    if (error && ["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code))
                        return null;
                    throw error;
                }
                const moved = await fsp.lstat(staleMainPath);
                if (moved.dev !== main.stat.dev || moved.ino !== main.stat.ino)
                    throw fail("ERR_REPOSITORY_LOCK_RACE", "main lock changed during interrupted takeover recovery");
                movedMain = true;
            }
        }
        try {
            try {
                recoveryLock = await this._createRepositoryLock(lockPath, "takeover-recovery");
            }
            catch (error) {
                if (error && ["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code))
                    return null;
                throw error;
            }
            const currentTakeover = await this._readRepositoryLock(takeoverPath);
            if (!currentTakeover.exists ||
                !currentTakeover.stale ||
                currentTakeover.stat.dev !== observedTakeover.stat.dev ||
                currentTakeover.stat.ino !== observedTakeover.stat.ino) {
                throw fail("ERR_REPOSITORY_LOCK_RACE", "takeover marker changed during recovery");
            }
            const recoveredPath = `${takeoverPath}.recovered-${crypto.randomBytes(12).toString("hex")}`;
            await fsp.rename(takeoverPath, recoveredPath);
            const movedTakeover = await fsp.lstat(recoveredPath);
            if (movedTakeover.dev !== observedTakeover.stat.dev ||
                movedTakeover.ino !== observedTakeover.stat.ino) {
                throw fail("ERR_REPOSITORY_LOCK_RACE", "takeover marker identity changed during recovery");
            }
            await fsp.rm(recoveredPath, { recursive: true, force: false });
            const quarantine = await this._readRepositoryLock(staleMainPath);
            if (quarantine.exists)
                await fsp.rm(staleMainPath, { recursive: true, force: false });
            return recoveryLock;
        }
        catch (error) {
            await this._releaseRepositoryLock(recoveryLock);
            if (movedMain) {
                try {
                    await fsp.rename(staleMainPath, lockPath);
                }
                catch { }
            }
            throw error;
        }
    }

    async _acquireRepositoryLock() {
        if (!this._lockRoot)
            return null;
        await fsp.mkdir(this._lockRoot, { recursive: true, mode: 0o700 });
        const rootStat = await fsp.lstat(this._lockRoot);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
            throw fail("ERR_UNSAFE_REPOSITORY_LOCK", "account repository storage directory is unsafe");
        if (typeof process.getuid === "function" &&
            Number.isInteger(rootStat.uid) &&
            rootStat.uid !== process.getuid()) {
            throw fail("ERR_UNSAFE_REPOSITORY_LOCK", "account repository storage directory has an unexpected owner");
        }
        const lockPath = path.join(this._lockRoot, REPOSITORY_LOCK_NAME);
        const takeoverPath = `${lockPath}.takeover`;
        const deadline = Date.now() + this._lockTimeoutMs;
        for (;;) {
            const takeover = await this._readRepositoryLock(takeoverPath);
            if (takeover.exists) {
                if (takeover.stale) {
                    const recovered = await this._recoverInterruptedTakeover(
                        lockPath,
                        takeover
                    );
                    if (recovered)
                        return recovered;
                }
                if (Date.now() >= deadline)
                    throw fail("ERR_REPOSITORY_LOCKED", "another Cursor window is updating the account repository");
                await delay(25);
                continue;
            }
            try {
                return await this._createRepositoryLock(lockPath);
            }
            catch (error) {
                if (!error || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) {
                    throw fail("ERR_REPOSITORY_LOCK", "failed to acquire account repository lock", error);
                }
            }

            const observed = await this._readRepositoryLock(lockPath);
            if (!observed.exists)
                continue;
            if (observed.stale) {
                try {
                    const acquired = await this._takeOverStaleRepositoryLock(
                        lockPath,
                        observed
                    );
                    if (acquired)
                        return acquired;
                }
                catch (error) {
                    throw fail("ERR_REPOSITORY_LOCK", "failed to recover stale account repository lock", error);
                }
                continue;
            }
            if (Date.now() >= deadline)
                throw fail("ERR_REPOSITORY_LOCKED", "another Cursor window is updating the account repository");
            await delay(25);
        }
    }

    async _releaseRepositoryLock(lock) {
        if (!lock)
            return;
        if (lock.heartbeat)
            clearInterval(lock.heartbeat);
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await this._releaseOwnedRepositoryLock(lock);
                return;
            }
            catch {
                if (attempt + 1 < 5)
                    await delay(20 * (attempt + 1));
            }
        }
        RELEASED_REPOSITORY_LOCKS.add(lock.nonce);
        try {
            await this._persistRepositoryReleaseIntent(lock);
        }
        catch (error) {
            throw fail(
                "ERR_REPOSITORY_LOCK_RELEASE",
                "failed to persist account repository lock release intent",
                error
            );
        }
    }

    async _withRepositoryLock(operation) {
        const key = this._lockRoot || this;
        const previous = LOCAL_REPOSITORY_OPERATIONS.get(key) || Promise.resolve();
        const current = previous.catch(() => undefined).then(async () => {
            const lock = await this._acquireRepositoryLock();
            try {
                return await operation();
            }
            finally {
                await this._releaseRepositoryLock(lock);
            }
        });
        LOCAL_REPOSITORY_OPERATIONS.set(key, current);
        current.catch(() => undefined);
        try {
            return await current;
        }
        finally {
            if (LOCAL_REPOSITORY_OPERATIONS.get(key) === current)
                LOCAL_REPOSITORY_OPERATIONS.delete(key);
        }
    }

    initialize() {
        if (this._initialized)
            return Promise.resolve(this.list());
        if (this._initializing)
            return this._initializing;

        const operation = this._withRepositoryLock(() => this._initializeNow())
            .then(() => {
                this._initialized = true;
                return accountListClone(this._cache, this._envelope.revision);
            });
        let wrapped;
        wrapped = operation.finally(() => {
            if (this._initializing === wrapped)
                this._initializing = null;
        });
        this._initializing = wrapped;
        return wrapped;
    }

    async _recoverMissingCredentialsFromPlaintext(envelope, hydrated) {
        const primary = this.globalState.get(PRIMARY_PLAINTEXT_ACCOUNT_KEY);
        const legacy = this.globalState.get(LEGACY_ACCOUNT_METADATA_KEY);
        const source = primary !== undefined ? primary : legacy;
        if (source === undefined)
            return { accounts: hydrated, plaintextPresent: false };
        if (!Array.isArray(source))
            throw fail("ERR_INVALID_METADATA", "legacy account metadata must be an array");
        const candidates = new Map();
        for (const account of source) {
            if (!isPlainObject(account))
                continue;
            const split = splitAccount(account);
            if (typeof split.metadata.id === "string" && split.credentialEntries.length)
                candidates.set(split.metadata.id, split.credentialEntries);
        }
        let matchedMissingCredential = false;
        for (let index = 0; index < envelope.accounts.length; index++) {
            if (hydrated[index].credentialStatus === CREDENTIAL_STATUS_AVAILABLE)
                continue;
            const record = envelope.accounts[index];
            const ref = credentialRefOf(record);
            const entries = candidates.get(record.id);
            if (!ref || !entries)
                continue;
            matchedMissingCredential = true;
            const key = accountSecretKey(record.id, ref.slot);
            const serialized = serializeCredential(record.id, entries);
            await this.secrets.store(key, serialized);
            const observed = await this.secrets.get(key);
            if (observed !== serialized) {
                throw fail(
                    "ERR_SECRET_VERIFY",
                    `recovered credentials for account ${record.id} did not verify`
                );
            }
        }
        return {
            accounts: await this._hydrateEnvelope(envelope),
            plaintextPresent: matchedMissingCredential
        };
    }

    async _initializeNow() {
        const authoritative = await this._readAuthoritativeEnvelope();
        const current = authoritative !== undefined
            ? authoritative
            : this.globalState.get(ACCOUNT_METADATA_KEY);
        if (current !== undefined) {
            let envelope = validateEnvelope(current);
            const recovered = await this._hydrateEnvelope(envelope, {
                recoverAlternate: true
            });
            let hydrated = recovered.accounts;
            if (recovered.recovered) {
                envelope = recovered.envelope;
                await this._writeEnvelope(envelope);
            }
            else if (authoritative === undefined)
                await this._writeAuthoritativeEnvelope(envelope);
            if (hydrated.some(account =>
                account.credentialStatus !== CREDENTIAL_STATUS_AVAILABLE)) {
                const plaintextRecovery = await this._recoverMissingCredentialsFromPlaintext(
                    envelope,
                    hydrated
                );
                hydrated = plaintextRecovery.accounts;
                if (plaintextRecovery.plaintextPresent &&
                    hydrated.some(account =>
                        account.credentialStatus !== CREDENTIAL_STATUS_AVAILABLE)) {
                    throw fail(
                        "ERR_MIGRATION_INCOMPLETE",
                        "legacy plaintext credentials remain but could not be safely restored"
                    );
                }
            }
            this._envelope = envelope;
            this._cache = hydrated;
            const pendingCleanupErrors = await this._retryPendingSecretDeletes(envelope);
            if (pendingCleanupErrors.length) {
                throw combineErrors(
                    "pending credential cleanup failed",
                    pendingCleanupErrors
                );
            }

            // A v2 record is authoritative. Old keys are only cleanup candidates,
            // never fallback data. Retain them if a referenced secret is missing:
            // plaintext may then be the user's only recoverable credential copy.
            const credentialsVerified = envelope.accounts.every((record, index) =>
                !credentialRefOf(record) ||
                hydrated[index].credentialStatus === CREDENTIAL_STATUS_AVAILABLE);
            if (credentialsVerified)
                await this._deleteLegacyMetadata();
            return;
        }

        const primaryPlaintext = this.globalState.get(PRIMARY_PLAINTEXT_ACCOUNT_KEY);
        const legacyPlaintext = this.globalState.get(LEGACY_ACCOUNT_METADATA_KEY);

        // An explicitly present primary plaintext key, including [], is
        // authoritative. It must never resurrect the keepchat list.
        let source = primaryPlaintext !== undefined
            ? primaryPlaintext
            : legacyPlaintext;
        if (source === undefined)
            source = [];
        if (!Array.isArray(source))
            throw fail("ERR_INVALID_METADATA", "legacy account metadata must be an array");

        await this._commitList(source, {
            schemaVersion: ACCOUNT_STORAGE_SCHEMA,
            revision: 0,
            accounts: []
        }, {
            deleteLegacy: primaryPlaintext !== undefined || legacyPlaintext !== undefined
        });
    }

    list() {
        if (!this._initialized)
            throw fail("ERR_NOT_INITIALIZED", "AccountRepository.initialize() must complete before list()");
        return accountListClone(this._cache, this._envelope.revision);
    }

    save(list) {
        let snapshot;
        let expectedRevision;
        try {
            if (!this._initialized)
                throw fail("ERR_NOT_INITIALIZED", "AccountRepository.initialize() must complete before save()");
            if (!Array.isArray(list))
                throw fail("ERR_INVALID_ACCOUNT_LIST", "save() requires an account array");
            expectedRevision = list[LIST_REVISION];
            if (!Number.isSafeInteger(expectedRevision)) {
                throw fail(
                    "ERR_REVISION_REQUIRED",
                    "save() requires the versioned array returned by list(); use mutate() for read-modify-write operations"
                );
            }
            snapshot = cloneJson(list, "accounts");
        }
        catch (error) {
            return Promise.reject(error);
        }

        const operation = this._saveTail.then(() => this._withRepositoryLock(async () => {
            await this._initializeNow();
            if (this._envelope.revision !== expectedRevision) {
                throw fail("ERR_REVISION_CONFLICT", "account metadata changed in another Cursor window");
            }
            return this._commitList(snapshot, this._envelope);
        }));
        this._saveTail = operation.catch(() => undefined);
        return operation;
    }

    mutate(mutator) {
        if (typeof mutator !== "function")
            return Promise.reject(fail("ERR_INVALID_MUTATOR", "mutate() requires a function"));
        if (!this._initialized)
            return Promise.reject(fail("ERR_NOT_INITIALIZED", "AccountRepository.initialize() must complete before mutate()"));

        const operation = this._saveTail.then(() => this._withRepositoryLock(async () => {
            await this._initializeNow();
            const current = cloneJson(this._cache, "accounts");
            const next = await mutator(current);
            if (next === undefined)
                return accountListClone(this._cache, this._envelope.revision);
            if (!Array.isArray(next))
                throw fail("ERR_INVALID_ACCOUNT_LIST", "account mutator must return an account array or undefined");
            const snapshot = cloneJson(next, "accounts");
            return this._commitList(snapshot, this._envelope);
        }));
        this._saveTail = operation.catch(() => undefined);
        return operation;
    }

    async _commitList(list, previousEnvelope, options = {}) {
        const prepared = this._prepareCommit(list, previousEnvelope);
        await this._stageSecrets(prepared.staged);
        const cleanupKeys = this._cleanupKeysAfterCommit(prepared, previousEnvelope);
        try {
            await this._mergePendingSecretDeletes(
                cleanupKeys.concat(prepared.staged.map(item => item.key))
            );
        }
        catch (error) {
            const cleanupErrors = await this._deleteSecretKeys(
                prepared.staged.map(item => item.key)
            );
            throw combineErrors("failed to persist credential cleanup state", [
                error,
                ...cleanupErrors
            ]);
        }

        let committed = false;
        let updateError = null;
        if (this._lockRoot) {
            await this._writeAuthoritativeEnvelope(prepared.envelope);
            committed = true;
        }
        try {
            await this.globalState.update(ACCOUNT_METADATA_KEY, prepared.envelope);
            const observed = this.globalState.get(ACCOUNT_METADATA_KEY);
            if (!envelopesEqual(observed, prepared.envelope))
                throw fail("ERR_METADATA_VERIFY", "account metadata did not verify after update");
            committed = true;
        }
        catch (error) {
            if (committed) {
                updateError = fail(
                    "ERR_METADATA_COMMIT_REPORTED",
                    "authoritative metadata committed but globalState synchronization failed",
                    error
                );
            }
            else {
            let observed;
            try {
                observed = this.globalState.get(ACCOUNT_METADATA_KEY);
            }
            catch (readError) {
                throw combineErrors("account metadata update and verification failed", [error, readError]);
            }
            if (!envelopesEqual(observed, prepared.envelope)) {
                // Pending cleanup records include staged slots. On the next
                // initialization they are deleted only if metadata does not
                // reference them.
                throw fail("ERR_METADATA_COMMIT", "failed to commit account metadata", error);
            }
            committed = true;
            updateError = fail("ERR_METADATA_COMMIT_REPORTED", "globalState.update reported an error after committing metadata", error);
            }
        }

        if (!committed)
            throw fail("ERR_METADATA_COMMIT", "account metadata was not committed");

        const hydrated = await this._hydrateEnvelope(prepared.envelope);
        const unavailableStaged = new Set(
            hydrated
                .filter(account => account.credentialStatus !== CREDENTIAL_STATUS_AVAILABLE)
                .map(account => account.id)
        );
        if (prepared.staged.some(item => unavailableStaged.has(item.id))) {
            // Metadata now names the staged slot, but the old slot (or legacy
            // plaintext during migration) is deliberately retained for recovery.
            throw fail(
                "ERR_SECRET_MISSING_AFTER_COMMIT",
                "a staged credential disappeared after metadata commit; old credentials were retained"
            );
        }
        this._envelope = prepared.envelope;
        this._cache = hydrated;

        const cleanupErrors = await this._cleanupAfterCommit(prepared);
        if (options.deleteLegacy) {
            try {
                await this._deleteLegacyMetadata();
            }
            catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (updateError || cleanupErrors.length)
            throw combineErrors("account data committed but cleanup failed", [updateError, ...cleanupErrors]);
        return accountListClone(this._cache, this._envelope.revision);
    }

    _prepareCommit(list, previousEnvelope) {
        const previous = validateEnvelope(previousEnvelope);
        const previousById = new Map(previous.accounts.map(record => [record.id, record]));
        const records = [];
        const staged = [];
        const ids = new Set();

        list.forEach((account, index) => {
            const split = splitAccount(account);
            const id = validateAccountId(split.metadata.id);
            if (ids.has(id))
                throw fail("ERR_DUPLICATE_ACCOUNT_ID", `duplicate account id: ${id}`);
            ids.add(id);
            assertNoSensitiveMetadata(split.metadata, `accounts[${index}]`);

            const oldRecord = previousById.get(id);
            const oldRef = oldRecord ? credentialRefOf(oldRecord) : null;
            let newRef = oldRef;
            if (split.credentialEntries.length) {
                const slot = oldRef ? oppositeSlot(oldRef.slot) : "a";
                newRef = { slot };
                staged.push({
                    id,
                    slot,
                    key: accountSecretKey(id, slot),
                    value: serializeCredential(id, split.credentialEntries)
                });
            }

            const record = split.metadata;
            if (newRef)
                record.credentialSlot = newRef.slot;
            records.push(record);
        });

        const nextRevision = previous.revision + 1;
        if (!Number.isSafeInteger(nextRevision))
            throw fail("ERR_INVALID_METADATA", "account metadata revision overflow");

        return {
            envelope: {
                schemaVersion: ACCOUNT_STORAGE_SCHEMA,
                revision: nextRevision,
                accounts: records
            },
            staged,
            ids
        };
    }

    async _stageSecrets(staged) {
        const written = [];
        try {
            for (const item of staged) {
                await this.secrets.store(item.key, item.value);
                written.push(item.key);
                const observed = await this.secrets.get(item.key);
                if (observed !== item.value)
                    throw fail("ERR_SECRET_VERIFY", `credentials for account ${item.id} did not verify`);
            }
        }
        catch (error) {
            const cleanupErrors = await this._deleteSecretKeys(written);
            if (cleanupErrors.length)
                throw combineErrors("staging credentials and rollback both failed", [error, ...cleanupErrors]);
            throw fail("ERR_SECRET_STAGE", "failed to stage account credentials", error);
        }
    }

    async _hydrateEnvelope(envelope, options = {}) {
        const validated = validateEnvelope(envelope);
        const hydrated = [];
        const recoveredRecords = [];
        let recovered = false;
        for (const record of validated.accounts) {
            const ref = credentialRefOf(record);
            const metadata = cloneJson(record, `metadata for ${record.id}`);
            delete metadata.credentialSlot;

            if (!ref) {
                metadata.credentialStatus = CREDENTIAL_STATUS_MISSING;
                hydrated.push(metadata);
                recoveredRecords.push(record);
                continue;
            }

            const serialized = await this.secrets.get(accountSecretKey(record.id, ref.slot));
            let account = null;
            let primaryError = null;
            if (serialized !== undefined && serialized !== null) {
                try {
                    account = applyCredentialEntries(metadata, parseCredential(serialized, record.id));
                }
                catch (error) {
                    primaryError = error;
                }
            }
            let selectedSlot = ref.slot;
            if (!account && options.recoverAlternate === true) {
                const alternateSlot = oppositeSlot(ref.slot);
                const alternate = await this.secrets.get(accountSecretKey(record.id, alternateSlot));
                if (alternate !== undefined && alternate !== null) {
                    try {
                        account = applyCredentialEntries(
                            metadata,
                            parseCredential(alternate, record.id)
                        );
                        selectedSlot = alternateSlot;
                        recovered = true;
                    }
                    catch {
                        // An unreferenced invalid slot is not authoritative.
                    }
                }
            }
            if (!account && primaryError)
                throw primaryError;
            if (!account) {
                metadata.credentialStatus = CREDENTIAL_STATUS_MISSING;
                hydrated.push(metadata);
                recoveredRecords.push(record);
                continue;
            }
            account.credentialStatus = CREDENTIAL_STATUS_AVAILABLE;
            hydrated.push(account);
            recoveredRecords.push(selectedSlot === ref.slot
                ? record
                : { ...record, credentialSlot: selectedSlot });
        }
        if (options.recoverAlternate !== true)
            return hydrated;
        if (recovered && !Number.isSafeInteger(validated.revision + 1))
            throw fail("ERR_INVALID_METADATA", "account metadata revision overflow");
        return {
            accounts: hydrated,
            recovered,
            envelope: recovered ? {
                schemaVersion: ACCOUNT_STORAGE_SCHEMA,
                revision: validated.revision + 1,
                accounts: recoveredRecords
            } : validated
        };
    }

    _cleanupKeysAfterCommit(prepared, previousEnvelope) {
        const previous = validateEnvelope(previousEnvelope);
        const currentById = new Map(prepared.envelope.accounts.map(record => [record.id, record]));
        const stagedIds = new Set(prepared.staged.map(item => item.id));
        const keys = [];

        for (const oldRecord of previous.accounts) {
            const current = currentById.get(oldRecord.id);
            if (!current) {
                for (const slot of ACCOUNT_SECRET_SLOTS)
                    keys.push(accountSecretKey(oldRecord.id, slot));
                continue;
            }
            if (stagedIds.has(oldRecord.id)) {
                const oldRef = credentialRefOf(oldRecord);
                const newRef = credentialRefOf(current);
                if (oldRef && newRef && oldRef.slot !== newRef.slot)
                    keys.push(accountSecretKey(oldRecord.id, oldRef.slot));
            }
        }

        for (const item of prepared.staged) {
            if (!previous.accounts.some(record => record.id === item.id))
                keys.push(accountSecretKey(item.id, oppositeSlot(item.slot)));
        }
        return [...new Set(keys)];
    }

    async _writePendingSecretDeletes(keys) {
        const unique = [...new Set(keys)].sort();
        const authoritative = await this._readAuthoritativePendingDeletes();
        if (!unique.length &&
            authoritative === undefined &&
            this.globalState.get(PENDING_SECRET_DELETES_KEY) === undefined) {
            return;
        }
        await this._writeAuthoritativePendingDeletes(unique);
        const value = unique.length
            ? { schemaVersion: 1, keys: unique }
            : undefined;
        await this.globalState.update(PENDING_SECRET_DELETES_KEY, value);
        const observed = this.globalState.get(PENDING_SECRET_DELETES_KEY);
        if (unique.length) {
            if (canonicalJson(validatePendingSecretDeletes(observed)) !== canonicalJson(unique))
                throw fail("ERR_CLEANUP_STATE_COMMIT", "pending credential cleanup metadata did not verify");
        }
        else if (observed !== undefined) {
            throw fail("ERR_CLEANUP_STATE_COMMIT", "pending credential cleanup metadata was not removed");
        }
    }

    async _mergePendingSecretDeletes(keys) {
        const authoritative = await this._readAuthoritativePendingDeletes();
        const current = authoritative === undefined
            ? validatePendingSecretDeletes(this.globalState.get(PENDING_SECRET_DELETES_KEY))
            : authoritative;
        if (!current.length && keys.length === 0)
            return;
        await this._writePendingSecretDeletes(current.concat(keys));
    }

    async _retryPendingSecretDeletes(envelope) {
        const authoritative = await this._readAuthoritativePendingDeletes();
        const pending = authoritative === undefined
            ? validatePendingSecretDeletes(this.globalState.get(PENDING_SECRET_DELETES_KEY))
            : authoritative;
        if (!pending.length)
            return [];
        const referenced = new Set();
        for (const record of validateEnvelope(envelope).accounts) {
            const ref = credentialRefOf(record);
            if (ref)
                referenced.add(accountSecretKey(record.id, ref.slot));
        }
        const remaining = [];
        const errors = [];
        for (const key of pending) {
            if (referenced.has(key))
                continue;
            try {
                await this.secrets.delete(key);
                const observed = await this.secrets.get(key);
                if (observed !== undefined && observed !== null)
                    throw fail("ERR_SECRET_DELETE_VERIFY", `secret ${key} still exists after deletion`);
            }
            catch (error) {
                remaining.push(key);
                errors.push(fail("ERR_SECRET_DELETE", `failed to delete secret ${key}`, error));
            }
        }
        try {
            await this._writePendingSecretDeletes(remaining);
        }
        catch (error) {
            errors.push(error);
        }
        return errors;
    }

    async _cleanupAfterCommit(prepared) {
        return this._retryPendingSecretDeletes(prepared.envelope);
    }

    async _deleteSecretKeys(keys) {
        const errors = [];
        for (const key of new Set(keys)) {
            try {
                await this.secrets.delete(key);
                const observed = await this.secrets.get(key);
                if (observed !== undefined && observed !== null)
                    throw fail("ERR_SECRET_DELETE_VERIFY", `secret ${key} still exists after deletion`);
            }
            catch (error) {
                errors.push(fail("ERR_SECRET_DELETE", `failed to delete secret ${key}`, error));
            }
        }
        return errors;
    }

    async _writeEnvelope(envelope) {
        const validated = validateEnvelope(envelope);
        await this._writeAuthoritativeEnvelope(validated);
        await this.globalState.update(ACCOUNT_METADATA_KEY, validated);
        const observed = this.globalState.get(ACCOUNT_METADATA_KEY);
        if (!envelopesEqual(observed, validated))
            throw fail("ERR_METADATA_VERIFY", "account metadata did not verify after update");
    }

    async _deleteLegacyMetadata() {
        const errors = [];
        for (const key of [PRIMARY_PLAINTEXT_ACCOUNT_KEY, LEGACY_ACCOUNT_METADATA_KEY]) {
            try {
                await this.globalState.update(key, undefined);
                if (this.globalState.get(key) !== undefined)
                    throw fail("ERR_LEGACY_DELETE_VERIFY", `legacy plaintext account metadata still exists at ${key}`);
            }
            catch (error) {
                errors.push(error);
            }
        }
        if (errors.length)
            throw combineErrors("failed to delete legacy plaintext account metadata", errors);
    }

    _enqueueManual(operation) {
        const pending = this._manualTail.then(() =>
            this._withRepositoryLock(operation)
        );
        this._manualTail = pending.catch(() => undefined);
        return pending;
    }

    getManualToken() {
        return this._enqueueManual(async () => {
            const serialized = await this.secrets.get(MANUAL_TOKEN_SECRET_KEY);
            if (serialized === undefined || serialized === null)
                return "";
            let payload;
            try {
                payload = JSON.parse(serialized);
            }
            catch (error) {
                throw fail("ERR_INVALID_MANUAL_TOKEN_SECRET", "manual token secret is not valid JSON", error);
            }
            if (!isPlainObject(payload) ||
                payload.schema !== MANUAL_TOKEN_SCHEMA ||
                typeof payload.token !== "string") {
                throw fail("ERR_INVALID_MANUAL_TOKEN_SECRET", "manual token secret has an invalid schema");
            }
            return payload.token;
        });
    }

    setManualToken(token) {
        return this._enqueueManual(async () => {
            if (typeof token !== "string")
                throw fail("ERR_INVALID_MANUAL_TOKEN", "manual token must be a string");
            const normalized = token.trim();
            if (!normalized)
                throw fail("ERR_INVALID_MANUAL_TOKEN", "manual token must not be empty");
            const serialized = JSON.stringify({
                schema: MANUAL_TOKEN_SCHEMA,
                token: normalized
            });
            if (Buffer.byteLength(serialized, "utf8") > MAX_SECRET_BYTES)
                throw fail("ERR_SECRET_TOO_LARGE", "manual token is too large");
            const previous = await this.secrets.get(MANUAL_TOKEN_SECRET_KEY);
            try {
                await this.secrets.store(MANUAL_TOKEN_SECRET_KEY, serialized);
                const observed = await this.secrets.get(MANUAL_TOKEN_SECRET_KEY);
                if (observed !== serialized)
                    throw fail("ERR_SECRET_VERIFY", "manual token did not verify after storage");
            }
            catch (error) {
                const failures = [error];
                try {
                    if (previous === undefined || previous === null)
                        await this.secrets.delete(MANUAL_TOKEN_SECRET_KEY);
                    else
                        await this.secrets.store(MANUAL_TOKEN_SECRET_KEY, previous);
                    const restored = await this.secrets.get(MANUAL_TOKEN_SECRET_KEY);
                    if (restored !== previous)
                        throw fail("ERR_SECRET_ROLLBACK_VERIFY", "previous manual token did not verify after rollback");
                }
                catch (rollbackError) {
                    failures.push(rollbackError);
                }
                throw combineErrors("manual token storage and rollback failed", failures);
            }
            return normalized;
        });
    }

    clearManualToken() {
        return this._enqueueManual(async () => {
            await this.secrets.delete(MANUAL_TOKEN_SECRET_KEY);
            const observed = await this.secrets.get(MANUAL_TOKEN_SECRET_KEY);
            if (observed !== undefined && observed !== null)
                throw fail("ERR_SECRET_DELETE_VERIFY", "manual token still exists after deletion");
        });
    }

    getManualCursorToken() {
        return this.getManualToken();
    }

    setManualCursorToken(token) {
        return this.setManualToken(token);
    }

    clearManualCursorToken() {
        return this.clearManualToken();
    }
}

module.exports = {
    ACCOUNT_METADATA_KEY,
    ACCOUNT_SECRET_PREFIX,
    ACCOUNT_SECRET_SCHEMA,
    ACCOUNT_SECRET_SLOTS,
    ACCOUNT_STORAGE_SCHEMA,
    ACCOUNTS_V2_KEY: ACCOUNT_METADATA_KEY,
    AccountRepository,
    AccountRepositoryError,
    CREDENTIAL_STATUS_AVAILABLE,
    CREDENTIAL_STATUS_MISSING,
    LEGACY_ACCOUNT_METADATA_KEY,
    MANUAL_TOKEN_SCHEMA,
    MANUAL_TOKEN_SECRET_KEY,
    PENDING_SECRET_DELETES_KEY,
    PRIMARY_PLAINTEXT_ACCOUNT_KEY,
    accountSecretKey,
    isSensitiveField
};
