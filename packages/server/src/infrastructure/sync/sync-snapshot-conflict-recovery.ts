import { createHash } from 'node:crypto';
import { CompiledQuery, sql, type Transaction } from 'kysely';
import type { PoolClient } from 'pg';
import { SYNC_PULL_STREAM_KIND_ORDER, SyncAckError, SyncBootstrapSnapshotError,
  type SyncPullTuple } from '../../modules/sync/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/**
 * The same three Pull branches, in Pull's tuple order. A dismiss is the
 * resolution ordinal, not the conflict row's own ordinal, and a conflicted
 * operation is not an operation tuple.
 */
export const VISIBLE_PULL_UPPER_SQL = `select commit_ordinal::text as commit_ordinal, stream_kind, stable_id from (
  select operation.commit_ordinal, operation.sync_stream_kind as stream_kind,
      operation.operation_id as stable_id
    from operations operation
    where operation.collection_id = $1 and operation.sync_wire_present
      and operation.operation_type <> 'sync.conflict.dismissed'
      and not exists (
        select 1 from sync_conflicts operation_conflict
        where operation_conflict.collection_id = operation.collection_id
          and operation_conflict.operation_id = operation.operation_id)
  union all
  select conflict.commit_ordinal, conflict.sync_stream_kind, conflict.conflict_id
    from sync_conflicts conflict
    where conflict.collection_id = $1
  union all
  select resolution.commit_ordinal, conflict.sync_stream_kind, conflict.conflict_id
    from operations resolution
    join sync_conflicts conflict on conflict.collection_id = resolution.collection_id
      and conflict.resolved_by_operation_id = resolution.operation_id
    where resolution.collection_id = $1
      and resolution.operation_type = 'sync.conflict.dismissed'
      and conflict.status = 'resolved'
) stream
order by stream.commit_ordinal desc, stream.stream_kind desc, stream.stable_id collate "C" desc
limit 1`;

const CONFLICT_ANCHOR_SQL = `select conflict_id as stable_id from sync_conflicts
  where collection_id = $1 and commit_ordinal = $2::bigint and sync_stream_kind = $3::smallint
  union all
  select conflict.conflict_id as stable_id from operations resolution
  join sync_conflicts conflict on conflict.collection_id = resolution.collection_id
    and conflict.resolved_by_operation_id = resolution.operation_id
  where resolution.collection_id = $1 and resolution.commit_ordinal = $2::bigint
    and resolution.operation_type = 'sync.conflict.dismissed' and conflict.status = 'resolved'
    and conflict.sync_stream_kind = $3::smallint`;

export interface SnapshotOpenConflictWire {
  readonly id: string;
  readonly collectionId: string;
  readonly targetId: string;
  readonly type: string;
  readonly field?: string;
  readonly incomingOpId?: string;
  readonly createdAt: string;
  readonly status: 'open';
  readonly allowedResolutions: readonly string[];
  readonly revision: string;
}

export interface SnapshotOpenConflictPage {
  readonly snapshotId: string;
  readonly offset: number;
  readonly limit: number;
  readonly conflictCount: number;
  readonly conflictDigest: string;
  readonly conflicts: readonly SnapshotOpenConflictWire[];
  readonly nextOffset: number | null;
}

interface UpperRow {
  readonly commit_ordinal: string;
  readonly stream_kind: number | string;
  readonly stable_id: string;
}

interface CutRow {
  readonly conflict_count: number;
  readonly conflict_digest: string;
}

export function snapshotOpenConflictDigest(
  rows: readonly { readonly id: string; readonly revision: string }[],
): string {
  return createHash('sha256').update(rows.map((row) => `${row.id}\t${row.revision}`).join('\n'), 'utf8').digest('hex');
}

export async function readVisiblePullUpper(
  query: (text: string, params: readonly unknown[]) => Promise<{ rows: readonly UpperRow[] }>,
  collectionId: string,
): Promise<SyncPullTuple | undefined> {
  const result = await query(VISIBLE_PULL_UPPER_SQL, [collectionId]);
  return tupleFrom(result.rows[0]);
}

export async function readVisiblePullUpperKysely(
  transaction: Transaction<DatabaseSchema>,
  collectionId: string,
): Promise<SyncPullTuple | undefined> {
  const result = await transaction.executeQuery<UpperRow>(CompiledQuery.raw(VISIBLE_PULL_UPPER_SQL, [collectionId]));
  return tupleFrom(result.rows[0]);
}

/** Conflict-stream anchors Pull can resume: the conflict row or its later dismiss. */
export async function selectConflictStreamAnchorIds(
  transaction: DatabaseTransaction,
  collectionId: string,
  commitOrdinal: bigint,
): Promise<readonly { readonly stable_id: string }[]> {
  const result = await transaction.executeQuery<{ stable_id: string }>(CompiledQuery.raw(CONFLICT_ANCHOR_SQL, [
    collectionId, commitOrdinal.toString(), SYNC_PULL_STREAM_KIND_ORDER.conflict,
  ]));
  return result.rows;
}

export async function freezeSnapshotOpenConflicts(
  client: PoolClient,
  snapshotId: string,
  collectionId: string,
  tuple: SyncPullTuple,
): Promise<void> {
  const streamKind = tuple.streamKind === 'operation' ? 0 : 1;
  await client.query(
    `insert into sync_bootstrap_snapshot_conflicts
      (snapshot_id, conflict_index, conflict_id, revision, wire_json)
    select $1,
      (row_number() over (order by conflict.commit_ordinal, conflict.sync_stream_kind,
        conflict.conflict_id collate "C")) - 1,
      conflict.conflict_id,
      conflict.pull_wire_json->>'revision',
      jsonb_strip_nulls(jsonb_build_object(
        'id', conflict.pull_wire_json->'id',
        'collectionId', conflict.pull_wire_json->'collectionId',
        'targetId', conflict.pull_wire_json->'targetId',
        'type', conflict.pull_wire_json->'type',
        'field', conflict.pull_wire_json->'field',
        'incomingOpId', conflict.pull_wire_json->'incomingOpId',
        'createdAt', conflict.pull_wire_json->'createdAt',
        'status', '"open"'::jsonb,
        'allowedResolutions', conflict.pull_wire_json->'allowedResolutions',
        'revision', conflict.pull_wire_json->'revision'))
    from sync_conflicts conflict
    where conflict.collection_id = $2 and conflict.status = 'open'
      and (conflict.commit_ordinal, conflict.sync_stream_kind, conflict.conflict_id collate "C")
        <= ($3::bigint, $4::smallint, $5::text collate "C")`,
    [snapshotId, collectionId, tuple.commitOrdinal, streamKind, tuple.stableId]);
  const inserted = await client.query<{ conflict_id: string; revision: string; wire_json: unknown }>(
    `select conflict_id, revision, wire_json from sync_bootstrap_snapshot_conflicts
      where snapshot_id = $1 order by conflict_index asc`, [snapshotId]);
  const wires = inserted.rows.map((row) => readWire(row.wire_json, row.conflict_id, row.revision));
  const digest = snapshotOpenConflictDigest(wires);
  await client.query(`insert into sync_bootstrap_snapshot_conflict_cuts
    (snapshot_id, conflict_count, conflict_digest) values ($1,$2,$3)`,
  [snapshotId, wires.length, digest]);
}

export async function readSnapshotOpenConflictPage(
  client: PoolClient,
  authority: { readonly session_id: string; readonly replica_id: string; readonly replica_generation: string },
  input: { readonly snapshotId: string; readonly offset: number; readonly limit: number },
): Promise<SnapshotOpenConflictPage> {
  const snapshot = await client.query<{ session_id: string; replica_id: string; lease_generation: string }>(
    `select session_id, replica_id, lease_generation::text from sync_bootstrap_snapshots
      where snapshot_id = $1 and expires_at > current_timestamp`, [input.snapshotId]);
  const row = snapshot.rows[0];
  if (!row || row.session_id !== authority.session_id || row.replica_id !== authority.replica_id
      || row.lease_generation !== authority.replica_generation) {
    throw new SyncBootstrapSnapshotError('snapshot_expired');
  }
  const cut = await client.query<CutRow>(
    `select conflict_count, conflict_digest from sync_bootstrap_snapshot_conflict_cuts where snapshot_id = $1`,
    [input.snapshotId]);
  const frozen = cut.rows[0];
  if (!frozen) throw new SyncBootstrapSnapshotError('unsupported_version', 'snapshot_conflict_cut_missing');
  if (input.offset > frozen.conflict_count) throw new SyncBootstrapSnapshotError('invalid_query');
  const page = await client.query<{ conflict_id: string; revision: string; wire_json: unknown }>(
    `select conflict_id, revision, wire_json from sync_bootstrap_snapshot_conflicts
      where snapshot_id = $1 and conflict_index >= $2
      order by conflict_index asc limit $3`,
    [input.snapshotId, input.offset, input.limit]);
  const conflicts = page.rows.map((item) => readWire(item.wire_json, item.conflict_id, item.revision));
  const next = input.offset + conflicts.length;
  return Object.freeze({
    snapshotId: input.snapshotId, offset: input.offset, limit: input.limit,
    conflictCount: frozen.conflict_count, conflictDigest: frozen.conflict_digest, conflicts,
    nextOffset: next < frozen.conflict_count ? next : null,
  });
}

export async function confirmSnapshotOpenConflicts(
  client: PoolClient,
  authority: { readonly session_id: string; readonly replica_id: string; readonly replica_generation: string },
  input: { readonly snapshotId: string; readonly conflictDigest: string },
): Promise<{ readonly confirmed: true }> {
  const page = await readSnapshotOpenConflictPage(client, authority, {
    snapshotId: input.snapshotId, offset: 0, limit: 1,
  });
  if (page.conflictCount === 0 || page.conflictDigest !== input.conflictDigest) {
    throw new SyncBootstrapSnapshotError('invalid_cursor_scope', 'snapshot_conflict_digest');
  }
  await client.query(`insert into sync_bootstrap_snapshot_conflict_receipts
    (snapshot_id, session_id, replica_id, conflict_count, conflict_digest)
    values ($1,$2,$3,$4,$5) on conflict (snapshot_id, session_id) do nothing`,
  [input.snapshotId, authority.session_id, authority.replica_id, page.conflictCount, page.conflictDigest]);
  const stored = await client.query<{ conflict_count: number; conflict_digest: string; replica_id: string }>(
    `select conflict_count, conflict_digest, replica_id from sync_bootstrap_snapshot_conflict_receipts
      where snapshot_id = $1 and session_id = $2`,
    [input.snapshotId, authority.session_id]);
  const receipt = stored.rows[0];
  if (!receipt || receipt.replica_id !== authority.replica_id || receipt.conflict_count !== page.conflictCount
      || receipt.conflict_digest !== page.conflictDigest) {
    throw new SyncBootstrapSnapshotError('invalid_cursor_scope', 'snapshot_conflict_receipt');
  }
  return Object.freeze({ confirmed: true as const });
}

/** Legacy snapshots have no cut row and keep the previous Ack path. */
export async function assertSnapshotOpenConflictsDelivered(
  transaction: DatabaseTransaction,
  snapshotId: string,
  sessionId: string,
): Promise<void> {
  const cut = await sql<CutRow>`select conflict_count, conflict_digest
    from sync_bootstrap_snapshot_conflict_cuts where snapshot_id = ${snapshotId}`.execute(transaction);
  const frozen = cut.rows[0];
  if (!frozen || frozen.conflict_count === 0) return;
  const receipt = await sql<{ conflict_count: number; conflict_digest: string }>`select conflict_count, conflict_digest
    from sync_bootstrap_snapshot_conflict_receipts
    where snapshot_id = ${snapshotId} and session_id = ${sessionId}`.execute(transaction);
  const confirmed = receipt.rows[0];
  if (!confirmed || confirmed.conflict_count !== frozen.conflict_count
      || confirmed.conflict_digest !== frozen.conflict_digest) {
    throw Object.assign(new SyncAckError('unsupported_version'), { authorityGuard: 'snapshot_conflict_recovery' });
  }
}

function tupleFrom(row: UpperRow | undefined): SyncPullTuple | undefined {
  if (!row) return undefined;
  const streamKind = Number(row.stream_kind);
  if (streamKind !== 0 && streamKind !== 1) throw new SyncBootstrapSnapshotError('internal_error');
  return Object.freeze({
    commitOrdinal: row.commit_ordinal,
    streamKind: streamKind === 0 ? 'operation' as const : 'conflict' as const,
    stableId: row.stable_id,
  });
}

function readWire(value: unknown, conflictId: string, revision: string): SnapshotOpenConflictWire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncBootstrapSnapshotError('internal_error');
  const wire = value as Record<string, unknown>;
  if (wire.id !== conflictId || wire.revision !== revision || wire.status !== 'open'
      || typeof wire.collectionId !== 'string' || typeof wire.targetId !== 'string'
      || typeof wire.type !== 'string' || typeof wire.createdAt !== 'string'
      || !Array.isArray(wire.allowedResolutions) || wire.allowedResolutions.length < 1
      || 'base' in wire || 'server' in wire || 'incoming' in wire) {
    throw new SyncBootstrapSnapshotError('internal_error');
  }
  return Object.freeze({
    id: conflictId, collectionId: wire.collectionId, targetId: wire.targetId, type: wire.type,
    ...(typeof wire.field === 'string' ? { field: wire.field } : {}),
    ...(typeof wire.incomingOpId === 'string' ? { incomingOpId: wire.incomingOpId } : {}),
    createdAt: wire.createdAt, status: 'open' as const,
    allowedResolutions: Object.freeze([...wire.allowedResolutions].map(String)),
    revision,
  });
}
