/**
 * Task A3: transaction-bound ports for the BrowserSessionAuthority.
 *
 * The application facade (browser-session-authority.ts) is the ONLY product
 * session port; these ports are the low-level seams it consumes. Nothing here
 * exposes Better Auth user/session objects: the authority maps the Better Auth
 * session record onto the product `Account`/`Session` domain types, and the
 * transport never sees `better-auth` types (plan §4.2; A3 file boundary).
 *
 * Storage contract (G1 ADR §7/§12/§13; migration 202609050920):
 * - `session_token_hash` is the sha256 digest of the logical BA token; the raw
 *   token lives only in the signed cookie/process while the BA row is protected at rest;
 * - `csrf_token_hash` is the digest of the purpose-separated product CSRF token;
 * - idle/absolute/epoch/revoked facts and the predecessor CAS single-winner
 *   claim live in `known_auth_session_metadata`, never in the BA tables.
 */
import type {
  AccountRepository,
  IdentityClock,
  SessionRepository,
} from '../../identity/index.js';
import type { BusinessAccountMappingRepository } from './business-account-mapping.js';

/** Minimal transport-agnostic request view consumed by the authority. */
export interface BrowserSessionRequest {
  /** Raw Cookie header value; undefined when the header is absent. */
  readonly cookie?: string;
}

/**
 * Structural mirror of the Better Auth session record the authority needs.
 * Deliberately NOT the BA session type: the facade and its callers depend on
 * this stable product-side shape, so the BA library type cannot leak into
 * modules/auth or transport (plan §4.2).
 */
export interface BetterAuthSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly token: string;
  readonly expiresAt: Date;
  /**
   * Mailbox proof on the BA user. `false` is never a product actor (P1
   * invariant A/D). Omitted on older test fakes is treated as proven so
   * existing authority unit tests stay focused on cookie/metadata checks.
   */
  readonly emailVerified?: boolean;
}

/**
 * Server-side Better Auth operations (infrastructure implements this with the
 * real 1.7.1 `auth.api`). `getSession` is the authoritative carrier check:
 * it verifies the signed cookie, resolves the session row and rejects
 * missing/expired sessions (BA deletes expired rows itself — spike §3.4).
 */
export interface BetterAuthServerPort {
  /** Authoritative session lookup by the request cookie. Null when absent/invalid/expired. */
  getSession(request: BrowserSessionRequest): Promise<BetterAuthSessionRecord | null>;
  /** Revoke the session addressed by the request cookie. Idempotent (spike §3.4). */
  signOut(request: BrowserSessionRequest): Promise<void>;
}

/** One `known_auth_session_metadata` row (product security facts). */
export interface BrowserSessionMetadataRow {
  readonly authSessionId: string;
  /** sha256 hex digest of the BA session token (R1 compensation). */
  readonly sessionTokenHash: string;
  readonly accountId: string;
  readonly idleExpiresAt: Date;
  /** Never extended by refresh/touch/rotation (G1 §7). */
  readonly absoluteExpiresAt: Date;
  readonly securityEpoch: bigint;
  readonly csrfTokenHash: string;
  readonly predecessorSessionId: string | null;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * A successor Better Auth session minted by the rotation path: the BA session
 * row plus the signed cookie value the browser must hold. The raw cookie value
 * is returned exactly once (winner response / CAS-loser convergence) and never
 * persisted by the product (R1).
 */
export interface MintedSuccessorSession {
  readonly session: BetterAuthSessionRecord;
  readonly rawCookieValue: string;
}

/**
 * The rotation predecessor CAS was lost: another concurrent rotator already
 * claimed the same predecessor (partial unique index on
 * `predecessor_session_id`). The application facade resolves the winner via
 * `findSuccessorCookie` instead of minting a second successor.
 */
export class RotationCasConflictError extends Error {
  constructor(message = 'rotation predecessor was already claimed by a concurrent rotator') {
    super(message);
    this.name = 'RotationCasConflictError';
  }
}

/**
 * Transaction-bound store for the product session facts and the BA carrier
 * rows the authority manages (metadata CRUD + CAS + successor minting).
 */
export interface BrowserSessionMetadataStore {
  findByTokenHash(tokenHash: string): Promise<BrowserSessionMetadataRow | null>;
  /**
   * Inserts the metadata row. A unique violation on the predecessor partial
   * index surfaces as RotationCasConflictError — the calling transaction is
   * aborted by PostgreSQL, so callers re-resolve in a fresh transaction.
   */
  insert(row: BrowserSessionMetadataRow): Promise<void>;
  /** CAS revoke: sets revoked_at only when currently null. False when already revoked. */
  markRevoked(authSessionId: string, revokedAt: Date): Promise<boolean>;
  /** CAS touch: slides last_seen_at/idle only while the row is live. False when revoked. */
  touch(authSessionId: string, lastSeenAt: Date, idleExpiresAt: Date): Promise<boolean>;
  /** The single live successor metadata row of a rotated predecessor (CAS winner). */
  findByPredecessor(predecessorSessionId: string): Promise<BrowserSessionMetadataRow | null>;
  revokeAllForAccount(accountId: string, revokedAt: Date): Promise<number>;
  /**
   * Mints a successor BA session row (auth_sessions) inside the calling
   * transaction and returns the signed cookie value. Row shape mirrors BA
   * 1.7.1 `internalAdapter.createSession` (generateId-style id/token).
   */
  mintSuccessorSession(input: { readonly userId: string; readonly now: Date }): Promise<MintedSuccessorSession>;
  /**
   * CAS-loser convergence: decrypt the winner's protected successor token and
   * rebuild the signed cookie for the predecessor link.
   */
  findSuccessorCookie(predecessorSessionId: string): Promise<MintedSuccessorSession | null>;
  /** Revokes every BA session row of the account's auth user (revoke-all). */
  deleteAuthSessionsForAccount(accountId: string): Promise<number>;
  /**
   * Password-change keep-current: mark every live metadata row of the
   * account revoked EXCEPT the session that just replaced the others.
   */
  revokeOthersForAccount(
    accountId: string,
    keepAuthSessionId: string,
    revokedAt: Date,
  ): Promise<number>;
  /** Align the kept session's epoch snapshot after a password-change bump. */
  alignMetadataEpoch(authSessionId: string, securityEpoch: bigint): Promise<boolean>;
  /** Delete every BA session row of the account except the kept successor. */
  deleteAuthSessionsForAccountExcept(
    accountId: string,
    keepAuthSessionId: string,
  ): Promise<number>;
  /**
   * Live (not revoked) metadata rows for the account that still have a BA
   * `auth_sessions` carrier. Newest `last_seen_at` first, then
   * `auth_session_id` DESC, capped at `BROWSER_SESSION_LIVE_CAP` (P-07).
   * Never returns tokens (P4 / R9).
   */
  listLiveForAccount(
    accountId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly BrowserSessionMetadataRow[]>;
  /**
   * Kick oldest live sessions until the account is at `cap`. Oldest =
   * smallest `last_seen_at`, then smallest `auth_session_id`. Never
   * revokes `keepAuthSessionId` and never bumps `security_epoch` (P-07).
   * Revokes metadata and deletes the BA `auth_sessions` row.
   */
  evictOldestLiveForAccount(input: {
    readonly accountId: string;
    readonly keepAuthSessionId: string;
    readonly now: Date;
    readonly cap: number;
  }): Promise<number>;
  /**
   * Live metadata for one BA session id, or null when missing/revoked/no
   * carrier row. Ownership is checked by the authority (no existence leak).
   */
  findLiveByAuthSessionId(authSessionId: string): Promise<BrowserSessionMetadataRow | null>;
  /** Delete one BA `auth_sessions` row by id. False when the row was already gone. */
  deleteAuthSessionById(authSessionId: string): Promise<boolean>;
  /**
   * P5: drop Better Auth 1.7.1 2FA trust-device verification rows for every
   * auth user mapped to the account. Identifiers are hashed
   * (`storeIdentifier: 'hashed'`), so this deletes `auth_verifications` where
   * `value` is the auth user id — a copied `known.trust_device` cookie then
   * cannot skip TOTP. Does not touch `auth_two_factor` or `twoFactorEnabled`.
   */
  deleteTrustDeviceStateForAccount(accountId: string): Promise<number>;
}

/**
 * Transaction-bound ports handed to the authority's unit of work. The Better
 * Auth server port is deliberately NOT here: it runs outside product
 * transactions (its adapter opens its own transactions on the shared Kysely
 * instance — G0 spike §4.8), so the authority receives it at construction.
 */
export interface BrowserSessionAuthorityPorts {
  readonly store: BrowserSessionMetadataStore;
  readonly mappings: BusinessAccountMappingRepository;
  readonly accounts: AccountRepository;
  /** Legacy product sessions (revoke-all only; never an authentication authority). */
  readonly sessions: SessionRepository;
  readonly clock: IdentityClock;
}

/** Module-owned unit of work for browser session authority flows. */
export interface BrowserSessionUnitOfWork {
  execute<Result>(work: (ports: BrowserSessionAuthorityPorts) => Promise<Result>): Promise<Result>;
}
