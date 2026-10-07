/**
 * FIX-L-049 delivery request-limit HMAC key codec (mirrors the FIX-M-018 MCP
 * codec pattern but is deliberately BUSINESS-KEY INDEPENDENT: the delivery
 * limiter never reuses the auth/search/MCP/Attachment codecs, prefixes, hash
 * tags or route classes — only the same *pattern*).
 *
 * Canonical key layout (the prefix is configurable, `known` by default):
 *
 *   known:<env>:ratelimit:v1:{dlv:<subjectHmac>}:<policy>:<window>
 *
 * - `subjectHmac` = base64url-truncated HMAC-SHA-256 over the canonical
 *   subject facts (the trusted client IP for `ip`, the raw capability token
 *   for `token`) using the configured key secret; the RAW IP and the RAW
 *   capability token (a bearer secret) never enter the key text — the
 *   builder has no interpolation path and the normalizer rejects any key
 *   whose subject segment is not exactly the truncated base64url shape;
 * - the `{dlv:<hmac>}` segment doubles as the Redis Cluster hash tag so one
 *   subject's counters stay in one slot;
 * - `<policy>` is one of the two sealed delivery policies (`ip`, `token`) —
 *   the two budgets are separate key namespaces and can NEVER share a
 *   counter;
 * - `<window>` is the fixed floor-rounded window start epoch ms; the window
 *   identity itself comes from Redis SERVER time inside the shared frozen
 *   Lua script (host-time seed replaced there), so replicas with skewed
 *   clocks share one quota;
 * - the environment token is restricted to `[A-Za-z0-9_.-]` (no colon) so
 *   the key grammar parses unambiguously.
 *
 * The token policy admits long facts (I10 capabilities are ~600 chars and
 * the route accepts up to 1024), while the ip policy is capped at a
 * canonical IP length; both are control-character-free. The HMAC secret is
 * resolved by the bootstrap composition and passed here as bytes; this
 * module never reads environment variables and never logs the secret.
 */
import { createHmac } from 'node:crypto';
import {
  DELIVERY_REQUEST_RATE_LIMIT_POLICIES,
  type DeliveryRequestRateLimitPolicy,
} from '../../modules/attachments/index.js';

/** Fixed key schema version (the `v1` segment). */
export const DELIVERY_RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
/** base64url truncation length of the subject HMAC (32 chars ≈ 192 bits). */
export const DELIVERY_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
/** Hard ceiling on the full key length. */
export const DELIVERY_RATE_LIMIT_KEY_MAX_LENGTH = 512;
/** Per-field length ceiling of the HMAC input for the `ip` policy. */
export const DELIVERY_RATE_LIMIT_IP_FACTS_MAX_LENGTH = 64;
/** Per-field length ceiling of the HMAC input for the `token` policy. */
export const DELIVERY_RATE_LIMIT_TOKEN_FACTS_MAX_LENGTH = 1024;

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
/** No colon: the key grammar must parse unambiguously. */
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;

export interface DeliveryRateLimitKeyBuildInput {
  /** Redis key namespace prefix; default 'known' (config keyPrefix). */
  readonly keyPrefix?: string;
  /** Deployment environment token, e.g. 'prod' (1-64 chars, no colon). */
  readonly environment: string;
  /** Resolved HMAC secret bytes (never logged, never interpolated). */
  readonly keySecret: Buffer;
  readonly policy: DeliveryRequestRateLimitPolicy;
  /** Canonical subject facts (bounded, no control characters). */
  readonly facts: string;
  /** Floor-rounded fixed-window start (epoch ms). */
  readonly windowStartEpochMs: number;
}

export type DeliveryRateLimitKeyRejectReason =
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
export interface DeliveryRateLimitKeyParts {
  readonly keyPrefix: string;
  readonly environment: string;
  readonly schemaVersion: 1;
  readonly subjectHmac: string;
  readonly policy: DeliveryRequestRateLimitPolicy;
  readonly windowStartEpochMs: number;
}

export type DeliveryRateLimitKeyParseResult =
  | { readonly kind: 'ok'; readonly parts: DeliveryRateLimitKeyParts }
  | { readonly kind: 'rejected'; readonly reason: DeliveryRateLimitKeyRejectReason };

/** Programmer/deployment-input guard used by the key builder (never an HTTP error). */
export class DeliveryRateLimitKeyError extends Error {
  readonly reason: DeliveryRateLimitKeyRejectReason;
  constructor(reason: DeliveryRateLimitKeyRejectReason, message: string) {
    super(message);
    this.name = 'DeliveryRateLimitKeyError';
    this.reason = reason;
  }
}

/** Fail-closed subject validation: sealed policy, non-empty, bounded, no control characters. */
export function assertDeliveryRateLimitSubject(
  policy: DeliveryRequestRateLimitPolicy,
  facts: string,
): void {
  if (!DELIVERY_REQUEST_RATE_LIMIT_POLICIES.includes(policy)) {
    throw new DeliveryRateLimitKeyError('invalid_policy', `unknown delivery rate-limit policy: ${String(policy)}`);
  }
  const maxLength = policy === 'ip'
    ? DELIVERY_RATE_LIMIT_IP_FACTS_MAX_LENGTH
    : DELIVERY_RATE_LIMIT_TOKEN_FACTS_MAX_LENGTH;
  if (typeof facts !== 'string' || facts.length === 0 || facts.length > maxLength) {
    throw new DeliveryRateLimitKeyError(
      'malformed',
      `delivery rate-limit ${policy} facts must be 1-${maxLength} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(facts)) {
    throw new DeliveryRateLimitKeyError('malformed', 'delivery rate-limit facts must not contain control characters');
  }
}

/**
 * HMAC-SHA-256 over the canonical facts, base64url-encoded and truncated to
 * `DELIVERY_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS`. The raw facts (client
 * IP / capability token) only ever exist inside the digest input, never in
 * the key text.
 */
export function deliveryRateLimitSubjectHmac(
  keySecret: Buffer,
  policy: DeliveryRequestRateLimitPolicy,
  facts: string,
): string {
  assertDeliveryRateLimitSubject(policy, facts);
  const digest = createHmac('sha256', keySecret)
    .update(facts, 'utf8')
    .digest('base64url');
  return digest.slice(0, DELIVERY_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

// Canonical grammar. The prefix may contain ':' (config pattern parity with
// the cache namespace); the anchored `:ratelimit:v1:` literal plus the
// colon-free environment token make the parse unambiguous via backtracking.
const DELIVERY_RATE_LIMIT_KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{dlv:([A-Za-z0-9_-]{32})\}:(ip|token):(\d{1,16})$/u;

/**
 * Normalizes/parses a key into its canonical parts. Rejects every
 * non-canonical shape, including any key whose subject segment is not
 * exactly the 32-char base64url HMAC — raw facts pasted into the key can
 * never pass.
 */
export function parseDeliveryRateLimitKey(key: string): DeliveryRateLimitKeyParseResult {
  if (typeof key !== 'string' || key.length === 0 || key.length > DELIVERY_RATE_LIMIT_KEY_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const match = DELIVERY_RATE_LIMIT_KEY_PATTERN.exec(key);
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
      schemaVersion: DELIVERY_RATE_LIMIT_KEY_SCHEMA_VERSION,
      subjectHmac: match[3]!,
      // The regex grammar only admits the two sealed policy tokens.
      policy: match[4] as DeliveryRequestRateLimitPolicy,
      windowStartEpochMs,
    }),
  };
}

/**
 * Builds the canonical admission key. Only the HMAC output and fixed tokens
 * can ever reach the key text; the raw facts are validated fail-closed
 * before hashing. The built key is self-checked through the normalizer.
 */
export function buildDeliveryRateLimitKey(input: DeliveryRateLimitKeyBuildInput): string {
  const keyPrefix = input.keyPrefix ?? 'known';
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new DeliveryRateLimitKeyError(
      'invalid_prefix',
      'delivery rate-limit key prefix must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new DeliveryRateLimitKeyError(
      'invalid_environment',
      'delivery rate-limit key environment must be 1-64 characters of [A-Za-z0-9_.-]',
    );
  }
  if (!DELIVERY_REQUEST_RATE_LIMIT_POLICIES.includes(input.policy)) {
    throw new DeliveryRateLimitKeyError('invalid_policy', `unknown delivery rate-limit policy: ${String(input.policy)}`);
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new DeliveryRateLimitKeyError('invalid_window', 'delivery rate-limit key window must be a non-negative safe integer');
  }
  const subjectHmac = deliveryRateLimitSubjectHmac(input.keySecret, input.policy, input.facts);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${DELIVERY_RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{dlv:${subjectHmac}}:${input.policy}:${input.windowStartEpochMs}`;
  if (key.length > DELIVERY_RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new DeliveryRateLimitKeyError('key_too_long', `delivery rate-limit key exceeds ${DELIVERY_RATE_LIMIT_KEY_MAX_LENGTH} characters`);
  }
  if (parseDeliveryRateLimitKey(key).kind !== 'ok') {
    // The builder is deterministic; a failure here is a contract corruption.
    throw new DeliveryRateLimitKeyError('malformed', 'built delivery rate-limit key failed canonical parse');
  }
  return key;
}
