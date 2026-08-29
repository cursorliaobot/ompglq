"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { fsyncDirectory } = require("./atomicFile");

const BACKUP_KIND = "cursor-account-manager.encrypted-backup";
const BACKUP_VERSION = 2;
const BACKUP_CIPHER = "aes-256-gcm";
const BACKUP_KDF = "scrypt";

const DEFAULT_KDF = Object.freeze({
    N: 16384,
    r: 8,
    p: 1
});

const BACKUP_LIMITS = Object.freeze({
    maxFileBytes: 12 * 1024 * 1024,
    maxPlaintextBytes: 8 * 1024 * 1024,
    maxAccounts: 1000,
    maxFieldBytes: 256 * 1024,
    maxPasswordBytes: 4096,
    maxDepth: 32,
    maxNodes: 100000,
    minScryptN: 16384,
    maxScryptN: 131072,
    minScryptR: 8,
    maxScryptR: 16,
    minScryptP: 1,
    maxScryptP: 4,
    maxScryptMemoryBytes: 64 * 1024 * 1024,
    maxScryptWork: 2 * 1024 * 1024
});

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

class AccountBackupError extends Error {
    constructor(code, message, cause) {
        super(message);
        this.name = "AccountBackupError";
        this.code = code;
        if (cause !== undefined)
            this.cause = cause;
    }
}

class BackupFormatError extends AccountBackupError {
    constructor(message, cause) {
        super("ERR_BACKUP_FORMAT", message, cause);
        this.name = "BackupFormatError";
    }
}

class BackupAuthenticationError extends AccountBackupError {
    constructor(message = "incorrect password or tampered backup", cause) {
        super("ERR_BACKUP_AUTH", message, cause);
        this.name = "BackupAuthenticationError";
    }
}

class BackupLimitError extends AccountBackupError {
    constructor(message, cause) {
        super("ERR_BACKUP_LIMIT", message, cause);
        this.name = "BackupLimitError";
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
    return Buffer.byteLength(value, "utf8");
}

function ensureInputSize(input, maximum, label) {
    const size = Buffer.isBuffer(input) || input instanceof Uint8Array
        ? input.byteLength
        : byteLength(String(input));
    if (size > maximum)
        throw new BackupLimitError(`${label} exceeds ${maximum} bytes`);
    return size;
}

function toJsonText(input) {
    if (typeof input === "string") {
        ensureInputSize(input, BACKUP_LIMITS.maxFileBytes, "backup file");
        return input;
    }
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        ensureInputSize(input, BACKUP_LIMITS.maxFileBytes, "backup file");
        return Buffer.from(input).toString("utf8");
    }
    if (isPlainObject(input) || Array.isArray(input)) {
        let serialized;
        try {
            serialized = JSON.stringify(input);
        }
        catch (error) {
            throw new BackupFormatError("backup object is not JSON-compatible", error);
        }
        ensureInputSize(serialized, BACKUP_LIMITS.maxFileBytes, "backup file");
        return serialized;
    }
    throw new BackupFormatError("backup must be a JSON string, buffer, object, or array");
}

function parseJson(text, label) {
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new BackupFormatError(`${label} is not valid JSON`, error);
    }
}

function inspectValue(value, state, depth, ancestors, label) {
    if (depth > BACKUP_LIMITS.maxDepth)
        throw new BackupLimitError(`${label} exceeds the maximum nesting depth`);
    state.nodes += 1;
    if (state.nodes > BACKUP_LIMITS.maxNodes)
        throw new BackupLimitError("backup contains too many values");

    if (value === null || typeof value === "boolean")
        return;
    if (typeof value === "string") {
        if (byteLength(value) > BACKUP_LIMITS.maxFieldBytes)
            throw new BackupLimitError(`${label} exceeds the maximum field length`);
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new BackupFormatError(`${label} contains a non-finite number`);
        return;
    }
    if (typeof value !== "object")
        throw new BackupFormatError(`${label} is not JSON-compatible`);
    if (ancestors.has(value))
        throw new BackupFormatError(`${label} contains a circular reference`);

    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            value.forEach((item, index) =>
                inspectValue(item, state, depth + 1, ancestors, `${label}[${index}]`));
            return;
        }
        if (!isPlainObject(value))
            throw new BackupFormatError(`${label} must contain only plain objects`);
        for (const [key, item] of Object.entries(value)) {
            if (byteLength(key) > BACKUP_LIMITS.maxFieldBytes)
                throw new BackupLimitError(`${label} contains an oversized field name`);
            if (key === "__proto__" || key === "constructor" || key === "prototype")
                throw new BackupFormatError(`${label} contains an unsafe field name`);
            inspectValue(item, state, depth + 1, ancestors, `${label}.${key}`);
        }
    }
    finally {
        ancestors.delete(value);
    }
}

function accountsFromPayload(payload) {
    if (Array.isArray(payload))
        return payload;
    if (!isPlainObject(payload))
        throw new BackupFormatError("backup payload must be an object or account array");
    if (Array.isArray(payload.accounts))
        return payload.accounts;
    if (payload.accessToken !== undefined ||
        payload.refreshToken !== undefined ||
        payload.token !== undefined ||
        payload.session !== undefined ||
        payload.authBlob !== undefined ||
        payload.email !== undefined) {
        return [payload];
    }
    throw new BackupFormatError("backup payload does not contain an accounts array");
}

function validateBackupPayload(payload) {
    const accounts = accountsFromPayload(payload);
    if (accounts.length > BACKUP_LIMITS.maxAccounts)
        throw new BackupLimitError(`backup contains more than ${BACKUP_LIMITS.maxAccounts} accounts`);
    accounts.forEach((account, index) => {
        if (!isPlainObject(account))
            throw new BackupFormatError(`account ${index} is not an object`);
    });

    inspectValue(payload, { nodes: 0 }, 0, new Set(), "backup");

    let serialized;
    try {
        serialized = JSON.stringify(payload);
    }
    catch (error) {
        throw new BackupFormatError("backup payload is not JSON-compatible", error);
    }
    ensureInputSize(serialized, BACKUP_LIMITS.maxPlaintextBytes, "backup plaintext");
    return {
        value: JSON.parse(serialized),
        serialized
    };
}

function validatePassword(password) {
    if (typeof password !== "string" && !Buffer.isBuffer(password) && !(password instanceof Uint8Array))
        throw new BackupFormatError("backup password must be a string or buffer");
    const buffer = Buffer.isBuffer(password) ? Buffer.from(password) : Buffer.from(password);
    if (buffer.length === 0)
        throw new BackupFormatError("backup password must not be empty");
    if (buffer.length > BACKUP_LIMITS.maxPasswordBytes)
        throw new BackupLimitError("backup password is too long");
    return buffer;
}

function isPowerOfTwo(value) {
    return Number.isSafeInteger(value) && value > 0 && Math.log2(value) % 1 === 0;
}

function validateKdfParameters(input) {
    if (!isPlainObject(input))
        throw new BackupFormatError("scrypt parameters are missing");
    if (input.name !== undefined && input.name !== BACKUP_KDF)
        throw new BackupFormatError("unsupported backup KDF");

    const N = input.N;
    const r = input.r;
    const p = input.p;
    if (!isPowerOfTwo(N) || N < BACKUP_LIMITS.minScryptN || N > BACKUP_LIMITS.maxScryptN)
        throw new BackupLimitError("scrypt N is outside the permitted range");
    if (!Number.isSafeInteger(r) || r < BACKUP_LIMITS.minScryptR || r > BACKUP_LIMITS.maxScryptR)
        throw new BackupLimitError("scrypt r is outside the permitted range");
    if (!Number.isSafeInteger(p) || p < BACKUP_LIMITS.minScryptP || p > BACKUP_LIMITS.maxScryptP)
        throw new BackupLimitError("scrypt p is outside the permitted range");

    const memoryBytes = 128 * N * r;
    const work = N * r * p;
    if (!Number.isSafeInteger(memoryBytes) || memoryBytes > BACKUP_LIMITS.maxScryptMemoryBytes)
        throw new BackupLimitError("scrypt memory cost exceeds the permitted limit");
    if (!Number.isSafeInteger(work) || work > BACKUP_LIMITS.maxScryptWork)
        throw new BackupLimitError("scrypt work factor exceeds the permitted limit");
    return { N, r, p, memoryBytes };
}

function deriveKey(password, salt, kdf) {
    const maxmem = Math.max(32 * 1024 * 1024, kdf.memoryBytes + 4 * 1024 * 1024);
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, KEY_BYTES, {
            N: kdf.N,
            r: kdf.r,
            p: kdf.p,
            maxmem
        }, (error, key) => {
            if (error)
                reject(new AccountBackupError("ERR_BACKUP_KDF", "scrypt key derivation failed", error));
            else
                resolve(key);
        });
    });
}

function decodeBase64(value, label, expectedBytes) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new BackupFormatError(`${label} is not valid base64`);
    }
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value)
        throw new BackupFormatError(`${label} is not canonical base64`);
    if (expectedBytes !== undefined && decoded.length !== expectedBytes)
        throw new BackupFormatError(`${label} has an invalid length`);
    return decoded;
}

function authenticatedHeader(envelope) {
    return {
        kind: envelope.kind,
        version: envelope.version,
        cipher: envelope.cipher,
        kdf: {
            name: envelope.kdf.name,
            N: envelope.kdf.N,
            r: envelope.kdf.r,
            p: envelope.kdf.p,
            salt: envelope.kdf.salt
        },
        iv: envelope.iv
    };
}

function aadFor(envelope) {
    return Buffer.from(JSON.stringify(authenticatedHeader(envelope)), "utf8");
}

function isEncryptedBackup(value) {
    return isPlainObject(value) && value.kind === BACKUP_KIND;
}

async function encryptBackup(payload, password, options = {}) {
    const checked = validateBackupPayload(payload);
    if (options === null || typeof options !== "object")
        throw new BackupFormatError("backup encryption options must be an object");
    const requestedKdf = isPlainObject(options.kdf) ? options.kdf : options;
    const kdf = validateKdfParameters({
        name: BACKUP_KDF,
        N: requestedKdf.N === undefined ? DEFAULT_KDF.N : requestedKdf.N,
        r: requestedKdf.r === undefined ? DEFAULT_KDF.r : requestedKdf.r,
        p: requestedKdf.p === undefined ? DEFAULT_KDF.p : requestedKdf.p
    });
    const passwordBuffer = validatePassword(password);
    const salt = crypto.randomBytes(SALT_BYTES);
    const iv = crypto.randomBytes(IV_BYTES);
    const envelope = {
        kind: BACKUP_KIND,
        version: BACKUP_VERSION,
        cipher: BACKUP_CIPHER,
        kdf: {
            name: BACKUP_KDF,
            N: kdf.N,
            r: kdf.r,
            p: kdf.p,
            salt: salt.toString("base64")
        },
        iv: iv.toString("base64")
    };

    let key;
    try {
        key = await deriveKey(passwordBuffer, salt, kdf);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
            authTagLength: TAG_BYTES
        });
        cipher.setAAD(aadFor(envelope));
        const ciphertext = Buffer.concat([
            cipher.update(Buffer.from(checked.serialized, "utf8")),
            cipher.final()
        ]);
        envelope.tag = cipher.getAuthTag().toString("base64");
        envelope.ciphertext = ciphertext.toString("base64");
    }
    finally {
        passwordBuffer.fill(0);
        if (key)
            key.fill(0);
    }

    const serialized = JSON.stringify(envelope);
    ensureInputSize(serialized, BACKUP_LIMITS.maxFileBytes, "encrypted backup");
    return serialized;
}

function validateEncryptedEnvelope(envelope) {
    if (!isPlainObject(envelope) || envelope.kind !== BACKUP_KIND)
        throw new BackupFormatError("not a Cursor Account Manager encrypted backup");
    if (envelope.version !== BACKUP_VERSION)
        throw new BackupFormatError(`unsupported encrypted backup version: ${String(envelope.version)}`);
    if (envelope.cipher !== BACKUP_CIPHER)
        throw new BackupFormatError("unsupported backup cipher");
    if (!isPlainObject(envelope.kdf) || envelope.kdf.name !== BACKUP_KDF)
        throw new BackupFormatError("unsupported backup KDF");

    const kdf = validateKdfParameters(envelope.kdf);
    const salt = decodeBase64(envelope.kdf.salt, "scrypt salt", SALT_BYTES);
    const iv = decodeBase64(envelope.iv, "AES-GCM IV", IV_BYTES);
    const tag = decodeBase64(envelope.tag, "AES-GCM tag", TAG_BYTES);
    const ciphertext = decodeBase64(envelope.ciphertext, "ciphertext");
    if (ciphertext.length > BACKUP_LIMITS.maxPlaintextBytes + TAG_BYTES)
        throw new BackupLimitError("encrypted backup payload is too large");
    return { kdf, salt, iv, tag, ciphertext };
}

async function decryptBackup(input, password) {
    const text = toJsonText(input);
    const parsed = parseJson(text, "backup file");

    if (!isEncryptedBackup(parsed)) {
        if (isPlainObject(parsed) &&
            (parsed.ciphertext !== undefined || parsed.kdf !== undefined || parsed.tag !== undefined)) {
            throw new BackupFormatError("encrypted backup header is invalid");
        }
        return validateBackupPayload(parsed).value;
    }

    const encrypted = validateEncryptedEnvelope(parsed);
    const passwordBuffer = validatePassword(password);
    let key;
    let plaintext;
    try {
        key = await deriveKey(passwordBuffer, encrypted.salt, encrypted.kdf);
        try {
            const decipher = crypto.createDecipheriv("aes-256-gcm", key, encrypted.iv, {
                authTagLength: TAG_BYTES
            });
            decipher.setAAD(aadFor(parsed));
            decipher.setAuthTag(encrypted.tag);
            plaintext = Buffer.concat([
                decipher.update(encrypted.ciphertext),
                decipher.final()
            ]);
        }
        catch (error) {
            throw new BackupAuthenticationError("incorrect password or tampered backup", error);
        }
    }
    finally {
        passwordBuffer.fill(0);
        if (key)
            key.fill(0);
    }

    if (plaintext.length > BACKUP_LIMITS.maxPlaintextBytes) {
        plaintext.fill(0);
        throw new BackupLimitError("decrypted backup payload is too large");
    }
    try {
        const payload = parseJson(plaintext.toString("utf8"), "decrypted backup payload");
        return validateBackupPayload(payload).value;
    }
    finally {
        plaintext.fill(0);
    }
}

function parsePlaintextBackup(input) {
    const text = toJsonText(input);
    const parsed = parseJson(text, "backup file");
    if (isEncryptedBackup(parsed))
        throw new BackupFormatError("encrypted v2 backup requires decryptBackup()");
    return validateBackupPayload(parsed).value;
}

function combineFileErrors(message, errors) {
    const realErrors = errors.filter(Boolean);
    if (realErrors.length === 1)
        return realErrors[0];
    const combined = new AggregateError(realErrors, message);
    combined.code = "ERR_BACKUP_FILE";
    return combined;
}

async function writeFileAtomic(filePath, data) {
    if (typeof filePath !== "string" || !filePath)
        throw new BackupFormatError("backup file path must be a non-empty string");
    if (typeof data !== "string" && !Buffer.isBuffer(data) && !(data instanceof Uint8Array))
        throw new BackupFormatError("backup file data must be a string or buffer");
    ensureInputSize(data, BACKUP_LIMITS.maxFileBytes, "backup file");

    const directory = path.dirname(filePath);
    const temporary = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
    );
    let handle;
    try {
        handle = await fs.promises.open(temporary, "wx", 0o600);
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.promises.rename(temporary, filePath);
        await fs.promises.chmod(filePath, 0o600);
        await fsyncDirectory(directory);
    }
    catch (error) {
        const cleanupErrors = [];
        if (handle) {
            try {
                await handle.close();
            }
            catch (closeError) {
                cleanupErrors.push(closeError);
            }
        }
        try {
            await fs.promises.unlink(temporary);
        }
        catch (unlinkError) {
            if (!unlinkError || unlinkError.code !== "ENOENT")
                cleanupErrors.push(unlinkError);
        }
        throw combineFileErrors("atomic backup write failed", [
            new AccountBackupError("ERR_BACKUP_FILE", "failed to write backup file", error),
            ...cleanupErrors
        ]);
    }
}

async function writeEncryptedBackup(filePath, payload, password, options) {
    const serialized = await encryptBackup(payload, password, options);
    await writeFileAtomic(filePath, serialized);
    return serialized;
}

async function readBackupFile(filePath, password) {
    if (typeof filePath !== "string" || !filePath)
        throw new BackupFormatError("backup file path must be a non-empty string");
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile())
        throw new BackupFormatError("backup path is not a regular file");
    if (stat.size > BACKUP_LIMITS.maxFileBytes)
        throw new BackupLimitError("backup file is too large");
    const contents = await fs.promises.readFile(filePath);
    return decryptBackup(contents, password);
}

const encryptAccountBackup = encryptBackup;
const decryptAccountBackup = decryptBackup;
const parseBackup = decryptBackup;
const atomicWriteFile = writeFileAtomic;

module.exports = {
    BACKUP_CIPHER,
    BACKUP_KDF,
    BACKUP_KIND,
    BACKUP_LIMITS,
    BACKUP_VERSION,
    DEFAULT_KDF,
    AccountBackupError,
    BackupAuthenticationError,
    BackupFormatError,
    BackupLimitError,
    atomicWriteFile,
    decryptAccountBackup,
    decryptBackup,
    encryptAccountBackup,
    encryptBackup,
    isEncryptedBackup,
    parseBackup,
    parsePlaintextBackup,
    readBackupFile,
    validateBackupPayload,
    writeEncryptedBackup,
    writeFileAtomic
};
