import { sql } from 'kysely';
import type { SyncSequenceAdmissionInput } from '../../modules/sync/index.js';
import { lockCollectionReplicaGate } from '../database/lock-order.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { persistenceError } from './sync-sequence-persistence-error.js';

export interface SequenceAuthority {
  readonly accountId: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly leaseGeneration: string;
}

interface LockedSequenceAuthority {
  readonly authority: Readonly<SequenceAuthority>;
  readonly sessionExpiresAt: Date;
  readonly credentialExpiresAt: readonly Date[];
  readonly leaseExpiresAt: Date;
}

export async function lockAuthority(
  transaction: DatabaseTransaction,
  input: Readonly<SyncSequenceAdmissionInput>,
): Promise<LockedSequenceAuthority> {
  // Sequence writes fail closed: holding a Session id is not enough to mutate
  // lanes. Every lock must re-check credential digest, security epoch, push
  // scope, and editor+/owner membership from locked rows.
  const transactionalAuthority = input.transactionalAuthority;
  if (transactionalAuthority === undefined) persistenceError('authorization_denied');
  const credential = transactionalAuthority.credential;
  // FIX-L-032: the Session/Replica generation is classified from locked rows
  // inside the Sequence owner transaction. The admission pre-read is advisory
  // only: filtering on it here would turn a concurrent resume/retire into a
  // misleading not_found instead of the stable stale_replica outcome.
  const session = await transaction.selectFrom('sync_sessions').selectAll()
    .where('session_id', '=', input.session.sessionId).forUpdate().executeTakeFirst();
  if (!session || session.collection_id !== input.session.collectionId
      || session.replica_id !== input.replicaId) persistenceError('not_found');
  // FIX-L-032: classify the Session's current generation from the locked row.
  if (BigInt(session.lease_generation) !== BigInt(input.leaseGeneration)) {
    persistenceError('stale_replica');
  }
  const account = await transaction.selectFrom('accounts').selectAll()
    .where('id', '=', session.account_id).forUpdate().executeTakeFirst();
  const storedCredential = await transaction.selectFrom('sync_extension_credentials').selectAll()
    .where('issuer', '=', credential.issuer)
    .where('credential_id', '=', credential.credentialId).forUpdate().executeTakeFirst();
  await lockCollectionReplicaGate(transaction, session.collection_id);
  const replica = await transaction.selectFrom('sync_replicas').selectAll()
    .where('replica_id', '=', session.replica_id).forUpdate().executeTakeFirst();
  const binding = await transaction.selectFrom('sync_session_bindings').selectAll()
    .where('session_id', '=', session.session_id).executeTakeFirst();
  const collection = await transaction.selectFrom('collections').select([
    'owner_subject_id', 'policy_revision', 'deleted_at',
  ]).where('id', '=', session.collection_id).forUpdate().executeTakeFirst();
  const scope = await transaction.selectFrom('sync_session_scopes').select('scope')
    .where('session_id', '=', session.session_id).where('scope', '=', 'sync:push').executeTakeFirst();
  const member = account && collection?.owner_subject_id !== account.subject_id
    ? await transaction.selectFrom('collection_members').select('role')
      .where('collection_id', '=', session.collection_id)
      .where('subject_id', '=', account.subject_id).forUpdate().executeTakeFirst()
    : undefined;
  const role = collection?.owner_subject_id === account?.subject_id ? 'owner' : member?.role;
  if (session.status !== 'active') {
    persistenceError('session_expired');
  }
  if (!replica) persistenceError('not_found');
  if (replica.status === 'retired') persistenceError('replica_retired');
  if (BigInt(replica.lease_generation) !== BigInt(session.lease_generation)) {
    persistenceError('stale_replica');
  }
  const credentialActive = !!account && account.status === 'active'
    && input.session.principal.type === 'user'
    && input.session.principal.id === session.principal_subject_id
    && input.session.credential.kind === 'token'
    && input.session.credential.id === credential.credentialId
    && input.session.oauthClientId === credential.clientId
    && input.session.origin === transactionalAuthority.origin
    && BigInt(session.account_security_epoch) === BigInt(account.security_epoch)
    && session.credential_issuer === credential.issuer
    && session.credential_id === credential.credentialId
    && session.oauth_client_id === credential.clientId
    && !!storedCredential
    && storedCredential.account_id === account.id
    && storedCredential.subject === credential.subject
    && storedCredential.client_id === credential.clientId
    && storedCredential.audience === canonicalAudience(credential.audience)
    && credential.scopes.includes('known.sync')
    && Array.isArray(storedCredential.scopes_json)
    && storedCredential.scopes_json.includes('known.sync')
    && storedCredential.credential_digest === credential.credentialDigest
    && BigInt(storedCredential.security_epoch) === BigInt(account.security_epoch)
    && storedCredential.revoked_at === null;
  if (!credentialActive) persistenceError('authorization_denied');
  const authorized = !!collection && collection.deleted_at === null
    && collection.policy_revision === session.policy_revision
    && (role === 'owner' || role === 'editor')
    && scope?.scope === 'sync:push'
    && input.session.authorizationScopes.includes('sync:push')
    && replica.status === 'active'
    && replica.capabilities_json.write === true
    && replica.capabilities_json.maxBatchOperations === 1
    && replica.account_id === session.account_id
    && replica.collection_id === session.collection_id
    && BigInt(replica.lease_generation) === BigInt(session.lease_generation)
    && replica.lease_id === session.lease_id
    && BigInt(replica.lifecycle_revision) === BigInt(session.lifecycle_revision)
    && !!binding
    && binding.account_id === session.account_id
    && binding.collection_id === session.collection_id
    && binding.replica_id === session.replica_id
    && BigInt(binding.lease_generation) === BigInt(replica.lease_generation)
    && binding.lease_id === replica.lease_id
    && BigInt(binding.lifecycle_revision) === BigInt(replica.lifecycle_revision)
    && binding.policy_revision === collection.policy_revision
    && binding.binding_mode === replica.binding_mode
    && binding.browser_profile_id === replica.browser_profile_id
    && binding.browser_generation === replica.browser_generation;
  if (!authorized) persistenceError('stale_replica');
  return Object.freeze({
    authority: Object.freeze({
      accountId: session.account_id,
      collectionId: session.collection_id,
      replicaId: session.replica_id,
      leaseGeneration: String(session.lease_generation),
    }),
    sessionExpiresAt: session.expires_at,
    credentialExpiresAt: [storedCredential.credential_expires_at, credential.credentialExpiresAt, credential.evidenceExpiresAt],
    leaseExpiresAt: replica.lease_expires_at,
  });
}

/** Authorize at the post-lock evaluation boundary, never at transaction start. */
export async function assertAuthorityUnexpired(transaction: DatabaseTransaction, locked: LockedSequenceAuthority): Promise<void> {
  const result = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(transaction);
  const now = result.rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) persistenceError('integrity_failure');
  const live = (expiry: Date): boolean => expiry.getTime() > now.getTime();
  if (!live(locked.sessionExpiresAt)) persistenceError('session_expired');
  if (!locked.credentialExpiresAt.every(live)) persistenceError('authorization_denied');
  if (!live(locked.leaseExpiresAt)) persistenceError('stale_replica');
}

function canonicalAudience(audience: string | readonly string[]): string {
  return typeof audience === 'string' ? audience : [...audience].sort().join(' ');
}

export async function lockLane(
  transaction: DatabaseTransaction,
  input: Readonly<SyncSequenceAdmissionInput>,
  authority: SequenceAuthority,
): Promise<void> {
  await sql`
    insert into sync_sequence_lanes (replica_id,collection_id,sequence_scope)
    values (${authority.replicaId},${authority.collectionId},${input.sequenceScope})
    on conflict (replica_id,sequence_scope) do nothing
  `.execute(transaction);
  const locked = await sql<Record<string, unknown>>`
    select replica_id,collection_id,sequence_scope from sync_sequence_lanes
    where replica_id=${authority.replicaId} and sequence_scope=${input.sequenceScope}
    for update
  `.execute(transaction);
  const row = locked.rows[0];
  if (!row || row.collection_id !== authority.collectionId) persistenceError('integrity_failure');
}
