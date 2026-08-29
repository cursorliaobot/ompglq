'use strict';

const { compareDist } = require('./build-extension');

async function main() {
  const result = await compareDist();
  if (!result.ok) {
    throw new Error(
      'dist differs from src: ' +
      JSON.stringify({
        missing: result.missing,
        extra: result.extra,
        changed: result.changed
      })
    );
  }
  process.stdout.write('dist matches src\n');
}

main().catch(error => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 1;
});
