/** Seed registry metadata and tarballs from trusted repository dependencies only. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeConsumerTreeReadable } from './lib/consumer-permissions.mjs';
import { isolatedProcessEnvironment, runNpm } from './lib/npm-command.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function prepareCleanConsumerCache(cache) {
  assert.ok(isAbsolute(cache), 'Pass an absolute path for a dedicated npm cache.');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'));
  const temporary = await mkdtemp(join(tmpdir(), 'colp-cache-preparation-'));
  try {
    await mkdir(join(temporary, 'npm-tmp'));
    await writeFile(join(temporary, 'user.npmrc'), '');
    await writeFile(join(temporary, 'global.npmrc'), '');
    await writeFile(join(temporary, 'package.json'), JSON.stringify({
      name: 'colp-trusted-cache-seed', private: true,
      dependencies: {
        ...manifest.dependencies,
        typescript: lock.packages['node_modules/typescript'].version,
        '@types/node': lock.packages['node_modules/@types/node'].version,
      },
    }));
    // npm ci caches lockfile tarballs but can omit the packuments required by
    // a new consumer. Resolve this trusted manifest in a fresh project so both
    // metadata and artifacts exist before the candidate enters Docker.
    await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund',
      '--workspaces=false', '--registry=https://registry.npmjs.org/'], temporary, {
      env: { ...isolatedProcessEnvironment(temporary), npm_config_cache: cache },
    });
    await makeConsumerTreeReadable(cache);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-clean-consumer-cache.mjs /absolute/cache');
  await prepareCleanConsumerCache(process.argv[2]);
}
