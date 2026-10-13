import { sql } from 'kysely';
import { isVerifiedExtensionCredential, type VerifiedExtensionCredential } from '../../modules/identity/index.js';
import { AutomationError, type AutomationDeviceActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { lockSyncReplicaBeforeCollection } from '../database/lock-order.js';
const deny = (): never => { throw new AutomationError('insufficient_permission', 'Current device session authority is unavailable.'); };
/** Reuse existing Sync bearer/session/device binding, including revocation and generation fences. */
export async function authorizeAutomationDevice(tx: DatabaseTransaction,
  input: { credential: VerifiedExtensionCredential; sessionId: string; origin: string }): Promise<AutomationDeviceActor> {
  const { credential } = input;
  if (!isVerifiedExtensionCredential(credential) || !credential.scopes.includes('known.sync')) deny();
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now;
  if (credential.evidenceExpiresAt <= now || credential.credentialExpiresAt <= now) deny();
  const session = await tx.selectFrom('sync_sessions').selectAll().where('session_id', '=', input.sessionId).forUpdate().executeTakeFirst();
  if (!session || session.status !== 'active' || session.expires_at <= now || session.origin !== input.origin
    || session.credential_issuer !== credential.issuer || session.credential_id !== credential.credentialId
    || session.oauth_client_id !== credential.clientId) return deny();
  const account = await tx.selectFrom('accounts').selectAll().where('id', '=', session.account_id).forUpdate().executeTakeFirst();
  if (!account || account.status !== 'active' || account.deleted_at || BigInt(account.security_epoch) !== BigInt(session.account_security_epoch)) return deny();
  const proof = await tx.selectFrom('sync_extension_credentials').selectAll().where('issuer', '=', credential.issuer)
    .where('credential_id', '=', credential.credentialId).forUpdate().executeTakeFirst();
  if (!proof || proof.account_id !== account.id || proof.revoked_at || proof.subject !== credential.subject
    || proof.client_id !== credential.clientId || proof.credential_digest !== credential.credentialDigest
    || proof.credential_expires_at <= now || BigInt(proof.security_epoch) !== BigInt(account.security_epoch)) return deny();
  const scope = await tx.selectFrom('sync_session_scopes').select('scope').where('session_id', '=', session.session_id)
    .where('scope', '=', 'sync:push').executeTakeFirst();
  if (!scope) return deny();
  await lockSyncReplicaBeforeCollection(tx, session.replica_id);
  const replica = await tx.selectFrom('sync_replicas').selectAll().where('replica_id', '=', session.replica_id).executeTakeFirstOrThrow();
  if (!['active', 'recovery_required'].includes(replica.status) || replica.account_id !== account.id || replica.collection_id !== session.collection_id
    || replica.lease_expires_at <= now || BigInt(replica.lease_generation) !== BigInt(session.lease_generation) || replica.lease_id !== session.lease_id) return deny();
  const collection = await tx.selectFrom('collections').select(['owner_subject_id', 'deleted_at']).where('id', '=', session.collection_id).forShare().executeTakeFirst();
  if (!collection || collection.deleted_at || collection.owner_subject_id !== account.subject_id) return deny();
  return { accountId: account.id, subjectId: account.subject_id, deviceId: replica.device_id, replicaId: replica.replica_id,
    replicaGeneration: String(replica.lease_generation), collectionId: replica.collection_id, sessionId: session.session_id };
}
