import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  createPostgresSchemaIsolation,
  type PostgresSchemaIsolation,
} from '../../support/postgres-schema-isolation.js';

describeWithPostgres('per-test PostgreSQL schema isolation', () => {
  let isolated: IsolatedPostgresRuntime;
  let isolation: PostgresSchemaIsolation;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('schema_isolation_probe', { maxConnections: 2 });
    isolation = createPostgresSchemaIsolation(isolated);
    // The schema is still fresh here (no migrations, no tables): a reset must
    // be a safe no-op rather than a failure.
    await isolation.reset();
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(async () => {
    await isolation.reset();
  });

  test('test 1 inserts data, including rows guarded by permanence triggers', async () => {
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status)
       values ('isolation-probe-account', 'isolation-probe-subject', 'active')`,
    );
    // resource_id_ledger rows reject ordinary DELETE/UPDATE. Truncating them
    // here proves the reset disables permanence triggers instead of relying on
    // per-row deletes.
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ('isolation-probe-ledger', 'node')`,
    );
    const sequence = await isolated.runtime.pool.query<{ value: string }>(
      `select nextval('community_rank_refresh_ordinal')::text as value`,
    );
    assert.equal(sequence.rows[0]?.value, '1', 'the reset restarted the schema sequence');

    const counts = await isolated.runtime.pool.query<{ accounts: number; ledger: number }>(
      `select (select count(*)::int from accounts) as accounts,
              (select count(*)::int from resource_id_ledger) as ledger`,
    );
    assert.deepEqual(counts.rows[0], { accounts: 1, ledger: 1 });
  });

  test('test 2 observes none of test 1 rows and keeps the migrated schema', async () => {
    const counts = await isolated.runtime.pool.query<{
      accounts: number;
      ledger: number;
      migrations: number;
    }>(
      `select (select count(*)::int from accounts) as accounts,
              (select count(*)::int from resource_id_ledger) as ledger,
              (select count(*)::int from kysely_migration) as migrations`,
    );
    assert.equal(counts.rows[0]?.accounts, 0, 'test 1 account rows must be gone');
    assert.equal(counts.rows[0]?.ledger, 0, 'permanence-guarded ledger rows must be gone');
    assert.ok(counts.rows[0]!.migrations > 0, 'migration bookkeeping must survive the reset');

    const sequence = await isolated.runtime.pool.query<{ value: string }>(
      `select nextval('community_rank_refresh_ordinal')::text as value`,
    );
    assert.equal(sequence.rows[0]?.value, '1', 'sequences restart for each test');
  });
});
