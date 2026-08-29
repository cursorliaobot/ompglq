'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SQLiteAdapter } = require('../src/sqliteAdapter');

const fsp = fs.promises;

class FakeBetterDatabase {
    constructor(dbPath) {
        this.path = path.resolve(dbPath);
        this.tx = null;
        if (!FakeBetterDatabase.databases.has(this.path))
            throw new Error('SQLITE_CANTOPEN');
        FakeBetterDatabase.log.push(['open', this.path]);
    }

    pragma(value) {
        FakeBetterDatabase.log.push(['pragma', value]);
    }

    current() {
        return this.tx || FakeBetterDatabase.databases.get(this.path);
    }

    exec(sql) {
        const normalized = sql.trim().toUpperCase();
        FakeBetterDatabase.log.push(['exec', normalized]);
        if (normalized === 'BEGIN IMMEDIATE') {
            this.tx = { ...FakeBetterDatabase.databases.get(this.path) };
            return;
        }
        if (normalized === 'COMMIT') {
            FakeBetterDatabase.databases.set(this.path, this.tx);
            this.tx = null;
            return;
        }
        if (normalized === 'ROLLBACK') {
            this.tx = null;
            return;
        }
        throw new Error('unsupported exec: ' + sql);
    }

    prepare(sql) {
        const normalized = sql.trim().toUpperCase();
        if (normalized === 'PRAGMA QUICK_CHECK') {
            return {
                all: () => [{ quick_check: FakeBetterDatabase.corrupt.has(this.path) ? 'corrupt' : 'ok' }]
            };
        }
        if (normalized.startsWith('SELECT KEY, VALUE FROM ITEMTABLE')) {
            return {
                get: key => {
                    const source = this.current();
                    return Object.prototype.hasOwnProperty.call(source, key)
                        ? { key, value: source[key] }
                        : undefined;
                },
                all: (...keys) => {
                    FakeBetterDatabase.selectAllCalls++;
                    const source = this.current();
                    return keys
                        .filter(key => Object.prototype.hasOwnProperty.call(source, key))
                        .map(key => ({ key, value: source[key] }));
                }
            };
        }
        if (normalized.startsWith('DELETE FROM ITEMTABLE')) {
            return {
                run: key => {
                    delete this.current()[key];
                    return { changes: 1 };
                }
            };
        }
        if (normalized.startsWith('INSERT INTO ITEMTABLE')) {
            return {
                run: (key, value) => {
                    if (FakeBetterDatabase.failOnKey === key)
                        throw new Error('injected insert failure');
                    this.current()[key] = value;
                    return { changes: 1 };
                }
            };
        }
        throw new Error('unsupported prepare: ' + sql);
    }

    async backup(destinationPath) {
        const destination = path.resolve(destinationPath);
        FakeBetterDatabase.backupCalls++;
        await fsp.writeFile(destination, 'fake-better-backup', { mode: 0o600, flag: 'wx' });
        FakeBetterDatabase.databases.set(destination, {
            ...FakeBetterDatabase.databases.get(this.path)
        });
    }

    close() {
        FakeBetterDatabase.log.push(['close', this.path]);
    }

    static reset() {
        this.databases = new Map();
        this.corrupt = new Set();
        this.log = [];
        this.failOnKey = '';
        this.backupCalls = 0;
        this.selectAllCalls = 0;
    }
}
FakeBetterDatabase.reset();

class FakeSqlite3Database {
    constructor(dbPath, _mode, callback) {
        this.path = path.resolve(dbPath);
        this.tx = null;
        FakeSqlite3Database.log.push(['open', this.path]);
        queueMicrotask(() => callback(
            FakeSqlite3Database.databases.has(this.path)
                ? null
                : new Error('SQLITE_CANTOPEN')
        ));
    }

    current() {
        return this.tx || FakeSqlite3Database.databases.get(this.path);
    }

    run(sql, params, callback) {
        const normalized = sql.trim().toUpperCase();
        FakeSqlite3Database.log.push(['run', normalized]);
        queueMicrotask(() => {
            try {
                if (normalized.startsWith('PRAGMA BUSY_TIMEOUT')) {
                    callback.call({ changes: 0 }, null);
                    return;
                }
                if (normalized.startsWith('DELETE FROM ITEMTABLE')) {
                    delete this.current()[params[0]];
                    callback.call({ changes: 1 }, null);
                    return;
                }
                if (normalized.startsWith('INSERT INTO ITEMTABLE')) {
                    if (FakeSqlite3Database.failOnKey === params[0])
                        throw new Error('injected sqlite3 insert failure');
                    this.current()[params[0]] = params[1];
                    callback.call({ changes: 1 }, null);
                    return;
                }
                throw new Error('unsupported run: ' + sql);
            }
            catch (error) {
                callback.call({ changes: 0 }, error);
            }
        });
        return this;
    }

    exec(sql, callback) {
        const normalized = sql.trim().toUpperCase();
        FakeSqlite3Database.log.push(['exec', normalized]);
        if (normalized === 'BEGIN IMMEDIATE') {
            this.tx = { ...FakeSqlite3Database.databases.get(this.path) };
            queueMicrotask(() => callback(null));
            return this;
        }
        if (normalized === 'COMMIT') {
            FakeSqlite3Database.databases.set(this.path, this.tx);
            this.tx = null;
            queueMicrotask(() => callback(null));
            return this;
        }
        if (normalized === 'ROLLBACK') {
            this.tx = null;
            queueMicrotask(() => callback(null));
            return this;
        }
        const vacuum = sql.match(/VACUUM\s+INTO\s+'((?:''|[^'])*)'/i);
        if (vacuum) {
            const destination = path.resolve(vacuum[1].replace(/''/g, "'"));
            const snapshot = { ...FakeSqlite3Database.databases.get(this.path) };
            fsp.writeFile(destination, 'fake-sqlite3-backup', { mode: 0o600, flag: 'wx' })
                .then(() => {
                    FakeSqlite3Database.databases.set(destination, snapshot);
                    FakeSqlite3Database.vacuumCalls++;
                    callback(null);
                }, callback);
            return this;
        }
        queueMicrotask(() => callback(new Error('unsupported exec: ' + sql)));
        return this;
    }

    get(sql, params, callback) {
        const normalized = sql.trim().toUpperCase();
        queueMicrotask(() => {
            if (!normalized.startsWith('SELECT KEY, VALUE FROM ITEMTABLE')) {
                callback(new Error('unsupported get: ' + sql));
                return;
            }
            const key = params[0];
            const source = this.current();
            callback(null, Object.prototype.hasOwnProperty.call(source, key)
                ? { key, value: source[key] }
                : undefined);
        });
        return this;
    }

    all(sql, params, callback) {
        const normalized = sql.trim().toUpperCase();
        queueMicrotask(() => {
            if (normalized.startsWith('SELECT KEY, VALUE FROM ITEMTABLE')) {
                FakeSqlite3Database.selectAllCalls++;
                const source = this.current();
                callback(null, params
                    .filter(key => Object.prototype.hasOwnProperty.call(source, key))
                    .map(key => ({ key, value: source[key] })));
                return;
            }
            if (normalized !== 'PRAGMA QUICK_CHECK') {
                callback(new Error('unsupported all: ' + sql));
                return;
            }
            callback(null, [{
                quick_check: FakeSqlite3Database.corrupt.has(this.path) ? 'corrupt' : 'ok'
            }]);
        });
        return this;
    }

    close(callback) {
        FakeSqlite3Database.log.push(['close', this.path]);
        queueMicrotask(() => callback(null));
    }

    static reset() {
        this.databases = new Map();
        this.corrupt = new Set();
        this.log = [];
        this.failOnKey = '';
        this.vacuumCalls = 0;
        this.selectAllCalls = 0;
    }
}
FakeSqlite3Database.reset();

async function databaseFixture(t, prefix) {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    const dbPath = path.join(directory, 'state.vscdb');
    await fsp.writeFile(dbPath, 'fake-db', { mode: 0o600 });
    return { directory, dbPath };
}

test('两种适配器都用单条查询读取多键快照', async t => {
    const fixtures = [
        {
            kind: 'better',
            Database: FakeBetterDatabase,
            reset: () => FakeBetterDatabase.reset(),
            count: () => FakeBetterDatabase.selectAllCalls
        },
        {
            kind: 'sqlite3',
            Database: FakeSqlite3Database,
            reset: () => FakeSqlite3Database.reset(),
            count: () => FakeSqlite3Database.selectAllCalls
        }
    ];
    for (const fixture of fixtures) {
        fixture.reset();
        const { dbPath } = await databaseFixture(t, `cam-snapshot-${fixture.kind}-`);
        fixture.Database.databases.set(path.resolve(dbPath), {
            authA: 'a',
            authB: 'b',
            untouched: 'keep'
        });
        const descriptor = fixture.kind === 'better'
            ? { kind: 'better', mod: fixture.Database }
            : { kind: 'sqlite3', mod: { Database: fixture.Database, OPEN_READONLY: 1 } };
        const adapter = new SQLiteAdapter(descriptor);
        assert.deepEqual(await adapter.readKeys(dbPath, ['authA', 'authB']), {
            authA: 'a',
            authB: 'b'
        });
        assert.equal(fixture.count(), 1);
    }
});

test('better-sqlite3 精确多键写使用显式事务、读回并回滚失败点', async t => {
    FakeBetterDatabase.reset();
    const { dbPath } = await databaseFixture(t, 'cam-better-');
    FakeBetterDatabase.databases.set(path.resolve(dbPath), {
        authA: 'old-a',
        authB: 'old-b',
        untouched: 'keep'
    });
    const adapter = new SQLiteAdapter({
        kind: 'better',
        mod: FakeBetterDatabase
    });

    await adapter.replaceKeys(dbPath, ['authA', 'authB'], { authA: 'new-a' });
    assert.deepEqual(FakeBetterDatabase.databases.get(path.resolve(dbPath)), {
        authA: 'new-a',
        untouched: 'keep'
    });
    assert.ok(FakeBetterDatabase.log.some(entry => entry[0] === 'exec' && entry[1] === 'BEGIN IMMEDIATE'));
    assert.ok(FakeBetterDatabase.log.some(entry => entry[0] === 'exec' && entry[1] === 'COMMIT'));

    FakeBetterDatabase.failOnKey = 'authB';
    const beforeFailure = { ...FakeBetterDatabase.databases.get(path.resolve(dbPath)) };
    await assert.rejects(
        adapter.replaceKeys(dbPath, ['authA', 'authB'], {
            authA: 'will-rollback',
            authB: 'boom'
        }),
        error => error && error.code === 'WRITE_KEYS_FAILED'
    );
    assert.deepEqual(FakeBetterDatabase.databases.get(path.resolve(dbPath)), beforeFailure);
    assert.ok(FakeBetterDatabase.log.some(entry => entry[0] === 'exec' && entry[1] === 'ROLLBACK'));
    assert.ok(FakeBetterDatabase.log.some(entry => entry[0] === 'close'));
});

test('better-sqlite3 备份使用 backup API，随后 quick_check 和 0600', async t => {
    FakeBetterDatabase.reset();
    const { directory, dbPath } = await databaseFixture(t, 'cam-better-backup-');
    FakeBetterDatabase.databases.set(path.resolve(dbPath), { auth: 'live-wal-value' });
    const adapter = new SQLiteAdapter({ kind: 'better', mod: FakeBetterDatabase });
    const destination = path.join(directory, 'backup.vscdb');

    const result = await adapter.backup(dbPath, destination);
    assert.equal(result.method, 'better.backup');
    assert.equal(FakeBetterDatabase.backupCalls, 1);
    assert.deepEqual(FakeBetterDatabase.databases.get(path.resolve(destination)), {
        auth: 'live-wal-value'
    });
    assert.equal((await fsp.stat(destination)).mode & 0o777, 0o600);
});

test('sqlite3 精确写显式 BEGIN/COMMIT，失败时 ROLLBACK 且正确关闭', async t => {
    FakeSqlite3Database.reset();
    const { dbPath } = await databaseFixture(t, 'cam-sqlite3-');
    FakeSqlite3Database.databases.set(path.resolve(dbPath), {
        authA: 'old-a',
        authB: 'old-b',
        untouched: 'keep'
    });
    const sqlite3Module = {
        Database: FakeSqlite3Database,
        OPEN_READONLY: 1,
        OPEN_READWRITE: 2,
        verbose() {
            return this;
        }
    };
    const adapter = new SQLiteAdapter({ kind: 'sqlite3', mod: sqlite3Module });

    await adapter.replaceKeys(dbPath, ['authA', 'authB'], { authA: 'new-a' });
    assert.deepEqual(FakeSqlite3Database.databases.get(path.resolve(dbPath)), {
        authA: 'new-a',
        untouched: 'keep'
    });
    assert.ok(FakeSqlite3Database.log.some(entry => entry[0] === 'exec' && entry[1] === 'BEGIN IMMEDIATE'));
    assert.ok(FakeSqlite3Database.log.some(entry => entry[0] === 'exec' && entry[1] === 'COMMIT'));

    FakeSqlite3Database.failOnKey = 'authB';
    const beforeFailure = { ...FakeSqlite3Database.databases.get(path.resolve(dbPath)) };
    await assert.rejects(
        adapter.replaceKeys(dbPath, ['authA', 'authB'], {
            authA: 'will-rollback',
            authB: 'boom'
        }),
        error => error && error.code === 'WRITE_KEYS_FAILED'
    );
    assert.deepEqual(FakeSqlite3Database.databases.get(path.resolve(dbPath)), beforeFailure);
    assert.ok(FakeSqlite3Database.log.some(entry => entry[0] === 'exec' && entry[1] === 'ROLLBACK'));
    assert.ok(FakeSqlite3Database.log.filter(entry => entry[0] === 'close').length >= 2);
});

test('sqlite3 一致备份使用 VACUUM INTO 并校验结果', async t => {
    FakeSqlite3Database.reset();
    const { directory, dbPath } = await databaseFixture(t, 'cam-sqlite3-backup-');
    FakeSqlite3Database.databases.set(path.resolve(dbPath), { auth: 'wal-aware-value' });
    const adapter = new SQLiteAdapter({
        kind: 'sqlite3',
        mod: {
            Database: FakeSqlite3Database,
            OPEN_READONLY: 1,
            OPEN_READWRITE: 2
        }
    });
    const destination = path.join(directory, 'backup.vscdb');

    const result = await adapter.backup(dbPath, destination);
    assert.equal(result.method, 'vacuum-into');
    assert.equal(FakeSqlite3Database.vacuumCalls, 1);
    assert.deepEqual(FakeSqlite3Database.databases.get(path.resolve(destination)), {
        auth: 'wal-aware-value'
    });
    assert.equal((await fsp.stat(destination)).mode & 0o777, 0o600);
});

test('真实 better-sqlite3 备份包含尚未 checkpoint 的 WAL 提交', async t => {
    const Database = require('better-sqlite3');
    const { directory, dbPath } = await databaseFixture(t, 'cam-real-wal-');
    await fsp.unlink(dbPath);
    const writer = new Database(dbPath);
    t.after(() => {
        if (writer.open)
            writer.close();
    });
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    const put = writer.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    put.run('cursorAuth/accessToken', 'wal-token');
    put.run('cursorAuth/userId', 'wal-user');
    const walStat = await fsp.stat(`${dbPath}-wal`);
    assert.ok(walStat.size > 0);

    const adapter = new SQLiteAdapter({ kind: 'better', mod: Database });
    const backupPath = path.join(directory, 'backup.vscdb');
    await adapter.backup(dbPath, backupPath);
    await adapter.quickCheck(backupPath);
    assert.deepEqual(
        await adapter.readKeys(backupPath, [
            'cursorAuth/accessToken',
            'cursorAuth/userId'
        ]),
        {
            'cursorAuth/accessToken': 'wal-token',
            'cursorAuth/userId': 'wal-user'
        }
    );
});

test('真实 better-sqlite3 在事务内拒绝陈旧前像', async t => {
    const Database = require('better-sqlite3');
    const { dbPath } = await databaseFixture(t, 'cam-real-cas-');
    await fsp.unlink(dbPath);
    const writer = new Database(dbPath);
    writer.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    writer.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('cursorAuth/accessToken', 'new-token');
    writer.close();

    const adapter = new SQLiteAdapter({ kind: 'better', mod: Database });
    await assert.rejects(
        adapter.replaceKeys(
            dbPath,
            ['cursorAuth/accessToken'],
            { 'cursorAuth/accessToken': 'replacement' },
            { expectedEntries: { 'cursorAuth/accessToken': 'stale-token' } }
        ),
        error => error &&
            error.code === 'WRITE_KEYS_FAILED' &&
            error.cause &&
            error.cause.code === 'REVISION_CONFLICT'
    );
    assert.deepEqual(
        await adapter.readKeys(dbPath, ['cursorAuth/accessToken']),
        { 'cursorAuth/accessToken': 'new-token' }
    );
});
