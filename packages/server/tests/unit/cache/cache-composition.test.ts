/**
 * T10 API composition tests (plan §6.4 T10 / §7.1 / §7.2): prove that the
 * Redis runtime, the T06-T08 Publication query decorators and the readiness /
 * graceful-close lifecycle are wired into the API the way the plan requires.
 *
 * Evidence style:
 * - mode=off never calls the Redis runtime factory and leaves the origin
 *   loader untouched (reference behavior), even when every domain flag is on.
 * - mode=shadow always returns the PostgreSQL result and counts a digest
 *   mismatch when the cached value differs from origin.
 * - mode=serve serves the cache on the second request (origin loader count
 *   stays put) and Redis-unavailable degrades to origin reads.
 * - The recording CacheStore fake explicitly records every command and never
 *   fabricates a hit, so a miss can never be mistaken for a hit.
 * - close() releases the client once and is safe to call again.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import {
  CACHE_SHADOW_DIGEST_MISMATCH_METRIC,
  composeCollectionBookmarkCountLookup,
  createApiCacheComposition,
  type ApiCacheComposition,
} from '../../../src/bootstrap/cache-composition.js';
import {
  decodeCacheEnvelope,
  decodeCollectionBookmarkCountCacheEnvelope,
  encodeCacheEnvelope,
  encodeCollectionBookmarkCountCacheEnvelope,
  type CacheEnvelopeTimes,
  type RedisCacheConnectionConfig,
} from '../../../src/infrastructure/cache/index.js';
import { alwaysReady } from '../../../src/infrastructure/health.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createProductOwnedCollectionsCursorSigner,
  type CollectionsUnitOfWork,
  type OwnedCollectionFact,
  type ProductCollectionMutationUnitOfWork,
} from '../../../src/modules/collections/index.js';
import {
  createPublicationCursorKeyring,
  PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
  PUBLICATION_RELATION_COMPARATOR_VERSION,
  type PublicationAnnotationRecord,
  type PublicationCollectionRecord,
  type PublicationDirectoryRecord,
  type PublicationMetadataRecord,
  type PublicationNodeRecord,
  type PublicationRelationRecord,
  type PublicationSnapshotQueryPorts,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';
import { RecordingCacheStore } from '../../support/recording-cache-store.js';

const ORIGIN = 'https://known.example';
const NOW = new Date('2026-07-24T00:00:00.000Z');
const REDIS_URL = 'redis://127.0.0.1:6379/0';
const MAX_ENTRY_BYTES = 512 * 1024;

function memoryExploreLimiter() {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  });
}

const openApps: FastifyInstance[] = [];
const openCompositions: ApiCacheComposition[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await Promise.all(openCompositions.splice(0).map(async (composition) => composition.close()));
});

function cacheConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: ORIGIN,
    PUBLICATION_ORIGIN: ORIGIN,
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    ...overrides,
  });
}

function metadataRecord(overrides: Partial<PublicationMetadataRecord> = {}): PublicationMetadataRecord {
  return {
    id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Collection', summary: null,
    visibility: 'public', publicationSlug: 'collection', rootNodeId: 'root-1', rootAvailable: true,
    contentRevision: 'c1', policyRevision: 'p1', tags: [], language: null, membershipRole: null,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z', deletedAt: null,
    ...overrides,
  };
}

interface MetadataHarness {
  readonly app: FastifyInstance;
  readonly store: RecordingCacheStore;
  readonly composition: ApiCacheComposition;
  readonly metrics: InMemoryMetrics;
  loaderCount(): number;
  setCurrent(record: PublicationMetadataRecord): void;
}

function buildMetadataHarness(
  config: AppConfig,
  store: RecordingCacheStore,
  metrics: InMemoryMetrics,
  composition?: ApiCacheComposition,
): MetadataHarness {
  let current = metadataRecord();
  let loaderCalls = 0;
  const ownComposition = composition ?? createApiCacheComposition({
    config: config.cache,
    metrics,
    environment: 'test',
    createStore: () => store,
  });
  openCompositions.push(ownComposition);
  const app = buildApiApp({
    config,
    readiness: alwaysReady,
    metrics,
    publicationMetadataQuery: {
      reads: {
        async load() {
          loaderCalls += 1;
          return current;
        },
      },
      origin: ORIGIN,
      now: () => NOW,
    },
    ...(ownComposition.metadataReader === undefined
      ? {}
      : { publicationMetadataCacheReader: ownComposition.metadataReader }),
    exploreDirectoryRateLimiter: memoryExploreLimiter(),
    cacheReadiness: () => ownComposition.readiness(),
    cacheCapabilityReadiness: () => ownComposition.capabilityReadiness(),
  });
  openApps.push(app);
  return {
    app, store, composition: ownComposition, metrics,
    loaderCount: () => loaderCalls,
    setCurrent: (record) => { current = record; },
  };
}

function directoryRow(id: string, updatedAt: string): PublicationDirectoryRecord {
  return {
    id, ownerSubjectId: 'owner', title: id, summary: null, kind: 'bookmarks', visibility: 'public',
    publicationSlug: id, tags: [], language: null, nodeCount: 1, updatedAt, protectedAuthorized: false,
    orderingUpdatedAtMicros: String(BigInt(Date.parse(updatedAt)) * 1000n),
  };
}

interface DirectoryHarness {
  readonly app: FastifyInstance;
  readonly store: RecordingCacheStore;
  readonly composition: ApiCacheComposition;
  loaderCount(): number;
  setRows(rows: readonly PublicationDirectoryRecord[]): void;
}

function buildDirectoryHarness(config: AppConfig, store: RecordingCacheStore, metrics: InMemoryMetrics): DirectoryHarness {
  let rows: readonly PublicationDirectoryRecord[] = [
    directoryRow('newest', '2026-07-24T02:00:00.000Z'),
    directoryRow('older', '2026-07-24T01:00:00.000Z'),
  ];
  let loaderCalls = 0;
  const cursors = createPublicationCursorKeyring({
    active: { id: 'cache-composition-directory-v1', secret: Buffer.alloc(32, 29).toString('base64') },
    retained: [],
  });
  const composition = createApiCacheComposition({
    config: config.cache,
    metrics,
    environment: 'test',
    createStore: () => store,
  });
  openCompositions.push(composition);
  const app = buildApiApp({
    config,
    readiness: alwaysReady,
    metrics,
    publicationDirectoryQuery: {
      cursors,
      origin: ORIGIN,
      maxPageSize: 200,
      reads: {
        async loadPage(request) {
          loaderCalls += 1;
          return rows.slice(0, request.limit + 1);
        },
      },
    },
    ...(composition.directoryReader === undefined
      ? {}
      : { publicationDirectoryCacheReader: composition.directoryReader }),
    exploreDirectoryRateLimiter: memoryExploreLimiter(),
    cacheReadiness: () => composition.readiness(),
    cacheCapabilityReadiness: () => composition.capabilityReadiness(),
  });
  openApps.push(app);
  return {
    app, store, composition,
    loaderCount: () => loaderCalls,
    setRows: (value) => { rows = value; },
  };
}

const SNAPSHOT_INSTANT = '2026-07-24T00:00:00.000Z';

function snapshotCollection(): PublicationCollectionRecord {
  return {
    id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Published', summary: null,
    visibility: 'public', publicationSlug: 'published', rootNodeId: 'root-1', contentRevision: 'c1',
    policyRevision: 'p1', createdAt: SNAPSHOT_INSTANT, updatedAt: SNAPSHOT_INSTANT, deletedAt: null,
  };
}

function snapshotNode(id: string): PublicationNodeRecord {
  return {
    id, collectionId: 'collection-1', parentId: 'root-1', kind: 'bookmark', isRoot: false,
    title: id, url: `https://example.test/${id}`, description: null, tags: [], visibility: 'inherit',
    ancestorRestricted: false, position: id.toUpperCase(), resourceRevision: `rev-${id}`,
    createdAt: SNAPSHOT_INSTANT, updatedAt: SNAPSHOT_INSTANT,
  };
}

function snapshotRoot(): PublicationNodeRecord {
  return {
    ...snapshotNode('root-1'), parentId: null, kind: 'folder', isRoot: true, url: null, position: null,
    title: 'Root',
  };
}

interface SnapshotHarness {
  readonly app: FastifyInstance;
  readonly store: RecordingCacheStore;
  readonly composition: ApiCacheComposition;
  readonly ports: PublicationSnapshotQueryPorts;
  loaderCount(): number;
}

function buildSnapshotHarness(config: AppConfig, store: RecordingCacheStore, metrics: InMemoryMetrics): SnapshotHarness {
  let records: readonly PublicationNodeRecord[] = [snapshotNode('a'), snapshotNode('b')];
  let loaderCalls = 0;
  const cursors = createPublicationCursorKeyring({
    active: { id: 'cache-composition-snapshot-v1', secret: Buffer.alloc(32, 19).toString('base64') },
    retained: [],
  });
  const composition = createApiCacheComposition({
    config: config.cache,
    metrics,
    environment: 'test',
    createStore: () => store,
  });
  openCompositions.push(composition);
  const ports: PublicationSnapshotQueryPorts = {
    cursors,
    origin: ORIGIN,
    // P4A-R06: deny-by-default exposure gate over logical blob facts; no blobs in this unit harness.
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
    accessPolicy: {
      async loadCollectionFacts() {
        return {
          collectionId: 'collection-1', ownerSubjectId: 'owner', visibility: 'public',
          policyRevision: 'p1', membershipRole: null, deleted: false,
        };
      },
    },
    reads: {
      async loadPage(request) {
        loaderCalls += 1;
        return {
          isolation: 'repeatable read', comparatorVersion: 'parent-position-id-v1',
          collection: snapshotCollection(), root: snapshotRoot(),
          candidates: records.slice(0, request.limit + 1),
        };
      },
    },
    annotations: {
      async loadPage() {
        return {
          isolation: 'repeatable read', comparatorVersion: PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
          contentRevision: 'c1', policyRevision: 'p1', candidates: [] as PublicationAnnotationRecord[],
        };
      },
    },
    relations: {
      async loadPage() {
        return {
          isolation: 'repeatable read', comparatorVersion: PUBLICATION_RELATION_COMPARATOR_VERSION,
          contentRevision: 'c1', policyRevision: 'p1', candidates: [] as PublicationRelationRecord[],
        };
      },
    },
  };
  const app = buildApiApp({
    config,
    readiness: alwaysReady,
    metrics,
    publicationSnapshotQuery: ports,
    ...(composition.snapshotReader === undefined
      ? {}
      : { publicationSnapshotCacheReader: composition.snapshotReader }),
    exploreDirectoryRateLimiter: memoryExploreLimiter(),
    cacheReadiness: () => composition.readiness(),
    cacheCapabilityReadiness: () => composition.capabilityReadiness(),
  });
  openApps.push(app);
  return { app, store, composition, ports, loaderCount: () => loaderCalls };
}

function metadataUrl(): string {
  return '/colp/v0.1/collections/collection-1';
}

async function getMetadata(harness: MetadataHarness): Promise<{ readonly status: number; readonly title: string }> {
  const response = await harness.app.inject({ method: 'GET', url: metadataUrl() });
  return { status: response.statusCode, title: (response.json() as { collection: { title: string } }).collection.title };
}

/** Rewrites the freshest written metadata envelope with a different-but-valid title. */
function tamperMetadataCache(store: RecordingCacheStore, nowMs: number): void {
  const sets = store.callsOf('set');
  assert.ok(sets.length > 0, 'shadow needs a prior cache write to tamper with');
  const last = sets[sets.length - 1]!;
  const key = last.args[0] as string;
  const decoded = decodeCacheEnvelope(last.args[1] as string, { maxEntryBytes: MAX_ENTRY_BYTES });
  assert.equal(decoded.kind, 'ok');
  if (decoded.kind !== 'ok') return;
  const value = decoded.envelope.value as { metadata: { collection: { title: string } } };
  value.metadata.collection.title = 'Tampered-from-cache';
  const times: CacheEnvelopeTimes = {
    writtenAtMs: nowMs - 1_000,
    softExpiresAtMs: nowMs + 5_000,
    hardExpiresAtMs: nowMs + 30_000,
  };
  const reencoded = encodeCacheEnvelope(value, times, { maxEntryBytes: MAX_ENTRY_BYTES });
  assert.equal(reencoded.kind, 'ok');
  if (reencoded.kind === 'ok') store.data.set(key, reencoded.encoded);
}

describe('T10 API composition: mode=off is the reference path', () => {
  test('never creates a Redis client and leaves the origin loader untouched even when every domain flag is on', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'off',
      CACHE_PUBLICATION_METADATA_ENABLED: 'true',
      CACHE_PUBLICATION_DIRECTORY_ENABLED: 'true',
      CACHE_PUBLICATION_SNAPSHOT_ENABLED: 'true',
      CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const createStore = vi.fn((_connection: RedisCacheConnectionConfig) => store);
    const composition = createApiCacheComposition({
      config: config.cache,
      metrics,
      environment: 'test',
      createStore,
    });
    openCompositions.push(composition);

    assert.equal(createStore.mock.calls.length, 0, 'off mode must never construct the Redis runtime');
    assert.equal(composition.metadataReader, undefined);
    assert.equal(composition.directoryReader, undefined);
    assert.equal(composition.snapshotReader, undefined);
    assert.equal(composition.bookmarkCountCache, undefined);

    const harness = buildMetadataHarness(config, store, metrics, composition);
    const first = await getMetadata(harness);
    assert.equal(first.status, 200);
    assert.equal(first.title, 'Collection');
    assert.equal(harness.loaderCount(), 1);

    harness.setCurrent(metadataRecord({ title: 'Changed by origin' }));
    const second = await getMetadata(harness);
    assert.equal(second.status, 200);
    assert.equal(second.title, 'Changed by origin', 'off mode must keep the reference origin behavior');
    assert.equal(harness.loaderCount(), 2);
    assert.equal(store.callsOf('get').length, 0, 'off mode must not issue any Redis command');

    const capability = await harness.app.inject({ method: 'GET', url: '/ready/features/cache' });
    assert.equal(capability.statusCode, 503);
    assert.equal(capability.json().status, 'disabled');
    assert.equal(capability.json().mode, 'off');

    const ready = await harness.app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: 'ready' });

    const health = await harness.app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);

    await composition.close();
    assert.equal(store.closeCalls, 0, 'off mode owns no Redis client to close');
  });
});

describe('T10 API composition: shadow mode always returns the origin', () => {
  test('returns PostgreSQL for every request and counts a digest mismatch when cache differs', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'shadow',
      REDIS_URL,
      CACHE_PUBLICATION_METADATA_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const harness = buildMetadataHarness(config, store, metrics);

    // First request: the cached reader misses (origin load #1) and then the
    // shadow wrapper re-reads the authoritative origin (#2). That second origin
    // call on a miss is the accepted, documented shadow-mode cost.
    const first = await getMetadata(harness);
    assert.equal(first.status, 200);
    assert.equal(first.title, 'Collection');
    assert.equal(harness.loaderCount(), 2);
    assert.equal(metrics.get('cache.shadow.digest_mismatch'), 0);
    assert.ok(store.callsOf('get').length > 0, 'shadow must actually read Redis');

    // Second request with the cache now fresh: still returns origin, no mismatch.
    const second = await getMetadata(harness);
    assert.equal(second.status, 200);
    assert.equal(second.title, 'Collection');
    assert.equal(harness.loaderCount(), 3);
    assert.equal(metrics.get('cache.shadow.digest_mismatch'), 0);

    // Tamper with the cached value: the cached reader serves the tampered hit
    // (no loader), the shadow wrapper compares it against the origin, counts the
    // mismatch and MUST return the authoritative origin result.
    tamperMetadataCache(store, Date.now());
    const third = await getMetadata(harness);
    assert.equal(third.status, 200);
    assert.equal(third.title, 'Collection', 'shadow must never return the cached result');
    assert.equal(harness.loaderCount(), 4);
    assert.equal(metrics.get('cache.shadow.digest_mismatch'), 1);
  });

  test('preserves the authoritative member Snapshot projection', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'shadow',
      REDIS_URL,
      CACHE_PUBLICATION_SNAPSHOT_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const harness = buildSnapshotHarness(config, store, metrics);
    const reader = harness.composition.snapshotReader;
    assert.ok(reader);

    const result = await reader(harness.ports, {
      collectionId: 'collection-1',
      principal: { kind: 'account', principalId: 'account-1', subjectId: 'owner' },
    });
    assert.equal(result.projection, 'member', 'shadow must return the authoritative member projection');
    assert.equal(harness.loaderCount(), 2, 'shadow performs its comparison read and authoritative read');
    assert.equal(store.callsOf('get').length, 0, 'authenticated Snapshot bypasses the anonymous cache');
  });
});

describe('T10 API composition: serve mode returns the cache', () => {
  test('serves metadata from cache on the second request without calling the origin loader', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      CACHE_PUBLICATION_METADATA_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const harness = buildMetadataHarness(config, store, metrics);

    const first = await getMetadata(harness);
    assert.equal(first.status, 200);
    assert.equal(first.title, 'Collection');
    assert.equal(harness.loaderCount(), 1);
    assert.equal(store.callsOf('set').length, 1, 'a miss must write the envelope back');

    // Change the fact source: the second read must come from Redis, so the
    // origin loader must not run and the cached title must be served.
    harness.setCurrent(metadataRecord({ title: 'Changed by origin' }));
    const second = await getMetadata(harness);
    assert.equal(second.status, 200);
    assert.equal(second.title, 'Collection', 'the second request must be served from cache');
    assert.equal(harness.loaderCount(), 1, 'a cache hit must not touch the origin loader');
    assert.ok(store.callsOf('get').length >= 2, 'the hit path must read Redis');
    assert.equal(store.callsOf('set').length, 1, 'a hit must not write the cache again');
    assert.equal(metrics.observations('cache.entry.size_bytes.publication-metadata').length, 2,
      'production domain reads observe entry size for the write and warm hit');
    assert.equal(metrics.observations('cache.read.latency_ms.publication-metadata').length, 2,
      'production domain reads record one latency observation per request');
  });

  test('serves the directory first page from cache on the second request', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      CACHE_PUBLICATION_DIRECTORY_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const harness = buildDirectoryHarness(config, store, metrics);

    const first = await harness.app.inject({ method: 'GET', url: '/colp/v0.1/directory' });
    assert.equal(first.statusCode, 200);
    assert.equal(harness.loaderCount(), 1);

    const second = await harness.app.inject({ method: 'GET', url: '/colp/v0.1/directory' });
    assert.equal(second.statusCode, 200);
    assert.equal(harness.loaderCount(), 1, 'the directory hit must not call the read port');
    assert.deepEqual(
      (second.json() as { collections: readonly { id: string }[] }).collections.map((item) => item.id),
      ['newest', 'older'],
    );
  });

  test('serves the snapshot first page from cache on the second request', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      CACHE_PUBLICATION_SNAPSHOT_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const harness = buildSnapshotHarness(config, store, metrics);

    const first = await harness.app.inject({ method: 'GET', url: '/colp/v0.1/collections/collection-1/snapshot' });
    assert.equal(first.statusCode, 200);
    assert.equal(harness.loaderCount(), 1);

    const second = await harness.app.inject({ method: 'GET', url: '/colp/v0.1/collections/collection-1/snapshot' });
    assert.equal(second.statusCode, 200);
    assert.equal(harness.loaderCount(), 1, 'the snapshot hit must not call the read port');
    assert.deepEqual(
      (second.json() as { nodes: readonly { id: string }[] }).nodes.map((item) => item.id),
      ['root-1', 'a', 'b'],
    );
  });
});

describe('T10 API composition: Redis unavailable degrades to origin', () => {
  test('opens the production breaker on an epoch failure and rejects overflow without another DB load', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      CACHE_PUBLICATION_METADATA_ENABLED: 'true',
    });
    const store = new RecordingCacheStore({ health: 'degraded', failCommands: true });
    const metrics = new InMemoryMetrics();
    const composition = createApiCacheComposition({
      config: config.cache,
      metrics,
      environment: 'test',
      createStore: () => store,
      breakerFailureThreshold: 1,
      bulkheadCapacity: 1,
    });
    openCompositions.push(composition);
    const reader = composition.metadataReader;
    assert.ok(reader);

    let loads = 0;
    let releaseLoader!: () => void;
    let loaderStarted!: () => void;
    const started = new Promise<void>((resolve) => { loaderStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseLoader = resolve; });
    const ports = {
      origin: ORIGIN,
      now: () => NOW,
      reads: {
        async load() {
          loads += 1;
          loaderStarted();
          await release;
          return metadataRecord();
        },
      },
    };
    const input = { collectionId: 'collection-1', principal: { kind: 'anonymous' as const } };

    const first = reader(ports, input);
    await started;
    await assert.rejects(reader(ports, input), /fallback bulkhead/u);
    assert.equal(loads, 1, 'the overflow request must not start another PostgreSQL load');
    assert.equal(store.callsOf('get').length, 1, 'the open breaker must skip the second epoch read');
    releaseLoader();
    const result = await first;
    assert.equal(result.kind, 'metadata');
    assert.equal(metrics.get('cache.read.redis_error.publication-metadata'), 1);
    assert.equal(metrics.get('cache.read.fallback.publication-metadata'), 2);
  });

  test('starts, reports degraded and still serves public reads from origin when required=false', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      KNOWN_CACHE_REQUIRED: 'false',
      REDIS_URL,
      CACHE_PUBLICATION_METADATA_ENABLED: 'true',
    });
    const store = new RecordingCacheStore({ health: 'degraded', failCommands: true });
    const metrics = new InMemoryMetrics();
    const harness = buildMetadataHarness(config, store, metrics);

    const read = await getMetadata(harness);
    assert.equal(read.status, 200, 'public reads must fail open to origin');
    assert.equal(read.title, 'Collection');
    assert.equal(harness.loaderCount(), 1);
    assert.ok(store.callsOf('get').length > 0, 'Redis must actually be attempted before falling back');

    const capability = await harness.app.inject({ method: 'GET', url: '/ready/features/cache' });
    assert.equal(capability.statusCode, 503);
    assert.equal(capability.json().status, 'degraded');

    const ready = await harness.app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 200, 'required=false must not let cache degrade the main readiness');

    const health = await harness.app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  });

  test('fails closed on readiness while liveness stays up when required=true', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      KNOWN_CACHE_REQUIRED: 'true',
      REDIS_URL,
      CACHE_PUBLICATION_METADATA_ENABLED: 'true',
    });
    const store = new RecordingCacheStore({ health: 'degraded', failCommands: true });
    const metrics = new InMemoryMetrics();
    const harness = buildMetadataHarness(config, store, metrics);

    const ready = await harness.app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json(), { status: 'not-ready' });

    const capability = await harness.app.inject({ method: 'GET', url: '/ready/features/cache' });
    assert.equal(capability.statusCode, 503);
    assert.equal(capability.json().status, 'degraded');

    const health = await harness.app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200, 'liveness must never depend on Redis');
  });
});

describe('T10 API composition: close lifecycle and fake observability', () => {
  test('closes the Redis client exactly once and tolerates repeated close', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      CACHE_PUBLICATION_METADATA_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const harness = buildMetadataHarness(config, store, metrics);

    assert.equal(store.closeCalls, 0);
    await harness.composition.close();
    assert.equal(store.closeCalls, 1, 'API shutdown must release the Redis client once');
    await harness.composition.close();
    assert.equal(store.closeCalls, 1, 'repeat close must be idempotent and never throw');
  });

  test('the recording fake records every command and never fabricates a hit', async () => {
    const store = new RecordingCacheStore();
    const signal = new AbortController().signal;

    assert.equal(await store.get('missing', signal), null, 'an unknown key is a real miss');
    await store.set('known', 'v', 1_000, signal);
    assert.equal(await store.get('known', signal), 'v');
    assert.equal(await store.get('missing', signal), null);
    await store.setIfAbsent('lock', 'token', 100, signal);
    await store.releaseIfOwner('lock', 'token', signal);
    await store.rotateEpoch('epoch', 1_000, signal);
    await store.close();

    assert.deepEqual(store.callsOf('get').map((call) => call.args[0]), ['missing', 'known', 'missing']);
    assert.equal(store.callsOf('set').length, 1);
    assert.equal(store.callsOf('setIfAbsent').length, 1);
    assert.equal(store.callsOf('releaseIfOwner').length, 1);
    assert.equal(store.callsOf('rotateEpoch').length, 1);
    assert.equal(store.closeCalls, 1);
  });
});

const unusedCollectionsUow: CollectionsUnitOfWork = {
  async execute<T>(): Promise<T> {
    throw new Error('mutation UoW must not execute for bookmark-count list');
  },
};
const unusedMutationUow: ProductCollectionMutationUnitOfWork = {
  async execute<T>(): Promise<T> {
    throw new Error('mutation UoW must not execute for bookmark-count list');
  },
};

interface BookmarkCountListDocument {
  readonly items: ReadonlyArray<{
    readonly collection: { readonly id: string };
    readonly bookmarkCount: number;
  }>;
}

interface BookmarkCountHarness {
  readonly app: FastifyInstance;
  readonly store: RecordingCacheStore;
  readonly composition: ApiCacheComposition;
  readonly metrics: InMemoryMetrics;
  readonly cookie: string;
  originCount(): number;
  originCalls(): readonly string[][];
}

function bookmarkCountFact(id: string, contentRevision = 'rev-1'): OwnedCollectionFact {
  return {
    id,
    kind: 'bookmarks',
    title: `Title ${id}`,
    summary: null,
    visibility: 'private',
    publicationSlug: null,
    allowSearchIndexing: false,
    publishedAt: null,
    rootNodeId: `root-${id}`,
    resourceRevision: `r-${id}`,
    contentRevision,
    policyRevision: `p-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function buildBookmarkCountHarness(
  config: AppConfig,
  store: RecordingCacheStore,
  metrics: InMemoryMetrics,
  options: {
    readonly createStore?: (connection: RedisCacheConnectionConfig) => RecordingCacheStore;
    readonly originCounts?: ReadonlyMap<string, number>;
    readonly composition?: ApiCacheComposition;
  } = {},
): Promise<BookmarkCountHarness> {
  const originCalls: string[][] = [];
  const table = options.originCounts ?? new Map([['collection-1', 9]]);
  const origin = {
    async countBookmarks(collectionIds: readonly string[]) {
      originCalls.push([...collectionIds]);
      const counts = new Map<string, number>();
      for (const id of collectionIds) counts.set(id, table.get(id) ?? 0);
      return counts;
    },
  };
  const composition = options.composition ?? createApiCacheComposition({
    config: config.cache,
    metrics,
    environment: 'test',
    createStore: options.createStore ?? (() => store),
    random: () => 0,
  });
  openCompositions.push(composition);
  const lookup = composeCollectionBookmarkCountLookup(composition, origin, metrics);
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const signer = createProductOwnedCollectionsCursorSigner({
    current: { id: 'bookmark-count-cache-v1', key: 'bookmark-count-cache-cursor-secret-32b' },
  });
  let ownerSubjectId = '';
  const app = buildApiApp({
    config,
    readiness: alwaysReady,
    metrics,
    identityUnitOfWork: identity,
    collectionsUnitOfWork: unusedCollectionsUow,
    productCollectionMutationUnitOfWork: unusedMutationUow,
    browserSessionAuthority: factory.authority,
    ownedCollectionsQuery: {
      reads: {
        async listOwnedCollections(input) {
          if (input.ownerSubjectId !== ownerSubjectId) return [];
          return [bookmarkCountFact('collection-1')];
        },
      },
      cursors: signer,
      clock: { now: async () => NOW },
    },
    bookmarkCounts: lookup,
    cacheReadiness: () => composition.readiness(),
    cacheCapabilityReadiness: () => composition.capabilityReadiness(),
  });
  app.addHook('onClose', async () => signer.destroy());
  openApps.push(app);
  const owner = await issueTestSession({
    factory,
    subject: 'owner-subject',
    displayName: 'Owner',
    handle: 'bookmarkcache',
  });
  ownerSubjectId = owner.subjectId;
  return {
    app,
    store,
    composition,
    metrics,
    cookie: owner.cookie,
    originCount: () => originCalls.length,
    originCalls: () => originCalls,
  };
}

async function listOwnedBookmarkCounts(
  harness: BookmarkCountHarness,
): Promise<{ readonly status: number; readonly bookmarkCount: number | undefined }> {
  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/v1/collections',
    headers: { cookie: harness.cookie, accept: 'application/json' },
  });
  const body = response.json() as BookmarkCountListDocument;
  return { status: response.statusCode, bookmarkCount: body.items[0]?.bookmarkCount };
}

function tamperBookmarkCountCache(store: RecordingCacheStore, nowMs: number, bookmarkCount: number): void {
  const sets = store.callsOf('set');
  assert.ok(sets.length > 0, 'shadow needs a prior cache write to tamper with');
  const last = sets[sets.length - 1]!;
  const key = last.args[0] as string;
  const decoded = decodeCollectionBookmarkCountCacheEnvelope(last.args[1] as string, {
    maxEntryBytes: MAX_ENTRY_BYTES,
  });
  assert.equal(decoded.kind, 'ok');
  if (decoded.kind !== 'ok') return;
  const times: CacheEnvelopeTimes = {
    writtenAtMs: nowMs - 1_000,
    softExpiresAtMs: nowMs + 5_000,
    hardExpiresAtMs: nowMs + 30_000,
  };
  const reencoded = encodeCollectionBookmarkCountCacheEnvelope(
    { bookmarkCount },
    times,
    { maxEntryBytes: MAX_ENTRY_BYTES },
  );
  assert.equal(reencoded.kind, 'ok');
  if (reencoded.kind === 'ok') store.data.set(key, reencoded.encoded);
}

describe('P5 collection bookmark-count composition', () => {
  test('off never creates a Redis client even when the domain flag is on, and list COUNT stays on origin', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'off',
      CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const createStore = vi.fn((_connection: RedisCacheConnectionConfig) => store);
    const composition = createApiCacheComposition({
      config: config.cache,
      metrics,
      environment: 'test',
      createStore,
    });
    const harness = await buildBookmarkCountHarness(config, store, metrics, { composition, createStore });

    assert.equal(createStore.mock.calls.length, 0, 'off mode must never construct the Redis runtime');
    assert.equal(composition.bookmarkCountCache, undefined);

    const first = await listOwnedBookmarkCounts(harness);
    assert.equal(first.status, 200);
    assert.equal(first.bookmarkCount, 9);
    assert.equal(harness.originCount(), 1);
    assert.deepEqual(harness.originCalls(), [['collection-1']]);

    const second = await listOwnedBookmarkCounts(harness);
    assert.equal(second.status, 200);
    assert.equal(second.bookmarkCount, 9);
    assert.equal(harness.originCount(), 2, 'off mode must keep issuing origin COUNT');
    assert.equal(store.callsOf('get').length, 0);
    assert.equal(store.closeCalls, 0);

    await composition.close();
    assert.equal(store.closeCalls, 0, 'off mode owns no Redis client to close');
  });

  test('shadow always returns origin COUNT and increments digest mismatch when cache differs', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'shadow',
      REDIS_URL,
      CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const harness = await buildBookmarkCountHarness(config, store, metrics);

    const first = await listOwnedBookmarkCounts(harness);
    assert.equal(first.status, 200);
    assert.equal(first.bookmarkCount, 9);
    assert.equal(harness.originCount(), 2, 'shadow miss pays cache origin plus authoritative origin');
    assert.equal(metrics.get(CACHE_SHADOW_DIGEST_MISMATCH_METRIC), 0);
    assert.ok(store.callsOf('get').length > 0, 'shadow must actually read Redis');
    assert.equal(store.callsOf('set').length, 1, 'shadow miss must write the envelope');

    const second = await listOwnedBookmarkCounts(harness);
    assert.equal(second.status, 200);
    assert.equal(second.bookmarkCount, 9);
    assert.equal(harness.originCount(), 3, 'shadow hit still re-reads origin');
    assert.equal(metrics.get(CACHE_SHADOW_DIGEST_MISMATCH_METRIC), 0);

    tamperBookmarkCountCache(store, Date.now(), 99);
    const third = await listOwnedBookmarkCounts(harness);
    assert.equal(third.status, 200);
    assert.equal(third.bookmarkCount, 9, 'shadow must never return the cached COUNT');
    assert.equal(harness.originCount(), 4);
    assert.equal(metrics.get(CACHE_SHADOW_DIGEST_MISMATCH_METRIC), 1);
  });

  test('serve healthy store skips origin COUNT on the second identical list', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const harness = await buildBookmarkCountHarness(config, store, metrics);

    const first = await listOwnedBookmarkCounts(harness);
    assert.equal(first.status, 200);
    assert.equal(first.bookmarkCount, 9);
    assert.equal(harness.originCount(), 1, 'the first list is a miss and must COUNT');
    assert.equal(store.callsOf('set').length, 1, 'a miss must write the envelope back');

    const second = await listOwnedBookmarkCounts(harness);
    assert.equal(second.status, 200);
    assert.equal(second.bookmarkCount, 9);
    assert.equal(harness.originCount(), 1, 'a cache hit must not call origin countBookmarks');
    assert.ok(store.callsOf('get').length >= 2, 'the hit path must read Redis');
    assert.equal(store.callsOf('set').length, 1, 'a hit must not write the cache again');
  });

  test('required=false and Redis down still starts and fail-opens list COUNT to origin', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      KNOWN_CACHE_REQUIRED: 'false',
      REDIS_URL,
      CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED: 'true',
    });
    const store = new RecordingCacheStore({ health: 'degraded', failCommands: true });
    const metrics = new InMemoryMetrics();
    const harness = await buildBookmarkCountHarness(config, store, metrics);

    const read = await listOwnedBookmarkCounts(harness);
    assert.equal(read.status, 200, 'list must fail open to origin COUNT');
    assert.equal(read.bookmarkCount, 9);
    assert.equal(harness.originCount(), 1);
    assert.ok(store.callsOf('get').length > 0, 'Redis must actually be attempted before falling back');

    const ready = await harness.app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 200, 'required=false must not let cache degrade the main readiness');
  });

  test('serve shares the one API CacheStore and close releases it once', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      CACHE_PUBLICATION_METADATA_ENABLED: 'true',
      CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED: 'true',
    });
    const store = new RecordingCacheStore();
    const metrics = new InMemoryMetrics();
    const createStore = vi.fn((_connection: RedisCacheConnectionConfig) => store);
    const composition = createApiCacheComposition({
      config: config.cache,
      metrics,
      environment: 'test',
      createStore,
      random: () => 0,
    });
    const harness = await buildBookmarkCountHarness(config, store, metrics, { composition, createStore });

    assert.equal(createStore.mock.calls.length, 1, 'serve must construct exactly one Redis runtime');
    assert.ok(composition.bookmarkCountCache, 'the domain factory must be present under serve');
    assert.ok(composition.metadataReader, 'publication must share the same composition');

    const first = await listOwnedBookmarkCounts(harness);
    assert.equal(first.status, 200);
    assert.equal(first.bookmarkCount, 9);

    assert.equal(store.closeCalls, 0);
    await harness.composition.close();
    assert.equal(store.closeCalls, 1, 'API shutdown must release the shared Redis client once');
    await harness.composition.close();
    assert.equal(store.closeCalls, 1, 'repeat close must be idempotent');
  });
});
