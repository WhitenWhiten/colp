import type { Generated, GeneratedAlways } from 'kysely';

export interface AccountTable {
  id: string;
  subject_id: string;
  status: 'active' | 'disabled' | 'deleted';
  email: string | null;
  security_epoch: bigint;
  security_epoch_bumped_at: Generated<Date | null>;
  created_at: Date;
  deleted_at: Date | null;
}

export interface ProfileTable {
  account_id: string;
  display_name: string;
  avatar_url: string | null;
  about: Generated<string>;
  search_display_name: Generated<string>;
  search_display_vector: Generated<unknown>;
  updated_at: Date;
}

export interface ProfileHandleTable {
  handle: string;
  account_id: string;
  search_handle: Generated<string>;
  created_at: Date;
}

export interface AccountIdentityTable {
  id: string;
  account_id: string;
  issuer: string;
  subject: string;
  created_at: Date;
}

export interface SessionTable {
  id: string;
  account_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  csrf_token_hash: string;
  token_hash: string;
  security_epoch: bigint;
  rotated_from_session_id: string | null;
  last_seen_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

/**
 * Contracted OIDC login transaction: protected digests + PKCE ciphertext only.
 * Raw state/nonce/code_verifier columns are removed (cannot store browser secrets).
 */
export interface OidcLoginTransactionTable {
  /** Keyed digest of browser state (primary key). */
  state_hash: string;
  /** Keyed digest of browser nonce. */
  nonce_hash: string;
  /** Authenticated ciphertext of PKCE code_verifier. */
  pkce_verifier_ciphertext: Buffer;
  /** Encryption key reference id (not the key material). */
  encryption_key_id: string;
  /** Encryption key version for rotation. */
  encryption_key_version: number;
  return_to: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  code_challenge_method: string;
}

/**
 * B1 expand: Better Auth 1.6.29 authentication user (library schema
 * transcription, migration 202609050900_better_auth_schema). Column names are
 * the Better Auth runtime contract (quoted camelCase) and must not be renamed.
 */
export interface AuthUserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** G2 username plugin. Null for email-only rows created before a username was set. */
  username: string | null;
}

/** B1 expand + T-02: Better Auth 1.7.1 credential / provider account rows. */
export interface AuthAccountTable {
  id: string;
  accountId: string;
  providerId: string;
  issuer: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  password: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** B1 expand: Better Auth 1.6.29 browser session carrier. */
export interface AuthSessionTable {
  id: string;
  expiresAt: Date;
  token: string;
  /** Keyed equality lookup for the encrypted token; null only on legacy rows. */
  tokenLookupHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

/** B1 expand: Better Auth 1.6.29 OTP / reset proof storage. */
export interface AuthVerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * B1 expand: bidirectional 1:1 mapping between a Better Auth user and a
 * Know-N business account (G1 ADR §15). auth_user_id is the primary key;
 * account_id has its own UNIQUE.
 */
export interface AuthUserAccountMapTable {
  auth_user_id: string;
  account_id: string;
  created_at: Date;
}

/**
 * B1 expand: Know-N idle/absolute/epoch/CSRF facts for a Better Auth session
 * plus the predecessor CAS single-winner claim (G1 ADR §13, R1/R2/R3).
 */
export interface KnownAuthSessionMetadataTable {
  auth_session_id: string;
  /** sha256 digest of the logical BA token (never of its encrypted DB envelope). */
  session_token_hash: string;
  account_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  security_epoch: bigint;
  csrf_token_hash: string;
  predecessor_session_id: string | null;
  last_seen_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

/**
 * B1 expand: permanent legacy OIDC identity archive (issuer/subject/account
 * evidence facts only; no access/refresh token, code or secret column).
 */
export interface LegacyOidcIdentityArchiveTable {
  id: GeneratedAlways<bigint>;
  issuer: string;
  subject: string;
  account_id: string;
  migration_source: string;
  email_verified_claim: boolean;
  migrated_at: Date;
  retention_until: Date;
}
