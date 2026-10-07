/**
 * P4 unit tests (library collection bookmark-count plan §5.3 / §7 P4 / §8.2):
 * batch GET, one origin GROUP BY for misses, SET, singleflight, fail-open,
 * serveStale=false.
 *
 * The suite imports the production decorator, codec and read-through helpers.
 * Hash/TTL algorithms are not copied here. Hit tests assert origin
 * `countBookmarks` call counts (not just equal return values); miss tests
 * assert SET happened. Concurrent cases use start-gates, never `sleep`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CacheBulkhead,
  CacheCircuitBreaker,
  CacheSingleflight,
  buildCacheLockKey,
  buildCollectionBookmarkCountCacheDataKey,
  createCollectionBookmarkCountCache,
  decodeCollectionBookmarkCountCacheEnvelope,
  defaultCollectionBookmarkCountCachePolicy,
  encodeCollectionBookmarkCountCacheEnvelope,
  type CollectionBookmarkCountCacheOrigin,
  type CacheKeyOptions,
} from '../../../src/infrastructure/cache/index.js';
import { FakeCacheStore } from '../../support/cache-test-fixtures.js';

const KEY: CacheKeyOptions = { environment: 'production', keyPrefix: 'known' };
const POLICY = defaultCollectionBookmarkCountCachePolicy();
const CODEC_OPTIONS = { maxEntryBytes: POLICY.maxEntryBytes };
const NOW = 1_000_000;

interface OriginHandle {
  readonly port: CollectionBookmarkCountCacheOrigin;
  readonly calls: string[][];
  callCount(): number;
  setFail(flag: boolean): void;
  setOnCall(hook: (() => Promise<void>) | undefined): void;
}

function makeOrigin(table: Record<string, number> = {}): OriginHandle {
  const calls: string[][] = [];
  let fail = false;
  let onCall: (() => Promise<void>) | undefined;
  const port: CollectionBookmarkCountCacheOrigin = {
    async countBookmarks(collectionIds) {
      calls.push([...collectionIds]);
      if (onCall !== undefined) await onCall();
      if (fail) throw new Error('origin COUNT failed');
      const counts = new Map<string, number>();
      for (const collectionId of collectionIds) {
        if (Object.prototype.hasOwnProperty.call(table, collectionId)) {
          counts.set(collectionId, table[collectionId]!);
        }
      }
      return counts;
    },
  };
  return {
    port,
    calls,
    callCount: () => calls.length,
    setFail: (flag) => { fail = flag; },
    setOnCall: (hook) => { onCall = hook; },
  };
}

function makeCache(
  store: FakeCacheStore,
  origin: CollectionBookmarkCountCacheOrigin,
  clock: () => number = () => NOW,
): ReturnType<typeof createCollectionBookmarkCountCache> {
  return createCollectionBookmarkCountCache({
    store,
    origin,
    clock,
    singleflight: new CacheSingleflight(),
    bulkhead: new CacheBulkhead(8),
    key: KEY,
    policy: POLICY,
    random: () => 0,
    tokenFactory: () => 'token-1',
  });
}

function entry(collectionId: string, contentRevision = 'rev-1'): { collectionId: string; contentRevision: string } {
  return { collectionId, contentRevision };
}

function dataKey(collectionId: string, contentRevision = 'rev-1'): string {
  return buildCollectionBookmarkCountCacheDataKey({
    collectionId,
    query: { contentRevision },
    ...KEY,
  });
}

function seedEnvelope(
  store: FakeCacheStore,
  collectionId: string,
  bookmarkCount: number,
  times: { writtenAtMs: number; softExpiresAtMs: number; hardExpiresAtMs: number },
  contentRevision = 'rev-1',
): string {
  const encoded = encodeCollectionBookmarkCountCacheEnvelope(
    { bookmarkCount },
    times,
    CODEC_OPTIONS,
  );
  assert.equal(encoded.kind, 'ok', 'fixture envelope must encode');
  if (encoded.kind !== 'ok') throw new Error('fixture envelope must encode');
  const key = dataKey(collectionId, contentRevision);
  store.data.set(key, encoded.encoded);
  return key;
}

function seedFresh(store: FakeCacheStore, collectionId: string, bookmarkCount: number, now = NOW): string {
  return seedEnvelope(store, collectionId, bookmarkCount, {
    writtenAtMs: now - 1_000,
    softExpiresAtMs: now + POLICY.softTtlMs,
    hardExpiresAtMs: now + POLICY.hardTtlMs,
  });
}

function seedSoftExpired(store: FakeCacheStore, collectionId: string, bookmarkCount: number, now = NOW): string {
  return seedEnvelope(store, collectionId, bookmarkCount, {
    writtenAtMs: now - 1,
    softExpiresAtMs: now - 1,
    hardExpiresAtMs: now + 1_000_000,
  });
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function asSet(ids: readonly string[]): Set<string> {
  return new Set(ids);
}

describe('collection bookmark-count batch cache', () => {
  test('empty entries skip Redis and origin', async () => {
    const store = new FakeCacheStore();
    const origin = makeOrigin();
    const cache = makeCache(store, origin.port);
    const result = await cache.lookupBookmarkCounts([]);
    assert.equal(result.size, 0);
    assert.equal(store.calls.length, 0);
    assert.equal(origin.callCount(), 0);
  });

  test('same key second lookup is a hit: origin COUNT=0 and the miss SET', async () => {
    const store = new FakeCacheStore();
    const origin = makeOrigin({ 'collection-1': 9 });
    const cache = makeCache(store, origin.port);

    const first = await cache.lookupBookmarkCounts([entry('collection-1')]);
    assert.equal(first.get('collection-1'), 9);
    assert.equal(origin.callCount(), 1, 'the first lookup is a miss and must COUNT');
    assert.equal(store.callsOf('set').length, 1, 'a miss must be written back');
    assert.equal(store.callsOf('set')[0].args[0], dataKey('collection-1'));

    const second = await cache.lookupBookmarkCounts([entry('collection-1')]);
    assert.equal(second.get('collection-1'), 9);
    assert.equal(origin.callCount(), 1, 'a fresh hit must never call countBookmarks');
    assert.equal(store.callsOf('set').length, 1, 'a hit must not SET');
  });

  test('page of 30 misses issues one GROUP BY and parallel GET', async () => {
    const store = new FakeCacheStore();
    const ids = Array.from({ length: 30 }, (_, index) => `collection-${index + 1}`);
    const table: Record<string, number> = {};
    for (const [index, id] of ids.entries()) table[id] = index + 1;
    const origin = makeOrigin(table);

    let startedGets = 0;
    let releaseGets!: () => void;
    const getsGate = new Promise<void>((resolve) => { releaseGets = resolve; });
    store.onGet = async () => {
      startedGets += 1;
      if (startedGets === 30) releaseGets();
      await getsGate;
    };

    const cache = makeCache(store, origin.port);
    const result = await cache.lookupBookmarkCounts(ids.map((collectionId) => entry(collectionId)));

    assert.equal(startedGets, 30, 'all 30 GETs must start before any GET finishes (Promise.all)');
    assert.equal(origin.callCount(), 1, 'one page of misses must issue exactly one countBookmarks');
    assert.deepEqual(asSet(origin.calls[0] ?? []), asSet(ids));
    assert.equal(store.callsOf('set').length, 30, 'each miss must SET');
    assert.ok(store.callsOf('get').length >= 30);

    const lockKeys = new Set(store.callsOf('setIfAbsent').map((call) => call.args[0] as string));
    assert.equal(lockKeys.size, 30, 'the distributed lock is per collection data key, not one page lock');
    for (const collectionId of ids) {
      assert.ok(lockKeys.has(buildCacheLockKey(dataKey(collectionId))));
      assert.equal(result.get(collectionId), table[collectionId]);
    }
  });

  test('concurrent same key merges to one origin COUNT under a start-gate', async () => {
    const store = new FakeCacheStore();
    const origin = makeOrigin({ 'collection-1': 4 });
    let getCalls = 0;
    let releaseGets!: () => void;
    const getsGate = new Promise<void>((resolve) => { releaseGets = resolve; });
    store.onGet = async () => {
      getCalls += 1;
      if (getCalls === 2) releaseGets();
      if (getCalls <= 2) await getsGate;
    };

    let releaseOrigin!: () => void;
    const originGate = new Promise<void>((resolve) => { releaseOrigin = resolve; });
    origin.setOnCall(async () => { await originGate; });

    const cache = makeCache(store, origin.port);
    const first = cache.lookupBookmarkCounts([entry('collection-1')]);
    await flush();
    const second = cache.lookupBookmarkCounts([entry('collection-1')]);
    await flush();
    assert.equal(getCalls, 2, 'both lookups must observe the miss before either refreshes');

    releaseGets();
    await flush(20);
    assert.equal(origin.callCount(), 1, 'in-process singleflight must merge the same data key');

    releaseOrigin();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.get('collection-1'), 4);
    assert.equal(right.get('collection-1'), 4);
    assert.equal(origin.callCount(), 1);
    assert.equal(store.callsOf('set').length, 1);
    assert.deepEqual(asSet(origin.calls[0] ?? []), asSet(['collection-1']));
  });

  test('Redis GET unavailable fails open to origin COUNT without throwing', async () => {
    const store = new FakeCacheStore();
    store.failGet = true;
    const origin = makeOrigin({ 'collection-1': 12 });
    const cache = makeCache(store, origin.port);
    const result = await cache.lookupBookmarkCounts([entry('collection-1')]);
    assert.equal(result.get('collection-1'), 12);
    assert.equal(origin.callCount(), 1);
    assert.equal(store.callsOf('set').length, 0, 'a GET failure must not write through a broken store');
  });

  test('origin COUNT throw does not SET an envelope', async () => {
    const store = new FakeCacheStore();
    const origin = makeOrigin({ 'collection-1': 3 });
    origin.setFail(true);
    const cache = makeCache(store, origin.port);
    await assert.rejects(
      cache.lookupBookmarkCounts([entry('collection-1')]),
      /origin COUNT failed/,
    );
    assert.equal(origin.callCount(), 1);
    assert.equal(store.callsOf('set').length, 0, 'a loader failure must not write an envelope');
  });

  test('bookmarkCount 0 is written and the second lookup is a hit', async () => {
    const store = new FakeCacheStore();
    const origin = makeOrigin();
    const cache = makeCache(store, origin.port);

    const first = await cache.lookupBookmarkCounts([entry('collection-empty')]);
    assert.equal(first.get('collection-empty'), 0);
    assert.equal(origin.callCount(), 1);
    assert.equal(store.callsOf('set').length, 1, '0 is a real empty-collection count and must be written');

    const encoded = store.callsOf('set')[0].args[1];
    const decoded = decodeCollectionBookmarkCountCacheEnvelope(encoded as string, CODEC_OPTIONS);
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') assert.equal(decoded.envelope.value.bookmarkCount, 0);

    const second = await cache.lookupBookmarkCounts([entry('collection-empty')]);
    assert.equal(second.get('collection-empty'), 0);
    assert.equal(origin.callCount(), 1, 'the cached 0 must be a hit');
    assert.equal(store.callsOf('set').length, 1);
  });

  test('serveStale=false: soft-expired refresh failure does not return the stale integer', async () => {
    const store = new FakeCacheStore();
    seedSoftExpired(store, 'collection-1', 99);
    const origin = makeOrigin({ 'collection-1': 1 });
    origin.setFail(true);
    const cache = makeCache(store, origin.port);

    await assert.rejects(
      cache.lookupBookmarkCounts([entry('collection-1')]),
      /origin COUNT failed/,
    );
    assert.equal(origin.callCount(), 1, 'soft-expired must refresh in the foreground');
    assert.equal(store.callsOf('set').length, 0, 'a failed refresh must not write');
  });

  test('mixed hit and miss on one page COUNTs only the miss ids', async () => {
    const store = new FakeCacheStore();
    seedFresh(store, 'collection-hit', 17);
    const origin = makeOrigin({ 'collection-miss-a': 2, 'collection-miss-b': 5 });
    const cache = makeCache(store, origin.port);

    const result = await cache.lookupBookmarkCounts([
      entry('collection-hit'),
      entry('collection-miss-a'),
      entry('collection-miss-b'),
    ]);
    assert.equal(result.get('collection-hit'), 17);
    assert.equal(result.get('collection-miss-a'), 2);
    assert.equal(result.get('collection-miss-b'), 5);
    assert.equal(origin.callCount(), 1);
    assert.deepEqual(asSet(origin.calls[0] ?? []), asSet(['collection-miss-a', 'collection-miss-b']));
    assert.equal(
      origin.calls[0]?.includes('collection-hit'),
      false,
      'hits must not appear in the origin COUNT argument',
    );
    assert.equal(store.callsOf('set').length, 2);
  });

  test('duplicate ids on a page issue one GET per unique key and one origin membership', async () => {
    const store = new FakeCacheStore();
    const origin = makeOrigin({ 'collection-1': 8 });
    const cache = makeCache(store, origin.port);
    const result = await cache.lookupBookmarkCounts([
      entry('collection-1'),
      entry('collection-1'),
    ]);
    assert.equal(result.get('collection-1'), 8);
    assert.equal(store.callsOf('get').length, 1, 'duplicate keys must share one GET');
    assert.equal(origin.callCount(), 1);
    assert.deepEqual(asSet(origin.calls[0] ?? []), asSet(['collection-1']));
    assert.equal(store.callsOf('set').length, 1);
  });

  test('unkeyable collectionId fails open to origin and does not poison the page', async () => {
    const store = new FakeCacheStore();
    const origin = makeOrigin({ 'collection-1': 6, '': 0 });
    const cache = makeCache(store, origin.port);
    const result = await cache.lookupBookmarkCounts([
      entry('', 'rev-1'),
      entry('collection-1'),
    ]);
    assert.equal(result.get('collection-1'), 6);
    assert.equal(result.get(''), 0);
    assert.equal(origin.callCount(), 1);
    assert.ok(asSet(origin.calls[0] ?? []).has(''));
    assert.ok(asSet(origin.calls[0] ?? []).has('collection-1'));
    assert.equal(store.callsOf('get').length, 1, 'only the keyable id is read from Redis');
    assert.equal(store.callsOf('set').length, 1, 'only the keyable miss is written');
    assert.equal(store.callsOf('set')[0].args[0], dataKey('collection-1'));
  });

  test('a bad cached value is treated as a miss and overwritten', async () => {
    const store = new FakeCacheStore();
    store.data.set(dataKey('collection-1'), JSON.stringify({
      schemaVersion: 1,
      writtenAtMs: NOW,
      softExpiresAtMs: NOW + POLICY.softTtlMs,
      hardExpiresAtMs: NOW + POLICY.hardTtlMs,
      value: { bookmarkCount: -1 },
    }));
    const origin = makeOrigin({ 'collection-1': 3 });
    const cache = makeCache(store, origin.port);
    const result = await cache.lookupBookmarkCounts([entry('collection-1')]);
    assert.equal(result.get('collection-1'), 3);
    assert.equal(origin.callCount(), 1);
    assert.equal(store.callsOf('set').length, 1, 'the bad value must be overwritten');
    const decoded = decodeCollectionBookmarkCountCacheEnvelope(
      store.callsOf('set')[0].args[1] as string,
      CODEC_OPTIONS,
    );
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') assert.equal(decoded.envelope.value.bookmarkCount, 3);
  });
});

describe('collection bookmark-count breaker wiring (RDS-05 / T-11)', () => {
  function makeBreakerCache(
    store: FakeCacheStore,
    origin: CollectionBookmarkCountCacheOrigin,
    breaker: CacheCircuitBreaker,
    clock: () => number,
  ): ReturnType<typeof createCollectionBookmarkCountCache> {
    return createCollectionBookmarkCountCache({
      store,
      origin,
      clock,
      singleflight: new CacheSingleflight(),
      bulkhead: new CacheBulkhead(8),
      key: KEY,
      policy: POLICY,
      breaker,
      random: () => 0,
      tokenFactory: () => 'token-1',
    });
  }

  test('an open breaker bypasses Redis with one origin COUNT per page', async () => {
    let nowMs = NOW;
    const breaker = new CacheCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      clock: () => nowMs,
    });
    const store = new FakeCacheStore();
    store.failGet = true;
    const origin = makeOrigin({ 'collection-1': 4, 'collection-2': 7 });
    const cache = makeBreakerCache(store, origin.port, breaker, () => nowMs);

    const first = await cache.lookupBookmarkCounts([entry('collection-1'), entry('collection-2')]);
    assert.equal(first.get('collection-1'), 4);
    assert.equal(first.get('collection-2'), 7);
    assert.equal(breaker.currentState, 'open', 'unavailable GETs must open the breaker');
    const getsAfterFirst = store.callsOf('get').length;

    const second = await cache.lookupBookmarkCounts([entry('collection-1'), entry('collection-2')]);
    assert.equal(second.get('collection-1'), 4);
    assert.equal(second.get('collection-2'), 7);
    assert.equal(store.callsOf('get').length, getsAfterFirst,
      'an open breaker must not issue any Redis command');
    assert.equal(origin.callCount(), 2, 'each bypassed page costs exactly one origin COUNT');
    assert.deepEqual(asSet(origin.calls[1] ?? []), asSet(['collection-1', 'collection-2']));
  });

  test('the half-open probe closes the breaker once Redis recovers', async () => {
    let nowMs = NOW;
    const breaker = new CacheCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      clock: () => nowMs,
    });
    const store = new FakeCacheStore();
    store.failGet = true;
    const origin = makeOrigin({ 'collection-1': 4 });
    const cache = makeBreakerCache(store, origin.port, breaker, () => nowMs);

    await cache.lookupBookmarkCounts([entry('collection-1')]);
    assert.equal(breaker.currentState, 'open');

    store.failGet = false;
    seedFresh(store, 'collection-1', 4, nowMs);
    nowMs += 1_001;
    const recovered = await cache.lookupBookmarkCounts([entry('collection-1')]);
    assert.equal(recovered.get('collection-1'), 4);
    assert.equal(breaker.currentState, 'closed', 'a healthy probe read must close the breaker');
  });
});
