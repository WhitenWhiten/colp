import assert from 'node:assert/strict';
import { lstat, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, test } from 'vitest';

import {
  migrationDirectoryExcluding,
  PACKAGE_ROOT,
  PRODUCTION_MIGRATIONS_DIRECTORY,
} from '../../support/migration-subset-directory.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// This migration imports `../src/modules/collections/domain/resource-payload.js`;
// it is the file that failed in CI when the subset folder lived under /tmp.
const SRC_IMPORTING_MIGRATION = '202607222600_canonical_resource_payloads';

test('the subset folder is a sibling of migrations/ so file-URL imports resolve ../src', async () => {
  const directory = await migrationDirectoryExcluding(new Set());
  created.push(directory);
  assert.equal(dirname(directory), PACKAGE_ROOT);
  assert.equal(dirname(PRODUCTION_MIGRATIONS_DIRECTORY), PACKAGE_ROOT);
  const entry = resolve(directory, `${SRC_IMPORTING_MIGRATION}.ts`);
  assert.ok((await lstat(entry)).isSymbolicLink());
  // Same import shape as runMigrations (FileMigrationProvider `import` option):
  // a file:// URL of the symlink, whose importer path is not realpath'd.
  const module = await import(/* @vite-ignore */ pathToFileURL(entry).href) as { migration?: unknown };
  assert.equal(typeof module.migration, 'object');
});

test('excluded names are absent and every other production migration is linked', async () => {
  const excluded = new Set([SRC_IMPORTING_MIGRATION]);
  const directory = await migrationDirectoryExcluding(excluded);
  created.push(directory);
  const linked = (await readdir(directory)).sort();
  const production = (await readdir(PRODUCTION_MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith('.ts') && !excluded.has(name.slice(0, -3)))
    .sort();
  assert.deepEqual(linked, production);
});
