import type { VerifiedExtensionCredential } from '../../modules/identity/index.js';
import type { SyncExtensionCredentialTable } from '../database/runtime.js';

type StoredCredential = Pick<SyncExtensionCredentialTable,
  'issuer' | 'credential_id' | 'credential_digest' | 'subject' | 'account_id' | 'client_id'
  | 'audience' | 'scopes_json' | 'credential_expires_at' | 'revoked_at'> & {
    readonly security_epoch: bigint | string;
  };

/** Cached verification expiry is not an authorization deadline. Every request
 * supplies fresh verifier evidence; the durable row owns identity and revocation. */
export function syncCredentialIsAuthorized(
  stored: StoredCredential | undefined,
  credential: VerifiedExtensionCredential,
  account: { readonly id: string; readonly security_epoch: bigint | string } | undefined,
  now: Date,
): boolean {
  return !!stored && !!account && stored.revoked_at === null
    && stored.issuer === credential.issuer && stored.credential_id === credential.credentialId
    && stored.credential_digest === credential.credentialDigest
    && stored.subject === credential.subject && stored.account_id === account.id
    && stored.client_id === credential.clientId
    && stored.audience === (typeof credential.audience === 'string'
      ? credential.audience : [...credential.audience].sort().join(' '))
    && Array.isArray(stored.scopes_json) && stored.scopes_json.includes('known.sync')
    && credential.scopes.includes('known.sync')
    && BigInt(stored.security_epoch) === BigInt(account.security_epoch)
    && stored.credential_expires_at > now && credential.credentialExpiresAt > now
    && credential.verifiedAt <= now && credential.evidenceExpiresAt > now;
}
