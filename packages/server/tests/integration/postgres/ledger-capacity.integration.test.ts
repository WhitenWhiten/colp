import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { inspectLedgerCapacity } from '../../../src/infrastructure/database/ledger-capacity.js';
import { inspectAppendHeavyCompleteness } from '../../../src/infrastructure/database/ledger-append-heavy-completeness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('append-only ledger capacity inventory', () => {
  let isolated: IsolatedPostgresRuntime;
  let fixture: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ledger_capacity');
    await runMigrations(isolated.runtime.db, 'latest');
    fixture = await createIsolatedPostgresRuntime('ledger_capacity_fixture');
    await fixture.runtime.pool.query(`
      CREATE TABLE resource_id_ledger (
        resource_id text PRIMARY KEY,
        created_at timestamptz NOT NULL
      );
      INSERT INTO resource_id_ledger VALUES
        ('resource-1', '2026-01-01'), ('resource-2', '2026-01-02');
      CREATE TABLE outbox_delivery_receipts (
        handler_name text NOT NULL,
        domain_event_id text NOT NULL,
        delivered_at timestamptz NOT NULL,
        PRIMARY KEY (handler_name, domain_event_id, delivered_at)
      ) PARTITION BY RANGE (delivered_at);
      CREATE TABLE outbox_delivery_receipts_2025 PARTITION OF outbox_delivery_receipts
        FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
      CREATE TABLE outbox_delivery_receipts_2026 PARTITION OF outbox_delivery_receipts
        FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      CREATE INDEX outbox_delivery_receipts_2025_handler_idx
        ON outbox_delivery_receipts_2025 (handler_name);
      CREATE INDEX outbox_delivery_receipts_2026_handler_idx
        ON outbox_delivery_receipts_2026 (handler_name);
      INSERT INTO outbox_delivery_receipts VALUES
        ('mail', 'event-1', '2025-01-01'),
        ('mail', 'event-2', '2025-06-01'),
        ('mail', 'event-3', '2026-01-01'),
        ('mail', 'event-4', '2026-06-01'),
        ('mail', 'event-5', '2026-08-01');
      ANALYZE resource_id_ledger;
      ANALYZE outbox_delivery_receipts_2025;
      ANALYZE outbox_delivery_receipts_2026;
      SELECT pg_stat_force_next_flush();
    `);
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
    await isolated?.close();
  });

  test('reads every explicit ledger from catalog statistics without data scans', async () => {
    const rows = await inspectLedgerCapacity(isolated.runtime.pool, {
      warnRows: 0n,
      warnBytes: 2n ** 62n,
    });
    assert.equal(rows.length, 24);
    assert.ok(rows.every((row) => row.present));
    assert.ok(rows.every((row) => row.partitionCount === 0));
    assert.ok(rows.every((row) => row.totalBytes >= row.tableBytes));
    assert.ok(rows.every((row) => row.warning));
  });

  test('reports regular, missing and declaratively partitioned targets without double counting', async () => {
    const rows = await inspectLedgerCapacity(fixture.runtime.pool, {
      warnRows: 5n,
      warnBytes: 2n ** 62n,
    });
    const regular = rows.find((row) => row.tableName === 'resource_id_ledger');
    const missing = rows.find((row) => row.tableName === 'operations');
    const partitioned = rows.find((row) => row.tableName === 'outbox_delivery_receipts');
    assert.deepEqual({ present: regular?.present, partitions: regular?.partitionCount,
      rows: regular?.estimatedRows, warning: regular?.warning },
    { present: true, partitions: 0, rows: 2n, warning: false });
    assert.deepEqual({ present: missing?.present, partitions: missing?.partitionCount,
      rows: missing?.estimatedRows, bytes: missing?.totalBytes },
    { present: false, partitions: 0, rows: 0n, bytes: 0n });
    assert.equal(partitioned?.present, true);
    assert.equal(partitioned?.partitionCount, 2);
    assert.equal(partitioned?.estimatedRows, 5n);
    assert.equal(partitioned?.warning, true);

    const expected = await fixture.runtime.pool.query<{
      table_bytes: string; index_bytes: string; total_bytes: string;
    }>(`
      SELECT sum(pg_relation_size(relid))::text AS table_bytes,
             sum(pg_indexes_size(relid))::text AS index_bytes,
             sum(pg_total_relation_size(relid))::text AS total_bytes
        FROM pg_partition_tree('outbox_delivery_receipts'::regclass)
       WHERE isleaf
    `);
    assert.equal(partitioned?.tableBytes, BigInt(expected.rows[0]!.table_bytes));
    assert.equal(partitioned?.indexBytes, BigInt(expected.rows[0]!.index_bytes));
    assert.equal(partitioned?.totalBytes, BigInt(expected.rows[0]!.total_bytes));
  });

  test('migrated catalog comments match the registry and reject synthetic append-heavy tables', async () => {
    assert.deepEqual(await inspectAppendHeavyCompleteness(isolated.runtime.pool), []);

    await isolated.runtime.pool.query(`
      CREATE TABLE synthetic_append_heavy (id integer PRIMARY KEY);
      COMMENT ON TABLE synthetic_append_heavy IS 'known.append_heavy=true; completeness probe';
    `);
    const issues = await inspectAppendHeavyCompleteness(isolated.runtime.pool);
    assert.ok(issues.some((issue) => issue.code === 'unregistered_append_heavy_table'
      && issue.tableName === 'synthetic_append_heavy'));
    await isolated.runtime.pool.query('DROP TABLE synthetic_append_heavy');
  });

  test('reports dead tuples on a regular table without scanning ledger rows', async () => {
    await fixture.runtime.pool.query(`
      UPDATE resource_id_ledger SET created_at = created_at;
      SELECT pg_stat_force_next_flush();
    `);
    const rows = await inspectLedgerCapacity(fixture.runtime.pool, {
      warnRows: 2n ** 62n,
      warnBytes: 2n ** 62n,
    });
    const regular = rows.find((row) => row.tableName === 'resource_id_ledger');
    assert.equal(regular?.present, true);
    assert.ok((regular?.deadRows ?? 0n) >= 2n);
    assert.equal(regular?.warning, true);
    assert.ok((regular?.deadTupleRatio ?? 0) >= 0.2);
  });
});
