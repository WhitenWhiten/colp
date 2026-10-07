import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../../database/runtime.js';

/**
 * Compact-JWS revocation used by the Sync credential verifier.
 *
 * A matching row is revoked when `revoked_at` is set, the digest does not
 * match, the account is not active, or the credential's bind-time
 * `security_epoch` no longer equals `accounts.security_epoch`.
 *
 * A missing row is the first-bind window: look up the account through
 * `account_identities` (issuer+subject). No mapping, or an inactive account,
 * is revoked. After an epoch bump, signed `iat` is compared to
 * `security_epoch_bumped_at` as whole seconds with strict less-than and no
 * JWT skew (same-second iat is not revoked). Bound rows use epoch equality
 * and do not use this branch. Epoch 0 with a NULL stamp stays admitted.
 * Epoch > 0 with a missing stamp fails closed.
 */
export interface JoseSyncCredentialRevocationQuery {
  readonly issuer: string;
  readonly subject: string;
  readonly tokenId: string;
  readonly tokenDigest: string;
  readonly issuedAtSeconds: number;
  readonly clockSkewSeconds: number;
}

export async function isJoseSyncCredentialRevoked(
  db: Kysely<DatabaseSchema>,
  input: JoseSyncCredentialRevocationQuery,
): Promise<boolean> {
  const record = await db.selectFrom('sync_extension_credentials as credential')
    .innerJoin('accounts as account', 'account.id', 'credential.account_id')
    .select([
      'credential.credential_digest',
      'credential.revoked_at',
      'credential.security_epoch as credential_security_epoch',
      'account.security_epoch as account_security_epoch',
      'account.status as account_status',
    ])
    .where('credential.issuer', '=', input.issuer)
    .where('credential.credential_id', '=', input.tokenId)
    .executeTakeFirst();
  if (record !== undefined) {
    return record.revoked_at !== null
      || record.credential_digest !== input.tokenDigest
      || record.account_status !== 'active'
      || BigInt(record.credential_security_epoch) !== BigInt(record.account_security_epoch);
  }
  return isNeverBoundJoseSyncCredentialRevoked(db, input);
}

async function isNeverBoundJoseSyncCredentialRevoked(
  db: Kysely<DatabaseSchema>,
  input: JoseSyncCredentialRevocationQuery,
): Promise<boolean> {
  if (typeof input.subject !== 'string' || input.subject === '') return true;
  const account = await db.selectFrom('account_identities as identity')
    .innerJoin('accounts as account', 'account.id', 'identity.account_id')
    .select([
      'account.status as account_status',
      'account.security_epoch as security_epoch',
      'account.security_epoch_bumped_at as security_epoch_bumped_at',
    ])
    .where('identity.issuer', '=', input.issuer)
    .where('identity.subject', '=', input.subject)
    .executeTakeFirst();
  if (account === undefined) return true;
  if (account.account_status !== 'active') return true;
  const bumpedAt = account.security_epoch_bumped_at;
  if (bumpedAt === null) return BigInt(account.security_epoch) !== 0n;
  if (!(bumpedAt instanceof Date) || Number.isNaN(bumpedAt.getTime())) return true;
  if (typeof input.issuedAtSeconds !== 'number' || !Number.isSafeInteger(input.issuedAtSeconds)) {
    return true;
  }
  // clockSkewSeconds is the JWT exp/nbf/iat tolerance. Revocation does not add it.
  return input.issuedAtSeconds < Math.floor(bumpedAt.getTime() / 1_000);
}
