import { IdentityError } from './errors.js';
import type { Account, Session, SessionExpiryWindow } from './types.js';

export const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const OIDC_LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1000;

/**
 * Minimum age of a session row (since createdAt / last rotation issue) before
 * read-time bootstrap may rotate secrets. Ordinary authenticated reads must not
 * rotate; GET /session only rotates when this threshold is met (or forceRotate).
 */
export const SESSION_ROTATION_MIN_AGE_MS = 15 * 60 * 1000;

/**
 * Minimum interval between idle-slide / last_seen writes. Below this, authenticate
 * is a pure read so ordinary traffic does not write on every request.
 */
export const SESSION_TOUCH_MIN_INTERVAL_MS = 60 * 1000;

/** True when the session is old enough that a bootstrap rotation is allowed. */
export function shouldRotateSession(
  session: Session,
  now: Date,
  minAgeMs: number = SESSION_ROTATION_MIN_AGE_MS,
): boolean {
  if (minAgeMs < 0) {
    throw new IdentityError('invalid_identity_input', 'rotation min age must be non-negative');
  }
  return now.getTime() - session.createdAt.getTime() >= minAgeMs;
}

/** True when idle sliding should persist (throttles last_seen / idle_expires writes). */
export function shouldTouchSession(
  session: Session,
  now: Date,
  minIntervalMs: number = SESSION_TOUCH_MIN_INTERVAL_MS,
): boolean {
  if (minIntervalMs < 0) {
    throw new IdentityError('invalid_identity_input', 'touch min interval must be non-negative');
  }
  return now.getTime() - session.lastSeenAt.getTime() >= minIntervalMs;
}

export function computeSessionExpiryWindow(
  now: Date,
  options: {
    readonly idleTtlMs?: number;
    readonly absoluteTtlMs?: number;
  } = {},
): SessionExpiryWindow {
  const idleTtlMs = options.idleTtlMs ?? SESSION_IDLE_TTL_MS;
  const absoluteTtlMs = options.absoluteTtlMs ?? SESSION_ABSOLUTE_TTL_MS;
  if (idleTtlMs <= 0 || absoluteTtlMs <= 0) {
    throw new IdentityError('invalid_identity_input', 'session TTLs must be positive');
  }
  if (idleTtlMs > absoluteTtlMs) {
    throw new IdentityError('invalid_identity_input', 'idle TTL must not exceed absolute TTL');
  }
  const absoluteExpiresAt = new Date(now.getTime() + absoluteTtlMs);
  const idleExpiresAt = new Date(now.getTime() + idleTtlMs);
  return { idleExpiresAt, absoluteExpiresAt };
}

export function computeSlidIdleExpiry(
  now: Date,
  absoluteExpiresAt: Date,
  idleTtlMs: number = SESSION_IDLE_TTL_MS,
): Date {
  const slid = new Date(now.getTime() + idleTtlMs);
  return slid.getTime() <= absoluteExpiresAt.getTime() ? slid : absoluteExpiresAt;
}

export function isSessionRevoked(session: Session): boolean {
  return session.revokedAt !== null;
}

export function isSessionIdleExpired(session: Session, now: Date): boolean {
  return now.getTime() >= session.idleExpiresAt.getTime();
}

export function isSessionAbsoluteExpired(session: Session, now: Date): boolean {
  return now.getTime() >= session.absoluteExpiresAt.getTime();
}

export function isSessionExpired(session: Session, now: Date): boolean {
  return isSessionIdleExpired(session, now) || isSessionAbsoluteExpired(session, now);
}

export function isSecurityEpochMatch(session: Session, account: Account): boolean {
  return session.securityEpoch === account.securityEpoch;
}

/**
 * Pure session usability check against account state and DB time.
 * Does not perform sliding or persistence.
 */
export function assertSessionUsable(session: Session, account: Account, now: Date): void {
  if (isSessionRevoked(session)) {
    throw new IdentityError('session_revoked', 'session has been revoked');
  }
  if (isSessionExpired(session, now)) {
    throw new IdentityError('session_expired', 'session has expired');
  }
  if (!isSecurityEpochMatch(session, account)) {
    throw new IdentityError(
      'session_security_epoch_mismatch',
      'session security epoch does not match account',
    );
  }
  if (account.status === 'disabled') {
    throw new IdentityError('account_disabled', 'account is disabled');
  }
  if (account.status === 'deleted' || account.deletedAt !== null) {
    throw new IdentityError('account_deleted', 'account is deleted');
  }
  if (account.status !== 'active') {
    throw new IdentityError('account_disabled', 'account is not active');
  }
  if (session.accountId !== account.id) {
    throw new IdentityError('session_not_found', 'session does not belong to account');
  }
}

export function assertAccountCanIssueSession(account: Account): void {
  if (account.status === 'disabled') {
    throw new IdentityError('account_disabled', 'account is disabled');
  }
  if (account.status === 'deleted' || account.deletedAt !== null) {
    throw new IdentityError('account_deleted', 'account is deleted');
  }
  if (account.status !== 'active') {
    throw new IdentityError('account_disabled', 'account is not active');
  }
}
