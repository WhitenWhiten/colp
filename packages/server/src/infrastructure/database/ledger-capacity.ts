import type { Pool } from 'pg';
import { LEDGER_CAPACITY_TARGETS } from './ledger-append-authority.js';

/**
 * Append-heavy relations whose retention cannot be inferred from row age.
 * Keep this explicit: adding a ledger requires an operator-visible contract,
 * not an automatic wildcard that might authorize unsafe deletion.
 * Table set is generated with the retention matrix from `ledger-append-authority.ts`.
 */
export { LEDGER_CAPACITY_TARGETS };

export type LedgerRetentionClass =
  | 'authoritative_permanent'
  | 'identity_lifetime'
  | 'protocol_retained_source';

export type LedgerFamily =
  | 'operation'
  | 'audit'
  | 'audit_payload'
  | 'outbox'
  | 'sync'
  | 'identity'
  | 'idempotency';

export interface LedgerCapacityTarget {
  readonly tableName: string;
  readonly family: LedgerFamily;
  readonly retentionClass: LedgerRetentionClass;
  readonly archiveBlocker: string;
  readonly owner: string;
  readonly growthDriver: string;
  readonly cleanupMechanism: string;
  readonly requiredIndex: string;
  readonly warnRows: bigint;
  readonly warnBytes: bigint;
  readonly warnDeadRatio: number;
  readonly recoveryDependency: string;
  readonly replacesTableName: string | null;
}

export interface LedgerCapacityThresholds {
  readonly warnRows: bigint;
  readonly warnBytes: bigint;
}

export interface LedgerCapacityRow extends LedgerCapacityTarget {
  readonly present: boolean;
  readonly partitionCount: number;
  readonly estimatedRows: bigint;
  readonly deadRows: bigint;
  readonly tableBytes: bigint;
  readonly indexBytes: bigint;
  readonly totalBytes: bigint;
  readonly sequentialScans: bigint;
  readonly indexScans: bigint;
  readonly tuplesInserted: bigint;
  readonly statsReset: string | null;
  readonly lastAutovacuum: string | null;
  readonly lastAutoanalyze: string | null;
  readonly deadTupleRatio: number | null;
  readonly indexByteRatio: number | null;
  readonly autovacuumAgeSeconds: number | null;
  readonly growthRowsPerDay: number | null;
  readonly estimatedDaysToRowLimit: number | null;
  readonly appliedWarnRows: bigint;
  readonly appliedWarnBytes: bigint;
  readonly warning: boolean;
}

interface CapacityDatabaseRow {
  table_name: string;
  present: boolean;
  partition_count: number;
  estimated_rows: string | number | bigint | null;
  dead_rows: string | number | bigint | null;
  table_bytes: string | number | bigint | null;
  index_bytes: string | number | bigint | null;
  total_bytes: string | number | bigint | null;
  sequential_scans: string | number | bigint | null;
  index_scans: string | number | bigint | null;
  tuples_inserted: string | number | bigint | null;
  stats_reset: Date | null;
  last_autovacuum: Date | null;
  last_autoanalyze: Date | null;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MS_PER_DAY = 86_400_000;

export function parseLedgerCapacityThreshold(
  value: string | undefined,
  fallback: bigint,
  name: string,
): bigint {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/u.test(value.trim())) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(value.trim());
}

export function ledgerCapacityRatio(part: bigint, whole: bigint): number | null {
  if (whole === 0n) return 0;
  if (part < 0n || whole < 0n || part > MAX_SAFE || whole > MAX_SAFE) return null;
  return Number(part) / Number(whole);
}

export function ledgerCapacityDaysToLimit(
  estimatedRows: bigint,
  warnRows: bigint,
  tuplesInserted: bigint,
  statsReset: Date | null,
  now: Date,
): number | null {
  if (estimatedRows >= warnRows) return 0;
  if (statsReset === null || tuplesInserted <= 0n) return null;
  const elapsedMs = now.getTime() - statsReset.getTime();
  if (elapsedMs < 60_000) return null;
  const remaining = warnRows - estimatedRows;
  if (remaining > MAX_SAFE || tuplesInserted > MAX_SAFE) return null;
  const rowsPerDay = Number(tuplesInserted) / (elapsedMs / MS_PER_DAY);
  if (!Number.isFinite(rowsPerDay) || rowsPerDay <= 0) return null;
  const days = Number(remaining) / rowsPerDay;
  return Number.isFinite(days) ? days : null;
}

export async function inspectLedgerCapacity(
  pool: Pool,
  thresholds?: LedgerCapacityThresholds,
  now: Date = new Date(),
): Promise<readonly LedgerCapacityRow[]> {
  const names = LEDGER_CAPACITY_TARGETS.map((target) => target.tableName);
  const result = await pool.query<CapacityDatabaseRow>(`
    WITH targets(table_name) AS (
      SELECT unnest($1::text[])
    ), roots AS (
      SELECT target.table_name, relation.oid AS root_oid, relation.relkind
        FROM targets target
        LEFT JOIN pg_namespace namespace ON namespace.nspname = current_schema()
        LEFT JOIN pg_class relation
          ON relation.relnamespace = namespace.oid
         AND relation.relname = target.table_name
         AND relation.relkind IN ('r', 'p')
    ), leaves AS (
      SELECT root.table_name, root.root_oid, root.relkind, leaf.relid
        FROM roots root
        LEFT JOIN LATERAL (
          SELECT root.root_oid AS relid WHERE root.relkind = 'r'
          UNION ALL
          SELECT tree.relid
            FROM pg_partition_tree(root.root_oid::regclass) tree
           WHERE root.relkind = 'p' AND tree.isleaf
        ) leaf ON true
    )
    SELECT leaf.table_name,
           leaf.root_oid IS NOT NULL AS present,
           CASE WHEN leaf.relkind = 'p' THEN count(leaf.relid) ELSE 0 END::integer AS partition_count,
           coalesce(
             nullif(sum(stats.n_live_tup), 0),
             nullif(sum(GREATEST(leaf_class.reltuples, 0::real))::bigint, 0),
             0
           )::text AS estimated_rows,
           coalesce(sum(stats.n_dead_tup), 0)::text AS dead_rows,
           coalesce(sum(pg_relation_size(leaf.relid)), 0)::text AS table_bytes,
           coalesce(sum(pg_indexes_size(leaf.relid)), 0)::text AS index_bytes,
           coalesce(sum(pg_total_relation_size(leaf.relid)), 0)::text AS total_bytes,
           coalesce(sum(stats.seq_scan), 0)::text AS sequential_scans,
           coalesce(sum(stats.idx_scan), 0)::text AS index_scans,
           coalesce(sum(stats.n_tup_ins), 0)::text AS tuples_inserted,
           (SELECT database_stats.stats_reset
              FROM pg_stat_database database_stats
             WHERE database_stats.datname = current_database()) AS stats_reset,
           max(stats.last_autovacuum) AS last_autovacuum,
           max(stats.last_autoanalyze) AS last_autoanalyze
      FROM leaves leaf
      LEFT JOIN pg_stat_user_tables stats ON stats.relid = leaf.relid
      LEFT JOIN pg_class leaf_class ON leaf_class.oid = leaf.relid
     GROUP BY leaf.table_name, leaf.root_oid, leaf.relkind
     ORDER BY leaf.table_name COLLATE "C"
  `, [names]);
  const facts = new Map(result.rows.map((row) => [row.table_name, row]));
  return Object.freeze(LEDGER_CAPACITY_TARGETS.map((target) => {
    const row = facts.get(target.tableName);
    const estimatedRows = toBigInt(row?.estimated_rows);
    const deadRows = toBigInt(row?.dead_rows);
    const totalBytes = toBigInt(row?.total_bytes);
    const indexBytes = toBigInt(row?.index_bytes);
    const tuplesInserted = toBigInt(row?.tuples_inserted);
    const warnRows = thresholds?.warnRows ?? target.warnRows;
    const warnBytes = thresholds?.warnBytes ?? target.warnBytes;
    const lastAutovacuum = row?.last_autovacuum?.toISOString() ?? null;
    const statsReset = row?.stats_reset ?? null;
    const deadTupleRatio = ledgerCapacityRatio(deadRows, estimatedRows + deadRows);
    const indexByteRatio = ledgerCapacityRatio(indexBytes, totalBytes);
    const autovacuumAgeSeconds = lastAutovacuum === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - Date.parse(lastAutovacuum)) / 1000));
    const elapsedMs = statsReset === null ? null : now.getTime() - statsReset.getTime();
    const growthRowsPerDay = elapsedMs === null || elapsedMs < 60_000 || tuplesInserted > MAX_SAFE
      ? null
      : Number(tuplesInserted) / (elapsedMs / MS_PER_DAY);
    const estimatedDaysToRowLimit = ledgerCapacityDaysToLimit(
      estimatedRows, warnRows, tuplesInserted, statsReset, now,
    );
    const warning = estimatedRows >= warnRows
      || totalBytes >= warnBytes
      || (deadTupleRatio !== null && deadTupleRatio >= target.warnDeadRatio);
    return Object.freeze({
      ...target,
      present: row?.present === true,
      partitionCount: row?.partition_count ?? 0,
      estimatedRows,
      deadRows,
      tableBytes: toBigInt(row?.table_bytes),
      indexBytes,
      totalBytes,
      sequentialScans: toBigInt(row?.sequential_scans),
      indexScans: toBigInt(row?.index_scans),
      tuplesInserted,
      statsReset: statsReset?.toISOString() ?? null,
      lastAutovacuum,
      lastAutoanalyze: row?.last_autoanalyze?.toISOString() ?? null,
      deadTupleRatio,
      indexByteRatio,
      autovacuumAgeSeconds,
      growthRowsPerDay: growthRowsPerDay !== null && Number.isFinite(growthRowsPerDay)
        ? growthRowsPerDay : null,
      estimatedDaysToRowLimit,
      appliedWarnRows: warnRows,
      appliedWarnBytes: warnBytes,
      warning,
    });
  }));
}

function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return BigInt(value);
}
