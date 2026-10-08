/**
 * PERIPH-P1-c Sync effect-page rate-limit HMAC key codec.
 *
 * Independent of auth/search/explore/sync-colp purpose strings. Hash-tag
 * purpose is `epg`; sealed families are `subject` | `effect` so the subject
 * total bucket and the per-effect sub-bucket never share a counter. Page
 * indices are deliberately NOT part of the HMAC input.
 *
 * Canonical key (prefix default `known-effect-page`):
 *
 *   known-effect-page:<env>:ratelimit:v1:{epg:<subjectHmac>}:<family>:<window>
 *
 * Subject family facts: trusted client IP | session | replica.
 * Effect family facts: trusted client IP | session | replica | effect id.
 * Raw facts never enter the key text.
 */
import { createHmac } from 'node:crypto';

export const EFFECT_PAGE_RATE_LIMIT_ROUTE_FAMILIES = Object.freeze([
  'subject', 'effect',
] as const);
export type EffectPageRateLimitRouteFamily = (typeof EFFECT_PAGE_RATE_LIMIT_ROUTE_FAMILIES)[number];

export const EFFECT_PAGE_RATE_LIMIT_KEY_SCHEMA_VERSION = 1;
export const EFFECT_PAGE_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS = 32;
export const EFFECT_PAGE_RATE_LIMIT_KEY_MAX_LENGTH = 512;
export const EFFECT_PAGE_RATE_LIMIT_FACTS_MAX_LENGTH = 512;
export const EFFECT_PAGE_RATE_LIMIT_DEFAULT_PREFIX = 'known-effect-page';

const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const EFFECT_PAGE_RATE_LIMIT_KEY_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,63}):([A-Za-z0-9_.-]{1,64}):ratelimit:v1:\{epg:([A-Za-z0-9_-]{32})\}:(subject|effect):(\d{1,16})$/u;

export interface EffectPageRateLimitKeyBuildInput {
  readonly keyPrefix?: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly family: EffectPageRateLimitRouteFamily;
  readonly facts: string;
  readonly windowStartEpochMs: number;
}

export type EffectPageRateLimitKeyRejectReason =
  | 'malformed'
  | 'invalid_prefix'
  | 'invalid_environment'
  | 'invalid_family'
  | 'invalid_window'
  | 'key_too_long';

export interface EffectPageRateLimitKeyParts {
  readonly keyPrefix: string;
  readonly environment: string;
  readonly schemaVersion: 1;
  readonly subjectHmac: string;
  readonly family: EffectPageRateLimitRouteFamily;
  readonly windowStartEpochMs: number;
}

export type EffectPageRateLimitKeyParseResult =
  | { readonly kind: 'ok'; readonly parts: EffectPageRateLimitKeyParts }
  | { readonly kind: 'rejected'; readonly reason: EffectPageRateLimitKeyRejectReason };

export class EffectPageRateLimitKeyError extends Error {
  readonly reason: EffectPageRateLimitKeyRejectReason;
  constructor(reason: EffectPageRateLimitKeyRejectReason, message: string) {
    super(message);
    this.name = 'EffectPageRateLimitKeyError';
    this.reason = reason;
  }
}

export function effectPageRateLimitSubjectFacts(input: {
  readonly clientIp: string;
  readonly sessionId: string;
  readonly replicaId: string;
}): string {
  return `${input.clientIp}|${input.sessionId}|${input.replicaId}`;
}

export function effectPageRateLimitEffectFacts(input: {
  readonly clientIp: string;
  readonly sessionId: string;
  readonly replicaId: string;
  readonly effectId: string;
}): string {
  return `${effectPageRateLimitSubjectFacts(input)}|${input.effectId}`;
}

export function assertEffectPageRateLimitFacts(facts: string): void {
  if (typeof facts !== 'string' || facts.length === 0
    || facts.length > EFFECT_PAGE_RATE_LIMIT_FACTS_MAX_LENGTH) {
    throw new EffectPageRateLimitKeyError(
      'malformed',
      `effect-page rate-limit facts must be 1-${EFFECT_PAGE_RATE_LIMIT_FACTS_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(facts)) {
    throw new EffectPageRateLimitKeyError(
      'malformed',
      'effect-page rate-limit facts must not contain control characters',
    );
  }
}

export function effectPageRateLimitSubjectHmac(keySecret: Buffer, facts: string): string {
  assertEffectPageRateLimitFacts(facts);
  return createHmac('sha256', keySecret)
    .update(facts, 'utf8')
    .digest('base64url')
    .slice(0, EFFECT_PAGE_RATE_LIMIT_SUBJECT_HMAC_TRUNCATED_CHARS);
}

export function parseEffectPageRateLimitKey(key: string): EffectPageRateLimitKeyParseResult {
  if (typeof key !== 'string' || key.length === 0 || key.length > EFFECT_PAGE_RATE_LIMIT_KEY_MAX_LENGTH) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const match = EFFECT_PAGE_RATE_LIMIT_KEY_PATTERN.exec(key);
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
      schemaVersion: EFFECT_PAGE_RATE_LIMIT_KEY_SCHEMA_VERSION,
      subjectHmac: match[3]!,
      family: match[4] as EffectPageRateLimitRouteFamily,
      windowStartEpochMs,
    }),
  };
}

export function buildEffectPageRateLimitKey(input: EffectPageRateLimitKeyBuildInput): string {
  const keyPrefix = input.keyPrefix ?? EFFECT_PAGE_RATE_LIMIT_DEFAULT_PREFIX;
  if (!KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new EffectPageRateLimitKeyError(
      'invalid_prefix',
      'effect-page rate-limit key prefix must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  if (!ENVIRONMENT_PATTERN.test(input.environment)) {
    throw new EffectPageRateLimitKeyError(
      'invalid_environment',
      'effect-page rate-limit key environment must be 1-64 characters of [A-Za-z0-9_.-]',
    );
  }
  if (!EFFECT_PAGE_RATE_LIMIT_ROUTE_FAMILIES.includes(input.family)) {
    throw new EffectPageRateLimitKeyError(
      'invalid_family',
      `unknown effect-page rate-limit family: ${String(input.family)}`,
    );
  }
  if (!Number.isSafeInteger(input.windowStartEpochMs) || input.windowStartEpochMs < 0) {
    throw new EffectPageRateLimitKeyError(
      'invalid_window',
      'effect-page rate-limit key window must be a non-negative safe integer',
    );
  }
  const subjectHmac = effectPageRateLimitSubjectHmac(input.keySecret, input.facts);
  const key = `${keyPrefix}:${input.environment}:ratelimit:v${EFFECT_PAGE_RATE_LIMIT_KEY_SCHEMA_VERSION}`
    + `:{epg:${subjectHmac}}:${input.family}:${input.windowStartEpochMs}`;
  if (key.length > EFFECT_PAGE_RATE_LIMIT_KEY_MAX_LENGTH) {
    throw new EffectPageRateLimitKeyError(
      'key_too_long',
      `effect-page rate-limit key exceeds ${EFFECT_PAGE_RATE_LIMIT_KEY_MAX_LENGTH} characters`,
    );
  }
  if (parseEffectPageRateLimitKey(key).kind !== 'ok') {
    throw new EffectPageRateLimitKeyError(
      'malformed',
      'built effect-page rate-limit key failed canonical parse',
    );
  }
  return key;
}
