/**
 * LEGACY STATUS — partial quarantine (Task F1).
 *
 * This file backs the CURRENT product identity row mappers; only
 * `mapOidcLoginTransaction` is legacy OIDC/Logto code, deprecated by the
 * Better Auth migration
 * (docs/development/known-backend/better-auth/better-auth-migration-development-plan.md
 * §12 Task F1; G1 ADR §11). Source retention is NOT runtime enablement.
 * Ownership: Better Auth migration lane F. Keep behavior unchanged.
 */
import type {
  Account,
  AccountIdentity,
  OidcLoginTransaction,
  Profile,
  ProfileHandle,
  Session,
} from '../../modules/identity/index.js';
import type { Selectable } from 'kysely';
import type {
  AccountIdentityTable,
  AccountTable,
  OidcLoginTransactionTable,
  ProfileHandleTable,
  ProfileTable,
  SessionTable,
} from '../database/runtime.js';

export function mapAccount(row: Selectable<AccountTable>): Account {
  return {
    id: row.id,
    subjectId: row.subject_id,
    status: row.status,
    email: row.email,
    securityEpoch: toBigInt(row.security_epoch),
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

export function mapProfile(row: Selectable<ProfileTable>): Profile {
  return {
    accountId: row.account_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    about: row.about,
    updatedAt: row.updated_at,
  };
}

export function mapProfileHandle(row: Selectable<ProfileHandleTable>): ProfileHandle {
  return {
    handle: row.handle,
    accountId: row.account_id,
    createdAt: row.created_at,
  };
}

export function mapAccountIdentity(row: AccountIdentityTable): AccountIdentity {
  return {
    id: row.id,
    accountId: row.account_id,
    issuer: row.issuer,
    subject: row.subject,
    createdAt: row.created_at,
  };
}

export function mapSession(row: SessionTable): Session {
  return {
    id: row.id,
    accountId: row.account_id,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    csrfTokenHash: row.csrf_token_hash,
    tokenHash: row.token_hash,
    securityEpoch: toBigInt(row.security_epoch),
    rotatedFromSessionId: row.rotated_from_session_id,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

/**
 * @deprecated Legacy OIDC login transaction row mapper (Task F1 quarantine).
 */
export function mapOidcLoginTransaction(row: OidcLoginTransactionTable): OidcLoginTransaction {
  if (row.code_challenge_method !== 'S256') {
    throw new TypeError('unsupported OIDC code_challenge_method');
  }
  return {
    // Browser secrets are not stored; state identity is the digest until materialize.
    state: row.state_hash,
    nonce: '',
    codeVerifier: '',
    returnTo: row.return_to,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    codeChallengeMethod: 'S256',
    stateHash: row.state_hash,
    nonceHash: row.nonce_hash,
    pkceVerifierCiphertext: Buffer.from(row.pkce_verifier_ciphertext),
    encryptionKeyId: row.encryption_key_id,
    encryptionKeyVersion: Number(row.encryption_key_version),
  };
}

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  return BigInt(value);
}
