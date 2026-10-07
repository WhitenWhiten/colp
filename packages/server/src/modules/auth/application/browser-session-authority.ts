/**
 * Task A3: BrowserSessionAuthority — the ONLY product-facing browser session
 * port (plan §4.2; A3 file boundary).
 *
 * The authority authenticates product routes against the Better Auth 1.7.1
 * browser session (single `__Host-known_session` cookie, G1 §4) plus the
 * `known_auth_session_metadata` product facts (idle/absolute/epoch/CSRF hash/
 * predecessor CAS). It never exposes Better Auth user/session types: callers
 * receive the product `Account` plus a product `Session`-shaped view that is
 * shape-compatible with the legacy `AuthenticatedSession` so the existing
 * `requireSessionActor` callers keep working unchanged (plan §8 Task A3).
 *
 * Security contract:
 * - duplicate `__Host-known_session` cookies and malformed percent-encoding
 *   fail closed (R3/FIX-L-003 semantics — BA 1.7.1 itself is first-wins);
 * - the BA carrier check (`auth.api.getSession`) is authoritative for the
 *   cookie signature and the session row; the metadata row is authoritative
 *   for idle/absolute/epoch/revoked; a live BA session WITHOUT metadata never
 *   authenticates (orphan sessions are rejected, legacy `sessions` rows are
 *   never consulted — plan A3 假阳性防护);
 * - the product CSRF token is derived purpose-separated from the BA session
 *   token (HMAC-SHA256 with a dedicated purpose tag); only its sha256 digest
 *   is stored (`csrf_token_hash`); the raw token is returned once by
 *   bootstrap (G0 §4.2; R1);
 * - rotation mints ONE successor per predecessor: the metadata partial unique
 *   index on `predecessor_session_id` is the CAS; losers converge to the
 *   winner's successor cookie; the predecessor absolute deadline is preserved
 *   (G1 §7), and the predecessor metadata row is marked revoked (audit fact,
 *   G1 §14) while its BA row remains the FK anchor until BA-side expiry;
 * - C4: the MFA pending challenge cookie (`known.two_factor`) is never a
 *   session — BA deletes the session row when the 2FA challenge starts, and
 *   the authority rejects any request that carries only the challenge cookie
 *   (the pending 2FA session must not become a full business session).
 */
import { createHmac } from 'node:crypto';
import {
  computeSlidIdleExpiry,
  hashSecret,
  hashesMatch,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_ROTATION_MIN_AGE_MS,
  SESSION_TOUCH_MIN_INTERVAL_MS,
  type Account,
  type Session,
} from '../../identity/index.js';
import { assertAccountUsable } from './business-account-mapping.js';
import {
  RotationCasConflictError,
  type BrowserSessionAuthorityPorts,
  type BrowserSessionMetadataRow,
  type BrowserSessionRequest,
  type BrowserSessionUnitOfWork,
  type BetterAuthServerPort,
  type BetterAuthSessionRecord,
} from './ports.js';

/** Frozen single browser session cookie name (G1 §4; mirror of transport/session-cookie.ts). */
export const BROWSER_SESSION_COOKIE_NAME = '__Host-known_session';

/**
 * MFA pending challenge cookie (Better Auth two-factor plugin 1.7.1,
 * cookiePrefix 'known'): `known.two_factor`. The pending challenge is NOT a
 * session — BA deletes the auth_sessions row when the challenge starts and
 * keeps only a single-use verification row + this signed cookie (plugin
 * source; G0 §3.2 contract). The authority therefore never authenticates a
 * request that carries only this cookie (C4: MFA pending session is never a
 * full business session).
 */
export const BROWSER_SESSION_MFA_CHALLENGE_COOKIE_NAME = 'known.two_factor';

/**
 * 2FA trust-device cookie (Better Auth two-factor plugin 1.7.1,
 * cookiePrefix 'known'): `known.trust_device`. Pair of a signed cookie and an
 * `auth_verifications` row (`trust-device-<random>`, hashed identifier, value
 * = auth user id). Password change / reset / revokeAll must drop that row so
 * a copied cookie cannot skip TOTP (Invariant F / P5).
 */
export const BROWSER_SESSION_TRUST_DEVICE_COOKIE_NAME = 'known.trust_device';

/**
 * Concurrent live Better Auth sessions per account (P-07). Overflow kicks
 * the oldest live row; a new login is never refused.
 */
export const BROWSER_SESSION_LIVE_CAP = 50;

/** Newest-first inventory order: `last_seen_at DESC, auth_session_id DESC`. */
function compareLiveSessionNewestFirst(
  left: BrowserSessionMetadataRow,
  right: BrowserSessionMetadataRow,
): number {
  const seen = right.lastSeenAt.getTime() - left.lastSeenAt.getTime();
  if (seen !== 0) return seen;
  if (left.authSessionId < right.authSessionId) return 1;
  if (left.authSessionId > right.authSessionId) return -1;
  return 0;
}

export function resolveBrowserSessionInventoryLimit(
  options?: { readonly limit?: number },
): number {
  const requested = options?.limit;
  if (requested === undefined || !Number.isInteger(requested) || requested <= 0) {
    return BROWSER_SESSION_LIVE_CAP;
  }
  return Math.min(requested, BROWSER_SESSION_LIVE_CAP);
}

/** Sort + cap used by in-memory stores to match the PostgreSQL inventory query. */
export function rankLiveSessionsForInventory(
  rows: readonly BrowserSessionMetadataRow[],
  limit: number = BROWSER_SESSION_LIVE_CAP,
): BrowserSessionMetadataRow[] {
  return [...rows].sort(compareLiveSessionNewestFirst).slice(0, resolveBrowserSessionInventoryLimit({ limit }));
}

/** Oldest-first overflow victims, excluding the session that must stay. */
export function selectOldestLiveSessionsToEvict(
  live: readonly BrowserSessionMetadataRow[],
  input: { readonly keepAuthSessionId: string; readonly cap: number },
): BrowserSessionMetadataRow[] {
  const overflow = live.length - input.cap;
  if (overflow <= 0) return [];
  return live
    .filter((row) => row.authSessionId !== input.keepAuthSessionId)
    .sort((left, right) => compareLiveSessionNewestFirst(right, left))
    .slice(0, overflow);
}

/**
 * True when the request carries the MFA pending challenge cookie. The
 * challenge cookie name is distinct from the session cookie (case-sensitive
 * contract), so a challenge alone parses as an absent session cookie — this
 * helper makes the pending-session rejection explicit and testable.
 */
export function hasBrowserSessionMfaChallenge(cookieHeader: string | undefined): boolean {
  if (cookieHeader === undefined) return false;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === BROWSER_SESSION_MFA_CHALLENGE_COOKIE_NAME) return true;
  }
  return false;
}

/** Purpose tag so BA session-token material cannot be reused as product CSRF directly. */
const BROWSER_SESSION_CSRF_PURPOSE = 'known-browser-session-csrf-v1';

export type BrowserSessionCookieParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly value: string }
  | { readonly kind: 'parse-error' };

/**
 * FIX-L-003 fail-closed cookie parse: the session cookie name is case-sensitive
 * and must occur exactly once; >1 occurrences or malformed percent-encoding of
 * its value is a parse error. BA 1.7.1 is first-wins on duplicates (spike
 * §3.2/R3), so the authority MUST reject them itself.
 */
export function parseBrowserSessionCookie(cookieHeader: string | undefined): BrowserSessionCookieParseResult {
  if (cookieHeader === undefined) return { kind: 'absent' };
  let value: string | null = null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    if (name !== BROWSER_SESSION_COOKIE_NAME) continue;
    if (value !== null) return { kind: 'parse-error' };
    try {
      value = decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return { kind: 'parse-error' };
    }
  }
  return value === null ? { kind: 'absent' } : { kind: 'present', value };
}

/**
 * Extract the BA session token from the signed cookie value
 * (`<token>.<HMAC signature>`). Mirrors BA's own `getSignedCookie` split at the
 * LAST dot; a missing/empty token part fails closed (the BA check would also
 * reject it).
 */
export function browserSessionTokenOf(cookieValue: string): string | null {
  const dot = cookieValue.lastIndexOf('.');
  if (dot < 1) return null;
  return cookieValue.slice(0, dot);
}

/** sha256 hex digest of the BA session token (metadata `session_token_hash`, R1). */
export function browserSessionTokenHash(sessionToken: string): string {
  return hashSecret(sessionToken);
}

/**
 * Build the Cookie header carrying the signed BA cookie value, exactly as the
 * browser would send it back after a Set-Cookie (`buildSessionSetCookie`
 * percent-encodes the value; the server-side parsers decode it). The raw
 * signed value alone is NOT a valid Cookie header: the base64 signature
 * contains `=`, which a header parser would split into `name=value` pairs
 * whose name never matches the session cookie name (silently absent).
 */
export function browserSessionCookieHeader(cookieValue: string): string {
  return `${BROWSER_SESSION_COOKIE_NAME}=${encodeURIComponent(cookieValue)}`;
}

/**
 * Purpose-separated product CSRF derivation from the BA session token. The
 * token is stable across BA refresh (the cookie signature covers only the
 * token), so the derived CSRF can be re-issued by bootstrap without rotation.
 * Cross-site attackers that only auto-include the HttpOnly cookie cannot
 * compute it.
 */
export function deriveBrowserSessionCsrfTokenRaw(sessionToken: string): string {
  if (!sessionToken) {
    throw new Error('session token is required to derive the product csrf token');
  }
  return createHmac('sha256', sessionToken)
    .update(BROWSER_SESSION_CSRF_PURPOSE, 'utf8')
    .digest('base64url');
}

/** sha256 digest stored as `csrf_token_hash`; the raw CSRF is never persisted. */
export function browserSessionCsrfTokenHash(rawCsrfToken: string): string {
  return hashSecret(rawCsrfToken);
}

/** Stable classification for authority failures (transport maps to product errors). */
export class BrowserSessionAuthenticationError extends Error {
  readonly code: 'authentication_required' | 'account_not_found' | 'verification_required';

  constructor(code: BrowserSessionAuthenticationError['code'], message: string) {
    super(message);
    this.name = 'BrowserSessionAuthenticationError';
    this.code = code;
  }
}

/**
 * Authenticated product actor. Deliberately exposes NO Better Auth user/session
 * types: the `account` is the product business account and `session` is the
 * product-shaped view (shape-compatible with the legacy AuthenticatedSession).
 */
export interface AuthenticatedBrowserActor {
  readonly account: Account;
  readonly session: Session;
}

export type BrowserSessionBootstrapResult =
  | {
      readonly authenticated: false;
      /**
       * True when a Better Auth occupancy cookie is present but email is not
       * verified. Omitted when there is no usable occupancy (C-02).
       */
      readonly verificationRequired?: true;
    }
  | {
      readonly authenticated: true;
      readonly account: Account;
      readonly session: Session;
      /** Raw product CSRF token — returned once; never persisted (plan §4.2). */
      readonly csrfToken: string;
      readonly idleExpiresAt: Date;
      readonly absoluteExpiresAt: Date;
      /**
       * True when secrets rotated. Only the CAS winner mints a successor;
       * concurrent losers converge to the winner's cookie value, so every
       * rotated response carries the SAME `rotatedCookieValue`.
       */
      readonly rotated: boolean;
      /** Signed successor cookie value to Set-Cookie when rotated. */
      readonly rotatedCookieValue?: string;
    };

export interface BrowserSessionRevokeAllResult {
  readonly securityEpoch: bigint;
  readonly revokedAuthSessions: number;
  readonly revokedLegacySessions: number;
}

/**
 * Product session inventory item (P4). `id` is the BA / metadata
 * `authSessionId`. Never includes a token (R9).
 */
export interface BrowserSessionListItem {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly current: boolean;
}

export type RevokeBrowserSessionByIdResult =
  | { readonly kind: 'current' }
  | { readonly kind: 'other' }
  | { readonly kind: 'not_found' };

/**
 * The product-facing session port (plan §4.2). Implementation lives in
 * infrastructure (better-auth-session-authority.ts); transport consumes only
 * this interface and the `AuthenticatedBrowserActor` shape.
 */
export interface BrowserSessionAuthority {
  /** Authenticate the browser session; occupancy and missing sessions return null. */
  authenticate(
    request: BrowserSessionRequest,
    options?: { readonly touch?: boolean },
  ): Promise<AuthenticatedBrowserActor | null>;
  /** requireMutationActor throws verification_required for occupancy, authentication_required otherwise. */
  requireMutationActor(
    request: BrowserSessionRequest,
    options?: { readonly touch?: boolean },
  ): Promise<AuthenticatedBrowserActor>;
  /**
   * GET /session bootstrap: re-issue CSRF without rotating below the rotation
   * age threshold; CAS single-winner rotate at/above it (or converge to a
   * concurrent winner). Does not idle-slide (`last_seen` / idle TTL) — GET
   * `/me` is the heartbeat (C-07). Rotation minting a successor may set the
   * successor's `lastSeenAt` to now; that is not a throttle-touch of the
   * predecessor. Never throws for authentication failures.
   */
  bootstrap(request: BrowserSessionRequest): Promise<BrowserSessionBootstrapResult>;
  /** Logout: mark the metadata revoked, then revoke the BA session. Idempotent. */
  signOut(request: BrowserSessionRequest): Promise<void>;
  /**
   * Security revoke-all: epoch bump + BA session revoke + legacy sessions
   * revoke + 2FA trust-device verification rows (P5 / Invariant F).
   */
  revokeAll(accountId: string): Promise<BrowserSessionRevokeAllResult>;
  /**
   * Password change: bump the account epoch, revoke every other browser /
   * legacy session, drop 2FA trust-device state (P5), and keep the successor
   * BA session that Better Auth just minted so the current tab stays signed in.
   */
  revokeOthersKeepingCurrent(input: {
    readonly authUserId: string;
    readonly currentAuthSessionId: string;
  }): Promise<BrowserSessionRevokeAllResult>;
  /**
   * Live sessions for the account (P4). `current` is true for
   * `currentAuthSessionId`. Items never carry a token.
   */
  listLiveSessions(input: {
    readonly accountId: string;
    readonly currentAuthSessionId: string;
  }): Promise<readonly BrowserSessionListItem[]>;
  /**
   * Revoke one session by BA/metadata id. Current session uses signOut.
   * Other devices delete that BA row only — no security_epoch bump.
   */
  revokeSessionById(input: {
    readonly request: BrowserSessionRequest;
    readonly sessionId: string;
    readonly accountId: string;
    readonly currentAuthSessionId: string;
  }): Promise<RevokeBrowserSessionByIdResult>;
}

export interface CreateBrowserSessionAuthorityOptions {
  readonly unitOfWork: BrowserSessionUnitOfWork;
  readonly betterAuth: BetterAuthServerPort;
  /** Override SESSION_IDLE_TTL_MS for tests / future config. */
  readonly idleTtlMs?: number;
  readonly absoluteTtlMs?: number;
  readonly rotationMinAgeMs?: number;
  readonly touchMinIntervalMs?: number;
}

/** Internal signal: the predecessor was (or just became) rotated — resolve the winner. */
class SuccessorResolutionRequired extends Error {
  readonly predecessorAuthSessionId: string;

  constructor(predecessorAuthSessionId: string) {
    super('session was rotated by a concurrent winner; resolve the successor');
    this.name = 'SuccessorResolutionRequired';
    this.predecessorAuthSessionId = predecessorAuthSessionId;
  }
}

function authenticationRequired(): BrowserSessionAuthenticationError {
  return new BrowserSessionAuthenticationError(
    'authentication_required',
    'a valid browser session is required',
  );
}

function verificationRequired(): BrowserSessionAuthenticationError {
  return new BrowserSessionAuthenticationError(
    'verification_required',
    'email verification is required',
  );
}

function unauthenticatedBootstrap(occupancy: boolean): Extract<
  BrowserSessionBootstrapResult,
  { readonly authenticated: false }
> {
  return occupancy
    ? { authenticated: false, verificationRequired: true }
    : { authenticated: false };
}

function toSessionView(metadata: BrowserSessionMetadataRow, accountId: string): Session {
  return {
    id: metadata.authSessionId,
    accountId,
    idleExpiresAt: metadata.idleExpiresAt,
    absoluteExpiresAt: metadata.absoluteExpiresAt,
    csrfTokenHash: metadata.csrfTokenHash,
    tokenHash: metadata.sessionTokenHash,
    securityEpoch: metadata.securityEpoch,
    rotatedFromSessionId: metadata.predecessorSessionId,
    lastSeenAt: metadata.lastSeenAt,
    revokedAt: metadata.revokedAt,
    createdAt: metadata.createdAt,
  };
}

function isExpired(metadata: BrowserSessionMetadataRow, now: Date): boolean {
  return now.getTime() >= metadata.idleExpiresAt.getTime()
    || now.getTime() >= metadata.absoluteExpiresAt.getTime();
}

/**
 * Full product-side usability check on an already BA-validated session:
 * Checks revocation, expiry, mapping, account status, epoch and CSRF digest.
 * Optionally slides idle expiry. Invalid authority throws; expired sessions
 * return null after recording revocation so the transaction commits (G1 §14).
 */
/** Self-hosted sign-up does not verify email. The column stays false; the mapped session is still an actor. */
function unverifiedSessionBlocksProductActor(): boolean {
  return process.env.KNOWN_EDITION !== 'self-hosted';
}

async function loadUsableActor(
  ports: BrowserSessionAuthorityPorts,
  metadata: BrowserSessionMetadataRow,
  baSession: BetterAuthSessionRecord,
  options: { readonly touch: boolean; readonly idleTtlMs: number; readonly touchMinIntervalMs: number },
): Promise<AuthenticatedBrowserActor | null> {
  if (baSession.emailVerified === false && unverifiedSessionBlocksProductActor()) throw verificationRequired();
  if (metadata.revokedAt !== null) throw authenticationRequired();
  const now = await ports.clock.now();
  if (isExpired(metadata, now)) {
    await ports.store.markRevoked(metadata.authSessionId, now);
    return null;
  }
  const mapping = await ports.mappings.findByAuthUserId(baSession.userId);
  if (!mapping || mapping.accountId !== metadata.accountId) throw authenticationRequired();
  const account = await ports.accounts.findById(mapping.accountId);
  if (!account) throw authenticationRequired();
  try {
    assertAccountUsable(account);
  } catch {
    throw authenticationRequired();
  }
  if (account.securityEpoch !== metadata.securityEpoch) throw authenticationRequired();
  if (!hashesMatch(browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(baSession.token)), metadata.csrfTokenHash)) {
    throw authenticationRequired();
  }

  let live = metadata;
  if (options.touch) {
    if (now.getTime() - metadata.lastSeenAt.getTime() >= options.touchMinIntervalMs) {
      const idleExpiresAt = computeSlidIdleExpiry(now, metadata.absoluteExpiresAt, options.idleTtlMs);
      const touched = await ports.store.touch(metadata.authSessionId, now, idleExpiresAt);
      if (!touched) throw authenticationRequired();
      live = { ...metadata, lastSeenAt: now, idleExpiresAt };
    }
  }
  return { account, session: toSessionView(live, account.id) };
}

/**
 * CAS single-winner rotation: mint the successor BA session, claim the
 * predecessor via the metadata partial unique index (only the winner inserts),
 * then retire the predecessor metadata. The successor inherits the predecessor
 * ABSOLUTE deadline — rotation never extends absolute lifetime (G1 §7).
 */
async function rotateUsableSession(
  ports: BrowserSessionAuthorityPorts,
  metadata: BrowserSessionMetadataRow,
  baSession: BetterAuthSessionRecord,
  account: Account,
  now: Date,
  options: { readonly idleTtlMs: number },
): Promise<Extract<BrowserSessionBootstrapResult, { readonly authenticated: true }>> {
  const minted = await ports.store.mintSuccessorSession({ userId: baSession.userId, now });
  const rawCsrfToken = deriveBrowserSessionCsrfTokenRaw(minted.session.token);
  const successor: BrowserSessionMetadataRow = {
    authSessionId: minted.session.id,
    sessionTokenHash: browserSessionTokenHash(minted.session.token),
    accountId: account.id,
    idleExpiresAt: computeSlidIdleExpiry(now, metadata.absoluteExpiresAt, options.idleTtlMs),
    // Preserve the predecessor absolute deadline — never extended on rotation.
    absoluteExpiresAt: metadata.absoluteExpiresAt,
    securityEpoch: account.securityEpoch,
    csrfTokenHash: browserSessionCsrfTokenHash(rawCsrfToken),
    predecessorSessionId: metadata.authSessionId,
    lastSeenAt: now,
    revokedAt: null,
    createdAt: now,
  };
  await ports.store.insert(successor);
  await ports.store.markRevoked(metadata.authSessionId, now);
  return {
    authenticated: true,
    account,
    session: toSessionView(successor, account.id),
    csrfToken: rawCsrfToken,
    idleExpiresAt: successor.idleExpiresAt,
    absoluteExpiresAt: successor.absoluteExpiresAt,
    rotated: true,
    rotatedCookieValue: minted.rawCookieValue,
  };
}

/**
 * CAS-loser / rotated-away convergence: read the winner's successor cookie
 * (token revealed through the storage protector + signed cookie), verify the
 * winner BA session through the real server API and the winner metadata through
 * the product checks, then
 * return the winner's credentials so the loser response carries the SAME new
 * cookie as the winner (mirror of the legacy single-winner successor
 * resolution).
 */
async function resolveSuccessor(
  unitOfWork: BrowserSessionUnitOfWork,
  betterAuth: BetterAuthServerPort,
  predecessorAuthSessionId: string,
  options: { readonly idleTtlMs: number; readonly touchMinIntervalMs: number },
): Promise<BrowserSessionBootstrapResult> {
  return unitOfWork.execute(async (ports) => {
    const minted = await ports.store.findSuccessorCookie(predecessorAuthSessionId);
    if (!minted) return unauthenticatedBootstrap(false);
    const winnerBa = await betterAuth.getSession({ cookie: browserSessionCookieHeader(minted.rawCookieValue) });
    if (!winnerBa || winnerBa.token !== minted.session.token) return unauthenticatedBootstrap(false);
    const winnerMetadata = await ports.store.findByTokenHash(browserSessionTokenHash(minted.session.token));
    if (!winnerMetadata || winnerMetadata.authSessionId !== minted.session.id) return unauthenticatedBootstrap(false);
    try {
      const winner = await loadUsableActor(ports, winnerMetadata, winnerBa, {
        touch: false,
        idleTtlMs: options.idleTtlMs,
        touchMinIntervalMs: options.touchMinIntervalMs,
      });
      if (winner === null) return unauthenticatedBootstrap(false);
      return {
        authenticated: true,
        account: winner.account,
        session: winner.session,
        csrfToken: deriveBrowserSessionCsrfTokenRaw(minted.session.token),
        idleExpiresAt: winnerMetadata.idleExpiresAt,
        absoluteExpiresAt: winnerMetadata.absoluteExpiresAt,
        rotated: true,
        rotatedCookieValue: minted.rawCookieValue,
      };
    } catch (error) {
      if (error instanceof BrowserSessionAuthenticationError) {
        return unauthenticatedBootstrap(error.code === 'verification_required');
      }
      throw error;
    }
  });
}

export function createBrowserSessionAuthority(
  options: CreateBrowserSessionAuthorityOptions,
): BrowserSessionAuthority {
  const idleTtlMs = options.idleTtlMs ?? SESSION_IDLE_TTL_MS;
  const absoluteTtlMs = options.absoluteTtlMs ?? SESSION_ABSOLUTE_TTL_MS;
  const rotationMinAgeMs = options.rotationMinAgeMs ?? SESSION_ROTATION_MIN_AGE_MS;
  const touchMinIntervalMs = options.touchMinIntervalMs ?? SESSION_TOUCH_MIN_INTERVAL_MS;
  if (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0 || !Number.isFinite(absoluteTtlMs) || absoluteTtlMs <= 0) {
    throw new TypeError('browser session TTLs must be positive');
  }
  if (idleTtlMs > absoluteTtlMs) {
    throw new TypeError('idle TTL must not exceed absolute TTL');
  }
  const { unitOfWork, betterAuth } = options;

  async function signOut(request: BrowserSessionRequest): Promise<void> {
    const parsed = parseBrowserSessionCookie(request.cookie);
    if (parsed.kind !== 'present') return;
    const token = browserSessionTokenOf(parsed.value);
    if (token === null) return;
    const tokenHash = browserSessionTokenHash(token);

    // Record the product revoke fact first (concurrent requests fail closed),
    // then let BA revoke the carrier row (idempotent — spike §3.4).
    await unitOfWork.execute(async (ports) => {
      const metadata = await ports.store.findByTokenHash(tokenHash);
      if (metadata && metadata.revokedAt === null) {
        await ports.store.markRevoked(metadata.authSessionId, await ports.clock.now());
      }
    });
    await betterAuth.signOut(request);
  }

  type ResolvedBrowserSession =
    | { readonly kind: 'missing' }
    | { readonly kind: 'occupancy' }
    | { readonly kind: 'actor'; readonly actor: AuthenticatedBrowserActor };

  async function resolveBrowserSession(
    request: BrowserSessionRequest,
    authOptions: { readonly touch?: boolean } = {},
  ): Promise<ResolvedBrowserSession> {
    const parsed = parseBrowserSessionCookie(request.cookie);
    if (parsed.kind !== 'present') {
      // C4: a request carrying ONLY the MFA pending challenge cookie
      // (known.two_factor) has no session — BA deleted the session row when
      // the challenge started, so getSession below would return null anyway.
      // The explicit guard documents the contract: the pending 2FA session
      // is never a full business session (A3 facade rejection).
      return { kind: 'missing' };
    }
    const token = browserSessionTokenOf(parsed.value);
    if (token === null) return { kind: 'missing' };
    const tokenHash = browserSessionTokenHash(token);

    // Authoritative carrier check (cookie signature + BA session row).
    const baSession = await betterAuth.getSession(request);
    if (!baSession || baSession.token !== token) return { kind: 'missing' };
    if (baSession.emailVerified === false && unverifiedSessionBlocksProductActor()) return { kind: 'occupancy' };

    try {
      const actor = await unitOfWork.execute(async (ports) => {
        const metadata = await ports.store.findByTokenHash(tokenHash);
        if (!metadata || metadata.authSessionId !== baSession.id) return null;
        return loadUsableActor(ports, metadata, baSession, {
          touch: authOptions.touch ?? true,
          idleTtlMs,
          touchMinIntervalMs,
        });
      });
      return actor ? { kind: 'actor', actor } : { kind: 'missing' };
    } catch (error) {
      if (error instanceof BrowserSessionAuthenticationError) {
        return error.code === 'verification_required'
          ? { kind: 'occupancy' }
          : { kind: 'missing' };
      }
      throw error;
    }
  }

  async function authenticate(
    request: BrowserSessionRequest,
    authOptions: { readonly touch?: boolean } = {},
  ): Promise<AuthenticatedBrowserActor | null> {
    // Occupancy is not a product actor: optional ingest / owner-skip stay anonymous.
    const resolved = await resolveBrowserSession(request, authOptions);
    return resolved.kind === 'actor' ? resolved.actor : null;
  }

  return {
    authenticate,
    async requireMutationActor(request, authOptions = {}) {
      const resolved = await resolveBrowserSession(request, authOptions);
      if (resolved.kind === 'occupancy') throw verificationRequired();
      if (resolved.kind === 'missing') throw authenticationRequired();
      return resolved.actor;
    },
    async bootstrap(request): Promise<BrowserSessionBootstrapResult> {
      const parsed = parseBrowserSessionCookie(request.cookie);
      if (parsed.kind !== 'present') {
        // C4 pending-challenge guard (see authenticate): the MFA challenge
        // cookie is never a session for bootstrap either.
        return unauthenticatedBootstrap(false);
      }
      const token = browserSessionTokenOf(parsed.value);
      if (token === null) return unauthenticatedBootstrap(false);
      const tokenHash = browserSessionTokenHash(token);

      const baSession = await betterAuth.getSession(request);
      if (!baSession || baSession.token !== token) return unauthenticatedBootstrap(false);
      if (baSession.emailVerified === false && unverifiedSessionBlocksProductActor()) return unauthenticatedBootstrap(true);

      try {
        return await unitOfWork.execute(async (ports) => {
          const metadata = await ports.store.findByTokenHash(tokenHash);
          if (!metadata || metadata.authSessionId !== baSession.id) return unauthenticatedBootstrap(false);
          if (metadata.revokedAt !== null) {
            // Rotated away (or revoked) — a live successor means a concurrent
            // winner rotated this session: converge to its cookie.
            throw new SuccessorResolutionRequired(metadata.authSessionId);
          }
          const now = await ports.clock.now();
          if (isExpired(metadata, now)) {
            await ports.store.markRevoked(metadata.authSessionId, now);
            return unauthenticatedBootstrap(false);
          }
          // Full usability before any rotation write (never mint for a
          // disabled/unmapped/epoch-stale session).
          const actor = await loadUsableActor(ports, metadata, baSession, {
            touch: false,
            idleTtlMs,
            touchMinIntervalMs,
          });
          if (actor === null) return unauthenticatedBootstrap(false);

          if (now.getTime() - metadata.createdAt.getTime() >= rotationMinAgeMs) {
            try {
              return await rotateUsableSession(ports, metadata, baSession, actor.account, now, { idleTtlMs });
            } catch (error) {
              if (error instanceof RotationCasConflictError) {
                throw new SuccessorResolutionRequired(metadata.authSessionId);
              }
              throw error;
            }
          }

          // Below rotation age: re-issue CSRF without minting. Do not idle-slide
          // (C-07: GET /session is not the heartbeat).
          return {
            authenticated: true,
            account: actor.account,
            session: actor.session,
            csrfToken: deriveBrowserSessionCsrfTokenRaw(token),
            idleExpiresAt: metadata.idleExpiresAt,
            absoluteExpiresAt: metadata.absoluteExpiresAt,
            rotated: false,
          };
        });
      } catch (error) {
        if (error instanceof SuccessorResolutionRequired) {
          return resolveSuccessor(unitOfWork, betterAuth, error.predecessorAuthSessionId, {
            idleTtlMs,
            touchMinIntervalMs,
          });
        }
        if (error instanceof BrowserSessionAuthenticationError) {
          return unauthenticatedBootstrap(error.code === 'verification_required');
        }
        throw error;
      }
    },
    signOut,
    async revokeAll(accountId): Promise<BrowserSessionRevokeAllResult> {
      return unitOfWork.execute(async (ports) => {
        const account = await ports.accounts.findById(accountId);
        if (!account) {
          throw new BrowserSessionAuthenticationError('account_not_found', 'account was not found');
        }
        const now = await ports.clock.now();
        const securityEpoch = await ports.accounts.bumpSecurityEpoch(accountId);
        // BA session rows die with their metadata rows (FK cascade); the
        // security_epoch bump is the durable revoke fact that invalidates
        // every downstream binding (sync sessions / MCP approvals snapshot it).
        const revokedAuthSessions = await ports.store.deleteAuthSessionsForAccount(accountId);
        const revokedLegacySessions = await ports.sessions.revokeAllForAccount(accountId, now);
        await ports.store.deleteTrustDeviceStateForAccount(accountId);
        return { securityEpoch, revokedAuthSessions, revokedLegacySessions };
      });
    },
    async revokeOthersKeepingCurrent({ authUserId, currentAuthSessionId }) {
      return unitOfWork.execute(async (ports) => {
        const mapping = await ports.mappings.findByAuthUserId(authUserId);
        if (!mapping) {
          throw new BrowserSessionAuthenticationError('account_not_found', 'account was not found');
        }
        const account = await ports.accounts.findById(mapping.accountId);
        if (!account) {
          throw new BrowserSessionAuthenticationError('account_not_found', 'account was not found');
        }
        const now = await ports.clock.now();
        const securityEpoch = await ports.accounts.bumpSecurityEpoch(mapping.accountId);
        await ports.store.revokeOthersForAccount(mapping.accountId, currentAuthSessionId, now);
        await ports.store.alignMetadataEpoch(currentAuthSessionId, securityEpoch);
        const revokedAuthSessions = await ports.store.deleteAuthSessionsForAccountExcept(
          mapping.accountId,
          currentAuthSessionId,
        );
        const revokedLegacySessions = await ports.sessions.revokeAllForAccount(mapping.accountId, now);
        await ports.store.deleteTrustDeviceStateForAccount(mapping.accountId);
        return { securityEpoch, revokedAuthSessions, revokedLegacySessions };
      });
    },
    async listLiveSessions({ accountId, currentAuthSessionId }) {
      return unitOfWork.execute(async (ports) => {
        const now = await ports.clock.now();
        const rows = await ports.store.listLiveForAccount(accountId, {
          limit: BROWSER_SESSION_LIVE_CAP,
        });
        return rows
          .filter((row) => !isExpired(row, now))
          .map((row) => ({
            id: row.authSessionId,
            createdAt: row.createdAt,
            updatedAt: row.lastSeenAt,
            current: row.authSessionId === currentAuthSessionId,
          }));
      });
    },
    async revokeSessionById({ request, sessionId, accountId, currentAuthSessionId }) {
      if (sessionId === currentAuthSessionId) {
        await signOut(request);
        return { kind: 'current' };
      }
      return unitOfWork.execute(async (ports) => {
        const row = await ports.store.findLiveByAuthSessionId(sessionId);
        if (!row || row.accountId !== accountId) return { kind: 'not_found' };
        const now = await ports.clock.now();
        await ports.store.markRevoked(sessionId, now);
        await ports.store.deleteAuthSessionById(sessionId);
        return { kind: 'other' };
      });
    },
  };
}
