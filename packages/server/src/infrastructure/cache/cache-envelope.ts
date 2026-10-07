/**
 * T02 cache contract: CacheEnvelope shape and the public-value codec.
 *
 * The envelope is a JSON document with a schema version and millisecond time
 * fields (plan §4.2). The codec is a pure function pair: encode measures UTF-8
 * bytes of the value BEFORE encoding version/time fields, then measures the
 * full envelope; decode returns a stable `cache_decode_error` classification
 * instead of throwing to the HTTP layer. Cached values are only allowed to be
 * public projections: the codec rejects known private/auth fields (recursively)
 * and never trusts a JSON.parse result without shape, schema and size checks.
 */
import { CACHE_ERROR_CATEGORY } from './cache-store.js';
import { isRecord } from './cache-guards.js';

/** Cache value schema version; keys are namespaced with v{schemaVersion}. */
export const CACHE_SCHEMA_VERSION = 1;

export interface CacheEnvelope<T = unknown> {
  readonly schemaVersion: number;
  readonly writtenAtMs: number;
  readonly softExpiresAtMs: number;
  readonly hardExpiresAtMs: number;
  readonly value: T;
}

export interface CacheEnvelopeTimes {
  readonly writtenAtMs: number;
  readonly softExpiresAtMs: number;
  readonly hardExpiresAtMs: number;
}

export interface CacheEnvelopeCodecOptions {
  /** Maximum encoded envelope bytes (config.cache.limits.maxEntryBytes). */
  readonly maxEntryBytes: number;
}

export type CacheEnvelopeDecodeReason =
  | 'invalid_json'
  | 'not_plain_object'
  | 'bad_schema_version'
  | 'bad_time_fields'
  | 'bad_value'
  | 'forbidden_field'
  | 'oversized';

export type CacheEnvelopeDecodeResult<T = unknown> =
  | { readonly kind: 'ok'; readonly envelope: CacheEnvelope<T>; readonly utf8Bytes: number }
  | {
      readonly kind: 'decode_error';
      readonly category: typeof CACHE_ERROR_CATEGORY.DECODE_ERROR;
      readonly reason: CacheEnvelopeDecodeReason;
    };

export type CacheEnvelopeEncodeReason = 'invalid_value' | 'forbidden_field' | 'oversized';

export type CacheEnvelopeEncodeResult =
  | { readonly kind: 'ok'; readonly encoded: string; readonly utf8Bytes: number }
  | { readonly kind: 'rejected'; readonly reason: CacheEnvelopeEncodeReason };

/**
 * Private/auth facts that must never appear anywhere inside a cached public
 * value (top level or nested). The list is conservative and intentionally
 * rejects fail-closed: a projection containing any of these keys cannot be
 * cached. The public-facing `visibility` value and the public owner profile
 * (`owner: { profileId, handle, ... }`) are NOT private facts and stay
 * cacheable; internal visibility/policy facts (`visibilityRevision`,
 * `policyRevision`, `policy`, `permissions`, membership, ...) are not.
 */
const FORBIDDEN_CACHE_VALUE_KEYS = new Set<string>([
  // principal / ownership identity facts
  'principalId',
  'subjectId',
  'ownerSubjectId',
  'ownerId',
  'ownerPrincipalId',
  'creatorSubjectId',
  'creatorId',
  'creatorPrincipalId',
  // collection membership facts
  'membership',
  'memberships',
  'membershipRole',
  'memberIds',
  'memberSubjectIds',
  'memberPrincipalIds',
  // contact facts
  'email',
  'emails',
  'emailAddress',
  // internal visibility/policy facts
  'visibilityRevision',
  'visibilityState',
  'policyRevision',
  'policy',
  'policyFacts',
  'accessPolicy',
  'acl',
  'permissions',
  // credentials / auth material
  'password',
  'passwordHash',
  'sessionToken',
  'session',
  'authorization',
  'cookie',
  'apiKey',
  'apiSecret',
  'accessToken',
  'refreshToken',
]);

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validEnvelopeTimes(times: CacheEnvelopeTimes): boolean {
  return isNonNegativeSafeInteger(times.writtenAtMs)
    && isNonNegativeSafeInteger(times.softExpiresAtMs)
    && isNonNegativeSafeInteger(times.hardExpiresAtMs)
    && times.writtenAtMs <= times.softExpiresAtMs
    && times.softExpiresAtMs <= times.hardExpiresAtMs;
}

/**
 * Recursively scans a JSON value (no cycles possible from JSON.parse, and the
 * seen set guards against a buggy cyclic encode input) for forbidden keys.
 */
function containsForbiddenKey(value: unknown, seen = new Set<unknown>()): boolean {
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some((item) => containsForbiddenKey(item, seen));
  }
  if (!isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_CACHE_VALUE_KEYS.has(key)) return true;
    if (containsForbiddenKey(value[key], seen)) return true;
  }
  return false;
}

/**
 * Encodes a public projection into a schema-valid JSON envelope string.
 *
 * Ordering per plan §6.4 T02: validate times, require a plain-object value,
 * reject forbidden private/auth fields, serialize the value and check its
 * UTF-8 byte length FIRST, then encode schemaVersion/time fields and check the
 * full envelope byte length. Oversized results are rejected (never truncated),
 * and the policy layer decides to serve from origin instead.
 */
export function encodeCacheEnvelope(
  value: unknown,
  times: CacheEnvelopeTimes,
  options: CacheEnvelopeCodecOptions,
): CacheEnvelopeEncodeResult {
  if (!validEnvelopeTimes(times)) return { kind: 'rejected', reason: 'invalid_value' };
  if (!isRecord(value)) return { kind: 'rejected', reason: 'invalid_value' };
  if (containsForbiddenKey(value)) return { kind: 'rejected', reason: 'forbidden_field' };

  let valueJson: string;
  try {
    valueJson = JSON.stringify(value);
  } catch {
    return { kind: 'rejected', reason: 'invalid_value' };
  }
  const valueBytes = Buffer.byteLength(valueJson, 'utf8');
  if (valueBytes > options.maxEntryBytes) return { kind: 'rejected', reason: 'oversized' };

  const envelope: CacheEnvelope = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    writtenAtMs: times.writtenAtMs,
    softExpiresAtMs: times.softExpiresAtMs,
    hardExpiresAtMs: times.hardExpiresAtMs,
    value,
  };
  const encoded = JSON.stringify(envelope);
  const utf8Bytes = Buffer.byteLength(encoded, 'utf8');
  if (utf8Bytes > options.maxEntryBytes) return { kind: 'rejected', reason: 'oversized' };
  return { kind: 'ok', encoded, utf8Bytes };
}

function decodeError(reason: CacheEnvelopeDecodeReason): CacheEnvelopeDecodeResult<never> {
  return { kind: 'decode_error', category: CACHE_ERROR_CATEGORY.DECODE_ERROR, reason };
}

/**
 * Decodes and validates a stored envelope string. Every failure returns the
 * stable `cache_decode_error` category with a precise reason; this never
 * throws to the HTTP layer. The cached value is not trusted after JSON.parse:
 * the top level must be a plain object, schemaVersion must match, the time
 * fields must be monotonic non-negative safe integers, the value must be a
 * plain object without forbidden private/auth fields, and the UTF-8 byte
 * length must fit within maxEntryBytes.
 */
export function decodeCacheEnvelope<T = unknown>(
  raw: string,
  options: CacheEnvelopeCodecOptions,
): CacheEnvelopeDecodeResult<T> {
  if (typeof raw !== 'string') return decodeError('invalid_json');
  const utf8Bytes = Buffer.byteLength(raw, 'utf8');
  if (utf8Bytes > options.maxEntryBytes) return decodeError('oversized');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return decodeError('invalid_json');
  }
  if (!isRecord(parsed)) return decodeError('not_plain_object');
  if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return decodeError('bad_schema_version');

  const writtenAtMs = parsed.writtenAtMs;
  const softExpiresAtMs = parsed.softExpiresAtMs;
  const hardExpiresAtMs = parsed.hardExpiresAtMs;
  if (
    !isNonNegativeSafeInteger(writtenAtMs)
    || !isNonNegativeSafeInteger(softExpiresAtMs)
    || !isNonNegativeSafeInteger(hardExpiresAtMs)
    || writtenAtMs > softExpiresAtMs
    || softExpiresAtMs > hardExpiresAtMs
  ) {
    return decodeError('bad_time_fields');
  }

  if (!isRecord(parsed.value)) return decodeError('bad_value');
  if (containsForbiddenKey(parsed.value)) return decodeError('forbidden_field');

  return {
    kind: 'ok',
    envelope: {
      schemaVersion: CACHE_SCHEMA_VERSION,
      writtenAtMs,
      softExpiresAtMs,
      hardExpiresAtMs,
      value: parsed.value as T,
    },
    utf8Bytes,
  };
}
