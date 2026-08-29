'use strict';

const fs = require('fs');
const path = require('path');
const {
    assertSafeDirectory,
    assertSafeRegularFile,
    durableUnlink,
    fsyncDirectory,
    fsyncFile
} = require('./atomicFile');

const fsp = fs.promises;

class SQLiteAdapterError extends Error {
    constructor(code, message, details = {}, cause) {
        super(message);
        this.name = 'SQLiteAdapterError';
        this.code = code;
        this.operation = details.operation || 'sqlite';
        this.kind = details.kind;
        this.dbPath = details.dbPath;
        this.destinationPath = details.destinationPath;
        this.retryable = details.retryable === true;
        this.committed = details.committed === true;
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
            kind: this.kind,
            dbPath: this.dbPath,
            destinationPath: this.destinationPath,
            retryable: this.retryable,
            committed: this.committed,
            details: this.details
        };
    }
}

function sqliteMessage(error) {
    return String(error && error.message || error || 'unknown sqlite error');
}

function isBusyError(error) {
    const code = String(error && error.code || '');
    return code === 'SQLITE_BUSY' ||
        code === 'SQLITE_LOCKED' ||
        /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(sqliteMessage(error));
}

function adapterError(code, message, details, cause) {
    return new SQLiteAdapterError(code, message, {
        ...details,
        retryable: details && details.retryable === true || isBusyError(cause)
    }, cause);
}

function descriptorKind(loaded) {
    const value = String(loaded && loaded.kind || '').toLowerCase();
    if (value === 'better' || value === 'better-sqlite3' || value === 'bettersqlite3')
        return 'better';
    if (value === 'sqlite3' || value === 'vscode-sqlite3' || value === '@vscode/sqlite3')
        return 'sqlite3';
    return value;
}

function moduleFromDescriptor(loaded) {
    return loaded && (loaded.mod || loaded.module || loaded.Database || loaded.default);
}

function validateLoadedDescriptor(loaded) {
    const kind = descriptorKind(loaded);
    if (!loaded || !moduleFromDescriptor(loaded) || !['better', 'sqlite3'].includes(kind)) {
        throw adapterError('INVALID_LOADED_DESCRIPTOR', 'SQLite loaded descriptor 无效', {
            operation: 'construct-adapter',
            kind
        });
    }
    return kind;
}

function uniqueKeys(keys) {
    if (!Array.isArray(keys))
        throw adapterError('INVALID_KEYS', 'keys 必须是字符串数组', { operation: 'validate-keys' });
    const result = [];
    const seen = new Set();
    for (const raw of keys) {
        if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) {
            throw adapterError('INVALID_KEY', 'SQLite key 必须是非空字符串', {
                operation: 'validate-keys'
            });
        }
        if (!seen.has(raw)) {
            seen.add(raw);
            result.push(raw);
        }
    }
    return result;
}

function ownEntries(entries) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        throw adapterError('INVALID_ENTRIES', 'entries 必须是键值对象', {
            operation: 'validate-entries'
        });
    }
    const result = {};
    for (const key of Object.keys(entries)) {
        const value = entries[key];
        if (value === undefined) {
            throw adapterError('INVALID_VALUE', `SQLite key ${key} 的值不能是 undefined`, {
                operation: 'validate-entries',
                key
            });
        }
        result[key] = normalizeValue(value);
    }
    return result;
}

function normalizeValue(value) {
    if (Buffer.isBuffer(value))
        return value.toString('utf8');
    if (value === null)
        return null;
    return String(value);
}

function valuesEqual(left, right) {
    return normalizeValue(left) === normalizeValue(right);
}

function rowValue(row) {
    if (!row || row.value === undefined)
        return undefined;
    return normalizeValue(row.value);
}

function compareExact(keys, expected, actual) {
    const mismatches = [];
    for (const key of keys) {
        const expectedHas = Object.prototype.hasOwnProperty.call(expected, key);
        const actualHas = Object.prototype.hasOwnProperty.call(actual, key);
        if (expectedHas !== actualHas) {
            mismatches.push({ key, expected: expectedHas ? 'present' : 'absent', actual: actualHas ? 'present' : 'absent' });
            continue;
        }
        if (expectedHas && !valuesEqual(expected[key], actual[key])) {
            mismatches.push({
                key,
                expected: `value-length:${String(expected[key] == null ? '' : expected[key]).length}`,
                actual: `value-length:${String(actual[key] == null ? '' : actual[key]).length}`
            });
        }
    }
    return mismatches;
}

function quoteSqliteLiteral(value) {
    const text = String(value);
    if (text.includes('\0')) {
        throw adapterError('INVALID_BACKUP_PATH', '备份路径不能包含 NUL', {
            operation: 'quote-backup-path'
        });
    }
    return "'" + text.replace(/'/g, "''") + "'";
}

function prefixLikePattern(prefix) {
    if (typeof prefix !== 'string' || !prefix || prefix.includes('\0')) {
        throw adapterError('INVALID_PREFIX', 'SQLite key prefix 必须是非空字符串', {
            operation: 'validate-prefix'
        });
    }
    return prefix.replace(/[\\%_]/g, value => '\\' + value) + '%';
}

class SQLiteAdapter {
    constructor(loadedOrOptions, maybeOptions = {}) {
        let loaded = loadedOrOptions;
        let options = maybeOptions;
        if (loadedOrOptions && loadedOrOptions.loaded) {
            loaded = loadedOrOptions.loaded;
            options = loadedOrOptions;
        }
        this.loaded = loaded;
        this.kind = validateLoadedDescriptor(loaded);
        this.busyTimeoutMs = Number.isFinite(options.busyTimeoutMs)
            ? Math.max(0, Math.floor(options.busyTimeoutMs))
            : 45000;
    }

    _details(operation, dbPath, extra = {}) {
        return {
            operation,
            kind: this.kind,
            dbPath: dbPath && path.resolve(dbPath),
            ...extra
        };
    }

    _betterDatabase() {
        const raw = moduleFromDescriptor(this.loaded);
        const candidate = raw && (raw.default || raw);
        const Database = typeof candidate === 'function'
            ? candidate
            : candidate && candidate.Database;
        if (typeof Database !== 'function') {
            throw adapterError('INVALID_BETTER_SQLITE3_MODULE', 'better-sqlite3 模块未导出 Database', {
                operation: 'resolve-database',
                kind: this.kind
            });
        }
        return Database;
    }

    _sqlite3Module() {
        const raw = moduleFromDescriptor(this.loaded);
        const moduleValue = raw && raw.verbose ? raw.verbose() : raw;
        const value = moduleValue && (moduleValue.default || moduleValue);
        const Database = value && (value.Database || (typeof value === 'function' ? value : null));
        if (typeof Database !== 'function') {
            throw adapterError('INVALID_SQLITE3_MODULE', 'sqlite3 模块未导出 Database', {
                operation: 'resolve-database',
                kind: this.kind
            });
        }
        return { moduleValue: value, Database };
    }

    _setBetterBusyTimeout(db) {
        if (!this.busyTimeoutMs)
            return;
        if (typeof db.pragma === 'function')
            db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
        else
            db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    }

    async _openBetter(dbPath, readonly) {
        const Database = this._betterDatabase();
        let db;
        try {
            db = new Database(path.resolve(dbPath), {
                readonly: readonly === true,
                fileMustExist: true
            });
            this._setBetterBusyTimeout(db);
            return db;
        }
        catch (error) {
            if (db && typeof db.close === 'function') {
                try {
                    db.close();
                }
                catch { }
            }
            throw adapterError('OPEN_FAILED', `无法打开 SQLite 数据库：${path.resolve(dbPath)}`, this._details('open', dbPath), error);
        }
    }

    async _closeBetter(db, dbPath) {
        if (!db)
            return;
        try {
            if (typeof db.close === 'function')
                db.close();
        }
        catch (error) {
            throw adapterError('CLOSE_FAILED', `关闭 SQLite 数据库失败：${path.resolve(dbPath)}`, this._details('close', dbPath), error);
        }
    }

    async _openSqlite3(dbPath, readonly) {
        const { moduleValue, Database } = this._sqlite3Module();
        const mode = readonly
            ? (moduleValue.OPEN_READONLY == null ? 1 : moduleValue.OPEN_READONLY)
            : (moduleValue.OPEN_READWRITE == null ? 2 : moduleValue.OPEN_READWRITE);
        const absolute = path.resolve(dbPath);
        return new Promise((resolve, reject) => {
            let db;
            let callbackCalled = false;
            const callback = (error) => {
                if (callbackCalled)
                    return;
                callbackCalled = true;
                queueMicrotask(() => {
                    if (error) {
                        Promise.resolve()
                            .then(() => this._closeSqlite3(db, absolute))
                            .catch(() => { })
                            .then(() => reject(adapterError('OPEN_FAILED', `无法打开 SQLite 数据库：${absolute}`, this._details('open', absolute), error)));
                    }
                    else {
                        resolve(db);
                    }
                });
            };
            try {
                db = new Database(absolute, mode, callback);
            }
            catch (error) {
                callback(error);
            }
        }).then(async db => {
            try {
                if (this.busyTimeoutMs)
                    await this._sqlite3Run(db, `PRAGMA busy_timeout = ${this.busyTimeoutMs}`, []);
                return db;
            }
            catch (error) {
                try {
                    await this._closeSqlite3(db, absolute);
                }
                catch { }
                throw adapterError('OPEN_CONFIGURATION_FAILED', `配置 SQLite 连接失败：${absolute}`, this._details('configure-open', absolute), error);
            }
        });
    }

    _sqlite3Run(db, sql, params = []) {
        return new Promise((resolve, reject) => {
            try {
                db.run(sql, params, function (error) {
                    if (error)
                        reject(error);
                    else
                        resolve({ changes: Number(this && this.changes || 0), lastID: this && this.lastID });
                });
            }
            catch (error) {
                reject(error);
            }
        });
    }

    _sqlite3Get(db, sql, params = []) {
        return new Promise((resolve, reject) => {
            try {
                db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
            }
            catch (error) {
                reject(error);
            }
        });
    }

    _sqlite3All(db, sql, params = []) {
        return new Promise((resolve, reject) => {
            try {
                db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
            }
            catch (error) {
                reject(error);
            }
        });
    }

    _sqlite3Exec(db, sql) {
        if (typeof db.exec !== 'function')
            return this._sqlite3Run(db, sql, []);
        return new Promise((resolve, reject) => {
            try {
                db.exec(sql, error => error ? reject(error) : resolve());
            }
            catch (error) {
                reject(error);
            }
        });
    }

    async _closeSqlite3(db, dbPath) {
        if (!db || typeof db.close !== 'function')
            return;
        try {
            await new Promise((resolve, reject) => {
                let done = false;
                const callback = error => {
                    if (done)
                        return;
                    done = true;
                    error ? reject(error) : resolve();
                };
                let returned;
                try {
                    returned = db.close(callback);
                }
                catch (error) {
                    callback(error);
                    return;
                }
                if (returned && typeof returned.then === 'function')
                    returned.then(() => callback(), callback);
                else if (db.close.length === 0)
                    queueMicrotask(() => callback());
            });
        }
        catch (error) {
            throw adapterError('CLOSE_FAILED', `关闭 SQLite 数据库失败：${path.resolve(dbPath)}`, this._details('close', dbPath), error);
        }
    }

    _readBetterOpen(db, keys) {
        if (keys.length === 0)
            return {};
        const placeholders = keys.map(() => '?').join(', ');
        const rows = db.prepare(
            `SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`
        ).all(...keys);
        const result = {};
        for (const row of rows || [])
            if (row && typeof row.key === 'string' && row.value !== undefined)
                result[row.key] = rowValue(row);
        return result;
    }

    async _readSqlite3Open(db, keys) {
        if (keys.length === 0)
            return {};
        const placeholders = keys.map(() => '?').join(', ');
        const rows = await this._sqlite3All(
            db,
            `SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`,
            keys
        );
        const result = {};
        for (const row of rows)
            if (row && typeof row.key === 'string' && row.value !== undefined)
                result[row.key] = rowValue(row);
        return result;
    }

    async readKeys(dbPath, requestedKeys) {
        const keys = uniqueKeys(requestedKeys);
        let db;
        let result;
        let operationError;
        try {
            if (this.kind === 'better') {
                db = await this._openBetter(dbPath, true);
                result = this._readBetterOpen(db, keys);
            }
            else {
                db = await this._openSqlite3(dbPath, true);
                result = await this._readSqlite3Open(db, keys);
            }
        }
        catch (error) {
            operationError = adapterError('READ_KEYS_FAILED', `读取 SQLite 精确键失败：${path.resolve(dbPath)}`, this._details('read-keys', dbPath, { keys }), error);
        }
        try {
            if (this.kind === 'better')
                await this._closeBetter(db, dbPath);
            else
                await this._closeSqlite3(db, dbPath);
        }
        catch (closeError) {
            if (!operationError)
                operationError = closeError;
        }
        if (operationError)
            throw operationError;
        return result;
    }

    async readKeysByPrefixes(dbPath, prefixes) {
        if (!Array.isArray(prefixes) || prefixes.length === 0) {
            throw adapterError('INVALID_PREFIXES', 'prefixes 必须是非空字符串数组', {
                operation: 'validate-prefixes'
            });
        }
        const patterns = [...new Set(prefixes.map(prefixLikePattern))];
        let db;
        let rows = [];
        let operationError;
        try {
            if (this.kind === 'better') {
                db = await this._openBetter(dbPath, true);
                const statement = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE ? ESCAPE '\\'");
                for (const pattern of patterns)
                    rows.push(...statement.all(pattern));
            }
            else {
                db = await this._openSqlite3(dbPath, true);
                for (const pattern of patterns) {
                    rows.push(...await this._sqlite3All(
                        db,
                        "SELECT key, value FROM ItemTable WHERE key LIKE ? ESCAPE '\\'",
                        [pattern]
                    ));
                }
            }
        }
        catch (error) {
            operationError = adapterError(
                'READ_PREFIX_KEYS_FAILED',
                `读取 SQLite 鉴权前缀失败：${path.resolve(dbPath)}`,
                this._details('read-prefix-keys', dbPath),
                error
            );
        }
        try {
            if (this.kind === 'better')
                await this._closeBetter(db, dbPath);
            else
                await this._closeSqlite3(db, dbPath);
        }
        catch (closeError) {
            if (!operationError)
                operationError = closeError;
        }
        if (operationError)
            throw operationError;
        const result = {};
        for (const row of rows) {
            if (row && typeof row.key === 'string' && row.value !== undefined)
                result[row.key] = rowValue(row);
        }
        return result;
    }

    async writeKeys(dbPath, rawEntries, options = {}) {
        const entries = ownEntries(rawEntries);
        const keys = uniqueKeys(options.keys || Object.keys(entries));
        const expectedEntries = options.expectedEntries === undefined
            ? null
            : ownEntries(options.expectedEntries);
        const keySet = new Set(keys);
        for (const key of Object.keys(entries)) {
            if (!keySet.has(key)) {
                throw adapterError('ENTRY_OUTSIDE_KEYS', `写入键不在精确 allowlist 中：${key}`, this._details('validate-write', dbPath, { key }));
            }
        }
        let db;
        let began = false;
        let committed = false;
        let operationError;
        let result;
        try {
            if (this.kind === 'better') {
                db = await this._openBetter(dbPath, false);
                db.exec('BEGIN IMMEDIATE');
                began = true;
                if (expectedEntries) {
                    const current = this._readBetterOpen(db, keys);
                    const conflicts = compareExact(keys, expectedEntries, current);
                    if (conflicts.length) {
                        throw adapterError('REVISION_CONFLICT', 'SQLite 鉴权键在事务开始前已变化', this._details('compare-before-write', dbPath, {
                            keys,
                            conflicts
                        }));
                    }
                }
                const remove = db.prepare('DELETE FROM ItemTable WHERE key = ?');
                const put = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
                for (const key of keys)
                    remove.run(key);
                for (const key of Object.keys(entries))
                    put.run(key, entries[key]);
                const inside = this._readBetterOpen(db, keys);
                const beforeCommitMismatches = compareExact(keys, entries, inside);
                if (beforeCommitMismatches.length) {
                    throw adapterError('READBACK_FAILED', 'SQLite 事务内读回校验失败', this._details('readback-before-commit', dbPath, {
                        keys,
                        mismatches: beforeCommitMismatches
                    }));
                }
                db.exec('COMMIT');
                committed = true;
                const after = this._readBetterOpen(db, keys);
                const afterCommitMismatches = compareExact(keys, entries, after);
                if (afterCommitMismatches.length) {
                    throw adapterError('READBACK_FAILED', 'SQLite 提交后读回校验失败', this._details('readback-after-commit', dbPath, {
                        keys,
                        mismatches: afterCommitMismatches,
                        committed: true
                    }));
                }
                result = after;
            }
            else {
                db = await this._openSqlite3(dbPath, false);
                await this._sqlite3Exec(db, 'BEGIN IMMEDIATE');
                began = true;
                if (expectedEntries) {
                    const current = await this._readSqlite3Open(db, keys);
                    const conflicts = compareExact(keys, expectedEntries, current);
                    if (conflicts.length) {
                        throw adapterError('REVISION_CONFLICT', 'SQLite 鉴权键在事务开始前已变化', this._details('compare-before-write', dbPath, {
                            keys,
                            conflicts
                        }));
                    }
                }
                for (const key of keys)
                    await this._sqlite3Run(db, 'DELETE FROM ItemTable WHERE key = ?', [key]);
                for (const key of Object.keys(entries)) {
                    await this._sqlite3Run(
                        db,
                        'INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                        [key, entries[key]]
                    );
                }
                const inside = await this._readSqlite3Open(db, keys);
                const beforeCommitMismatches = compareExact(keys, entries, inside);
                if (beforeCommitMismatches.length) {
                    throw adapterError('READBACK_FAILED', 'SQLite 事务内读回校验失败', this._details('readback-before-commit', dbPath, {
                        keys,
                        mismatches: beforeCommitMismatches
                    }));
                }
                await this._sqlite3Exec(db, 'COMMIT');
                committed = true;
                const after = await this._readSqlite3Open(db, keys);
                const afterCommitMismatches = compareExact(keys, entries, after);
                if (afterCommitMismatches.length) {
                    throw adapterError('READBACK_FAILED', 'SQLite 提交后读回校验失败', this._details('readback-after-commit', dbPath, {
                        keys,
                        mismatches: afterCommitMismatches,
                        committed: true
                    }));
                }
                result = after;
            }
        }
        catch (error) {
            if (began && !committed && db) {
                try {
                    if (this.kind === 'better')
                        db.exec('ROLLBACK');
                    else
                        await this._sqlite3Exec(db, 'ROLLBACK');
                }
                catch (rollbackError) {
                    operationError = adapterError('TRANSACTION_ROLLBACK_FAILED', 'SQLite 写事务失败且回滚失败', this._details('rollback-write', dbPath, {
                        keys,
                        originalCode: error && error.code
                    }), rollbackError);
                }
            }
            if (!operationError) {
                operationError = adapterError('WRITE_KEYS_FAILED', `写入 SQLite 精确键失败：${path.resolve(dbPath)}`, this._details('write-keys', dbPath, {
                    keys,
                    committed: committed || error && error.committed === true
                }), error);
            }
        }
        try {
            if (this.kind === 'better')
                await this._closeBetter(db, dbPath);
            else
                await this._closeSqlite3(db, dbPath);
        }
        catch (closeError) {
            if (!operationError)
                operationError = closeError;
        }
        if (operationError)
            throw operationError;
        return result;
    }

    replaceKeys(dbPath, keys, entries, options = {}) {
        return this.writeKeys(dbPath, entries, {
            keys,
            expectedEntries: options.expectedEntries
        });
    }

    restoreKeys(dbPath, keysOrSnapshot, maybeSnapshot) {
        if (Array.isArray(keysOrSnapshot))
            return this.replaceKeys(dbPath, keysOrSnapshot, maybeSnapshot || {});
        const snapshot = ownEntries(keysOrSnapshot || {});
        return this.replaceKeys(dbPath, Object.keys(snapshot), snapshot);
    }

    async quickCheck(dbPath) {
        let db;
        let rows;
        let operationError;
        try {
            if (this.kind === 'better') {
                db = await this._openBetter(dbPath, true);
                rows = db.prepare('PRAGMA quick_check').all();
            }
            else {
                db = await this._openSqlite3(dbPath, true);
                rows = await this._sqlite3All(db, 'PRAGMA quick_check', []);
            }
            const messages = (rows || []).map(row => {
                if (row == null)
                    return '';
                if (typeof row !== 'object')
                    return String(row);
                const values = Object.values(row);
                return values.length ? String(values[0]) : '';
            });
            if (!messages.length || messages.some(message => message.toLowerCase() !== 'ok')) {
                throw adapterError('QUICK_CHECK_FAILED', 'SQLite PRAGMA quick_check 未通过', this._details('quick-check', dbPath, {
                    result: messages
                }));
            }
        }
        catch (error) {
            operationError = adapterError('QUICK_CHECK_FAILED', `SQLite 完整性检查失败：${path.resolve(dbPath)}`, this._details('quick-check', dbPath), error);
        }
        try {
            if (this.kind === 'better')
                await this._closeBetter(db, dbPath);
            else
                await this._closeSqlite3(db, dbPath);
        }
        catch (closeError) {
            if (!operationError)
                operationError = closeError;
        }
        if (operationError)
            throw operationError;
        return { ok: true };
    }

    async backup(dbPath, destinationPath) {
        const source = path.resolve(dbPath);
        const destination = path.resolve(destinationPath);
        const destinationDirectory = path.dirname(destination);
        await assertSafeRegularFile(source);
        await assertSafeDirectory(destinationDirectory);
        const destinationState = await assertSafeRegularFile(destination, {
            root: destinationDirectory,
            allowMissing: true
        });
        if (destinationState.exists) {
            throw adapterError('BACKUP_DESTINATION_EXISTS', `备份目标已存在：${destination}`, this._details('backup', source, {
                destinationPath: destination
            }));
        }

        let db;
        let operationError;
        try {
            if (this.kind === 'better') {
                db = await this._openBetter(source, true);
                if (typeof db.backup === 'function') {
                    const pending = db.backup(destination);
                    if (pending && typeof pending.then === 'function')
                        await pending;
                }
                else {
                    db.exec(`VACUUM INTO ${quoteSqliteLiteral(destination)}`);
                }
            }
            else {
                db = await this._openSqlite3(source, true);
                await this._sqlite3Exec(db, `VACUUM INTO ${quoteSqliteLiteral(destination)}`);
            }
        }
        catch (error) {
            operationError = adapterError('BACKUP_FAILED', `创建一致 SQLite 备份失败：${source}`, this._details('backup', source, {
                destinationPath: destination
            }), error);
        }
        try {
            if (this.kind === 'better')
                await this._closeBetter(db, source);
            else
                await this._closeSqlite3(db, source);
        }
        catch (closeError) {
            if (!operationError)
                operationError = closeError;
        }

        if (!operationError) {
            try {
                const backupStat = await fsp.lstat(destination);
                if (backupStat.isSymbolicLink() || !backupStat.isFile())
                    throw new Error('backup output is not a regular file');
                await fsp.chmod(destination, 0o600);
                await this.quickCheck(destination);
                await fsyncFile(destination);
                await fsyncDirectory(destinationDirectory);
            }
            catch (error) {
                operationError = adapterError('BACKUP_VALIDATION_FAILED', `SQLite 备份校验失败：${destination}`, this._details('validate-backup', source, {
                    destinationPath: destination
                }), error);
            }
        }

        if (operationError) {
            try {
                await durableUnlink(destination, { root: destinationDirectory });
            }
            catch { }
            throw operationError;
        }
        return {
            ok: true,
            source,
            path: destination,
            method: this.kind === 'better' && db && typeof db.backup === 'function'
                ? 'better.backup'
                : 'vacuum-into'
        };
    }

    backupDatabase(dbPath, destinationPath) {
        return this.backup(dbPath, destinationPath);
    }

    readExactKeys(dbPath, keys) {
        return this.readKeys(dbPath, keys);
    }

    readAuthPrefixKeys(dbPath, prefixes) {
        return this.readKeysByPrefixes(dbPath, prefixes);
    }

    writeExactKeys(dbPath, keys, entries) {
        return this.replaceKeys(dbPath, keys, entries);
    }

    restoreExactKeys(dbPath, keys, snapshot) {
        return this.restoreKeys(dbPath, keys, snapshot);
    }
}

function createSQLiteAdapter(loaded, options) {
    return new SQLiteAdapter(loaded, options);
}

async function readExactKeys(loaded, dbPath, keys, options) {
    return new SQLiteAdapter(loaded, options).readKeys(dbPath, keys);
}

async function writeExactKeys(loaded, dbPath, keys, entries, options) {
    return new SQLiteAdapter(loaded, options).replaceKeys(dbPath, keys, entries);
}

async function restoreExactKeys(loaded, dbPath, keys, snapshot, options) {
    return new SQLiteAdapter(loaded, options).restoreKeys(dbPath, keys, snapshot);
}

async function backupDatabase(loaded, dbPath, destinationPath, options) {
    return new SQLiteAdapter(loaded, options).backup(dbPath, destinationPath);
}

module.exports = {
    SQLiteAdapter,
    SQLiteAdapterError,
    createSQLiteAdapter,
    readExactKeys,
    writeExactKeys,
    restoreExactKeys,
    backupDatabase,
    isBusyError
};
