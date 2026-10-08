import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import {
  INITIAL_SYNC_PULL_PURGE_BOUNDARY,
  SYNC_PULL_STREAM_KIND_ORDER,
  SyncPullReadError,
  syncPullStableIdHash,
  type SyncPullCursorAnchor,
  type SyncPullCursorContext,
  type SyncPullCursorKeyring,
  type SyncPullReadErrorCode,
  type SyncPullTuple,
} from '../../../modules/sync/index.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';
import type { PullAuthority } from './sync-pull-authority-postgres.js';
import { lookupSyncPullPageEvidenceByNextCursorDigest } from './sync-pull-page-evidence-postgres.js';
import { selectConflictStreamAnchorIds } from '../sync-snapshot-conflict-recovery.js';

export function compareTuple(left: SyncPullTuple, right: SyncPullTuple): number {
  const leftOrdinal = BigInt(left.commitOrdinal); const rightOrdinal = BigInt(right.commitOrdinal);
  if (leftOrdinal !== rightOrdinal) return leftOrdinal < rightOrdinal ? -1 : 1;
  const leftKind = SYNC_PULL_STREAM_KIND_ORDER[left.streamKind];
  const rightKind = SYNC_PULL_STREAM_KIND_ORDER[right.streamKind];
  if (leftKind !== rightKind) return leftKind < rightKind ? -1 : 1;
  return left.stableId < right.stableId ? -1 : left.stableId > right.stableId ? 1 : 0;
}

export function compareStoredTuple(
  left: readonly [bigint, number, string],
  right: readonly [bigint, number, string],
): number {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  return left[2] < right[2] ? -1 : left[2] > right[2] ? 1 : 0;
}

export function syncPullTupleIsBehindHistoryFloor(
  after: SyncPullTuple,
  floor: SyncPullTuple,
): boolean {
  return compareTuple(after, floor) < 0;
}

export async function cursorIsBehindEffectCutover(
  transaction: DatabaseTransaction,
  authority: PullAuthority,
  after: SyncPullTuple,
): Promise<boolean> {
  await sql`select set_config('known.sync_authority', 'server', true)`.execute(transaction);
  const cutover = await transaction.selectFrom('sync_collection_effect_cutovers')
    .select('effect_cutover_ordinal').where('collection_id', '=', authority.collectionId).executeTakeFirst();
  if (!cutover) fail('integrity_failure');
  const snapshotBoundary = BigInt(cutover.effect_cutover_ordinal) - 1n;
  return BigInt(after.commitOrdinal) < snapshotBoundary;
}

export async function reuseOrIssueInitialCursor(
  transaction: DatabaseTransaction,
  authority: PullAuthority,
  context: SyncPullCursorContext,
  tuple: SyncPullTuple,
  keyring: SyncPullCursorKeyring,
  cursorNow: number,
): Promise<string> {
  const issuanceScope = JSON.stringify([authority.accountId, authority.collectionId, authority.replicaId,
    context.sessionId, authority.leaseGeneration, authority.policyRevision, authority.protocolVersion,
    String(context.limit), tuple.commitOrdinal, tuple.streamKind, tuple.stableId,
    context.purgeBoundary.commitOrdinal, context.purgeBoundary.streamKind,
    context.purgeBoundary.stableId]);
  await sql`select pg_advisory_xact_lock(hashtextextended(${issuanceScope}, 0))`.execute(transaction);
  const persisted = await transaction.selectFrom('sync_pull_cursor_evidence').select([
    'cursor', 'cursor_expires_at',
  ]).where('replica_id', '=', authority.replicaId)
    .where('collection_id', '=', authority.collectionId)
    .where('session_id', '=', context.sessionId)
    .where('account_id', '=', authority.accountId)
    .where('lease_generation', '=', BigInt(authority.leaseGeneration))
    .where('policy_revision', '=', authority.policyRevision)
    .where('protocol_version', '=', authority.protocolVersion)
    .where('page_limit', '=', context.limit)
    .where('tuple_commit_ordinal', '=', BigInt(tuple.commitOrdinal))
    .where('tuple_stream_kind', '=', SYNC_PULL_STREAM_KIND_ORDER[tuple.streamKind])
    .where('tuple_stable_id', '=', tuple.stableId)
    .where('purge_commit_ordinal', '=', BigInt(context.purgeBoundary.commitOrdinal))
    .where('purge_stream_kind', '=', SYNC_PULL_STREAM_KIND_ORDER[context.purgeBoundary.streamKind])
    .where('purge_stable_id', '=', context.purgeBoundary.stableId)
    .where('cursor', 'is not', null)
    .where('cursor_expires_at', '>', new Date(cursorNow))
    .orderBy('issued_at', 'desc').executeTakeFirst();
  if (persisted?.cursor) {
    const verified = keyring.verify(persisted.cursor, context);
    if (verified.valid && verified.expiresAt === persisted.cursor_expires_at.getTime()) return persisted.cursor;
  }
  return keyring.sign({ ...context, tuple });
}

export async function loadPurgeBoundary(
  transaction: DatabaseTransaction,
  collectionId: string,
): Promise<SyncPullTuple> {
  const row = await transaction.selectFrom('sync_collection_purge_state').select([
    'purged_through_commit_ordinal', 'purged_through_stream_kind', 'purged_through_stable_id',
  ]).where('collection_id', '=', collectionId).executeTakeFirst();
  if (!row) return INITIAL_SYNC_PULL_PURGE_BOUNDARY;
  return Object.freeze({
    commitOrdinal: BigInt(row.purged_through_commit_ordinal).toString(),
    streamKind: row.purged_through_stream_kind === 0 ? 'operation' : 'conflict',
    stableId: row.purged_through_stable_id,
  });
}

export async function cursorIsBehindPurgeBoundary(
  transaction: DatabaseTransaction,
  authority: PullAuthority,
  cursor: string,
  context: SyncPullCursorContext,
): Promise<boolean> {
  const boundary = context.purgeBoundary;
  if (boundary.commitOrdinal === '0') return false;
  const digest = createHash('sha256').update(cursor, 'utf8').digest('hex');
  const evidence = await transaction.selectFrom('sync_pull_cursor_evidence').select([
    'tuple_commit_ordinal', 'tuple_stream_kind', 'tuple_stable_id',
  ]).where('replica_id', '=', authority.replicaId).where('collection_id', '=', authority.collectionId)
    // Purge changes the signed cursor context. Authenticate its durable issue
    // evidence before that drift is allowed to change the current Replica.
    .where('session_id', '=', context.sessionId).where('account_id', '=', authority.accountId)
    .where('lease_generation', '=', BigInt(authority.leaseGeneration))
    .where('policy_revision', '=', authority.policyRevision).where('protocol_version', '=', authority.protocolVersion)
    .where('page_limit', '=', context.limit)
    .where('cursor_digest', '=', digest).executeTakeFirst();
  if (evidence) {
    const tuple = [BigInt(evidence.tuple_commit_ordinal), evidence.tuple_stream_kind,
      evidence.tuple_stable_id] as const;
    const purge = [BigInt(boundary.commitOrdinal), SYNC_PULL_STREAM_KIND_ORDER[boundary.streamKind],
      boundary.stableId] as const;
    return tuple[0] < purge[0] || (tuple[0] === purge[0]
      && (tuple[1] < purge[1] || (tuple[1] === purge[1] && tuple[2] < purge[2])));
  }
  const page = await lookupSyncPullPageEvidenceByNextCursorDigest(
    transaction, authority.replicaId, authority.collectionId, digest,
  );
  if (!page || page.session_id !== context.sessionId || page.account_id !== authority.accountId
      || BigInt(page.lease_generation) !== BigInt(authority.leaseGeneration)
      || page.policy_revision !== authority.policyRevision || page.protocol_version !== authority.protocolVersion
      || page.page_limit !== context.limit) return false;
  const tuple = [BigInt(page.upper_commit_ordinal), page.upper_stream_kind, page.upper_stable_id] as const;
  const purge = [BigInt(boundary.commitOrdinal), SYNC_PULL_STREAM_KIND_ORDER[boundary.streamKind],
    boundary.stableId] as const;
  return tuple[0] < purge[0] || (tuple[0] === purge[0]
    && (tuple[1] < purge[1] || (tuple[1] === purge[1] && tuple[2] < purge[2])));
}

export async function loadSyncHistoryFloor(
  transaction: DatabaseTransaction,
  collectionId: string,
): Promise<SyncPullTuple> {
  const row = await transaction.selectFrom('sync_history_floors').select([
    'floor_commit_ordinal', 'floor_stream_kind', 'floor_stable_id',
  ]).where('collection_id', '=', collectionId).executeTakeFirst();
  if (!row) fail('integrity_failure');
  return Object.freeze({
    commitOrdinal: BigInt(row.floor_commit_ordinal).toString(),
    streamKind: row.floor_stream_kind === 0 ? 'operation' : fail('integrity_failure'),
    stableId: row.floor_stable_id,
  });
}

export async function resolveCursorAnchor(
  transaction: DatabaseTransaction,
  collectionId: string,
  anchor: SyncPullCursorAnchor,
  purgeBoundary: SyncPullTuple,
): Promise<SyncPullTuple> {
  if (anchor.commitOrdinal === purgeBoundary.commitOrdinal && anchor.streamKind === purgeBoundary.streamKind
      && anchor.stableIdHash === syncPullStableIdHash(purgeBoundary.stableId)) return purgeBoundary;
  const rows = anchor.streamKind === 'operation'
    ? await transaction.selectFrom('operations').select('operation_id as stable_id')
      .where('collection_id', '=', collectionId).where('commit_ordinal', '=', BigInt(anchor.commitOrdinal))
      .where('sync_stream_kind', '=', SYNC_PULL_STREAM_KIND_ORDER.operation).execute()
    : await selectConflictStreamAnchorIds(transaction, collectionId, BigInt(anchor.commitOrdinal));
  const matches = rows.filter((row) => syncPullStableIdHash(row.stable_id) === anchor.stableIdHash);
  if (matches.length === 0) {
    // F026: the cursor passed signature + scope binding, so this backend issued
    // its anchor. A missing row means the evidence horizon moved past the
    // anchor (purge/archive) or the store can no longer prove the position —
    // either way the authentic cursor can never resume. The only self-healing
    // answer is the expired-cursor contract (410 sync_cursor_expired +
    // snapshotUrl at the route layer), never invalid_cursor_scope.
    fail('sync_cursor_expired');
  }
  // Two distinct rows colliding on one anchor hash is store corruption, not a
  // client scope error.
  if (matches.length !== 1) fail('integrity_failure');
  // The single-match guard above guarantees the first element exists.
  return Object.freeze({ commitOrdinal: anchor.commitOrdinal, streamKind: anchor.streamKind,
    stableId: matches[0]!.stable_id });
}

function fail(code: SyncPullReadErrorCode): never {
  throw new SyncPullReadError(code);
}
