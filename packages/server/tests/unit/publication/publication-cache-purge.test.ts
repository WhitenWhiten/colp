import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker, resolvePublicationCachePurgeProvider, resolvePublicationCachePurgeReadinessState } from '../../../src/bootstrap/worker.js';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { InMemoryMetrics, type Metrics } from '../../../src/infrastructure/telemetry/index.js';
import { EventEnvelopeRegistry, InvalidEventEnvelopeError } from '../../../src/infrastructure/outbox/envelope.js';
import {
  OutboxDeliveryError,
  OutboxRouter,
  type OutboxHandlerContext,
} from '../../../src/infrastructure/outbox/router.js';
import {
  FetchPublicationCachePurgeProvider,
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION_N_MINUS_1,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
  PublicationCachePurgeProviderError,
  createNoopPublicationCachePurgeProvider,
  createPublicationCachePurgeRoutes,
  publicationCachePurgeEnvelopeRegistrations,
  publicationCachePurgeIdempotencyKey,
  type PublicationCachePurgeProvider,
  type PublicationCachePurgeRequest,
} from '../../../src/infrastructure/outbox/publication-cache-purge.js';
import { VersionedOutboxWorker, createExponentialRetryPolicy } from '../../../src/infrastructure/outbox/worker.js';
import {
  createCollectionMutationEnvelopeRegistry,
  createCollectionMutationEnvelopeRegistryNMinus1,
} from '../../../src/infrastructure/outbox/collection-mutation-events.js';
import type {
  FailureDisposition,
  OutboxClaim,
  OutboxRepository,
} from '../../../src/infrastructure/outbox/repository.js';

const v1Payload = {
  collectionId: 'collection-1',
  publicationSlug: 'engineering-notes',
} as const;

const v2Payload = {
  collectionId: 'collection-1',
  contentRevision: 'content-7',
  policyRevision: 'policy-4',
  publicationSlug: 'engineering-notes',
  sourceEventType: 'node.updated',
  sourceEventVersion: 1,
  visibility: 'public',
} as const;

function envelope(version: 1 | 2, eventId = 'event-1') {
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
    payload: version === 1 ? v1Payload : v2Payload,
  } as const;
}

function context(version: 1 | 2, eventId = 'event-1'): OutboxHandlerContext {
  const registry = new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations());
  return {
    envelope: registry.validate(envelope(version, eventId)),
    idempotencyKey: eventId,
    signal: new AbortController().signal,
  };
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
    payload: v2Payload,
    attemptCount: 1,
    leaseGeneration: '1',
    ...overrides,
  };
}

class FakeRepository implements OutboxRepository {
  readonly failures: Array<{
    readonly claim: OutboxClaim;
    readonly retryDelayMs: number;
    readonly maxAttempts: number;
    readonly disposition: FailureDisposition;
  }> = [];
  readonly completed: OutboxClaim[] = [];
  lockHeld = false;

  constructor(readonly claims: OutboxClaim[]) {}

  async claim(): Promise<OutboxClaim | null> {
    this.lockHeld = true;
    const claimed = this.claims.shift() ?? null;
    this.lockHeld = false;
    return claimed;
  }

  async inspectBacklog() { return { count: this.claims.length, oldestAgeMs: 500 }; }
  async heartbeat() { return true; }
  async isObsoleteProjection() { return false; }
  async hasDeliveryReceipt() { return false; }

  async complete(seen: OutboxClaim): Promise<boolean> {
    this.completed.push(seen);
    return true;
  }

  async continue(_seen: OutboxClaim): Promise<boolean> {
    return true;
  }

  async fail(
    seen: OutboxClaim,
    _error: string,
    retryDelayMs: number,
    maxAttempts: number,
  ): Promise<FailureDisposition> {
    const disposition = seen.attemptCount >= maxAttempts ? 'dead_letter' : 'retryable';
    this.failures.push({ claim: seen, retryDelayMs, maxAttempts, disposition });
    return disposition;
  }
}

class TrackingMetrics implements Metrics {
  readonly names = new Set<string>();
  private readonly metrics = new InMemoryMetrics();

  increment(name: string, value?: number): void {
    this.names.add(name);
    this.metrics.increment(name, value);
  }

  gauge(name: string, value: number): void {
    this.names.add(name);
    this.metrics.gauge(name, value);
  }

  observe(name: string, value: number): void {
    this.names.add(name);
    this.metrics.observe(name, value);
  }

  get(name: string): number { return this.metrics.get(name); }
  observations(name: string): readonly number[] { return this.metrics.observations(name); }
}

const logger = { info() {}, warn() {}, error() {} };

function routes(provider: PublicationCachePurgeProvider, metrics?: Metrics) {
  return createPublicationCachePurgeRoutes({
    provider,
    publicationOrigin: 'https://collections.example.test',
    productOrigin: 'https://app.example.test',
    timeoutMs: 100,
    metrics,
    resolvePublicProfileHandle: async (collectionId) => collectionId === 'collection-1' ? 'ada_curator' : null,
    isCanonicalPublicProfileHandle: (value) => /^[a-z0-9._~-]{1,64}$/u.test(value),
  });
}

describe('publication cache purge versioned contract', () => {
  test('accepts N and N-1 as distinct closed payloads and routes both versions', () => {
    const registry = new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations());
    assert.deepEqual(registry.validate(envelope(1)).payload, v1Payload);
    assert.deepEqual(registry.validate(envelope(2)).payload, v2Payload);
    assert.throws(
      () => registry.validate({
        ...envelope(1),
        payload: { ...v1Payload, visibility: 'public' },
      }),
      InvalidEventEnvelopeError,
    );
    assert.throws(
      () => registry.validate({ ...envelope(2), event_version: 3 }),
      /unsupported outbox event/u,
    );

    const configured = routes({ async purge() {} });
    assert.deepEqual(configured.map((route) => route.eventVersion), [
      PUBLICATION_CACHE_PURGE_EVENT_VERSION_N_MINUS_1,
      PUBLICATION_CACHE_PURGE_EVENT_VERSION,
    ]);
    assert.ok(configured.every((route) => route.handlerMode === 'delivery_each_event'));
    assert.ok(configured.every((route) => route.sideEffectDurability === 'durable'));

    assert.deepEqual(createCollectionMutationEnvelopeRegistry().validate(envelope(2)).payload, v2Payload);
    assert.deepEqual(
      createCollectionMutationEnvelopeRegistryNMinus1().validate(envelope(1)).payload,
      v1Payload,
    );
    assert.throws(
      () => createCollectionMutationEnvelopeRegistryNMinus1().validate(envelope(2)),
      /unsupported outbox event/u,
    );
  });

  test('accepts protected visibility because member authorization changes also invalidate public caches', () => {
    const registry = new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations());
    assert.equal(registry.validate({
      ...envelope(2),
      payload: { ...v2Payload, visibility: 'protected' },
    }).payload.visibility, 'protected');
  });

  test('derives stable event-scoped idempotency and exact public cache targets', async () => {
    const requests: PublicationCachePurgeRequest[] = [];
    const effects = new Set<string>();
    const provider: PublicationCachePurgeProvider = {
      async purge(request) {
        requests.push(request);
        effects.add(request.idempotencyKey);
      },
    };
    const route = routes(provider)[1]!;

    await route.handle(context(2));
    await route.handle(context(2));

    assert.equal(requests.length, 2, 'redelivery may call the provider again');
    assert.equal(effects.size, 1, 'provider receives one stable idempotency identity');
    assert.equal(requests[0]?.idempotencyKey, publicationCachePurgeIdempotencyKey('event-1'));
    assert.equal(requests[1]?.idempotencyKey, requests[0]?.idempotencyKey);
    assert.notEqual(
      publicationCachePurgeIdempotencyKey('event-1'),
      publicationCachePurgeIdempotencyKey('event-2'),
    );
    assert.deepEqual(requests[0]?.urls, [
      'https://collections.example.test/colp/v0.1/directory',
      'https://collections.example.test/colp/v0.1/collections/collection-1',
      'https://collections.example.test/colp/v0.1/collections/collection-1/snapshot',
      'https://app.example.test/api/v1/collections/engineering-notes',
      'https://app.example.test/c/engineering-notes',
      'https://app.example.test/share/engineering-notes',
      'https://app.example.test/path/engineering-notes',
      'https://app.example.test/graph/engineering-notes',
      'https://app.example.test/u/ada_curator',
      'https://app.example.test/explore',
      'https://app.example.test/sitemap-collections.xml',
      'https://app.example.test/sitemap-profiles.xml',
    ]);
    assert.ok(requests[0]?.urls.every((url) => !url.includes('/api/v1/search')),
      'Search has no purge channel; its anonymous revocation window is bounded by max-age + must-revalidate');
    assert.deepEqual(requests[0]?.surrogateKeys, [
      'known-publication-directory',
      'known-publication-collection-collection-1',
      'known-publication-slug-engineering-notes',
    ]);
    assert.equal(requests[0]?.sourceEventType, 'node.updated');
    assert.equal(requests[0]?.visibility, 'public');
  });

  test('maps the N-1 payload without inventing unavailable revision facts', async () => {
    let request: PublicationCachePurgeRequest | undefined;
    await routes({ async purge(seen) { request = seen; } })[0]!.handle(context(1));
    assert.equal(request?.collectionId, 'collection-1');
    assert.equal(request?.publicationSlug, 'engineering-notes');
    assert.equal(request?.contentRevision, null);
    assert.equal(request?.policyRevision, null);
    assert.equal(request?.sourceEventType, null);
    assert.equal(request?.sourceEventVersion, null);
    assert.equal(request?.visibility, null);
  });

  test('omits a profile purge target when the owner has no canonical public handle', async () => {
    let request: PublicationCachePurgeRequest | undefined;
    const configured = createPublicationCachePurgeRoutes({
      provider: { async purge(seen) { request = seen; } },
      publicationOrigin: 'https://collections.example.test',
      productOrigin: 'https://app.example.test',
      timeoutMs: 100,
      resolvePublicProfileHandle: async () => '\"><script>',
      isCanonicalPublicProfileHandle: (value) => /^[a-z0-9._~-]{1,64}$/u.test(value),
    });
    await configured[1]!.handle(context(2));
    assert.ok(request?.urls.every((url) => !url.includes('/u/')));
  });
});

describe('publication cache purge configuration and readiness', () => {
  test('validates a vendor-neutral HTTPS endpoint and bounded timeout', () => {
    const configured = loadConfig({
      DATABASE_URL: 'postgres://unused/known',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      PUBLICATION_CACHE_PURGE_ENDPOINT: 'https://purge.example.test/v1/cache',
      PUBLICATION_CACHE_PURGE_BEARER_TOKEN: 'purge-token',
      PUBLICATION_CACHE_PURGE_TIMEOUT_MS: '2500',
    });
    assert.deepEqual(configured.publication.cachePurge, {
      endpoint: 'https://purge.example.test/v1/cache',
      bearerToken: 'purge-token',
      timeoutMs: 2_500,
    });

    for (const endpoint of [
      '/relative',
      'https://user:password@purge.example.test/v1/cache',
      'https://purge.example.test/v1/cache#fragment',
      'http://purge.example.test/v1/cache',
    ]) {
      assert.throws(() => loadConfig({
        DATABASE_URL: 'postgres://unused/known',
        OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
        PUBLICATION_CACHE_PURGE_ENDPOINT: endpoint,
      }), /PUBLICATION_CACHE_PURGE_ENDPOINT/u);
    }
    assert.throws(() => loadConfig({
      DATABASE_URL: 'postgres://unused/known',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      PUBLICATION_CACHE_PURGE_ENDPOINT: 'https://purge.example.test/v1/cache',
      PUBLICATION_CACHE_PURGE_TIMEOUT_MS: '0',
    }), /PUBLICATION_CACHE_PURGE_TIMEOUT_MS/u);

    const loopback = loadConfig({
      DATABASE_URL: 'postgres://unused/known',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      PUBLICATION_CACHE_PURGE_ENDPOINT: 'http://127.0.0.1:9999/purge',
    });
    assert.equal(loopback.publication.cachePurge?.endpoint, 'http://127.0.0.1:9999/purge');
  });

  test('production readiness fails closed without purge and exposes the durable purge routes (2 versioned + 4 governance) when wired', async () => {
    const base = loadConfig({ DATABASE_URL: 'postgres://unused/known', LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' });
    const config = Object.freeze({ ...base, nodeEnv: 'production' });
    const database = {
      pool: { options: { max: config.database.maxConnections } },
      db: {},
      async verifyReady() {},
      async close() {},
    } as unknown as DatabaseRuntime;

    const missing = buildWorker(config, database);
    await assert.rejects(
      missing.start(),
      /publicationCachePurgeConfigured=false/u,
    );
    assert.deepEqual(missing.outbox?.projectionReadiness().publicationCachePurge, {
      configured: false,
      routeCount: 0,
      durableCount: 0,
      allDurable: false,
      state: 'missing',
    });
    await missing.stop();

    const configured = buildWorker(config, database, new InMemoryMetrics(), {
      publicationCachePurgeProvider: { async purge() {} },
    });
    assert.deepEqual(configured.outbox?.projectionReadiness().publicationCachePurge, {
      configured: true,
      routeCount: 6,
      durableCount: 6,
      allDurable: true,
      state: 'durable',
    });
  });

  test('test-mode no-op purge stub is reported honestly as stubbed and never durable', () => {
    const base = loadConfig({ DATABASE_URL: 'postgres://unused/known', LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' });
    const config = Object.freeze({ ...base, nodeEnv: 'test' as const });
    const database = {
      pool: { options: { max: config.database.maxConnections } },
      db: {},
      async verifyReady() {},
      async close() {},
    } as unknown as DatabaseRuntime;

    const worker = buildWorker(config, database);
    // The no-op stub completes purge events without any external cache invalidation, so
    // it must never be reported as durable even though the routes are declared durable.
    assert.deepEqual(worker.outbox?.projectionReadiness().publicationCachePurge, {
      configured: true,
      routeCount: 6,
      durableCount: 6,
      allDurable: false,
      state: 'stubbed',
    });
  });

  test('a configured fetch purge provider reports durable with purge routes present', () => {
    const base = loadConfig({
      DATABASE_URL: 'postgres://unused/known',
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      PUBLICATION_CACHE_PURGE_ENDPOINT: 'https://purge.example.test/v1/cache',
    });
    const config = Object.freeze({ ...base, nodeEnv: 'test' as const });
    const database = {
      pool: { options: { max: config.database.maxConnections } },
      db: {},
      async verifyReady() {},
      async close() {},
    } as unknown as DatabaseRuntime;

    const worker = buildWorker(config, database);
    assert.deepEqual(worker.outbox?.projectionReadiness().publicationCachePurge, {
      configured: true,
      routeCount: 6,
      durableCount: 6,
      allDurable: true,
      state: 'durable',
    });
  });
});

describe('publication cache purge provider classification', () => {
  test.each([
    [429, 'retryable'],
    [503, 'retryable'],
    [400, 'permanent'],
  ] as const)('classifies HTTP %s as %s', async (status, failureKind) => {
    const provider = new FetchPublicationCachePurgeProvider({
      endpoint: 'https://purge-gateway.example.test/v1/purge',
      fetch: (async () => new Response(null, { status })) as typeof fetch,
    });
    await assert.rejects(
      provider.purge({
        eventId: 'event-1',
        idempotencyKey: 'idempotency-1',
        collectionId: 'collection-1',
        publicationSlug: 'engineering-notes',
        visibility: 'public',
        contentRevision: 'content-7',
        policyRevision: 'policy-4',
        sourceEventType: 'node.updated',
        sourceEventVersion: 1,
        urls: [],
        surrogateKeys: [],
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof PublicationCachePurgeProviderError
        && error.failureKind === failureKind
        && error.statusCode === status,
    );
  });

  test('treats provider network errors and the bounded route timeout as retryable', async () => {
    const networkProvider = new FetchPublicationCachePurgeProvider({
      endpoint: 'https://purge-gateway.example.test/v1/purge',
      fetch: (async () => { throw new Error('socket closed'); }) as typeof fetch,
    });
    await assert.rejects(
      networkProvider.purge({
        eventId: 'event-network', idempotencyKey: 'network-key',
        collectionId: 'collection-1', publicationSlug: 'engineering-notes',
        visibility: null, contentRevision: null, policyRevision: null,
        sourceEventType: null, sourceEventVersion: null,
        urls: [], surrogateKeys: [], signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof PublicationCachePurgeProviderError
        && error.failureKind === 'retryable',
    );

    let timedOut = false;
    const route = createPublicationCachePurgeRoutes({
      provider: {
        async purge(request) {
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => {
              timedOut = true;
              reject(request.signal.reason);
            }, { once: true });
          });
        },
      },
      publicationOrigin: 'https://collections.example.test',
      productOrigin: 'https://app.example.test',
      timeoutMs: 5,
    })[1]!;
    await assert.rejects(
      route.handle(context(2, 'event-timeout')),
      (error: unknown) => error instanceof OutboxDeliveryError
        && error.failureKind === 'retryable',
    );
    assert.equal(timedOut, true);
  });
});

describe('publication cache purge worker observability and recovery', () => {
  test('readiness distinguishes an absent purge route from two durable version routes', () => {
    const absent = new VersionedOutboxWorker({
      repository: new FakeRepository([]),
      router: new OutboxRouter([]),
      envelopes: new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations()),
      logger,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
    });
    assert.deepEqual(absent.projectionReadiness().publicationCachePurge, {
      configured: false,
      routeCount: 0,
      durableCount: 0,
      allDurable: false,
      state: 'missing',
    });
  });

  test('retries transient failures, dead-letters permanent failures, and emits low-cardinality metrics', async () => {
    const repository = new FakeRepository([
      claim({ outboxId: 'outbox-retry', eventId: 'event-retry' }),
      claim({ outboxId: 'outbox-permanent', eventId: 'event-permanent' }),
    ]);
    const metrics = new TrackingMetrics();
    const provider: PublicationCachePurgeProvider = {
      async purge(request) {
        assert.equal(repository.lockHeld, false, 'provider network I/O must follow claim commit');
        throw new PublicationCachePurgeProviderError(
          request.eventId === 'event-permanent' ? 'permanent' : 'retryable',
          'provider rejected purge',
        );
      },
    };
    const worker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter(routes(provider, metrics)),
      envelopes: new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations()),
      logger,
      metrics,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      handlerTimeoutMs: 500,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 25, maxDelayMs: 25, maxAttempts: 3, jitterRatio: 0,
      }),
    });

    await worker.runOnce();
    await worker.runOnce();

    assert.deepEqual(repository.failures.map((failure) => ({
      eventId: failure.claim.eventId,
      maxAttempts: failure.maxAttempts,
      disposition: failure.disposition,
    })), [
      { eventId: 'event-retry', maxAttempts: 3, disposition: 'retryable' },
      { eventId: 'event-permanent', maxAttempts: 1, disposition: 'dead_letter' },
    ]);
    assert.equal(metrics.observations('publication.cache_purge.queue_age_ms').length, 2);
    assert.deepEqual(metrics.observations('publication.cache_purge.attempt'), [1, 1]);
    assert.equal(metrics.observations('publication.cache_purge.latency_ms').length, 2);
    assert.equal(metrics.get('publication.cache_purge.retryable_failure'), 1);
    assert.equal(metrics.get('publication.cache_purge.permanent_failure'), 1);
    assert.equal(metrics.get('publication.cache_purge.dead_letter'), 1);
    assert.equal(metrics.get('publication.cache_purge.route_configured'), 1);
    assert.equal(metrics.get('publication.cache_purge.route_durable'), 1);
    // This worker is built from the versioned purge pair only (no governance
    // routes are composed here), so it exposes exactly 2 durable routes.
    assert.deepEqual(worker.projectionReadiness().publicationCachePurge, {
      configured: true,
      routeCount: 2,
      durableCount: 2,
      allDurable: true,
      state: 'durable',
    });
    for (const name of metrics.names) {
      assert.doesNotMatch(name, /(event-retry|event-permanent|collection-1|429|503)/u);
    }
  });

  test('keeps a committed authoritative mutation intact when purge delivery fails', async () => {
    const authoritative = { visibility: 'private', policyRevision: 'policy-5', committed: true };
    const repository = new FakeRepository([claim({ eventId: 'event-withdraw' })]);
    const worker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter(routes({
        async purge() {
          assert.equal(repository.lockHeld, false);
          throw new PublicationCachePurgeProviderError('retryable', 'cdn unavailable');
        },
      })),
      envelopes: new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations()),
      logger,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 3, jitterRatio: 0,
      }),
    });

    await worker.runOnce();
    assert.deepEqual(authoritative, {
      visibility: 'private', policyRevision: 'policy-5', committed: true,
    });
    assert.equal(repository.completed.length, 0);
    assert.equal(repository.failures[0]?.disposition, 'retryable');
  });
});

describe('publication cache purge provider readiness classification', () => {
  test('resolvePublicationCachePurgeProvider labels configured fetch, test stub, absent, and injected providers', () => {
    const devConfig = loadConfig({ DATABASE_URL: 'postgres://unused/known', LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' });
    const testConfig = Object.freeze({ ...devConfig, nodeEnv: 'test' as const });
    const configuredConfig = loadConfig({
      DATABASE_URL: 'postgres://unused/known',
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      PUBLICATION_CACHE_PURGE_ENDPOINT: 'https://purge.example.test/v1/cache',
    });

    // Absent provider (development without cachePurge): missing.
    assert.equal(resolvePublicationCachePurgeProvider(devConfig), undefined);

    // Test-mode no-op: a labeled stub that must never be reported durable.
    const stub = resolvePublicationCachePurgeProvider(testConfig);
    assert.ok(stub);
    assert.equal(stub.kind, 'stub');

    // Configured real provider: labeled fetch and therefore durable.
    const configured = resolvePublicationCachePurgeProvider(configuredConfig);
    assert.ok(configured instanceof FetchPublicationCachePurgeProvider);
    assert.equal(configured.kind, 'fetch');

    // Injected kind-less provider: no discriminator, defaults to durable.
    const injected = resolvePublicationCachePurgeProvider(devConfig, { async purge() {} });
    assert.ok(injected);
    assert.equal(injected.kind, undefined);
  });

  test('createNoopPublicationCachePurgeProvider is a frozen labeled stub that no-ops', async () => {
    const stub = createNoopPublicationCachePurgeProvider();
    assert.equal(stub.kind, 'stub');
    assert.equal(Object.isFrozen(stub), true);
    await stub.purge({} as PublicationCachePurgeRequest);
  });

  test('resolvePublicationCachePurgeReadinessState maps stub to stubbed and never durable', () => {
    assert.equal(resolvePublicationCachePurgeReadinessState(undefined), 'missing');
    assert.equal(resolvePublicationCachePurgeReadinessState(createNoopPublicationCachePurgeProvider()), 'stubbed');
    assert.equal(resolvePublicationCachePurgeReadinessState(new FetchPublicationCachePurgeProvider({
      endpoint: 'https://purge.example.test/v1/cache',
    })), 'durable');
    assert.equal(resolvePublicationCachePurgeReadinessState({ async purge() {} }), 'durable');
  });
});
