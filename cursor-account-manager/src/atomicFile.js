'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

class AtomicFileError extends Error {
    constructor(code, message, details = {}, cause) {
        super(message);
        this.name = 'AtomicFileError';
        this.code = code;
        this.operation = details.operation || 'file-safety';
        this.path = details.path;
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
            path: this.path,
            details: this.details
        };
    }
}

function fileError(code, message, details, cause) {
    if (cause instanceof AtomicFileError)
        return cause;
    return new AtomicFileError(code, message, details, cause);
}

function normalizedForComparison(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathContained(rootPath, candidatePath, allowEqual = true) {
    const root = normalizedForComparison(rootPath);
    const candidate = normalizedForComparison(candidatePath);
    const relative = path.relative(root, candidate);
    if (relative === '')
        return allowEqual;
    return relative !== '..' &&
        !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative);
}

async function lstatOrNull(filePath) {
    try {
        return await fsp.lstat(filePath);
    }
    catch (error) {
        if (error && error.code === 'ENOENT')
            return null;
        throw error;
    }
}

async function assertSafeDirectory(directoryPath, options = {}) {
    const absolute = path.resolve(directoryPath);
    let stat;
    try {
        stat = await fsp.lstat(absolute);
    }
    catch (error) {
        throw fileError(
            error && error.code === 'ENOENT' ? 'PATH_NOT_FOUND' : 'LSTAT_FAILED',
            `无法检查目录：${absolute}`,
            { operation: 'lstat-directory', path: absolute },
            error
        );
    }
    if (stat.isSymbolicLink()) {
        throw fileError('SYMLINK_REJECTED', `拒绝符号链接目录：${absolute}`, {
            operation: 'validate-directory',
            path: absolute
        });
    }
    if (!stat.isDirectory()) {
        throw fileError('NOT_A_DIRECTORY', `路径不是目录：${absolute}`, {
            operation: 'validate-directory',
            path: absolute
        });
    }
    let canonical;
    try {
        canonical = await fsp.realpath(absolute);
    }
    catch (error) {
        throw fileError('REALPATH_FAILED', `无法解析目录真实路径：${absolute}`, {
            operation: 'realpath-directory',
            path: absolute
        }, error);
    }
    if (options.root) {
        const rootCanonical = await assertSafeDirectory(options.root);
        if (!isPathContained(rootCanonical.path, canonical, options.allowRoot !== false)) {
            throw fileError('PATH_OUTSIDE_ROOT', `目录超出允许范围：${absolute}`, {
                operation: 'validate-containment',
                path: absolute,
                root: rootCanonical.path,
                canonical
            });
        }
    }
    return { path: canonical, stat };
}

/**
 * Validate every existing component below root with lstat, reject symbolic
 * links, then use realpath to prove canonical containment.
 */
async function inspectContainedPath(rootPath, candidatePath, options = {}) {
    const rootAbsolute = path.resolve(rootPath);
    const candidateAbsolute = path.resolve(candidatePath);
    const root = await assertSafeDirectory(rootAbsolute);
    if (!isPathContained(rootAbsolute, candidateAbsolute, options.allowRoot === true)) {
        throw fileError('PATH_OUTSIDE_ROOT', `路径超出允许范围：${candidateAbsolute}`, {
            operation: 'validate-containment',
            path: candidateAbsolute,
            root: rootAbsolute
        });
    }

    const relative = path.relative(rootAbsolute, candidateAbsolute);
    const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
    let current = rootAbsolute;
    let stat = root.stat;
    let exists = true;
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        try {
            stat = await fsp.lstat(current);
        }
        catch (error) {
            const isFinal = index === parts.length - 1;
            if (error && error.code === 'ENOENT' && options.allowMissing && isFinal) {
                exists = false;
                stat = null;
                break;
            }
            throw fileError(
                error && error.code === 'ENOENT' ? 'PATH_NOT_FOUND' : 'LSTAT_FAILED',
                `无法检查路径：${current}`,
                { operation: 'lstat-path', path: current, root: root.path },
                error
            );
        }
        if (stat.isSymbolicLink()) {
            throw fileError('SYMLINK_REJECTED', `拒绝路径中的符号链接：${current}`, {
                operation: 'validate-path',
                path: current,
                root: root.path
            });
        }
        if (index < parts.length - 1 && !stat.isDirectory()) {
            throw fileError('NOT_A_DIRECTORY', `路径中间项不是目录：${current}`, {
                operation: 'validate-path',
                path: current,
                root: root.path
            });
        }
    }

    const canonical = exists
        ? await fsp.realpath(candidateAbsolute)
        : path.join(root.path, relative);
    if (!isPathContained(root.path, canonical, options.allowRoot === true)) {
        throw fileError('PATH_OUTSIDE_ROOT', `真实路径超出允许范围：${candidateAbsolute}`, {
            operation: 'validate-realpath-containment',
            path: candidateAbsolute,
            root: root.path,
            canonical
        });
    }
    if (exists && options.type === 'file' && !stat.isFile()) {
        throw fileError('NOT_A_REGULAR_FILE', `路径不是普通文件：${candidateAbsolute}`, {
            operation: 'validate-file',
            path: candidateAbsolute,
            root: root.path
        });
    }
    if (exists && options.type === 'file' && stat.nlink !== 1) {
        throw fileError('HARDLINK_REJECTED', `拒绝硬链接文件：${candidateAbsolute}`, {
            operation: 'validate-file',
            path: candidateAbsolute,
            root: root.path,
            nlink: stat.nlink
        });
    }
    if (exists && options.type === 'directory' && !stat.isDirectory()) {
        throw fileError('NOT_A_DIRECTORY', `路径不是目录：${candidateAbsolute}`, {
            operation: 'validate-directory',
            path: candidateAbsolute,
            root: root.path
        });
    }
    return {
        path: canonical,
        requestedPath: candidateAbsolute,
        root: root.path,
        stat,
        exists
    };
}

async function assertSafeRegularFile(filePath, options = {}) {
    const absolute = path.resolve(filePath);
    if (options.root) {
        return inspectContainedPath(options.root, absolute, {
            allowMissing: options.allowMissing === true,
            type: 'file'
        });
    }
    const parent = await assertSafeDirectory(path.dirname(absolute));
    return inspectContainedPath(parent.path, path.join(parent.path, path.basename(absolute)), {
        allowMissing: options.allowMissing === true,
        type: 'file'
    });
}

async function fsyncDirectory(directoryPath) {
    const directory = await assertSafeDirectory(directoryPath);
    let handle;
    try {
        handle = await fsp.open(directory.path, fs.constants.O_RDONLY);
        await handle.sync();
    }
    catch (error) {
        // Windows does not consistently permit opening/syncing directories.
        if (process.platform === 'win32' && error &&
            ['EACCES', 'EBADF', 'EINVAL', 'EPERM', 'EISDIR'].includes(error.code))
            return;
        throw fileError('DIRECTORY_FSYNC_FAILED', `目录 fsync 失败：${directory.path}`, {
            operation: 'fsync-directory',
            path: directory.path
        }, error);
    }
    finally {
        if (handle) {
            try {
                await handle.close();
            }
            catch { }
        }
    }
}

async function fsyncFile(filePath) {
    const safe = await assertSafeRegularFile(filePath);
    let handle;
    try {
        handle = await fsp.open(safe.path, fs.constants.O_RDONLY);
        await handle.sync();
    }
    catch (error) {
        throw fileError('FILE_FSYNC_FAILED', `文件 fsync 失败：${safe.path}`, {
            operation: 'fsync-file',
            path: safe.path
        }, error);
    }
    finally {
        if (handle) {
            try {
                await handle.close();
            }
            catch { }
        }
    }
}

function randomTemporaryName(targetPath) {
    const random = crypto.randomBytes(18).toString('hex');
    return path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.${process.pid}.${random}.tmp`
    );
}

async function readFileSnapshot(filePath) {
    const handle = await fsp.open(
        filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1)
            throw fileError('HARDLINK_REJECTED', `拒绝非独立普通文件：${filePath}`, {
                operation: 'read-snapshot',
                path: filePath,
                nlink: before.nlink
            });
        const data = await handle.readFile();
        const after = await handle.stat();
        if (before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            data.length !== after.size) {
            throw fileError('TARGET_CHANGED', `文件读取期间发生变化：${filePath}`, {
                operation: 'read-snapshot',
                path: filePath
            });
        }
        return {
            dev: after.dev,
            ino: after.ino,
            size: after.size,
            mtimeMs: after.mtimeMs,
            sha256: crypto.createHash('sha256').update(data).digest('hex'),
            data
        };
    }
    finally {
        await handle.close();
    }
}

function snapshotsEqual(left, right) {
    return !!left && !!right &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.sha256 === right.sha256;
}

async function atomicWriteFile(targetPath, data, options = {}) {
    const absolute = path.resolve(targetPath);
    const root = options.root ? path.resolve(options.root) : path.dirname(absolute);
    const safe = await assertSafeRegularFile(absolute, { root, allowMissing: true });
    const parent = path.dirname(safe.path);
    const mode = options.mode == null ? 0o600 : options.mode;
    let temporaryPath;
    let handle;
    let renamed = false;

    try {
        for (let attempt = 0; attempt < 16; attempt++) {
            temporaryPath = randomTemporaryName(safe.path);
            try {
                handle = await fsp.open(temporaryPath, 'wx', mode);
                break;
            }
            catch (error) {
                if (!error || error.code !== 'EEXIST')
                    throw error;
            }
        }
        if (!handle) {
            throw fileError('TEMP_NAME_EXHAUSTED', `无法创建随机临时文件：${safe.path}`, {
                operation: 'create-temporary',
                path: safe.path
            });
        }
        await handle.chmod(mode);
        await handle.writeFile(data, options.encoding ? { encoding: options.encoding } : undefined);
        await handle.sync();
        await handle.close();
        handle = null;

        // Re-check immediately before rename so an existing target cannot be
        // swapped for a symlink while data is being written.
        const beforeRename = await lstatOrNull(safe.path);
        if (beforeRename && beforeRename.isSymbolicLink()) {
            throw fileError('SYMLINK_REJECTED', `拒绝覆盖符号链接：${safe.path}`, {
                operation: 'pre-rename-validation',
                path: safe.path
            });
        }
        if (beforeRename && !beforeRename.isFile()) {
            throw fileError('NOT_A_REGULAR_FILE', `拒绝覆盖非普通文件：${safe.path}`, {
                operation: 'pre-rename-validation',
                path: safe.path
            });
        }
        if (beforeRename && beforeRename.nlink !== 1) {
            throw fileError('HARDLINK_REJECTED', `拒绝覆盖硬链接文件：${safe.path}`, {
                operation: 'pre-rename-validation',
                path: safe.path,
                nlink: beforeRename.nlink
            });
        }
        if (options.expectedCurrent) {
            if (!beforeRename) {
                throw fileError('TARGET_CHANGED', `目标文件已被删除：${safe.path}`, {
                    operation: 'pre-rename-compare',
                    path: safe.path
                });
            }
            const observed = await readFileSnapshot(safe.path);
            if (!snapshotsEqual(observed, options.expectedCurrent)) {
                throw fileError('TARGET_CHANGED', `目标文件在写入前已变化：${safe.path}`, {
                    operation: 'pre-rename-compare',
                    path: safe.path
                });
            }
        }
        await fsp.rename(temporaryPath, safe.path);
        renamed = true;
        await fsyncDirectory(parent);
        return { path: safe.path, mode };
    }
    catch (error) {
        if (error instanceof AtomicFileError)
            throw error;
        throw fileError('ATOMIC_WRITE_FAILED', `原子写入失败：${safe.path}`, {
            operation: renamed ? 'post-rename-fsync' : 'atomic-write',
            path: safe.path,
            temporaryPath
        }, error);
    }
    finally {
        if (handle) {
            try {
                await handle.close();
            }
            catch { }
        }
        if (!renamed && temporaryPath) {
            try {
                await fsp.unlink(temporaryPath);
                await fsyncDirectory(parent);
            }
            catch { }
        }
    }
}

async function atomicWriteJson(targetPath, value, options = {}) {
    const spacing = options.space == null ? 2 : options.space;
    const serialized = JSON.stringify(value, null, spacing) + '\n';
    return atomicWriteFile(targetPath, serialized, {
        ...options,
        encoding: 'utf8',
        mode: options.mode == null ? 0o600 : options.mode
    });
}

async function durableUnlink(filePath, options = {}) {
    const absolute = path.resolve(filePath);
    const root = options.root ? path.resolve(options.root) : path.dirname(absolute);
    const safe = await assertSafeRegularFile(absolute, { root, allowMissing: true });
    if (!safe.exists)
        return false;
    try {
        await fsp.unlink(safe.path);
        await fsyncDirectory(path.dirname(safe.path));
        return true;
    }
    catch (error) {
        throw fileError('DURABLE_UNLINK_FAILED', `持久删除失败：${safe.path}`, {
            operation: 'unlink',
            path: safe.path
        }, error);
    }
}

module.exports = {
    AtomicFileError,
    assertSafeDirectory,
    assertSafeRegularFile,
    inspectContainedPath,
    isPathContained,
    fsyncDirectory,
    fsyncFile,
    readFileSnapshot,
    snapshotsEqual,
    atomicWriteFile,
    atomicWriteJson,
    durableUnlink
};
