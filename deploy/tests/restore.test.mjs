import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const script = await readFile(new URL('../restore.sh', import.meta.url), 'utf8');

async function restore(failure = '') {
  const directory = await mkdtemp(join(tmpdir(), 'colp-restore-'));
  try {
    await mkdir(join(directory, 'bin'));
    await writeFile(join(directory, 'restore.sh'), script);
    await writeFile(join(directory, '.env'), '');
    await writeFile(join(directory, 'backup.dump'), 'archive fixture');
    await writeFile(join(directory, 'bin/docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COLP_RESTORE_LOG, JSON.stringify(args) + '\\n');
if (args.includes('pg_restore')) {
  fs.readFileSync(0);
  if (process.env.COLP_RESTORE_FAILURE === 'archive') process.exit(1);
}
if (args.includes('psql') && !args.includes('-c')) {
  fs.readFileSync(0);
  if (process.env.COLP_RESTORE_FAILURE === 'revalidation') process.exit(1);
}
if (args.includes('psql') && args.some(a => a.startsWith('ALTER DATABASE')) && process.env.COLP_RESTORE_FAILURE === 'cutover') process.exit(1);
`, { mode: 0o755 });
    const result = await exec('bash', [join(directory, 'restore.sh'), join(directory, 'backup.dump')], {
      env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`,
        COLP_RESTORE_LOG: join(directory, 'calls'), COLP_RESTORE_FAILURE: failure },
    }).then(value => ({ ...value, code: 0 }), error => error);
    const calls = (await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
    return { result, calls };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const failure of ['archive', 'revalidation', 'cutover']) {
  test(`restore preserves the original database on ${failure} failure`, async () => {
    const { result, calls } = await restore(failure);
    assert.equal(result.code, 1);
    const drops = calls.flat().filter(arg => arg.startsWith('DROP DATABASE'));
    assert.equal(drops.length, 1);
    assert.match(drops[0], /^DROP DATABASE IF EXISTS colp_restore_/u);
    assert.ok(!calls.some(args => args.includes('pg_restore') && args[args.indexOf('-d') + 1] === 'colp'));
    const cutover = calls.find(args => args.some(arg => arg.startsWith('ALTER DATABASE')));
    if (failure !== 'cutover') assert.equal(cutover, undefined);
    else assert.ok(cutover.includes('--single-transaction'));
    assert.ok(!calls.some(args => args.includes('ready')));
  });
}

test('restore revalidates before the atomic cutover and retains the previous database', async () => {
  const { result, calls } = await restore();
  assert.equal(result.code, 0);
  const importIndex = calls.findIndex(args => args.includes('pg_restore'));
  const revalidationIndex = calls.findIndex(args => args.includes('psql') && !args.includes('-c'));
  const cutoverIndex = calls.findIndex(args => args.some(arg => arg.startsWith('ALTER DATABASE')));
  assert.ok(importIndex < revalidationIndex && revalidationIndex < cutoverIndex);
  assert.ok(calls[cutoverIndex].includes('--single-transaction'));
  assert.ok(!calls.flat().some(arg => arg.startsWith('DROP DATABASE')));
  assert.match(result.stdout, /Previous database retained as colp_before_restore_/u);
});
