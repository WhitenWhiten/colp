/**
 * P4A-RL02 HMAC key codec (plan §2.3 key contract + §4.1.11 key isolation).
 *
 * Canonical key layout (the prefix is configurable, `known` by default):
 *
 *   known:<env>:ratelimit:v1:{att:<subjectHmac>}:<routeClass>:<window>
 *
 * - `subjectHmac` = base64url-truncated HMAC-SHA-256 over
 *   `principalId + NUL + tenant/collection scope` using the configured key
 *   secret; the raw principal, Collection, email, session, IP, filename,
 *   blob, generation or URL NEVER enter the key text (the builder has no
 *   interpolation path and the normalizer rejects any key whose subject
 *   segment is not exactly the truncated base64url shape);
 * - the `{att:<hmac>}` segment doubles as the Redis Cluster hash tag so one
 *   principal's counters stay in one slot (the fixed Lua script in RL03);
 * - `<window>` is the fixed floor-rounded window start epoch ms (the same
 *   rounding the policy module pins), so the window identity lives IN the
 *   key and the TTL is only set on first write — no per-hit TTL refresh;
 * - the environment token is restricted to `[A-Za-z0-9_.-]` (no colon) so
 *   the key grammar parses unambiguously.
 *
 * The HMAC secret is resolved by the RL03 infrastructure adapter and passed
 * here as bytes; this module never reads environment variables and never
 * logs the secret.
 */
import { createHmac } from 'node:crypto';
import { ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES, type AttachmentRateLimitRouteClass } from './rate-limit-contracts.js';

/** Fixed key schema version (the `v1` segment). */
export const RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
/** base64url truncation length of the subject HMAC (32 chars ≈ 192 bits). */
export const RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
/** Hard ceiling on the full key length. */
export const RATE_LIMIT_KEY_MAX_LENGTH = 512;
/**
 * Per-field length ceiling of the HMAC input fields (1-256). This is the
 * UNIFIED ceiling shared with the transport `issue` collectionId schema: the
 * route rejects overlong/control-character collectionIds as a stable 422
 * BEFORE admission, so a schema-valid client input can never hit this
 * fail-closed boundary and be misreported as a 503 (KA-P4-AM-02).
 */
export const RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH = 256;

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
/** No colon: the key grammar must parse unambiguously. */
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
/**
 * Control characters rejected in every subject field — and reused by the
 * transport `issue` collectionId schema, so the codec character contract and
 * the route schema stay one contract (KA-P4-AM-02).
 */
export const RATE_LIMIT_SUBJECT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;

export interface RateLimitSubjectInput {
  readonly principalId: string;
  /** Tenant/collection scope; anonymous requests never reach the codec. */
  readonly scope: string;
}

export interface RateLimitKeyBuildInput {
  /** Redis key namespace prefix; default 'known' (config keyPrefix). */
  readonly keyPrefix?: string;
  /** Deployment environment token, e.g. 'prod' (1-64 chars, no colon). */
  readonly environment: string;
  /** Resolved HMAC secret bytes (never logged, never interpolated). */
  readonly keySecret: Buffer;
  readonly routeClass: AttachmentRateLimitRouteClass;
  readonly subject: RateLimitSubjectInput;
  /** Floor-rounded fixed-window start (epoch ms); see windowStartFor. */
  readonly windowStartEpochMs: number;
}

export type RateLimitKeyRejectReason =
  | 'malformed'
  | 'invalid_prefix'
  | 'invalid_environment'
  | 'invalid_schema_version'
  | 'invalid_hash_tag'
  | 'invalid_subject_hmac'
  | 'invalid_route_class'
  | 'invalid_window'
  | 'key_too_long';

/** Canonical parsed key parts (parse output / normalization target). */
export interface RateLimitKeyParts {
  readonly keyPrefix: string;
  readonly environment: string;
  readonly schemaVersion: 1;
  readonly subjectHmac: string;
  readonly routeClass: AttachmentRateLimitRouteClass;
  readonly windowStartEpochMs: number;
}

export type RateLimitKeyParseResult =
  | { readonly kind: 'ok'; readonly parts: RateLimitKeyParts }
  | { readonly kind: 'rejected'; readonly reason: RateLimitKeyRejectReason };

/** Programmer/deployment-input guard used by the key builder (never an HTTP error). */
export class RateLimitKeyError extends Error {
  readonly reason: RateLimitKeyRejectReason;
  constructor(reason: RateLimitKeyRejectReason, message: string) {
    super(message);
    this.name = 'RateLimitKeyError';
    this.reason = reason;
  }
}

/** Fail-closed subject validation: non-empty, bounded, no control characters. */
export function assertRateLimitSubject(subject: RateLimitSubjectInput): void {
  for (const field of ['principalId', 'scope'] as const) {
    const value = subject[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH) {
      throw new RateLimitKeyError(
        'malformed',
        `rate-limit subject ${field} must be 1-${RATE_LIMIT_SUBJECT_FIELD_MAX_LENGTH} characters`,
      );
    }
    if (RATE_LIMIT_SUBJECT_CONTROL_CHARACTER_PATTERN.test(value)) {
      throw new RateLimitKeyError('malformed', `rate-limit subject ${field} must not contain control characters`);
    }
  }
}

/**
 * HMAC-SHA-256 over `principalId + NUL + scope`, base64url-encoded and
 * truncated to `RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS`. The NUL separator
 * makes `a|bc` distinct from `ab|c`; the raw values only ever exist inside
 * the digest input, never in the key text.
 */
export function rateLimitSubjectHmac(keySecret: Buffer, subject: RateLimitSubjectInput): string {
  assertRateLimitSubject(subject);
  const digest = createHmac('sha256', keySecret)
    .update(`${subject.principalId}\u0000${subject.scope}`, 'utf8')
    .digest('base64url');
  return digest.slice(0, RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

// Canonical grammar. The prefix may contain ':' (config pattern parity with
// the cache namespace); the anchored `:ratelimit:v1:` literal plus the
// colon-free environment token make the parse unambiguous via backtracking.
const RATE_LIMIT_KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{att:([A-Za-z0-9_-]{32})\}:(issue|complete|download|status):(\d{1,16})$/u;

/**
 * Normalizes/parses a key into its canonical parts. Rejects every
 * non-canonical shape, including any key whose subject segment is not
 * exactly the 32-char base64url HMAC — a raw principal or secret pasted into
 * the key can never pass (plan §4.1.11).
 */
export function parseAttachmentRateLimitKey(key: string): RateLimitKeyParseResult {
  if (typeof key !== 'string' || key.length === 0 || key.length > RATE_LIMIT_KEY_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const match = RATE_LIMIT_KEY_PATTERN.exec(key);
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
      schemaVersion: RATE_LIMIT_KEY_SCHEMA_VERSION,
      subjectHmac: match[3]!,
      // The regex grammar only admits the four sealed route-class tokens
      // (issue/complete/download/status).
      routeClass: match[4] as AttachmentRateLimitRouteClass,
      windowStartEpochMs,
    }),
  };
}

/**
 * Builds the canonical admission key. Only the HMAC output and fixed tokens
 * can ever reach the key text; the raw subject is validated fail-closed
 * before hashing. The built key is self-checked through the normalizer.
 */
export function buildAttachmentRateLimitKey(input: RateLimitKeyBuildInput): string {
  const keyPrefix = input.keyPrefix ?? 'known';
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new RateLimitKeyError(
      'invalid_prefix',
      'rate-limit key prefix must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new RateLimitKeyError(
      'invalid_environment',
      'rate-limit key environment must be 1-64 characters of [A-Za-z0-9_.-]',
    );
  }
  if (!ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES.includes(input.routeClass)) {
    throw new RateLimitKeyError('invalid_route_class', `unknown rate-limit route class: ${String(input.routeClass)}`);
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new RateLimitKeyError('invalid_window', 'rate-limit key window must be a non-negative safe integer');
  }
  const subjectHmac = rateLimitSubjectHmac(input.keySecret, input.subject);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{att:${subjectHmac}}:${input.routeClass}:${input.windowStartEpochMs}`;
  if (key.length > RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new RateLimitKeyError('key_too_long', `rate-limit key exceeds ${RATE_LIMIT_KEY_MAX_LENGTH} characters`);
  }
  if (parseAttachmentRateLimitKey(key).kind !== 'ok') {
    // The builder is deterministic; a failure here is a contract corruption.
    throw new RateLimitKeyError('malformed', 'built rate-limit key failed canonical parse');
  }
  return key;
}
