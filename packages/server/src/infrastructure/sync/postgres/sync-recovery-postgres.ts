import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { SyncAckResult } from '@know-n/colp/types';
import {
  SyncAckError,
  buildSyncRouteAuthorityContext,
  syncPullCursorContext,
  validateVerifiedExtensionCredential,
  type SyncAckApplicationInput,
  type SyncRecoveryBoundary,
  type SyncRecoveryCapabilityClaims,
  type SyncRecoveryCapabilityKeyring,
  type SyncPullCursorContext,
  type SyncPullCursorKeyring,
  syncPullStableIdHash,
} from '../../../modules/sync/index.js';
import type { VerifiedExtensionCredential } from '../../../modules/identity/index.js';
import type { DatabaseSchema, SyncPullCursorEvidenceTable,
  SyncRecoveryCapabilityTable } from '../../database/runtime.js';
import { appendAuditEvent } from '../../database/audit-event-payload.js';
import { createUnitOfWork, type DatabaseTransaction } from '../../database/unit-of-work.js';
import { DatabaseOperationError } from '../../database/errors.js';
import { lockCollectionReplicaGate } from '../../database/lock-order.js';
import { createPostgresReplicaRetirementApplication } from '../sync-retire-postgres.js';
import {
  assertSnapshotOpenConflictsDelivered, readVisiblePullUpperKysely, selectConflictStreamAnchorIds,
} from '../sync-snapshot-conflict-recovery.js';

export type SyncRecoveryFaultPhase = 'capability' | 'snapshot_evidence' | 'generation' | 'checkpoint'
  | 'receipt' | 'audit' | 'commit_outcome';

export interface PostgresSyncRecoveryOptions {
  readonly capabilityKeys: SyncRecoveryCapabilityKeyring;
  readonly leaseExtensionSeconds: number;
  readonly maxLeaseLifetimeSeconds: number;
  readonly pullCursorKeyring?: SyncPullCursorKeyring;
  readonly recoveryProofRetentionMs?: number;
  readonly leaseId?: () => string;
  readonly faultInjector?: { readonly afterPhase?: (phase: SyncRecoveryFaultPhase) => void | Promise<void> };
}

interface RecoveryAckInput {
  readonly credential: VerifiedExtensionCredential;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly capability: string;
  readonly requestFingerprint: string;
  /** The ack request's cursor field; echoed as ackedCursor (legacy 0.1 Acks carry the capability there). */
  readonly requestCursor?: string;
  /** Whether the ack request carried the explicit recoveryCapability protocol field (FIX-M-012). */
  readonly explicitCapability?: boolean;
}

interface BootstrapSnapshotRow {
  readonly snapshot_id: string; readonly session_id: string; readonly account_id: string;
  readonly collection_id: string; readonly replica_id: string; readonly lease_generation: bigint;
  readonly policy_revision: string; readonly content_revision: string; readonly binding_mode: string;
  readonly binding_root_node_id: string; readonly snapshot_json: unknown; readonly bootstrap_cursor: string;
  readonly cursor_key_id: string; readonly generated_at: Date; readonly expires_at: Date;
  readonly completed_at: Date | null;
  readonly recovery_pull_page_limit: number | null;
}

export function createPostgresSyncRecoveryApplication(db: Kysely<DatabaseSchema>, options: PostgresSyncRecoveryOptions) {
  assertOptions(options);
  const leaseId = options.leaseId ?? (() => `lease-${randomUUID()}`);
  const bootstrapAcknowledge = async (input: RecoveryAckInput): Promise<SyncAckResult> => {
    validateVerifiedExtensionCredential(input.credential);
    try {
      const result = await createUnitOfWork(db).execute(async ({ transaction }) =>
        acknowledgeRecovery(transaction, input, options, leaseId));
      await options.faultInjector?.afterPhase?.('commit_outcome');
      return result;
    } catch (error: unknown) {
      if (error instanceof SyncAckError) throw error;
      if (isExpectedAuthorityConstraint(error)) deny('stale_replica');
      throw error;
    }
  };
  return Object.freeze({
    async requireRecoveryForStaleCursor(input: { readonly credential: VerifiedExtensionCredential;
      readonly sessionId: string; readonly cursor: string }) {
      validateVerifiedExtensionCredential(input.credential);
      return createUnitOfWork(db).execute(async ({ transaction }) => {
        const authority = await loadAuthority(transaction, input.credential, input.sessionId);
        const cursorDigest = digest(input.cursor);
        const evidence = await transaction.selectFrom('sync_pull_cursor_evidence').selectAll()
          .where('replica_id', '=', authority.replicaId).where('cursor_digest', '=', cursorDigest)
          .executeTakeFirst();
        if (!evidence || evidence.cursor !== input.cursor || evidence.session_id !== input.sessionId
            || BigInt(evidence.lease_generation) !== authority.generation) deny('invalid_cursor_scope');
        const boundary = await loadBoundary(transaction, authority.collectionId);
        if (compareTuple(tupleOf(evidence), boundary) > 0) deny('invalid_cursor_scope');
        if (authority.status === 'retired') deny('replica_retired');
        if (authority.status !== 'recovery_required') {
          const updated = await transaction.updateTable('sync_replicas').set({
            status: 'recovery_required', lifecycle_revision: authority.lifecycleRevision + 1n,
            wire_json: sql<Record<string, unknown>>`jsonb_set(wire_json, '{status}', '"recovery_required"'::jsonb, true)`,
          }).where('replica_id', '=', authority.replicaId).where('lease_generation', '=', authority.generation)
            .where('lifecycle_revision', '=', authority.lifecycleRevision).where('status', 'in', ['active', 'expired'])
            .returning('replica_id').executeTakeFirst();
          if (!updated) deny('stale_replica');
          await appendAuditEvent(transaction, { operationId: null, collectionId: null,
            principalId: null, eventType: 'sync.replica.lifecycle.recovery_required', details: {
              replicaId: authority.replicaId, collectionId: authority.collectionId,
              leaseGeneration: authority.generation.toString(), purgeBoundary: boundary,
            } });
        }
        return Object.freeze({ state: 'recovery_required' as const });
      });
    },

    async recordSnapshotPage(input: { readonly credential: VerifiedExtensionCredential; readonly sessionId: string;
      readonly snapshotId: string; readonly sequence: number; readonly startOffset: number;
      readonly endOffset: number; readonly complete: boolean; readonly responseDigest: string }) {
      validateVerifiedExtensionCredential(input.credential);
      return createUnitOfWork(db).execute(async ({ transaction }) => {
        const authority = await loadAuthority(transaction, input.credential, input.sessionId);
        if (authority.status !== 'recovery_required') deny('stale_replica');
        const snapshot = await loadSnapshot(transaction, input.snapshotId, authority);
        if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || !Number.isSafeInteger(input.startOffset)
            || !Number.isSafeInteger(input.endOffset) || input.startOffset < 0 || input.endOffset < input.startOffset
            || !/^[A-Za-z0-9._~-]{1,128}$/u.test(input.responseDigest)) deny('invalid_document');
        const nodeCount = snapshotNodeCount(snapshot.snapshot_json);
        if (input.endOffset > nodeCount || input.complete !== (input.endOffset === nodeCount)) deny('invalid_document');
        await transaction.insertInto('sync_bootstrap_snapshot_pages').values({ snapshot_id: input.snapshotId,
          session_id: input.sessionId, replica_id: authority.replicaId, old_lease_generation: authority.generation,
          page_sequence: input.sequence, page_start_offset: input.startOffset, page_end_offset: input.endOffset,
          complete: input.complete, response_digest: input.responseDigest }).onConflict((conflict) =>
          conflict.columns(['snapshot_id', 'page_sequence']).doNothing()).execute();
        const persisted = await transaction.selectFrom('sync_bootstrap_snapshot_pages').selectAll()
          .where('snapshot_id', '=', input.snapshotId).where('page_sequence', '=', input.sequence).executeTakeFirst();
        if (!persisted || persisted.session_id !== input.sessionId || persisted.replica_id !== authority.replicaId
            || persisted.page_start_offset !== input.startOffset || persisted.page_end_offset !== input.endOffset
            || persisted.complete !== input.complete || persisted.response_digest !== input.responseDigest) {
          deny('invalid_cursor_scope');
        }
        return Object.freeze({ recorded: true as const });
      });
    },

    async issueCapability(input: { readonly credential: VerifiedExtensionCredential; readonly sessionId: string;
      readonly snapshotId: string }) {
      validateVerifiedExtensionCredential(input.credential);
      return createUnitOfWork(db).execute(async ({ transaction }) => {
        const authority = await loadAuthority(transaction, input.credential, input.sessionId);
        if (authority.status !== 'recovery_required') deny('stale_replica');
        const snapshot = await loadSnapshot(transaction, input.snapshotId, authority);
        const collection = await transaction.selectFrom('collections').select(['content_revision', 'policy_revision'])
          .where('id', '=', authority.collectionId).forUpdate().executeTakeFirst();
        if (!collection || collection.content_revision !== snapshot.content_revision
            || collection.policy_revision !== snapshot.policy_revision) deny('stale_replica');
        const pages = await completePages(transaction, snapshot.snapshot_id, snapshotNodeCount(snapshot.snapshot_json));
        const boundary = await loadBoundary(transaction, authority.collectionId);
        const claims = claimsFrom(authority, snapshot, boundary, pages.length);
        const prior = await transaction.selectFrom('sync_recovery_capabilities').selectAll()
          .where('session_id', '=', input.sessionId).where('snapshot_id', '=', snapshot.snapshot_id)
          .where('old_lease_generation', '=', authority.generation).executeTakeFirst();
        // F006: anchor the lifetime on this issuance (the transaction clock is exactly the value the
        // insert records as `issued_at`), never on the Snapshot's older `generated_at`, which made a
        // slow paged recovery mint an already-expired token. A row already stored for this immutable
        // identity can only be replayed: re-signing its expiry reproduces the token the Ack resolves.
        const issuedAt = (await sql<{ now: Date }>`select current_timestamp as now`.execute(transaction)).rows[0]?.now;
        if (!(issuedAt instanceof Date)) deny('internal_error');
        let capability: string;
        try { capability = prior === undefined ? options.capabilityKeys.sign(claims, issuedAt.getTime())
          : options.capabilityKeys.signWithExpiry(claims, prior.expires_at.getTime(), prior.key_version); }
        catch { deny('invalid_cursor_scope', 'recovery_capability_sign'); }
        const verification = options.capabilityKeys.verify(capability, claims);
        if (!verification.valid) deny(verification.code, 'recovery_capability_verify');
        await transaction.insertInto('sync_recovery_capabilities').values({ capability_digest: digest(capability),
          session_id: input.sessionId, account_id: authority.accountId, replica_id: authority.replicaId,
          collection_id: authority.collectionId, old_lease_generation: authority.generation,
          purge_commit_ordinal: BigInt(boundary.commitOrdinal), purge_stream_kind: kindOrder(boundary.streamKind),
          purge_stable_id: boundary.stableId, snapshot_id: snapshot.snapshot_id,
          snapshot_revision: snapshot.content_revision, snapshot_page_count: pages.length,
          snapshot_node_count: snapshotNodeCount(snapshot.snapshot_json), snapshot_cursor: snapshot.bootstrap_cursor,
          purpose: 'sync-recovery-bootstrap-ack', version: 1, key_version: verification.keyId,
          expires_at: new Date(verification.expiresAt), consumed_at: null,
        }).onConflict((conflict) => conflict.columns(['session_id', 'snapshot_id', 'old_lease_generation'])
          .doNothing()).execute();
        const stored = await transaction.selectFrom('sync_recovery_capabilities').selectAll()
          .where('session_id', '=', input.sessionId).where('snapshot_id', '=', snapshot.snapshot_id)
          .where('old_lease_generation', '=', authority.generation).executeTakeFirst();
        if (!stored || stored.capability_digest !== digest(capability)) deny('invalid_cursor_scope', 'recovery_capability_replay');
        return capability;
      });
    },

    bootstrapAcknowledge,

    async acknowledge(input: SyncAckApplicationInput): Promise<SyncAckResult> {
      return bootstrapAcknowledge({ credential: input.credential, idempotencyKey: input.idempotencyKey,
        sessionId: input.request.sessionId,
        capability: input.request.recoveryCapability ?? input.request.cursor,
        requestCursor: input.request.cursor,
        explicitCapability: input.request.recoveryCapability !== undefined,
        requestFingerprint: input.requestFingerprint ?? digest(JSON.stringify(input.request)) });
    },

    async retire(input: { readonly credential: VerifiedExtensionCredential; readonly sessionId: string }) {
      const binding = digest(`${input.sessionId}\nrecovery-retire`);
      // Recovery is an internal capability, but retirement still uses the
      // same Origin-bound transaction authority as the HTTP route. Read the
      // durable session binding and pass it explicitly so future internal
      // callers cannot accidentally bypass the Origin check by omission.
      const session = await db.selectFrom('sync_sessions').select('origin')
        .where('session_id', '=', input.sessionId).executeTakeFirst();
      await createPostgresReplicaRetirementApplication(db).retireExtension({ credential: input.credential,
        sessionId: input.sessionId, origin: session?.origin ?? '', idempotencyKey: `recovery-${binding}`,
        requestFingerprint: 'sync-recovery-explicit-retire-v1' });
      return Object.freeze({ state: 'retired' as const });
    },
  });
}

async function acknowledgeRecovery(transaction: DatabaseTransaction, input: RecoveryAckInput,
  options: PostgresSyncRecoveryOptions, leaseId: () => string): Promise<SyncAckResult> {
  const capabilityDigest = digest(input.capability); const requestDigest = digest(input.requestFingerprint);
  const requestCursor = input.requestCursor ?? input.capability;
  const replayScope = await loadReplayScope(transaction, input.credential, input.sessionId);
  const existing = await transaction.selectFrom('sync_recovery_ack_receipts').selectAll()
    .where('replica_id', '=', replayScope.replicaId).where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (existing) {
    if (existing.request_digest !== requestDigest || existing.capability_digest !== capabilityDigest) deny('idempotency_key_reused');
    const result = existing.result_json as unknown as SyncAckResult;
    if (!createValidatorRegistry().validate('syncAckResult', result).valid || result.ackedCursor !== requestCursor) deny('internal_error');
    return Object.freeze(structuredClone(result));
  }
  const authority = await loadAuthority(transaction, input.credential, input.sessionId);
  if (authority.status === 'retired') deny('replica_retired');
  if (authority.status !== 'recovery_required') deny('stale_replica');
  // FIX-M-012: protocol 0.2 Acks must carry the capability in the explicit recoveryCapability
  // field; the capability-in-cursor form is only honored for legacy 0.1 clients.
  if (authority.protocolVersion === '0.2' && !input.explicitCapability) deny('invalid_cursor_scope', 'recovery_ack_capability_field');
  const capability = await transaction.selectFrom('sync_recovery_capabilities').selectAll()
    .where('capability_digest', '=', capabilityDigest).where('replica_id', '=', authority.replicaId)
    .where('expires_at', '>', sql<Date>`current_timestamp`)
    .forUpdate().executeTakeFirst();
  if (!capability || capability.session_id !== input.sessionId || capability.account_id !== authority.accountId
      || capability.collection_id !== authority.collectionId
      || BigInt(capability.old_lease_generation) !== authority.generation
      || capability.consumed_at !== null) deny('invalid_cursor_scope', 'recovery_ack_capability_binding');
  const claims = claimsFromRow(capability);
  const verified = options.capabilityKeys.verify(input.capability, claims);
  if (!verified.valid) deny(verified.code, 'recovery_ack_capability_verify');
  await options.faultInjector?.afterPhase?.('capability');
  const currentBoundary = await loadBoundary(transaction, authority.collectionId);
  if (compareTuple(currentBoundary, claims.purgeBoundary) !== 0) {
    deny('stale_replica', 'recovery_ack_purge_boundary');
  }
  const snapshot = await loadSnapshot(transaction, capability.snapshot_id, authority);
  if (snapshot.content_revision !== capability.snapshot_revision || snapshot.completed_at === null) deny('sync_cursor_expired');
  const collection = await transaction.selectFrom('collections')
    .select(['content_revision', 'policy_revision', 'commit_ordinal'])
    .where('id', '=', authority.collectionId).forUpdate().executeTakeFirst();
  if (!collection || collection.content_revision !== snapshot.content_revision
      || collection.policy_revision !== snapshot.policy_revision) deny('stale_replica');
  const pages = await completePages(transaction, snapshot.snapshot_id, capability.snapshot_node_count);
  if (pages.length !== capability.snapshot_page_count
      || snapshotNodeCount(snapshot.snapshot_json) !== capability.snapshot_node_count
      || snapshot.bootstrap_cursor !== capability.snapshot_cursor) {
    deny('invalid_cursor_scope', 'recovery_ack_snapshot_evidence');
  }
  await assertSnapshotOpenConflictsDelivered(transaction, snapshot.snapshot_id, input.sessionId);
  await options.faultInjector?.afterPhase?.('snapshot_evidence');
  const nextGeneration = authority.generation + 1n; const nextLeaseId = leaseId();
  if (!/^[A-Za-z0-9._~-]{1,512}$/u.test(nextLeaseId)) deny('internal_error');
  const now = (await sql<{ now: Date }>`select current_timestamp as now`.execute(transaction)).rows[0]?.now;
  // current_timestamp always yields exactly one row; a missing row is an internal fault.
  if (!(now instanceof Date)) deny('internal_error');
  const safeBoundary = await loadCurrentSafeBoundary(transaction, authority.collectionId,
    BigInt(collection.commit_ordinal), snapshot.snapshot_id, currentBoundary);
  const absoluteLimit = new Date(now.getTime() + options.maxLeaseLifetimeSeconds * 1_000);
  const leaseExpiresAt = new Date(Math.min(now.getTime() + options.leaseExtensionSeconds * 1_000,
    absoluteLimit.getTime()));
  if (leaseExpiresAt <= now) deny('stale_replica');
  await transaction.insertInto('sync_replica_generations').values({ replica_id: authority.replicaId,
    lease_generation: nextGeneration, lease_id: nextLeaseId, issued_at: now }).execute();
  await options.faultInjector?.afterPhase?.('generation');
  const activeCursor = await activateRecoveryPullCursor(transaction, options, authority, snapshot,
    currentBoundary, nextGeneration, now);
  const checkpointBoundary = activeCursor?.tuple ?? safeBoundary;
  await transaction.deleteFrom('sync_pull_cursor_recovery_proofs')
    .where('replica_id', '=', authority.replicaId).execute();
  await transaction.updateTable('sync_pull_cursor_evidence').set({ cursor: null })
    .where('replica_id', '=', authority.replicaId).where('cursor', 'is not', null).execute();
  if (activeCursor) await persistActivatedRecoveryCursor(transaction, activeCursor);
  const updated = await transaction.updateTable('sync_replicas').set({ lease_generation: nextGeneration,
    lease_id: nextLeaseId, status: 'active', checkpoint_cursor: snapshot.bootstrap_cursor,
    checkpoint_commit_ordinal: BigInt(checkpointBoundary.commitOrdinal),
    checkpoint_stream_kind: kindOrder(checkpointBoundary.streamKind), checkpoint_stable_id: checkpointBoundary.stableId,
    last_seen_at: now, lease_expires_at: leaseExpiresAt,
    lifecycle_revision: authority.lifecycleRevision + 1n,
    wire_json: sql<Record<string, unknown>>`wire_json || jsonb_build_object(
      'status', 'active', 'leaseId', ${nextLeaseId}::text,
      'leaseGeneration', ${nextGeneration.toString()}::text,
      'checkpoint', jsonb_build_object('acknowledgedCursor', ${snapshot.bootstrap_cursor}::text,
        'acknowledgedCommitOrdinal', ${checkpointBoundary.commitOrdinal}::text))`,
  }).where('replica_id', '=', authority.replicaId).where('lease_generation', '=', authority.generation)
    .where('lifecycle_revision', '=', authority.lifecycleRevision).where('status', '=', 'recovery_required')
    .returning('replica_id').executeTakeFirst();
  if (!updated) deny('stale_replica');
  await transaction.updateTable('sync_sessions').set({ status: 'terminated', termination_reason: 'lease_expired',
    terminated_at: now }).where('replica_id', '=', authority.replicaId)
    .where('lease_generation', '=', authority.generation).where('status', '=', 'active').execute();
  await options.faultInjector?.afterPhase?.('checkpoint');
  const result: SyncAckResult = Object.freeze({ replicaId: authority.replicaId,
    ackedCursor: requestCursor, ackedAt: now.toISOString() });
  await transaction.insertInto('sync_recovery_ack_receipts').values({ replica_id: authority.replicaId,
    idempotency_key: input.idempotencyKey, principal_id: authority.accountId, request_digest: requestDigest,
    capability_digest: capabilityDigest, session_id: input.sessionId, collection_id: authority.collectionId,
    snapshot_id: snapshot.snapshot_id, snapshot_revision: snapshot.content_revision,
    old_lease_generation: authority.generation, new_lease_generation: nextGeneration, new_lease_id: nextLeaseId,
    result_json: result as unknown as Record<string, unknown>, result_digest: digest(JSON.stringify(result)),
    completed_at: now }).execute();
  await options.faultInjector?.afterPhase?.('receipt');
  const consumed = await transaction.updateTable('sync_recovery_capabilities').set({ consumed_at: now })
    .where('capability_digest', '=', capabilityDigest).where('consumed_at', 'is', null)
    .returning('capability_digest').executeTakeFirst();
  if (!consumed) deny('stale_replica');
  await appendAuditEvent(transaction, { operationId: null, collectionId: null,
    principalId: null, eventType: 'sync.replica.snapshot_recovered', details: { replicaId: authority.replicaId,
      collectionId: authority.collectionId, snapshotId: snapshot.snapshot_id,
      oldLeaseGeneration: authority.generation.toString(), newLeaseGeneration: nextGeneration.toString(),
    }, createdAt: now });
  await options.faultInjector?.afterPhase?.('audit');
  return result;
}

interface ActivatedRecoveryPullCursor {
  readonly cursor: string; readonly cursorDigest: string; readonly tuple: SyncRecoveryBoundary;
  readonly upper: SyncRecoveryBoundary; readonly purgeBoundary: SyncRecoveryBoundary;
  readonly authority: Authority; readonly nextGeneration: bigint; readonly pageLimit: number;
  readonly cursorExpiresAt: Date; readonly proofExpiresAt: Date; readonly issuedAt: Date;
  readonly snapshotRevision: string;
}

async function activateRecoveryPullCursor(
  transaction: DatabaseTransaction,
  options: PostgresSyncRecoveryOptions,
  authority: Authority,
  snapshot: BootstrapSnapshotRow,
  purgeBoundary: SyncRecoveryBoundary,
  nextGeneration: bigint,
  now: Date,
): Promise<ActivatedRecoveryPullCursor | null> {
  if (!options.pullCursorKeyring || !snapshot.bootstrap_cursor.startsWith('spc2.')) return null;
  const pageLimit = snapshot.recovery_pull_page_limit;
  // recovery_pull_page_limit is nullable in the schema; an unset or non-positive page
  // limit must fail closed with the recovery_ack_pull_page_limit authority guard.
  if (pageLimit === null || pageLimit === undefined || pageLimit < 1 || !Number.isSafeInteger(pageLimit)) {
    deny('invalid_cursor_scope', 'recovery_ack_pull_page_limit');
  }
  const routeAuthority = buildSyncRouteAuthorityContext({ accountId: authority.accountId,
    collectionId: authority.collectionId, replicaId: authority.replicaId,
    sessionId: authority.sessionId, leaseGeneration: nextGeneration.toString(),
    lifecycleRevision: (authority.lifecycleRevision + 1n).toString(),
    policyRevision: authority.policyRevision, protocolVersion: authority.protocolVersion });
  const context: SyncPullCursorContext = syncPullCursorContext(routeAuthority, purgeBoundary, pageLimit);
  const verified = options.pullCursorKeyring.verify(snapshot.bootstrap_cursor, context);
  if (!verified.valid) deny(verified.code, 'recovery_ack_pull_cursor_verify');
  const tuple = await resolveRecoveryCursorAnchor(transaction, authority.collectionId,
    verified.anchor, purgeBoundary);
  const retention = options.recoveryProofRetentionMs ?? 2_592_000_000;
  return Object.freeze({ cursor: snapshot.bootstrap_cursor, cursorDigest: digest(snapshot.bootstrap_cursor),
    tuple, upper: tuple, purgeBoundary, authority, nextGeneration, pageLimit: pageLimit,
    cursorExpiresAt: new Date(verified.expiresAt),
    proofExpiresAt: new Date(Math.max(verified.expiresAt + 1, now.getTime() + retention)),
    issuedAt: now, snapshotRevision: snapshot.content_revision });
}

function cursorAnchorMatches(
  anchor: { readonly commitOrdinal: string; readonly streamKind: 'operation' | 'conflict'; readonly stableIdHash: string },
  tuple: SyncRecoveryBoundary,
): boolean {
  return anchor.commitOrdinal === tuple.commitOrdinal && anchor.streamKind === tuple.streamKind
    && anchor.stableIdHash === syncPullStableIdHash(tuple.stableId);
}

async function persistActivatedRecoveryCursor(
  transaction: DatabaseTransaction,
  input: ActivatedRecoveryPullCursor,
): Promise<void> {
  const streamKind = kindOrder(input.tuple.streamKind); const purgeKind = kindOrder(input.purgeBoundary.streamKind);
  await transaction.insertInto('sync_pull_cursor_evidence').values({ cursor: input.cursor,
    cursor_digest: input.cursorDigest, session_id: input.authority.sessionId,
    account_id: input.authority.accountId, collection_id: input.authority.collectionId,
    replica_id: input.authority.replicaId, lease_generation: input.nextGeneration,
    policy_revision: input.authority.policyRevision, protocol_version: input.authority.protocolVersion,
    tuple_commit_ordinal: BigInt(input.tuple.commitOrdinal), tuple_stream_kind: streamKind,
    tuple_stable_id: input.tuple.stableId, cursor_expires_at: input.cursorExpiresAt,
    upper_commit_ordinal: BigInt(input.upper.commitOrdinal), upper_stream_kind: kindOrder(input.upper.streamKind),
    upper_stable_id: input.upper.stableId, collection_revision: input.snapshotRevision,
    page_limit: input.pageLimit, purge_commit_ordinal: BigInt(input.purgeBoundary.commitOrdinal),
    purge_stream_kind: purgeKind, purge_stable_id: input.purgeBoundary.stableId }).execute();
  await transaction.insertInto('sync_pull_cursor_recovery_proofs').values({ cursor_digest: input.cursorDigest,
    authority_session_id: input.authority.sessionId,
    authority_lifecycle_revision: input.authority.lifecycleRevision + 1n,
    account_id: input.authority.accountId, collection_id: input.authority.collectionId,
    replica_id: input.authority.replicaId, lease_generation: input.nextGeneration,
    policy_revision: input.authority.policyRevision, protocol_version: input.authority.protocolVersion,
    page_limit: input.pageLimit, tuple_commit_ordinal: BigInt(input.tuple.commitOrdinal),
    tuple_stream_kind: streamKind, tuple_stable_id: input.tuple.stableId,
    upper_commit_ordinal: BigInt(input.upper.commitOrdinal), upper_stream_kind: kindOrder(input.upper.streamKind),
    upper_stable_id: input.upper.stableId, purge_commit_ordinal: BigInt(input.purgeBoundary.commitOrdinal),
    purge_stream_kind: purgeKind, purge_stable_id: input.purgeBoundary.stableId,
    cursor_expires_at: input.cursorExpiresAt, proof_expires_at: input.proofExpiresAt,
    issued_at: input.issuedAt, consumed_at: null }).execute();
}

interface Authority { sessionId: string; accountId: string; collectionId: string; replicaId: string; generation: bigint;
  lifecycleRevision: bigint; status: 'active' | 'expired' | 'recovery_required' | 'retired';
  protocolVersion: '0.1' | '0.2'; policyRevision: string }
async function loadAuthority(transaction: DatabaseTransaction, credential: VerifiedExtensionCredential,
  sessionId: string): Promise<Authority> {
  const session = await transaction.selectFrom('sync_sessions').selectAll().where('session_id', '=', sessionId)
    .forUpdate().executeTakeFirst(); if (!session) deny('resource_not_found');
  const account = await transaction.selectFrom('accounts').selectAll().where('id', '=', session.account_id)
    .forUpdate().executeTakeFirst();
  const storedCredential = await transaction.selectFrom('sync_extension_credentials').selectAll()
    .where('issuer', '=', credential.issuer).where('credential_id', '=', credential.credentialId)
    .forUpdate().executeTakeFirst();
  await lockCollectionReplicaGate(transaction, session.collection_id);
  const replica = await transaction.selectFrom('sync_replicas').selectAll().where('replica_id', '=', session.replica_id)
    .forUpdate().executeTakeFirst();
  const collection = await transaction.selectFrom('collections').select(['owner_subject_id', 'policy_revision', 'deleted_at'])
    .where('id', '=', session.collection_id).forUpdate().executeTakeFirst();
  const bootstrapScope = await transaction.selectFrom('sync_session_scopes').select('scope')
    .where('session_id', '=', sessionId).where('scope', '=', 'sync:bootstrap').executeTakeFirst();
  const binding = await transaction.selectFrom('sync_session_bindings').selectAll()
    .where('session_id', '=', sessionId).executeTakeFirst();
  const clock = await sql<{ now: Date }>`select current_timestamp as now`.execute(transaction);
  const nowValue = clock.rows[0]?.now;
  // current_timestamp always yields exactly one row; a missing row is an internal fault.
  if (!(nowValue instanceof Date)) deny('internal_error');
  const now = nowValue;
  const membership = account ? await transaction.selectFrom('collection_members').select('role')
    .where('collection_id', '=', session.collection_id).where('subject_id', '=', account.subject_id)
    .forUpdate().executeTakeFirst() : undefined;
  const role = collection?.owner_subject_id === account?.subject_id ? 'owner' : membership?.role;
  if (replica && session.status !== 'active'
      && BigInt(replica.lease_generation) > BigInt(session.lease_generation)) deny('stale_replica');
  if (!account || account.status !== 'active' || !storedCredential || storedCredential.revoked_at !== null
      || storedCredential.credential_digest !== credential.credentialDigest
      || storedCredential.subject !== credential.subject || storedCredential.account_id !== account.id
      || storedCredential.client_id !== credential.clientId
      || storedCredential.audience !== canonicalAudience(credential.audience)
      || !Array.isArray(storedCredential.scopes_json) || !storedCredential.scopes_json.includes('known.sync')
      || !credential.scopes.includes('known.sync')
      || BigInt(storedCredential.security_epoch) !== BigInt(account.security_epoch)
      || BigInt(session.account_security_epoch) !== BigInt(account.security_epoch)
      || credential.credentialExpiresAt <= now || credential.evidenceExpiresAt <= now
      || storedCredential.credential_expires_at <= now || storedCredential.evidence_expires_at <= now
      || session.credential_issuer !== credential.issuer || session.credential_id !== credential.credentialId
      || session.oauth_client_id !== credential.clientId
      || session.status !== 'active' || session.expires_at <= now || !replica || !collection
      || collection.deleted_at !== null || collection.policy_revision !== session.policy_revision
      || (role !== 'owner' && role !== 'editor' && role !== 'viewer') || !bootstrapScope
      || !binding || binding.account_id !== account.id || binding.collection_id !== session.collection_id
      || binding.replica_id !== replica.replica_id || binding.lease_generation !== replica.lease_generation
      || binding.lease_id !== replica.lease_id || binding.policy_revision !== collection.policy_revision
      || binding.binding_mode !== replica.binding_mode || binding.browser_profile_id !== replica.browser_profile_id
      || binding.browser_generation !== replica.browser_generation
      || (replica.status !== 'recovery_required'
        && BigInt(binding.lifecycle_revision) !== BigInt(replica.lifecycle_revision))
      || replica.account_id !== account.id || replica.collection_id !== session.collection_id
      || replica.lease_generation !== session.lease_generation) deny('resource_not_found');
  return { sessionId, accountId: account.id, collectionId: replica.collection_id, replicaId: replica.replica_id,
    generation: BigInt(replica.lease_generation), lifecycleRevision: BigInt(replica.lifecycle_revision),
    status: replica.status, protocolVersion: session.protocol_version,
    policyRevision: collection.policy_revision };
}

async function loadReplayScope(transaction: DatabaseTransaction, credential: VerifiedExtensionCredential,
  sessionId: string): Promise<{ readonly replicaId: string }> {
  const session = await transaction.selectFrom('sync_sessions').selectAll().where('session_id', '=', sessionId)
    .forUpdate().executeTakeFirst(); if (!session) deny('resource_not_found');
  const account = await transaction.selectFrom('accounts').selectAll().where('id', '=', session.account_id)
    .executeTakeFirst();
  const storedCredential = await transaction.selectFrom('sync_extension_credentials').selectAll()
    .where('issuer', '=', credential.issuer).where('credential_id', '=', credential.credentialId).executeTakeFirst();
  const collection = await transaction.selectFrom('collections').select(['owner_subject_id', 'policy_revision', 'deleted_at'])
    .where('id', '=', session.collection_id).executeTakeFirst();
  const membership = account ? await transaction.selectFrom('collection_members').select('role')
    .where('collection_id', '=', session.collection_id).where('subject_id', '=', account.subject_id)
    .executeTakeFirst() : undefined;
  const role = collection?.owner_subject_id === account?.subject_id ? 'owner' : membership?.role;
  const clock = await sql<{ now: Date }>`select current_timestamp as now`.execute(transaction);
  const nowValue = clock.rows[0]?.now;
  // current_timestamp always yields exactly one row; a missing row is an internal fault.
  if (!(nowValue instanceof Date)) deny('internal_error');
  const now = nowValue;
  if (!account || account.status !== 'active' || !storedCredential || storedCredential.revoked_at !== null
      || storedCredential.credential_digest !== credential.credentialDigest
      || storedCredential.subject !== credential.subject || storedCredential.account_id !== account.id
      || storedCredential.client_id !== credential.clientId
      || storedCredential.audience !== canonicalAudience(credential.audience)
      || !credential.scopes.includes('known.sync')
      || BigInt(storedCredential.security_epoch) !== BigInt(account.security_epoch)
      || BigInt(session.account_security_epoch) !== BigInt(account.security_epoch)
      || session.credential_issuer !== credential.issuer || session.credential_id !== credential.credentialId
      || session.oauth_client_id !== credential.clientId
      || !collection || collection.deleted_at !== null || collection.policy_revision !== session.policy_revision
      || (role !== 'owner' && role !== 'editor' && role !== 'viewer')
      || storedCredential.credential_expires_at <= now || storedCredential.evidence_expires_at <= now
      || credential.credentialExpiresAt <= now || credential.evidenceExpiresAt <= now) deny('resource_not_found');
  return Object.freeze({ replicaId: session.replica_id });
}

async function loadBoundary(transaction: DatabaseTransaction, collectionId: string): Promise<SyncRecoveryBoundary> {
  const row = await transaction.selectFrom('sync_collection_purge_state').selectAll()
    .where('collection_id', '=', collectionId).forUpdate().executeTakeFirst();
  return row ? Object.freeze({ commitOrdinal: BigInt(row.purged_through_commit_ordinal).toString(),
    streamKind: row.purged_through_stream_kind === 0 ? 'operation' as const : 'conflict' as const,
    stableId: row.purged_through_stable_id }) : Object.freeze({ commitOrdinal: '0',
    streamKind: 'operation' as const, stableId: '' });
}

async function loadCurrentSafeBoundary(transaction: DatabaseTransaction, collectionId: string,
  collectionOrdinal: bigint, snapshotId: string,
  purgeBoundary: SyncRecoveryBoundary): Promise<SyncRecoveryBoundary> {
  const upper = await readVisiblePullUpperKysely(transaction, collectionId);
  if (!upper) return Object.freeze({ commitOrdinal: collectionOrdinal.toString(),
    streamKind: 'operation' as const, stableId: collectionOrdinal === 0n ? '' : `snapshot:${snapshotId}` });
  return compareTuple(upper, purgeBoundary) > 0 ? upper : purgeBoundary;
}

async function resolveRecoveryCursorAnchor(
  transaction: DatabaseTransaction,
  collectionId: string,
  anchor: { readonly commitOrdinal: string; readonly streamKind: 'operation' | 'conflict';
    readonly stableIdHash: string },
  purgeBoundary: SyncRecoveryBoundary,
): Promise<SyncRecoveryBoundary> {
  if (cursorAnchorMatches(anchor, purgeBoundary)) return purgeBoundary;
  const rows = anchor.streamKind === 'operation'
    ? await transaction.selectFrom('operations').select('operation_id as stable_id')
      .where('collection_id', '=', collectionId).where('commit_ordinal', '=', BigInt(anchor.commitOrdinal))
      .where('sync_stream_kind', '=', kindOrder(anchor.streamKind)).where('sync_wire_present', '=', true).execute()
    : await selectConflictStreamAnchorIds(transaction, collectionId, BigInt(anchor.commitOrdinal));
  const matches = rows.filter((row) => syncPullStableIdHash(row.stable_id) === anchor.stableIdHash);
  if (matches.length !== 1) deny('invalid_cursor_scope', 'recovery_ack_pull_cursor_anchor');
  // The single-match guard above guarantees the first element exists.
  return Object.freeze({ commitOrdinal: anchor.commitOrdinal, streamKind: anchor.streamKind,
    stableId: matches[0]!.stable_id });
}

async function loadSnapshot(transaction: DatabaseTransaction, snapshotId: string,
  authority: Authority): Promise<BootstrapSnapshotRow> {
  const row = await sql<BootstrapSnapshotRow>`select * from sync_bootstrap_snapshots where snapshot_id=${snapshotId}
    and expires_at > current_timestamp`.execute(transaction);
  const snapshot = row.rows.find((candidate) => candidate.replica_id === authority.replicaId
    && candidate.session_id === authority.sessionId && candidate.account_id === authority.accountId
    && candidate.collection_id === authority.collectionId
    && BigInt(candidate.lease_generation) === authority.generation);
  if (!snapshot) deny('invalid_cursor_scope'); return snapshot;
}

async function completePages(transaction: DatabaseTransaction, snapshotId: string, nodeCount: number) {
  const pages = await transaction.selectFrom('sync_bootstrap_snapshot_pages').selectAll()
    .where('snapshot_id', '=', snapshotId).orderBy('page_sequence', 'asc').execute();
  let offset = 0;
  // The loop bound keeps index strictly below pages.length, so the element exists.
  for (let index = 0; index < pages.length; index += 1) { const page = pages[index]!;
    if (page.page_sequence !== index + 1 || page.page_start_offset !== offset
        || page.page_end_offset < offset || page.complete !== (page.page_end_offset === nodeCount)) deny('invalid_cursor_scope');
    offset = page.page_end_offset;
  }
  // The pages.length < 1 branch short-circuits before the at(-1) read is evaluated.
  if (pages.length < 1 || offset !== nodeCount || !pages.at(-1)!.complete) deny('invalid_cursor_scope');
  return pages;
}

function claimsFrom(authority: Authority, snapshot: BootstrapSnapshotRow, boundary: SyncRecoveryBoundary,
  pageCount: number): SyncRecoveryCapabilityClaims { return Object.freeze({ purpose: 'sync-recovery-bootstrap-ack',
  version: 1, sessionId: snapshot.session_id, accountId: authority.accountId,
  replicaId: authority.replicaId, collectionId: authority.collectionId,
  oldLeaseGeneration: authority.generation.toString(), purgeBoundary: boundary, snapshotId: snapshot.snapshot_id,
  snapshotRevision: snapshot.content_revision, snapshotPageCount: pageCount,
  snapshotNodeCount: snapshotNodeCount(snapshot.snapshot_json), snapshotCursor: snapshot.bootstrap_cursor }); }
function claimsFromRow(row: Selectable<SyncRecoveryCapabilityTable>): SyncRecoveryCapabilityClaims { return Object.freeze({
  purpose: 'sync-recovery-bootstrap-ack', version: 1, sessionId: row.session_id, accountId: row.account_id,
  replicaId: row.replica_id,
  collectionId: row.collection_id, oldLeaseGeneration: BigInt(row.old_lease_generation).toString(),
  purgeBoundary: { commitOrdinal: BigInt(row.purge_commit_ordinal).toString(),
    streamKind: row.purge_stream_kind === 0 ? 'operation' as const : 'conflict' as const,
    stableId: row.purge_stable_id },
  snapshotId: row.snapshot_id, snapshotRevision: row.snapshot_revision,
  snapshotPageCount: row.snapshot_page_count, snapshotNodeCount: row.snapshot_node_count,
  snapshotCursor: row.snapshot_cursor }); }
function snapshotNodeCount(value: unknown): number {
  if (value !== null && typeof value === 'object') {
    const document = value as { readonly nodes?: unknown; readonly nodeCount?: unknown };
    // FIX-M-014: v2 rows persist the count in the header; v1 rows keep `nodes` inline.
    if (typeof document.nodeCount === 'number' && Number.isSafeInteger(document.nodeCount)
        && document.nodeCount >= 0) {
      return document.nodeCount;
    }
    if (Array.isArray(document.nodes)) return document.nodes.length;
  }
  deny('internal_error');
}
function tupleOf(row: Pick<Selectable<SyncPullCursorEvidenceTable>, 'tuple_commit_ordinal'
  | 'tuple_stream_kind' | 'tuple_stable_id'>): SyncRecoveryBoundary {
  return { commitOrdinal: BigInt(row.tuple_commit_ordinal).toString(),
  streamKind: row.tuple_stream_kind === 0 ? 'operation' : 'conflict', stableId: row.tuple_stable_id }; }
function compareTuple(left: SyncRecoveryBoundary, right: SyncRecoveryBoundary): number {
  const lo = BigInt(left.commitOrdinal); const ro = BigInt(right.commitOrdinal); if (lo !== ro) return lo < ro ? -1 : 1;
  const lk = kindOrder(left.streamKind); const rk = kindOrder(right.streamKind); if (lk !== rk) return lk < rk ? -1 : 1;
  return left.stableId < right.stableId ? -1 : left.stableId > right.stableId ? 1 : 0;
}
function kindOrder(kind: SyncRecoveryBoundary['streamKind']): number { return kind === 'operation' ? 0 : 1; }
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function canonicalAudience(audience: string | readonly string[]): string {
  return typeof audience === 'string' ? audience : [...audience].sort().join(' ');
}
function assertOptions(options: PostgresSyncRecoveryOptions): void { if (!options.capabilityKeys
  || !Number.isSafeInteger(options.leaseExtensionSeconds) || options.leaseExtensionSeconds < 1
  || !Number.isSafeInteger(options.maxLeaseLifetimeSeconds)
  || options.maxLeaseLifetimeSeconds < options.leaseExtensionSeconds
  || (options.pullCursorKeyring !== undefined && options.pullCursorKeyring.destroyed)
  || (options.pullCursorKeyring !== undefined
    && (!Number.isSafeInteger(options.recoveryProofRetentionMs)
      || (options.recoveryProofRetentionMs ?? 0) < 1_000))) throw new TypeError('Invalid recovery options.'); }
function isExpectedAuthorityConstraint(error: unknown): boolean {
  if (error instanceof DatabaseOperationError) {
    if (error.kind === 'unique_violation' || error.kind === 'serialization_failure') return true;
    if (error.kind !== 'database_failure') return false;
    error = error.cause;
  }
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return ['23502', '23503', '23505', '23514', '23P01', '40001'].includes(String(error.code));
}
function deny(code: ConstructorParameters<typeof SyncAckError>[0], authorityGuard?: string): never {
  throw Object.assign(new SyncAckError(code), authorityGuard ? { authorityGuard } : {});
}
