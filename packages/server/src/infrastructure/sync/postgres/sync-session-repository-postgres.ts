import { createHash } from 'node:crypto';
import {
  type ActiveSyncSessionRecord,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
} from '@know-n/colp/sync';
import { sql, type Selectable } from 'kysely';
import type { VerifiedExtensionCredential } from '../../../modules/identity/index.js';
import {
  buildSyncRouteAuthorityContext,
  SYNC_PULL_STREAM_KIND_ORDER,
  SyncSessionIssueError,
  syncPullCursorContext,
  validateProtocolSafeReplicaId,
  type SyncPullTuple,
  type SyncSessionIssueInput,
} from '../../../modules/sync/index.js';
import type {
  SyncExtensionCredentialTable,
  SyncReplicaTable,
  SyncSessionTable,
} from '../../database/runtime.js';
import { appendAuditEvent } from '../../database/audit-event-payload.js';
import { lockCollectionReplicaGate } from '../../database/lock-order.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';
import type { ReplicaRetentionTuple } from '../replica-lifecycle-postgres.js';
import {
  canonicalAudience,
  formatInstant,
} from './sync-session-admission-postgres.js';
import type {
  Authority,
  SessionAuthority,
  SyncAuthorizationScope,
  ValidatedOptions,
} from './sync-session-types-postgres.js';
import { isJoseSyncCredentialRevoked } from './sync-jose-credential-revocation-postgres.js';

export function sameBinding(row: Selectable<SyncReplicaTable>, input: SyncSessionIssueInput): boolean {
  return row.binding_mode === input.binding.mountMode
    && row.browser_profile_id === input.binding.browserProfileId
    && row.browser_generation === input.binding.browserGeneration;
}

export function assertReplicaWire(row: Selectable<SyncReplicaTable>): void {
  const wire = row.wire_json;
  const binding = wire.binding;
  const checkpoint = wire.checkpoint;
  if (wire.replicaId !== row.replica_id || wire.accountId !== row.account_id
      || wire.collectionId !== row.collection_id || wire.leaseId !== row.lease_id
      || wire.leaseGeneration !== BigInt(row.lease_generation).toString()
      || wire.status !== row.status || typeof binding !== 'object' || binding === null
      || (binding as Record<string, unknown>).mountMode !== row.binding_mode
      || (binding as Record<string, unknown>).browserProfileId !== row.browser_profile_id
      || (binding as Record<string, unknown>).browserGeneration !== row.browser_generation
      || typeof checkpoint !== 'object' || checkpoint === null
      || (checkpoint as Record<string, unknown>).acknowledgedCursor !== row.checkpoint_cursor
      || (checkpoint as Record<string, unknown>).acknowledgedCommitOrdinal
        !== (row.checkpoint_commit_ordinal === null
          ? null : BigInt(row.checkpoint_commit_ordinal).toString())) {
    throw new SyncSessionIssueError('integrity_failure');
  }
}

export async function bindCredential(
  transaction: DatabaseTransaction,
  credential: VerifiedExtensionCredential,
  accountId: string,
  securityEpoch: bigint,
  now: Date,
): Promise<Selectable<SyncExtensionCredentialTable>> {
  if (credential.credentialIssuedAt.getTime() >= credential.credentialExpiresAt.getTime()
      || credential.verifiedAt.getTime() > credential.evidenceExpiresAt.getTime()
      || credential.credentialExpiresAt.getTime() <= now.getTime()
      || credential.evidenceExpiresAt.getTime() <= now.getTime()
      || credential.verifiedAt.getTime() > now.getTime() + 60_000) {
    throw new SyncSessionIssueError('credential_invalid');
  }
  await transaction.insertInto('sync_extension_credentials').values({
    issuer: credential.issuer,
    credential_id: credential.credentialId,
    credential_digest: credential.credentialDigest,
    subject: credential.subject,
    account_id: accountId,
    client_id: credential.clientId,
    audience: canonicalAudience(credential.audience),
    scopes_json: sql`${JSON.stringify([...credential.scopes])}::jsonb`,
    credential_issued_at: credential.credentialIssuedAt,
    credential_expires_at: credential.credentialExpiresAt,
    evidence_expires_at: credential.evidenceExpiresAt,
    security_epoch: securityEpoch,
    revoked_at: null,
    first_seen_at: now,
    last_verified_at: credential.verifiedAt,
  }).onConflict((conflict) => conflict.columns(['issuer', 'credential_id']).doNothing()).execute();

  const stored = await transaction.selectFrom('sync_extension_credentials').selectAll()
    .where('issuer', '=', credential.issuer)
    .where('credential_id', '=', credential.credentialId)
    .forUpdate().executeTakeFirst();
  if (!stored || stored.credential_digest !== credential.credentialDigest
      || stored.subject !== credential.subject || stored.account_id !== accountId
      || stored.client_id !== credential.clientId || stored.audience !== canonicalAudience(credential.audience)
      || BigInt(stored.security_epoch) !== securityEpoch || stored.revoked_at !== null
      || stored.credential_expires_at.getTime() <= now.getTime()) {
    throw new SyncSessionIssueError('credential_invalid');
  }
  await transaction.updateTable('sync_extension_credentials').set({
    last_verified_at: credential.verifiedAt,
    evidence_expires_at: credential.evidenceExpiresAt,
  }).where('issuer', '=', credential.issuer)
    .where('credential_id', '=', credential.credentialId)
    .where('revoked_at', 'is', null).execute();
  return stored;
}

export async function loadAuthority(
  transaction: DatabaseTransaction,
  input: SyncSessionIssueInput,
  options: ValidatedOptions,
): Promise<Authority> {
  const nowRow = await sql<{ now: Date }>`select current_timestamp as now`.execute(transaction);
  const now = nowRow.rows[0]?.now;
  if (!(now instanceof Date)) throw new SyncSessionIssueError('integrity_failure');

  const identity = await transaction.selectFrom('account_identities as identity')
    .innerJoin('accounts as account', 'account.id', 'identity.account_id')
    .select([
      'account.id as account_id', 'account.subject_id', 'account.status',
      'account.security_epoch', 'identity.subject as credential_subject',
    ])
    .where('identity.issuer', '=', input.credential.issuer)
    .where('identity.subject', '=', input.credential.subject)
    .forUpdate('account').executeTakeFirst();
  if (!identity || identity.status !== 'active') throw new SyncSessionIssueError('credential_invalid');
  const securityEpoch = BigInt(identity.security_epoch);
  if (await isJoseSyncCredentialRevoked(transaction, {
    issuer: input.credential.issuer,
    subject: input.credential.subject,
    tokenId: input.credential.credentialId,
    tokenDigest: input.credential.credentialDigest,
    issuedAtSeconds: Math.floor(input.credential.credentialIssuedAt.getTime() / 1_000),
    clockSkewSeconds: 0,
  })) {
    throw new SyncSessionIssueError('credential_invalid');
  }
  await bindCredential(transaction, input.credential, identity.account_id, securityEpoch, now);
  await lockCollectionReplicaGate(transaction, input.collectionId);
  const replica = await transaction.selectFrom('sync_replicas').selectAll()
    .where('replica_id', '=', input.replicaId)
    .where('account_id', '=', identity.account_id)
    .where('collection_id', '=', input.collectionId)
    .forUpdate().executeTakeFirst();
  if (!replica) throw new SyncSessionIssueError('not_found');

  const collection = await transaction.selectFrom('collections').select([
    'id', 'owner_subject_id', 'policy_revision', 'content_revision', 'commit_ordinal', 'deleted_at',
  ]).where('id', '=', input.collectionId).forUpdate().executeTakeFirst();
  if (!collection || collection.deleted_at !== null) throw new SyncSessionIssueError('not_found');
  let role: 'owner' | 'editor' | 'viewer' | undefined =
    collection.owner_subject_id === identity.subject_id ? 'owner' : undefined;
  if (!role) {
    const member = await transaction.selectFrom('collection_members').select('role')
      .where('collection_id', '=', input.collectionId)
      .where('subject_id', '=', identity.subject_id).executeTakeFirst();
    role = member?.role;
  }
  if (role !== 'owner' && role !== 'editor' && role !== 'viewer') {
    throw new SyncSessionIssueError('not_found');
  }

  if (replica.status === 'retired') throw new SyncSessionIssueError('replica_retired');
  if (replica.status === 'expired' && !options.retentionWindow) {
    throw new SyncSessionIssueError('replica_expired');
  }
  assertReplicaWire(replica);
  if (!sameBinding(replica, input)) throw new SyncSessionIssueError('stale_replica');
  if (replica.capabilities_json.maxBatchOperations !== 1 || options.maxBatchOperations !== 1) {
    throw new SyncSessionIssueError('stale_replica');
  }
  return Object.freeze({
    accountId: identity.account_id,
    subjectId: identity.subject_id,
    securityEpoch,
    role,
    policyRevision: collection.policy_revision,
    contentRevision: collection.content_revision,
    commitOrdinal: BigInt(collection.commit_ordinal),
    replica,
    now,
  });
}

function retentionOrdinal(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new SyncSessionIssueError('integrity_failure');
  }
  try {
    return BigInt(value);
  } catch {
    throw new SyncSessionIssueError('integrity_failure');
  }
}

function checkpointAtOrBeyond(
  checkpoint: Pick<Selectable<SyncReplicaTable>, 'checkpoint_commit_ordinal'
    | 'checkpoint_stream_kind' | 'checkpoint_stable_id'>,
  boundary: ReplicaRetentionTuple | undefined,
  fallbackOrdinal: string,
): boolean {
  if (checkpoint.checkpoint_commit_ordinal === null) return false;
  if (!boundary) return BigInt(checkpoint.checkpoint_commit_ordinal) >= retentionOrdinal(fallbackOrdinal);
  if (checkpoint.checkpoint_stream_kind === null || checkpoint.checkpoint_stable_id === null) return false;
  const current = [BigInt(checkpoint.checkpoint_commit_ordinal), checkpoint.checkpoint_stream_kind,
    checkpoint.checkpoint_stable_id] as const;
  const required = [retentionOrdinal(boundary.commitOrdinal), boundary.streamKind, boundary.stableId] as const;
  return current[0] > required[0] || (current[0] === required[0]
    && (current[1] > required[1] || (current[1] === required[1] && current[2] >= required[2])));
}

export async function prepareReplicaForSession(
  transaction: DatabaseTransaction,
  authority: Authority,
  input: SyncSessionIssueInput,
  options: ValidatedOptions,
): Promise<Selectable<SyncReplicaTable>> {
  const current = authority.replica;
  if (BigInt(current.lease_generation).toString() !== input.expectedLeaseGeneration
      || BigInt(current.lifecycle_revision).toString() !== input.expectedLifecycleRevision) {
    throw new SyncSessionIssueError('stale_replica');
  }

  if (current.status === 'recovery_required') {
    if (!options.retentionWindow) throw new SyncSessionIssueError('replica_recovery_required');
    const window = await options.retentionWindow.load(transaction, input.collectionId);
    if (window.collectionId !== input.collectionId || typeof window.snapshotUrl !== 'string'
        || window.snapshotUrl.length < 1 || window.snapshotUrl.length > 2048) {
      throw new SyncSessionIssueError('integrity_failure');
    }
    return current;
  }

  if (current.status === 'expired'
      || (current.status === 'active' && current.lease_expires_at.getTime() <= authority.now.getTime())) {
    if (!options.retentionWindow) throw new SyncSessionIssueError('replica_expired');
    const window = await options.retentionWindow.load(transaction, input.collectionId);
    if (window.collectionId !== input.collectionId) throw new SyncSessionIssueError('integrity_failure');
    if (typeof window.snapshotUrl !== 'string' || window.snapshotUrl.length < 1
        || window.snapshotUrl.length > 2048) {
      throw new SyncSessionIssueError('integrity_failure');
    }
    const coversHead = current.checkpoint_commit_ordinal !== null
      && BigInt(current.checkpoint_commit_ordinal) >= authority.commitOrdinal;
    const complete = coversHead && checkpointAtOrBeyond(current, window.earliestPullTuple,
      window.earliestPull.commitOrdinal)
      && checkpointAtOrBeyond(current, window.purgedThroughTuple,
        window.purgedThrough.commitOrdinal);
    const lifecycleRevision = BigInt(current.lifecycle_revision) + 1n;
    if (!complete) {
      const wire = { ...current.wire_json, status: 'recovery_required' };
      const recovery = await transaction.updateTable('sync_replicas').set({
        status: 'recovery_required',
        lifecycle_revision: lifecycleRevision,
        wire_json: wire,
      }).where('replica_id', '=', input.replicaId)
        .where('status', 'in', ['active', 'expired'])
        .where('lease_generation', '=', BigInt(input.expectedLeaseGeneration))
        .where('lifecycle_revision', '=', BigInt(input.expectedLifecycleRevision))
        .returningAll().executeTakeFirst();
      if (!recovery) throw new SyncSessionIssueError('stale_replica');
      await options.faultInjector.afterPhase?.('lease');
      await appendAuditEvent(transaction, {
        operationId: null,
        collectionId: null,
        principalId: authority.accountId,
        eventType: 'sync.replica.lifecycle.expired_to_recovery_required',
        details: {
          replicaId: input.replicaId,
          collectionId: input.collectionId,
          from: 'expired',
          to: 'recovery_required',
          leaseGeneration: input.expectedLeaseGeneration,
          lifecycleRevision: lifecycleRevision.toString(),
        },
        createdAt: authority.now,
      });
      await options.faultInjector.afterPhase?.('audit');
      return recovery;
    }

    const leaseGeneration = BigInt(current.lease_generation) + 1n;
    const leaseId = validateProtocolSafeReplicaId(
      options.resumedLeaseId(),
      'Resumed Replica lease ID',
    );
    const leaseExpiresAt = new Date(
      authority.now.getTime() + options.replicaLeaseExtensionSeconds * 1_000,
    );
    await transaction.insertInto('sync_replica_generations').values({
      replica_id: current.replica_id,
      lease_generation: leaseGeneration,
      lease_id: leaseId,
      issued_at: authority.now,
    }).execute();
    await options.faultInjector.afterPhase?.('generation');
    const wire = {
      ...current.wire_json,
      leaseId,
      leaseGeneration: leaseGeneration.toString(),
      status: 'active',
    };
    const resumed = await transaction.updateTable('sync_replicas').set({
      lease_generation: leaseGeneration,
      lease_id: leaseId,
      status: 'active',
      last_seen_at: authority.now,
      lease_expires_at: leaseExpiresAt,
      lifecycle_revision: lifecycleRevision,
      wire_json: wire,
    }).where('replica_id', '=', input.replicaId)
      .where('status', 'in', ['active', 'expired'])
      .where('lease_generation', '=', BigInt(input.expectedLeaseGeneration))
      .where('lifecycle_revision', '=', BigInt(input.expectedLifecycleRevision))
      .returningAll().executeTakeFirst();
    if (!resumed) throw new SyncSessionIssueError('stale_replica');
    await options.faultInjector.afterPhase?.('lease');
    await appendAuditEvent(transaction, {
      operationId: null,
      collectionId: null,
      principalId: authority.accountId,
      eventType: 'sync.replica.lifecycle.expired_to_active',
      details: {
        replicaId: input.replicaId,
        collectionId: input.collectionId,
        from: 'expired',
        to: 'active',
        previousLeaseGeneration: input.expectedLeaseGeneration,
        leaseGeneration: leaseGeneration.toString(),
        lifecycleRevision: lifecycleRevision.toString(),
      },
      createdAt: authority.now,
    });
    return resumed;
  }

  const leaseExpiresAt = new Date(Math.max(
    current.lease_expires_at.getTime(),
    authority.now.getTime() + options.replicaLeaseExtensionSeconds * 1_000,
  ));
  const lifecycleRevision = BigInt(current.lifecycle_revision) + 1n;
  const renewed = await transaction.updateTable('sync_replicas').set({
    last_seen_at: authority.now,
    lease_expires_at: leaseExpiresAt,
    lifecycle_revision: lifecycleRevision,
  }).where('replica_id', '=', input.replicaId)
    .where('account_id', '=', authority.accountId)
    .where('collection_id', '=', input.collectionId)
    .where('status', '=', 'active')
    .where('lease_generation', '=', BigInt(input.expectedLeaseGeneration))
    .where('lifecycle_revision', '=', BigInt(input.expectedLifecycleRevision))
    .where('lease_expires_at', '>', authority.now)
    .returningAll().executeTakeFirst();
  if (!renewed) throw new SyncSessionIssueError('stale_replica');
  await options.faultInjector.afterPhase?.('lease');
  return renewed;
}

export async function reissueExpiredResumeCursor(
  transaction: DatabaseTransaction,
  options: ValidatedOptions,
  authority: Authority,
  renewed: Selectable<SyncReplicaTable>,
  sessionId: string,
  protocolVersion: '0.1' | '0.2',
): Promise<Selectable<SyncReplicaTable>> {
  const previousGeneration = BigInt(authority.replica.lease_generation);
  const nextGeneration = BigInt(renewed.lease_generation);
  if (!options.pullCursorKeyring || nextGeneration === previousGeneration) return renewed;
  if (nextGeneration !== previousGeneration + 1n || renewed.status !== 'active'
      || renewed.checkpoint_cursor === null || renewed.checkpoint_commit_ordinal === null
      || renewed.checkpoint_stream_kind === null || renewed.checkpoint_stable_id === null
      || !options.retentionWindow) throw new SyncSessionIssueError('integrity_failure');

  const priorDigest = createHash('sha256').update(renewed.checkpoint_cursor, 'utf8').digest('hex');
  const evidence = await transaction.selectFrom('sync_pull_cursor_evidence').selectAll()
    .where('replica_id', '=', renewed.replica_id).where('collection_id', '=', renewed.collection_id)
    .where('cursor_digest', '=', priorDigest).where('cursor', '=', renewed.checkpoint_cursor)
    .where('lease_generation', '=', previousGeneration).executeTakeFirst();
  if (!evidence || evidence.account_id !== authority.accountId || evidence.policy_revision !== authority.policyRevision
      || evidence.protocol_version !== protocolVersion
      || BigInt(evidence.tuple_commit_ordinal) !== BigInt(renewed.checkpoint_commit_ordinal)
      || evidence.tuple_stream_kind !== renewed.checkpoint_stream_kind
      || evidence.tuple_stable_id !== renewed.checkpoint_stable_id
      || !Number.isSafeInteger(evidence.page_limit) || evidence.page_limit < 1 || evidence.page_limit > 1_000) {
    throw new SyncSessionIssueError('integrity_failure');
  }
  const window = await options.retentionWindow.load(transaction, renewed.collection_id);
  const retained = window.purgedThroughTuple;
  if (!retained) throw new SyncSessionIssueError('integrity_failure');
  const purgeBoundary: SyncPullTuple = { commitOrdinal: retained.commitOrdinal,
    streamKind: retained.streamKind === SYNC_PULL_STREAM_KIND_ORDER.operation ? 'operation' : 'conflict',
    stableId: retained.stableId };
  const tuple: SyncPullTuple = { commitOrdinal: BigInt(renewed.checkpoint_commit_ordinal).toString(),
    streamKind: renewed.checkpoint_stream_kind === SYNC_PULL_STREAM_KIND_ORDER.operation ? 'operation' : 'conflict',
    stableId: renewed.checkpoint_stable_id };
  const routeAuthority = buildSyncRouteAuthorityContext({ accountId: authority.accountId,
    collectionId: renewed.collection_id, replicaId: renewed.replica_id, sessionId,
    leaseGeneration: nextGeneration.toString(), lifecycleRevision: BigInt(renewed.lifecycle_revision).toString(),
    policyRevision: authority.policyRevision, protocolVersion });
  const context = syncPullCursorContext(routeAuthority, purgeBoundary, evidence.page_limit);
  const cursor = options.pullCursorKeyring.sign({ ...context, tuple });
  const verified = options.pullCursorKeyring.verify(cursor, context);
  if (!verified.valid) throw new SyncSessionIssueError('integrity_failure');
  const cursorDigest = createHash('sha256').update(cursor, 'utf8').digest('hex');
  const streamKind = SYNC_PULL_STREAM_KIND_ORDER[tuple.streamKind];
  const purgeKind = SYNC_PULL_STREAM_KIND_ORDER[purgeBoundary.streamKind];
  await transaction.insertInto('sync_pull_cursor_evidence').values({ cursor, cursor_digest: cursorDigest,
    session_id: sessionId, account_id: authority.accountId, collection_id: renewed.collection_id,
    replica_id: renewed.replica_id, lease_generation: nextGeneration, policy_revision: authority.policyRevision,
    protocol_version: protocolVersion, tuple_commit_ordinal: BigInt(tuple.commitOrdinal),
    tuple_stream_kind: streamKind, tuple_stable_id: tuple.stableId,
    cursor_expires_at: new Date(verified.expiresAt), upper_commit_ordinal: BigInt(tuple.commitOrdinal),
    upper_stream_kind: streamKind, upper_stable_id: tuple.stableId, collection_revision: authority.contentRevision,
    page_limit: evidence.page_limit, purge_commit_ordinal: BigInt(purgeBoundary.commitOrdinal),
    purge_stream_kind: purgeKind, purge_stable_id: purgeBoundary.stableId }).execute();
  const proofRetention = options.recoveryProofRetentionMs ?? 2_592_000_000;
  await transaction.insertInto('sync_pull_cursor_recovery_proofs').values({ cursor_digest: cursorDigest,
    authority_session_id: sessionId, authority_lifecycle_revision: BigInt(renewed.lifecycle_revision),
    account_id: authority.accountId, collection_id: renewed.collection_id, replica_id: renewed.replica_id,
    lease_generation: nextGeneration, policy_revision: authority.policyRevision, protocol_version: protocolVersion,
    page_limit: evidence.page_limit, tuple_commit_ordinal: BigInt(tuple.commitOrdinal), tuple_stream_kind: streamKind,
    tuple_stable_id: tuple.stableId, upper_commit_ordinal: BigInt(tuple.commitOrdinal), upper_stream_kind: streamKind,
    upper_stable_id: tuple.stableId, purge_commit_ordinal: BigInt(purgeBoundary.commitOrdinal),
    purge_stream_kind: purgeKind, purge_stable_id: purgeBoundary.stableId,
    cursor_expires_at: new Date(verified.expiresAt), proof_expires_at: new Date(Math.max(
      verified.expiresAt + 1, authority.now.getTime() + proofRetention)), issued_at: authority.now, consumed_at: null }).execute();
  const wireCheckpoint = typeof renewed.wire_json.checkpoint === 'object' && renewed.wire_json.checkpoint !== null
    && !Array.isArray(renewed.wire_json.checkpoint) ? renewed.wire_json.checkpoint as Record<string, unknown> : {};
  const published = await transaction.updateTable('sync_replicas').set({ checkpoint_cursor: cursor,
    wire_json: { ...renewed.wire_json, checkpoint: { ...wireCheckpoint, acknowledgedCursor: cursor } } })
    .where('replica_id', '=', renewed.replica_id).where('lease_generation', '=', nextGeneration)
    .where('lifecycle_revision', '=', BigInt(renewed.lifecycle_revision)).where('checkpoint_cursor', '=', renewed.checkpoint_cursor)
    .returningAll().executeTakeFirst();
  if (!published) throw new SyncSessionIssueError('stale_replica');
  return published;
}

export function mapSession(
  row: Selectable<SyncSessionTable>,
  scopes: readonly SyncAuthorizationScope[],
): SyncSessionRecord {
  const base = {
    sessionId: row.session_id,
    principal: { type: 'user' as const, id: row.principal_subject_id },
    credential: { kind: 'token' as const, id: row.credential_id },
    oauthClientId: row.oauth_client_id,
    origin: row.origin,
    sessionScope: 'collection' as const,
    protocolVersion: row.protocol_version,
    collectionId: row.collection_id,
    purpose: null,
    authorizationScopes: Object.freeze([...scopes]),
    expiresAt: formatInstant(row.expires_at),
  };
  if (row.status === 'active') return Object.freeze({ ...base, status: 'active' as const });
  if (!row.termination_reason || !row.terminated_at) throw new SyncSessionIssueError('integrity_failure');
  return Object.freeze({
    ...base,
    status: 'terminated' as const,
    terminationReason: row.termination_reason,
    terminatedAt: formatInstant(row.terminated_at),
  });
}

export class TransactionSessionStore implements SyncSessionStore {
  constructor(
    private readonly transaction: DatabaseTransaction,
    private readonly authority?: SessionAuthority,
  ) {}

  async create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult> {
    const authority = this.authority;
    if (!authority || session.sessionId.length < 1) throw new SyncSessionIssueError('integrity_failure');
    const existing = await this.load(session.sessionId);
    if (existing) return Object.freeze({ state: 'conflict' as const, session: existing });
    const bindingJson = {
      accountId: authority.accountId,
      principalSubjectId: authority.principalSubjectId,
      credentialIssuer: authority.credential.issuer,
      credentialId: authority.credential.credentialId,
      oauthClientId: authority.credential.clientId,
      collectionId: authority.collectionId,
      replicaId: authority.replica.replica_id,
      leaseGeneration: BigInt(authority.replica.lease_generation).toString(),
      leaseId: authority.replica.lease_id,
      lifecycleRevision: authority.lifecycleRevision.toString(),
      policyRevision: authority.policyRevision,
      accountSecurityEpoch: authority.accountSecurityEpoch.toString(),
      sessionScope: 'collection',
      protocolVersion: session.protocolVersion,
    };
    await this.transaction.insertInto('resource_id_ledger').values({
      resource_id: session.sessionId,
      resource_type: 'sync_session',
      committed_at: authority.issuedAt,
    }).execute();
    await this.transaction.insertInto('sync_sessions').values({
      session_id: session.sessionId,
      account_id: authority.accountId,
      principal_subject_id: authority.principalSubjectId,
      credential_issuer: authority.credential.issuer,
      credential_id: authority.credential.credentialId,
      oauth_client_id: authority.credential.clientId,
      origin: authority.origin,
      session_scope: 'collection',
      protocol_version: session.protocolVersion,
      collection_id: authority.collectionId,
      replica_id: authority.replica.replica_id,
      lease_generation: BigInt(authority.replica.lease_generation),
      lease_id: authority.replica.lease_id,
      lifecycle_revision: authority.lifecycleRevision,
      policy_revision: authority.policyRevision,
      account_security_epoch: authority.accountSecurityEpoch,
      issued_at: authority.issuedAt,
      expires_at: authority.expiresAt,
      status: 'active',
      termination_reason: null,
      terminated_at: null,
      secret_digest: authority.secretDigest,
      capability_digest: authority.capabilityDigest,
      binding_json: bindingJson,
    }).execute();
    await authority.faultInjector.afterPhase?.('session');
    await this.transaction.insertInto('sync_session_scopes').values(
      session.authorizationScopes.map((scope) => ({
        session_id: session.sessionId,
        scope: scope as 'sync:bootstrap' | 'sync:pull' | 'sync:push',
      })),
    ).execute();
    await this.transaction.insertInto('sync_session_bindings').values({
      session_id: session.sessionId,
      account_id: authority.accountId,
      collection_id: authority.collectionId,
      replica_id: authority.replica.replica_id,
      lease_generation: BigInt(authority.replica.lease_generation),
      lease_id: authority.replica.lease_id,
      lifecycle_revision: authority.lifecycleRevision,
      policy_revision: authority.policyRevision,
      binding_mode: authority.replica.binding_mode,
      browser_profile_id: authority.replica.browser_profile_id,
      browser_generation: authority.replica.browser_generation,
      created_at: authority.issuedAt,
    }).execute();
    await authority.faultInjector.afterPhase?.('binding');
    return Object.freeze({ state: 'created' as const, session });
  }

  async load(sessionId: string): Promise<SyncSessionRecord | undefined> {
    const row = await this.transaction.selectFrom('sync_sessions').selectAll()
      .where('session_id', '=', sessionId).executeTakeFirst();
    if (!row) return undefined;
    const scopes = await this.transaction.selectFrom('sync_session_scopes').select('scope')
      .where('session_id', '=', sessionId).orderBy('scope', 'asc').execute();
    return mapSession(row, scopes.map((item) => item.scope));
  }

  async terminate(termination: SyncSessionTermination): Promise<SyncSessionRecord | undefined> {
    const terminated = await this.transaction.updateTable('sync_sessions').set({
      status: 'terminated',
      termination_reason: termination.reason,
      terminated_at: new Date(termination.terminatedAt),
    }).where('session_id', '=', termination.sessionId)
      .where('status', '=', 'active')
      .returning(['account_id', 'collection_id', 'replica_id'])
      .executeTakeFirst();
    if (terminated) {
      await appendAuditEvent(this.transaction, {
        operationId: null,
        collectionId: null,
        principalId: terminated.account_id,
        eventType: 'sync.session.terminated',
        details: {
          sessionId: termination.sessionId,
          collectionId: terminated.collection_id,
          replicaId: terminated.replica_id,
          reason: termination.reason,
        },
        createdAt: new Date(termination.terminatedAt),
      });
    }
    return this.load(termination.sessionId);
  }
}
