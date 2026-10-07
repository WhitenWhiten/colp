/**
 * T11 worker composition tests (plan §6.4 T11 / §7.1 / §7.2): prove that the
 * Worker owns its own Redis runtime and wires the T09 composite purge provider
 * into the `publication_cache_purge` route without changing the delivery
 * contract, and that shutdown releases the worker Redis client exactly once.
 *
 * Evidence style:
 * - mode=off never calls the Redis store factory and keeps the CDN purge route
 *   exactly as before (cache off is NOT "stop all publication purge").
 * - mode=shadow|serve create exactly one process-local worker store and a
 *   CompositePublicationCachePurgeProvider (Redis invalidator + existing CDN).
 * - The composed provider is injected into the real route factory, so handler
 *   name / mode / durability / event version / retry contract stay unchanged
 *   and delivery provably calls BOTH rotateEpoch and the CDN purge.
 * - Partial success stays retryable in both directions (Redis success cannot
 *   swallow a CDN failure and a CDN success cannot swallow a Redis failure).
 * - Worker stop stops the outbox (stop claiming + bounded in-flight drain)
 *   before closing the Redis client; repeated stop/close is idempotent.
 * - Composition never falls back to an in-memory completion of production
 *   routes: with no database there is no outbox/sink, with a database the sink
 *   is the durable PostgreSQL sink, and delivery calls the injected fakes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import {
  buildWorker,
  createWorkerCacheComposition,
  resolvePublicationCachePurgeReadinessState,
} from '../../../src/bootstrap/worker.js';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { EventEnvelopeRegistry } from '../../../src/infrastructure/outbox/envelope.js';
import {
  CompositePublicationCachePurgeProvider,
  FetchPublicationCachePurgeProvider,
  OutboxDeliveryError,
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION_N_MINUS_1,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
  PublicationCachePurgeProviderError,
  createPublicationCachePurgeRoutes,
  publicationCachePurgeEnvelopeRegistrations,
  type OutboxHandlerContext,
  type PublicationCachePurgeProvider,
  type PublicationCachePurgeRequest,
} from '../../../src/infrastructure/outbox/index.js';
import { InMemoryMetrics, type Metrics } from '../../../src/infrastructure/telemetry/index.js';
import { RecordingCacheStore } from '../../support/recording-cache-store.js';

const REDIS_URL = 'redis://127.0.0.1:6379/0';

const v2Payload = {
  collectionId: 'collection-1',
  contentRevision: 'content-7',
  policyRevision: 'policy-4',
  publicationSlug: 'engineering-notes',
  sourceEventType: 'node.updated',
  sourceEventVersion: 1,
  visibility: 'public',
} as const;

function purgeEnvelope(version: 1 | 2, eventId: string) {
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
    payload: version === 1
      ? { collectionId: 'collection-1', publicationSlug: 'engineering-notes' }
      : v2Payload,
  } as const;
}

function purgeContext(version: 1 | 2, eventId = 'event-1'): OutboxHandlerContext {
  const registry = new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations());
  return {
    envelope: registry.validate(purgeEnvelope(version, eventId)),
    idempotencyKey: eventId,
    signal: new AbortController().signal,
  };
}

function purgeRoutes(provider: PublicationCachePurgeProvider, metrics?: Metrics) {
  return createPublicationCachePurgeRoutes({
    provider,
    publicationOrigin: 'https://collections.example.test',
    productOrigin: 'https://app.example.test',
    timeoutMs: 100,
    metrics,
  });
}

function database(config: AppConfig): DatabaseRuntime {
  return {
    pool: { options: { max: config.database.maxConnections } },
    db: {},
    async verifyReady() {},
    async close() {},
  } as unknown as DatabaseRuntime;
}

function workerConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: 'https://app.example.test',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    ...overrides,
  });
}

describe('T11 worker cache composition: mode=off', () => {
  test('never creates a Redis store and preserves the existing CDN purge route', async () => {
    const config = workerConfig({ KNOWN_CACHE_MODE: 'off' });
    const metrics = new InMemoryMetrics();
    const cdnPurges: PublicationCachePurgeRequest[] = [];
    const cdn: PublicationCachePurgeProvider = {
      async purge(request) { cdnPurges.push(request); },
    };
    const createStore = vi.fn(() => new RecordingCacheStore());
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: createStore,
      publicationCachePurgeProvider: cdn,
    });

    assert.equal(createStore.mock.calls.length, 0, 'mode=off must never create a Redis store');
    assert.equal(worker.publicationCachePurgeProvider, cdn, 'mode=off keeps the CDN provider unwrapped');
    assert.equal(resolvePublicationCachePurgeReadinessState(worker.publicationCachePurgeProvider), 'durable');
    assert.deepEqual(worker.outbox?.projectionReadiness().publicationCachePurge, {
      configured: true,
      routeCount: 6,
      durableCount: 6,
      allDurable: true,
      state: 'durable',
    });

    // The CDN purge route still runs: disabling the cache must NOT disable purge.
    const route = purgeRoutes(worker.publicationCachePurgeProvider!, metrics)[1]!;
    await route.handle(purgeContext(2, 'event-off-mode'));
    assert.equal(cdnPurges.length, 1, 'cache off must not stop publication purge');
    assert.equal(cdnPurges[0]?.eventId, 'event-off-mode');
    assert.equal(metrics.get('publication.cache_purge.succeeded'), 1);
    await worker.stop();
  });

  test('with a configured CDN endpoint keeps the fetch provider unwrapped', () => {
    const config = workerConfig({
      KNOWN_CACHE_MODE: 'off',
      PUBLICATION_CACHE_PURGE_ENDPOINT: 'https://purge.example.test/v1/cache',
    });
    const createStore = vi.fn(() => new RecordingCacheStore());
    const worker = buildWorker(config, database(config), new InMemoryMetrics(), {
      createCacheStore: createStore,
    });
    assert.equal(createStore.mock.calls.length, 0);
    assert.ok(worker.publicationCachePurgeProvider instanceof FetchPublicationCachePurgeProvider);
    assert.equal(resolvePublicationCachePurgeReadinessState(worker.publicationCachePurgeProvider), 'durable');
    assert.equal(worker.outbox?.projectionReadiness().publicationCachePurge.state, 'durable');
    void worker.stop();
  });

  test('resolvePublicationCachePurgeProvider wires hardened egress fetch', () => {
    const workerSource = readFileSync(resolve(import.meta.dirname, '../../../src/bootstrap/worker.ts'), 'utf8');
    const compositionSource = readFileSync(resolve(
      import.meta.dirname, '../../../src/bootstrap/publication-cache-purge-composition.ts'), 'utf8');
    assert.match(workerSource, /resolvePublicationCachePurgeProvider/);
    assert.match(compositionSource, /createHardenedEgressFetch/);
    assert.match(compositionSource, /publication cache purge/);
  });
});

describe('T11 worker cache composition: shadow/serve composite route', () => {
  test.each(['shadow', 'serve'] as const)('mode=%s wires the composite provider with unchanged contract', async (mode) => {
    const config = workerConfig({
      KNOWN_CACHE_MODE: mode,
      REDIS_URL,
      KNOWN_CACHE_REQUIRED: 'false',
    });
    const store = new RecordingCacheStore();
    const createStore = vi.fn(() => store);
    const metrics = new InMemoryMetrics();
    const cdnPurges: PublicationCachePurgeRequest[] = [];
    const cdn: PublicationCachePurgeProvider = {
      async purge(request) { cdnPurges.push(request); },
    };
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: createStore,
      publicationCachePurgeProvider: cdn,
    });

    assert.equal(createStore.mock.calls.length, 1, `${mode} must create exactly one worker Redis store`);
    assert.ok(worker.publicationCachePurgeProvider instanceof CompositePublicationCachePurgeProvider);
    const composite = worker.publicationCachePurgeProvider as CompositePublicationCachePurgeProvider;
    assert.equal(composite.cdnConfigured, true, 'the existing CDN provider must be the composite cdn arm');
    assert.equal(resolvePublicationCachePurgeReadinessState(composite), 'durable');
    assert.deepEqual(worker.outbox?.projectionReadiness().publicationCachePurge, {
      configured: true,
      routeCount: 6,
      durableCount: 6,
      allDurable: true,
      state: 'durable',
    });

    // Route contract unchanged: two versions, stable handler/mode/durability.
    const routes = purgeRoutes(composite, metrics);
    assert.deepEqual(routes.map((route) => route.eventVersion), [
      PUBLICATION_CACHE_PURGE_EVENT_VERSION_N_MINUS_1,
      PUBLICATION_CACHE_PURGE_EVENT_VERSION,
    ]);
    assert.ok(routes.every((route) => route.handlerName === PUBLICATION_CACHE_PURGE_HANDLER_NAME));
    assert.ok(routes.every((route) => route.handlerMode === 'delivery_each_event'));
    assert.ok(routes.every((route) => route.sideEffectDurability === 'durable'));
    assert.ok(routes.every((route) => route.routeClass === 'publication_cache_purge'));

    // Delivery triggers BOTH arms: Redis epoch rotation and the CDN purge.
    await routes[1]!.handle(purgeContext(2, 'event-composed'));
    assert.ok(store.callsOf('rotateEpoch').length >= 1, 'delivery must rotate Redis epochs');
    assert.equal(cdnPurges.length, 1, 'delivery must still purge the CDN');
    assert.equal(metrics.get('publication.cache_purge.succeeded'), 1);
    await worker.stop();
  });

  test('mode=serve without a CDN is Redis-only and still delivers (no-side-effect success)', async () => {
    const config = workerConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      NODE_ENV: 'development',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: () => store,
    });
    assert.ok(worker.publicationCachePurgeProvider instanceof CompositePublicationCachePurgeProvider);
    const composite = worker.publicationCachePurgeProvider as CompositePublicationCachePurgeProvider;
    assert.equal(composite.cdnConfigured, false, 'no CDN provider means Redis-only');
    assert.equal(resolvePublicationCachePurgeReadinessState(composite), 'durable');
    await purgeRoutes(composite, metrics)[1]!.handle(purgeContext(2, 'event-redis-only'));
    assert.ok(store.callsOf('rotateEpoch').length >= 1, 'Redis-only delivery still rotates epochs');
    assert.equal(metrics.get('publication.cache_purge.succeeded'), 1);
    await worker.stop();
  });
});

describe('T11 worker cache composition: partial success keeps Outbox retry semantics', () => {
  test('Redis success cannot swallow a CDN failure (delivery stays retryable)', async () => {
    const config = workerConfig({ KNOWN_CACHE_MODE: 'serve', REDIS_URL });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const cdn: PublicationCachePurgeProvider = {
      async purge() {
        throw new PublicationCachePurgeProviderError('retryable', 'cdn unavailable');
      },
    };
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: () => store,
      publicationCachePurgeProvider: cdn,
    });
    const route = purgeRoutes(worker.publicationCachePurgeProvider!, metrics)[1]!;
    await assert.rejects(
      route.handle(purgeContext(2, 'event-cdn-down')),
      (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
    );
    assert.ok(store.callsOf('rotateEpoch').length >= 1, 'Redis epoch rotation ran before the CDN failure');
    assert.equal(metrics.get('publication.cache_purge.retryable_failure'), 1);
    assert.equal(metrics.get('publication.cache_purge.succeeded'), 0, 'the delivery must not ack');
    await worker.stop();
  });

  test('CDN success cannot swallow a Redis failure (delivery stays retryable)', async () => {
    const config = workerConfig({ KNOWN_CACHE_MODE: 'serve', REDIS_URL });
    const store = new RecordingCacheStore({ failCommands: true });
    const metrics = new InMemoryMetrics();
    const cdnPurges: PublicationCachePurgeRequest[] = [];
    const cdn: PublicationCachePurgeProvider = {
      async purge(request) { cdnPurges.push(request); },
    };
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: () => store,
      publicationCachePurgeProvider: cdn,
    });
    const route = purgeRoutes(worker.publicationCachePurgeProvider!, metrics)[1]!;
    await assert.rejects(
      route.handle(purgeContext(2, 'event-redis-down')),
      (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
    );
    assert.equal(cdnPurges.length, 0, 'the CDN arm must not be credited when Redis already failed');
    assert.equal(metrics.get('publication.cache_purge.retryable_failure'), 1);
    assert.equal(metrics.get('publication.cache_purge.succeeded'), 0, 'the delivery must not ack');
    await worker.stop();
  });
});

describe('T11 worker cache composition: lifecycle and fake injection', () => {
  test('worker stop stops the outbox first and releases its Redis client once (repeat close safe)', async () => {
    const config = workerConfig({ KNOWN_CACHE_MODE: 'serve', REDIS_URL });
    const store = new RecordingCacheStore();
    const worker = buildWorker(config, database(config), new InMemoryMetrics(), {
      createCacheStore: () => store,
    });
    const outboxStop = vi.spyOn(worker.outbox!, 'stop');
    const storeClose = vi.spyOn(store, 'close');

    await worker.stop();
    assert.equal(store.closeCalls, 1, 'worker shutdown must release its Redis client once');
    assert.equal(outboxStop.mock.calls.length, 1);
    assert.ok(
      (outboxStop.mock.invocationCallOrder[0] ?? 0) < (storeClose.mock.invocationCallOrder[0] ?? 0),
      'outbox must stop (stop claiming + bounded in-flight drain) before the Redis client closes',
    );

    await worker.stop();
    assert.equal(store.closeCalls, 1, 'repeat stop must not close the Redis client again');
    assert.equal(storeClose.mock.calls.length, 1, 'repeat close is idempotent and never throws');
  });

  test('worker stop closes the database after a cache close failure and reports the failure', async () => {
    const config = workerConfig({ KNOWN_CACHE_MODE: 'serve', REDIS_URL });
    const store = new RecordingCacheStore();
    vi.spyOn(store, 'close').mockRejectedValue(new Error('cache close failed'));
    const runtimeDatabase = database(config);
    const databaseClose = vi.spyOn(runtimeDatabase, 'close');
    const worker = buildWorker(config, runtimeDatabase, new InMemoryMetrics(), {
      createCacheStore: () => store,
    });

    await assert.rejects(
      worker.stop(),
      (error: unknown) => error instanceof AggregateError
        && error.errors.length === 1
        && /workerCacheComposition/u.test(error.message),
    );
    assert.equal(databaseClose.mock.calls.length, 1, 'database close must survive an earlier cache failure');
  });

  test('composition never falls back to an in-memory sink; delivery calls the injected fakes', async () => {
    const config = workerConfig({ KNOWN_CACHE_MODE: 'serve', REDIS_URL });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const cdnPurges: PublicationCachePurgeRequest[] = [];
    const cdn: PublicationCachePurgeProvider = {
      async purge(request) { cdnPurges.push(request); },
    };

    // Without a database there is no outbox and no projection sink at all.
    const workerWithoutDb = buildWorker(config, undefined, metrics, {
      createCacheStore: () => store,
      publicationCachePurgeProvider: cdn,
    });
    assert.equal(workerWithoutDb.outbox, undefined);
    assert.equal(workerWithoutDb.projectionSink, undefined);

    // With a database the projection sink is the durable PostgreSQL sink — never memory.
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: () => store,
      publicationCachePurgeProvider: cdn,
    });
    assert.equal(worker.projectionSink?.durability, 'durable');
    assert.equal(worker.outbox?.projectionReadiness().acknowledgesTransientSideEffects, false);

    // The composed purge route really calls the injected fake store and CDN.
    await purgeRoutes(worker.publicationCachePurgeProvider!, metrics)[1]!.handle(purgeContext(2, 'event-fake'));
    assert.ok(store.callsOf('rotateEpoch').length >= 1, 'the fake store recorded the Redis epoch rotation');
    assert.equal(cdnPurges.length, 1, 'the fake CDN recorded the purge');
    await worker.stop();
    await workerWithoutDb.stop();
  });

  test('createWorkerCacheComposition(mode=off) is a no-op that never builds a store', async () => {
    const config = workerConfig({ KNOWN_CACHE_MODE: 'off' });
    const createStore = vi.fn(() => new RecordingCacheStore());
    const composition = createWorkerCacheComposition({
      config: config.cache,
      createStore,
    });
    assert.equal(createStore.mock.calls.length, 0);
    assert.equal(composition.publicationCachePurgeProvider, undefined);
    assert.equal(composition.store, undefined);
    assert.equal(await composition.readiness(), 'disabled');
    await composition.close();
    assert.equal(createStore.mock.calls.length, 0);
  });
});
