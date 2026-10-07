import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CACHE_PROJECTION,
  CacheKeyError,
  buildCacheDataKey,
  buildCacheEpochKey,
  cacheQueryHash,
  normalizeCacheQuery,
} from '../../../src/infrastructure/cache/index.js';

const production = { environment: 'production' } as const;

function assertKeyError(reason: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof CacheKeyError && error.reason === reason);
}

describe('canonical query hash', () => {
  test('identical normalized queries hash identically and field order is irrelevant', () => {
    const domain = { kind: 'publication', locator: 'pubid', collectionId: 'collection-1' } as const;
    const first = cacheQueryHash({
      domain,
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      query: { page: 1, tag: 'x', flag: true, note: null },
    });
    const reordered = cacheQueryHash({
      domain,
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      query: { note: null, flag: true, tag: 'x', page: 1 },
    });
    assert.equal(reordered, first);
    // SHA-256 over canonical JSON is base64url: 43 chars, no whitespace.
    assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
  });

  test('different query values, projections and collections produce different hashes', () => {
    const domainA = { kind: 'publication', locator: 'pubid', collectionId: 'collection-a' } as const;
    const domainB = { kind: 'publication', locator: 'pubid', collectionId: 'collection-b' } as const;
    const base = {
      domain: domainA,
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      query: {},
    } as const;
    const reference = cacheQueryHash(base);
    assert.notEqual(cacheQueryHash({ ...base, query: { page: 2 } }), reference);
    assert.notEqual(cacheQueryHash({ ...base, projection: CACHE_PROJECTION.PUBLICATION_SNAPSHOT }), reference);
    assert.notEqual(cacheQueryHash({ ...base, domain: domainB }), reference);
    assert.notEqual(cacheQueryHash({ ...base, schemaVersion: 2 }), reference);
  });

  test('normalizeCacheQuery accepts flat scalar and nested queries and rejects unsafe input', () => {
    assert.deepEqual(
      normalizeCacheQuery({ page: 1, tag: 'x', flag: true, note: null }),
      { kind: 'ok', query: { page: 1, tag: 'x', flag: true, note: null } },
    );
    assert.equal(normalizeCacheQuery({ nested: { a: 1, list: [1, 'two', null] } }).kind, 'ok');

    for (const bad of ['nope', [1, 2], 42, null, undefined]) {
      assert.deepEqual(normalizeCacheQuery(bad), { kind: 'rejected', reason: 'not_plain_object' });
    }
    assert.deepEqual(normalizeCacheQuery({ 'bad key': 1 }), { kind: 'rejected', reason: 'invalid_key' });
    assert.deepEqual(normalizeCacheQuery({ 'bad\nkey': 1 }), { kind: 'rejected', reason: 'invalid_key' });
    assert.deepEqual(normalizeCacheQuery({ fn: () => 1 }), { kind: 'rejected', reason: 'invalid_value' });
    assert.deepEqual(normalizeCacheQuery({ n: Number.NaN }), { kind: 'rejected', reason: 'invalid_value' });
    assert.deepEqual(normalizeCacheQuery({ n: Number.POSITIVE_INFINITY }), { kind: 'rejected', reason: 'invalid_value' });
    assert.deepEqual(normalizeCacheQuery({ principalId: 'p-1' }), { kind: 'rejected', reason: 'forbidden_principal_key' });
  });
});

describe('cache key builder', () => {
  test('data keys are isolated across collection, directory, environment and schema version', () => {
    const collectionA = buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-a' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 4,
      query: {},
      ...production,
    });
    const collectionB = buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-b' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 4,
      query: {},
      ...production,
    });
    const directory = buildCacheDataKey({
      domain: { kind: 'publication-directory' },
      projection: CACHE_PROJECTION.PUBLICATION_DIRECTORY_PAGE,
      epoch: 4,
      query: {},
      ...production,
    });
    const development = buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-a' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 4,
      query: {},
      environment: 'development',
    });
    const schemaV2 = buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-a' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 4,
      query: {},
      ...production,
      schemaVersion: 2,
    });
    const otherEpoch = buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-a' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 5,
      query: {},
      ...production,
    });

    assert.notEqual(collectionB, collectionA);
    assert.notEqual(directory, collectionA);
    assert.notEqual(development, collectionA);
    assert.notEqual(schemaV2, collectionA);
    assert.notEqual(otherEpoch, collectionA);
    // Deterministic: the same input always yields the same key.
    assert.equal(collectionA, buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-a' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 4,
      query: {},
      ...production,
    }));
  });

  test('epoch and data keys follow the documented namespace, hash-tag and projection shape', () => {
    const epochKey = buildCacheEpochKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-1' },
      environment: 'production',
      keyPrefix: 'known',
      schemaVersion: 1,
    });
    assert.equal(epochKey, 'known:production:cache:v1:{pub:collection-1}:pubid:epoch');

    const directoryEpoch = buildCacheEpochKey({
      domain: { kind: 'publication-directory' },
      environment: 'development',
    });
    assert.equal(directoryEpoch, 'known:development:cache:v1:{publication-directory}:epoch');

    const dataKey = buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-1' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 7,
      query: {},
      environment: 'production',
    });
    assert.match(dataKey, /^known:production:cache:v1:\{pub:collection-1\}:metadata:7:[A-Za-z0-9_-]{43}$/u);
  });

  test('pubid and pubslug locators namespace epoch and data keys of the same string', () => {
    const idDomain = { kind: 'publication', locator: 'pubid', collectionId: 'shared' } as const;
    const slugDomain = { kind: 'publication', locator: 'pubslug', collectionId: 'shared' } as const;

    const idEpoch = buildCacheEpochKey({ ...production, domain: idDomain });
    const slugEpoch = buildCacheEpochKey({ ...production, domain: slugDomain });
    assert.notEqual(idEpoch, slugEpoch, 'an ID and a slug that share a string must never share an epoch key');
    assert.equal(idEpoch, 'known:production:cache:v1:{pub:shared}:pubid:epoch');
    assert.equal(slugEpoch, 'known:production:cache:v1:{pub:shared}:pubslug:epoch');
    // Both locators keep the same Redis Cluster hash tag, so the collection
    // scope stays pinned to one slot exactly as before the locator split.
    assert.ok(idEpoch.includes('{pub:shared}'));
    assert.ok(slugEpoch.includes('{pub:shared}'));

    const idData = buildCacheDataKey({
      domain: idDomain,
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 1,
      query: {},
      ...production,
    });
    const slugData = buildCacheDataKey({
      domain: slugDomain,
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 1,
      query: {},
      ...production,
    });
    assert.notEqual(idData, slugData, 'the locator must be part of the query hash input');
  });

  test('raw whitespace, newlines, control characters and URLs never enter the key', () => {
    const key = buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-1' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 1,
      query: { term: 'hello world' },
      environment: 'production',
    });
    // The key text contains only namespace characters and base64url hash output.
    assert.match(key, /^[A-Za-z0-9_.:{}.-]+$/u);
    assert.doesNotMatch(key, /\s/u);
    assert.doesNotMatch(key, /hello|world|https?:/iu);

    // Newlines, tabs, NUL and raw URLs are rejected by normalization.
    assert.deepEqual(normalizeCacheQuery({ q: 'a\nb' }), { kind: 'rejected', reason: 'contains_control_character' });
    assert.deepEqual(normalizeCacheQuery({ q: 'a\tb' }), { kind: 'rejected', reason: 'contains_control_character' });
    assert.deepEqual(normalizeCacheQuery({ q: 'a\u0000b' }), { kind: 'rejected', reason: 'contains_control_character' });
    assert.deepEqual(normalizeCacheQuery({ url: 'https://example.com/a?b=1' }), { kind: 'rejected', reason: 'contains_url' });
    assert.deepEqual(normalizeCacheQuery({ text: 'see https://example.test/x' }), { kind: 'rejected', reason: 'contains_url' });

    // The key builder refuses to hash a query that was not normalized.
    assertKeyError('unnormalized_query', () => buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-1' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 1,
      query: { q: 'a\nb' },
      environment: 'production',
    }));
    assertKeyError('unnormalized_query', () => buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-1' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 1,
      query: { url: 'https://example.com/' },
      environment: 'production',
    }));
  });

  test('key builder rejects empty, control-char and overlong IDs and other invalid inputs', () => {
    const base = {
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-1' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 1,
      query: {},
      environment: 'production',
    };
    assertKeyError('empty_id', () => buildCacheDataKey({
      ...base, domain: { kind: 'publication', locator: 'pubid', collectionId: '' },
    }));
    assertKeyError('invalid_id_character', () => buildCacheDataKey({
      ...base, domain: { kind: 'publication', locator: 'pubid', collectionId: 'a\nb' },
    }));
    assertKeyError('invalid_id_character', () => buildCacheDataKey({
      ...base, domain: { kind: 'publication', locator: 'pubid', collectionId: 'a b' },
    }));
    assertKeyError('id_too_long', () => buildCacheDataKey({
      ...base, domain: { kind: 'publication', locator: 'pubid', collectionId: 'x'.repeat(129) },
    }));
    assertKeyError('invalid_environment', () => buildCacheDataKey({
      ...base, environment: '',
    }));
    assertKeyError('invalid_key_prefix', () => buildCacheDataKey({
      ...base, keyPrefix: 'bad prefix!',
    }));
    assertKeyError('invalid_schema_version', () => buildCacheDataKey({
      ...base, schemaVersion: 0,
    }));
    assertKeyError('invalid_projection', () => buildCacheDataKey({
      ...base, projection: 'Metadata',
    }));
    assertKeyError('invalid_epoch', () => buildCacheDataKey({
      ...base, epoch: -1,
    }));
  });

  test('anonymous cache keys and hashes never carry principal identity', () => {
    const key = buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-1' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 1,
      query: {},
      environment: 'production',
    });
    assert.doesNotMatch(key, /principal|owner|subject|user|session|authorization|cookie/iu);
    assert.deepEqual(normalizeCacheQuery({ principalId: 'p-1' }), { kind: 'rejected', reason: 'forbidden_principal_key' });
    assert.deepEqual(normalizeCacheQuery({ ownerSubjectId: 's-1' }), { kind: 'rejected', reason: 'forbidden_principal_key' });
    assertKeyError('unnormalized_query', () => buildCacheDataKey({
      domain: { kind: 'publication', locator: 'pubid', collectionId: 'collection-1' },
      projection: CACHE_PROJECTION.PUBLICATION_METADATA,
      epoch: 1,
      query: { principalId: 'p-1' },
      environment: 'production',
    }));
  });
});
