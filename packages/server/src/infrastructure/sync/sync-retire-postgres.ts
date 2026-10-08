import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  SyncRetireError,
  validateVerifiedExtensionCredential,
  type SyncRetireApplication,
  type SyncRetireApplicationInput,
} from '../../modules/sync/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { lockCollectionReplicaGate } from '../database/lock-order.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import {
  retireReplicaInTransaction,
  type ReplicaLifecycleFaultPhase,
} from './replica-lifecycle-postgres.js';

export type SyncRetireFaultPhase = 'receipt' | 'replica' | 'sessions' | 'audit';

export interface PostgresReplicaRetirementOptions {
  readonly faultInjector?: {
    readonly afterPhase?: (phase: SyncRetireFaultPhase) => void | Promise<void>;
  };
}

const TOKEN = /^[A-Za-z0-9._~-]{1,512}$/u;

export function createPostgresReplicaRetirementApplication(
  db: Kysely<DatabaseSchema>,
  options: PostgresReplicaRetirementOptions = {},
): SyncRetireApplication {
  return Object.freeze({
    async retireExtension(input: SyncRetireApplicationInput): Promise<void> {
      validateInput(input);
      await createUnitOfWork(db).execute(async ({ transaction }) => {
        await retireExtensionTransaction(transaction, input, options);
      });
    },
  });
}

async function retireExtensionTransaction(
  transaction: DatabaseTransaction,
  input: SyncRetireApplicationInput,
  options: PostgresReplicaRetirementOptions,
): Promise<void> {
  const session = await transaction.selectFrom('sync_sessions').selectAll()
    .where('session_id', '=', input.sessionId).forUpdate().executeTakeFirst();
  if (!session) deny('resource_not_found');
  const account = await transaction.selectFrom('accounts').selectAll().where('id', '=', session.account_id)
    .forUpdate().executeTakeFirst();
  const credential = await transaction.selectFrom('sync_extension_credentials').selectAll()
    .where('issuer', '=', input.credential.issuer)
    .where('credential_id', '=', input.credential.credentialId).forUpdate().executeTakeFirst();
  await lockCollectionReplicaGate(transaction, session.collection_id);
  const replica = await transaction.selectFrom('sync_replicas').selectAll()
    .where('replica_id', '=', session.replica_id).forUpdate().executeTakeFirst();
  const collection = await transaction.selectFrom('collections')
    .select(['owner_subject_id', 'policy_revision', 'deleted_at'])
    .where('id', '=', session.collection_id).forUpdate().executeTakeFirst();
  const binding = await transaction.selectFrom('sync_session_bindings').selectAll()
    .where('session_id', '=', session.session_id).executeTakeFirst();
  const nowResult = await sql<{ now: Date }>`select current_timestamp as now`.execute(transaction);
  const now = nowResult.rows[0]?.now;
  if (!(now instanceof Date)) deny('internal_error');
  if (!account || !credential || !collection || !replica || !binding) deny('resource_not_found');
  const role = collection.owner_subject_id === account.subject_id
    ? 'owner'
    : await transaction.selectFrom('collection_members').select('role')
      .where('collection_id', '=', session.collection_id)
      .where('subject_id', '=', account.subject_id).executeTakeFirst().then((row) => row?.role);
  // The Session must be active and unexpired. Lifecycle equality is required
  // only while the Replica is active, so a recovery retire can still proceed.
  const sessionMayRetire = session.status === 'active'
    && session.expires_at.getTime() > now.getTime()
    && (replica.status !== 'active'
      || BigInt(session.lifecycle_revision) === BigInt(replica.lifecycle_revision));
  const principalAuthorized = account.status === 'active'
    && collection.deleted_at === null
    && collection.policy_revision === session.policy_revision
    && role !== undefined
    && session.account_id === replica.account_id
    && session.collection_id === replica.collection_id
    && session.credential_issuer === input.credential.issuer
    && session.credential_id === input.credential.credentialId
    // Bind retirement to the exact Origin recorded when this Sync session was
    // issued. The application contract requires callers to provide it.
    && session.origin === input.origin
    && session.oauth_client_id === input.credential.clientId
    && credential.account_id === account.id
    && credential.subject === input.credential.subject
    && credential.client_id === input.credential.clientId
    && credential.audience === canonicalAudience(input.credential.audience)
    && credential.credential_digest === input.credential.credentialDigest
    && credential.revoked_at === null
    && credential.credential_expires_at.getTime() > now.getTime()
    && input.credential.credentialExpiresAt.getTime() > now.getTime()
    && input.credential.evidenceExpiresAt.getTime() > now.getTime()
    && BigInt(credential.security_epoch) === BigInt(account.security_epoch)
    && BigInt(session.account_security_epoch) === BigInt(account.security_epoch)
    && binding.account_id === account.id
    && binding.collection_id === replica.collection_id
    && binding.replica_id === replica.replica_id
    && BigInt(binding.lease_generation) === BigInt(replica.lease_generation)
    && BigInt(session.lease_generation) === BigInt(replica.lease_generation)
    && binding.lease_id === replica.lease_id;
  const authorized = principalAuthorized && sessionMayRetire;
  if (!principalAuthorized) deny('resource_not_found');

  const requestDigest = digest(input.requestFingerprint);
  const existing = await transaction.selectFrom('sync_replica_retirement_receipts').selectAll()
    .where('replica_id', '=', replica.replica_id)
    .where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (existing) {
    if (existing.principal_id !== account.id || existing.request_digest !== requestDigest
        || existing.session_id !== input.sessionId || existing.collection_id !== replica.collection_id
        || BigInt(existing.lease_generation) !== BigInt(replica.lease_generation)) {
      deny('idempotency_key_reused');
    }
    if (replica.status !== 'retired' || replica.retired_at === null
        || BigInt(existing.retired_lifecycle_revision) !== BigInt(replica.lifecycle_revision)) {
      deny('internal_error');
    }
    const expectedResultDigest = digest(
      `retired\n${replica.replica_id}\n${BigInt(existing.retired_lifecycle_revision).toString()}`,
    );
    if (existing.result_digest !== expectedResultDigest) deny('internal_error');
    return;
  }
  if (replica.status === 'retired' || replica.retired_at !== null) deny('replica_retired');
  // Receipt replay returned above. That retirement terminates the Session, so
  // liveness is required only for a call that would still change the Replica.
  if (!authorized) deny('resource_not_found');

  const lifecycleFaultInjector = {
    async afterPhase(phase: ReplicaLifecycleFaultPhase) {
      if (phase === 'replica') await options.faultInjector?.afterPhase?.('replica');
      if (phase === 'audit') await options.faultInjector?.afterPhase?.('audit');
    },
  };
  const result = await retireReplicaInTransaction(transaction, {
    accountId: account.id,
    collectionId: replica.collection_id,
    replicaId: replica.replica_id,
    expectedLeaseGeneration: BigInt(replica.lease_generation).toString(),
    expectedLifecycleRevision: BigInt(replica.lifecycle_revision).toString(),
  }, { faultInjector: lifecycleFaultInjector, auditPrincipalId: account.id });
  if (result.state !== 'committed' || result.checkpoint.lifecycle !== 'retired') {
    deny(result.state === 'denied' && result.code === 'stale_replica' ? 'stale_replica' : 'internal_error');
  }
  const retiredRevision = BigInt(replica.lifecycle_revision) + 1n;
  const resultDigest = digest(`retired\n${replica.replica_id}\n${retiredRevision.toString()}`);
  await transaction.insertInto('sync_replica_retirement_receipts').values({
    replica_id: replica.replica_id,
    idempotency_key: input.idempotencyKey,
    principal_id: account.id,
    request_digest: requestDigest,
    session_id: session.session_id,
    collection_id: replica.collection_id,
    lease_generation: replica.lease_generation,
    retired_lifecycle_revision: retiredRevision,
    result_digest: resultDigest,
    completed_at: now,
  }).execute();
  await options.faultInjector?.afterPhase?.('receipt');
  await transaction.updateTable('sync_sessions').set({
    status: 'terminated', termination_reason: 'administrative', terminated_at: now,
  }).where('replica_id', '=', replica.replica_id).where('status', '=', 'active').execute();
  await transaction.deleteFrom('sync_pull_cursor_recovery_proofs')
    .where('replica_id', '=', replica.replica_id).execute();
  await transaction.updateTable('sync_pull_cursor_evidence').set({ cursor: null })
    .where('replica_id', '=', replica.replica_id).where('cursor', 'is not', null).execute();
  await options.faultInjector?.afterPhase?.('sessions');
}

function validateInput(input: SyncRetireApplicationInput): void {
  validateVerifiedExtensionCredential(input.credential);
  if (typeof input.origin !== 'string' || input.origin.length < 1 || input.origin.length > 2_048
      || !TOKEN.test(input.sessionId) || !TOKEN.test(input.idempotencyKey)
      || typeof input.requestFingerprint !== 'string' || input.requestFingerprint.length < 1
      || input.requestFingerprint.length > 4_096) deny('internal_error');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalAudience(value: string | readonly string[]): string {
  return typeof value === 'string' ? value : [...value].sort().join(' ');
}

function deny(code: ConstructorParameters<typeof SyncRetireError>[0]): never {
  throw new SyncRetireError(code);
}
