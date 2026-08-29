'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { walkRegularFiles } = require('./build-extension');

const root = path.resolve(__dirname, '..');

async function main() {
  const files = [];
  for (const directory of ['src', 'media', 'scripts', 'test']) {
    const entries = await walkRegularFiles(path.join(root, directory));
    files.push(...entries
      .filter(entry => entry.relative.endsWith('.js'))
      .map(entry => path.join(root, directory, entry.relative)));
  }
  files.sort();

  const failures = [];
  for (const file of files) {
    const checked = spawnSync(process.execPath, ['--check', file], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true
    });
    if (checked.status !== 0) {
      failures.push({
        file: path.relative(root, file),
        output: String(checked.stderr || checked.stdout || '').trim()
      });
    }
  }
  if (failures.length)
    throw new Error(`syntax check failed:\n${failures.map(item => `${item.file}\n${item.output}`).join('\n')}`);
  process.stdout.write(`syntax checked ${files.length} JavaScript files\n`);
}

main().catch(error => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 1;
});
