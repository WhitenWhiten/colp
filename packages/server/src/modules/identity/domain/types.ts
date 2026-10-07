export type AccountStatus = 'active' | 'disabled' | 'deleted';

export interface Account {
  readonly id: string;
  readonly subjectId: string;
  readonly status: AccountStatus;
  readonly email: string | null;
  readonly securityEpoch: bigint;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

export interface Profile {
  readonly accountId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  /** Public self-introduction. Empty string when unset. */
  readonly about: string;
  readonly updatedAt: Date;
}

export interface ProfileHandle {
  readonly handle: string;
  readonly accountId: string;
  readonly createdAt: Date;
}

export interface AccountIdentity {
  readonly id: string;
  readonly accountId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly createdAt: Date;
}

export interface Session {
  readonly id: string;
  readonly accountId: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly csrfTokenHash: string;
  readonly tokenHash: string;
  readonly securityEpoch: bigint;
  readonly rotatedFromSessionId: string | null;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * OIDC login transaction (contracted protected-secrets shape).
 *
 * At rest: only digests + PKCE ciphertext (+ key metadata). Browser state/nonce
 * and the raw PKCE verifier exist only in memory after create/materialize.
 */
export interface OidcLoginTransaction {
  /**
   * In-memory browser state after create/materialize; for persisted rows this
   * equals stateHash until materialize replaces it with the browser value.
   */
  readonly state: string;
  /**
   * In-memory browser nonce after create; not recoverable from storage
   * (verify id_token nonce via nonceHash). Empty string when loaded from DB.
   */
  readonly nonce: string;
  /**
   * In-memory PKCE verifier after create/materialize; empty until decrypted.
   */
  readonly codeVerifier: string;
  readonly returnTo: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly codeChallengeMethod: 'S256';
  /** Keyed digest of browser state (storage primary key / lookup). */
  readonly stateHash: string;
  /** Keyed digest of browser nonce (id_token nonce verification). */
  readonly nonceHash: string;
  /** AEAD ciphertext of PKCE code_verifier. */
  readonly pkceVerifierCiphertext: Buffer;
  readonly encryptionKeyId: string;
  readonly encryptionKeyVersion: number;
}

export interface AccountWithProfile {
  readonly account: Account;
  readonly profile: Profile;
  readonly handle: ProfileHandle | null;
  readonly identity: AccountIdentity | null;
}

/**
 * A2 expand: bidirectional 1:1 mapping between one Better Auth user
 * (auth_users.id) and one Know-N business account (accounts.id). Row shape of
 * `auth_user_account_map` (G1 ADR §15; migration 202609050910).
 */
export interface AuthUserAccountMapping {
  readonly authUserId: string;
  readonly accountId: string;
  readonly createdAt: Date;
}

/**
 * A2 expand: a Better Auth user resolved to its business account together
 * with the account's profile and handle (auth_user_account_map + accounts +
 * profiles + profile_handles). profile/handle are null only when the business
 * account is missing its lifecycle rows (corruption); accounts created by the
 * A2 ensure facade always have both because they are written in the same
 * transaction.
 */
export interface MappedBusinessAccount {
  readonly mapping: AuthUserAccountMapping;
  readonly account: Account;
  readonly profile: Profile | null;
  readonly handle: ProfileHandle | null;
}

export interface SessionExpiryWindow {
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface IssuedSessionSecrets {
  readonly session: Session;
  /** Raw session secret for cookie transport only; never persist or log. */
  readonly rawSessionToken: string;
  /** Raw CSRF token for bootstrap response only; never persist or log. */
  readonly rawCsrfToken: string;
}
