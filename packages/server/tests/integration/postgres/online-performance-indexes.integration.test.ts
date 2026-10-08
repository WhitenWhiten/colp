import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  ensureTransactionalPerformanceIndex,
  installOnlinePerformanceIndex,
  MAX_TRANSACTIONAL_INDEX_TABLE_BYTES,
  ONLINE_PERFORMANCE_INDEX_LIST,
  ONLINE_PERFORMANCE_INDEXES,
  type OnlinePerformanceIndexDefinition,
} from '../../../src/infrastructure/database/online-performance-indexes.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('online performance index rollout', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('online_performance_indexes');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('latest migration created and structurally validates every manifest index', async () => {
    const client = await isolated.runtime.pool.connect();
    try {
      for (const definition of ONLINE_PERFORMANCE_INDEX_LIST) {
        assert.equal(await installOnlinePerformanceIndex(client, definition), 'present');
      }
    } finally {
      client.release();
    }
  });

  test('rebuilds a missing index concurrently and stays idempotent', async () => {
    const definition = ONLINE_PERFORMANCE_INDEXES.exploreViews;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query(`DROP INDEX publication_insight_daily_explore_views_idx`);
      assert.equal(await installOnlinePerformanceIndex(client, definition), 'created');
      assert.equal(await installOnlinePerformanceIndex(client, definition), 'present');
    } finally {
      client.release();
    }
  });

  test('refuses a valid same-name index with the wrong definition', async () => {
    const definition = ONLINE_PERFORMANCE_INDEXES.outboxExpiredLease;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query(`DROP INDEX outbox_expired_lease_due_candidate_idx`);
      await client.query(`CREATE INDEX outbox_expired_lease_due_candidate_idx
        ON outbox_events (outbox_id)`);
      await assert.rejects(
        installOnlinePerformanceIndex(client, definition),
        /definition does not match/iu,
      );
      await client.query(`DROP INDEX outbox_expired_lease_due_candidate_idx`);
      assert.equal(await installOnlinePerformanceIndex(client, definition), 'created');
    } finally {
      client.release();
    }
  });

  test('repairs the invalid catalog entry left by a failed concurrent build', async () => {
    const definition = ONLINE_PERFORMANCE_INDEXES.authSessionTokenLookup;
    const client = await isolated.runtime.pool.connect();
    const lookupHash = `knsh1.1.${'A'.repeat(43)}`;
    try {
      await client.query(`DROP INDEX auth_sessions_token_lookup_hash_uidx`);
      await client.query(`INSERT INTO auth_users (id, name, email, "emailVerified")
        VALUES ('online-index-user', 'Online Index', 'online-index@example.test', true)`);
      await client.query(`INSERT INTO auth_sessions
          (id, "expiresAt", token, "updatedAt", "userId", "tokenLookupHash")
        VALUES
          ('online-index-session-a', now() + interval '1 hour', 'online-index-token-a', now(),
            'online-index-user', $1),
          ('online-index-session-b', now() + interval '1 hour', 'online-index-token-b', now(),
            'online-index-user', $1)`, [lookupHash]);

      await assert.rejects(
        client.query(definition.createConcurrentlySql),
        /could not create unique index|duplicate key/iu,
      );
      const invalid = await client.query<{ is_valid: boolean; is_ready: boolean }>(`
        SELECT catalog.indisvalid AS is_valid, catalog.indisready AS is_ready
          FROM pg_index catalog
          JOIN pg_class index_relation ON index_relation.oid = catalog.indexrelid
          JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
         WHERE namespace.nspname = current_schema() AND index_relation.relname = $1
      `, [definition.name]);
      assert.equal(invalid.rows[0]?.is_valid, false);

      await client.query(`DELETE FROM auth_sessions WHERE id = 'online-index-session-b'`);
      assert.equal(await installOnlinePerformanceIndex(client, definition), 'repaired');
      assert.equal(await installOnlinePerformanceIndex(client, definition), 'present');
    } finally {
      try {
        await client.query(`DELETE FROM auth_users WHERE id = 'online-index-user'`);
      } finally {
        client.release();
      }
    }
  });

  test('transactional path fails before index DDL for a relation above the online threshold', async () => {
    const definition: OnlinePerformanceIndexDefinition = {
      name: 'online_index_large_relation_id_idx',
      tableName: 'online_index_large_relation',
      createConcurrentlySql: `CREATE INDEX CONCURRENTLY online_index_large_relation_id_idx
        ON online_index_large_relation (id)`,
      definitionPatterns: [/\(id\)/iu],
    };
    try {
      await isolated.runtime.pool.query(`CREATE TABLE online_index_large_relation (
        id integer NOT NULL,
        payload text NOT NULL
      )`);
      await isolated.runtime.pool.query(
        `ALTER TABLE online_index_large_relation ALTER COLUMN payload SET STORAGE EXTERNAL`,
      );
      await isolated.runtime.pool.query(`INSERT INTO online_index_large_relation (id, payload)
        SELECT n, repeat(md5(n::text), 32768)
          FROM generate_series(1, 68) AS n`);
      const size = await isolated.runtime.pool.query<{ bytes: string }>(`
        SELECT pg_total_relation_size('online_index_large_relation'::regclass)::text AS bytes
      `);
      assert.ok(
        BigInt(size.rows[0]?.bytes ?? '0') > MAX_TRANSACTIONAL_INDEX_TABLE_BYTES,
      );

      await assert.rejects(
        isolated.runtime.db.transaction().execute(async (transaction) => {
          await ensureTransactionalPerformanceIndex(transaction, definition);
        }),
        /db:indexes:online -- --only=online_index_large_relation_id_idx/iu,
      );
      const missing = await isolated.runtime.pool.query<{ index_name: string | null }>(
        `SELECT to_regclass('online_index_large_relation_id_idx')::text AS index_name`,
      );
      assert.equal(missing.rows[0]?.index_name, null);
    } finally {
      await isolated.runtime.pool.query(`DROP TABLE IF EXISTS online_index_large_relation`);
    }
  }, 120_000);
});
