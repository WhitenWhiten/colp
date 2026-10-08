/**
 * FIX-M-006 Search rate-limit HMAC key codec (mirrors the FIX-M-001 auth
 * codec pattern: same grammar family, deliberately BUSINESS-KEY INDEPENDENT).
 *
 * Canonical key layout (the prefix is configurable, `known` by default):
 *
 *   known:<env>:ratelimit:v1:{search:<subjectHmac>}:<family>:<window>
 *
 * - `subjectHmac` = base64url-truncated HMAC-SHA-256 over the rate-limit
 *   SUBJECT — the trusted client IP for the `anonymous` family (Fastify
 *   `request.ip`, i.e. AFTER trusted-ingress proxy resolution, never a raw
 *   spoofable XFF header) or the account id for the `account` family. The
 *   raw subject never enters the key text (the builder has no interpolation
 *   path and the normalizer rejects any key whose subject segment is not
 *   exactly the truncated base64url shape);
 * - the `{search:<hmac>}` segment doubles as the Redis Cluster hash tag so
 *   one subject's counters stay in one slot (the fixed Lua script);
 * - `<family>` is one of the sealed Search identity strategies
 *   (`anonymous` | `account`), so the anonymous IP budget and the account
 *   budget never share a counter (PUB-R03 independent anonymous budget);
 * - `<window>` is the fixed floor-rounded window start epoch ms; the window
 *   identity itself comes from Redis SERVER time inside the Lua script
 *   (host-time seed replaced there), so replicas with skewed clocks share one
 *   quota;
 * - the environment token is restricted to `[A-Za-z0-9_.-]` (no colon) so
 *   the key grammar parses unambiguously.
 *
 * The HMAC secret is resolved by the bootstrap composition and passed here as
 * bytes; this module never reads environment variables and never logs the
 * secret.
 */
import { createHmac } from 'node:crypto';

/** Sealed Search identity families (1:1 with the route's principal kinds). */
export const SEARCH_RATE_LIMIT_ROUTE_FAMILIES = Object.freeze([
  'anonymous', 'account',
] as const);
export type SearchRateLimitRouteFamily = (typeof SEARCH_RATE_LIMIT_ROUTE_FAMILIES)[number];

/** Fixed key schema version (the `v1` segment). */
export const SEARCH_RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
/** base64url truncation length of the subject HMAC (32 chars ≈ 192 bits). */
export const SEARCH_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
/** Hard ceiling on the full key length. */
export const SEARCH_RATE_LIMIT_KEY_MAX_LENGTH = 512;
/** Per-field length ceiling of the HMAC input fields. */
export const SEARCH_RATE_LIMIT_SUBJECT_MAX_LENGTH = 256;

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
/** No colon: the key grammar must parse unambiguously. */
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;

export interface SearchRateLimitKeyBuildInput {
  /** Redis key namespace prefix; default 'known' (config keyPrefix). */
  readonly keyPrefix?: string;
  /** Deployment environment token, e.g. 'prod' (1-64 chars, no colon). */
  readonly environment: string;
  /** Resolved HMAC secret bytes (never logged, never interpolated). */
  readonly keySecret: Buffer;
  /** Sealed Search identity family. */
  readonly family: SearchRateLimitRouteFamily;
  /** Trusted client IP (anonymous) or account id (account); never raw XFF. */
  readonly subject: string;
  /** Floor-rounded fixed-window start (epoch ms). */
  readonly windowStartEpochMs: number;
}

export type SearchRateLimitKeyRejectReason =
  | 'malformed'
  | 'invalid_prefix'
  | 'invalid_environment'
  | 'invalid_schema_version'
  | 'invalid_hash_tag'
  | 'invalid_subject_hmac'
  | 'invalid_family'
  | 'invalid_window'
  | 'key_too_long';

/** Canonical parsed key parts (parse output / normalization target). */
export interface SearchRateLimitKeyParts {
  readonly keyPrefix: string;
  readonly environment: string;
  readonly schemaVersion: 1;
  readonly subjectHmac: string;
  readonly family: SearchRateLimitRouteFamily;
  readonly windowStartEpochMs: number;
}

export type SearchRateLimitKeyParseResult =
  | { readonly kind: 'ok'; readonly parts: SearchRateLimitKeyParts }
  | { readonly kind: 'rejected'; readonly reason: SearchRateLimitKeyRejectReason };

/** Programmer/deployment-input guard used by the key builder (never an HTTP error). */
export class SearchRateLimitKeyError extends Error {
  readonly reason: SearchRateLimitKeyRejectReason;
  constructor(reason: SearchRateLimitKeyRejectReason, message: string) {
    super(message);
    this.name = 'SearchRateLimitKeyError';
    this.reason = reason;
  }
}

/** Fail-closed subject validation: non-empty, bounded, no control characters. */
export function assertSearchRateLimitSubject(subject: string): void {
  if (typeof subject !== 'string' || subject.length === 0
    || subject.length > SEARCH_RATE_LIMIT_SUBJECT_MAX_LENGTH) {
    throw new SearchRateLimitKeyError(
      'malformed',
      `search rate-limit subject must be 1-${SEARCH_RATE_LIMIT_SUBJECT_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(subject)) {
    throw new SearchRateLimitKeyError('malformed', 'search rate-limit subject must not contain control characters');
  }
}

/**
 * HMAC-SHA-256 over the rate-limit subject (client IP or account id),
 * base64url-encoded and truncated to `SEARCH_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS`.
 * The raw subject only ever exists inside the digest input, never in the key
 * text.
 */
export function searchRateLimitSubjectHmac(keySecret: Buffer, subject: string): string {
  assertSearchRateLimitSubject(subject);
  const digest = createHmac('sha256', keySecret)
    .update(subject, 'utf8')
    .digest('base64url');
  return digest.slice(0, SEARCH_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

// Canonical grammar (mirrors the auth codec: anchored `:ratelimit:v1:` plus
// the colon-free environment token; the `{search:<hmac>}` hash-tag segment
// isolates the Search namespace from auth/attachment counters).
const SEARCH_RATE_LIMIT_KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{search:([A-Za-z0-9_-]{32})\}:(anonymous|account):(\d{1,16})$/u;

/**
 * Normalizes/parses a key into its canonical parts. Rejects every
 * non-canonical shape, including any key whose subject segment is not
 * exactly the 32-char base64url HMAC — a raw IP/account id pasted into the
 * key can never pass.
 */
export function parseSearchRateLimitKey(key: string): SearchRateLimitKeyParseResult {
  if (typeof key !== 'string' || key.length === 0 || key.length > SEARCH_RATE_LIMIT_KEY_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const match = SEARCH_RATE_LIMIT_KEY_PATTERN.exec(key);
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
      schemaVersion: SEARCH_RATE_LIMIT_KEY_SCHEMA_VERSION,
      subjectHmac: match[3]!,
      // The regex grammar only admits the two sealed family tokens.
      family: match[4] as SearchRateLimitRouteFamily,
      windowStartEpochMs,
    }),
  };
}

/**
 * Builds the canonical admission key. Only the HMAC output and fixed tokens
 * can ever reach the key text; the raw subject is validated fail-closed
 * before hashing. The built key is self-checked through the normalizer.
 */
export function buildSearchRateLimitKey(input: SearchRateLimitKeyBuildInput): string {
  const keyPrefix = input.keyPrefix ?? 'known';
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new SearchRateLimitKeyError(
      'invalid_prefix',
      'search rate-limit key prefix must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new SearchRateLimitKeyError(
      'invalid_environment',
      'search rate-limit key environment must be 1-64 characters of [A-Za-z0-9_.-]',
    );
  }
  if (!SEARCH_RATE_LIMIT_ROUTE_FAMILIES.includes(input.family)) {
    throw new SearchRateLimitKeyError('invalid_family', `unknown search rate-limit family: ${String(input.family)}`);
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new SearchRateLimitKeyError('invalid_window', 'search rate-limit key window must be a non-negative safe integer');
  }
  const subjectHmac = searchRateLimitSubjectHmac(input.keySecret, input.subject);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${SEARCH_RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{search:${subjectHmac}}:${input.family}:${input.windowStartEpochMs}`;
  if (key.length > SEARCH_RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new SearchRateLimitKeyError('key_too_long', `search rate-limit key exceeds ${SEARCH_RATE_LIMIT_KEY_MAX_LENGTH} characters`);
  }
  if (parseSearchRateLimitKey(key).kind !== 'ok') {
    // The builder is deterministic; a failure here is a contract corruption.
    throw new SearchRateLimitKeyError('malformed', 'built search rate-limit key failed canonical parse');
  }
  return key;
}
