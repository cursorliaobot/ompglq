"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    ACCOUNT_METADATA_KEY,
    ACCOUNT_SECRET_PREFIX,
    ACCOUNT_SECRET_SCHEMA,
    ACCOUNT_STORAGE_SCHEMA,
    AccountRepository,
    CREDENTIAL_STATUS_AVAILABLE,
    CREDENTIAL_STATUS_MISSING,
    LEGACY_ACCOUNT_METADATA_KEY,
    MANUAL_TOKEN_SECRET_KEY,
    PENDING_SECRET_DELETES_KEY,
    PRIMARY_PLAINTEXT_ACCOUNT_KEY,
    accountSecretKey,
    isSensitiveField
} = require("../src/accountRepository");
const {
    migrateManualTokenFromConfiguration
} = require("../src/migrations");

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class MemoryGlobalState {
    constructor(initial = {}, events = []) {
        this.values = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));
        this.events = events;
        this.failNext = null;
    }

    get(key) {
        this.events.push({ type: "global.get", key });
        return clone(this.values.get(key));
    }

    async update(key, value) {
        this.events.push({ type: "global.update", key, value: clone(value) });
        const failure = this.failNext;
        if (failure && (!failure.key || failure.key === key)) {
            this.failNext = null;
            if (failure.when === "after") {
                if (value === undefined)
                    this.values.delete(key);
                else
                    this.values.set(key, clone(value));
            }
            throw new Error(failure.message || "injected globalState failure");
        }
        if (value === undefined)
            this.values.delete(key);
        else
            this.values.set(key, clone(value));
    }
}

class MemorySecrets {
    constructor(events = []) {
        this.values = new Map();
        this.events = events;
        this.failStoreKey = null;
        this.failDeleteKey = null;
        this.corruptGetKey = null;
        this.storeDelayMs = 0;
    }

    async get(key) {
        this.events.push({ type: "secret.get", key });
        const value = this.values.get(key);
        if (value !== undefined && this.corruptGetKey === key)
            return `${value}corrupt`;
        return value;
    }

    async store(key, value) {
        this.events.push({ type: "secret.store", key, value });
        if (this.storeDelayMs)
            await new Promise(resolve => setTimeout(resolve, this.storeDelayMs));
        if (this.failStoreKey === key) {
            this.failStoreKey = null;
            throw new Error("injected SecretStorage store failure");
        }
        this.values.set(key, value);
    }

    async delete(key) {
        this.events.push({ type: "secret.delete", key });
        if (this.failDeleteKey === key) {
            this.failDeleteKey = null;
            throw new Error("injected SecretStorage delete failure");
        }
        this.values.delete(key);
    }
}

function createContext(initial = {}) {
    const events = [];
    return {
        events,
        globalState: new MemoryGlobalState(initial, events),
        secrets: new MemorySecrets(events)
    };
}

function sampleAccount(suffix = "one") {
    return {
        id: "acc-1",
        email: "person@example.com",
        userId: "user_123",
        type: "pro",
        tokenType: "client",
        accessTokenExp: 123456,
        addedAt: "2026-08-29T00:00:00.000Z",
        usage: {
            sessionCount: 2,
            used: 3
        },
        accessToken: `access-${suffix}`,
        session: `user_123::access-${suffix}`,
        refreshToken: `refresh-${suffix}`,
        authBlob: {
            "cursorAuth/accessToken": `access-${suffix}`,
            "cursorAuth/refreshToken": `refresh-${suffix}`,
            "cursorAuth/userId": "user_123",
            "cursorAuth/cachedEmail": "person@example.com"
        }
    };
}

async function replaceAccounts(repository, accounts) {
    const versioned = repository.list();
    versioned.splice(0, versioned.length, ...accounts);
    return repository.save(versioned);
}

function assertMetadataHasNoCredentials(value) {
    const forbidden = new Set(["accessToken", "refreshToken", "session", "authBlob"]);
    const visit = node => {
        if (!node || typeof node !== "object")
            return;
        for (const [key, child] of Object.entries(node)) {
            assert.equal(forbidden.has(key), false, `plaintext metadata contains ${key}`);
            visit(child);
        }
    };
    visit(value);
}

test("all token-shaped Cursor auth keys are classified as credentials", () => {
    for (const key of [
        "cursor.auth.token",
        "cursorAuth/accessToken",
        "cursorAuth/refreshToken",
        "cursorAuth/workosCursorSessionToken",
        "idToken"
    ])
        assert.equal(isSensitiveField(key), true, key);
    assert.equal(isSensitiveField("tokenType"), false);
});

test("initialize migrates plaintext keys only after each secret verifies", async () => {
    const oldAccount = sampleAccount();
    const context = createContext({
        [PRIMARY_PLAINTEXT_ACCOUNT_KEY]: [oldAccount],
        [LEGACY_ACCOUNT_METADATA_KEY]: [oldAccount]
    });
    const repository = new AccountRepository(context);

    const initialized = await repository.initialize();
    assert.equal(initialized.length, 1);
    assert.equal(initialized[0].authBlob["cursorAuth/accessToken"], "access-one");
    assert.equal(initialized[0].refreshToken, "refresh-one");
    assert.equal(initialized[0].credentialStatus, CREDENTIAL_STATUS_AVAILABLE);

    const metadata = context.globalState.values.get(ACCOUNT_METADATA_KEY);
    assert.equal(metadata.schemaVersion, ACCOUNT_STORAGE_SCHEMA);
    assert.equal(metadata.accounts[0].credentialSlot, "a");
    assertMetadataHasNoCredentials(metadata);
    const serializedMetadata = JSON.stringify(metadata);
    assert.equal(serializedMetadata.includes("access-one"), false);
    assert.equal(serializedMetadata.includes("refresh-one"), false);
    assert.equal(context.globalState.values.has(PRIMARY_PLAINTEXT_ACCOUNT_KEY), false);
    assert.equal(context.globalState.values.has(LEGACY_ACCOUNT_METADATA_KEY), false);

    const key = accountSecretKey("acc-1", "a");
    const secret = JSON.parse(context.secrets.values.get(key));
    assert.equal(secret.schemaVersion, ACCOUNT_SECRET_SCHEMA);
    assert.equal(secret.accountId, "acc-1");

    const storeIndex = context.events.findIndex(event => event.type === "secret.store" && event.key === key);
    const verifyIndex = context.events.findIndex((event, index) =>
        index > storeIndex && event.type === "secret.get" && event.key === key);
    const commitIndex = context.events.findIndex(event =>
        event.type === "global.update" && event.key === ACCOUNT_METADATA_KEY);
    assert.ok(storeIndex >= 0 && verifyIndex > storeIndex && commitIndex > verifyIndex);

    context.events.length = 0;
    const secondRepository = new AccountRepository(context);
    assert.equal((await secondRepository.initialize()).length, 1);
    assert.equal(context.events.some(event => event.type === "secret.store"), false);
});

test("an explicit empty primary key never falls back to legacy accounts", async () => {
    const context = createContext({
        [PRIMARY_PLAINTEXT_ACCOUNT_KEY]: [],
        [LEGACY_ACCOUNT_METADATA_KEY]: [sampleAccount()]
    });
    const repository = new AccountRepository(context);

    assert.deepEqual(await repository.initialize(), []);
    assert.deepEqual(repository.list(), []);
    assert.equal(
        [...context.secrets.values.keys()].some(key => key.startsWith(ACCOUNT_SECRET_PREFIX)),
        false
    );
    assert.equal(context.globalState.values.has(LEGACY_ACCOUNT_METADATA_KEY), false);

    context.globalState.values.set(LEGACY_ACCOUNT_METADATA_KEY, [sampleAccount("stale")]);
    context.events.length = 0;
    const restarted = new AccountRepository(context);
    assert.deepEqual(await restarted.initialize(), []);
    assert.equal(context.events.some(event => event.type === "secret.store"), false);
    assert.equal(context.globalState.values.has(LEGACY_ACCOUNT_METADATA_KEY), false);
});

test("a present primary list is authoritative and cannot resurrect legacy-only accounts", async () => {
    const primary = sampleAccount("primary");
    const legacyOnly = sampleAccount("legacy");
    legacyOnly.id = "acc-2";
    legacyOnly.userId = "user_456";
    legacyOnly.email = "second@example.com";
    const context = createContext({
        [PRIMARY_PLAINTEXT_ACCOUNT_KEY]: [primary],
        [LEGACY_ACCOUNT_METADATA_KEY]: [primary, legacyOnly]
    });
    const repository = new AccountRepository(context);

    const accounts = await repository.initialize();
    assert.deepEqual(accounts.map(account => account.id), ["acc-1"]);
    assert.equal(accounts.every(account => account.credentialStatus === CREDENTIAL_STATUS_AVAILABLE), true);
    assert.equal(context.globalState.values.has(PRIMARY_PLAINTEXT_ACCOUNT_KEY), false);
    assert.equal(context.globalState.values.has(LEGACY_ACCOUNT_METADATA_KEY), false);
});

test("missing SecretStorage entries preserve metadata and mark credentialStatus", async () => {
    const context = createContext({
        [ACCOUNT_METADATA_KEY]: {
            schemaVersion: ACCOUNT_STORAGE_SCHEMA,
            revision: 7,
            accounts: [{
                id: "acc-missing",
                email: "missing@example.com",
                credentialSlot: "b"
            }]
        }
    });
    const repository = new AccountRepository(context);

    await repository.initialize();
    const account = repository.list()[0];
    assert.equal(account.id, "acc-missing");
    assert.equal(account.email, "missing@example.com");
    assert.equal(account.credentialStatus, CREDENTIAL_STATUS_MISSING);
    assert.equal(account.authBlob, undefined);
});

test("restart restores a referenced missing credential from retained plaintext before cleanup", async () => {
    const plaintext = sampleAccount("recoverable");
    const context = createContext({
        [ACCOUNT_METADATA_KEY]: {
            schemaVersion: ACCOUNT_STORAGE_SCHEMA,
            revision: 4,
            accounts: [{
                id: plaintext.id,
                email: plaintext.email,
                userId: plaintext.userId,
                credentialSlot: "a"
            }]
        },
        [PRIMARY_PLAINTEXT_ACCOUNT_KEY]: [plaintext]
    });
    const repository = new AccountRepository(context);

    const accounts = await repository.initialize();
    assert.equal(accounts[0].credentialStatus, CREDENTIAL_STATUS_AVAILABLE);
    assert.equal(accounts[0].authBlob["cursorAuth/accessToken"], "access-recoverable");
    assert.equal(context.globalState.values.has(PRIMARY_PLAINTEXT_ACCOUNT_KEY), false);
    assert.equal(
        context.secrets.values.has(accountSecretKey(plaintext.id, "a")),
        true
    );
});

test("initialize atomically repoints metadata to a valid retained credential slot", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    await repository.initialize();
    await replaceAccounts(repository, [sampleAccount("one")]);

    const changed = repository.list();
    changed[0].authBlob["cursorAuth/accessToken"] = "access-two";
    changed[0].refreshToken = "refresh-two";
    context.secrets.failDeleteKey = accountSecretKey("acc-1", "a");
    await assert.rejects(repository.save(changed), /failed to delete secret/);
    assert.equal(
        context.globalState.values.get(ACCOUNT_METADATA_KEY).accounts[0].credentialSlot,
        "b"
    );

    context.secrets.values.delete(accountSecretKey("acc-1", "b"));
    const restarted = new AccountRepository(context);
    const accounts = await restarted.initialize();
    assert.equal(accounts[0].authBlob["cursorAuth/accessToken"], "access-one");
    assert.equal(accounts[0].credentialStatus, CREDENTIAL_STATUS_AVAILABLE);
    assert.equal(
        context.globalState.values.get(ACCOUNT_METADATA_KEY).accounts[0].credentialSlot,
        "a"
    );
});

test("save alternates secret slots, commits metadata, and removes the old slot", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    await repository.initialize();
    await replaceAccounts(repository, [sampleAccount("one")]);

    const keyA = accountSecretKey("acc-1", "a");
    const keyB = accountSecretKey("acc-1", "b");
    assert.equal(context.secrets.values.has(keyA), true);
    assert.equal(context.secrets.values.has(keyB), false);

    context.events.length = 0;
    const changed = repository.list();
    changed[0].authBlob["cursorAuth/accessToken"] = "access-two";
    changed[0].authBlob["cursorAuth/refreshToken"] = "refresh-two";
    changed[0].refreshToken = "refresh-two";
    await repository.save(changed);

    const metadata = context.globalState.values.get(ACCOUNT_METADATA_KEY);
    assert.equal(metadata.accounts[0].credentialSlot, "b");
    assert.equal(context.secrets.values.has(keyA), false);
    assert.equal(context.secrets.values.has(keyB), true);
    assert.equal(repository.list()[0].authBlob["cursorAuth/accessToken"], "access-two");

    const stage = context.events.findIndex(event => event.type === "secret.store" && event.key === keyB);
    const commit = context.events.findIndex(event => event.type === "global.update" && event.key === ACCOUNT_METADATA_KEY);
    const cleanup = context.events.findIndex(event => event.type === "secret.delete" && event.key === keyA);
    assert.ok(stage >= 0 && commit > stage && cleanup > commit);
});

test("save calls are serialized and deletion clears both credential slots", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    await repository.initialize();
    await replaceAccounts(repository, [sampleAccount("one")]);
    context.secrets.storeDelayMs = 10;

    const two = repository.list();
    two[0].authBlob["cursorAuth/accessToken"] = "access-two";
    const three = repository.list();
    three[0].authBlob["cursorAuth/accessToken"] = "access-three";
    const results = await Promise.allSettled([
        repository.save(two),
        repository.save(three)
    ]);

    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(results[1].reason.code, "ERR_REVISION_CONFLICT");
    assert.equal(repository.list()[0].authBlob["cursorAuth/accessToken"], "access-two");
    assert.equal(
        context.globalState.values.get(ACCOUNT_METADATA_KEY).accounts[0].credentialSlot,
        "b"
    );

    await replaceAccounts(repository, []);
    assert.deepEqual(repository.list(), []);
    assert.equal(context.secrets.values.has(accountSecretKey("acc-1", "a")), false);
    assert.equal(context.secrets.values.has(accountSecretKey("acc-1", "b")), false);
});

test("mutate applies to the latest committed list and cannot resurrect a removed account", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    await repository.initialize();
    await replaceAccounts(repository, [sampleAccount("one")]);

    const removal = repository.mutate(list =>
        list.filter(account => account.id !== "acc-1")
    );
    const delayedRefreshCommit = repository.mutate(list => {
        const account = list.find(item => item.id === "acc-1");
        if (!account)
            return undefined;
        account.refreshToken = "refresh-rotated";
        return list;
    });
    await Promise.all([removal, delayedRefreshCommit]);

    assert.deepEqual(repository.list(), []);
    assert.equal(context.secrets.values.has(accountSecretKey("acc-1", "a")), false);
    assert.equal(context.secrets.values.has(accountSecretKey("acc-1", "b")), false);
});

test("two repository instances serialize through the shared storage lock and reload revisions", async t => {
    const lockRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cam-account-lock-"));
    t.after(() => fs.promises.rm(lockRoot, { recursive: true, force: true }));
    const context = createContext();
    context.globalStorageUri = { fsPath: lockRoot };
    const first = new AccountRepository(context);
    await first.initialize();
    await replaceAccounts(first, [sampleAccount("one")]);
    const second = new AccountRepository(context);
    await second.initialize();

    await Promise.all([
        first.mutate(list => list.filter(account => account.id !== "acc-1")),
        second.mutate(list => {
            const account = list.find(item => item.id === "acc-1");
            if (!account)
                return undefined;
            account.refreshToken = "must-not-resurrect";
            return list;
        })
    ]);

    assert.deepEqual(first.list(), []);
    assert.deepEqual(second.list(), []);
    assert.equal(context.secrets.values.has(accountSecretKey("acc-1", "a")), false);
    assert.equal(context.secrets.values.has(accountSecretKey("acc-1", "b")), false);
});

test("the on-disk envelope is authoritative across stale per-window globalState caches", async t => {
    const lockRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cam-account-authority-"));
    t.after(() => fs.promises.rm(lockRoot, { recursive: true, force: true }));
    const firstContext = createContext();
    const secondContext = createContext();
    secondContext.secrets = firstContext.secrets;
    firstContext.globalStorageUri = { fsPath: lockRoot };
    secondContext.globalStorageUri = { fsPath: lockRoot };
    const first = new AccountRepository(firstContext);
    const second = new AccountRepository(secondContext);
    await first.initialize();
    await second.initialize();

    await first.mutate(() => [sampleAccount("disk-authority")]);
    await second.mutate(accounts => accounts.map(account => ({
        ...account,
        note: "updated from stale window"
    })));

    const reloaded = new AccountRepository({
        globalState: new MemoryGlobalState(),
        secrets: firstContext.secrets,
        globalStorageUri: { fsPath: lockRoot }
    });
    const accounts = await reloaded.initialize();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].accessToken, "access-disk-authority");
    assert.equal(accounts[0].note, "updated from stale window");
});

test("two repository instances cannot concurrently take over the same stale lock", async t => {
    const lockRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cam-account-stale-lock-"));
    t.after(() => fs.promises.rm(lockRoot, { recursive: true, force: true }));
    const context = createContext();
    context.globalStorageUri = { fsPath: lockRoot };
    const first = new AccountRepository(context);
    const second = new AccountRepository(context);
    const lockPath = path.join(lockRoot, ".cursor-account-manager-accounts.lock");
    await fs.promises.mkdir(lockPath, { mode: 0o700 });
    await fs.promises.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
        schemaVersion: 1,
        kind: "operation",
        pid: 2147483647,
        processStart: null,
        hostname: os.hostname(),
        nonce: "dead-owner",
        createdAt: new Date().toISOString()
    }), { mode: 0o600 });
    let active = 0;
    let maxActive = 0;
    const operation = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        finally {
            active--;
        }
    };

    await Promise.all([
        first._withRepositoryLock(operation),
        second._withRepositoryLock(operation)
    ]);
    assert.equal(maxActive, 1);
});

test("an interrupted stale-lock takeover is recovered without manual deletion", async t => {
    const lockRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cam-account-takeover-recovery-"));
    t.after(() => fs.promises.rm(lockRoot, { recursive: true, force: true }));
    const context = createContext();
    context.globalStorageUri = { fsPath: lockRoot };
    const repository = new AccountRepository(context);
    const owner = suffix => JSON.stringify({
        schemaVersion: 1,
        kind: suffix,
        pid: 2147483647,
        processStart: null,
        hostname: os.hostname(),
        nonce: `dead-${suffix}`,
        createdAt: new Date().toISOString()
    });
    for (const name of [
        ".cursor-account-manager-accounts.lock",
        ".cursor-account-manager-accounts.lock.takeover"
    ]) {
        const directory = path.join(lockRoot, name);
        await fs.promises.mkdir(directory, { mode: 0o700 });
        await fs.promises.writeFile(
            path.join(directory, "owner.json"),
            owner(name.endsWith(".takeover") ? "takeover" : "operation"),
            { mode: 0o600 }
        );
    }

    const lock = await repository._acquireRepositoryLock();
    assert.ok(lock);
    await repository._releaseRepositoryLock(lock);
    await assert.rejects(
        fs.promises.lstat(path.join(lockRoot, ".cursor-account-manager-accounts.lock.takeover")),
        { code: "ENOENT" }
    );
});

test("takeover recovery survives a second crash with interrupted-main present", async t => {
    const lockRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cam-account-second-crash-"));
    t.after(() => fs.promises.rm(lockRoot, { recursive: true, force: true }));
    const context = createContext();
    context.globalStorageUri = { fsPath: lockRoot };
    const repository = new AccountRepository(context);
    const lockBase = ".cursor-account-manager-accounts.lock";
    for (const [name, kind] of [
        [lockBase, "takeover-recovery"],
        [`${lockBase}.takeover`, "takeover"],
        [`${lockBase}.interrupted-main`, "operation"]
    ]) {
        const directory = path.join(lockRoot, name);
        await fs.promises.mkdir(directory, { mode: 0o700 });
        await fs.promises.writeFile(path.join(directory, "owner.json"), JSON.stringify({
            schemaVersion: 1,
            kind,
            pid: 2147483647,
            processStart: null,
            hostname: os.hostname(),
            nonce: `dead-${kind}`,
            createdAt: new Date().toISOString()
        }), { mode: 0o600 });
    }

    const lock = await repository._acquireRepositoryLock();
    await repository._releaseRepositoryLock(lock);
    assert.equal((await fs.promises.readdir(lockRoot)).some(name =>
        name.startsWith(`${lockBase}.interrupted-main`)
    ), false);
});

test("a transient release failure does not permanently self-lock the repository", async t => {
    const lockRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cam-account-release-lock-"));
    t.after(() => fs.promises.rm(lockRoot, { recursive: true, force: true }));
    const context = createContext();
    context.globalStorageUri = { fsPath: lockRoot };
    const repository = new AccountRepository(context);
    const lock = await repository._acquireRepositoryLock();
    const originalRename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
        if (from === lock.lockPath) {
            const error = new Error("injected release failure");
            error.code = "EIO";
            throw error;
        }
        return originalRename.call(fs.promises, from, to);
    };
    try {
        await repository._releaseRepositoryLock(lock);
    }
    finally {
        fs.promises.rename = originalRename;
    }

    const released = await repository._readRepositoryLock(lock.lockPath);
    assert.equal(released.released, true);
    assert.equal(released.stale, true);
    const recovered = await repository._acquireRepositoryLock();
    await repository._releaseRepositoryLock(recovered);
});

test("secret and metadata failures reject without exposing or replacing the old account", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    await repository.initialize();
    await replaceAccounts(repository, [sampleAccount("one")]);

    const changed = repository.list();
    changed[0].authBlob["cursorAuth/accessToken"] = "access-two";
    const keyB = accountSecretKey("acc-1", "b");
    context.secrets.failStoreKey = keyB;
    await assert.rejects(repository.save(changed), /stage account credentials|SecretStorage/);
    assert.equal(repository.list()[0].authBlob["cursorAuth/accessToken"], "access-one");
    assert.equal(
        context.globalState.values.get(ACCOUNT_METADATA_KEY).accounts[0].credentialSlot,
        "a"
    );

    context.globalState.failNext = {
        key: ACCOUNT_METADATA_KEY,
        when: "before"
    };
    await assert.rejects(repository.save(changed), /failed to commit account metadata/);
    assert.equal(repository.list()[0].authBlob["cursorAuth/accessToken"], "access-one");
    assert.equal(
        context.globalState.values.get(ACCOUNT_METADATA_KEY).accounts[0].credentialSlot,
        "a"
    );

    await repository.save(changed);
    assert.equal(repository.list()[0].authBlob["cursorAuth/accessToken"], "access-two");
    assert.equal(
        context.globalState.values.get(ACCOUNT_METADATA_KEY).accounts[0].credentialSlot,
        "b"
    );
});

test("post-commit cleanup failures are reported while the committed state remains usable", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    await repository.initialize();
    await replaceAccounts(repository, [sampleAccount("one")]);

    const changed = repository.list();
    changed[0].authBlob["cursorAuth/accessToken"] = "access-two";
    context.secrets.failDeleteKey = accountSecretKey("acc-1", "a");
    await assert.rejects(repository.save(changed), /failed to delete secret/);

    assert.equal(repository.list()[0].authBlob["cursorAuth/accessToken"], "access-two");
    assert.equal(
        context.globalState.values.get(ACCOUNT_METADATA_KEY).accounts[0].credentialSlot,
        "b"
    );
    assert.deepEqual(
        context.globalState.values.get(PENDING_SECRET_DELETES_KEY).keys,
        [accountSecretKey("acc-1", "a")]
    );

    const restarted = new AccountRepository(context);
    await restarted.initialize();
    assert.equal(context.secrets.values.has(accountSecretKey("acc-1", "a")), false);
    assert.equal(context.globalState.values.has(PENDING_SECRET_DELETES_KEY), false);
});

test("an update error reported after persistence is surfaced without rolling back valid metadata", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    await repository.initialize();
    await replaceAccounts(repository, [sampleAccount("one")]);

    const changed = repository.list();
    changed[0].authBlob["cursorAuth/accessToken"] = "access-two";
    context.globalState.failNext = {
        key: ACCOUNT_METADATA_KEY,
        when: "after"
    };
    await assert.rejects(repository.save(changed), /reported an error after committing metadata/);

    assert.equal(repository.list()[0].authBlob["cursorAuth/accessToken"], "access-two");
    assert.equal(
        context.globalState.values.get(ACCOUNT_METADATA_KEY).accounts[0].credentialSlot,
        "b"
    );
});

test("failed migration verification retains both plaintext storage keys", async () => {
    const oldAccount = sampleAccount();
    const context = createContext({
        [PRIMARY_PLAINTEXT_ACCOUNT_KEY]: [oldAccount],
        [LEGACY_ACCOUNT_METADATA_KEY]: [oldAccount]
    });
    const key = accountSecretKey("acc-1", "a");
    context.secrets.corruptGetKey = key;
    const repository = new AccountRepository(context);

    await assert.rejects(repository.initialize(), /stage account credentials|did not verify/);
    assert.equal(context.globalState.values.has(ACCOUNT_METADATA_KEY), false);
    assert.ok(Array.isArray(context.globalState.values.get(PRIMARY_PLAINTEXT_ACCOUNT_KEY)));
    assert.ok(Array.isArray(context.globalState.values.get(LEGACY_ACCOUNT_METADATA_KEY)));
    assert.equal(context.secrets.values.has(key), false);
});

test("manual token helpers and plaintext configuration migration use SecretStorage", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    const values = new Map([
        ["cursorAccountManager.manualCursorToken", " user::access "],
        ["keepchat.manualCursorToken", "user::access"]
    ]);
    const configuration = {
        get(section, key) {
            return values.get(`${section}.${key}`);
        },
        async clear(section, key) {
            values.delete(`${section}.${key}`);
        }
    };

    const result = await migrateManualTokenFromConfiguration({
        repository,
        configuration
    });
    assert.equal(result.migrated, true);
    assert.equal(result.cleared, 2);
    assert.equal(await repository.getManualToken(), "user::access");
    assert.equal(values.size, 0);
    assert.equal(context.secrets.values.has(MANUAL_TOKEN_SECRET_KEY), true);

    await repository.clearManualCursorToken();
    assert.equal(await repository.getManualCursorToken(), "");
});

test("conflicting plaintext manual token scopes fail without deleting or storing either value", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    const values = new Map([
        ["cursorAccountManager.manualCursorToken", "user-a::access-a"],
        ["keepchat.manualCursorToken", "user-b::access-b"]
    ]);
    const cleared = [];
    const configuration = {
        get(section, key) {
            return values.get(`${section}.${key}`);
        },
        async clear(section, key) {
            cleared.push(`${section}.${key}`);
            values.delete(`${section}.${key}`);
        }
    };

    await assert.rejects(
        migrateManualTokenFromConfiguration({ repository, configuration }),
        error => error && error.code === "ERR_MANUAL_TOKEN_CONFLICT"
    );
    assert.equal(cleared.length, 0);
    assert.equal(values.size, 2);
    assert.equal(context.secrets.values.has(MANUAL_TOKEN_SECRET_KEY), false);
});

test("manual token verification failure rolls back SecretStorage and retains plaintext config", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    const values = new Map([
        ["cursorAccountManager.manualCursorToken", "user::access"]
    ]);
    context.secrets.corruptGetKey = MANUAL_TOKEN_SECRET_KEY;
    const configuration = {
        get(section, key) {
            return values.get(`${section}.${key}`);
        },
        async clear(section, key) {
            values.delete(`${section}.${key}`);
        }
    };

    await assert.rejects(
        migrateManualTokenFromConfiguration({ repository, configuration }),
        /did not verify/
    );
    assert.equal(values.get("cursorAccountManager.manualCursorToken"), "user::access");
    assert.equal(context.secrets.values.has(MANUAL_TOKEN_SECRET_KEY), false);
});

test("plaintext cleanup failure is surfaced and the uncleared setting remains recoverable", async () => {
    const context = createContext();
    const repository = new AccountRepository(context);
    const values = new Map([
        ["cursorAccountManager.manualCursorToken", "user::access"]
    ]);
    const configuration = {
        get(section, key) {
            return values.get(`${section}.${key}`);
        },
        async clear() {
            throw new Error("injected configuration cleanup failure");
        }
    };

    await assert.rejects(
        migrateManualTokenFromConfiguration({ repository, configuration }),
        /cleanup failure/
    );
    assert.equal(values.get("cursorAccountManager.manualCursorToken"), "user::access");
    assert.equal(await repository.getManualToken(), "user::access");
});
