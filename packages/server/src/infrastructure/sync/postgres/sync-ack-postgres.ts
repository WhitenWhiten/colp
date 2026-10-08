import { createHash } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { SyncAckResult } from '@know-n/colp/types';
import {
  canonicalSyncAckDigest,
  SyncAckError,
  validateSyncAckInput,
  validateVerifiedExtensionCredential,
  type SyncAckApplication,
  type SyncAckApplicationInput,
} from '../../../modules/sync/index.js';
import type { DatabaseSchema, SyncPullCursorEvidenceTable } from '../../database/runtime.js';
import { appendAuditEvent } from '../../database/audit-event-payload.js';
import { DatabaseOperationError } from '../../database/errors.js';
import { withTransactionRetry } from '../../database/transaction-retry.js';
import { createUnitOfWork, type DatabaseTransaction } from '../../database/unit-of-work.js';

export type PostgresSyncAckFaultPhase = 'evidence_verified' | 'checkpoint_updated' | 'before_receipt';
export interface PostgresSyncAckOptions {
  readonly leaseExtensionSeconds: number;
  readonly maxLeaseLifetimeSeconds: number;
  readonly faultInjector?: {
    afterEvidenceVerified?(cursor: string): void | Promise<void>;
    afterCheckpointUpdated?(): void | Promise<void>;
    beforeReceipt?(): void | Promise<void>;
  };
}

const validators = createValidatorRegistry();

export function createPostgresSyncAckApplication(
  db: Kysely<DatabaseSchema>, options: PostgresSyncAckOptions,
): SyncAckApplication {
  assertOptions(options);
  return Object.freeze({
    async acknowledge(rawInput: SyncAckApplicationInput) {
      const input = validateSyncAckInput(rawInput);
      validateVerifiedExtensionCredential(input.credential);
      try {
        // The entire Ack attempt is database-only and receipt-idempotent. Retry
        // only a proven rollback; unknown commit outcomes remain caller-visible.
        return await withTransactionRetry(() => createUnitOfWork(db).execute(({ transaction }) => acknowledgeInTransaction(
          transaction, input, options,
        )));
      } catch (error) {
        if (error instanceof SyncAckError || error instanceof DatabaseOperationError) {
          // A denied Ack for a Replica that never established a baseline (its checkpoint is
          // still null) can never succeed on retry: the evidence it names was minted under the
          // authority this denial just repudiated. Migrate that Replica to recovery_required in
          // a separate committed transaction so the next Session issues recovery authority
          // (Snapshot capability + recovery Ack path) instead of re-serving a plain bootstrap
          // Snapshot the client is required to refuse. Replicas with a checkpoint keep the
          // existing Session-refresh exit, and a lost CAS race simply defers to the next denial.
          //
          // The client rejects the Ack intent on FOUR codes
          // (durable-sync-engine.ts `invalidatedIntent`): stale_replica, sync_cursor_expired,
          // resource_not_found and invalid_cursor_scope. Every one of them leaves the client
          // needing fresh recovery authority, so every one of them needs this migration or the
          // deadlock is only half closed — `invalid_cursor_scope` is the reachable one, because
          // a cursor whose evidence row has been pruned by retention and a cursor minted for
          // another scope are both reported as "no usable evidence". `resource_not_found` is
          // deliberately absent: its denials are about the Session, credential, account or
          // Collection being invalid/absent, and the Session path rejects on exactly those
          // before the Replica branch is consulted, so migrating the Replica there would
          // relabel an authentication problem as a Replica-lifecycle one without unblocking
          // anything.
          if (error instanceof SyncAckError
              && (error.code === 'stale_replica' || error.code === 'sync_cursor_expired'
                || error.code === 'invalid_cursor_scope')) {
            await migrateBaselineLessReplicaToRecovery(db, input, error.code)
              .catch(() => { /* the denial stays authoritative; the next denial retries. */ });
          }
          throw error;
        }
        throw new SyncAckError('internal_error');
      }
    },
  });
}

async function migrateBaselineLessReplicaToRecovery(
  db: Kysely<DatabaseSchema>, input: SyncAckApplicationInput,
  code: 'stale_replica' | 'sync_cursor_expired' | 'invalid_cursor_scope',
): Promise<void> {
  await createUnitOfWork(db).execute(async ({ transaction }) => {
    const session = await transaction.selectFrom('sync_sessions').select(['replica_id', 'collection_id'])
      .where('session_id', '=', input.request.sessionId).executeTakeFirst();
    if (!session) return;
    const replica = await transaction.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', session.replica_id).forUpdate().executeTakeFirst();
    if (!replica || replica.checkpoint_commit_ordinal !== null
        || (replica.status !== 'active' && replica.status !== 'expired')) return;
    const nextRevision = BigInt(replica.lifecycle_revision) + 1n;
    const updated = await transaction.updateTable('sync_replicas').set({
      status: 'recovery_required', lifecycle_revision: nextRevision,
      wire_json: sql<Record<string, unknown>>`jsonb_set(wire_json, '{status}', '"recovery_required"'::jsonb, true)`,
    }).where('replica_id', '=', replica.replica_id)
      .where('lease_generation', '=', replica.lease_generation)
      .where('lifecycle_revision', '=', replica.lifecycle_revision)
      .where('status', 'in', ['active', 'expired'])
      .where('checkpoint_commit_ordinal', 'is', null)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return;
    await appendAuditEvent(transaction, { operationId: null, collectionId: null, principalId: null,
      eventType: 'sync.replica.lifecycle.recovery_required', details: {
        replicaId: replica.replica_id, collectionId: session.collection_id,
        leaseGeneration: BigInt(replica.lease_generation).toString(),
        lifecycleRevision: nextRevision.toString(), reason: 'baseline_less_ack_denied', code,
      } });
  });
}

async function acknowledgeInTransaction(
  transaction: DatabaseTransaction,
  input: SyncAckApplicationInput,
  options: PostgresSyncAckOptions,
): Promise<SyncAckResult> {
  const preliminary = await loadAuthority(transaction, input, false);
  const cursorDigest = createHash('sha256').update(input.request.cursor, 'utf8').digest('hex');
  const requestDigest = canonicalSyncAckDigest(input);
  const earlyReceipt = await transaction.selectFrom('sync_ack_receipts').selectAll()
    .where('principal_id', '=', preliminary.accountId).where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (earlyReceipt) {
    const replayAuthority = await loadAuthority(transaction, input, true);
    return replayReceipt(earlyReceipt, requestDigest, cursorDigest, input, replayAuthority);
  }
  const preliminaryEvidence = await transaction.selectFrom('sync_pull_cursor_evidence').selectAll()
    .where('replica_id', '=', preliminary.replicaId).where('cursor_digest', '=', cursorDigest)
    .executeTakeFirst();
  if (!preliminaryEvidence || preliminaryEvidence.cursor !== input.request.cursor) deny('invalid_cursor_scope');
  await options.faultInjector?.afterEvidenceVerified?.(input.request.cursor);

  const authority = await loadAuthority(transaction, input, true);
  const replica = await transaction.selectFrom('sync_replicas').selectAll()
    .where('replica_id', '=', authority.replicaId).executeTakeFirst();
  if (!replica) deny('resource_not_found');
  const now = await databaseNow(transaction);
  const receipt = await transaction.selectFrom('sync_ack_receipts').selectAll()
    .where('principal_id', '=', authority.accountId).where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (receipt) return replayReceipt(receipt, requestDigest, cursorDigest, input, authority);

  const evidence = await transaction.selectFrom('sync_pull_cursor_evidence').selectAll()
    .where('replica_id', '=', authority.replicaId).where('cursor_digest', '=', cursorDigest).executeTakeFirst();
  assertEvidence(evidence, input, authority, preliminaryEvidence, now);
  const checkpoint = replicaTuple(replica);
  const candidate = evidenceTuple(evidence);
  const tupleComparison = checkpoint ? compareTuple(candidate, checkpoint) : 1;
  const cursorRebindProofId = tupleComparison === 0
    ? await cursorCheckpointRebindProof(transaction, authority, replica, evidence) : null;
  const cursorRebind = cursorRebindProofId !== null;
  if (checkpoint && (tupleComparison < 0 || tupleComparison === 0 && !cursorRebind)) deny('stale_replica');

  const generation = await transaction.selectFrom('sync_replica_generations').select('issued_at')
    .where('replica_id', '=', authority.replicaId).where('lease_generation', '=', authority.leaseGeneration)
    .executeTakeFirst();
  if (!generation) deny('internal_error');
  const absoluteLeaseLimit = new Date(generation.issued_at.getTime() + options.maxLeaseLifetimeSeconds * 1_000);
  const requestedLease = new Date(now.getTime() + options.leaseExtensionSeconds * 1_000);
  const boundedRenewal = new Date(Math.min(requestedLease.getTime(), absoluteLeaseLimit.getTime()));
  const leaseExpiresAt = new Date(Math.max(replica.lease_expires_at.getTime(), boundedRenewal.getTime()));
  const updated = await transaction.updateTable('sync_replicas').set({
    checkpoint_cursor: input.request.cursor,
    checkpoint_commit_ordinal: evidence.tuple_commit_ordinal,
    checkpoint_stream_kind: evidence.tuple_stream_kind,
    checkpoint_stable_id: evidence.tuple_stable_id,
    last_seen_at: now,
    lease_expires_at: leaseExpiresAt,
    wire_json: sql<Record<string, unknown>>`jsonb_set(
      wire_json,
      '{checkpoint}',
      jsonb_build_object(
        'acknowledgedCursor', ${input.request.cursor}::text,
        'acknowledgedCommitOrdinal', ${evidence.tuple_commit_ordinal.toString()}::text
      ),
      true
    )`,
  }).where('replica_id', '=', authority.replicaId)
    .where('lease_generation', '=', authority.leaseGeneration)
    .where((builder) => builder.or([
      builder('checkpoint_commit_ordinal', 'is', null),
      sql<boolean>`(checkpoint_commit_ordinal, checkpoint_stream_kind, checkpoint_stable_id COLLATE "C")
        < (${evidence.tuple_commit_ordinal}, ${evidence.tuple_stream_kind},
          ${evidence.tuple_stable_id}::text COLLATE "C")`,
      ...(cursorRebind ? [builder.and([
        // The rebind branch runs only when cursorCheckpointRebindProof returned a proof, which requires a non-null checkpoint cursor.
        builder('checkpoint_cursor', '=', replica.checkpoint_cursor!),
        sql<boolean>`(checkpoint_commit_ordinal, checkpoint_stream_kind, checkpoint_stable_id COLLATE "C")
          = (${evidence.tuple_commit_ordinal}, ${evidence.tuple_stream_kind},
            ${evidence.tuple_stable_id}::text COLLATE "C")`,
      ])] : []),
    ])).executeTakeFirst();
  if (updated.numUpdatedRows !== 1n) deny('stale_replica');
  if (cursorRebindProofId !== null) {
    const consumed = await transaction.updateTable('sync_pull_cursor_recovery_proofs').set({ consumed_at: now })
      .where('proof_id', '=', cursorRebindProofId).where('consumed_at', 'is', null)
      .returning('proof_id').executeTakeFirst();
    if (!consumed) deny('stale_replica');
  }
  await options.faultInjector?.afterCheckpointUpdated?.();

  const result: SyncAckResult = Object.freeze({ replicaId: authority.replicaId,
    ackedCursor: input.request.cursor, ackedAt: now.toISOString() });
  if (!validators.validate('syncAckResult', result).valid) deny('internal_error');
  await appendAuditEvent(transaction, { operationId: null, collectionId: null,
    principalId: authority.accountId, eventType: 'sync.replica.acknowledged', details: {
      replicaId: authority.replicaId, collectionId: authority.collectionId,
      leaseGeneration: authority.leaseGeneration.toString(),
      commitOrdinal: evidence.tuple_commit_ordinal.toString(), streamKind: evidence.tuple_stream_kind,
    }, createdAt: now });
  await options.faultInjector?.beforeReceipt?.();
  await transaction.insertInto('sync_ack_receipts').values({ principal_id: authority.accountId,
    idempotency_key: input.idempotencyKey, request_digest: requestDigest, session_id: authority.sessionId,
    collection_id: authority.collectionId, replica_id: authority.replicaId,
    lease_generation: authority.leaseGeneration, cursor_digest: cursorDigest,
    result_json: result as unknown as Record<string, unknown>, result_digest: digestResult(result),
    claimed_at: now, completed_at: now }).execute();
  return result;
}

function replayReceipt(receipt: Selectable<DatabaseSchema['sync_ack_receipts']>, requestDigest: string,
  cursorDigest: string, input: SyncAckApplicationInput, authority: AckAuthority): SyncAckResult {
  if (receipt.request_digest !== requestDigest || receipt.session_id !== authority.sessionId
      || receipt.replica_id !== authority.replicaId || receipt.collection_id !== authority.collectionId
      || BigInt(receipt.lease_generation) !== authority.leaseGeneration || receipt.cursor_digest !== cursorDigest) {
    deny('idempotency_key_reused');
  }
  const replay = receipt.result_json as unknown as SyncAckResult;
  if (!validators.validate('syncAckResult', replay).valid || receipt.result_digest !== digestResult(replay)
      || replay.replicaId !== authority.replicaId || replay.ackedCursor !== input.request.cursor) deny('internal_error');
  return Object.freeze(replay);
}

interface AckAuthority {
  readonly accountId: string; readonly sessionId: string; readonly collectionId: string;
  readonly replicaId: string; readonly leaseGeneration: bigint; readonly lifecycleRevision: bigint;
  readonly policyRevision: string;
  readonly protocolVersion: '0.1' | '0.2';
}

async function loadAuthority(transaction: DatabaseTransaction, input: SyncAckApplicationInput,
  lock: boolean): Promise<AckAuthority> {
  const now = await databaseNow(transaction);
  let sessionQuery = transaction.selectFrom('sync_sessions').selectAll()
    .where('session_id', '=', input.request.sessionId);
  if (lock) sessionQuery = sessionQuery.forUpdate();
  const session = await sessionQuery.executeTakeFirst();
  if (!session) deny('resource_not_found');
  let accountQuery = transaction.selectFrom('accounts').selectAll().where('id', '=', session.account_id);
  let credentialQuery = transaction.selectFrom('sync_extension_credentials').selectAll()
    .where('issuer', '=', input.credential.issuer).where('credential_id', '=', input.credential.credentialId);
  let replicaQuery = transaction.selectFrom('sync_replicas').selectAll()
    .where('replica_id', '=', session.replica_id);
  let collectionQuery = transaction.selectFrom('collections').select(['owner_subject_id', 'policy_revision', 'deleted_at'])
    .where('id', '=', session.collection_id);
  if (lock) { accountQuery = accountQuery.forUpdate(); credentialQuery = credentialQuery.forUpdate();
    // T-10 lock order (ADR-0027): sync_replicas precedes collections.
    replicaQuery = replicaQuery.forUpdate(); collectionQuery = collectionQuery.forUpdate(); }
  const account = await accountQuery.executeTakeFirst();
  const credential = await credentialQuery.executeTakeFirst();
  const replica = await replicaQuery.executeTakeFirst();
  const collection = await collectionQuery.executeTakeFirst();
  let bindingQuery = transaction.selectFrom('sync_session_bindings').selectAll()
    .where('session_id', '=', session.session_id);
  let pullScopeQuery = transaction.selectFrom('sync_session_scopes').select('scope')
    .where('session_id', '=', session.session_id).where('scope', '=', 'sync:pull');
  if (lock) { bindingQuery = bindingQuery.forUpdate(); pullScopeQuery = pullScopeQuery.forUpdate(); }
  const binding = await bindingQuery.executeTakeFirst();
  const pullScope = await pullScopeQuery.executeTakeFirst();
  let role: 'owner' | 'editor' | 'viewer' | undefined;
  if (account && collection?.owner_subject_id === account.subject_id) role = 'owner';
  if (account && !role) {
    let membershipQuery = transaction.selectFrom('collection_members').select('role')
      .where('collection_id', '=', session.collection_id).where('subject_id', '=', account.subject_id);
    if (lock) membershipQuery = membershipQuery.forUpdate();
    role = (await membershipQuery.executeTakeFirst())?.role;
  }
  const authorized = !!account && account.status === 'active'
    && BigInt(account.security_epoch) === BigInt(session.account_security_epoch)
    && !!credential && credential.revoked_at === null
    && credential.credential_digest === input.credential.credentialDigest
    && credential.subject === input.credential.subject && credential.account_id === account.id
    && credential.client_id === input.credential.clientId
    && credential.audience === canonicalAudience(input.credential.audience)
    && input.credential.scopes.includes('known.sync')
    && Array.isArray(credential.scopes_json) && credential.scopes_json.includes('known.sync')
    && BigInt(credential.security_epoch) === BigInt(account.security_epoch)
    && credential.credential_expires_at > now && input.credential.credentialExpiresAt > now
    && input.credential.evidenceExpiresAt > now
    && session.credential_issuer === input.credential.issuer
    && session.credential_id === input.credential.credentialId
    && session.oauth_client_id === input.credential.clientId
    && session.principal_subject_id === account.subject_id
    && session.origin === input.origin
    && session.status === 'active' && session.expires_at > now
    && !!collection && collection.deleted_at === null && collection.policy_revision === session.policy_revision
    && (role === 'owner' || role === 'editor' || role === 'viewer') && !!pullScope
    && !!replica && replica.account_id === account.id && replica.collection_id === session.collection_id
    && replica.capabilities_json.read === true
    && BigInt(replica.lease_generation) === BigInt(session.lease_generation)
    && replica.lease_id === session.lease_id
    && !!binding && binding.account_id === account.id && binding.collection_id === session.collection_id
    && binding.replica_id === session.replica_id && binding.policy_revision === collection.policy_revision
    && BigInt(binding.lease_generation) === BigInt(replica.lease_generation)
    && binding.lease_id === replica.lease_id && binding.binding_mode === replica.binding_mode
    && binding.browser_profile_id === replica.browser_profile_id
    && binding.browser_generation === replica.browser_generation;
  if (!authorized) deny('resource_not_found');
  if (replica.status === 'retired') deny('replica_retired');
  if (replica.status !== 'active' || replica.lease_expires_at <= now) deny('stale_replica');
  if (BigInt(replica.lifecycle_revision) !== BigInt(session.lifecycle_revision)
      || BigInt(binding.lifecycle_revision) !== BigInt(replica.lifecycle_revision)) deny('stale_replica');
  return { accountId: account.id, sessionId: session.session_id, collectionId: session.collection_id,
    replicaId: session.replica_id, leaseGeneration: BigInt(session.lease_generation),
    lifecycleRevision: BigInt(session.lifecycle_revision), policyRevision: session.policy_revision,
    protocolVersion: session.protocol_version };
}

async function cursorCheckpointRebindProof(
  transaction: DatabaseTransaction,
  authority: AckAuthority,
  replica: Selectable<DatabaseSchema['sync_replicas']>,
  candidate: Selectable<SyncPullCursorEvidenceTable>,
): Promise<bigint | null> {
  if (replica.checkpoint_cursor === null || candidate.cursor === null
      || replica.checkpoint_cursor === candidate.cursor) return null;
  const checkpointDigest = createHash('sha256').update(replica.checkpoint_cursor, 'utf8').digest('hex');
  const checkpointEvidence = await transaction.selectFrom('sync_pull_cursor_evidence').selectAll()
    .where('replica_id', '=', authority.replicaId).where('cursor_digest', '=', checkpointDigest)
    .executeTakeFirst();
  if (!checkpointEvidence || checkpointEvidence.cursor !== replica.checkpoint_cursor) return null;
  const checkpointProof = await transaction.selectFrom('sync_pull_cursor_recovery_proofs').selectAll()
    .where('replica_id', '=', authority.replicaId).where('cursor_digest', '=', checkpointDigest)
    .where('consumed_at', 'is', null).executeTakeFirst();
  const candidateProof = await transaction.selectFrom('sync_pull_cursor_recovery_proofs').selectAll()
    .where('replica_id', '=', authority.replicaId).where('cursor_digest', '=', candidate.cursor_digest)
    .where('consumed_at', 'is', null).executeTakeFirst();
  if (!checkpointProof || !candidateProof
      || checkpointProof.authority_session_id !== checkpointEvidence.session_id
      || candidateProof.authority_session_id !== authority.sessionId
      || BigInt(checkpointProof.authority_lifecycle_revision) > authority.lifecycleRevision
      || BigInt(candidateProof.authority_lifecycle_revision) !== authority.lifecycleRevision) return null;
  const sessionChanged = checkpointEvidence.session_id !== authority.sessionId;
  const purgeComparison = compareTuple(purgeTuple(checkpointEvidence), purgeTuple(candidate));
  const permitted = sameCursorHandoffCoreFacts(checkpointEvidence, candidate)
    && sameCursorHandoffCoreFacts(checkpointProof, candidateProof)
    && sameCursorHandoffFacts(checkpointEvidence, checkpointProof)
    && sameCursorHandoffFacts(candidate, candidateProof)
    && purgeComparison <= 0 && (sessionChanged || purgeComparison < 0)
    && compareTuple(purgeTuple(candidate), evidenceTuple(candidate)) <= 0
    && checkpointProof.account_id === authority.accountId
    && checkpointProof.collection_id === authority.collectionId
    && BigInt(checkpointProof.lease_generation) === authority.leaseGeneration
    && checkpointProof.policy_revision === authority.policyRevision
    && checkpointProof.protocol_version === authority.protocolVersion
    && candidateProof.account_id === authority.accountId
    && candidateProof.collection_id === authority.collectionId
    && BigInt(candidateProof.lease_generation) === authority.leaseGeneration
    && candidateProof.policy_revision === authority.policyRevision
    && candidateProof.protocol_version === authority.protocolVersion
    && checkpointProof.cursor_expires_at.getTime() === checkpointEvidence.cursor_expires_at.getTime()
    && candidateProof.cursor_expires_at.getTime() === candidate.cursor_expires_at.getTime();
  return permitted ? BigInt(checkpointProof.proof_id) : null;
}

function sameCursorHandoffCoreFacts(left: {
  readonly page_limit: number; readonly tuple_commit_ordinal: bigint; readonly tuple_stream_kind: number;
  readonly tuple_stable_id: string; readonly upper_commit_ordinal: bigint; readonly upper_stream_kind: number;
  readonly upper_stable_id: string;
}, right: {
  readonly page_limit: number; readonly tuple_commit_ordinal: bigint; readonly tuple_stream_kind: number;
  readonly tuple_stable_id: string; readonly upper_commit_ordinal: bigint; readonly upper_stream_kind: number;
  readonly upper_stable_id: string;
}): boolean {
  return left.page_limit === right.page_limit
    && BigInt(left.tuple_commit_ordinal) === BigInt(right.tuple_commit_ordinal)
    && left.tuple_stream_kind === right.tuple_stream_kind && left.tuple_stable_id === right.tuple_stable_id
    && BigInt(left.upper_commit_ordinal) === BigInt(right.upper_commit_ordinal)
    && left.upper_stream_kind === right.upper_stream_kind && left.upper_stable_id === right.upper_stable_id;
}

function sameCursorHandoffFacts(left: {
  readonly page_limit: number; readonly tuple_commit_ordinal: bigint; readonly tuple_stream_kind: number;
  readonly tuple_stable_id: string; readonly upper_commit_ordinal: bigint; readonly upper_stream_kind: number;
  readonly upper_stable_id: string; readonly purge_commit_ordinal: bigint; readonly purge_stream_kind: number;
  readonly purge_stable_id: string;
}, right: {
  readonly page_limit: number; readonly tuple_commit_ordinal: bigint; readonly tuple_stream_kind: number;
  readonly tuple_stable_id: string; readonly upper_commit_ordinal: bigint; readonly upper_stream_kind: number;
  readonly upper_stable_id: string; readonly purge_commit_ordinal: bigint; readonly purge_stream_kind: number;
  readonly purge_stable_id: string;
}): boolean {
  return left.page_limit === right.page_limit
    && BigInt(left.tuple_commit_ordinal) === BigInt(right.tuple_commit_ordinal)
    && left.tuple_stream_kind === right.tuple_stream_kind && left.tuple_stable_id === right.tuple_stable_id
    && BigInt(left.upper_commit_ordinal) === BigInt(right.upper_commit_ordinal)
    && left.upper_stream_kind === right.upper_stream_kind && left.upper_stable_id === right.upper_stable_id
    && BigInt(left.purge_commit_ordinal) === BigInt(right.purge_commit_ordinal)
    && left.purge_stream_kind === right.purge_stream_kind && left.purge_stable_id === right.purge_stable_id;
}

function assertEvidence(evidence: Selectable<SyncPullCursorEvidenceTable> | undefined, input: SyncAckApplicationInput,
  authority: AckAuthority, preliminary: Selectable<SyncPullCursorEvidenceTable>, now: Date):
  asserts evidence is Selectable<SyncPullCursorEvidenceTable> {
  if (!evidence || evidence.evidence_id !== preliminary.evidence_id || evidence.cursor !== input.request.cursor
      || evidence.session_id !== authority.sessionId || evidence.collection_id !== authority.collectionId
      || evidence.replica_id !== authority.replicaId
      || BigInt(evidence.lease_generation) !== authority.leaseGeneration
      || evidence.policy_revision !== authority.policyRevision
      || evidence.protocol_version !== authority.protocolVersion) {
    deny('invalid_cursor_scope');
  }
  if (evidence.cursor_expires_at <= now) deny('sync_cursor_expired');
}

function evidenceTuple(evidence: Selectable<SyncPullCursorEvidenceTable>) {
  return { ordinal: BigInt(evidence.tuple_commit_ordinal), kind: evidence.tuple_stream_kind,
    id: evidence.tuple_stable_id };
}
function purgeTuple(evidence: { readonly purge_commit_ordinal: bigint; readonly purge_stream_kind: number;
  readonly purge_stable_id: string }) {
  return { ordinal: BigInt(evidence.purge_commit_ordinal), kind: evidence.purge_stream_kind,
    id: evidence.purge_stable_id };
}
function replicaTuple(replica: { checkpoint_commit_ordinal: bigint | null; checkpoint_stream_kind: number | null;
  checkpoint_stable_id: string | null }) {
  return replica.checkpoint_commit_ordinal === null ? null : { ordinal: BigInt(replica.checkpoint_commit_ordinal),
    // The checkpoint columns are persisted as one group, so a non-null ordinal implies the sibling columns are set.
    kind: replica.checkpoint_stream_kind!, id: replica.checkpoint_stable_id! };
}
function compareTuple(left: { ordinal: bigint; kind: number; id: string }, right: { ordinal: bigint; kind: number; id: string }) {
  return left.ordinal < right.ordinal ? -1 : left.ordinal > right.ordinal ? 1
    : left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
function digestResult(result: SyncAckResult) {
  const canonical = `{${Object.entries(result).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
async function databaseNow(transaction: DatabaseTransaction): Promise<Date> {
  const result = await sql<{ now: Date }>`select current_timestamp as now`.execute(transaction);
  const now = result.rows[0]?.now; if (!(now instanceof Date)) deny('internal_error'); return now;
}
function canonicalAudience(audience: string | readonly string[]) {
  return typeof audience === 'string' ? audience : [...audience].sort().join(' ');
}
function assertOptions(options: PostgresSyncAckOptions): void {
  if (!options || !Number.isSafeInteger(options.leaseExtensionSeconds) || options.leaseExtensionSeconds < 1
      || !Number.isSafeInteger(options.maxLeaseLifetimeSeconds) || options.maxLeaseLifetimeSeconds < 1
      || options.leaseExtensionSeconds > options.maxLeaseLifetimeSeconds) deny('internal_error');
}
function deny(code: SyncAckError['code']): never { throw new SyncAckError(code); }
