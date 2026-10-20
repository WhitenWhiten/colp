import type { Selectable } from 'kysely';
import type { SyncRetireApplicationInput } from '../../modules/sync/index.js';
import type { SyncExtensionCredentialTable, SyncSessionTable } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { isJoseSyncCredentialRevoked } from './postgres/sync-jose-credential-revocation-postgres.js';
import { hasReplicaReportAuthority, replicaReportProofDigest } from './replica-report-authority.js';

/**
 * Explicit reset reauthorization, under the retirement transaction's account
 * and replica locks. The old Session identifies the installation; it grants no
 * current account authority. The route must still verify the current credential.
 */
export async function reauthorizeReplicaRetirement(transaction: DatabaseTransaction,
  input: SyncRetireApplicationInput, session: Selectable<SyncSessionTable>,
  credential: Selectable<SyncExtensionCredentialTable> | undefined, now: Date): Promise<boolean> {
  const current = input.credential;
  if (input.replicaProof !== input.sessionId || !current.scopes.includes('known.sync')
    || current.credentialExpiresAt.getTime() <= now.getTime() || current.evidenceExpiresAt.getTime() <= now.getTime()
    || current.credentialIssuedAt.getTime() >= current.credentialExpiresAt.getTime()
    || current.verifiedAt.getTime() > now.getTime() + 60_000) return false;
  const identity = await transaction.selectFrom('account_identities').select('account_id')
    .where('issuer', '=', current.issuer).where('subject', '=', current.subject).executeTakeFirst();
  if (identity?.account_id !== session.account_id) return false;
  const proof = await transaction.selectFrom('sync_replica_report_authorities').select('account_id')
    .where('proof_digest', '=', replicaReportProofDigest(input.replicaProof)).where('replica_id', '=', session.replica_id).executeTakeFirst();
  if (proof?.account_id !== session.account_id) return false;
  // Keep the original endpoint's audience/client binding even when the current
  // credential has never minted a Sync Session. Expiry of the old token is fine.
  const original = await transaction.selectFrom('sync_extension_credentials').selectAll()
    .where('issuer', '=', session.credential_issuer).where('credential_id', '=', session.credential_id).executeTakeFirst();
  const audience = typeof current.audience === 'string' ? current.audience : [...current.audience].sort().join(' ');
  if (!original || original.account_id !== session.account_id || original.client_id !== current.clientId
    || original.audience !== audience) return false;
  if (credential && (credential.account_id !== session.account_id || credential.subject !== current.subject
    || credential.client_id !== current.clientId || credential.audience !== audience
    || credential.credential_expires_at.getTime() <= now.getTime())) return false;
  if (await isJoseSyncCredentialRevoked(transaction, {
    issuer: current.issuer, subject: current.subject, tokenId: current.credentialId,
    tokenDigest: current.credentialDigest, issuedAtSeconds: Math.floor(current.credentialIssuedAt.getTime() / 1_000),
    clockSkewSeconds: 0,
  })) return false;
  return hasReplicaReportAuthority(transaction, current, session.replica_id, input.replicaProof);
}
