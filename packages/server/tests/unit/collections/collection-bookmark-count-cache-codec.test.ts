import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CACHE_ERROR_CATEGORY,
  CACHE_PROJECTION,
  CACHE_SCHEMA_VERSION,
  COLLECTION_BOOKMARK_COUNT_CACHE_EPOCH,
  CacheKeyError,
  buildCacheDataKey,
  buildCacheEpochKey,
  buildCollectionBookmarkCountCacheDataKey,
  cacheQueryHash,
  decodeCollectionBookmarkCountCacheEnvelope,
  encodeCollectionBookmarkCountCacheEnvelope,
  isValidCollectionBookmarkCountCacheValue,
  normalizeCacheQuery,
  normalizeCollectionBookmarkCountCacheQuery,
  type CacheEnvelopeTimes,
} from '../../../src/infrastructure/cache/index.js';

const production = { environment: 'production' } as const;
const times: CacheEnvelopeTimes = { writtenAtMs: 100, softExpiresAtMs: 200, hardExpiresAtMs: 300 };
const codecOptions = { maxEntryBytes: 512 * 1024 };

function domain(collectionId: string) {
  return { kind: 'collection-bookmark-count' as const, collectionId };
}

function assertKeyError(reason: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof CacheKeyError && error.reason === reason);
}

function envelopeRaw(value: unknown): string {
  return JSON.stringify({
    schemaVersion: CACHE_SCHEMA_VERSION,
    writtenAtMs: 1,
    softExpiresAtMs: 2,
    hardExpiresAtMs: 3,
    value,
  });
}

describe('collection bookmark-count cache keys', () => {
  test('identical (collectionId, contentRevision) produce the same hash; field order is irrelevant', () => {
    const scope = domain('collection-1');
    const projection = CACHE_PROJECTION.COLLECTION_BOOKMARK_COUNT;
    const first = cacheQueryHash({
      domain: scope,
      projection,
      query: { contentRevision: 'rev-1' },
    });
    const reordered = cacheQueryHash({
      domain: scope,
      projection,
      query: JSON.parse('{"contentRevision":"rev-1"}') as { contentRevision: string },
    });
    assert.equal(reordered, first);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/u);

    const firstKey = buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-1',
      query: { contentRevision: 'rev-1' },
      ...production,
    });
    const secondKey = buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-1',
      query: JSON.parse('{"contentRevision":"rev-1"}') as { contentRevision: string },
      ...production,
    });
    assert.equal(secondKey, firstKey);
  });

  test('different collectionId isolates keys when contentRevision is unchanged', () => {
    const query = { contentRevision: 'rev-same' };
    const collectionA = buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-a',
      query,
      ...production,
    });
    const collectionB = buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-b',
      query,
      ...production,
    });
    assert.notEqual(collectionB, collectionA);
  });

  test('different contentRevision isolates keys when collectionId is unchanged', () => {
    const revisionA = buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-a',
      query: { contentRevision: 'rev-a' },
      ...production,
    });
    const revisionB = buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-a',
      query: { contentRevision: 'rev-b' },
      ...production,
    });
    assert.notEqual(revisionB, revisionA);
  });

  test('data keys use {col:id}, projection bookmark-count, and epoch 0', () => {
    const key = buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-1',
      query: { contentRevision: 'rev-1' },
      environment: 'production',
      keyPrefix: 'known',
      schemaVersion: 1,
    });
    assert.match(key, /^known:production:cache:v1:\{col:collection-1\}:bookmark-count:0:[A-Za-z0-9_-]{43}$/u);
    assert.equal(COLLECTION_BOOKMARK_COUNT_CACHE_EPOCH, 0);
    assert.equal(CACHE_PROJECTION.COLLECTION_BOOKMARK_COUNT, 'bookmark-count');
    assert.ok(key.includes('{col:collection-1}'));
    assert.doesNotMatch(key, /\{pub:/u);
    assert.doesNotMatch(key, /principalId|subjectId|principal|cookie/iu);

    const viaGeneric = buildCacheDataKey({
      domain: domain('collection-1'),
      projection: CACHE_PROJECTION.COLLECTION_BOOKMARK_COUNT,
      epoch: COLLECTION_BOOKMARK_COUNT_CACHE_EPOCH,
      query: { contentRevision: 'rev-1' },
      environment: 'production',
    });
    assert.equal(viaGeneric, key);

    const epochKey = buildCacheEpochKey({
      domain: domain('collection-1'),
      environment: 'production',
    });
    assert.equal(epochKey, 'known:production:cache:v1:{col:collection-1}:epoch');
  });

  test('contentRevision containing ~ is accepted and never appears in the key text', () => {
    const contentRevision = 'rev~with~tilde';
    const normalized = normalizeCollectionBookmarkCountCacheQuery({ contentRevision });
    assert.deepEqual(normalized, { kind: 'ok', query: { contentRevision } });

    const key = buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-1',
      query: { contentRevision },
      ...production,
    });
    assert.equal(key.includes(contentRevision), false);
    assert.equal(key.includes('~'), false);
    assert.match(key, /^known:production:cache:v1:\{col:collection-1\}:bookmark-count:0:[A-Za-z0-9_-]{43}$/u);
  });

  test('raw query whitespace, control characters and URLs never enter the key', () => {
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ contentRevision: 'hello world' }),
      { kind: 'rejected', reason: 'invalid_value' },
    );
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ contentRevision: 'a\nb' }),
      { kind: 'rejected', reason: 'contains_control_character' },
    );
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ contentRevision: 'a\tb' }),
      { kind: 'rejected', reason: 'contains_control_character' },
    );
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ contentRevision: 'a\u0000b' }),
      { kind: 'rejected', reason: 'contains_control_character' },
    );
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ contentRevision: 'https://example.com/a?b=1' }),
      { kind: 'rejected', reason: 'contains_url' },
    );
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ url: 'https://example.test/x' }),
      { kind: 'rejected', reason: 'contains_url' },
    );

    assertKeyError('unnormalized_query', () => buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-1',
      query: { contentRevision: 'hello world' },
      ...production,
    }));
    assertKeyError('unnormalized_query', () => buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-1',
      query: { contentRevision: 'a\nb' },
      ...production,
    }));
    assertKeyError('unnormalized_query', () => buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-1',
      query: { contentRevision: 'https://example.com/' },
      ...production,
    }));
  });

  test('query with subjectId, principalId or cookie is rejected', () => {
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ contentRevision: 'rev-1', subjectId: 's-1' }),
      { kind: 'rejected', reason: 'forbidden_principal_key' },
    );
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ principalId: 'p-1' }),
      { kind: 'rejected', reason: 'forbidden_principal_key' },
    );
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ cookie: 'session=1' }),
      { kind: 'rejected', reason: 'forbidden_principal_key' },
    );
    assert.deepEqual(
      normalizeCacheQuery({ subjectId: 's-1' }),
      { kind: 'rejected', reason: 'forbidden_principal_key' },
    );

    assertKeyError('unnormalized_query', () => buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-1',
      query: { contentRevision: 'rev-1', subjectId: 's-1' },
      ...production,
    }));
    assertKeyError('unnormalized_query', () => buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-1',
      query: { principalId: 'p-1' },
      ...production,
    }));
    assertKeyError('unnormalized_query', () => buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'collection-1',
      query: { cookie: 'session=1' },
      ...production,
    }));
  });

  test('query rejects extra keys and invalid contentRevision charset', () => {
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ contentRevision: 'rev-1', page: 1 }),
      { kind: 'rejected', reason: 'invalid_key' },
    );
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({}),
      { kind: 'rejected', reason: 'invalid_key' },
    );
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ contentRevision: '' }),
      { kind: 'rejected', reason: 'invalid_value' },
    );
    assert.deepEqual(
      normalizeCollectionBookmarkCountCacheQuery({ contentRevision: 'x'.repeat(129) }),
      { kind: 'rejected', reason: 'invalid_value' },
    );
  });

  test('collectionId empty, control character or overlong raises CacheKeyError', () => {
    const query = { contentRevision: 'rev-1' };
    assertKeyError('empty_id', () => buildCollectionBookmarkCountCacheDataKey({
      collectionId: '',
      query,
      ...production,
    }));
    assertKeyError('invalid_id_character', () => buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'a\nb',
      query,
      ...production,
    }));
    assertKeyError('invalid_id_character', () => buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'a b',
      query,
      ...production,
    }));
    assertKeyError('id_too_long', () => buildCollectionBookmarkCountCacheDataKey({
      collectionId: 'x'.repeat(129),
      query,
      ...production,
    }));
  });
});

describe('collection bookmark-count cache value guard', () => {
  test('0 is a valid bookmarkCount and round-trips through the domain envelope', () => {
    assert.equal(isValidCollectionBookmarkCountCacheValue({ bookmarkCount: 0 }), true);
    assert.equal(isValidCollectionBookmarkCountCacheValue({ bookmarkCount: 17 }), true);

    const encoded = encodeCollectionBookmarkCountCacheEnvelope({ bookmarkCount: 0 }, times, codecOptions);
    assert.equal(encoded.kind, 'ok');
    if (encoded.kind !== 'ok') return;
    const decoded = decodeCollectionBookmarkCountCacheEnvelope(encoded.encoded, codecOptions);
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') assert.deepEqual(decoded.envelope.value, { bookmarkCount: 0 });
  });

  test('value with title or url is refused on write and decode', () => {
    assert.equal(isValidCollectionBookmarkCountCacheValue({ bookmarkCount: 1, title: 'Reading queue' }), false);
    assert.equal(isValidCollectionBookmarkCountCacheValue({ title: 'Reading queue', url: 'https://example.test' }), false);
    assert.equal(isValidCollectionBookmarkCountCacheValue({ bookmarkCount: 1, capabilities: {} }), false);
    assert.equal(isValidCollectionBookmarkCountCacheValue({ bookmarkCount: 1, members: [] }), false);
    assert.equal(isValidCollectionBookmarkCountCacheValue({ bookmarkCount: 1, email: 'user@example.test' }), false);

    const withTitle = encodeCollectionBookmarkCountCacheEnvelope(
      { bookmarkCount: 1, title: 'Reading queue' },
      times,
      codecOptions,
    );
    assert.equal(withTitle.kind, 'rejected');
    if (withTitle.kind === 'rejected') assert.equal(withTitle.reason, 'invalid_value');

    const withUrl = encodeCollectionBookmarkCountCacheEnvelope(
      { title: 'Reading queue', url: '/library' },
      times,
      codecOptions,
    );
    assert.equal(withUrl.kind, 'rejected');

    const decodedTitle = decodeCollectionBookmarkCountCacheEnvelope(
      envelopeRaw({ bookmarkCount: 1, title: 'Reading queue' }),
      codecOptions,
    );
    assert.equal(decodedTitle.kind, 'decode_error');
    if (decodedTitle.kind === 'decode_error') {
      assert.equal(decodedTitle.category, CACHE_ERROR_CATEGORY.DECODE_ERROR);
      assert.equal(decodedTitle.reason, 'bad_value');
    }

    const decodedUrl = decodeCollectionBookmarkCountCacheEnvelope(
      envelopeRaw({ url: '/library' }),
      codecOptions,
    );
    assert.equal(decodedUrl.kind, 'decode_error');
  });

  test('-1, non-integer and missing bookmarkCount fail the guard and decode', () => {
    for (const value of [
      { bookmarkCount: -1 },
      { bookmarkCount: 1.5 },
      { bookmarkCount: Number.NaN },
      { bookmarkCount: Number.POSITIVE_INFINITY },
      { bookmarkCount: '17' },
      {},
      { count: 17 },
      17,
      null,
    ]) {
      assert.equal(isValidCollectionBookmarkCountCacheValue(value), false);
      const encoded = encodeCollectionBookmarkCountCacheEnvelope(value, times, codecOptions);
      assert.equal(encoded.kind, 'rejected');
      const decoded = decodeCollectionBookmarkCountCacheEnvelope(envelopeRaw(value), codecOptions);
      assert.equal(decoded.kind, 'decode_error');
      if (decoded.kind === 'decode_error') {
        assert.equal(decoded.category, CACHE_ERROR_CATEGORY.DECODE_ERROR);
      }
    }

    const negative = decodeCollectionBookmarkCountCacheEnvelope(envelopeRaw({ bookmarkCount: -1 }), codecOptions);
    assert.equal(negative.kind, 'decode_error');
    if (negative.kind === 'decode_error') assert.equal(negative.reason, 'bad_value');
  });
});
