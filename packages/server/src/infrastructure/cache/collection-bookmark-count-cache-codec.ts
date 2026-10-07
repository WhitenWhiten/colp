/**
 * Collection bookmark-count cache contract (library collection bookmark-count
 * plan §5.2 / P3).
 *
 * This module is the domain key + value codec only: no Redis client, no
 * read-through, no ioredis types. Data keys reuse `cacheQueryHash` /
 * `buildCacheDataKey`. The query is `{ contentRevision }` hashed into the key;
 * revision text (which may contain `~`) never appears in the key plaintext.
 * Cached values are exactly `{ bookmarkCount: integer >= 0 }` — never title,
 * URL, capabilities, members, or email.
 */
import { CACHE_ERROR_CATEGORY } from './cache-store.js';
import {
  decodeCacheEnvelope,
  encodeCacheEnvelope,
  type CacheEnvelopeCodecOptions,
  type CacheEnvelopeDecodeResult,
  type CacheEnvelopeEncodeResult,
  type CacheEnvelopeTimes,
} from './cache-envelope.js';
import { isRecord } from './cache-guards.js';
import {
  CACHE_PROJECTION,
  CacheKeyError,
  buildCacheDataKey,
  normalizeCacheQuery,
  type CacheKeyOptions,
  type CacheNormalizeResult,
} from './cache-key-codec.js';

/** This domain does not rotate epoch; data keys always use the `0` segment. */
export const COLLECTION_BOOKMARK_COUNT_CACHE_EPOCH = 0;

/** OpenAPI / SQL `Revision` charset, including `~`. */
const CONTENT_REVISION_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface CollectionBookmarkCountCacheValue {
  readonly bookmarkCount: number;
}

export interface CollectionBookmarkCountCacheKeyInput extends CacheKeyOptions {
  readonly collectionId: string;
  readonly query: unknown;
}

/**
 * Domain query contract: a plain object whose only key is `contentRevision`,
 * matching `^[A-Za-z0-9._~-]{1,128}$`. Extra keys, principal/auth keys, raw
 * whitespace, control characters and URLs are rejected. `normalizeCacheQuery`
 * runs first so `subjectId` / `principalId` / `cookie` keep the generic
 * `forbidden_principal_key` reason.
 */
export function normalizeCollectionBookmarkCountCacheQuery(input: unknown): CacheNormalizeResult {
  const generic = normalizeCacheQuery(input);
  if (generic.kind !== 'ok') return generic;
  const keys = Object.keys(generic.query);
  if (keys.length !== 1 || keys[0] !== 'contentRevision') {
    return { kind: 'rejected', reason: 'invalid_key' };
  }
  const contentRevision = generic.query.contentRevision;
  if (typeof contentRevision !== 'string' || !CONTENT_REVISION_PATTERN.test(contentRevision)) {
    return { kind: 'rejected', reason: 'invalid_value' };
  }
  return { kind: 'ok', query: { contentRevision } };
}

/**
 * Allowed envelope `value` shape: a plain object with the unique key
 * `bookmarkCount`, a safe integer, and `>= 0`. `0` is a valid empty-collection
 * count, not a negative-cache miss.
 */
export function isValidCollectionBookmarkCountCacheValue(
  value: unknown,
): value is CollectionBookmarkCountCacheValue {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'bookmarkCount') return false;
  const bookmarkCount = value.bookmarkCount;
  return typeof bookmarkCount === 'number' && Number.isSafeInteger(bookmarkCount) && bookmarkCount >= 0;
}

/**
 * Builds
 * `<prefix>:<env>:cache:v1:{col:<collectionId>}:bookmark-count:0:<queryHash>`.
 * Epoch is always `0`. The query must pass domain normalization so extra keys
 * and an unhashed revision never reach the key text.
 */
export function buildCollectionBookmarkCountCacheDataKey(input: CollectionBookmarkCountCacheKeyInput): string {
  const normalized = normalizeCollectionBookmarkCountCacheQuery(input.query);
  if (normalized.kind !== 'ok') {
    throw new CacheKeyError(
      'unnormalized_query',
      'collection bookmark-count query must contain only a valid contentRevision',
    );
  }
  return buildCacheDataKey({
    domain: { kind: 'collection-bookmark-count', collectionId: input.collectionId },
    projection: CACHE_PROJECTION.COLLECTION_BOOKMARK_COUNT,
    epoch: COLLECTION_BOOKMARK_COUNT_CACHE_EPOCH,
    query: normalized.query,
    environment: input.environment,
    keyPrefix: input.keyPrefix,
    schemaVersion: input.schemaVersion,
  });
}

/**
 * Refuses values that are not `{ bookmarkCount: integer >= 0 }` before the
 * generic envelope encode (so title/URL/members never become a write).
 */
export function encodeCollectionBookmarkCountCacheEnvelope(
  value: unknown,
  times: CacheEnvelopeTimes,
  options: CacheEnvelopeCodecOptions,
): CacheEnvelopeEncodeResult {
  if (!isValidCollectionBookmarkCountCacheValue(value)) {
    return { kind: 'rejected', reason: 'invalid_value' };
  }
  return encodeCacheEnvelope(value, times, options);
}

/**
 * Generic envelope decode, then the domain value guard. A schema-valid envelope
 * whose `value` is not `{ bookmarkCount: integer >= 0 }` is a decode failure
 * (P4 will delete+reload; this codec only classifies).
 */
export function decodeCollectionBookmarkCountCacheEnvelope(
  raw: string,
  options: CacheEnvelopeCodecOptions,
): CacheEnvelopeDecodeResult<CollectionBookmarkCountCacheValue> {
  const decoded = decodeCacheEnvelope<unknown>(raw, options);
  if (decoded.kind !== 'ok') return decoded;
  if (!isValidCollectionBookmarkCountCacheValue(decoded.envelope.value)) {
    return { kind: 'decode_error', category: CACHE_ERROR_CATEGORY.DECODE_ERROR, reason: 'bad_value' };
  }
  return {
    kind: 'ok',
    envelope: {
      schemaVersion: decoded.envelope.schemaVersion,
      writtenAtMs: decoded.envelope.writtenAtMs,
      softExpiresAtMs: decoded.envelope.softExpiresAtMs,
      hardExpiresAtMs: decoded.envelope.hardExpiresAtMs,
      value: decoded.envelope.value,
    },
    utf8Bytes: decoded.utf8Bytes,
  };
}
