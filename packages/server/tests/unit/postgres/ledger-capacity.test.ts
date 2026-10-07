import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { test } from 'vitest';
import {
  LEDGER_CAPACITY_TARGETS,
  inspectLedgerCapacity,
  ledgerCapacityDaysToLimit,
  ledgerCapacityRatio,
  parseLedgerCapacityThreshold,
} from '../../../src/infrastructure/database/ledger-capacity.js';

test('ledger capacity inventory assigns an explicit non-destructive retention contract', () => {
  assert.deepEqual(LEDGER_CAPACITY_TARGETS.map((target) => target.tableName), [
    'operations',
    'operation_payloads',
    'operation_lookup_facts',
    'audit_events',
    'digest_audit_events',
    'audit_event_payloads',
    'outbox_events',
    'sync_node_revision_history',
    'sync_sequence_receipts',
    'resource_id_ledger',
    'sync_sequence_operation_claims',
    'sync_operation_effects',
    'sync_operation_effect_pages',
    'sync_purged_node_id_watermarks',
    'sync_replica_retirement_receipts',
    'sync_recovery_ack_receipts',
    'sync_bootstrap_snapshot_pages',
    'outbox_delivery_receipts',
    'product_command_receipts',
    'sync_pull_cursor_evidence',
    'sync_pull_cursor_recovery_proofs',
    'sync_pull_cursor_lineage',
    'sync_pull_page_evidence',
    'sync_node_tombstones',
  ]);
  assert.ok(LEDGER_CAPACITY_TARGETS.every((target) => target.archiveBlocker.length > 20));
  assert.ok(LEDGER_CAPACITY_TARGETS.every((target) => target.owner.length > 0));
  assert.ok(LEDGER_CAPACITY_TARGETS.every((target) => target.requiredIndex.length > 0));
  assert.equal(
    LEDGER_CAPACITY_TARGETS.find((target) => target.tableName === 'sync_pull_page_evidence')
      ?.replacesTableName,
    'sync_pull_cursor_evidence',
  );
  assert.deepEqual(new Set(LEDGER_CAPACITY_TARGETS.map((target) => target.family)), new Set([
    'operation', 'audit', 'audit_payload', 'outbox', 'sync', 'identity', 'idempotency',
  ]));
});

test('ledger capacity thresholds reject ambiguous or negative values', () => {
  assert.equal(parseLedgerCapacityThreshold(undefined, 10n, 'ROWS'), 10n);
  assert.equal(parseLedgerCapacityThreshold(' 42 ', 10n, 'ROWS'), 42n);
  assert.throws(() => parseLedgerCapacityThreshold('-1', 10n, 'ROWS'), /non-negative integer/iu);
  assert.throws(() => parseLedgerCapacityThreshold('1.5', 10n, 'ROWS'), /non-negative integer/iu);
});

test('ledger capacity maps additive partition metadata and zero-fills missing targets', async () => {
  let statement = '';
  let parameters: readonly unknown[] = [];
  const pool = {
    async query(sql: string, values: readonly unknown[]) {
      statement = sql;
      parameters = values;
      return { rows: [{
        table_name: 'operations', present: true, partition_count: 2,
        estimated_rows: '12', dead_rows: '3', table_bytes: '100', index_bytes: '40',
        total_bytes: '160', sequential_scans: '5', index_scans: '8',
        tuples_inserted: '24', stats_reset: new Date('2026-07-01T00:00:00.000Z'),
        last_autovacuum: new Date('2026-08-01T00:00:00.000Z'), last_autoanalyze: null,
      }] };
    },
  } as unknown as Pool;

  const now = new Date('2026-08-02T00:00:00.000Z');
  const rows = await inspectLedgerCapacity(pool, { warnRows: 10n, warnBytes: 1_000n }, now);
  assert.match(statement, /pg_partition_tree\(root\.root_oid::regclass\)/u);
  assert.match(statement, /WHERE root\.relkind = 'p' AND tree\.isleaf/u);
  assert.match(statement, /sum\(stats\.n_live_tup\)/u);
  assert.match(statement, /leaf_class\.reltuples/u);
  assert.match(statement, /coalesce\(sum\(stats\.seq_scan\), 0\)/u);
  assert.match(statement, /sum\(pg_total_relation_size\(leaf\.relid\)\)/u);
  assert.match(statement, /max\(stats\.last_autovacuum\)/u);
  assert.match(statement, /coalesce\(sum\(stats\.n_tup_ins\), 0\)/u);
  assert.match(statement, /pg_stat_database/u);
  assert.deepEqual(parameters, [LEDGER_CAPACITY_TARGETS.map((target) => target.tableName)]);
  assert.equal(rows[0]?.present, true);
  assert.equal(rows[0]?.partitionCount, 2);
  assert.equal(rows[0]?.estimatedRows, 12n);
  assert.equal(rows[0]?.deadRows, 3n);
  assert.equal(rows[0]?.warning, true);
  assert.equal(rows[0]?.appliedWarnRows, 10n);
  assert.equal(rows[0]?.tuplesInserted, 24n);
  assert.equal(rows[0]?.deadTupleRatio, 3 / 15);
  assert.equal(rows[0]?.indexByteRatio, 40 / 160);
  assert.equal(rows[0]?.autovacuumAgeSeconds, 86_400);
  assert.deepEqual({ present: rows[1]?.present, partitionCount: rows[1]?.partitionCount,
    estimatedRows: rows[1]?.estimatedRows, totalBytes: rows[1]?.totalBytes },
  { present: false, partitionCount: 0, estimatedRows: 0n, totalBytes: 0n });
});

test('ledger capacity ratios and days-to-limit stay defined for overflow bigint', () => {
  const overflow = 9_007_199_254_740_992n;
  assert.equal(ledgerCapacityRatio(1n, overflow), null);
  assert.equal(ledgerCapacityRatio(3n, 15n), 0.2);
  assert.equal(ledgerCapacityDaysToLimit(0n, overflow, 10n,
    new Date('2026-01-01T00:00:00.000Z'), new Date('2026-02-01T00:00:00.000Z')), null);
  assert.equal(ledgerCapacityDaysToLimit(100n, 100n, 10n, new Date(), new Date()), 0);
});

test('ledger capacity warns on dead-tuple ratio using the per-table contract', async () => {
  const pool = {
    async query() {
      return { rows: [{
        table_name: 'operations', present: true, partition_count: 0,
        estimated_rows: '8', dead_rows: '8', table_bytes: '10', index_bytes: '10',
        total_bytes: '20', sequential_scans: '0', index_scans: '0',
        tuples_inserted: '0', stats_reset: null, last_autovacuum: null, last_autoanalyze: null,
      }] };
    },
  } as unknown as Pool;
  const rows = await inspectLedgerCapacity(pool, { warnRows: 1_000n, warnBytes: 1_000n });
  assert.equal(rows[0]?.warning, true);
  assert.equal(rows[0]?.deadTupleRatio, 0.5);
});
