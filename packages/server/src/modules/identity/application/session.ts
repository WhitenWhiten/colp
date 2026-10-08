/**
 * DEPRECATED legacy product session state machine (Task F1 quarantine note).
 *
 * Status: retained — the current runtime still issues product sessions from
 * this module, so behavior must not change. This is the legacy session
 * implementation targeted for replacement by the Better Auth
 * `BrowserSessionAuthority` adapter interface (Task A3,
 * docs/development/known-backend/better-auth/better-auth-migration-development-plan.md
 * §8 Task A3): the adapter keeps this file's callers' `account`/`session`
 * shape (see `BrowserAuthDeps`/transport consumers) but stops treating the old
 * `sessions` table as the authentication authority. The deprecation marker
 * here records ownership and direction only; Task F1 performs no functional
 * change.
 *
 * A3 adapter interface: the replacement lives in
 * `src/modules/auth/application/browser-session-authority.ts`
 * (`BrowserSessionAuthority` port) + `src/infrastructure/auth/better-auth-session-authority.ts`
 * (Better Auth 1.7.1 + `known_auth_session_metadata` implementation). It
 * returns the same `{ account, session }` shape via `AuthenticatedBrowserActor`
 * (the `Session` view is built from the metadata row), so the legacy callers
 * of `requireSessionActor`/`authenticateSession`-shaped ports keep compiling
 * unchanged. This file is NOT deleted: it stays as the shadow/off-mode
 * authority until Task F2/F3 isolate the legacy composition.
 *
 * @deprecated Legacy product session implementation; superseded by the
 *   Better Auth BrowserSessionAuthority adapter interface (Task A3).
 */
import {
  IdentityError,
  assertAccountCanIssueSession,
  assertSessionUsable,
  computeSessionExpiryWindow,
  computeSlidIdleExpiry,
  deriveCsrfTokenRaw,
  generateOpaqueId,
  generateSessionTokenRaw,
  hashSecret,
  SESSION_IDLE_TTL_MS,
  SESSION_ROTATION_MIN_AGE_MS,
  SESSION_TOUCH_MIN_INTERVAL_MS,
  shouldRotateSession,
  shouldTouchSession,
  secretsMatch,
} from '../domain/index.js';
import type { Account, IssuedSessionSecrets, Session } from '../domain/types.js';
import type { IdentityPorts } from './ports.js';

export interface CreateSessionInput {
  readonly accountId: string;
  readonly sessionId?: string;
  readonly rotatedFromSessionId?: string | null;
  readonly idleTtlMs?: number;
  readonly absoluteTtlMs?: number;
  /**
   * When set (rotation), preserves the predecessor absolute deadline so rotation
   * cannot extend absolute lifetime beyond the original policy window.
   */
  readonly absoluteExpiresAt?: Date;
}

export interface AuthenticateSessionOptions {
  /**
   * When true (default), may slide idle expiry using DB time — only when the
   * touch interval threshold is met (ordinary reads avoid writes).
   * When false, pure read validation.
   */
  readonly touch?: boolean;
  readonly idleTtlMs?: number;
  /** Override SESSION_TOUCH_MIN_INTERVAL_MS for tests. */
  readonly touchMinIntervalMs?: number;
}

export interface AuthenticatedSession {
  readonly session: Session;
  readonly account: Account;
}

export interface RotateSessionOptions {
  readonly idleTtlMs?: number;
  /** Ignored when preserving predecessor absoluteExpiresAt (always preserved). */
  readonly absoluteTtlMs?: number;
  /** Raw predecessor cookie used to hand CAS losers the same successor secret. */
  readonly predecessorRawSessionToken?: string;
}

export interface BootstrapBrowserSessionOptions {
  /** When true, rotate regardless of age threshold (login / step-up). */
  readonly forceRotate?: boolean;
  /** Override SESSION_ROTATION_MIN_AGE_MS for tests. */
  readonly rotationMinAgeMs?: number;
  readonly idleTtlMs?: number;
}

export interface BootstrappedBrowserSession extends IssuedSessionSecrets {
  /** True when secrets were rotated (caller should Set-Cookie). */
  readonly rotated: boolean;
}

/**
 * Issues a session: stores only hashes; returns raw token/csrf once to transport.
 * CSRF is derived from the session token so it can be re-issued without rotation.
 */
export async function createSession(
  ports: IdentityPorts,
  input: CreateSessionInput,
): Promise<IssuedSessionSecrets> {
  return issueSession(ports, input, generateSessionTokenRaw());
}

async function issueSession(
  ports: IdentityPorts,
  input: CreateSessionInput,
  rawSessionToken: string,
): Promise<IssuedSessionSecrets> {
  const account = await ports.accounts.findById(input.accountId);
  if (!account) {
    throw new IdentityError('account_not_found', 'account was not found');
  }
  assertAccountCanIssueSession(account);

  const now = await ports.clock.now();
  const idleTtlMs = input.idleTtlMs ?? SESSION_IDLE_TTL_MS;
  let idleExpiresAt: Date;
  let absoluteExpiresAt: Date;
  if (input.absoluteExpiresAt) {
    absoluteExpiresAt = input.absoluteExpiresAt;
    if (now.getTime() >= absoluteExpiresAt.getTime()) {
      throw new IdentityError('session_expired', 'session has expired');
    }
    idleExpiresAt = computeSlidIdleExpiry(now, absoluteExpiresAt, idleTtlMs);
  } else {
    const expiry = computeSessionExpiryWindow(now, {
      idleTtlMs: input.idleTtlMs,
      absoluteTtlMs: input.absoluteTtlMs,
    });
    idleExpiresAt = expiry.idleExpiresAt;
    absoluteExpiresAt = expiry.absoluteExpiresAt;
  }

  const rawCsrfToken = deriveCsrfTokenRaw(rawSessionToken);
  const session: Session = {
    id: input.sessionId ?? generateOpaqueId(),
    accountId: account.id,
    idleExpiresAt,
    absoluteExpiresAt,
    csrfTokenHash: hashSecret(rawCsrfToken),
    tokenHash: hashSecret(rawSessionToken),
    securityEpoch: account.securityEpoch,
    rotatedFromSessionId: input.rotatedFromSessionId ?? null,
    lastSeenAt: now,
    revokedAt: null,
    createdAt: now,
  };
  await ports.sessions.insert(session);
  return { session, rawSessionToken, rawCsrfToken };
}

/**
 * Anti-fixation / age-threshold rotation: CAS-revoke the predecessor, then issue
 * exactly one successor. Concurrent losers do not mint another row; when given
 * the predecessor raw token they reconstruct and return the winner's credentials.
 * Absolute lifetime is preserved from the predecessor.
 */
export async function rotateSession(
  ports: IdentityPorts,
  currentSessionId: string,
  options: RotateSessionOptions = {},
): Promise<IssuedSessionSecrets> {
  const current = await ports.sessions.findById(currentSessionId);
  if (!current) {
    throw new IdentityError('session_not_found', 'session was not found');
  }
  const account = await ports.accounts.findById(current.accountId);
  if (!account) {
    throw new IdentityError('account_not_found', 'account was not found');
  }
  const now = await ports.clock.now();
  assertSessionUsable(current, account, now);

  return rotateUsableSession(ports, current, account, now, options);
}

async function rotateUsableSession(
  ports: IdentityPorts,
  current: Session,
  account: Account,
  now: Date,
  options: RotateSessionOptions,
): Promise<IssuedSessionSecrets> {
  const predecessorRaw = options.predecessorRawSessionToken;
  if (predecessorRaw && !secretsMatch(predecessorRaw, current.tokenHash)) {
    throw new IdentityError('session_not_found', 'session token does not match');
  }
  const successorRaw = predecessorRaw
    ? ports.sessionRotationSecrets.deriveSuccessorToken(predecessorRaw, current.id)
    : undefined;

  // Single-winner claim: only one concurrent rotator revokes successfully.
  const claimed = await ports.sessions.revoke(current.id, now);
  if (!claimed) {
    // Resolve to the winning successor without minting another row.
    const winner = await ports.sessions.findLiveSuccessorByRotatedFrom(current.id);
    if (winner && successorRaw && secretsMatch(successorRaw, winner.tokenHash)) {
      assertSessionUsable(winner, account, now);
      return {
        session: winner,
        rawSessionToken: successorRaw,
        rawCsrfToken: deriveCsrfTokenRaw(successorRaw),
      };
    }
    throw new IdentityError('session_revoked', 'session has been revoked');
  }

  return issueSession(ports, {
    accountId: account.id,
    rotatedFromSessionId: current.id,
    idleTtlMs: options.idleTtlMs,
    // Preserve absolute deadline — do not extend absolute lifetime on rotation.
    absoluteExpiresAt: current.absoluteExpiresAt,
  }, successorRaw ?? generateSessionTokenRaw());
}

/**
 * Load session by raw cookie secret hash, validate revoke/expiry/epoch, optionally
 * slide idle only when the touch interval threshold is met (avoids write-on-every-read).
 */
export async function authenticateSession(
  ports: IdentityPorts,
  rawSessionToken: string,
  options: AuthenticateSessionOptions = {},
): Promise<AuthenticatedSession> {
  if (!rawSessionToken) {
    throw new IdentityError('session_not_found', 'session token is required');
  }
  const tokenHash = hashSecret(rawSessionToken);
  const session = await ports.sessions.findByTokenHash(tokenHash);
  if (!session) {
    throw new IdentityError('session_not_found', 'session was not found');
  }
  const account = await ports.accounts.findById(session.accountId);
  if (!account) {
    throw new IdentityError('account_not_found', 'account was not found');
  }
  const now = await ports.clock.now();
  assertSessionUsable(session, account, now);

  if (options.touch === false) {
    return { session, account };
  }

  const touchMinIntervalMs = options.touchMinIntervalMs ?? SESSION_TOUCH_MIN_INTERVAL_MS;
  if (!shouldTouchSession(session, now, touchMinIntervalMs)) {
    // Below threshold: pure read — no last_seen / idle write.
    return { session, account };
  }

  const idleExpiresAt = computeSlidIdleExpiry(
    now,
    session.absoluteExpiresAt,
    options.idleTtlMs ?? SESSION_IDLE_TTL_MS,
  );
  const touched = await ports.sessions.touch(session.id, now, idleExpiresAt);
  if (!touched) {
    // Concurrent revoke between assert and touch.
    throw new IdentityError('session_revoked', 'session has been revoked');
  }
  return {
    session: {
      ...session,
      lastSeenAt: now,
      idleExpiresAt,
    },
    account,
  };
}

/** Alias for authenticateSession with touch enabled (still threshold-gated). */
export async function touchSession(
  ports: IdentityPorts,
  rawSessionToken: string,
  options: Omit<AuthenticateSessionOptions, 'touch'> = {},
): Promise<AuthenticatedSession> {
  return authenticateSession(ports, rawSessionToken, { ...options, touch: true });
}

/**
 * Browser GET /session bootstrap: re-issue CSRF without rotating when below the
 * rotation age threshold; CAS single-winner rotate when at/above threshold (or forced).
 * Does not idle-slide: GET `/me` is the heartbeat (C-07). Rotation minting a
 * successor may set the successor's lastSeenAt to now. Ordinary product reads
 * should call authenticateSession, not this helper.
 */
export async function bootstrapBrowserSession(
  ports: IdentityPorts,
  rawSessionToken: string,
  options: BootstrapBrowserSessionOptions = {},
): Promise<BootstrappedBrowserSession> {
  if (!rawSessionToken) {
    throw new IdentityError('session_not_found', 'session token is required');
  }
  const tokenHash = hashSecret(rawSessionToken);
  const session = await ports.sessions.findByTokenHash(tokenHash);
  if (!session) {
    throw new IdentityError('session_not_found', 'session was not found');
  }
  const account = await ports.accounts.findById(session.accountId);
  if (!account) {
    throw new IdentityError('account_not_found', 'account was not found');
  }
  const now = await ports.clock.now();
  assertSessionUsable(session, account, now);

  const rotationMinAgeMs = options.rotationMinAgeMs ?? SESSION_ROTATION_MIN_AGE_MS;
  const forceRotate = options.forceRotate === true;
  if (forceRotate || shouldRotateSession(session, now, rotationMinAgeMs)) {
    // Use the already-validated snapshot so concurrent requests that reached
    // this point all contend on the same revoke CAS instead of re-reading revoked.
    const issued = await rotateUsableSession(ports, session, account, now, {
      idleTtlMs: options.idleTtlMs,
      predecessorRawSessionToken: rawSessionToken,
    });
    return { ...issued, rotated: true };
  }

  // Below rotation age: re-issue CSRF without minting. Do not idle-slide
  // (C-07: GET /session is not the heartbeat).
  return {
    session,
    rawSessionToken,
    rawCsrfToken: deriveCsrfTokenRaw(rawSessionToken),
    rotated: false,
  };
}

/**
 * Logout: revoke current session. Idempotent if already revoked or missing.
 */
export async function revokeSession(
  ports: IdentityPorts,
  sessionId: string,
): Promise<{ readonly revoked: boolean }> {
  const existing = await ports.sessions.findById(sessionId);
  if (!existing) {
    return { revoked: false };
  }
  if (existing.revokedAt !== null) {
    return { revoked: false };
  }
  const now = await ports.clock.now();
  const revoked = await ports.sessions.revoke(sessionId, now);
  return { revoked };
}

/**
 * Bumps account security epoch and revokes all live sessions for that account.
 */
export async function bumpAccountSecurityEpoch(
  ports: IdentityPorts,
  accountId: string,
): Promise<{ readonly securityEpoch: bigint; readonly revokedSessions: number }> {
  const account = await ports.accounts.findById(accountId);
  if (!account) {
    throw new IdentityError('account_not_found', 'account was not found');
  }
  const securityEpoch = await ports.accounts.bumpSecurityEpoch(accountId);
  const now = await ports.clock.now();
  const revokedSessions = await ports.sessions.revokeAllForAccount(accountId, now);
  return { securityEpoch, revokedSessions };
}
