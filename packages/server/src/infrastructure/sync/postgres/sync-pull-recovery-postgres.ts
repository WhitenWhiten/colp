import { createHash } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import { appendAuditEvent } from '../../database/audit-event-payload.js';
import {
  buildSyncRouteAuthorityContext,
  sameSyncRouteLineage,
  SYNC_PULL_STREAM_KIND_ORDER,
  SyncPullReadError,
  type SyncPullCursorContext,
  type SyncPullCursorLineageFacts,
  type SyncPullCursorLineageKeyring,
  type SyncPullReadErrorCode,
  type SyncPullTuple,
} from '../../../modules/sync/index.js';
import type { SyncPullCursorLineageTable } from '../../database/runtime.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';
import type { PullAuthority } from './sync-pull-authority-postgres.js';
import { compareStoredTuple, compareTuple } from './sync-pull-cursor-codec-postgres.js';
import { lookupSyncPullPageEvidenceByNextCursorDigest } from './sync-pull-page-evidence-postgres.js';

function proofTupleIsCompatible(
  proof: { readonly tuple_commit_ordinal: bigint; readonly tuple_stream_kind: number;
    readonly tuple_stable_id: string; readonly upper_commit_ordinal: bigint;
    readonly upper_stream_kind: number; readonly upper_stable_id: string;
    readonly purge_commit_ordinal: bigint; readonly purge_stream_kind: number;
    readonly purge_stable_id: string },
  currentPurge: SyncPullTuple,
): boolean {
  const tuple = [BigInt(proof.tuple_commit_ordinal), proof.tuple_stream_kind, proof.tuple_stable_id] as const;
  const upper = [BigInt(proof.upper_commit_ordinal), proof.upper_stream_kind, proof.upper_stable_id] as const;
  const issuedPurge = [BigInt(proof.purge_commit_ordinal), proof.purge_stream_kind, proof.purge_stable_id] as const;
  const livePurge = [BigInt(currentPurge.commitOrdinal), SYNC_PULL_STREAM_KIND_ORDER[currentPurge.streamKind],
    currentPurge.stableId] as const;
  return compareStoredTuple(issuedPurge, tuple) <= 0 && compareStoredTuple(tuple, upper) <= 0
    && compareStoredTuple(issuedPurge, livePurge) <= 0;
}

export async function markRecoveryForExpiredCursor(
  transaction: DatabaseTransaction,
  authority: PullAuthority,
  context: SyncPullCursorContext,
  cursor: string,
  cursorNow: number,
): Promise<void> {
  const digest = createHash('sha256').update(cursor, 'utf8').digest('hex');
  const proof = await transaction.selectFrom('sync_pull_cursor_recovery_proofs').selectAll()
    .where('replica_id', '=', authority.replicaId).where('collection_id', '=', authority.collectionId)
    .where('cursor_digest', '=', digest).forUpdate().executeTakeFirst();
  if (!proof || proof.account_id !== authority.accountId
      || BigInt(proof.lease_generation) !== BigInt(authority.leaseGeneration)
      || BigInt(proof.authority_lifecycle_revision) > BigInt(authority.lifecycleRevision)
      || proof.policy_revision !== authority.policyRevision
      || proof.protocol_version !== authority.protocolVersion
      || proof.page_limit !== context.limit || proof.consumed_at !== null
      || proof.cursor_expires_at.getTime() > cursorNow
      || proof.proof_expires_at.getTime() <= cursorNow
      || authority.checkpointCursor === null || authority.checkpointTuple === null
      || createHash('sha256').update(authority.checkpointCursor, 'utf8').digest('hex') !== digest
      || BigInt(proof.tuple_commit_ordinal) !== BigInt(authority.checkpointTuple.commitOrdinal)
      || proof.tuple_stream_kind !== SYNC_PULL_STREAM_KIND_ORDER[authority.checkpointTuple.streamKind]
      || proof.tuple_stable_id !== authority.checkpointTuple.stableId
      || !proofTupleIsCompatible(proof, context.purgeBoundary)) fail('sync_cursor_expired');
  const consumed = await transaction.updateTable('sync_pull_cursor_recovery_proofs').set({ consumed_at: authority.now })
    .where('proof_id', '=', proof.proof_id).where('consumed_at', 'is', null)
    .returning('proof_id').executeTakeFirst();
  if (!consumed) fail('sync_cursor_expired');
  await transitionReplicaToRecovery(transaction, authority, context.purgeBoundary, 'cursor_expired');
}

export async function transitionReplicaToRecovery(
  transaction: DatabaseTransaction,
  authority: PullAuthority,
  purgeBoundary: SyncPullTuple,
  reason: 'purge_boundary' | 'cursor_expired' | 'effect_cutover' | 'history_floor' | 'payload_too_large',
): Promise<void> {
  const updated = await transaction.updateTable('sync_replicas').set({
    status: 'recovery_required',
    lifecycle_revision: sql<bigint>`lifecycle_revision + 1`,
    wire_json: sql<Record<string, unknown>>`jsonb_set(wire_json, '{status}', '"recovery_required"'::jsonb, true)`,
  }).where('replica_id', '=', authority.replicaId).where('collection_id', '=', authority.collectionId)
    .where('lease_generation', '=', BigInt(authority.leaseGeneration)).where('status', '=', 'active')
    .returning('replica_id').executeTakeFirst();
  if (!updated) fail('stale_replica');
  await appendAuditEvent(transaction, { operationId: null, collectionId: null,
    principalId: null, eventType: 'sync.replica.lifecycle.recovery_required', details: {
      replicaId: authority.replicaId, collectionId: authority.collectionId,
      leaseGeneration: authority.leaseGeneration, purgeBoundary, reason,
    } });
}

export async function resolveCursorHandoff(
  transaction: DatabaseTransaction,
  authority: PullAuthority,
  context: SyncPullCursorContext,
  cursor: string,
  cursorNow: number,
  finalizeAuthority: () => Promise<PullAuthority>,
  lineageKeyring: SyncPullCursorLineageKeyring | undefined,
): Promise<{ readonly tuple: SyncPullTuple; readonly expiresAt: number }
  | { readonly recoveryRequired: true }> {
  const digest = createHash('sha256').update(cursor, 'utf8').digest('hex');
  const evidence = await transaction.selectFrom('sync_pull_cursor_evidence').selectAll()
    .where('replica_id', '=', authority.replicaId).where('collection_id', '=', authority.collectionId)
    .where('cursor_digest', '=', digest).executeTakeFirst();
  if (!evidence) {
    const page = await lookupSyncPullPageEvidenceByNextCursorDigest(
      transaction, authority.replicaId, authority.collectionId, digest,
    );
    if (page && page.page_expires_at.getTime() > cursorNow
        && page.session_id === context.sessionId
        && page.account_id === authority.accountId
        && BigInt(page.lease_generation) === BigInt(authority.leaseGeneration)
        && page.policy_revision === authority.policyRevision
        && page.protocol_version === authority.protocolVersion
        && page.page_limit === context.limit) {
      const tuple = Object.freeze({
        commitOrdinal: BigInt(page.upper_commit_ordinal).toString(),
        streamKind: page.upper_stream_kind === SYNC_PULL_STREAM_KIND_ORDER.operation
          ? 'operation' as const : page.upper_stream_kind === SYNC_PULL_STREAM_KIND_ORDER.conflict
            ? 'conflict' as const : fail('integrity_failure'),
        stableId: page.upper_stable_id,
      });
      if (compareTuple(tuple, context.purgeBoundary) < 0) fail('sync_cursor_expired');
      return Object.freeze({ tuple, expiresAt: page.page_expires_at.getTime() });
    }
    const proof = await transaction.selectFrom('sync_pull_cursor_recovery_proofs').select('proof_id')
      .where('replica_id', '=', authority.replicaId).where('collection_id', '=', authority.collectionId)
      .where('cursor_digest', '=', digest).executeTakeFirst();
    if (!proof) {
      // FIX-L-035: both the evidence and the recovery proof were cleaned, so the
      // only remaining authenticator is the longer-lived signed lineage. A cursor
      // whose digest matches a receipt-authenticated, binding-matched, expired
      // lineage row is provably old and gets 410 + snapshot recovery guidance;
      // random or tampered cursors (no row, wrong binding, or a broken receipt)
      // keep the 400 invalid_cursor_scope contract.
      const lineage = await transaction.selectFrom('sync_pull_cursor_lineage').selectAll()
        .where('replica_id', '=', authority.replicaId)
        .where('cursor_digest', '=', digest).executeTakeFirst();
      if (lineage !== undefined
          && lineageProvesExpiredCursor(lineage, authority, cursorNow, lineageKeyring)) {
        const finalized = await finalizeAuthority();
        await transitionReplicaToRecovery(transaction, finalized, context.purgeBoundary, 'cursor_expired');
        return Object.freeze({ recoveryRequired: true as const });
      }
      fail('invalid_cursor_scope');
    }
    const finalized = await finalizeAuthority();
    await markRecoveryForExpiredCursor(transaction, finalized, context, cursor, cursorNow);
    return Object.freeze({ recoveryRequired: true as const });
  }
  const proof = await transaction.selectFrom('sync_pull_cursor_recovery_proofs').selectAll()
    .where('replica_id', '=', authority.replicaId).where('collection_id', '=', authority.collectionId)
    .where('cursor_digest', '=', digest).executeTakeFirst();
  if (!proof || proof.authority_session_id !== evidence.session_id
      || proof.cursor_expires_at.getTime() !== evidence.cursor_expires_at.getTime()
      || proof.page_limit !== evidence.page_limit
      || !proofTupleIsCompatible(proof, context.purgeBoundary)
      || !sameSyncRouteLineage(buildSyncRouteAuthorityContext({ accountId: proof.account_id,
        collectionId: proof.collection_id, replicaId: proof.replica_id,
        sessionId: proof.authority_session_id, leaseGeneration: BigInt(proof.lease_generation).toString(),
        lifecycleRevision: BigInt(proof.authority_lifecycle_revision).toString(),
        policyRevision: proof.policy_revision, protocolVersion: proof.protocol_version }),
      buildSyncRouteAuthorityContext({ accountId: authority.accountId, collectionId: authority.collectionId,
        replicaId: authority.replicaId, sessionId: context.sessionId,
        leaseGeneration: authority.leaseGeneration, lifecycleRevision: authority.lifecycleRevision,
        policyRevision: authority.policyRevision, protocolVersion: authority.protocolVersion }))) {
    fail('invalid_cursor_scope');
  }
  const issuedPurge = [BigInt(evidence.purge_commit_ordinal), evidence.purge_stream_kind,
    evidence.purge_stable_id] as const;
  const livePurge = [BigInt(context.purgeBoundary.commitOrdinal),
    SYNC_PULL_STREAM_KIND_ORDER[context.purgeBoundary.streamKind], context.purgeBoundary.stableId] as const;
  const purgeComparison = compareStoredTuple(issuedPurge, livePurge);
  const sessionChanged = evidence.session_id !== context.sessionId;
  const purgeBoundaryAdvanced = purgeComparison < 0;
  if ((!sessionChanged && !purgeBoundaryAdvanced) || purgeComparison > 0
      || evidence.account_id !== authority.accountId
      || BigInt(evidence.lease_generation) !== BigInt(authority.leaseGeneration)
      || evidence.policy_revision !== authority.policyRevision
      || evidence.protocol_version !== authority.protocolVersion
      || evidence.page_limit !== context.limit) fail('invalid_cursor_scope');
  if (evidence.cursor_expires_at.getTime() <= cursorNow) {
    const finalized = await finalizeAuthority();
    await markRecoveryForExpiredCursor(transaction, finalized, context, cursor, cursorNow);
    return Object.freeze({ recoveryRequired: true as const });
  }
  const tuple = Object.freeze({
    commitOrdinal: BigInt(evidence.tuple_commit_ordinal).toString(),
    streamKind: evidence.tuple_stream_kind === SYNC_PULL_STREAM_KIND_ORDER.operation
      ? 'operation' as const : evidence.tuple_stream_kind === SYNC_PULL_STREAM_KIND_ORDER.conflict
        ? 'conflict' as const : fail('integrity_failure'),
    stableId: evidence.tuple_stable_id,
  });
  if (compareTuple(tuple, context.purgeBoundary) < 0) fail('sync_cursor_expired');
  return Object.freeze({ tuple, expiresAt: evidence.cursor_expires_at.getTime() });
}

/**
 * FIX-L-035: the 410 + snapshot recovery gate for cursors whose evidence and
 * recovery proof were both cleaned. Only a receipt-authenticated lineage row
 * whose binding matches the current authority and whose cursor expiry has
 * passed is provably old; everything else stays 400 invalid_cursor_scope.
 */
export function lineageProvesExpiredCursor(
  lineage: Selectable<SyncPullCursorLineageTable>,
  authority: Pick<PullAuthority, 'accountId' | 'collectionId' | 'replicaId'>,
  cursorNow: number,
  keyring: SyncPullCursorLineageKeyring | undefined,
): boolean {
  if (keyring === undefined || keyring.destroyed) return false;
  if (lineage.account_id !== authority.accountId
      || lineage.collection_id !== authority.collectionId
      || lineage.replica_id !== authority.replicaId) return false;
  if (!Number.isSafeInteger(lineage.cursor_expires_at.getTime())) return false;
  if (lineage.cursor_expires_at.getTime() > cursorNow) return false;
  return keyring.verify(lineage.receipt, lineageFactsFromRow(lineage)).valid;
}

function lineageFactsFromRow(lineage: Selectable<SyncPullCursorLineageTable>): SyncPullCursorLineageFacts {
  return Object.freeze({
    cursorDigest: lineage.cursor_digest,
    sessionId: lineage.session_id,
    accountId: lineage.account_id,
    collectionId: lineage.collection_id,
    replicaId: lineage.replica_id,
    leaseGeneration: BigInt(lineage.lease_generation).toString(),
    policyRevision: lineage.policy_revision,
    protocolVersion: lineage.protocol_version,
    pageLimit: lineage.page_limit,
    tuple: Object.freeze({
      commitOrdinal: BigInt(lineage.tuple_commit_ordinal).toString(),
      streamKind: lineage.tuple_stream_kind === SYNC_PULL_STREAM_KIND_ORDER.operation
        ? 'operation' as const : 'conflict' as const,
      stableId: lineage.tuple_stable_id,
    }),
    cursorExpiresAt: lineage.cursor_expires_at.getTime(),
  });
}

function fail(code: SyncPullReadErrorCode): never {
  throw new SyncPullReadError(code);
}
