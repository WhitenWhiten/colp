import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { VerifiedExtensionCredential } from '../../modules/identity/index.js';

export const replicaReportProofDigest = (proof: string) => createHash('sha256').update(proof, 'utf8').digest('hex');
/** Possession of a server-issued installation proof, plus current account authority. No lease/cursor writes. */
export async function hasReplicaReportAuthority(db: Kysely<DatabaseSchema>, credential: VerifiedExtensionCredential,
  replicaId: string, proof: string | undefined): Promise<boolean> {
  if (typeof proof !== 'string' || !/^[A-Za-z0-9._~:-]{1,256}$/u.test(proof)) return false;
  const row = await db.selectFrom('sync_replica_report_authorities as authority')
    .innerJoin('sync_replicas as replica', 'replica.replica_id', 'authority.replica_id')
    .innerJoin('accounts as account', 'account.id', 'authority.account_id')
    .select(['authority.account_id', 'authority.device_id', 'authority.browser_profile_id', 'authority.browser_generation',
      'authority.account_security_epoch', 'account.security_epoch', 'account.status',
      'replica.device_id as replica_device_id', 'replica.browser_profile_id as replica_profile',
      'replica.browser_generation as replica_generation'])
    .where('authority.proof_digest', '=', replicaReportProofDigest(proof))
    .where('authority.replica_id', '=', replicaId)
    .where('authority.credential_issuer', '=', credential.issuer)
    .where('authority.oauth_client_id', '=', credential.clientId).executeTakeFirst();
  return row !== undefined && row.status === 'active'
    && row.device_id === row.replica_device_id && row.browser_profile_id === row.replica_profile
    && row.browser_generation === row.replica_generation && BigInt(row.account_security_epoch) === BigInt(row.security_epoch);
}
