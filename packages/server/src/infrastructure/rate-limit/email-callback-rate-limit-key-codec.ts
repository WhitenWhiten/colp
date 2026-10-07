/**
 * FIX-L-061 email callback ingress rate-limit HMAC key codec (audit
 * KA-P5-SOC-16). Mirrors the FIX-M-018 / FIX-L-049 codec pattern but is
 * deliberately BUSINESS-KEY INDEPENDENT: the callback limiter never reuses
 * the auth/search/MCP/attachment/delivery codecs, prefixes, hash tags or
 * route classes — only the same *pattern*.
 *
 * Canonical key layout (the prefix is configurable, `known` by default):
 *
 *   known:<env>:ratelimit:v1:{ecb:<subjectHmac>}:ip:<window>
 *
 * - `subjectHmac` = base64url-truncated HMAC-SHA-256 over the canonical
 *   subject facts (the trusted client IP) using the configured key secret;
 *   the RAW IP never enters the key text — the builder has no interpolation
 *   path and the normalizer rejects any key whose subject segment is not
 *   exactly the truncated base64url shape;
 * - the `{ecb:<hmac>}` segment doubles as the Redis Cluster hash tag so one
 *   subject's counters stay in one slot;
 * - `<policy>` is the single sealed email-callback policy (`ip`) — there is
 *   no token policy on this surface (the callback is credential-free by
 *   design, so the per-IP budget is the only quota);
 * - `<window>` is the fixed floor-rounded window start epoch ms; the window
 *   identity itself comes from Redis SERVER time inside the shared frozen
 *   Lua script (host-time seed replaced there), so replicas with skewed
 *   clocks share one quota;
 * - the environment token is restricted to `[A-Za-z0-9_.-]` (no colon) so
 *   the key grammar parses unambiguously.
 *
 * The ip policy admits facts up to a canonical IP length; both IPv4 and
 * IPv6 literals (<= 45 chars) fit under the 64-char ceiling and are
 * control-character-free. The HMAC secret is resolved by the bootstrap
 * composition and passed here as bytes; this module never reads environment
 * variables and never logs the secret.
 */
import { createHmac } from 'node:crypto';
import {
  EMAIL_CALLBACK_RATE_LIMIT_POLICIES,
  type EmailCallbackRateLimitPolicy,
} from '../../modules/email/index.js';

/** Fixed key schema version (the `v1` segment). */
export const EMAIL_CALLBACK_RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
/** base64url truncation length of the subject HMAC (32 chars ≈ 192 bits). */
export const EMAIL_CALLBACK_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
/** Hard ceiling on the full key length. */
export const EMAIL_CALLBACK_RATE_LIMIT_KEY_MAX_LENGTH = 512;
/** Per-field length ceiling of the HMAC input for the `ip` policy. */
export const EMAIL_CALLBACK_RATE_LIMIT_IP_FACTS_MAX_LENGTH = 64;

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
/** No colon: the key grammar must parse unambiguously. */
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;

export interface EmailCallbackRateLimitKeyBuildInput {
  /** Redis key namespace prefix; default 'known' (config keyPrefix). */
  readonly keyPrefix?: string;
  /** Deployment environment token, e.g. 'prod' (1-64 chars, no colon). */
  readonly environment: string;
  /** Resolved HMAC secret bytes (never logged, never interpolated). */
  readonly keySecret: Buffer;
  /** Canonical subject facts (the trusted client IP; bounded, no control characters). */
  readonly facts: string;
  /** Floor-rounded fixed-window start (epoch ms). */
  readonly windowStartEpochMs: number;
}

export type EmailCallbackRateLimitKeyRejectReason =
  | 'malformed'
  | 'invalid_prefix'
  | 'invalid_environment'
  | 'invalid_schema_version'
  | 'invalid_hash_tag'
  | 'invalid_subject_hmac'
  | 'invalid_policy'
  | 'invalid_window'
  | 'key_too_long';

/** Canonical parsed key parts (parse output / normalization target). */
export interface EmailCallbackRateLimitKeyParts {
  readonly keyPrefix: string;
  readonly environment: string;
  readonly schemaVersion: 1;
  readonly subjectHmac: string;
  readonly policy: 'ip';
  readonly windowStartEpochMs: number;
}

export type EmailCallbackRateLimitKeyParseResult =
  | { readonly kind: 'ok'; readonly parts: EmailCallbackRateLimitKeyParts }
  | { readonly kind: 'rejected'; readonly reason: EmailCallbackRateLimitKeyRejectReason };

/** Programmer/deployment-input guard used by the key builder (never an HTTP error). */
export class EmailCallbackRateLimitKeyError extends Error {
  readonly reason: EmailCallbackRateLimitKeyRejectReason;
  constructor(reason: EmailCallbackRateLimitKeyRejectReason, message: string) {
    super(message);
    this.name = 'EmailCallbackRateLimitKeyError';
    this.reason = reason;
  }
}

/** Fail-closed subject validation: sealed policy, non-empty, bounded, no control characters. */
export function assertEmailCallbackRateLimitSubject(policy: EmailCallbackRateLimitPolicy, facts: string): void {
  if (!EMAIL_CALLBACK_RATE_LIMIT_POLICIES.includes(policy)) {
    throw new EmailCallbackRateLimitKeyError('invalid_policy', `unknown email callback rate-limit policy: ${String(policy)}`);
  }
  if (typeof facts !== 'string' || facts.length === 0 || facts.length > EMAIL_CALLBACK_RATE_LIMIT_IP_FACTS_MAX_LENGTH) {
    throw new EmailCallbackRateLimitKeyError(
      'malformed',
      `email callback rate-limit ${policy} facts must be 1-${EMAIL_CALLBACK_RATE_LIMIT_IP_FACTS_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(facts)) {
    throw new EmailCallbackRateLimitKeyError('malformed', 'email callback rate-limit facts must not contain control characters');
  }
}

/**
 * HMAC-SHA-256 over the canonical facts, base64url-encoded and truncated to
 * `EMAIL_CALLBACK_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS`. The raw facts
 * (client IP) only ever exist inside the digest input, never in the key text.
 */
export function emailCallbackRateLimitSubjectHmac(keySecret: Buffer, facts: string): string {
  assertEmailCallbackRateLimitSubject('ip', facts);
  const digest = createHmac('sha256', keySecret)
    .update(facts, 'utf8')
    .digest('base64url');
  return digest.slice(0, EMAIL_CALLBACK_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

// Canonical grammar. The prefix may contain ':' (config pattern parity with
// the cache namespace); the anchored `:ratelimit:v1:` literal plus the
// colon-free environment token make the parse unambiguous via backtracking.
const EMAIL_CALLBACK_RATE_LIMIT_KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{ecb:([A-Za-z0-9_-]{32})\}:ip:(\d{1,16})$/u;

/**
 * Normalizes/parses a key into its canonical parts. Rejects every
 * non-canonical shape, including any key whose subject segment is not
 * exactly the 32-char base64url HMAC — raw facts pasted into the key can
 * never pass.
 */
export function parseEmailCallbackRateLimitKey(key: string): EmailCallbackRateLimitKeyParseResult {
  if (typeof key !== 'string' || key.length === 0 || key.length > EMAIL_CALLBACK_RATE_LIMIT_KEY_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const match = EMAIL_CALLBACK_RATE_LIMIT_KEY_PATTERN.exec(key);
  if (!match) return { kind: 'rejected', reason: 'malformed' };
  const windowRaw = match[4]!;
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
      schemaVersion: EMAIL_CALLBACK_RATE_LIMIT_KEY_SCHEMA_VERSION,
      subjectHmac: match[3]!,
      // The regex grammar only admits the sealed ip policy token.
      policy: 'ip',
      windowStartEpochMs,
    }),
  };
}

/**
 * Builds the canonical admission key. Only the HMAC output and fixed tokens
 * can ever reach the key text; the raw facts are validated fail-closed
 * before hashing. The built key is self-checked through the normalizer.
 */
export function buildEmailCallbackRateLimitKey(input: EmailCallbackRateLimitKeyBuildInput): string {
  const keyPrefix = input.keyPrefix ?? 'known';
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new EmailCallbackRateLimitKeyError(
      'invalid_prefix',
      'email callback rate-limit key prefix must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new EmailCallbackRateLimitKeyError(
      'invalid_environment',
      'email callback rate-limit key environment must be 1-64 characters of [A-Za-z0-9_.-]',
    );
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new EmailCallbackRateLimitKeyError('invalid_window', 'email callback rate-limit key window must be a non-negative safe integer');
  }
  const subjectHmac = emailCallbackRateLimitSubjectHmac(input.keySecret, input.facts);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${EMAIL_CALLBACK_RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{ecb:${subjectHmac}}:ip:${input.windowStartEpochMs}`;
  if (key.length > EMAIL_CALLBACK_RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new EmailCallbackRateLimitKeyError('key_too_long', `email callback rate-limit key exceeds ${EMAIL_CALLBACK_RATE_LIMIT_KEY_MAX_LENGTH} characters`);
  }
  if (parseEmailCallbackRateLimitKey(key).kind !== 'ok') {
    // The builder is deterministic; a failure here is a contract corruption.
    throw new EmailCallbackRateLimitKeyError('malformed', 'built email callback rate-limit key failed canonical parse');
  }
  return key;
}
