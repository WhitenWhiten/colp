import { sql } from 'kysely';
import { isVerifiedExtensionCredential, type VerifiedExtensionCredential } from '../../modules/identity/index.js';
import { AutomationError, type AutomationDeviceActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { lockSyncReplicaBeforeCollection } from '../database/lock-order.js';

export interface BridgeAuthorityDependencies {
  hasReplicaAuthority(tx: DatabaseTransaction, credential: VerifiedExtensionCredential, replicaId: string, proof: string): Promise<boolean>;
  isCredentialRevoked(tx: DatabaseTransaction, credential: VerifiedExtensionCredential): Promise<boolean>;
}

/** Installation possession and a live account credential grant bridge access,
 * without renewing a Sync session, replica lease or cursor. */
export async function authorizeAutomationBridgeDevice(tx: DatabaseTransaction, input: {
  credential: VerifiedExtensionCredential; replicaId: string; replicaProof: string; origin: string;
}, dependencies: BridgeAuthorityDependencies): Promise<AutomationDeviceActor> {
  const deny = (): never => { throw new AutomationError('insufficient_permission', 'Current browser installation authority is unavailable.'); };
  const { credential } = input;
  if (!isVerifiedExtensionCredential(credential) || !credential.scopes.includes('known.sync')) return deny();
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now;
  if (credential.evidenceExpiresAt <= now || credential.credentialExpiresAt <= now) return deny();
  const account = await tx.selectFrom('account_identities as identity').innerJoin('accounts as account', 'account.id', 'identity.account_id')
    .select(['account.id', 'account.subject_id', 'account.status', 'account.deleted_at'])
    .where('identity.issuer', '=', credential.issuer).where('identity.subject', '=', credential.subject).forUpdate('account').executeTakeFirst();
  if (!account || account.status !== 'active' || account.deleted_at || await dependencies.isCredentialRevoked(tx, credential)) return deny();
  await lockSyncReplicaBeforeCollection(tx, input.replicaId);
  const replica = await tx.selectFrom('sync_replicas').selectAll().where('replica_id', '=', input.replicaId).executeTakeFirst();
  if (!replica || replica.account_id !== account.id || !['active', 'recovery_required'].includes(replica.status)
    || !await dependencies.hasReplicaAuthority(tx, credential, input.replicaId, input.replicaProof)) return deny();
  const collection = await tx.selectFrom('collections').select(['owner_subject_id', 'deleted_at'])
    .where('id', '=', replica.collection_id).forShare().executeTakeFirst();
  if (!collection || collection.deleted_at || collection.owner_subject_id !== account.subject_id) return deny();
  return { accountId: account.id, subjectId: account.subject_id, deviceId: replica.device_id, replicaId: replica.replica_id,
    replicaGeneration: String(replica.lease_generation), collectionId: replica.collection_id, sessionId: `bridge:${replica.replica_id}` };
}
