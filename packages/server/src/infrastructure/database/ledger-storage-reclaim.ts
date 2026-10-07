import type { Pool, PoolClient } from 'pg';

export const LEDGER_RECLAIM_RELATIONS = Object.freeze([
  'operation_payloads',
  'audit_event_payloads',
  'outbox_events',
] as const);

export type LedgerReclaimRelation = (typeof LEDGER_RECLAIM_RELATIONS)[number];

export interface LedgerStorageMeasurement {
  readonly totalBytes: bigint;
  readonly liveTuples: bigint;
  readonly deadTuples: bigint;
}

export interface LedgerStorageReclaimEvidence {
  readonly evidence: 'known.ledger_storage_reclaim.v1';
  readonly relation: LedgerReclaimRelation;
  readonly mode: 'vacuum_analyze' | 'vacuum_full_analyze';
  readonly lockImpact: 'routine_vacuum' | 'access_exclusive_file_rewrite';
  readonly before: LedgerStorageMeasurement;
  readonly after: LedgerStorageMeasurement;
}

interface MeasurementRow {
  total_bytes: string | bigint;
  live_tuples: string | bigint;
  dead_tuples: string | bigint;
}

const VACUUM_SQL: Readonly<Record<LedgerReclaimRelation, Readonly<{
  normal: string;
  full: string;
}>>> = Object.freeze({
  operation_payloads: Object.freeze({
    normal: 'VACUUM (ANALYZE) operation_payloads',
    full: 'VACUUM (FULL, ANALYZE) operation_payloads',
  }),
  audit_event_payloads: Object.freeze({
    normal: 'VACUUM (ANALYZE) audit_event_payloads',
    full: 'VACUUM (FULL, ANALYZE) audit_event_payloads',
  }),
  outbox_events: Object.freeze({
    normal: 'VACUUM (ANALYZE) outbox_events',
    full: 'VACUUM (FULL, ANALYZE) outbox_events',
  }),
});

/** Runs directly on a checked-out maintenance connection, never inside a transaction. */
export async function reclaimLedgerStorage(
  pool: Pool,
  relation: LedgerReclaimRelation,
  full = false,
): Promise<LedgerStorageReclaimEvidence> {
  const commands = VACUUM_SQL[relation];
  if (!commands) throw new TypeError('ledger_reclaim_relation_not_allowed');
  const client = await pool.connect();
  try {
    const before = await measure(client, relation);
    await client.query(full ? commands.full : commands.normal);
    const after = await measure(client, relation);
    return Object.freeze({
      evidence: 'known.ledger_storage_reclaim.v1', relation,
      mode: full ? 'vacuum_full_analyze' : 'vacuum_analyze',
      lockImpact: full ? 'access_exclusive_file_rewrite' : 'routine_vacuum',
      before, after,
    });
  } finally {
    client.release();
  }
}

function asyncMeasureRow(client: PoolClient, relation: LedgerReclaimRelation) {
  return client.query<MeasurementRow>(`
    SELECT pg_total_relation_size(class.oid)::text AS total_bytes,
           coalesce(stat.n_live_tup, 0)::bigint::text AS live_tuples,
           coalesce(stat.n_dead_tup, 0)::bigint::text AS dead_tuples
      FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      LEFT JOIN pg_stat_all_tables stat ON stat.relid=class.oid
     WHERE namespace.nspname=current_schema() AND class.relname=$1
  `, [relation]);
}

async function measure(
  client: PoolClient,
  relation: LedgerReclaimRelation,
): Promise<LedgerStorageMeasurement> {
  const result = await asyncMeasureRow(client, relation);
  const row = result.rows[0];
  if (!row) throw new Error('ledger_reclaim_relation_missing');
  return Object.freeze({
    totalBytes: BigInt(row.total_bytes), liveTuples: BigInt(row.live_tuples),
    deadTuples: BigInt(row.dead_tuples),
  });
}
