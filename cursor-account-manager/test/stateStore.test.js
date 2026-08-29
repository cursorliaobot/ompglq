'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    AUTH_KEYS,
    CursorStateStore,
    buildAuthEntries,
    extractAuthEntries,
    replaceAuthEntries
} = require('../src/cursorStateStore');

const fsp = fs.promises;

class FakeSQLiteAdapter {
    constructor() {
        this.databases = new Map();
        this.writeDelayMs = 0;
        this.activeWrites = 0;
        this.maxActiveWrites = 0;
        this.backupCalls = 0;
        this.quickCheckCalls = 0;
        this.beforeReplace = null;
        this.afterReplace = null;
    }

    key(dbPath) {
        return path.resolve(dbPath);
    }

    seed(dbPath, entries) {
        this.databases.set(this.key(dbPath), { ...entries });
    }

    async readKeys(dbPath, keys) {
        const source = this.databases.get(this.key(dbPath));
        if (!source)
            throw new Error('fake database not found: ' + dbPath);
        const result = {};
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(source, key))
                result[key] = source[key];
        }
        return result;
    }

    async readKeysByPrefixes(dbPath, prefixes) {
        const source = this.databases.get(this.key(dbPath));
        if (!source)
            throw new Error('fake database not found: ' + dbPath);
        return Object.fromEntries(
            Object.entries(source).filter(([key]) =>
                prefixes.some(prefix => key.startsWith(prefix)))
        );
    }

    async replaceKeys(dbPath, keys, entries, options = {}) {
        const dbKey = this.key(dbPath);
        let source = this.databases.get(dbKey);
        if (!source)
            throw new Error('fake database not found: ' + dbPath);
        this.activeWrites++;
        this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
        try {
            if (this.writeDelayMs)
                await new Promise(resolve => setTimeout(resolve, this.writeDelayMs));
            if (this.beforeReplace) {
                const hook = this.beforeReplace;
                this.beforeReplace = null;
                await hook();
            }
            if (options.expectedEntries) {
                const current = await this.readKeys(dbPath, keys);
                for (const key of keys) {
                    const expectedHas = Object.prototype.hasOwnProperty.call(options.expectedEntries, key);
                    const currentHas = Object.prototype.hasOwnProperty.call(current, key);
                    if (expectedHas !== currentHas ||
                        (expectedHas && options.expectedEntries[key] !== current[key])) {
                        const error = new Error('fake SQLite revision conflict');
                        error.code = 'REVISION_CONFLICT';
                        throw error;
                    }
                }
            }
            source = this.databases.get(dbKey);
            const next = { ...source };
            for (const key of keys)
                delete next[key];
            Object.assign(next, entries);
            this.databases.set(dbKey, next);
            if (this.afterReplace) {
                const hook = this.afterReplace;
                this.afterReplace = null;
                await hook();
            }
            return this.readKeys(dbPath, keys);
        }
        finally {
            this.activeWrites--;
        }
    }

    async backup(dbPath, destinationPath) {
        const source = this.databases.get(this.key(dbPath));
        if (!source)
            throw new Error('fake database not found: ' + dbPath);
        this.backupCalls++;
        await fsp.writeFile(destinationPath, 'safe-fake-sqlite-backup', { mode: 0o600, flag: 'wx' });
        this.databases.set(this.key(destinationPath), { ...source });
        return { ok: true, path: destinationPath };
    }

    async quickCheck(dbPath) {
        this.quickCheckCalls++;
        if (!this.databases.has(this.key(dbPath)))
            throw new Error('fake quick_check failed');
        return { ok: true };
    }
}

async function fixture(t, options = {}) {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'cam-store-'));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    const dbPath = path.join(directory, 'state.vscdb');
    const storagePath = path.join(directory, 'storage.json');
    await fsp.writeFile(dbPath, 'fake-live-db', { mode: 0o600 });
    const initialDbAuth = {
        'cursorAuth/accessToken': 'token-a',
        'cursorAuth/userId': 'user-a',
        'cursorAuth/cachedEmail': 'a@example.com'
    };
    const initialJson = {
        'cursorAuth/accessToken': 'token-a',
        'cursorAuth/userId': 'user-a',
        'cursorAuth/cachedEmail': 'a@example.com',
        'workbench.colorTheme': 'Dark Modern',
        'telemetry.machineId': 'must-stay',
        nested: { enabled: true, count: 3 }
    };
    await fsp.writeFile(storagePath, JSON.stringify(initialJson, null, 2), { mode: 0o600 });
    const sqlite = options.sqlite || new FakeSQLiteAdapter();
    sqlite.seed(dbPath, initialDbAuth);
    const store = new CursorStateStore({
        storageDir: directory,
        sqliteAdapter: sqlite,
        maxBackups: options.maxBackups || 5,
        onPhase: options.onPhase,
        lockTimeoutMs: 2000
    });
    return {
        directory,
        dbPath,
        storagePath,
        sqlite,
        store,
        initialDbAuth,
        initialJson
    };
}

function targetB() {
    return {
        userId: 'user-b',
        email: 'b@example.com',
        accessToken: 'token-b',
        refreshToken: 'refresh-b',
        type: 'pro'
    };
}

test('AUTH_KEYS 是固定鉴权 allowlist，不包含 UI/遥测/cursorai 键', () => {
    assert.ok(Object.isFrozen(AUTH_KEYS));
    assert.ok(AUTH_KEYS.includes('cursorAuth/accessToken'));
    assert.ok(AUTH_KEYS.includes('workos.sessionToken'));
    for (const key of AUTH_KEYS)
        assert.doesNotMatch(key, /^(?:workbench|telemetry|cursorai)(?:[./]|$)/i);
});

test('buildAuthEntries 只构造 allowlist 键并核对 JWT 身份', () => {
    const entries = buildAuthEntries(targetB(), {
        timestamp: '2026-08-29T00:00:00.000Z'
    });
    assert.equal(entries['cursorAuth/accessToken'], 'token-b');
    assert.equal(entries['cursorAuth/userId'], 'user-b');
    assert.equal(entries['workos.sessionToken'], 'user-b::token-b');
    assert.ok(Object.keys(entries).every(key => AUTH_KEYS.includes(key)));

    const payload = Buffer.from(JSON.stringify({ userId: 'different-user' })).toString('base64url');
    assert.throws(
        () => buildAuthEntries({ userId: 'user-b', accessToken: `a.${payload}.c` }),
        error => error && error.code === 'TARGET_IDENTITY_MISMATCH'
    );

    const alternateNamespace = Buffer.from(JSON.stringify({
        sub: 'auth0|different-but-compatible',
        email: 'b@example.com'
    })).toString('base64url');
    assert.doesNotThrow(() =>
        buildAuthEntries({
            userId: 'user-b',
            email: 'b@example.com',
            accessToken: `a.${alternateNamespace}.c`
        })
    );
});

test('未知 Cursor 鉴权键会在任何写入前安全拒绝', async t => {
    const ctx = await fixture(t);
    const database = ctx.sqlite.databases.get(ctx.sqlite.key(ctx.dbPath));
    database['cursor.tokenV2'] = 'must-not-touch';
    const before = { ...database };

    await assert.rejects(
        ctx.store.switchAccount(targetB()),
        error => error && error.code === 'UNKNOWN_AUTH_KEYS'
    );

    assert.deepEqual(ctx.sqlite.databases.get(ctx.sqlite.key(ctx.dbPath)), before);
    assert.equal(ctx.sqlite.backupCalls, 0);
});

test('未知 WorkOS JSON 会话键会在备份前安全拒绝', async t => {
    const ctx = await fixture(t);
    const storage = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
    storage['workos.sessionTokenV2'] = 'must-not-touch';
    await fsp.writeFile(ctx.storagePath, JSON.stringify(storage, null, 2), { mode: 0o600 });

    await assert.rejects(
        ctx.store.switchAccount(targetB()),
        error => error && error.code === 'UNKNOWN_AUTH_KEYS'
    );
    assert.equal(ctx.sqlite.backupCalls, 0);
});

test('switchAccount 备份双文件、精确换键并保留所有非鉴权 JSON 键', async t => {
    const ctx = await fixture(t);
    const result = await ctx.store.switchAccount(targetB());

    assert.equal(result.ok, true);
    assert.equal(ctx.sqlite.backupCalls, 1);
    const databaseAuth = await ctx.sqlite.readKeys(ctx.dbPath, AUTH_KEYS);
    const storage = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
    assert.equal(databaseAuth['cursorAuth/accessToken'], 'token-b');
    assert.equal(databaseAuth['cursorAuth/userId'], 'user-b');
    assert.equal(storage['cursorAuth/accessToken'], 'token-b');
    assert.equal(storage['workbench.colorTheme'], 'Dark Modern');
    assert.equal(storage['telemetry.machineId'], 'must-stay');
    assert.deepEqual(storage.nested, { enabled: true, count: 3 });
    assert.deepEqual(extractAuthEntries(storage), databaseAuth);
    assert.equal((await fsp.stat(ctx.storagePath)).mode & 0o777, 0o600);

    const backupDirectory = path.join(
        ctx.directory,
        '.cursor-account-manager-backups',
        result.backupName
    );
    assert.equal((await fsp.stat(backupDirectory)).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(path.join(backupDirectory, 'state.vscdb'))).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(path.join(backupDirectory, 'storage.json'))).mode & 0o777, 0o600);
});

test('SQLite 写入期间出现的并发非鉴权 JSON 更新会合并保留', async t => {
    const ctx = await fixture(t);
    ctx.store.onPhase = async name => {
        if (name !== 'sqlite-written')
            return;
        const latest = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
        latest['workbench.colorTheme'] = 'Changed During Switch';
        latest.concurrentState = { revision: 2 };
        await fsp.writeFile(ctx.storagePath, JSON.stringify(latest, null, 2), { mode: 0o600 });
    };

    const result = await ctx.store.switchAccount(targetB());
    assert.equal(result.ok, true);
    const storage = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
    assert.equal(storage['cursorAuth/accessToken'], 'token-b');
    assert.equal(storage['workbench.colorTheme'], 'Changed During Switch');
    assert.deepEqual(storage.concurrentState, { revision: 2 });
});

test('JSON 阶段失败时回滚 SQLite 与 JSON 鉴权快照', async t => {
    const ctx = await fixture(t, {
        onPhase(name) {
            if (name === 'json-written')
                throw new Error('injected json-stage failure');
        }
    });

    await assert.rejects(
        ctx.store.switchAccount(targetB()),
        error => error && error.code === 'SWITCH_FAILED_ROLLED_BACK' && error.rolledBack
    );

    assert.deepEqual(await ctx.sqlite.readKeys(ctx.dbPath, AUTH_KEYS), ctx.initialDbAuth);
    const storage = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
    assert.deepEqual(extractAuthEntries(storage), extractAuthEntries(ctx.initialJson));
    assert.equal(storage['workbench.colorTheme'], 'Dark Modern');
    await assert.rejects(
        fsp.access(path.join(ctx.directory, '.cursor-account-manager-switch-journal.json')),
        error => error && error.code === 'ENOENT'
    );
});

test('进程在 SQLite 提交后中断时，下次 recover 回滚未提交切号', async t => {
    const sqlite = new FakeSQLiteAdapter();
    const ctx = await fixture(t, {
        sqlite,
        onPhase(name) {
            if (name === 'sqlite-written') {
                const error = new Error('simulated process death');
                error.simulateCrash = true;
                throw error;
            }
        }
    });

    await assert.rejects(
        ctx.store.switchAccount(targetB()),
        error => error && error.code === 'SWITCH_INTERRUPTED' && error.recoveryRequired
    );
    assert.equal(
        (await sqlite.readKeys(ctx.dbPath, AUTH_KEYS))['cursorAuth/accessToken'],
        'token-b'
    );
    assert.equal(
        JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'))['cursorAuth/accessToken'],
        'token-a'
    );

    const recoveringStore = new CursorStateStore({
        storageDir: ctx.directory,
        sqliteAdapter: sqlite
    });
    const recovered = await recoveringStore.recover();
    assert.equal(recovered.action, 'rolled-back');
    assert.deepEqual(await sqlite.readKeys(ctx.dbPath, AUTH_KEYS), ctx.initialDbAuth);
    const storage = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
    assert.deepEqual(extractAuthEntries(storage), extractAuthEntries(ctx.initialJson));
    assert.equal(storage['telemetry.machineId'], 'must-stay');
});

test('recover 遇到 journal 外的新登录态时零写入并保留 journal', async t => {
    const sqlite = new FakeSQLiteAdapter();
    const ctx = await fixture(t, {
        sqlite,
        onPhase(name) {
            if (name === 'sqlite-written') {
                const error = new Error('simulated process death');
                error.simulateCrash = true;
                throw error;
            }
        }
    });
    await assert.rejects(ctx.store.switchAccount(targetB()));
    const external = buildAuthEntries({
        userId: 'user-c',
        email: 'c@example.com',
        accessToken: 'token-c',
        refreshToken: 'refresh-c'
    }, { timestamp: '2026-08-29T02:00:00.000Z' });
    await sqlite.replaceKeys(ctx.dbPath, AUTH_KEYS, external);
    const storage = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
    await fsp.writeFile(
        ctx.storagePath,
        JSON.stringify(replaceAuthEntries(storage, external), null, 2),
        { mode: 0o600 }
    );

    const recoveringStore = new CursorStateStore({
        storageDir: ctx.directory,
        sqliteAdapter: sqlite
    });
    await assert.rejects(
        recoveringStore.recover(),
        error => error &&
            error.code === 'RECOVERY_FAILED' &&
            error.cause &&
            error.cause.code === 'RECOVERY_CONFLICT'
    );
    assert.equal(
        (await sqlite.readKeys(ctx.dbPath, AUTH_KEYS))['cursorAuth/accessToken'],
        'token-c'
    );
    assert.equal(
        JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'))['cursorAuth/accessToken'],
        'token-c'
    );
    await fsp.access(path.join(ctx.directory, '.cursor-account-manager-switch-journal.json'));
});

test('recover 第二阶段出现 JSON 冲突时会补偿已回滚的 SQLite', async t => {
    const sqlite = new FakeSQLiteAdapter();
    const ctx = await fixture(t, {
        sqlite,
        onPhase(name) {
            if (name === 'json-written') {
                const error = new Error('simulated process death');
                error.simulateCrash = true;
                throw error;
            }
        }
    });
    await assert.rejects(ctx.store.switchAccount(targetB()));
    const external = buildAuthEntries({
        userId: 'user-c',
        email: 'c@example.com',
        accessToken: 'token-c'
    }, { timestamp: '2026-08-29T02:00:00.000Z' });
    sqlite.afterReplace = async () => {
        const current = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
        await fsp.writeFile(
            ctx.storagePath,
            JSON.stringify(replaceAuthEntries(current, external), null, 2),
            { mode: 0o600 }
        );
    };

    const recoveringStore = new CursorStateStore({
        storageDir: ctx.directory,
        sqliteAdapter: sqlite
    });
    await assert.rejects(
        recoveringStore.recover(),
        error => error &&
            error.code === 'RECOVERY_FAILED' &&
            error.cause &&
            error.cause.code === 'CONCURRENT_AUTH_UPDATE'
    );
    assert.equal(
        (await sqlite.readKeys(ctx.dbPath, AUTH_KEYS))['cursorAuth/accessToken'],
        'token-b'
    );
    assert.equal(
        JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'))['cursorAuth/accessToken'],
        'token-c'
    );
});

test('SQLite 事务内前像冲突不会覆盖并发登录更新', async t => {
    const sqlite = new FakeSQLiteAdapter();
    const ctx = await fixture(t, { sqlite });
    const external = buildAuthEntries({
        userId: 'user-c',
        email: 'c@example.com',
        accessToken: 'token-c'
    }, { timestamp: '2026-08-29T02:00:00.000Z' });
    sqlite.beforeReplace = async () => {
        const current = sqlite.databases.get(sqlite.key(ctx.dbPath));
        sqlite.databases.set(sqlite.key(ctx.dbPath), {
            ...current,
            ...external
        });
    };

    await assert.rejects(
        ctx.store.switchAccount(targetB()),
        error => error &&
            error.code === 'CONCURRENT_AUTH_UPDATE' &&
            error.details.retryable
    );
    assert.equal(
        (await sqlite.readKeys(ctx.dbPath, AUTH_KEYS))['cursorAuth/accessToken'],
        'token-c'
    );
    await assert.rejects(
        fsp.access(path.join(ctx.directory, '.cursor-account-manager-switch-journal.json')),
        { code: 'ENOENT' }
    );
});

test('committed journal 遗留时 recover 完成提交而不误回滚', async t => {
    const sqlite = new FakeSQLiteAdapter();
    const ctx = await fixture(t, {
        sqlite,
        onPhase(name) {
            if (name === 'committed') {
                const error = new Error('simulated death after commit marker');
                error.simulateCrash = true;
                throw error;
            }
        }
    });

    await assert.rejects(
        ctx.store.switchAccount(targetB()),
        error => error && error.code === 'SWITCH_INTERRUPTED'
    );
    const rotated = buildAuthEntries({
        ...targetB(),
        accessToken: 'token-rotated',
        refreshToken: 'refresh-rotated'
    }, {
        timestamp: '2026-08-29T01:00:00.000Z'
    });
    await sqlite.replaceKeys(ctx.dbPath, AUTH_KEYS, rotated);
    const currentStorage = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
    await fsp.writeFile(
        ctx.storagePath,
        JSON.stringify(replaceAuthEntries(currentStorage, rotated), null, 2),
        { mode: 0o600 }
    );
    const recoveringStore = new CursorStateStore({
        storageDir: ctx.directory,
        sqliteAdapter: sqlite
    });
    const recovered = await recoveringStore.recover();
    assert.equal(recovered.action, 'finalized-commit');
    assert.equal(
        (await sqlite.readKeys(ctx.dbPath, AUTH_KEYS))['cursorAuth/accessToken'],
        'token-rotated'
    );
    assert.equal(
        JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'))['cursorAuth/accessToken'],
        'token-rotated'
    );
});

test('restoreLatest 恢复最近备份的鉴权且保留当前非鉴权数据', async t => {
    const ctx = await fixture(t);
    const switched = await ctx.store.switchAccount(targetB());
    const current = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
    current['workbench.colorTheme'] = 'New Theme';
    current.extraAfterSwitch = { keep: true };
    await fsp.writeFile(ctx.storagePath, JSON.stringify(current, null, 2), { mode: 0o600 });

    const restored = await ctx.store.restoreLatest({
        backupName: switched.backupName
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.restoredFrom, switched.backupName);
    const databaseAuth = await ctx.sqlite.readKeys(ctx.dbPath, AUTH_KEYS);
    const storage = JSON.parse(await fsp.readFile(ctx.storagePath, 'utf8'));
    assert.deepEqual(databaseAuth, ctx.initialDbAuth);
    assert.deepEqual(extractAuthEntries(storage), extractAuthEntries(ctx.initialJson));
    assert.equal(storage['workbench.colorTheme'], 'New Theme');
    assert.deepEqual(storage.extraAfterSwitch, { keep: true });
});

test('restoreLatest 默认选择最近完成的备份', async t => {
    const ctx = await fixture(t);
    await ctx.store.switchAccount(targetB());
    await new Promise(resolve => setTimeout(resolve, 5));
    await ctx.store.switchAccount({
        userId: 'user-c',
        email: 'c@example.com',
        accessToken: 'token-c'
    });

    const restored = await ctx.store.restoreLatest();
    assert.equal(restored.ok, true);
    const databaseAuth = await ctx.sqlite.readKeys(ctx.dbPath, AUTH_KEYS);
    assert.equal(databaseAuth['cursorAuth/userId'], 'user-b');
    assert.equal(databaseAuth['cursorAuth/accessToken'], 'token-b');
});

test('切号前拒绝符号链接 state.vscdb，且不触碰链接目标', async t => {
    const ctx = await fixture(t);
    const outsideDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'cam-outside-'));
    t.after(() => fsp.rm(outsideDirectory, { recursive: true, force: true }));
    const outsideDb = path.join(outsideDirectory, 'outside.vscdb');
    await fsp.writeFile(outsideDb, 'outside-data', { mode: 0o600 });
    await fsp.unlink(ctx.dbPath);
    await fsp.symlink(outsideDb, ctx.dbPath);

    await assert.rejects(
        ctx.store.switchAccount(targetB()),
        error => error && (
            error.code === 'SYMLINK_REJECTED' ||
            error.cause && error.cause.code === 'SYMLINK_REJECTED'
        )
    );
    assert.equal(await fsp.readFile(outsideDb, 'utf8'), 'outside-data');
    assert.equal(ctx.sqlite.backupCalls, 0);
});

test('操作锁将同一实例的并发切号串行化', async t => {
    const sqlite = new FakeSQLiteAdapter();
    sqlite.writeDelayMs = 20;
    const ctx = await fixture(t, { sqlite });

    await Promise.all([
        ctx.store.switchAccount(targetB()),
        ctx.store.switchAccount({
            userId: 'user-c',
            email: 'c@example.com',
            accessToken: 'token-c'
        })
    ]);

    assert.equal(sqlite.maxActiveWrites, 1);
    assert.equal(
        (await sqlite.readKeys(ctx.dbPath, AUTH_KEYS))['cursorAuth/userId'],
        'user-c'
    );
});

test('recover 会立即接管已死亡进程留下的新鲜锁', async t => {
    const ctx = await fixture(t);
    const lockPath = path.join(
        ctx.directory,
        '.cursor-account-manager-switch.lock'
    );
    await fsp.writeFile(lockPath, JSON.stringify({
        version: 1,
        lockId: 'dead-owner',
        pid: 2147483647,
        createdAt: new Date().toISOString()
    }), { mode: 0o600 });

    const recovered = await ctx.store.recover();
    assert.deepEqual(recovered, { ok: true, recovered: false });
    await assert.rejects(
        fsp.access(lockPath),
        error => error && error.code === 'ENOENT'
    );
});

test('recover 会清理死亡 takeover，并用进程启动标识识别 PID 复用', async t => {
    const ctx = await fixture(t);
    const lockPath = path.join(
        ctx.directory,
        '.cursor-account-manager-switch.lock'
    );
    const takeoverPath = `${lockPath}.takeover`;
    await fsp.writeFile(takeoverPath, JSON.stringify({
        version: 1,
        kind: 'stale-lock-takeover',
        lockId: 'dead-takeover',
        pid: 2147483647,
        processStart: null,
        hostname: os.hostname(),
        createdAt: new Date().toISOString()
    }), { mode: 0o600 });
    assert.deepEqual(await ctx.store.recover(), { ok: true, recovered: false });
    await assert.rejects(fsp.access(takeoverPath), { code: 'ENOENT' });

    if (process.platform === 'linux') {
        await fsp.writeFile(lockPath, JSON.stringify({
            version: 1,
            kind: 'operation',
            lockId: 'reused-pid',
            pid: process.pid,
            processStart: '0',
            hostname: os.hostname(),
            createdAt: new Date().toISOString()
        }), { mode: 0o600 });
        assert.deepEqual(await ctx.store.recover(), { ok: true, recovered: false });
        await assert.rejects(fsp.access(lockPath), { code: 'ENOENT' });
    }
});

test('两个实例并发接管死亡锁时仍只允许一个操作进入临界区', async t => {
    const ctx = await fixture(t);
    const lockPath = path.join(
        ctx.directory,
        '.cursor-account-manager-switch.lock'
    );
    await fsp.writeFile(lockPath, JSON.stringify({
        version: 1,
        lockId: 'dead-owner',
        pid: 2147483647,
        createdAt: new Date().toISOString()
    }), { mode: 0o600 });
    const secondStore = new CursorStateStore({
        storageDir: ctx.directory,
        sqliteAdapter: ctx.sqlite,
        lockTimeoutMs: 2000
    });
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
        ctx.store._withOperationLock('并发接管一', operation),
        secondStore._withOperationLock('并发接管二', operation)
    ]);
    assert.equal(maxActive, 1);
});

test('备份数量按 maxBackups 清理，保留文件权限不放宽', async t => {
    const ctx = await fixture(t, { maxBackups: 2 });
    await ctx.store.switchAccount(targetB());
    await ctx.store.switchAccount({
        userId: 'user-c',
        email: 'c@example.com',
        accessToken: 'token-c'
    });
    await ctx.store.switchAccount({
        userId: 'user-d',
        email: 'd@example.com',
        accessToken: 'token-d'
    });

    const backups = await ctx.store.listBackups();
    assert.equal(backups.length, 2);
    for (const backup of backups) {
        const backupDirectory = path.join(
            ctx.directory,
            '.cursor-account-manager-backups',
            backup.name
        );
        assert.equal((await fsp.stat(backupDirectory)).mode & 0o777, 0o700);
        assert.equal(
            (await fsp.stat(path.join(backupDirectory, 'manifest.json'))).mode & 0o777,
            0o600
        );
    }
});
