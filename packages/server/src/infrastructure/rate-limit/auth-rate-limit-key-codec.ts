/**
 * FIX-M-001 auth rate-limit HMAC key codec (key contract mirrors P4A-RL02
 * §2.3/§4.1.11 but is deliberately BUSINESS-KEY INDEPENDENT: the auth
 * limiter never reuses the Attachment codec, prefix, hash tag or route
 * classes — only the same *pattern*).
 *
 * Canonical key layout (the prefix is configurable, `known` by default):
 *
 *   known:<env>:ratelimit:v1:{auth:<clientIpHmac>}:<routeFamily>:<window>
 *
 * - `clientIpHmac` = base64url-truncated HMAC-SHA-256 over the TRUSTED client
 *   IP (Fastify `request.ip`, i.e. AFTER proxy resolution — never a raw
 *   spoofable XFF header) using the configured key secret; the raw IP never
 *   enters the key text (the builder has no interpolation path and the
 *   normalizer rejects any key whose subject segment is not exactly the
 *   truncated base64url shape);
 * - the `{auth:<hmac>}` segment doubles as the Redis Cluster hash tag so one
 *   client IP's counters stay in one slot (the fixed Lua script in RL03);
 * - `<routeFamily>` is one of the sealed auth families (`oidc-start`,
 *   `oidc-callback`, `session`, `me`, `sign-in`, `sign-up`, `otp`, `reset`,
 *   `link`, `mfa`, `oauth-callback`, `oauth-authorize`, `oauth-register`,
 *   `oauth-token` — 1:1 with AUTH_RATE_LIMITED_PATHS), so OIDC/session/me,
 *   the C4 auth families, and the MCP OAuth issuer families (authorize/
 *   consent vs DCR register vs token) never share a counter; the legacy
 *   OIDC families stay sealed until F3 removes them (G1 §10);
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

/** Sealed auth route families (1:1 with AUTH_RATE_LIMITED_PATHS). */
export const AUTH_RATE_LIMIT_ROUTE_FAMILIES = Object.freeze([
  // Legacy OIDC surface (F1 quarantine; removed with F3).
  'oidc-start', 'oidc-callback',
  // Product session/me surface.
  'session', 'me',
  // C4 auth families: sign-in, sign-up, OTP send/verify, reset, link, MFA,
  // parameterized OAuth callback, plus MCP OAuth authorize vs DCR register
  // vs token (DCR must not share the authorize/consent bucket).
  'sign-in', 'sign-up', 'otp', 'reset', 'link', 'mfa', 'oauth-callback',
  'oauth-authorize', 'oauth-register', 'oauth-token',
] as const);
export type AuthRateLimitRouteFamily = (typeof AUTH_RATE_LIMIT_ROUTE_FAMILIES)[number];

/** Fixed key schema version (the `v1` segment). */
export const AUTH_RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
/** base64url truncation length of the subject HMAC (32 chars ≈ 192 bits). */
export const AUTH_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
/** Hard ceiling on the full key length. */
export const AUTH_RATE_LIMIT_KEY_MAX_LENGTH = 512;
/** Per-field length ceiling of the HMAC input fields. */
export const AUTH_RATE_LIMIT_CLIENT_IP_MAX_LENGTH = 256;

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
/** No colon: the key grammar must parse unambiguously. */
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;

export interface AuthRateLimitKeyBuildInput {
  /** Redis key namespace prefix; default 'known' (config keyPrefix). */
  readonly keyPrefix?: string;
  /** Deployment environment token, e.g. 'prod' (1-64 chars, no colon). */
  readonly environment: string;
  /** Resolved HMAC secret bytes (never logged, never interpolated). */
  readonly keySecret: Buffer;
  readonly routeFamily: AuthRateLimitRouteFamily;
  /** Trusted client IP after proxy resolution (never raw XFF). */
  readonly clientIp: string;
  /** Floor-rounded fixed-window start (epoch ms). */
  readonly windowStartEpochMs: number;
}

export type AuthRateLimitKeyRejectReason =
  | 'malformed'
  | 'invalid_prefix'
  | 'invalid_environment'
  | 'invalid_schema_version'
  | 'invalid_hash_tag'
  | 'invalid_subject_hmac'
  | 'invalid_route_family'
  | 'invalid_window'
  | 'key_too_long';

/** Canonical parsed key parts (parse output / normalization target). */
export interface AuthRateLimitKeyParts {
  readonly keyPrefix: string;
  readonly environment: string;
  readonly schemaVersion: 1;
  readonly subjectHmac: string;
  readonly routeFamily: AuthRateLimitRouteFamily;
  readonly windowStartEpochMs: number;
}

export type AuthRateLimitKeyParseResult =
  | { readonly kind: 'ok'; readonly parts: AuthRateLimitKeyParts }
  | { readonly kind: 'rejected'; readonly reason: AuthRateLimitKeyRejectReason };

/** Programmer/deployment-input guard used by the key builder (never an HTTP error). */
export class AuthRateLimitKeyError extends Error {
  readonly reason: AuthRateLimitKeyRejectReason;
  constructor(reason: AuthRateLimitKeyRejectReason, message: string) {
    super(message);
    this.name = 'AuthRateLimitKeyError';
    this.reason = reason;
  }
}

/** Fail-closed client-IP validation: non-empty, bounded, no control characters. */
export function assertAuthRateLimitClientIp(clientIp: string): void {
  if (typeof clientIp !== 'string' || clientIp.length === 0 || clientIp.length > AUTH_RATE_LIMIT_CLIENT_IP_MAX_LENGTH) {
    throw new AuthRateLimitKeyError(
      'malformed',
      `auth rate-limit clientIp must be 1-${AUTH_RATE_LIMIT_CLIENT_IP_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(clientIp)) {
    throw new AuthRateLimitKeyError('malformed', 'auth rate-limit clientIp must not contain control characters');
  }
}

/**
 * HMAC-SHA-256 over the trusted client IP, base64url-encoded and truncated to
 * `AUTH_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS`. The raw IP only ever exists
 * inside the digest input, never in the key text.
 */
export function authRateLimitSubjectHmac(keySecret: Buffer, clientIp: string): string {
  assertAuthRateLimitClientIp(clientIp);
  const digest = createHmac('sha256', keySecret)
    .update(clientIp, 'utf8')
    .digest('base64url');
  return digest.slice(0, AUTH_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

// Canonical grammar. The prefix may contain ':' (config pattern parity with
// the cache namespace); the anchored `:ratelimit:v1:` literal plus the
// colon-free environment token make the parse unambiguous via backtracking.
const AUTH_RATE_LIMIT_KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{auth:([A-Za-z0-9_-]{32})\}:(oidc-start|oidc-callback|session|me|sign-in|sign-up|otp|reset|link|mfa|oauth-callback|oauth-authorize|oauth-register|oauth-token):(\d{1,16})$/u;

/**
 * Normalizes/parses a key into its canonical parts. Rejects every
 * non-canonical shape, including any key whose subject segment is not
 * exactly the 32-char base64url HMAC — a raw IP pasted into the key can never
 * pass (same §4.1.11 isolation the Attachment codec pins).
 */
export function parseAuthRateLimitKey(key: string): AuthRateLimitKeyParseResult {
  if (typeof key !== 'string' || key.length === 0 || key.length > AUTH_RATE_LIMIT_KEY_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const match = AUTH_RATE_LIMIT_KEY_PATTERN.exec(key);
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
      schemaVersion: AUTH_RATE_LIMIT_KEY_SCHEMA_VERSION,
      subjectHmac: match[3]!,
      // The regex grammar only admits the sealed family tokens.
      routeFamily: match[4] as AuthRateLimitRouteFamily,
      windowStartEpochMs,
    }),
  };
}

/**
 * Builds the canonical admission key. Only the HMAC output and fixed tokens
 * can ever reach the key text; the raw client IP is validated fail-closed
 * before hashing. The built key is self-checked through the normalizer.
 */
export function buildAuthRateLimitKey(input: AuthRateLimitKeyBuildInput): string {
  const keyPrefix = input.keyPrefix ?? 'known';
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new AuthRateLimitKeyError(
      'invalid_prefix',
      'auth rate-limit key prefix must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new AuthRateLimitKeyError(
      'invalid_environment',
      'auth rate-limit key environment must be 1-64 characters of [A-Za-z0-9_.-]',
    );
  }
  if (!AUTH_RATE_LIMIT_ROUTE_FAMILIES.includes(input.routeFamily)) {
    throw new AuthRateLimitKeyError('invalid_route_family', `unknown auth rate-limit route family: ${String(input.routeFamily)}`);
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new AuthRateLimitKeyError('invalid_window', 'auth rate-limit key window must be a non-negative safe integer');
  }
  const subjectHmac = authRateLimitSubjectHmac(input.keySecret, input.clientIp);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${AUTH_RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{auth:${subjectHmac}}:${input.routeFamily}:${input.windowStartEpochMs}`;
  if (key.length > AUTH_RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new AuthRateLimitKeyError('key_too_long', `auth rate-limit key exceeds ${AUTH_RATE_LIMIT_KEY_MAX_LENGTH} characters`);
  }
  if (parseAuthRateLimitKey(key).kind !== 'ok') {
    // The builder is deterministic; a failure here is a contract corruption.
    throw new AuthRateLimitKeyError('malformed', 'built auth rate-limit key failed canonical parse');
  }
  return key;
}
