import { mkdtemp, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import { productionMigrationNamesFromDisk } from '../../scripts/lexical-migration-head.mjs';

export const PACKAGE_ROOT = resolve(import.meta.dirname, '../..');
export const PRODUCTION_MIGRATIONS_DIRECTORY = resolve(PACKAGE_ROOT, 'migrations');

/**
 * A temporary migration folder holding symlinks to a subset of the production
 * migrations, for tests that run a partial chain.
 *
 * The folder is created INSIDE the package root (next to `migrations/`), not
 * under the OS temp directory. `runMigrations` imports each file through its
 * `file://` URL, and Vitest 4's module runner keeps that symlink path as the
 * importer instead of its real path, so a migration's `../src/...` import is
 * resolved relative to the folder that holds the symlink. A sibling of
 * `migrations/` resolves the same `../src/...` as the originals; a folder
 * under `/tmp` does not (`Cannot find module '../src/...'`). The caller must
 * remove the folder when done (`rm(directory, { recursive: true })`).
 */
export async function migrationDirectoryExcluding(excluded: ReadonlySet<string>): Promise<string> {
  const directory = await mkdtemp(resolve(PACKAGE_ROOT, '.migrations-subset-'));
  const names = productionMigrationNamesFromDisk(PRODUCTION_MIGRATIONS_DIRECTORY)
    .filter((name) => !excluded.has(name));
  await Promise.all(names.map((name) => symlink(
    resolve(PRODUCTION_MIGRATIONS_DIRECTORY, `${name}.ts`),
    resolve(directory, `${name}.ts`),
  )));
  return directory;
}
