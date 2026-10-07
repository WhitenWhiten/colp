import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  sql,
  type Kysely,
} from 'kysely';
import {
  FileMigrationProvider,
  Migrator,
  type MigrationResult,
  type MigrationResultSet,
} from 'kysely/migration';
import type { DatabaseSchema } from './runtime.js';
import { isConcurrentCatalogRaceError } from './concurrent-catalog.js';
import { AUDIT_GUARD_REPLACEMENT, bridgeAuditMigrationHistory } from './audit-migration-history.js';

export type MigrationCommand = 'latest' | 'up' | 'down';

export interface MigrationRunResult {
  readonly command: MigrationCommand;
  readonly results: readonly MigrationResult[];
}

const MIGRATION_STABILITY_ATTEMPTS = 8;
const MIGRATION_NAME_COLLATOR = 'en-US';

export function resolveMigrationDirectory(directory = 'migrations'): string {
  return path.isAbsolute(directory)
    ? path.relative(process.cwd(), directory) || '.'
    : directory;
}

/**
 * Kysely 0.29 sorts executed migrations by `kysely_migration.timestamp`
 * (ISO string from `new Date().toISOString()`) before comparing them to the
 * file-name order. Same-millisecond inserts and WSL2/NTP clock steps invert
 * that timestamp order; the next `migrateTo`/`migrateToLatest` then fails
 * with `corrupted migrations: expected previously executed migration …`.
 */
export function isMigrationTimestampOrderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('corrupted migrations: expected previously executed migration');
}

function compareMigrationNames(left: string, right: string): number {
  return left.localeCompare(right, MIGRATION_NAME_COLLATOR);
}

function qualifiedMigrationTable(schema?: string) {
  if (!schema) return sql.id('kysely_migration');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`unsafe migration table schema: ${schema}`);
  }
  return sql.id(schema, 'kysely_migration');
}

/**
 * Rewrite `kysely_migration.timestamp` so timestamp order equals `C`/name
 * order. Kysely's down path also walks timestamp order, so this keeps
 * rollback aligned with the file chain after a clock step.
 */
export async function canonicalizeExecutedMigrationTimestamps(
  db: Kysely<DatabaseSchema>,
  migrationTableSchema?: string,
): Promise<void> {
  const table = qualifiedMigrationTable(migrationTableSchema);
  await sql`
    UPDATE ${table} AS m
    SET timestamp = o.ts
    FROM (
      SELECT name,
             to_char(
               TIMESTAMPTZ '2000-01-01 00:00:00+00'
               + (row_number() OVER (ORDER BY name COLLATE "C") * INTERVAL '1 millisecond'),
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             ) AS ts
      FROM ${table}
    ) AS o
    WHERE m.name = o.name
  `.execute(db);
}

function isRetryableMigratorError(error: unknown): boolean {
  return isConcurrentCatalogRaceError(error) || isMigrationTimestampOrderError(error);
}

async function sleepBeforeMigratorRetry(attempt: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 15 + attempt * 30);
  });
}

async function stabilizeMigratorOutcome(
  db: Kysely<DatabaseSchema>,
  migrationTableSchema: string | undefined,
  run: () => Promise<MigrationResultSet>,
): Promise<MigrationResultSet> {
  let last: MigrationResultSet | undefined;
  for (let attempt = 1; attempt <= MIGRATION_STABILITY_ATTEMPTS; attempt += 1) {
    last = await run();
    if (!last.error) {
      try {
        await canonicalizeExecutedMigrationTimestamps(db, migrationTableSchema);
      } catch (error) {
        if (!isConcurrentCatalogRaceError(error)) throw error;
      }
      return last;
    }
    if (!isRetryableMigratorError(last.error) || attempt === MIGRATION_STABILITY_ATTEMPTS) {
      return last;
    }
    if (isMigrationTimestampOrderError(last.error)) {
      try {
        await canonicalizeExecutedMigrationTimestamps(db, migrationTableSchema);
      } catch (error) {
        if (!isConcurrentCatalogRaceError(error) && !isMigrationTimestampOrderError(error)) {
          throw error;
        }
      }
    }
    await sleepBeforeMigratorRetry(attempt);
  }
  return last ?? { error: new Error('migrator produced no outcome') };
}

function stabilizeMigrator(
  migrator: Migrator,
  db: Kysely<DatabaseSchema>,
  factory: (connection: Kysely<DatabaseSchema>) => Migrator,
  migrationNames: () => Promise<string[]>,
  migrationTableSchema?: string,
): Migrator {
  const run = async (operation: (raw: Migrator) => Promise<MigrationResultSet>, upgradeAuditHistory = false): Promise<MigrationResultSet> => {
    const locked = async (connection: Kysely<DatabaseSchema>) => {
      const adapter = connection.getExecutor().adapter;
      const lock = { lockTable: 'kysely_migration_lock', lockRowId: 'migration_lock', lockTableSchema: migrationTableSchema };
      await adapter.acquireMigrationLock(connection, lock);
      try {
        if (upgradeAuditHistory) {
          const names = await migrationNames();
          if (connection.isTransaction) await bridgeAuditMigrationHistory(connection, names, migrationTableSchema);
          else await connection.transaction().execute(tx => bridgeAuditMigrationHistory(tx, names, migrationTableSchema));
        }
        // The raw migrator's advisory lock is reentrant on this SAME session.
        // Do not invoke the pooled migrator while holding the outer lock.
        return await stabilizeMigratorOutcome(connection, migrationTableSchema, () => operation(factory(connection)));
      } finally { await adapter.releaseMigrationLock(connection, lock); }
    };
    try { return await (db.isTransaction ? locked(db) : db.connection().execute(locked)); }
    catch (error) { return { error }; }
  };
  migrator.migrateToLatest = options => run(raw => raw.migrateToLatest(options), true);
  migrator.migrateTo = (target, options) => run(raw => raw.migrateTo(target, options),
    typeof target === 'string' && target >= AUDIT_GUARD_REPLACEMENT);
  migrator.migrateUp = options => run(raw => raw.migrateUp(options), true);
  migrator.migrateDown = options => run(raw => raw.migrateDown(options));
  return migrator;
}

export function createMigrator(
  db: Kysely<DatabaseSchema>,
  migrationDirectory = resolveMigrationDirectory(),
  migrationTableSchema?: string,
): Migrator {
  const provider = new FileMigrationProvider({
    fs,
    path,
    migrationFolder: migrationDirectory,
    import: (filePath) => import(pathToFileURL(path.resolve(filePath)).href),
  });
  const orderedProvider = {
    async getMigrations() {
      const migrations = await provider.getMigrations();
      return Object.fromEntries(Object.entries(migrations).sort(([left], [right]) => compareMigrationNames(left, right)));
    },
  };
  const factory = (connection: Kysely<DatabaseSchema>) => new Migrator({
    db: connection,
    ...(migrationTableSchema ? { migrationTableSchema } : {}),
    nameComparator: compareMigrationNames,
    provider: orderedProvider,
  });
  return stabilizeMigrator(factory(db), db, factory,
    async () => Object.keys(await orderedProvider.getMigrations()), migrationTableSchema);
}

export async function runMigrations(
  db: Kysely<DatabaseSchema>,
  command: MigrationCommand,
  migrationDirectory = resolveMigrationDirectory(),
): Promise<MigrationRunResult> {
  const schema = await sql<{ name: string }>`select current_schema() as name`.execute(db);
  const migrationTableSchema = schema.rows[0]?.name;
  if (!migrationTableSchema) throw new Error('database connection has no current schema');
  const migrator = createMigrator(db, migrationDirectory, migrationTableSchema);
  const outcome = command === 'latest'
    ? await migrator.migrateToLatest()
    : command === 'up'
      ? await migrator.migrateUp()
      : await migrator.migrateDown();
  if (outcome.error) throw outcome.error;
  return { command, results: outcome.results ?? [] };
}
