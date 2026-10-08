import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CACHE_ERROR_CATEGORY,
  CacheStoreError,
  type CacheStore,
} from '../../../src/infrastructure/cache/cache-store.js';
import { buildCacheEpochKey } from '../../../src/infrastructure/cache/cache-key-codec.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  PUBLICATION_CACHE_EPOCH_TTL_MS,
  PUBLICATION_MAX_DATA_HARD_TTL_MS,
  RedisPublicationCacheInvalidator,
  type RedisPublicationInvalidationScope,
} from '../../../src/infrastructure/outbox/redis-publication-invalidator.js';
import { PublicationCachePurgeProviderError } from '../../../src/infrastructure/outbox/publication-cache-purge.js';

const KEY_OPTIONS = Object.freeze({ environment: 'test', keyPrefix: 'known' });

function epochKeyFor(collectionId: string): string {
  return buildCacheEpochKey({
    ...KEY_OPTIONS,
    domain: { kind: 'publication', locator: 'pubid', collectionId },
  });
}

function slugEpochKeyFor(publicationSlug: string): string {
  return buildCacheEpochKey({
    ...KEY_OPTIONS,
    domain: { kind: 'publication', locator: 'pubslug', collectionId: publicationSlug },
  });
}

const DIRECTORY_EPOCH_KEY = buildCacheEpochKey({
  ...KEY_OPTIONS,
  domain: { kind: 'publication-directory' },
});

/**
 * Scripted fake CacheStore: records every rotateEpoch call (key, TTL, signal)
 * and serves strictly monotonic positive epochs. Any other mutation is
 * recorded so a test can prove the invalidator never writes an epoch override
 * via `set` — invalidation only ever calls `rotateEpoch`.
 */
class FakeCacheStore implements CacheStore {
  readonly epochs = new Map<string, number>();
  readonly rotateCalls: Array<{ key: string; epochTtlMs: number; signal: AbortSignal; epoch: number }> = [];
  readonly setCalls: string[] = [];
  failRotate: Error | null = null;

  async rotateEpoch(key: string, epochTtlMs: number, signal: AbortSignal): Promise<number> {
    const next = (this.epochs.get(key) ?? 0) + 1;
    this.rotateCalls.push({ key, epochTtlMs, signal, epoch: next });
    if (this.failRotate !== null) throw this.failRotate;
    this.epochs.set(key, next);
    return next;
  }

  async get(_key: string, _signal: AbortSignal): Promise<string | null> { return null; }
  async set(key: string, _encodedValue: string, _hardTtlMs: number, _signal: AbortSignal): Promise<void> {
    this.setCalls.push(key);
  }
  async setIfAbsent(_key: string, _token: string, _lockTtlMs: number, _signal: AbortSignal): Promise<boolean> {
    return true;
  }
  async releaseIfOwner(_key: string, _token: string, _signal: AbortSignal): Promise<boolean> {
    return true;
  }
  async health(_signal?: AbortSignal) { return 'healthy' as const; }
  async close(): Promise<void> {}
}

function scope(overrides: Partial<RedisPublicationInvalidationScope> = {}): RedisPublicationInvalidationScope {
  return {
    collectionId: 'collection-1',
    publicationSlug: 'engineering-notes',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function harness(options: { store?: FakeCacheStore; metrics?: InMemoryMetrics; epochTtlMs?: number } = {}) {
  const store = options.store ?? new FakeCacheStore();
  const metrics = options.metrics ?? new InMemoryMetrics();
  const invalidator = new RedisPublicationCacheInvalidator({
    store,
    key: KEY_OPTIONS,
    epochTtlMs: options.epochTtlMs,
    metrics,
  });
  return { store, metrics, invalidator };
}

describe('RedisPublicationCacheInvalidator epoch rotation contract', () => {
  test('rotates both the collectionId and publicationSlug epochs on rotateCollection', async () => {
    const { store, invalidator } = harness();
    await invalidator.rotateCollection(scope());

    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 1);
    assert.equal(store.epochs.get(slugEpochKeyFor('engineering-notes')), 1);
    assert.equal(store.epochs.get(DIRECTORY_EPOCH_KEY), undefined, 'collection rotation must not touch the directory epoch');
    assert.deepEqual(store.rotateCalls.map((call) => call.key), [
      epochKeyFor('collection-1'),
      slugEpochKeyFor('engineering-notes'),
    ]);
  });

  test('rotates the global directory epoch on rotateDirectory', async () => {
    const { store, invalidator } = harness();
    await invalidator.rotateDirectory(new AbortController().signal);
    assert.equal(store.epochs.get(DIRECTORY_EPOCH_KEY), 1);
  });

  test('rotates both locator epochs even when collectionId equals publicationSlug', async () => {
    // The locator kinds make the ID-scoped and slug-scoped epoch keys distinct
    // even for the same string, so both are always rotated (previously the two
    // scopes collapsed onto one key and were deduplicated).
    const { store, invalidator } = harness();
    await invalidator.rotateCollection(scope({ collectionId: 'same', publicationSlug: 'same' }));
    assert.equal(store.rotateCalls.length, 2);
    assert.equal(store.epochs.get(epochKeyFor('same')), 1);
    assert.equal(store.epochs.get(slugEpochKeyFor('same')), 1);
  });

  test('passes the epoch TTL (default > 2x max data hard TTL) on every rotation', async () => {
    assert.ok(
      PUBLICATION_CACHE_EPOCH_TTL_MS > 2 * PUBLICATION_MAX_DATA_HARD_TTL_MS,
      `epoch TTL ${PUBLICATION_CACHE_EPOCH_TTL_MS} must exceed 2x max data hard TTL ${PUBLICATION_MAX_DATA_HARD_TTL_MS}`,
    );
    assert.equal(PUBLICATION_CACHE_EPOCH_TTL_MS, 120_000);

    const { store, invalidator } = harness();
    await invalidator.rotateCollection(scope());
    await invalidator.rotateDirectory(new AbortController().signal);
    assert.ok(store.rotateCalls.length >= 3);
    assert.ok(store.rotateCalls.every((call) => call.epochTtlMs === PUBLICATION_CACHE_EPOCH_TTL_MS));
  });

  test('rejects an epoch TTL that is not greater than 2x the max data hard TTL', () => {
    assert.throws(() => new RedisPublicationCacheInvalidator({
      store: new FakeCacheStore(),
      key: KEY_OPTIONS,
      epochTtlMs: 2 * PUBLICATION_MAX_DATA_HARD_TTL_MS,
    }), /epochTtlMs/u);
    assert.throws(() => new RedisPublicationCacheInvalidator({
      store: new FakeCacheStore(),
      key: KEY_OPTIONS,
      epochTtlMs: 0,
    }), /epochTtlMs/u);
  });

  test('never writes an epoch override and only ever uses rotateEpoch', async () => {
    const { store, invalidator } = harness();
    await invalidator.rotateCollection(scope());
    await invalidator.rotateDirectory(new AbortController().signal);
    assert.equal(store.setCalls.length, 0, 'epoch invalidation must never SET a value back');
    assert.equal(store.rotateCalls.length, 3);
  });

  test('replaying the same scope only advances the epoch monotonically', async () => {
    const { store, invalidator } = harness();
    await invalidator.rotateCollection(scope());
    await invalidator.rotateCollection(scope());
    await invalidator.rotateCollection(scope());

    const key = epochKeyFor('collection-1');
    const snapshots = store.rotateCalls
      .filter((call) => call.key === key)
      .map((call) => call.epoch);
    assert.ok(snapshots.length >= 3);
    for (let i = 1; i < snapshots.length; i += 1) {
      assert.ok(snapshots[i]! > snapshots[i - 1]!, 'epoch must strictly increase on replay');
    }
    assert.equal(store.epochs.get(key), snapshots[snapshots.length - 1]);
  });

  test('an ID and an unrelated slug that share a string never share an epoch key (A.id === B.slug)', async () => {
    const { store, invalidator } = harness();
    // Collection A has id 'shared'; an unrelated collection B has slug 'shared'.
    await invalidator.rotateCollection(scope({ collectionId: 'shared', publicationSlug: 'a-slug' }));
    await invalidator.rotateCollection(scope({ collectionId: 'b-id', publicationSlug: 'shared' }));

    // A's purge rotates only the pubid epoch of 'shared'...
    assert.equal(store.epochs.get(epochKeyFor('shared')), 1);
    // ...and B's purge rotates only the pubslug epoch of 'shared'; neither
    // purge ever advances the other locator's epoch for the same string.
    assert.equal(store.epochs.get(slugEpochKeyFor('shared')), 1);
    assert.equal(store.epochs.get(epochKeyFor('shared')), 1, 'B\'s slug purge must not advance A\'s ID epoch');
    assert.equal(store.epochs.get(slugEpochKeyFor('shared')), 1, 'A\'s ID purge must not advance B\'s slug epoch');
    assert.equal(store.epochs.get(epochKeyFor('b-id')), 1);
    assert.equal(store.epochs.get(slugEpochKeyFor('a-slug')), 1);
  });

  test('only invalidates the targeted collection scope, leaving other collections untouched', async () => {
    const { store, invalidator } = harness();
    await invalidator.rotateCollection(scope());
    await invalidator.rotateCollection(scope({ collectionId: 'collection-2', publicationSlug: 'other-slug' }));

    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 1);
    assert.equal(store.epochs.get(slugEpochKeyFor('engineering-notes')), 1);
    assert.equal(store.epochs.get(epochKeyFor('collection-2')), 1);
    assert.equal(store.epochs.get(slugEpochKeyFor('other-slug')), 1);
    assert.equal(store.epochs.get(epochKeyFor('collection-3')), undefined);
  });

  test('surfaces a Redis failure as a retryable provider error and does not count the rotation', async () => {
    const store = new FakeCacheStore();
    store.failRotate = new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'redis down');
    const metrics = new InMemoryMetrics();
    const { invalidator } = harness({ store, metrics });

    await assert.rejects(
      invalidator.rotateCollection(scope()),
      (error: unknown) => error instanceof PublicationCachePurgeProviderError
        && error.failureKind === 'retryable',
    );
    assert.equal(metrics.get('cache.epoch.rotation_total'), 0);
  });

  test('surfaces an unexpected store failure as retryable', async () => {
    const store = new FakeCacheStore();
    store.failRotate = new Error('unexpected');
    const { invalidator } = harness({ store });
    await assert.rejects(
      invalidator.rotateDirectory(new AbortController().signal),
      (error: unknown) => error instanceof PublicationCachePurgeProviderError
        && error.failureKind === 'retryable',
    );
  });

  test('classifies an unkeyable scope as permanent (dead-letter) because retrying cannot fix it', async () => {
    const { invalidator } = harness();
    await assert.rejects(
      invalidator.rotateCollection(scope({ collectionId: 'bad id!' })),
      (error: unknown) => error instanceof PublicationCachePurgeProviderError
        && error.failureKind === 'permanent',
    );
  });

  test('increments cache.epoch.rotation_total exactly once per successful rotateEpoch', async () => {
    const metrics = new InMemoryMetrics();
    const { invalidator } = harness({ metrics });
    await invalidator.rotateCollection(scope());
    assert.equal(metrics.get('cache.epoch.rotation_total'), 2);
    await invalidator.rotateDirectory(new AbortController().signal);
    assert.equal(metrics.get('cache.epoch.rotation_total'), 3);
  });
});
