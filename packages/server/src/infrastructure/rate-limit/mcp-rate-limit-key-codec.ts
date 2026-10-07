/**
 * FIX-M-018 MCP rate-limit HMAC key codec (FIX-M-018; mirrors the FIX-M-001
 * auth codec pattern but is deliberately BUSINESS-KEY INDEPENDENT: the MCP
 * limiter never reuses the auth/search/Attachment codecs, prefixes, hash
 * tags or route classes — only the same *pattern*).
 *
 * Canonical key layout (the prefix is configurable, `known` by default):
 *
 *   known:<env>:ratelimit:v1:{mcp:<factsHmac>}:<policy>:<window>
 *
 * - `factsHmac` = base64url-truncated HMAC-SHA-256 over the canonical
 *   principal/client/binding FACTS string using the configured key secret;
 *   the raw facts (principal ids, client ids, audiences, epochs, IPs) never
 *   enter the key text — the builder has no interpolation path and the
 *   normalizer rejects any key whose subject segment is not exactly the
 *   truncated base64url shape;
 * - the `{mcp:<hmac>}` segment doubles as the Redis Cluster hash tag so one
 *   subject's counters stay in one slot;
 * - `<policy>` is one of the three sealed MCP policies (`request`,
 *   `approval`, `commit-distinct-plan`) — the three budgets are separate key
 *   namespaces and can NEVER share a counter (三类预算不可互相覆盖);
 * - `<window>` is the fixed floor-rounded window start epoch ms; the window
 *   identity itself comes from Redis SERVER time inside the Lua scripts
 *   (host-time seed replaced there), so replicas with skewed clocks share one
 *   quota;
 * - the environment token is restricted to `[A-Za-z0-9_.-]` (no colon) so
 *   the key grammar parses unambiguously.
 *
 * The commit policy's distinct element (the planId) is a SET member passed
 * through ARGV, never part of the key text. The HMAC secret is resolved by
 * the bootstrap composition and passed here as bytes; this module never
 * reads environment variables and never logs the secret.
 */
import { createHmac } from 'node:crypto';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';

/** Sealed MCP rate-limit policy names (one budget namespace each). */
export const MCP_RATE_LIMIT_POLICIES = Object.freeze([
  'request', 'approval', 'commit-distinct-plan',
] as const);
export type McpRateLimitPolicyName = (typeof MCP_RATE_LIMIT_POLICIES)[number];

/** Fixed key schema version (the `v1` segment). */
export const MCP_RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
/** base64url truncation length of the facts HMAC (32 chars ≈ 192 bits). */
export const MCP_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
/** Hard ceiling on the full key length. */
export const MCP_RATE_LIMIT_KEY_MAX_LENGTH = 512;
/** Per-field length ceiling of the HMAC input facts. */
export const MCP_RATE_LIMIT_FACTS_MAX_LENGTH = 512;
/** Length ceiling of the distinct element (commit planId). */
export const MCP_RATE_LIMIT_DISTINCT_MAX_LENGTH = 256;

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
/** No colon: the key grammar must parse unambiguously. */
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;

export interface McpRateLimitKeyBuildInput {
  /** Redis key namespace prefix; default 'known' (config keyPrefix). */
  readonly keyPrefix?: string;
  /** Deployment environment token, e.g. 'prod' (1-64 chars, no colon). */
  readonly environment: string;
  /** Resolved HMAC secret bytes (never logged, never interpolated). */
  readonly keySecret: Buffer;
  readonly policy: McpRateLimitPolicyName;
  /** Canonical stable facts (bounded, no control characters). */
  readonly facts: string;
  /** Floor-rounded fixed-window start (epoch ms). */
  readonly windowStartEpochMs: number;
}

export type McpRateLimitKeyRejectReason =
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
export interface McpRateLimitKeyParts {
  readonly keyPrefix: string;
  readonly environment: string;
  readonly schemaVersion: 1;
  readonly subjectHmac: string;
  readonly policy: McpRateLimitPolicyName;
  readonly windowStartEpochMs: number;
}

export type McpRateLimitKeyParseResult =
  | { readonly kind: 'ok'; readonly parts: McpRateLimitKeyParts }
  | { readonly kind: 'rejected'; readonly reason: McpRateLimitKeyRejectReason };

/** Programmer/deployment-input guard used by the key builder (never an HTTP error). */
export class McpRateLimitKeyError extends Error {
  readonly reason: McpRateLimitKeyRejectReason;
  constructor(reason: McpRateLimitKeyRejectReason, message: string) {
    super(message);
    this.name = 'McpRateLimitKeyError';
    this.reason = reason;
  }
}

/** Fail-closed facts validation: non-empty, bounded, no control characters. */
export function assertMcpRateLimitFacts(facts: string): void {
  if (typeof facts !== 'string' || facts.length === 0 || facts.length > MCP_RATE_LIMIT_FACTS_MAX_LENGTH) {
    throw new McpRateLimitKeyError(
      'malformed',
      `mcp rate-limit facts must be 1-${MCP_RATE_LIMIT_FACTS_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(facts)) {
    throw new McpRateLimitKeyError('malformed', 'mcp rate-limit facts must not contain control characters');
  }
}

/** Fail-closed distinct-element validation (commit planId): bounded, no control characters. */
export function assertMcpRateLimitDistinctElement(distinct: string): void {
  if (typeof distinct !== 'string' || distinct.length === 0 || distinct.length > MCP_RATE_LIMIT_DISTINCT_MAX_LENGTH) {
    throw new McpRateLimitKeyError(
      'malformed',
      `mcp rate-limit distinct element must be 1-${MCP_RATE_LIMIT_DISTINCT_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(distinct)) {
    throw new McpRateLimitKeyError('malformed', 'mcp rate-limit distinct element must not contain control characters');
  }
}

/**
 * HMAC-SHA-256 over the canonical facts, base64url-encoded and truncated to
 * `MCP_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS`. The raw facts only ever
 * exist inside the digest input, never in the key text.
 */
export function mcpRateLimitSubjectHmac(keySecret: Buffer, facts: string): string {
  assertMcpRateLimitFacts(facts);
  const digest = createHmac('sha256', keySecret)
    .update(facts, 'utf8')
    .digest('base64url');
  return digest.slice(0, MCP_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

/**
 * Stable binding facts for the commit-distinct-plan policy. Covers exactly
 * the stable principal/client/binding fields: kind, principalId, clientId,
 * credentialBindingId, resourceAudience, securityEpoch — never request-local
 * values, so one subject maps to ONE key on every replica.
 *
 * FIX-L-043: the request policy deliberately does NOT use these per-token
 * binding facts (credentialBindingId is the issuer+jti digest, so a rotated
 * token would mint a fresh request bucket). The request budget keys on the
 * stable principal facts only: kind, principalId, clientId,
 * resourceAudience, securityEpoch.
 */
export function mcpRateLimitBindingFacts(binding: McpAuthenticatedAuthorizationBinding): string {
  return [
    binding.kind,
    binding.principalId,
    binding.clientId,
    binding.credentialBindingId,
    binding.resourceAudience,
    binding.securityEpoch,
  ].join(':');
}

// Canonical grammar. The prefix may contain ':' (config pattern parity with
// the cache namespace); the anchored `:ratelimit:v1:` literal plus the
// colon-free environment token make the parse unambiguous via backtracking.
const MCP_RATE_LIMIT_KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{mcp:([A-Za-z0-9_-]{32})\}:(request|approval|commit-distinct-plan):(\d{1,16})$/u;

/**
 * Normalizes/parses a key into its canonical parts. Rejects every
 * non-canonical shape, including any key whose subject segment is not
 * exactly the 32-char base64url HMAC — raw facts pasted into the key can
 * never pass.
 */
export function parseMcpRateLimitKey(key: string): McpRateLimitKeyParseResult {
  if (typeof key !== 'string' || key.length === 0 || key.length > MCP_RATE_LIMIT_KEY_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const match = MCP_RATE_LIMIT_KEY_PATTERN.exec(key);
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
      schemaVersion: MCP_RATE_LIMIT_KEY_SCHEMA_VERSION,
      subjectHmac: match[3]!,
      // The regex grammar only admits the three sealed policy tokens.
      policy: match[4] as McpRateLimitPolicyName,
      windowStartEpochMs,
    }),
  };
}

/**
 * Builds the canonical admission key. Only the HMAC output and fixed tokens
 * can ever reach the key text; the raw facts are validated fail-closed
 * before hashing. The built key is self-checked through the normalizer.
 */
export function buildMcpRateLimitKey(input: McpRateLimitKeyBuildInput): string {
  const keyPrefix = input.keyPrefix ?? 'known';
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new McpRateLimitKeyError(
      'invalid_prefix',
      'mcp rate-limit key prefix must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new McpRateLimitKeyError(
      'invalid_environment',
      'mcp rate-limit key environment must be 1-64 characters of [A-Za-z0-9_.-]',
    );
  }
  if (!MCP_RATE_LIMIT_POLICIES.includes(input.policy)) {
    throw new McpRateLimitKeyError('invalid_policy', `unknown mcp rate-limit policy: ${String(input.policy)}`);
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new McpRateLimitKeyError('invalid_window', 'mcp rate-limit key window must be a non-negative safe integer');
  }
  const subjectHmac = mcpRateLimitSubjectHmac(input.keySecret, input.facts);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${MCP_RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{mcp:${subjectHmac}}:${input.policy}:${input.windowStartEpochMs}`;
  if (key.length > MCP_RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new McpRateLimitKeyError('key_too_long', `mcp rate-limit key exceeds ${MCP_RATE_LIMIT_KEY_MAX_LENGTH} characters`);
  }
  if (parseMcpRateLimitKey(key).kind !== 'ok') {
    // The builder is deterministic; a failure here is a contract corruption.
    throw new McpRateLimitKeyError('malformed', 'built mcp rate-limit key failed canonical parse');
  }
  return key;
}
