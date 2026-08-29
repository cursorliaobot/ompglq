'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    atomicWriteFile,
    assertSafeRegularFile,
    readFileSnapshot
} = require('../src/atomicFile');

const fsp = fs.promises;

async function temporaryDirectory(t) {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'cam-atomic-'));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('atomicWriteFile 使用同目录 0600 文件并原子替换', async t => {
    const directory = await temporaryDirectory(t);
    const target = path.join(directory, 'storage.json');
    await fsp.writeFile(target, 'old', { mode: 0o644 });

    await atomicWriteFile(target, 'new-state', {
        root: directory,
        encoding: 'utf8'
    });

    assert.equal(await fsp.readFile(target, 'utf8'), 'new-state');
    assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
    const names = await fsp.readdir(directory);
    assert.deepEqual(names, ['storage.json']);
});

test('文件安全检查和原子写拒绝符号链接', async t => {
    const directory = await temporaryDirectory(t);
    const outside = path.join(await temporaryDirectory(t), 'outside.json');
    const link = path.join(directory, 'storage.json');
    await fsp.writeFile(outside, 'outside', { mode: 0o600 });
    await fsp.symlink(outside, link);

    await assert.rejects(
        assertSafeRegularFile(link, { root: directory }),
        error => error && error.code === 'SYMLINK_REJECTED'
    );
    await assert.rejects(
        atomicWriteFile(link, 'attacker-data', { root: directory }),
        error => error && error.code === 'SYMLINK_REJECTED'
    );
    assert.equal(await fsp.readFile(outside, 'utf8'), 'outside');
});

test('可变文件拒绝硬链接并用内容快照检测并发替换', async t => {
    const directory = await temporaryDirectory(t);
    const outsideDirectory = await temporaryDirectory(t);
    const outside = path.join(outsideDirectory, 'outside.json');
    const linked = path.join(directory, 'state.vscdb');
    await fsp.writeFile(outside, 'outside', { mode: 0o600 });
    await fsp.link(outside, linked);
    await assert.rejects(
        assertSafeRegularFile(linked, { root: directory }),
        error => error && error.code === 'HARDLINK_REJECTED'
    );
    assert.equal(await fsp.readFile(outside, 'utf8'), 'outside');

    const target = path.join(directory, 'storage.json');
    await fsp.writeFile(target, 'revision-1', { mode: 0o600 });
    const expectedCurrent = await readFileSnapshot(target);
    await fsp.writeFile(target, 'revision-2', { mode: 0o600 });
    await assert.rejects(
        atomicWriteFile(target, 'our-update', {
            root: directory,
            expectedCurrent
        }),
        error => error && error.code === 'TARGET_CHANGED'
    );
    assert.equal(await fsp.readFile(target, 'utf8'), 'revision-2');
});

test('containment 检查拒绝 root 之外的路径', async t => {
    const directory = await temporaryDirectory(t);
    const outsideDirectory = await temporaryDirectory(t);
    const outside = path.join(outsideDirectory, 'state.vscdb');
    await fsp.writeFile(outside, 'db');

    await assert.rejects(
        assertSafeRegularFile(outside, { root: directory }),
        error => error && error.code === 'PATH_OUTSIDE_ROOT'
    );
});
