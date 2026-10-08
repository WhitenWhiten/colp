import {
  createSyncSession,
  requireVerifiedSyncSession,
  SyncSessionGateDeniedError,
  type CreateSyncSessionInput,
  type SyncSessionRecord,
  type VerifiedSyncSession,
} from '@know-n/colp/sync';
import { sql } from 'kysely';
import { isVerifiedExtensionCredential } from '../../../modules/identity/index.js';
import {
  buildSyncRouteAuthorityContext,
  canonicalSyncSessionFingerprint,
  classifySyncSessionAuthorityFacts,
  rebuildSyncSessionIssueEnvelope,
  SyncSessionIssueError,
  validateProtocolSafeReplicaId,
  validateSyncSessionIssueInput,
  validateSyncSessionVerifyInput,
  type SyncSessionIssueInput,
  type SyncSessionVerifyInput,
} from '../../../modules/sync/index.js';
import { appendAuditEvent } from '../../database/audit-event-payload.js';
import { lockCollectionReplicaGate } from '../../database/lock-order.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';
import {
  assertCredentialPreflight,
  authorizeRequestedScopes,
  currentlyAuthorizedScopes,
  endpointCapabilitiesForScopes,
  formatInstant,
  nonEmpty,
  sha256,
} from './sync-session-admission-postgres.js';
import {
  decryptEnvelope,
  encryptEnvelope,
  receiptAad,
  replayAuthorityFacts,
  replayIdentityFromEnvelope,
} from './sync-session-receipt-postgres.js';
import {
  loadAuthority,
  prepareReplicaForSession,
  reissueExpiredResumeCursor,
  TransactionSessionStore,
} from './sync-session-repository-postgres.js';
import {
  isCommittedIssueDenial,
  type IssueTransactionOutcome,
  type PostgresSyncSessionCommittedDenial,
  type SessionAuthority,
  type ValidatedOptions,
  type VerifyTransactionOutcome,
} from './sync-session-types-postgres.js';

async function mintFromStore(
  store: TransactionSessionStore,
  session: SyncSessionRecord,
  credentialActive: boolean,
  now: Date,
  authorizationScopes: SyncSessionRecord['authorizationScopes'] = session.authorizationScopes,
): Promise<VerifiedSyncSession> {
  try {
    return await requireVerifiedSyncSession(store, {
      sessionId: session.sessionId,
      binding: {
        principal: session.principal,
        credential: session.credential,
        oauthClientId: session.oauthClientId,
        origin: session.origin,
        sessionScope: session.sessionScope,
        protocolVersion: session.protocolVersion,
        collectionId: session.collectionId,
        purpose: session.purpose,
      },
      authorization: {
        credentialActive,
        authorizationScopes,
      },
      terminatedAt: formatInstant(now),
    });
  } catch (error: unknown) {
    if (error instanceof SyncSessionGateDeniedError && error.denial.state === 'terminated') {
      if (error.denial.session.terminationReason === 'lease_expired') {
        throw new SyncSessionIssueError('session_expired');
      }
      if (error.denial.session.terminationReason === 'credential_revoked') {
        throw new SyncSessionIssueError('credential_invalid');
      }
      if (error.denial.session.terminationReason === 'scope_reduced') {
        throw new SyncSessionIssueError('session_revoked');
      }
    }
    if (error instanceof SyncSessionIssueError) throw error;
    throw new SyncSessionIssueError('session_revoked');
  }
}

async function mintWithCommittedDenial(
  store: TransactionSessionStore,
  session: SyncSessionRecord,
  credentialActive: boolean,
  now: Date,
  authorizationScopes: SyncSessionRecord['authorizationScopes'] = session.authorizationScopes,
): Promise<VerifiedSyncSession | PostgresSyncSessionCommittedDenial> {
  try {
    return await mintFromStore(store, session, credentialActive, now, authorizationScopes);
  } catch (error: unknown) {
    if (error instanceof SyncSessionIssueError
        && (error.code === 'credential_invalid' || error.code === 'session_expired'
          || error.code === 'session_revoked')) {
      return Object.freeze({
        state: 'denied_after_commit' as const,
        code: error.code,
        snapshotUrl: null,
      });
    }
    throw error;
  }
}

export async function issueInTransaction(
  transaction: DatabaseTransaction,
  rawInput: SyncSessionIssueInput,
  options: ValidatedOptions,
): Promise<IssueTransactionOutcome> {
  let input: Readonly<SyncSessionIssueInput>;
  try {
    input = validateSyncSessionIssueInput(rawInput);
  } catch (error: unknown) {
    const credential = typeof rawInput === 'object' && rawInput !== null
      ? (rawInput as { readonly credential?: unknown }).credential : undefined;
    if (!isVerifiedExtensionCredential(credential)) {
      throw new SyncSessionIssueError('credential_invalid');
    }
    throw error;
  }
  assertCredentialPreflight(input.credential, options);
  const fingerprint = canonicalSyncSessionFingerprint(input);
  const authority = await loadAuthority(transaction, input, options);

  const receipt = await transaction.selectFrom('sync_session_idempotency_receipts').selectAll()
    .where('principal_id', '=', authority.accountId)
    .where('session_scope', '=', 'collection')
    .where('idempotency_key', '=', input.idempotencyKey)
    .forUpdate().executeTakeFirst();
  if (receipt) {
    if (receipt.request_fingerprint !== fingerprint
        || receipt.collection_id !== input.collectionId || receipt.replica_id !== input.replicaId) {
      throw new SyncSessionIssueError('idempotency_key_reuse');
    }
    const store = new TransactionSessionStore(transaction);
    const session = await store.load(receipt.session_id);
    if (!session) throw new SyncSessionIssueError('integrity_failure');
    const sessionRow = await transaction.selectFrom('sync_sessions').selectAll()
      .where('session_id', '=', receipt.session_id).executeTakeFirst();
    const binding = await transaction.selectFrom('sync_session_bindings').selectAll()
      .where('session_id', '=', receipt.session_id).executeTakeFirst();
    if (!sessionRow || !binding) throw new SyncSessionIssueError('integrity_failure');
    const authorityStillBound = sessionRow.account_id === authority.accountId
      && sessionRow.principal_subject_id === authority.subjectId
      && sessionRow.credential_issuer === input.credential.issuer
      && sessionRow.credential_id === input.credential.credentialId
      && sessionRow.collection_id === input.collectionId
      && sessionRow.replica_id === input.replicaId
      && sessionRow.policy_revision === authority.policyRevision
      && BigInt(sessionRow.account_security_epoch) === authority.securityEpoch
      && BigInt(sessionRow.lease_generation) === BigInt(authority.replica.lease_generation)
      && sessionRow.lease_id === authority.replica.lease_id
      && BigInt(sessionRow.lifecycle_revision) === BigInt(authority.replica.lifecycle_revision)
      && binding.account_id === sessionRow.account_id
      && binding.collection_id === sessionRow.collection_id
      && binding.replica_id === sessionRow.replica_id
      && BigInt(binding.lease_generation) === BigInt(sessionRow.lease_generation)
      && binding.lease_id === sessionRow.lease_id
      && BigInt(binding.lifecycle_revision) === BigInt(sessionRow.lifecycle_revision)
      && binding.policy_revision === sessionRow.policy_revision
      && binding.binding_mode === authority.replica.binding_mode
      && binding.browser_profile_id === authority.replica.browser_profile_id
      && binding.browser_generation === authority.replica.browser_generation;
    const sameKeyReplayAllowed = authorityStillBound
      && authority.replica.status === 'active'
      && authority.replica.lease_expires_at.getTime() > authority.now.getTime();
    const currentScopes = sameKeyReplayAllowed
      ? currentlyAuthorizedScopes(authority, session.authorizationScopes)
      : [];
    const verified = await mintWithCommittedDenial(store, session, true, authority.now, currentScopes);
    if (isCommittedIssueDenial(verified)) return verified;
    return Object.freeze({
      state: 'replayed' as const,
      session: verified,
      envelope: rebuildSyncSessionIssueEnvelope(
        replayIdentityFromEnvelope(
          decryptEnvelope(receipt, options.replayEncryptionKey, options.replayEncryptionKeyVersion),
          receipt,
          verified,
          sessionRow,
        ),
        replayAuthorityFacts(authority, options, verified.sessionId, currentScopes),
      ),
    });
  }

  const renewed = await prepareReplicaForSession(transaction, authority, input, options);
  const sessionAuthorityFacts = classifySyncSessionAuthorityFacts({
    replicaState: renewed.status,
    checkpointCursor: renewed.checkpoint_cursor,
  });
  const lifecycleRevision = BigInt(renewed.lifecycle_revision);
  const renewedAuthority = Object.freeze({ ...authority, replica: renewed });
  const grantedScopes = sessionAuthorityFacts.scopeCeiling === 'bootstrap_only'
    ? authorizeRequestedScopes(renewedAuthority, input.requestedScopes).filter((scope) => scope === 'sync:bootstrap')
    : authorizeRequestedScopes(renewedAuthority, input.requestedScopes);
  if (sessionAuthorityFacts.scopeCeiling === 'bootstrap_only' && !grantedScopes.includes('sync:bootstrap')) {
    throw new SyncSessionIssueError('not_found');
  }

  const sessionId = validateProtocolSafeReplicaId(
    options.ids.sessionId(),
    'Generated Session ID',
  );
  const batchBindingSecret = nonEmpty(options.ids.batchBindingSecret(), 'Generated batch binding secret', 512);
  const endpointCapability = nonEmpty(options.ids.endpointCapability(), 'Generated endpoint capability', 512);
  const expiresAt = new Date(authority.now.getTime() + options.sessionDurationSeconds * 1_000);
  const sessionAuthority: SessionAuthority = {
    accountId: authority.accountId,
    principalSubjectId: authority.subjectId,
    credential: input.credential,
    origin: input.origin,
    collectionId: input.collectionId,
    replica: renewed,
    lifecycleRevision,
    policyRevision: authority.policyRevision,
    accountSecurityEpoch: authority.securityEpoch,
    issuedAt: authority.now,
    expiresAt,
    secretDigest: sha256(batchBindingSecret),
    capabilityDigest: sha256(endpointCapability),
    faultInjector: options.faultInjector,
  };
  buildSyncRouteAuthorityContext({ accountId: authority.accountId, collectionId: input.collectionId,
    replicaId: renewed.replica_id, sessionId, leaseGeneration: BigInt(renewed.lease_generation).toString(),
    lifecycleRevision: lifecycleRevision.toString(), policyRevision: authority.policyRevision,
    protocolVersion: input.protocolVersion ?? '0.1' });
  const store = new TransactionSessionStore(transaction, sessionAuthority);
  const createInput: CreateSyncSessionInput = {
    sessionId,
    principal: { type: 'user', id: authority.subjectId },
    credential: { kind: 'token', id: input.credential.credentialId },
    oauthClientId: input.credential.clientId,
    origin: input.origin,
    sessionScope: 'collection',
    protocolVersion: input.protocolVersion ?? '0.1',
    collectionId: input.collectionId,
    purpose: null,
    authorizationScopes: grantedScopes,
    expiresAt: formatInstant(expiresAt),
  };
  const created = await createSyncSession(store, createInput);
  if (created.status !== 'active') throw new SyncSessionIssueError('integrity_failure');
  const verified = await mintFromStore(store, created, true, authority.now);
  const publishedReplica = await reissueExpiredResumeCursor(transaction, options, authority,
    renewed, sessionId, input.protocolVersion ?? '0.1');
  const envelope = rebuildSyncSessionIssueEnvelope(Object.freeze({
    sessionId,
    expiresAt: formatInstant(expiresAt),
    serverTime: formatInstant(authority.now),
    acceptedProtocolVersion: input.protocolVersion ?? '0.1',
    scope: 'collection',
    maxBatchOperations: options.maxBatchOperations,
    tombstoneRetentionSeconds: options.tombstoneRetentionSeconds,
    batchBindingSecret,
    endpointCapability,
  }), Object.freeze({
    replicaLease: Object.freeze({
      leaseId: publishedReplica.lease_id,
      generation: BigInt(publishedReplica.lease_generation).toString(),
      state: sessionAuthorityFacts.wireLeaseState,
      lastSeenAt: formatInstant(publishedReplica.last_seen_at),
      expiresAt: formatInstant(publishedReplica.lease_expires_at),
      acknowledgedCursor: publishedReplica.checkpoint_cursor,
    }),
    collectionRevision: authority.contentRevision,
    collectionCursor: publishedReplica.checkpoint_cursor ?? `bootstrap-${sessionId}`,
    snapshotRequired: sessionAuthorityFacts.snapshotRequired,
    conversionPolicy: Object.freeze({
      alias: renewed.capabilities_json.alias ? 'duplicate' : 'skip',
      separator: renewed.capabilities_json.separator ? 'native' : 'preserve_remote',
      unknownExtensions: 'preserve_remote',
    }),
    endpointCapabilities: endpointCapabilitiesForScopes(options.endpointCapabilities, grantedScopes),
  }));
  const encrypted = encryptEnvelope(envelope, options.replayEncryptionKey, receiptAad({
    principalId: authority.accountId,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: fingerprint,
    collectionId: input.collectionId,
    replicaId: input.replicaId,
    sessionId,
    keyVersion: options.replayEncryptionKeyVersion,
  }));
  await transaction.insertInto('sync_session_idempotency_receipts').values({
    principal_id: authority.accountId,
    session_scope: 'collection',
    idempotency_key: input.idempotencyKey,
    request_fingerprint: fingerprint,
    collection_id: input.collectionId,
    replica_id: input.replicaId,
    session_id: sessionId,
    result_ciphertext: encrypted.ciphertext,
    result_iv: encrypted.iv,
    result_auth_tag: encrypted.authTag,
    result_key_version: options.replayEncryptionKeyVersion,
    result_digest: encrypted.digest,
    claimed_at: authority.now,
    completed_at: authority.now,
  }).execute();
  await options.faultInjector.afterPhase?.('receipt');
  await appendAuditEvent(transaction, {
    operationId: null,
    collectionId: null,
    principalId: authority.accountId,
    eventType: 'sync.session.issued',
    details: {
      sessionId,
      accountId: authority.accountId,
      collectionId: input.collectionId,
      replicaId: input.replicaId,
      leaseGeneration: BigInt(renewed.lease_generation).toString(),
      lifecycleRevision: lifecycleRevision.toString(),
      policyRevision: authority.policyRevision,
    },
    createdAt: authority.now,
  });
  await options.faultInjector.afterPhase?.('audit');
  await options.faultInjector.afterPhase?.('finalize');
  return Object.freeze({ state: 'issued' as const, session: verified, envelope });
}

export async function verifyInTransaction(
  transaction: DatabaseTransaction,
  rawInput: SyncSessionVerifyInput,
  options: ValidatedOptions,
): Promise<VerifyTransactionOutcome> {
  const input = validateSyncSessionVerifyInput(rawInput);
  assertCredentialPreflight(input.credential, options);
  const nowResult = await sql<{ now: Date }>`select current_timestamp as now`.execute(transaction);
  const now = nowResult.rows[0]?.now;
  if (!(now instanceof Date)) throw new SyncSessionIssueError('integrity_failure');
  const row = await transaction.selectFrom('sync_sessions').selectAll()
    .where('session_id', '=', input.sessionId)
    .where('collection_id', '=', input.collectionId)
    .where('replica_id', '=', input.replicaId)
    .forUpdate().executeTakeFirst();
  if (!row) throw new SyncSessionIssueError('not_found');
  const account = await transaction.selectFrom('accounts').selectAll()
    .where('id', '=', row.account_id).forUpdate().executeTakeFirst();
  const storedCredential = await transaction.selectFrom('sync_extension_credentials').selectAll()
    .where('issuer', '=', input.credential.issuer)
    .where('credential_id', '=', input.credential.credentialId)
    .forUpdate().executeTakeFirst();
  await lockCollectionReplicaGate(transaction, input.collectionId);
  const replica = await transaction.selectFrom('sync_replicas').selectAll()
    .where('replica_id', '=', row.replica_id).forUpdate().executeTakeFirst();
  const binding = await transaction.selectFrom('sync_session_bindings').selectAll()
    .where('session_id', '=', row.session_id).executeTakeFirst();
  const collection = await transaction.selectFrom('collections').select([
    'owner_subject_id', 'policy_revision', 'deleted_at',
  ]).where('id', '=', row.collection_id).forUpdate().executeTakeFirst();
  let role: 'owner' | 'editor' | 'viewer' | undefined;
  if (account && collection?.owner_subject_id === account.subject_id) role = 'owner';
  if (account && !role) {
    const member = await transaction.selectFrom('collection_members').select('role')
      .where('collection_id', '=', row.collection_id)
      .where('subject_id', '=', account.subject_id).executeTakeFirst();
    role = member?.role;
  }
  if (account && storedCredential && storedCredential.revoked_at === null
      && storedCredential.credential_digest === input.credential.credentialDigest
      && storedCredential.subject === input.credential.subject
      && storedCredential.account_id === account.id
      && BigInt(storedCredential.security_epoch) === BigInt(account.security_epoch)
      && input.credential.credentialExpiresAt.getTime() > now.getTime()
      && input.credential.evidenceExpiresAt.getTime() > now.getTime()) {
    await transaction.updateTable('sync_extension_credentials').set({
      last_verified_at: input.credential.verifiedAt,
      evidence_expires_at: input.credential.evidenceExpiresAt,
    }).where('issuer', '=', input.credential.issuer)
      .where('credential_id', '=', input.credential.credentialId)
      .where('revoked_at', 'is', null).execute();
  }
  const credentialActive = !!account && account.status === 'active'
    && BigInt(account.security_epoch) === BigInt(row.account_security_epoch)
    && row.credential_issuer === input.credential.issuer
    && row.credential_id === input.credential.credentialId
    && row.oauth_client_id === input.credential.clientId
    && !!storedCredential && storedCredential.credential_digest === input.credential.credentialDigest
    && storedCredential.subject === input.credential.subject
    && storedCredential.account_id === row.account_id
    && BigInt(storedCredential.security_epoch) === BigInt(account.security_epoch)
    && storedCredential.revoked_at === null
    && storedCredential.credential_expires_at.getTime() > now.getTime()
    && input.credential.credentialExpiresAt.getTime() > now.getTime()
    && input.credential.evidenceExpiresAt.getTime() > now.getTime();
  const authorizationActive = !!collection && collection.deleted_at === null
    && collection.policy_revision === row.policy_revision
    && (role === 'owner' || role === 'editor' || role === 'viewer')
    && !!replica && replica.status === 'active'
    && replica.lease_expires_at.getTime() > now.getTime()
    && BigInt(replica.lease_generation) === BigInt(row.lease_generation)
    && BigInt(replica.lifecycle_revision) === BigInt(row.lifecycle_revision)
    && !!binding && binding.account_id === row.account_id
    && binding.collection_id === row.collection_id && binding.replica_id === row.replica_id
    && BigInt(binding.lease_generation) === BigInt(replica.lease_generation)
    && binding.lease_id === replica.lease_id
    && BigInt(binding.lifecycle_revision) === BigInt(replica.lifecycle_revision)
    && binding.policy_revision === collection.policy_revision
    && binding.binding_mode === replica.binding_mode
    && binding.browser_profile_id === replica.browser_profile_id
    && binding.browser_generation === replica.browser_generation;
  const store = new TransactionSessionStore(transaction);
  const session = await store.load(row.session_id);
  if (!session) throw new SyncSessionIssueError('integrity_failure');
  const currentScopes = authorizationActive ? session.authorizationScopes.filter((scope) => {
    if (scope === 'sync:push') {
      return role !== 'viewer' && replica?.capabilities_json.write === true;
    }
    return replica?.capabilities_json.read === true;
  }) : [];
  return mintWithCommittedDenial(
    store,
    session,
    credentialActive,
    now,
    currentScopes,
  );
}
