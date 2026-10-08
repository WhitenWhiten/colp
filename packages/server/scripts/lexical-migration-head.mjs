/**
 * Production migration chain from the files on disk.
 *
 * Fresh evidence runs and postgres up/down pins must follow the lexically
 * last `migrations/\d{12}_*.ts` stem. Hand-written I16/R05/RL07/REAL heads
 * drift every time a worktree lands a new `20*.ts` file. Historical
 * evidence artifacts keep the head they recorded; validators in retained
 * mode recompute from git at that revision instead of vetoing with this.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATION_FILE_NAME = /^(\d{12}_[a-z0-9_]+)\.ts$/u;

function defaultMigrationsDirectory() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

/** Oldest → newest production migration stems. */
export function productionMigrationNamesFromDisk(
  migrationsDirectory = defaultMigrationsDirectory(),
) {
  return readdirSync(migrationsDirectory)
    .map((name) => MIGRATION_FILE_NAME.exec(name)?.[1])
    .filter((name) => typeof name === 'string')
    .sort();
}

/** Lexically last `migrations/*.ts` stem. */
export function lexicalMigrationHeadFromDisk(
  migrationsDirectory = defaultMigrationsDirectory(),
) {
  const names = productionMigrationNamesFromDisk(migrationsDirectory);
  const head = names.at(-1);
  if (!head) throw new Error('migration_head_missing');
  return head;
}

/** Newest → oldest names down to and including `untilName`. */
export function productionMigrationNamesNewestFirstUntil(
  untilName,
  migrationsDirectory = defaultMigrationsDirectory(),
) {
  const newestFirst = [...productionMigrationNamesFromDisk(migrationsDirectory)].reverse();
  const index = newestFirst.indexOf(untilName);
  if (index < 0) throw new Error(`migration_until_missing:${untilName}`);
  return newestFirst.slice(0, index + 1);
}

/** Oldest → newest names from `startName` through the current head. */
export function productionMigrationNamesFromInclusive(
  startName,
  migrationsDirectory = defaultMigrationsDirectory(),
) {
  const names = productionMigrationNamesFromDisk(migrationsDirectory);
  const index = names.indexOf(startName);
  if (index < 0) throw new Error(`migration_start_missing:${startName}`);
  return names.slice(index);
}
