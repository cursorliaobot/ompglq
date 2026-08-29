"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    BACKUP_KIND,
    BACKUP_LIMITS,
    BACKUP_VERSION,
    BackupAuthenticationError,
    BackupLimitError,
    decryptBackup,
    encryptBackup,
    parsePlaintextBackup,
    readBackupFile,
    writeEncryptedBackup,
    writeFileAtomic
} = require("../src/accountBackup");

function payload() {
    return {
        kind: "cursor-account-manager",
        version: 1,
        exportedAt: "2026-08-29T00:00:00.000Z",
        accounts: [{
            id: "acc-1",
            email: "person@example.com",
            userId: "user_123",
            accessToken: "secret-access-token",
            refreshToken: "secret-refresh-token",
            authBlob: {
                "cursorAuth/accessToken": "secret-access-token"
            }
        }]
    };
}

test("v2 scrypt + AES-256-GCM backup round-trips without plaintext credentials", async () => {
    const original = payload();
    const encrypted = await encryptBackup(original, "correct horse battery staple");
    const envelope = JSON.parse(encrypted);

    assert.equal(envelope.kind, BACKUP_KIND);
    assert.equal(envelope.version, BACKUP_VERSION);
    assert.equal(envelope.cipher, "aes-256-gcm");
    assert.equal(envelope.kdf.name, "scrypt");
    assert.equal(encrypted.includes("secret-access-token"), false);
    assert.deepEqual(
        await decryptBackup(encrypted, "correct horse battery staple"),
        original
    );
});

test("legacy plaintext JSON remains readable and validated", async () => {
    const original = payload();
    const serialized = JSON.stringify(original);

    assert.deepEqual(await decryptBackup(serialized), original);
    assert.deepEqual(parsePlaintextBackup(serialized), original);

    const oldArray = [{ email: "old@example.com", token: "old-token" }];
    assert.deepEqual(await decryptBackup(JSON.stringify(oldArray)), oldArray);
});

test("wrong passwords and ciphertext tampering fail authentication", async () => {
    const encrypted = await encryptBackup(payload(), "right-password");
    await assert.rejects(
        decryptBackup(encrypted, "wrong-password"),
        error => error instanceof BackupAuthenticationError && error.code === "ERR_BACKUP_AUTH"
    );

    const envelope = JSON.parse(encrypted);
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    ciphertext[Math.floor(ciphertext.length / 2)] ^= 0x01;
    envelope.ciphertext = ciphertext.toString("base64");
    await assert.rejects(
        decryptBackup(JSON.stringify(envelope), "right-password"),
        error => error instanceof BackupAuthenticationError
    );

    const headerTamper = JSON.parse(encrypted);
    headerTamper.kdf.p = 2;
    await assert.rejects(
        decryptBackup(JSON.stringify(headerTamper), "right-password"),
        error => error instanceof BackupAuthenticationError
    );
});

test("KDF parameters are rejected before unbounded work or memory allocation", async () => {
    await assert.rejects(
        encryptBackup(payload(), "password", {
            N: BACKUP_LIMITS.maxScryptN * 2,
            r: 8,
            p: 1
        }),
        error => error instanceof BackupLimitError
    );

    const encrypted = JSON.parse(await encryptBackup(payload(), "password"));
    encrypted.kdf.N = BACKUP_LIMITS.maxScryptN * 2;
    await assert.rejects(
        decryptBackup(JSON.stringify(encrypted), "password"),
        error => error instanceof BackupLimitError
    );

    const excessiveMemory = JSON.parse(await encryptBackup(payload(), "password"));
    excessiveMemory.kdf.N = BACKUP_LIMITS.maxScryptN;
    excessiveMemory.kdf.r = BACKUP_LIMITS.maxScryptR;
    await assert.rejects(
        decryptBackup(JSON.stringify(excessiveMemory), "password"),
        error => error instanceof BackupLimitError
    );
});

test("file size, account count, and field length limits are enforced", async () => {
    const oversizedFile = " ".repeat(BACKUP_LIMITS.maxFileBytes + 1);
    await assert.rejects(
        decryptBackup(oversizedFile, "password"),
        error => error instanceof BackupLimitError
    );

    const tooManyAccounts = {
        accounts: Array.from(
            { length: BACKUP_LIMITS.maxAccounts + 1 },
            (_, index) => ({ id: `acc-${index}` })
        )
    };
    await assert.rejects(
        encryptBackup(tooManyAccounts, "password"),
        error => error instanceof BackupLimitError
    );

    const oversizedField = {
        accounts: [{
            accessToken: "x".repeat(BACKUP_LIMITS.maxFieldBytes + 1)
        }]
    };
    await assert.rejects(
        encryptBackup(oversizedField, "password"),
        error => error instanceof BackupLimitError
    );
});

test("malformed tags and truncated encrypted envelopes are rejected", async () => {
    const encrypted = JSON.parse(await encryptBackup(payload(), "password"));
    encrypted.tag = "AAAA";
    await assert.rejects(
        decryptBackup(JSON.stringify(encrypted), "password"),
        /invalid length/
    );

    delete encrypted.tag;
    await assert.rejects(
        decryptBackup(JSON.stringify(encrypted), "password"),
        /valid base64/
    );
});

test("atomic writer creates or replaces backup files with mode 0600", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cam-backup-test-"));
    const file = path.join(directory, "accounts.json");
    try {
        await writeFileAtomic(file, "first");
        await writeFileAtomic(file, "second");
        assert.equal(await fs.promises.readFile(file, "utf8"), "second");
        const stat = await fs.promises.stat(file);
        assert.equal(stat.mode & 0o777, 0o600);

        await writeEncryptedBackup(file, payload(), "password");
        assert.deepEqual(await readBackupFile(file, "password"), payload());
        const encryptedStat = await fs.promises.stat(file);
        assert.equal(encryptedStat.mode & 0o777, 0o600);
    }
    finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
});
