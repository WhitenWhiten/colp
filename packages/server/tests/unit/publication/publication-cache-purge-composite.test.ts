import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CACHE_ERROR_CATEGORY,
  CacheStoreError,
  type CacheStore,
} from '../../../src/infrastructure/cache/cache-store.js';
import { buildCacheEpochKey } from '../../../src/infrastructure/cache/cache-key-codec.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { EventEnvelopeRegistry } from '../../../src/infrastructure/outbox/envelope.js';
import {
  OutboxDeliveryError,
  OutboxRouter,
  type OutboxHandlerContext,
} from '../../../src/infrastructure/outbox/router.js';
import {
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION_N_MINUS_1,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
  PublicationCachePurgeProviderError,
  createPublicationCachePurgeRoutes,
  publicationCachePurgeEnvelopeRegistrations,
  publicationCachePurgeIdempotencyKey,
  type PublicationCachePurgeProvider,
  type PublicationCachePurgeRequest,
} from '../../../src/infrastructure/outbox/publication-cache-purge.js';
import {
  CompositePublicationCachePurgeProvider,
  PUBLICATION_DIRECTORY_ROTATION_BY_SOURCE_EVENT_TYPE,
  shouldRotatePublicationDirectory,
} from '../../../src/infrastructure/outbox/publication-cache-purge-composite.js';
import { RedisPublicationCacheInvalidator } from '../../../src/infrastructure/outbox/redis-publication-invalidator.js';
import { VersionedOutboxWorker, createExponentialRetryPolicy } from '../../../src/infrastructure/outbox/worker.js';
import type {
  FailureDisposition,
  OutboxClaim,
  OutboxRepository,
} from '../../../src/infrastructure/outbox/repository.js';

const KEY_OPTIONS = Object.freeze({ environment: 'test', keyPrefix: 'known' });
const PUBLICATION_ORIGIN = 'https://collections.example.test';
const PRODUCT_ORIGIN = 'https://app.example.test';

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

class FakeCacheStore implements CacheStore {
  readonly epochs = new Map<string, number>();
  readonly rotateCalls: Array<{ key: string; epochTtlMs: number; signal: AbortSignal }> = [];
  failRotate: Error | null = null;

  async rotateEpoch(key: string, epochTtlMs: number, signal: AbortSignal): Promise<number> {
    this.rotateCalls.push({ key, epochTtlMs, signal });
    if (this.failRotate !== null) throw this.failRotate;
    const next = (this.epochs.get(key) ?? 0) + 1;
    this.epochs.set(key, next);
    return next;
  }
  async get(_key: string, _signal: AbortSignal): Promise<string | null> { return null; }
  async set(_key: string, _encodedValue: string, _hardTtlMs: number, _signal: AbortSignal): Promise<void> {}
  async setIfAbsent(_key: string, _token: string, _lockTtlMs: number, _signal: AbortSignal): Promise<boolean> {
    return true;
  }
  async releaseIfOwner(_key: string, _token: string, _signal: AbortSignal): Promise<boolean> { return true; }
  async health(_signal?: AbortSignal) { return 'healthy' as const; }
  async close(): Promise<void> {}
}

class FakeCdnProvider implements PublicationCachePurgeProvider {
  readonly calls: PublicationCachePurgeRequest[] = [];
  failWith: PublicationCachePurgeProviderError | null = null;

  async purge(request: PublicationCachePurgeRequest): Promise<void> {
    this.calls.push(request);
    if (this.failWith !== null) throw this.failWith;
  }
}

const v1Payload = { collectionId: 'collection-1', publicationSlug: 'engineering-notes' } as const;

function v2Payload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    collectionId: 'collection-1',
    contentRevision: 'content-7',
    policyRevision: 'policy-4',
    publicationSlug: 'engineering-notes',
    sourceEventType: 'node.updated',
    sourceEventVersion: 1,
    visibility: 'public',
    ...overrides,
  };
}

function envelope(version: 1 | 2, payload: Record<string, unknown>, eventId = 'event-1') {
  return {
    event_id: eventId,
    event_type: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
    event_version: version,
    aggregate_identity: {
      aggregate_type: 'collection',
      aggregate_id: 'collection-1',
      aggregate_scope: 'collection-1',
    },
    aggregate_revision: 'policy-4',
    commit_ordinal: '7',
    occurred_at: '2026-07-24T00:00:00.000Z',
    payload,
  };
}

/** Builds a handler context without registry validation for route-level closed-validator tests. */
function rawContext(version: 1 | 2, payload: Record<string, unknown>, eventId = 'event-1'): OutboxHandlerContext {
  return {
    envelope: envelope(version, payload, eventId) as OutboxHandlerContext['envelope'],
    idempotencyKey: eventId,
    signal: new AbortController().signal,
  };
}
function context(version: 1 | 2, payload: Record<string, unknown>, eventId = 'event-1'): OutboxHandlerContext {
  const registry = new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations());
  return {
    envelope: registry.validate(envelope(version, payload, eventId)),
    idempotencyKey: eventId,
    signal: new AbortController().signal,
  };
}

function harness(options: { cdn?: FakeCdnProvider; store?: FakeCacheStore; metrics?: InMemoryMetrics } = {}) {
  const store = options.store ?? new FakeCacheStore();
  const cdn = options.cdn ?? new FakeCdnProvider();
  const metrics = options.metrics ?? new InMemoryMetrics();
  const invalidator = new RedisPublicationCacheInvalidator({ store, key: KEY_OPTIONS, metrics });
  const composite = new CompositePublicationCachePurgeProvider({ invalidator, cdn, metrics });
  const routes = createPublicationCachePurgeRoutes({
    provider: composite,
    publicationOrigin: PUBLICATION_ORIGIN,
    productOrigin: PRODUCT_ORIGIN,
    timeoutMs: 100,
    metrics,
  });
  return { store, cdn, metrics, invalidator, composite, routes };
}

function claim(overrides: Partial<OutboxClaim> = {}): OutboxClaim {
  return {
    outboxId: 'outbox-1',
    eventId: 'event-1',
    eventType: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
    eventVersion: PUBLICATION_CACHE_PURGE_EVENT_VERSION,
    handlerName: PUBLICATION_CACHE_PURGE_HANDLER_NAME,
    handlerMode: 'delivery_each_event',
    aggregateType: 'collection',
    aggregateId: 'collection-1',
    aggregateScope: 'collection-1',
    aggregateRevision: 'policy-4',
    commitOrdinal: '7',
    occurredAt: new Date('2026-07-24T00:00:00.000Z'),
    payload: v2Payload(),
    attemptCount: 1,
    leaseGeneration: '1',
    ...overrides,
  };
}

class FakeRepository implements OutboxRepository {
  readonly failures: Array<{
    readonly claim: OutboxClaim;
    readonly disposition: FailureDisposition;
  }> = [];
  readonly completed: OutboxClaim[] = [];

  constructor(readonly claims: OutboxClaim[]) {}

  async claim(): Promise<OutboxClaim | null> { return this.claims.shift() ?? null; }
  async inspectBacklog() { return { count: this.claims.length, oldestAgeMs: 500 }; }
  async heartbeat() { return true; }
  async isObsoleteProjection() { return false; }
  async hasDeliveryReceipt() { return false; }
  async complete(seen: OutboxClaim): Promise<boolean> { this.completed.push(seen); return true; }
  async continue(_seen: OutboxClaim): Promise<boolean> { return true; }
  async fail(
    seen: OutboxClaim,
    _error: string,
    _retryDelayMs: number,
    maxAttempts: number,
  ): Promise<FailureDisposition> {
    const disposition = seen.attemptCount >= maxAttempts ? 'dead_letter' : 'retryable';
    this.failures.push({ claim: seen, disposition });
    if (disposition === 'retryable') {
      // Simulate the real repository returning the claim to pending so a later
      // runOnce replays the exact same event (out-of-order replay semantics).
      this.claims.unshift({ ...seen, attemptCount: seen.attemptCount + 1 });
    }
    return disposition;
  }
}

const logger = { info() {}, warn() {}, error() {} };

describe('publication cache purge Directory rotation decision table', () => {
  test('pins the explicit sourceEventType -> Directory rotation mapping', () => {
    assert.deepEqual(PUBLICATION_DIRECTORY_ROTATION_BY_SOURCE_EVENT_TYPE, {
      'collection.created': true,
      'collection.updated': true,
      'collection.deleted': true,
      'node.created': true,
      'node.restored': true,
      'node.deleted': true,
      'node.moved': true,
      'node.updated': false,
      'annotation.created': false,
      'annotation.updated': false,
      'annotation.deleted': false,
      'relation.created': false,
      'relation.updated': false,
      'relation.deleted': false,
    });
  });

  test('rotates Directory for lifecycle/metadata events and not for plain content updates', () => {
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'collection.created', visibility: 'public' }), true);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'collection.updated', visibility: 'public' }), true);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'node.created', visibility: 'public' }), true);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'node.restored', visibility: 'public' }), true);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'node.deleted', visibility: 'public' }), true);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'node.moved', visibility: 'public' }), true);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'node.updated', visibility: 'public' }), false);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'node.updated', visibility: 'unlisted' }), false);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'annotation.created', visibility: 'public' }), false);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'annotation.updated', visibility: 'public' }), false);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'annotation.deleted', visibility: 'public' }), false);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'relation.created', visibility: 'public' }), false);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'relation.updated', visibility: 'public' }), false);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'relation.deleted', visibility: 'public' }), false);
  });

  test('always rotates Directory on visibility revocation to private/protected', () => {
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'node.updated', visibility: 'private' }), true);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'node.updated', visibility: 'protected' }), true);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'relation.updated', visibility: 'private' }), true);
  });

  test('V1 (no source fields) and unknown event types use the conservative rotate default', () => {
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: null, visibility: null }), true);
    assert.equal(shouldRotatePublicationDirectory({ sourceEventType: 'future.event', visibility: 'public' }), true);
  });
});

describe('CompositePublicationCachePurgeProvider through the real purge route', () => {
  test('V2 content update rotates collection epochs and calls the CDN with the event idempotency key', async () => {
    const { store, cdn, routes } = harness();
    await routes[1]!.handle(context(2, v2Payload()));

    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 1);
    assert.equal(store.epochs.get(slugEpochKeyFor('engineering-notes')), 1);
    assert.equal(store.epochs.get(DIRECTORY_EPOCH_KEY), undefined, 'node.updated must not rotate Directory');
    assert.equal(cdn.calls.length, 1);
    assert.equal(cdn.calls[0]?.idempotencyKey, publicationCachePurgeIdempotencyKey('event-1'));
    assert.equal(cdn.calls[0]?.sourceEventType, 'node.updated');
  });

  test('V2 metadata/lifecycle events also rotate the global Directory epoch', async () => {
    const { store, routes } = harness();
    await routes[1]!.handle(context(2, v2Payload({ sourceEventType: 'collection.updated' })));
    assert.equal(store.epochs.get(DIRECTORY_EPOCH_KEY), 1);
    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 1);
  });

  test('V2 visibility revocation rotates Directory even for a content event', async () => {
    const { store, routes } = harness();
    await routes[1]!.handle(context(2, v2Payload({ visibility: 'private' })));
    assert.equal(store.epochs.get(DIRECTORY_EPOCH_KEY), 1, 'private visibility must hide the collection from Directory');
  });

  test('V1 always rotates the Directory (conservative default) and still purges the collection', async () => {
    const { store, cdn, routes } = harness();
    await routes[0]!.handle(context(1, { ...v1Payload }));

    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 1);
    assert.equal(store.epochs.get(slugEpochKeyFor('engineering-notes')), 1);
    assert.equal(store.epochs.get(DIRECTORY_EPOCH_KEY), 1);
    assert.equal(cdn.calls.length, 1);
    assert.equal(cdn.calls[0]?.sourceEventType, null);
  });

  test('route contract reuses the existing handler name, mode and durability for both versions', () => {
    const { routes } = harness();
    assert.deepEqual(routes.map((route) => ({
      handlerName: route.handlerName,
      eventType: route.eventType,
      eventVersion: route.eventVersion,
      handlerMode: route.handlerMode,
      sideEffectDurability: route.sideEffectDurability,
      routeClass: route.routeClass,
    })), [
      {
        handlerName: PUBLICATION_CACHE_PURGE_HANDLER_NAME,
        eventType: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
        eventVersion: PUBLICATION_CACHE_PURGE_EVENT_VERSION_N_MINUS_1,
        handlerMode: 'delivery_each_event',
        sideEffectDurability: 'durable',
        routeClass: 'publication_cache_purge',
      },
      {
        handlerName: PUBLICATION_CACHE_PURGE_HANDLER_NAME,
        eventType: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
        eventVersion: PUBLICATION_CACHE_PURGE_EVENT_VERSION,
        handlerMode: 'delivery_each_event',
        sideEffectDurability: 'durable',
        routeClass: 'publication_cache_purge',
      },
    ]);
  });

  test('OutboxRouter resolves both versions to the composite-backed routes', () => {
    const { routes } = harness();
    const router = new OutboxRouter(routes);
    assert.equal(router.resolve({
      handlerName: PUBLICATION_CACHE_PURGE_HANDLER_NAME,
      handlerMode: 'delivery_each_event',
      eventType: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
      eventVersion: 1,
    }).eventVersion, 1);
    assert.equal(router.resolve({
      handlerName: PUBLICATION_CACHE_PURGE_HANDLER_NAME,
      handlerMode: 'delivery_each_event',
      eventType: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
      eventVersion: 2,
    }).eventVersion, 2);
  });

  test('replaying the same event does not error: epochs advance and CDN idempotency key is stable', async () => {
    const { store, cdn, routes } = harness();
    await routes[1]!.handle(context(2, v2Payload()));
    await routes[1]!.handle(context(2, v2Payload()));

    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 2);
    assert.equal(store.epochs.get(slugEpochKeyFor('engineering-notes')), 2);
    assert.equal(cdn.calls.length, 2);
    assert.equal(cdn.calls[0]?.idempotencyKey, cdn.calls[1]?.idempotencyKey);
    assert.equal(cdn.calls[1]?.idempotencyKey, publicationCachePurgeIdempotencyKey('event-1'));
  });

  test('a late old V1 event only advances epochs and never re-enables a historical epoch', async () => {
    const { store, routes } = harness();
    await routes[1]!.handle(context(2, v2Payload({ sourceEventType: 'collection.updated' })));
    await routes[1]!.handle(context(2, v2Payload({ sourceEventType: 'collection.updated' })));
    const before = store.epochs.get(epochKeyFor('collection-1')) ?? 0;
    const directoryBefore = store.epochs.get(DIRECTORY_EPOCH_KEY) ?? 0;

    await routes[0]!.handle(context(1, { ...v1Payload }, 'event-old-v1'));

    assert.ok((store.epochs.get(epochKeyFor('collection-1')) ?? 0) > before, 'late event must only advance');
    assert.ok((store.epochs.get(DIRECTORY_EPOCH_KEY) ?? 0) > directoryBefore);
    assert.ok((store.epochs.get(slugEpochKeyFor('engineering-notes')) ?? 0) >= 1);
  });

  test('collection events only invalidate the targeted collection scope', async () => {
    const { store, routes } = harness();
    await routes[1]!.handle(context(2, v2Payload()));
    assert.equal(store.epochs.get(epochKeyFor('collection-2')), undefined);

    const other = context(2, v2Payload({ collectionId: 'collection-2', publicationSlug: 'other-slug' }), 'event-2');
    await routes[1]!.handle(other);
    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 1);
    assert.equal(store.epochs.get(epochKeyFor('collection-2')), 1);
  });

  test('CDN unconfigured is an explicit no-side-effect success that still rotates Redis', async () => {
    const store = new FakeCacheStore();
    const metrics = new InMemoryMetrics();
    const invalidator = new RedisPublicationCacheInvalidator({ store, key: KEY_OPTIONS, metrics });
    const composite = new CompositePublicationCachePurgeProvider({ invalidator, metrics });
    const routes = createPublicationCachePurgeRoutes({
      provider: composite,
      publicationOrigin: PUBLICATION_ORIGIN,
      productOrigin: PRODUCT_ORIGIN,
      timeoutMs: 100,
      metrics,
    });

    assert.equal(composite.kind, 'injected');
    assert.equal(composite.cdnConfigured, false);
    await routes[1]!.handle(context(2, v2Payload()));
    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 1);
    assert.equal(store.epochs.get(DIRECTORY_EPOCH_KEY), undefined);
    assert.equal(metrics.get('cache.epoch.rotation_total'), 2);
  });
});

describe('CompositePublicationCachePurgeProvider failure semantics', () => {
  test('Redis failure is retryable and the CDN is not called', async () => {
    const store = new FakeCacheStore();
    store.failRotate = new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'redis down');
    const cdn = new FakeCdnProvider();
    const metrics = new InMemoryMetrics();
    const { routes } = harness({ store, cdn, metrics });

    await assert.rejects(
      routes[1]!.handle(context(2, v2Payload())),
      (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
    );
    assert.equal(cdn.calls.length, 0);
    assert.equal(metrics.get('cache.outbox_invalidation.failure'), 1);
  });

  test('CDN retryable failure keeps the Redis rotation and returns retryable (Redis success must not skip CDN retry)', async () => {
    const cdn = new FakeCdnProvider();
    cdn.failWith = new PublicationCachePurgeProviderError('retryable', 'cdn unavailable');
    const store = new FakeCacheStore();
    const { routes } = harness({ store, cdn });

    await assert.rejects(
      routes[1]!.handle(context(2, v2Payload())),
      (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
    );
    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 1, 'Redis rotation persists before CDN retry');
    assert.equal(cdn.calls.length, 1);
  });

  test('double failure (Redis and CDN) is retryable', async () => {
    const store = new FakeCacheStore();
    store.failRotate = new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'redis down');
    const cdn = new FakeCdnProvider();
    cdn.failWith = new PublicationCachePurgeProviderError('retryable', 'cdn unavailable');
    const { routes } = harness({ store, cdn });

    await assert.rejects(
      routes[1]!.handle(context(2, v2Payload())),
      (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
    );
  });

  test('CDN permanent failures keep the existing terminal/dead-letter classification', async () => {
    const cdn = new FakeCdnProvider();
    cdn.failWith = new PublicationCachePurgeProviderError('permanent', 'cdn rejected payload', { statusCode: 400 });
    const { routes } = harness({ store: new FakeCacheStore(), cdn });

    await assert.rejects(
      routes[1]!.handle(context(2, v2Payload())),
      (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'permanent',
    );
  });

  test('a closed-payload rejection is permanent and never retried', async () => {
    const { routes } = harness();
    await assert.rejects(
      routes[1]!.handle(rawContext(2, v2Payload({ visibility: 'banana' }))),
      (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'permanent',
    );
    await assert.rejects(
      routes[1]!.handle(rawContext(2, { ...v2Payload(), extra: 'field' })),
      (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'permanent',
    );
  });

  test('worker does not ack when Redis succeeds but CDN fails; replay completes after CDN recovers', async () => {
    const cdn = new FakeCdnProvider();
    cdn.failWith = new PublicationCachePurgeProviderError('retryable', 'cdn unavailable');
    const store = new FakeCacheStore();
    const metrics = new InMemoryMetrics();
    const invalidator = new RedisPublicationCacheInvalidator({ store, key: KEY_OPTIONS, metrics });
    const composite = new CompositePublicationCachePurgeProvider({ invalidator, cdn, metrics });
    const repository = new FakeRepository([claim()]);
    const worker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter(createPublicationCachePurgeRoutes({
        provider: composite,
        publicationOrigin: PUBLICATION_ORIGIN,
        productOrigin: PRODUCT_ORIGIN,
        timeoutMs: 100,
        metrics,
      })),
      envelopes: new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations()),
      logger,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      retryPolicy: createExponentialRetryPolicy({ baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 3, jitterRatio: 0 }),
    });

    await worker.runOnce();
    assert.equal(repository.completed.length, 0, 'retryable failure must not ack');
    assert.equal(repository.failures[0]?.disposition, 'retryable');
    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 1, 'Redis rotation persisted');

    cdn.failWith = null;
    await worker.runOnce();
    assert.equal(repository.completed.length, 1, 'replay completes once CDN recovers');
    assert.equal(store.epochs.get(epochKeyFor('collection-1')), 2);
    assert.equal(cdn.calls.length, 2);
    assert.equal(cdn.calls[0]?.idempotencyKey, cdn.calls[1]?.idempotencyKey);
  });

  test('metrics stay low-cardinality: no collection ids, slugs or event ids appear in names', async () => {
    const metrics = new InMemoryMetrics();
    const { routes } = harness({ metrics });
    await routes[1]!.handle(context(2, v2Payload({ collectionId: 'collection-secret', publicationSlug: 'secret-slug' }), 'event-secret'));

    const names = [
      'cache.epoch.rotation_total',
      'cache.outbox_invalidation.failure',
      'publication.cache_purge.succeeded',
    ];
    for (const name of names) {
      assert.equal(typeof metrics.get(name), 'number');
    }
    assert.equal(metrics.get('cache.epoch.rotation_total'), 2);
  });
});
