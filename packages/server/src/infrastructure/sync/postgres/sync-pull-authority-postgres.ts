import { sql } from 'kysely';
import {
  SyncPullReadError,
  type SyncPullReadErrorCode,
  type SyncPullReadInput,
  type SyncPullTuple,
} from '../../../modules/sync/index.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';

export interface PullAuthority {
  readonly now: Date;
  readonly accountId: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly collectionRevision: string;
  readonly policyRevision: string;
  readonly leaseGeneration: string;
  readonly lifecycleRevision: string;
  readonly checkpointCursor: string | null;
  readonly checkpointTuple: SyncPullTuple | null;
  readonly protocolVersion: '0.1' | '0.2';
}

export type SyncPullAuthorityPhase = 'after_snapshot' | 'before_finalization';

export interface SyncPullAuthorityFaultInjector {
  afterPhase?(phase: SyncPullAuthorityPhase, transaction: DatabaseTransaction): void | Promise<void>;
}

export interface PullAuthorityFingerprint {
  readonly accountStatus: string;
  readonly accountSecurityEpoch: string;
  readonly credentialDigest: string;
  readonly credentialRevoked: boolean;
  readonly credentialSubject: string;
  readonly credentialAccountId: string;
  readonly credentialClientId: string;
  readonly credentialAudience: string;
  readonly credentialScopes: string;
  readonly credentialSecurityEpoch: string;
  readonly credentialExpiresAt: string;
  readonly sessionCredentialIssuer: string;
  readonly sessionCredentialId: string;
  readonly sessionOAuthClientId: string;
  readonly sessionPolicyRevision: string;
  readonly sessionAccountSecurityEpoch: string;
  readonly sessionLeaseGeneration: string;
  readonly sessionLifecycleRevision: string;
  readonly sessionExpiresAt: string;
  readonly sessionStatus: string;
  readonly membershipRole: string | null;
  readonly collectionPolicyRevision: string;
  readonly collectionContentRevision: string;
  readonly collectionDeleted: boolean;
  readonly replicaStatus: string;
  readonly replicaLeaseExpiresAt: string;
  readonly replicaLifecycleRevision: string;
  readonly replicaLeaseGeneration: string;
  readonly replicaCapabilitiesRead: boolean;
  readonly bindingIdentity: string;
  readonly hasPullScope: boolean;
}

export interface PullAuthoritySnapshot {
  readonly authority: PullAuthority;
  readonly fingerprint: PullAuthorityFingerprint;
}

function bindingIdentityFingerprint(binding: {
  readonly account_id: string;
  readonly collection_id: string;
  readonly replica_id: string;
  readonly policy_revision: string;
  readonly lease_generation: bigint | string;
  readonly lifecycle_revision: bigint | string;
  readonly lease_id: string;
  readonly binding_mode: string;
  readonly browser_profile_id: string;
  readonly browser_generation: string;
}): string {
  return JSON.stringify([
    binding.account_id, binding.collection_id, binding.replica_id, binding.policy_revision,
    BigInt(binding.lease_generation).toString(), BigInt(binding.lifecycle_revision).toString(),
    binding.lease_id, binding.binding_mode, binding.browser_profile_id, binding.browser_generation,
  ]);
}

function buildPullAuthorityFingerprint(input: {
  readonly account: { readonly status: string; readonly security_epoch: bigint | string;
    readonly subject_id: string; readonly id: string } | undefined;
  readonly credential: { readonly revoked_at: Date | null; readonly credential_digest: string;
    readonly subject: string; readonly account_id: string; readonly client_id: string;
    readonly audience: string; readonly scopes_json: unknown; readonly security_epoch: bigint | string;
    readonly credential_expires_at: Date } | undefined;
  readonly session: { readonly credential_issuer: string; readonly credential_id: string;
    readonly oauth_client_id: string; readonly origin: string | null; readonly policy_revision: string;
    readonly account_security_epoch: bigint | string; readonly lease_generation: bigint | string;
    readonly lifecycle_revision: bigint | string; readonly expires_at: Date; readonly status: string;
    readonly collection_id: string };
  readonly collection: { readonly owner_subject_id: string; readonly policy_revision: string;
    readonly content_revision: string; readonly deleted_at: Date | null } | undefined;
  readonly replica: { readonly status: string; readonly lease_expires_at: Date;
    readonly lifecycle_revision: bigint | string; readonly lease_generation: bigint | string;
    readonly capabilities_json: { readonly read?: boolean } } | undefined;
  readonly binding: { readonly account_id: string; readonly collection_id: string;
    readonly replica_id: string; readonly policy_revision: string; readonly lease_generation: bigint | string;
    readonly lifecycle_revision: bigint | string; readonly lease_id: string; readonly binding_mode: string;
    readonly browser_profile_id: string; readonly browser_generation: string } | undefined;
  readonly membershipRole: 'owner' | 'editor' | 'viewer' | null;
  readonly hasPullScope: boolean;
}): PullAuthorityFingerprint {
  const scopes = Array.isArray(input.credential?.scopes_json)
    ? [...input.credential.scopes_json].map(String).sort()
    : [];
  return Object.freeze({
    accountStatus: input.account?.status ?? '',
    accountSecurityEpoch: input.account ? BigInt(input.account.security_epoch).toString() : '',
    credentialDigest: input.credential?.credential_digest ?? '',
    credentialRevoked: input.credential?.revoked_at !== null && input.credential?.revoked_at !== undefined,
    credentialSubject: input.credential?.subject ?? '',
    credentialAccountId: input.credential?.account_id ?? '',
    credentialClientId: input.credential?.client_id ?? '',
    credentialAudience: input.credential?.audience ?? '',
    credentialScopes: JSON.stringify(scopes),
    credentialSecurityEpoch: input.credential ? BigInt(input.credential.security_epoch).toString() : '',
    credentialExpiresAt: input.credential?.credential_expires_at.toISOString() ?? '',
    sessionCredentialIssuer: input.session.credential_issuer,
    sessionCredentialId: input.session.credential_id,
    sessionOAuthClientId: input.session.oauth_client_id,
    sessionPolicyRevision: input.session.policy_revision,
    sessionAccountSecurityEpoch: BigInt(input.session.account_security_epoch).toString(),
    sessionLeaseGeneration: BigInt(input.session.lease_generation).toString(),
    sessionLifecycleRevision: BigInt(input.session.lifecycle_revision).toString(),
    sessionExpiresAt: input.session.expires_at.toISOString(),
    sessionStatus: input.session.status,
    membershipRole: input.membershipRole,
    collectionPolicyRevision: input.collection?.policy_revision ?? '',
    collectionContentRevision: input.collection?.content_revision ?? '',
    collectionDeleted: input.collection?.deleted_at !== null && input.collection?.deleted_at !== undefined,
    replicaStatus: input.replica?.status ?? '',
    replicaLeaseExpiresAt: input.replica?.lease_expires_at.toISOString() ?? '',
    replicaLifecycleRevision: input.replica ? BigInt(input.replica.lifecycle_revision).toString() : '',
    replicaLeaseGeneration: input.replica ? BigInt(input.replica.lease_generation).toString() : '',
    replicaCapabilitiesRead: input.replica?.capabilities_json.read === true,
    bindingIdentity: input.binding ? bindingIdentityFingerprint(input.binding) : '',
    hasPullScope: input.hasPullScope,
  });
}

function pullAuthorityFingerprintsEqual(
  left: PullAuthorityFingerprint,
  right: PullAuthorityFingerprint,
): boolean {
  return left.accountStatus === right.accountStatus
    && left.accountSecurityEpoch === right.accountSecurityEpoch
    && left.credentialDigest === right.credentialDigest
    && left.credentialRevoked === right.credentialRevoked
    && left.credentialSubject === right.credentialSubject
    && left.credentialAccountId === right.credentialAccountId
    && left.credentialClientId === right.credentialClientId
    && left.credentialAudience === right.credentialAudience
    && left.credentialScopes === right.credentialScopes
    && left.credentialSecurityEpoch === right.credentialSecurityEpoch
    && left.credentialExpiresAt === right.credentialExpiresAt
    && left.sessionCredentialIssuer === right.sessionCredentialIssuer
    && left.sessionCredentialId === right.sessionCredentialId
    && left.sessionOAuthClientId === right.sessionOAuthClientId
    && left.sessionPolicyRevision === right.sessionPolicyRevision
    && left.sessionAccountSecurityEpoch === right.sessionAccountSecurityEpoch
    && left.sessionLeaseGeneration === right.sessionLeaseGeneration
    && left.sessionLifecycleRevision === right.sessionLifecycleRevision
    && left.sessionExpiresAt === right.sessionExpiresAt
    && left.sessionStatus === right.sessionStatus
    && left.membershipRole === right.membershipRole
    && left.collectionPolicyRevision === right.collectionPolicyRevision
    && left.collectionContentRevision === right.collectionContentRevision
    && left.collectionDeleted === right.collectionDeleted
    && left.replicaStatus === right.replicaStatus
    && left.replicaLeaseExpiresAt === right.replicaLeaseExpiresAt
    && left.replicaLifecycleRevision === right.replicaLifecycleRevision
    && left.replicaLeaseGeneration === right.replicaLeaseGeneration
    && left.replicaCapabilitiesRead === right.replicaCapabilitiesRead
    && left.bindingIdentity === right.bindingIdentity
    && left.hasPullScope === right.hasPullScope;
}

function resolvePullMembershipRole(
  account: { readonly subject_id: string } | undefined,
  collection: { readonly owner_subject_id: string } | undefined,
  membershipRole: 'owner' | 'editor' | 'viewer' | undefined,
): 'owner' | 'editor' | 'viewer' | null {
  if (account && collection?.owner_subject_id === account.subject_id) return 'owner';
  return membershipRole ?? null;
}

function assertPullAuthorizationOutcome(input: {
  readonly now: Date;
  readonly account: { readonly status: string; readonly security_epoch: bigint | string;
    readonly subject_id: string; readonly id: string } | undefined;
  readonly credential: { readonly revoked_at: Date | null; readonly credential_digest: string;
    readonly subject: string; readonly account_id: string; readonly client_id: string;
    readonly audience: string; readonly scopes_json: unknown; readonly security_epoch: bigint | string;
    readonly credential_expires_at: Date } | undefined;
  readonly session: { readonly credential_issuer: string; readonly credential_id: string;
    readonly oauth_client_id: string; readonly origin: string | null; readonly policy_revision: string;
    readonly account_security_epoch: bigint | string; readonly collection_id: string;
    readonly replica_id: string; readonly lease_generation: bigint | string;
    readonly lifecycle_revision: bigint | string; readonly expires_at: Date; readonly status: string;
    readonly protocol_version: '0.1' | '0.2' };
  readonly collection: { readonly owner_subject_id: string; readonly policy_revision: string;
    readonly content_revision: string; readonly deleted_at: Date | null } | undefined;
  readonly replica: { readonly account_id: string; readonly collection_id: string; readonly status: string;
    readonly lease_expires_at: Date; readonly lifecycle_revision: bigint | string;
    readonly lease_generation: bigint | string; readonly lease_id: string; readonly binding_mode: string;
    readonly browser_profile_id: string; readonly browser_generation: string;
    readonly capabilities_json: { readonly read?: boolean };
    readonly checkpoint_cursor: string | null; readonly checkpoint_commit_ordinal: bigint | null;
    readonly checkpoint_stream_kind: number | null; readonly checkpoint_stable_id: string | null } | undefined;
  readonly binding: { readonly account_id: string; readonly collection_id: string;
    readonly replica_id: string; readonly policy_revision: string; readonly lease_generation: bigint | string;
    readonly lifecycle_revision: bigint | string; readonly lease_id: string; readonly binding_mode: string;
    readonly browser_profile_id: string; readonly browser_generation: string } | undefined;
  readonly membershipRole: 'owner' | 'editor' | 'viewer' | null;
  readonly hasPullScope: boolean;
  readonly request: Pick<SyncPullReadInput, 'credential' | 'sessionId' | 'origin' | 'collectionId' | 'replicaId'>;
}): PullAuthority {
  const role = input.membershipRole;
  const authorized = !!input.account && input.account.status === 'active'
    && BigInt(input.account.security_epoch) === BigInt(input.session.account_security_epoch)
    && !!input.credential && input.credential.revoked_at === null
    && input.credential.credential_digest === input.request.credential.credentialDigest
    && input.credential.subject === input.request.credential.subject
    && input.credential.account_id === input.account.id
    && input.credential.client_id === input.request.credential.clientId
    && input.credential.audience === canonicalAudience(input.request.credential.audience)
    && input.request.credential.scopes.includes('known.sync')
    && Array.isArray(input.credential.scopes_json) && input.credential.scopes_json.includes('known.sync')
    && BigInt(input.credential.security_epoch) === BigInt(input.account.security_epoch)
    && input.credential.credential_expires_at > input.now
    && input.request.credential.credentialExpiresAt > input.now
    && input.request.credential.evidenceExpiresAt > input.now
    && input.session.credential_issuer === input.request.credential.issuer
    && input.session.credential_id === input.request.credential.credentialId
    && input.session.oauth_client_id === input.request.credential.clientId
    && (input.request.origin === undefined || input.session.origin === input.request.origin)
    && !!input.collection && input.collection.deleted_at === null
    && input.collection.policy_revision === input.session.policy_revision
    && (role === 'owner' || role === 'editor' || role === 'viewer') && input.hasPullScope
    && !!input.replica && input.replica.account_id === input.account.id
    && input.replica.collection_id === input.session.collection_id
    && input.replica.capabilities_json.read === true
    && BigInt(input.replica.lease_generation) === BigInt(input.session.lease_generation)
    && (input.replica.status === 'recovery_required'
      || BigInt(input.replica.lifecycle_revision) === BigInt(input.session.lifecycle_revision))
    && !!input.binding && input.binding.account_id === input.account.id
    && input.binding.collection_id === input.session.collection_id
    && input.binding.replica_id === input.session.replica_id
    && input.binding.policy_revision === input.collection.policy_revision
    && BigInt(input.binding.lease_generation) === BigInt(input.replica.lease_generation)
    && (input.replica.status === 'recovery_required'
      || BigInt(input.binding.lifecycle_revision) === BigInt(input.replica.lifecycle_revision))
    && input.binding.lease_id === input.replica.lease_id
    && input.binding.binding_mode === input.replica.binding_mode
    && input.binding.browser_profile_id === input.replica.browser_profile_id
    && input.binding.browser_generation === input.replica.browser_generation;
  if (!authorized) fail('not_found');
  if (input.replica.status === 'retired') fail('replica_retired');
  if (input.replica.status === 'recovery_required') fail('recovery_required');
  if (input.replica.status === 'expired' || input.replica.lease_expires_at <= input.now
      || input.session.status !== 'active' || input.session.expires_at <= input.now) fail('replica_expired');
  if (!(input.replica.status === 'active')) fail('stale_replica');
  return Object.freeze({
    now: input.now,
    accountId: input.account.id,
    policyRevision: input.collection.policy_revision,
    collectionId: input.session.collection_id,
    replicaId: input.session.replica_id,
    collectionRevision: input.collection.content_revision,
    protocolVersion: input.session.protocol_version,
    leaseGeneration: BigInt(input.replica.lease_generation).toString(),
    lifecycleRevision: BigInt(input.replica.lifecycle_revision).toString(),
    checkpointCursor: input.replica.checkpoint_cursor,
    checkpointTuple: input.replica.checkpoint_commit_ordinal === null || input.replica.checkpoint_stream_kind === null
      || input.replica.checkpoint_stable_id === null ? null : Object.freeze({
        commitOrdinal: BigInt(input.replica.checkpoint_commit_ordinal).toString(),
        streamKind: input.replica.checkpoint_stream_kind === 0 ? 'operation' as const : 'conflict' as const,
        stableId: input.replica.checkpoint_stable_id,
      }),
  });
}

export async function readPullAuthoritySnapshot(
  transaction: DatabaseTransaction,
  input: Pick<SyncPullReadInput, 'credential' | 'sessionId' | 'origin' | 'collectionId' | 'replicaId'>,
): Promise<PullAuthoritySnapshot> {
  const bundle = await readUnlockedPullAuthorityBundle(transaction, input);
  const membershipRole = resolvePullMembershipRole(bundle.account, bundle.collection, bundle.memberRole);
  const fingerprint = buildPullAuthorityFingerprint({
    account: bundle.account,
    credential: bundle.credential,
    session: bundle.session,
    collection: bundle.collection,
    replica: bundle.replica,
    binding: bundle.binding,
    membershipRole,
    hasPullScope: bundle.hasPullScope,
  });
  const authority = assertPullAuthorizationOutcome({
    now: bundle.now,
    account: bundle.account,
    credential: bundle.credential,
    session: bundle.session,
    collection: bundle.collection,
    replica: bundle.replica,
    binding: bundle.binding,
    membershipRole,
    hasPullScope: bundle.hasPullScope,
    request: input,
  });
  return Object.freeze({ authority, fingerprint });
}

export async function lockAndRevalidatePullAuthority(
  transaction: DatabaseTransaction,
  input: Pick<SyncPullReadInput, 'credential' | 'sessionId' | 'origin' | 'collectionId' | 'replicaId'>,
  expectedFingerprint: PullAuthorityFingerprint,
): Promise<PullAuthority> {
  const bundle = await readLockedPullAuthorityBundle(transaction, input);
  const membershipRole = resolvePullMembershipRole(bundle.account, bundle.collection, bundle.memberRole);
  const fingerprint = buildPullAuthorityFingerprint({
    account: bundle.account,
    credential: bundle.credential,
    session: bundle.session,
    collection: bundle.collection,
    replica: bundle.replica,
    binding: bundle.binding,
    membershipRole,
    hasPullScope: bundle.hasPullScope,
  });
  if (!pullAuthorityFingerprintsEqual(expectedFingerprint, fingerprint)) {
    // Fingerprint drift between the unlocked snapshot and this locked re-read
    // is advisory, not a denial gate: a benign drift (concurrent Ack lease
    // extension, Collection content revision advance, or membership role shift)
    // leaves the Pull authorized, so re-assert against the locked facts and
    // continue with the fresh fingerprint. The in-lock authority validation is
    // never relaxed - only a genuine revocation, retirement, or lease expiry
    // fails the re-assertion and conceals as 404 (not_found) exactly as before.
    return assertPullAuthorizationOutcome({
      now: bundle.now,
      account: bundle.account,
      credential: bundle.credential,
      session: bundle.session,
      collection: bundle.collection,
      replica: bundle.replica,
      binding: bundle.binding,
      membershipRole,
      hasPullScope: bundle.hasPullScope,
      request: input,
    });
  }
  return assertPullAuthorizationOutcome({
    now: bundle.now,
    account: bundle.account,
    credential: bundle.credential,
    session: bundle.session,
    collection: bundle.collection,
    replica: bundle.replica,
    binding: bundle.binding,
    membershipRole,
    hasPullScope: bundle.hasPullScope,
    request: input,
  });
}

async function readUnlockedPullAuthorityBundle(
  transaction: DatabaseTransaction,
  input: Pick<SyncPullReadInput, 'credential' | 'sessionId' | 'origin' | 'collectionId' | 'replicaId'>,
) {
  return readPullAuthorityBundle(transaction, input, false);
}

async function readLockedPullAuthorityBundle(
  transaction: DatabaseTransaction,
  input: Pick<SyncPullReadInput, 'credential' | 'sessionId' | 'origin' | 'collectionId' | 'replicaId'>,
) {
  return readPullAuthorityBundle(transaction, input, true);
}

async function readPullAuthorityBundle(
  transaction: DatabaseTransaction,
  input: Pick<SyncPullReadInput, 'credential' | 'sessionId' | 'origin' | 'collectionId' | 'replicaId'>,
  lock: boolean,
) {
  const sessionQuery = transaction.selectFrom('sync_sessions').selectAll()
    .where('session_id', '=', input.sessionId);
  const session = await (lock ? sessionQuery.forUpdate() : sessionQuery).executeTakeFirst();
  if (!session) fail('not_found');
  if ((input.collectionId !== undefined && input.collectionId !== session.collection_id)
      || (input.replicaId !== undefined && input.replicaId !== session.replica_id)) fail('not_found');
  const accountQuery = transaction.selectFrom('accounts').selectAll()
    .where('id', '=', session.account_id);
  const account = await (lock ? accountQuery.forUpdate() : accountQuery).executeTakeFirst();
  const credentialQuery = transaction.selectFrom('sync_extension_credentials').selectAll()
    .where('issuer', '=', input.credential.issuer)
    .where('credential_id', '=', input.credential.credentialId);
  const credential = await (lock ? credentialQuery.forUpdate() : credentialQuery).executeTakeFirst();
  const replicaQuery = transaction.selectFrom('sync_replicas').selectAll()
    .where('replica_id', '=', session.replica_id);
  const replica = await (lock ? replicaQuery.forUpdate() : replicaQuery).executeTakeFirst();
  const collectionQuery = transaction.selectFrom('collections')
    .select(['owner_subject_id', 'policy_revision', 'content_revision', 'deleted_at'])
    .where('id', '=', session.collection_id);
  const collection = await (lock ? collectionQuery.forUpdate() : collectionQuery).executeTakeFirst();
  const binding = await transaction.selectFrom('sync_session_bindings').selectAll()
    .where('session_id', '=', input.sessionId).executeTakeFirst();
  const pullScope = await transaction.selectFrom('sync_session_scopes').select('scope')
    .where('session_id', '=', input.sessionId).where('scope', '=', 'sync:pull').executeTakeFirst();
  let memberRole: 'owner' | 'editor' | 'viewer' | undefined;
  if (account && collection?.owner_subject_id === account.subject_id) memberRole = 'owner';
  if (account && !memberRole) {
    const memberQuery = transaction.selectFrom('collection_members').select('role')
      .where('collection_id', '=', session.collection_id).where('subject_id', '=', account.subject_id);
    memberRole = (await (lock ? memberQuery.forUpdate() : memberQuery).executeTakeFirst())?.role;
  }
  const nowResult = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(transaction);
  const now = nowResult.rows[0]?.now;
  if (!(now instanceof Date)) fail('integrity_failure');
  return Object.freeze({
    now, session, account, credential, collection, replica, binding,
    memberRole, hasPullScope: !!pullScope,
  });
}

export async function assertTransactionalPullAuthority(
  transaction: DatabaseTransaction,
  input: Pick<SyncPullReadInput, 'credential' | 'sessionId' | 'origin' | 'collectionId' | 'replicaId'>,
): Promise<PullAuthority> {
  const snapshot = await readPullAuthoritySnapshot(transaction, input);
  return lockAndRevalidatePullAuthority(transaction, input, snapshot.fingerprint);
}

function canonicalAudience(audience: string | readonly string[]): string {
  return typeof audience === 'string' ? audience : [...audience].sort().join(' ');
}

function fail(code: SyncPullReadErrorCode): never {
  throw new SyncPullReadError(code);
}
