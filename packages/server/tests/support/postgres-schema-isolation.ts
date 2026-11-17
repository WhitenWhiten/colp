import type { PoolClient } from 'pg';
import {
  FIXTURE_DISABLE_PERMANENCE_TRIGGERS,
  type IsolatedPostgresRuntime,
} from './postgres-test-runtime.js';

/**
 * Migration bookkeeping created by Kysely. These rows are the migrated schema
 * itself, so per-test data cleanup must never delete them.
 */
const PRESERVED_TABLES: ReadonlySet<string> = new Set([
  'kysely_migration',
  'kysely_migration_lock',
]);

export interface PostgresSchemaIsolation {
  readonly schema: string;
  /** Remove every data row and restart every sequence in the isolated schema. */
  reset(): Promise<void>;
}

interface NameRow {
  readonly name: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

async function truncatableTables(client: PoolClient, schema: string): Promise<readonly string[]> {
  const tables = await client.query<NameRow>(`
    select c.relname as name
    from pg_class as c
    join pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = $1
      and c.relkind in ('r', 'p')
      and not c.relispartition
    order by c.relname`, [schema]);
  return tables.rows.map((row) => row.name).filter((name) => !PRESERVED_TABLES.has(name));
}

async function schemaSequences(client: PoolClient, schema: string): Promise<readonly string[]> {
  const sequences = await client.query<NameRow>(`
    select c.relname as name
    from pg_class as c
    join pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relkind = 'S'
    order by c.relname`, [schema]);
  return sequences.rows.map((row) => row.name);
}

/**
 * Opt-in per-test isolation for a file-scoped PostgreSQL schema.
 *
 * `reset()` truncates every base table in the file's isolated schema in one
 * statement, which keeps every foreign key satisfied, and restarts every
 * sequence in that schema so serial values do not leak between tests. The
 * transaction runs with `session_replication_role = 'replica'` so ledger
 * permanence/immutability triggers (which reject DELETE and sometimes
 * TRUNCATE) cannot block fixture cleanup; the setting is transaction-local.
 *
 * The schema may be fresh (no tables yet): the reset is then a no-op. Only
 * Kysely's migrated-schema bookkeeping is preserved. Rows installed by a
 * migration itself (for example default switch rows) are data like any other,
 * so a suite that needs them must recreate them after `reset()`.
 *
 * Suites share one schema per file by design; adopting this helper is
 * intentionally opt-in rather than a global change to the existing suites.
 */
export function createPostgresSchemaIsolation(
  isolated: Pick<IsolatedPostgresRuntime, 'schema' | 'runtime'>,
): PostgresSchemaIsolation {
  if (!/^[a-z][a-z0-9_]*$/.test(isolated.schema)) {
    throw new Error(`unsafe isolated schema name: ${isolated.schema}`);
  }
  const schema = isolated.schema;

  return {
    schema,
    async reset(): Promise<void> {
      const client = await isolated.runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query(FIXTURE_DISABLE_PERMANENCE_TRIGGERS);
        const tables = await truncatableTables(client, schema);
        if (tables.length > 0) {
          await client.query(`truncate table ${tables.map((name) => qualified(schema, name)).join(', ')}`);
        }
        for (const sequence of await schemaSequences(client, schema)) {
          await client.query(`alter sequence ${qualified(schema, sequence)} restart with 1`);
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
