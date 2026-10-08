/**
 * P-09 Sync COLP (push/pull) rate-limit HMAC key codec.
 *
 * Independent of auth/search/explore/insights/invite purpose strings. Hash-tag
 * purpose is `sync`; sealed families are `push` | `pull` so the two surfaces
 * never share a counter.
 *
 * Canonical key (prefix default `known-sync`):
 *
 *   known-sync:<env>:ratelimit:v1:{sync:<subjectHmac>}:<family>:<window>
 *
 * Subject is the trusted client IP (Fastify `request.ip` after trusted-ingress
 * resolution). The raw IP never enters the key text.
 */
import { createHmac } from 'node:crypto';

export const SYNC_COLP_RATE_LIMIT_ROUTE_FAMILIES = Object.freeze([
  'push', 'pull',
] as const);
export type SyncColpRateLimitRouteFamily = (typeof SYNC_COLP_RATE_LIMIT_ROUTE_FAMILIES)[number];

export const SYNC_COLP_RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
export const SYNC_COLP_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
export const SYNC_COLP_RATE_LIMIT_KEY_MAX_LENGTH = 512;
export const SYNC_COLP_RATE_LIMIT_SUBJECT_MAX_LENGTH = 256;

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const SYNC_COLP_RATE_LIMIT_KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{sync:([A-Za-z0-9_-]{32})\}:(push|pull):(\d{1,16})$/u;

export interface SyncColpRateLimitKeyBuildInput {
  readonly keyPrefix?: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly family: SyncColpRateLimitRouteFamily;
  readonly subject: string;
  readonly windowStartEpochMs: number;
}

export type SyncColpRateLimitKeyRejectReason =
  | 'malformed'
  | 'invalid_prefix'
  | 'invalid_environment'
  | 'invalid_family'
  | 'invalid_window'
  | 'key_too_long';

export interface SyncColpRateLimitKeyParts {
  readonly keyPrefix: string;
  readonly environment: string;
  readonly schemaVersion: 1;
  readonly subjectHmac: string;
  readonly family: SyncColpRateLimitRouteFamily;
  readonly windowStartEpochMs: number;
}

export type SyncColpRateLimitKeyParseResult =
  | { readonly kind: 'ok'; readonly parts: SyncColpRateLimitKeyParts }
  | { readonly kind: 'rejected'; readonly reason: SyncColpRateLimitKeyRejectReason };

export class SyncColpRateLimitKeyError extends Error {
  readonly reason: SyncColpRateLimitKeyRejectReason;
  constructor(reason: SyncColpRateLimitKeyRejectReason, message: string) {
    super(message);
    this.name = 'SyncColpRateLimitKeyError';
    this.reason = reason;
  }
}

export function assertSyncColpRateLimitSubject(subject: string): void {
  if (typeof subject !== 'string' || subject.length === 0
    || subject.length > SYNC_COLP_RATE_LIMIT_SUBJECT_MAX_LENGTH) {
    throw new SyncColpRateLimitKeyError(
      'malformed',
      `sync rate-limit subject must be 1-${SYNC_COLP_RATE_LIMIT_SUBJECT_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(subject)) {
    throw new SyncColpRateLimitKeyError('malformed', 'sync rate-limit subject must not contain control characters');
  }
}

export function syncColpRateLimitSubjectHmac(keySecret: Buffer, subject: string): string {
  assertSyncColpRateLimitSubject(subject);
  return createHmac('sha256', keySecret)
    .update(subject, 'utf8')
    .digest('base64url')
    .slice(0, SYNC_COLP_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

export function parseSyncColpRateLimitKey(key: string): SyncColpRateLimitKeyParseResult {
  if (typeof key !== 'string' || key.length === 0 || key.length > SYNC_COLP_RATE_LIMIT_KEY_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const match = SYNC_COLP_RATE_LIMIT_KEY_PATTERN.exec(key);
  if (!match) return { kind: 'rejected', reason: 'malformed' };
  const windowRaw = match[5]!;
  if (windowRaw.length > 1 && windowRaw.startsWith('0')) {
    return { kind: 'rejected', reason: 'invalid_window' };
  }
  const windowStartEpochMs = Number(windowRaw);
  if (!Number.isSafeInteger(windowStartEpochMs)) {
    return { kind: 'rejected', reason: 'invalid_window' };
  }
  return {
    kind: 'ok',
    parts: Object.freeze({
      keyPrefix: match[1]!,
      environment: match[2]!,
      schemaVersion: SYNC_COLP_RATE_LIMIT_KEY_SCHEMA_VERSION,
      subjectHmac: match[3]!,
      family: match[4] as SyncColpRateLimitRouteFamily,
      windowStartEpochMs,
    }),
  };
}

export function buildSyncColpRateLimitKey(input: SyncColpRateLimitKeyBuildInput): string {
  const keyPrefix = input.keyPrefix ?? 'known-sync';
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new SyncColpRateLimitKeyError(
      'invalid_prefix',
      'sync rate-limit key prefix must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new SyncColpRateLimitKeyError(
      'invalid_environment',
      'sync rate-limit key environment must be 1-64 characters of [A-Za-z0-9_.-]',
    );
  }
  if (!SYNC_COLP_RATE_LIMIT_ROUTE_FAMILIES.includes(input.family)) {
    throw new SyncColpRateLimitKeyError('invalid_family', `unknown sync rate-limit family: ${String(input.family)}`);
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new SyncColpRateLimitKeyError('invalid_window', 'sync rate-limit key window must be a non-negative safe integer');
  }
  const subjectHmac = syncColpRateLimitSubjectHmac(input.keySecret, input.subject);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${SYNC_COLP_RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{sync:${subjectHmac}}:${input.family}:${input.windowStartEpochMs}`;
  if (key.length > SYNC_COLP_RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new SyncColpRateLimitKeyError('key_too_long', `sync rate-limit key exceeds ${SYNC_COLP_RATE_LIMIT_KEY_MAX_LENGTH} characters`);
  }
  if (parseSyncColpRateLimitKey(key).kind !== 'ok') {
    throw new SyncColpRateLimitKeyError('malformed', 'built sync rate-limit key failed canonical parse');
  }
  return key;
}
