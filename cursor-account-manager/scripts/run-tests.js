'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const testRoot = path.join(root, 'test');
const files = fs.readdirSync(testRoot)
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => path.join('test', name));

if (!files.length)
  throw new Error('no test files found');

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  }
);

if (result.error)
  throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
