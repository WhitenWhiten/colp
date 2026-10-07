import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import { hasCompleteDeleteGroup } from './sync-delete-group-integrity.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  encodeTrashDeletionId,
  SYNC_PULL_STREAM_KIND_ORDER,
  type ProductSyncTrashEmptyItemResult,
  type ProductSyncTrashEmptySkipReason,
} from '../../modules/sync/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { SyncTombstonePurgeFenceLostError } from './sync-tombstone-purge-postgres.js';

interface PurgeStateRow {
  collection_id: string;
  purged_through_commit_ordinal: bigint | string;
  purged_through_stream_kind: number;
  purged_through_stable_id: string;
  state_revision: bigint | string;
  lease_token: string | null;
  lease_generation: bigint | string;
  lease_expires_at: Date | null;
}

interface TombstoneCandidate {
  collection_id: string;
  target_id: string;
  operation_id: string;
  delete_revision: string;
  delete_commit_ordinal: bigint | string;
  purge_after: Date;
  affected_count: number;
}

interface ActiveReplicaCheckpoint {
  checkpoint_commit_ordinal: bigint | string | null;
  checkpoint_stream_kind: number | null;
  checkpoint_stable_id: string | null;
}

export async function purgeOwnedTrashInTransaction(
  transaction: DatabaseTransaction,
  input: {
    readonly collectionId: string;
    readonly workerId: string;
    readonly leaseDurationMs: number;
    readonly now?: Date;
    readonly faultAfterGroup?: (groupIndex: number) => Promise<void>;
  },
): Promise<{
  readonly results: readonly ProductSyncTrashEmptyItemResult[];
  readonly remaining: number;
}> {
  const now = await databaseNow(transaction, input.now);
  await lockActiveSyncReplicasForCollection(transaction, input.collectionId);
      await transaction.selectFrom('collections').select('id').where('id', '=', input.collectionId)
    .forUpdate().executeTakeFirstOrThrow();
  await transaction.insertInto('sync_collection_purge_state').values({ collection_id: input.collectionId })
    .onConflict((conflict) => conflict.column('collection_id').doNothing()).execute();
  const leaseToken = randomUUID();
  const claimed = await sql<PurgeStateRow>`
    UPDATE sync_collection_purge_state SET
      lease_owner=${input.workerId}, lease_token=${leaseToken},
      lease_generation=lease_generation+1,
      lease_expires_at=${now}::timestamptz
        + (${input.leaseDurationMs} * interval '1 millisecond'),
      attempt_count=attempt_count+1, last_attempt_at=${now}, updated_at=${now}
    WHERE collection_id=${input.collectionId}
      AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
    RETURNING *
  `.execute(transaction);
  const claim = claimed.rows[0];
  if (!claim) {
    throw Object.assign(new Error('Trash empty is already in progress.'), { code: 'command_in_progress' });
  }
  const leaseGeneration = BigInt(claim.lease_generation).toString();
  const live = await loadLiveTombstones(transaction, input.collectionId);
  const groups = groupByOperation(live);
  const results: ProductSyncTrashEmptyItemResult[] = [];
  let blocked: ProductSyncTrashEmptySkipReason | null = null;
  let stateRevision = BigInt(claim.state_revision);
  let purgedThroughOrdinal = BigInt(claim.purged_through_commit_ordinal);
  let purgedThroughStableId = claim.purged_through_stable_id;
  for (const group of groups) {
    await assertFence(transaction, input.collectionId, leaseToken, leaseGeneration, now);
    const independent = await skipReason(transaction, input.collectionId, group, now,
      purgedThroughOrdinal, purgedThroughStableId);
    if (independent || blocked) {
      const reason = independent ?? 'watermark';
      blocked = blocked ?? reason;
      results.push(...group.map((row) => skipped(row, evaluateMemberReason(row, now, reason))));
      continue;
    }
    stateRevision += 1n;
    await applyGroup(transaction, input.collectionId, group, now, stateRevision, leaseToken, leaseGeneration);
    purgedThroughOrdinal = BigInt(group[0]!.delete_commit_ordinal);
    purgedThroughStableId = group[0]!.operation_id;
    results.push(...group.map((row) => Object.freeze({
      deletionId: encodeTrashDeletionId(row.operation_id, row.target_id),
      outcome: 'purged' as const,
    })));
    await input.faultAfterGroup?.(results.filter((item) => item.outcome === 'purged').length);
  }
  await releaseLease(transaction, input.collectionId, leaseToken, leaseGeneration, now);
  const remaining = await remainingCount(transaction, input.collectionId);
  return Object.freeze({ results: Object.freeze(results), remaining });
}

async function loadLiveTombstones(
  transaction: DatabaseTransaction, collectionId: string,
): Promise<readonly TombstoneCandidate[]> {
  const result = await sql<TombstoneCandidate>`
    SELECT tombstone.collection_id, tombstone.target_id, tombstone.operation_id,
      tombstone.delete_revision, tombstone.delete_commit_ordinal, tombstone.purge_after,
      tombstone.affected_count
    FROM sync_node_tombstones AS tombstone
    INNER JOIN nodes AS node
      ON node.collection_id = tombstone.collection_id AND node.id = tombstone.target_id
    WHERE tombstone.collection_id = ${collectionId}
      AND tombstone.payload_purged_at IS NULL
      AND node.deleted_at IS NOT NULL
    ORDER BY tombstone.delete_commit_ordinal, tombstone.operation_id, tombstone.target_id
    FOR UPDATE OF tombstone
  `.execute(transaction);
  return result.rows;
}

function groupByOperation(rows: readonly TombstoneCandidate[]): TombstoneCandidate[][] {
  const groups: TombstoneCandidate[][] = [];
  for (const row of rows) {
    const tail = groups.at(-1);
    if (tail && tail[0]?.operation_id === row.operation_id) tail.push(row);
    else groups.push([row]);
  }
  return groups;
}

async function skipReason(
  transaction: DatabaseTransaction,
  collectionId: string,
  group: readonly TombstoneCandidate[],
  now: Date,
  purgedThroughOrdinal: bigint,
  purgedThroughStableId: string,
): Promise<ProductSyncTrashEmptySkipReason | null> {
  const first = group[0];
  if (!first) return 'watermark';
  if (!await hasCompleteDeleteGroup(transaction, collectionId, first.operation_id, first.affected_count)) return 'watermark';
  if (group.some((row) => row.purge_after > now
      || BigInt(row.delete_commit_ordinal) !== BigInt(first.delete_commit_ordinal))) {
    return group.some((row) => row.purge_after > now) ? 'retention_window' : 'watermark';
  }
  if (BigInt(first.delete_commit_ordinal) < purgedThroughOrdinal
      || (BigInt(first.delete_commit_ordinal) === purgedThroughOrdinal
        && first.operation_id <= purgedThroughStableId)) {
    return 'watermark';
  }
  const active = await sql<ActiveReplicaCheckpoint>`
    SELECT checkpoint_commit_ordinal,checkpoint_stream_kind,checkpoint_stable_id
    FROM sync_replicas AS replica
    WHERE replica.collection_id=${collectionId} AND replica.status='active'
    ORDER BY replica.replica_id FOR SHARE OF replica`.execute(transaction);
  const deleteTuple = [BigInt(first.delete_commit_ordinal), SYNC_PULL_STREAM_KIND_ORDER.operation,
    first.operation_id] as const;
  const blocked = active.rows.some((row) => row.checkpoint_commit_ordinal === null
    || row.checkpoint_stream_kind === null || row.checkpoint_stable_id === null
    || BigInt(row.checkpoint_commit_ordinal) < deleteTuple[0]
    || (BigInt(row.checkpoint_commit_ordinal) === deleteTuple[0]
      && (row.checkpoint_stream_kind < deleteTuple[1]
        || (row.checkpoint_stream_kind === deleteTuple[1]
          && row.checkpoint_stable_id < deleteTuple[2]))));
  if (blocked) return 'replica_checkpoint';
  return null;
}

function evaluateMemberReason(
  row: TombstoneCandidate, now: Date, groupReason: ProductSyncTrashEmptySkipReason,
): ProductSyncTrashEmptySkipReason {
  if (row.purge_after > now) return 'retention_window';
  return groupReason;
}

function skipped(
  row: TombstoneCandidate, reason: ProductSyncTrashEmptySkipReason,
): ProductSyncTrashEmptyItemResult {
  return Object.freeze({
    deletionId: encodeTrashDeletionId(row.operation_id, row.target_id),
    outcome: 'skipped' as const, reason,
  });
}

async function applyGroup(
  transaction: DatabaseTransaction,
  collectionId: string,
  group: readonly TombstoneCandidate[],
  now: Date,
  nextRevision: bigint,
  leaseToken: string,
  leaseGeneration: string,
): Promise<void> {
  const first = group[0]!;
  await transaction.insertInto('sync_purged_node_id_watermarks').values(group.map((row) => ({
    collection_id: collectionId, target_id: row.target_id,
    delete_commit_ordinal: BigInt(row.delete_commit_ordinal), delete_revision: row.delete_revision,
    delete_operation_id: row.operation_id, purge_state_revision: nextRevision, purged_at: now,
  }))).execute();
  const compacted = await sql`UPDATE sync_node_tombstones SET
      payload_json=jsonb_set(payload_json,'{extensions}','{}'::jsonb,true),
      payload_purged_at=${now}, purge_state_revision=${nextRevision}
    WHERE collection_id=${collectionId} AND operation_id=${first.operation_id}
      AND payload_purged_at IS NULL`.execute(transaction);
  if (Number(compacted.numAffectedRows ?? 0) !== group.length) throw new SyncTombstonePurgeFenceLostError();
  await sql`select set_config('known.sync_authority', 'server', true),
    set_config('known.sync_effect_purge', 'server', true)`.execute(transaction);
  await sql`DELETE FROM sync_operation_effect_pages page USING sync_operation_effects effect
    WHERE page.effect_id=effect.effect_id AND effect.collection_id=${collectionId}
      AND effect.commit_ordinal <= ${BigInt(first.delete_commit_ordinal)}`.execute(transaction);
  await sql`DELETE FROM sync_operation_effects
    WHERE collection_id=${collectionId}
      AND commit_ordinal <= ${BigInt(first.delete_commit_ordinal)}`.execute(transaction);
  const advanced = await sql`UPDATE sync_collection_purge_state SET
      purged_through_commit_ordinal=${BigInt(first.delete_commit_ordinal)},
      purged_through_stream_kind=${SYNC_PULL_STREAM_KIND_ORDER.operation},
      purged_through_stable_id=${first.operation_id}, state_revision=${nextRevision},
      last_completed_at=${now}, updated_at=${now}
    WHERE collection_id=${collectionId} AND lease_token=${leaseToken}
      AND lease_generation=${BigInt(leaseGeneration)} AND lease_expires_at > ${now}`.execute(transaction);
  if (Number(advanced.numAffectedRows ?? 0) !== 1) throw new SyncTombstonePurgeFenceLostError();
}

async function assertFence(
  transaction: DatabaseTransaction, collectionId: string, leaseToken: string,
  leaseGeneration: string, now: Date,
): Promise<void> {
  const stateResult = await sql<PurgeStateRow>`SELECT * FROM sync_collection_purge_state
    WHERE collection_id=${collectionId} FOR UPDATE`.execute(transaction);
  const state = stateResult.rows[0];
  if (!state || state.lease_token !== leaseToken
      || BigInt(state.lease_generation).toString() !== leaseGeneration
      || !(state.lease_expires_at instanceof Date) || state.lease_expires_at <= now) {
    throw new SyncTombstonePurgeFenceLostError();
  }
}

async function releaseLease(
  transaction: DatabaseTransaction, collectionId: string, leaseToken: string,
  leaseGeneration: string, now: Date,
): Promise<void> {
  const released = await sql`UPDATE sync_collection_purge_state SET lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,last_completed_at=${now},updated_at=${now}
    WHERE collection_id=${collectionId} AND lease_token=${leaseToken}
      AND lease_generation=${BigInt(leaseGeneration)} AND lease_expires_at > ${now}`.execute(transaction);
  if (Number(released.numAffectedRows ?? 0) !== 1) throw new SyncTombstonePurgeFenceLostError();
}

async function remainingCount(transaction: DatabaseTransaction, collectionId: string): Promise<number> {
  const result = await sql<{ count: string | number }>`
    SELECT count(*)::int AS count
    FROM sync_node_tombstones AS tombstone
    INNER JOIN nodes AS node
      ON node.collection_id = tombstone.collection_id AND node.id = tombstone.target_id
    WHERE tombstone.collection_id = ${collectionId}
      AND tombstone.payload_purged_at IS NULL
      AND node.deleted_at IS NOT NULL
  `.execute(transaction);
  return Number(result.rows[0]?.count ?? 0);
}

async function databaseNow(transaction: DatabaseTransaction, override?: Date): Promise<Date> {
  const result = override
    ? await sql<{ now: Date }>`SELECT ${override}::timestamptz AS now`.execute(transaction)
    : await sql<{ now: Date }>`SELECT current_timestamp AS now`.execute(transaction);
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) throw new TypeError('PostgreSQL did not return an authoritative timestamp.');
  return now;
}
