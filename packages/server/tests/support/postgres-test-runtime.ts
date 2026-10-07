import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { createDatabaseRuntime, type DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import {
  configuredTestDatabaseUrl as configuredTestDatabaseUrlFromMode,
  isFailClosedPostgresMode,
  requireTestDatabaseUrl as requireTestDatabaseUrlFromMode,
  resolvePostgresEvidenceMode,
  resolvePostgresSuiteGate,
} from '../../scripts/postgres-evidence-mode.mjs';

// Lazy-load the vitest suite gate so this module can also be imported by
// processes OUTSIDE vitest (the phase4a evidence CLIs run via tsx and pull
// helper chains that reach this file). vitest is ESM-only, so a static
// top-level import would crash those CLIs before any fail-closed check.
// Inside vitest the dynamic import resolves to the real suite functions;
// outside it the gate degrades to no-ops (only test files invoke it).
type VitestDescribe = ((name: string, fn: () => void) => void) & {
  skip: (name: string, fn: () => void) => void;
};
type VitestTest = (name: string, fn: () => void | Promise<void>) => void;
const noopDescribe = (() => undefined) as unknown as VitestDescribe;
const vitestGate: { describe: VitestDescribe; test: VitestTest } = await import('vitest')
  .then((vitest) => ({
    describe: vitest.describe as VitestDescribe,
    test: vitest.test,
  }))
  .catch(() => ({ describe: noopDescribe, test: () => undefined }));

export type PostgresEvidenceMode = 'acceptance' | 'local-opt-out' | 'default';
export type PostgresSuiteAction = 'run' | 'skip' | 'fail';
export interface PostgresSuiteGate {
  readonly action: PostgresSuiteAction;
  readonly mode: PostgresEvidenceMode;
  readonly databaseUrl?: string;
  readonly message: string;
}

export interface IsolatedPostgresRuntime {
  readonly databaseUrl: string;
  readonly schema: string;
  readonly runtime: DatabaseRuntime;
  close(): Promise<void>;
}

export function configuredTestDatabaseUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return configuredTestDatabaseUrlFromMode(env);
}

export { isFailClosedPostgresMode, resolvePostgresEvidenceMode, resolvePostgresSuiteGate };

export function requireTestDatabaseUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  return requireTestDatabaseUrlFromMode(env);
}

/**
 * Vitest suite gate for PostgreSQL-required integration evidence.
 * - URL present → run
 * - local-opt-out without URL → describe.skip with a loud warning
 * - acceptance/default without URL → fail-closed suite (not skip/pass)
 */
export function describeWithPostgres(name: string, suite: () => void): void {
  const { describe, test } = vitestGate;
  const gate = resolvePostgresSuiteGate() as PostgresSuiteGate;
  if (gate.action === 'run') {
    describe(name, suite);
    return;
  }
  if (gate.action === 'skip') {
    console.warn(`[postgres-evidence] ${gate.message}`);
    describe.skip(name, suite);
    return;
  }
  describe(name, () => {
    test(`PostgreSQL evidence required (fail-closed, mode=${gate.mode})`, () => {
      assert.fail(gate.message);
    });
  });
}

export async function createIsolatedPostgresRuntime(
  prefix: string,
  options: {
    readonly maxConnections?: number;
    readonly applicationName?: string;
    readonly statementTimeoutMs?: number;
  } = {},
): Promise<IsolatedPostgresRuntime> {
  const databaseUrl = requireTestDatabaseUrl();
  assert.match(prefix, /^[a-z][a-z0-9_]*$/, 'schema prefix must be a safe PostgreSQL identifier fragment');

  const schema = `${prefix}_${randomUUID().replaceAll('-', '_')}`;
  const administrator = new Pool({ connectionString: databaseUrl, max: 1 });
  await administrator.query(`create schema ${schema}`);

  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtime = createDatabaseRuntime(isolatedUrl.toString(), {
    maxConnections: options.maxConnections ?? 6,
    applicationName: options.applicationName ?? `known-test-${prefix}`,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: options.statementTimeoutMs,
  });
  let closePromise: Promise<void> | undefined;

  return {
    databaseUrl: isolatedUrl.toString(),
    schema,
    runtime,
    close(): Promise<void> {
      closePromise ??= (async () => {
        await runtime.close();
        await administrator.query(`drop schema if exists ${schema} cascade`);
        await administrator.end();
      })();
      return closePromise;
    },
  };
}

/** Skip ledger permanence triggers so isolated-schema fixtures can TRUNCATE. */
export const FIXTURE_DISABLE_PERMANENCE_TRIGGERS =
  "set local session_replication_role = 'replica'";

/** Truncate ledger tables inside an open fixture transaction, then restore triggers. */
export async function truncateGuardedTablesInTransaction(
  client: PoolClient,
  truncateSql: string,
): Promise<void> {
  await client.query(FIXTURE_DISABLE_PERMANENCE_TRIGGERS);
  await client.query(truncateSql);
  await client.query("set local session_replication_role = 'origin'");
}

/** Run INSERT/UPDATE/DELETE/TRUNCATE while ledger permanence triggers are skipped. */
export async function executeWithoutPermanenceGuards(
  pool: Pool,
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(FIXTURE_DISABLE_PERMANENCE_TRIGGERS);
    await client.query(statement, [...parameters]);
    await client.query('commit');
  } catch (error) {
    try { await client.query('rollback'); } catch { /* already failed */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function truncateFixtureTables(
  pool: Pool,
  truncateSql: string,
): Promise<void> {
  await executeWithoutPermanenceGuards(pool, truncateSql);
}
