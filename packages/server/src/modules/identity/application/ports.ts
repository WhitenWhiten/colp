import type { ProductCommandReceiptPort } from '../../commands/index.js';
import type { OidcTransactionSecretsPort } from '../domain/oidc-transaction-crypto.js';
import type { SessionRotationSecretsPort } from '../domain/secrets.js';
import type {
  Account,
  AccountIdentity,
  AccountWithProfile,
  OidcLoginTransaction,
  Profile,
  ProfileHandle,
  Session,
} from '../domain/types.js';

/**
 * Transaction-bound identity repositories.
 * The Unit of Work (or admission layer) creates one set of ports per transaction.
 */
export interface AccountRepository {
  findById(id: string): Promise<Account | null>;
  findBySubjectId(subjectId: string): Promise<Account | null>;
  /**
   * Lookup by product email. Used for conflict checks when applying a trusted
   * OIDC email claim. Implementations should match the stored value exactly.
   */
  findByEmail(email: string): Promise<Account | null>;
  insert(account: Account): Promise<void>;
  /** Atomically increments security_epoch and returns the new value. */
  bumpSecurityEpoch(accountId: string): Promise<bigint>;
  updateEmail(accountId: string, email: string | null): Promise<void>;
  /**
   * P10 irreversible soft-delete: `status = 'deleted'`, `deletedAt` set, and
   * `email = null` so `accounts_email_unique` (`WHERE email IS NOT NULL`)
   * cannot block a later signup of the same mailbox.
   */
  markDeleted(accountId: string, deletedAt: Date): Promise<void>;
}

/**
 * SC-01 mailbox-proof lookup. Caller supplies already-normalized
 * `lower(trim(email))`. Misses and unverified occupancy both return null;
 * never throws "user does not exist".
 */
export interface VerifiedActiveAccountByEmail {
  readonly id: string;
  readonly subjectId: string;
  readonly email: string;
}

export interface VerifiedAccountEmailPort {
  findVerifiedActiveAccountByEmail(email: string): Promise<VerifiedActiveAccountByEmail | null>;
}

export interface AccountIdentityRepository {
  findByIssuerSubject(issuer: string, subject: string): Promise<AccountIdentity | null>;
  findByAccountId(accountId: string): Promise<AccountIdentity | null>;
  insert(identity: AccountIdentity): Promise<void>;
  /**
   * Inserts when (issuer, subject) is free. Returns the row that owns the binding
   * (inserted or pre-existing). Does not abort the transaction on conflict.
   */
  insertIfAbsent(identity: AccountIdentity): Promise<AccountIdentity>;
}

export interface ProfileRepository {
  findByAccountId(accountId: string): Promise<Profile | null>;
  insert(profile: Profile): Promise<void>;
  update(profile: Profile): Promise<void>;
}

export interface ProfileHandleRepository {
  findByHandle(handle: string): Promise<ProfileHandle | null>;
  findByAccountId(accountId: string): Promise<ProfileHandle | null>;
  insert(handle: ProfileHandle): Promise<void>;
  /** Returns true when this call reserved the handle; false on conflict. */
  tryInsert(handle: ProfileHandle): Promise<boolean>;
  deleteByAccountId(accountId: string): Promise<boolean>;
  deleteByHandle(handle: string): Promise<boolean>;
}

export interface SessionRepository {
  findById(id: string): Promise<Session | null>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  /**
   * Live (non-revoked) successor created by rotating `predecessorSessionId`.
   * Used so concurrent rotation losers resolve to the single winner without minting.
   */
  findLiveSuccessorByRotatedFrom(predecessorSessionId: string): Promise<Session | null>;
  insert(session: Session): Promise<void>;
  /**
   * Compare-and-swap revoke: sets revoked_at when currently null.
   * Returns true if this call won the revoke (single-winner claim for rotation).
   * Idempotent: already-revoked sessions return false without error.
   */
  revoke(sessionId: string, revokedAt: Date): Promise<boolean>;
  /** Updates last_seen_at and idle_expires_at when session is still live. */
  touch(sessionId: string, lastSeenAt: Date, idleExpiresAt: Date): Promise<boolean>;
  revokeAllForAccount(accountId: string, revokedAt: Date): Promise<number>;
}

export interface OidcLoginTransactionRepository {
  insert(transaction: OidcLoginTransaction): Promise<void>;
  /**
   * Race-safe one-time consume: marks consumed_at only when still open and unexpired.
   * Lookup is by state_hash = stateDigest only (contracted schema).
   * Returns the payload on success; null when missing, expired, or already consumed.
   * Callers distinguish miss/expired/consumed via a follow-up read when needed.
   */
  consume(
    browserState: string,
    now: Date,
    stateDigest: string,
  ): Promise<OidcLoginTransaction | null>;
  findByState(browserState: string, stateDigest: string): Promise<OidcLoginTransaction | null>;
  deleteByState(browserState: string, stateDigest: string): Promise<boolean>;
}

/** Database wall clock for expiry and audit timestamps. */
export interface IdentityClock {
  now(): Promise<Date>;
}

/**
 * System purge of pending unbound collaboration invites after a product
 * email leaves a mailbox (OIDC trusted-email sync / P9 change-email).
 * Bound invites stay subject-bound. Optional so existing `as IdentityPorts`
 * fakes keep compiling; production Postgres ports always wire it.
 */
export interface PendingUnboundInvitePurgePort {
  revokePendingUnboundInvitesByEmail(emailNormalized: string, now: Date): Promise<number>;
}

export interface IdentityPorts {
  readonly accounts: AccountRepository;
  readonly accountIdentities: AccountIdentityRepository;
  readonly profiles: ProfileRepository;
  readonly handles: ProfileHandleRepository;
  readonly sessions: SessionRepository;
  readonly oidcLoginTransactions: OidcLoginTransactionRepository;
  readonly oidcTransactionSecrets: OidcTransactionSecretsPort;
  readonly sessionRotationSecrets: SessionRotationSecretsPort;
  readonly clock: IdentityClock;
  readonly receipts: ProductCommandReceiptPort;
  readonly pendingUnboundInvites?: PendingUnboundInvitePurgePort;
}

/**
 * Module-owned unit of work. Implementation lives in infrastructure and must not
 * leak Kysely/pg types into the identity module.
 */
export interface IdentityUnitOfWork {
  execute<Result>(work: (ports: IdentityPorts) => Promise<Result>): Promise<Result>;
}

export type { AccountWithProfile };
