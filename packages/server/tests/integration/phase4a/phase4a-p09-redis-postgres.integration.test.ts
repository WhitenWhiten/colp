/**
 * P4A-P09 Redis suite: Publication Redis warm cache never carries private
 * facts (real Redis via Testcontainers, production key codec + adapter).
 *
 * Anti-false-positive anchors (plan §4.1.9/§4.2.6): the cache adapter and the
 * envelope codec are the PRODUCTION implementations over a REAL Redis
 * (docker `redis:7-alpine`, override KNOWN_REDIS_IMAGE; container start
 * failure is an environment failure, never a skip); keys/values are scanned
 * through a raw ioredis connection using the run-scoped prefix; cleanup
 * force-expires exactly the run's keys (no FLUSHALL/FLUSHDB).
 *
 * Scenario (plan §6 P4A-P09):
 * 1. warm the cache with ONLY the control resource present — the gate-wired
 *    loader writes a marker-free envelope;
 * 2. a REAL private blob is finalized AFTER warm — a warm hit serves the
 *    marker-free envelope with ZERO origin reload (set-call count unchanged)
 *    and a cold rebuild (epoch rotation) serves control + zero markers;
 * 3. old artifact migration: a stale pre-gate envelope whose snapshot carries
 *    attachment entries (the marker) is REJECTED by the cache value guard and
 *    healed through the gate (the stale snapshot still passes the full COLP
 *    validation, so the rejection is specifically the P09 attachments guard).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, test } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import {
  CACHE_PROJECTION,
  CacheBulkhead,
  CacheCircuitBreaker,
  CacheSingleflight,
  buildCacheDataKey,
  buildCacheEpochKey,
  createCacheFailurePolicy,
  createRedisCacheStore,
  decodeCacheEnvelope,
  encodeCacheEnvelope,
  type CacheStore,
} from '../../../src/infrastructure/cache/index.js';
import { createPublicationSnapshotCache } from '../../../src/infrastructure/publication/index.js';
import { isValidPublicationSnapshot } from '../../../src/modules/publication/index.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { seedControlCollection, I12_SUBJECT_OWNER } from '../../support/phase4a-i12-test-helpers.js';
import { p07Finalize, p07UploadToStored } from '../../support/phase4a-p07-test-helpers.js';
import { P08ObjectServer, p08Config } from '../../support/phase4a-p08-test-helpers.js';
import { buildP03App } from '../../support/phase4a-p03-test-helpers.js';
import { waitUntil } from '../../support/redis-runtime-test-helpers.js';
import type { AttachmentsFeatureConfig } from '../../../src/modules/attachments/index.js';
import {
  P09_COLLECTION,
  P09_MEDIA_TYPE,
  p09Body,
} from '../../support/phase4a-p09-test-helpers.js';
import {
  P09_CACHE_KEY,
  P09_CACHE_POLICY,
  p09SnapshotPorts,
  type P09SnapshotPorts,
} from '../../support/phase4a-p09-http-helpers.js';

const REDIS_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';
const ANONYMOUS = Object.freeze({ kind: 'anonymous' as const });
/** Mutable: the container port is only known after start. */
const REDIS_CONFIG = {
  url: null as string | null,
  commandTimeoutMs: 1_000,
  connectTimeoutMs: 5_000,
  maxRetriesPerRequest: 1,
  keyPrefix: P09_CACHE_KEY.keyPrefix,
};
const CACHE_LIMITS = Object.freeze({ maxEntryBytes: P09_CACHE_POLICY.maxEntryBytes });
const EPOCH_TTL_MS = 60_000;

class CountingCacheStore implements CacheStore {
  gets = 0;
  sets = 0;
  setIfAbsents = 0;
  releases = 0;
  rotates = 0;
  constructor(private readonly inner: CacheStore) {}
  async get(key: string, signal: AbortSignal): Promise<string | null> {
    this.gets += 1;
    return this.inner.get(key, signal);
  }
  async set(key: string, encodedValue: string, hardTtlMs: number, signal: AbortSignal): Promise<void> {
    this.sets += 1;
    return this.inner.set(key, encodedValue, hardTtlMs, signal);
  }
  async setIfAbsent(key: string, token: string, lockTtlMs: number, signal: AbortSignal): Promise<boolean> {
    this.setIfAbsents += 1;
    return this.inner.setIfAbsent(key, token, lockTtlMs, signal);
  }
  async releaseIfOwner(key: string, token: string, signal: AbortSignal): Promise<boolean> {
    this.releases += 1;
    return this.inner.releaseIfOwner(key, token, signal);
  }
  async rotateEpoch(key: string, epochTtlMs: number, signal: AbortSignal): Promise<number> {
    this.rotates += 1;
    return this.inner.rotateEpoch(key, epochTtlMs, signal);
  }
  async health(): Promise<'healthy' | 'degraded'> {
    return this.inner.health();
  }
  async close(): Promise<void> {
    return this.inner.close();
  }
}

interface CacheEntry {
  readonly key: string;
  readonly value: string;
}

describeWithPostgres('P4A-P09 Publication Redis warm-cache exclusion', () => {
  let isolated: I07MigrationRuntime;
  let container: StartedTestContainer | undefined;
  let store: CacheStore;
  let counting: CountingCacheStore;
  let raw: Redis;
  let snapshotPorts: P09SnapshotPorts;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let objectServer: P08ObjectServer;
  let bundle: ReturnType<typeof buildP03App>;
  let controlNodeTitle: string;
  /** Private markers that must never appear in any cache key/value/output. */
  const privateScanMarkers: string[] = [];

  function reader() {
    const readerInstance = createPublicationSnapshotCache({
      policy: P09_CACHE_POLICY,
      deps: {
        store: counting,
        singleflight: new CacheSingleflight(),
        bulkhead: new CacheBulkhead(4),
        failurePolicy: createCacheFailurePolicy(
          new CacheCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 }),
          new CacheBulkhead(4),
        ),
        clock: () => Date.now(),
      },
      key: P09_CACHE_KEY,
    });
    return readerInstance(snapshotPorts.ports, {
      collectionId: P09_COLLECTION,
      principal: ANONYMOUS,
      query: { limit: 200 },
    });
  }

  function domain() {
    return { kind: 'publication' as const, locator: 'pubid' as const, collectionId: P09_COLLECTION };
  }

  async function currentEpoch(): Promise<number> {
    const epochKey = buildCacheEpochKey({ ...P09_CACHE_KEY, domain: domain() });
    const rawEpoch = await store.get(epochKey, new AbortController().signal);
    const parsed = rawEpoch === null ? 0 : Number.parseInt(rawEpoch, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  async function currentDataKey(): Promise<string> {
    const epoch = await currentEpoch();
    return buildCacheDataKey({
      ...P09_CACHE_KEY,
      domain: domain(),
      projection: CACHE_PROJECTION.PUBLICATION_SNAPSHOT,
      epoch,
      query: { root: null, depth: null, include: [], limit: 200, pageCursor: null },
    });
  }

  async function scanRunKeys(): Promise<CacheEntry[]> {
    const keys = await raw.keys(`${P09_CACHE_KEY.keyPrefix}:*`);
    const entries: CacheEntry[] = [];
    for (const key of keys) {
      const value = (await raw.get(key)) ?? '';
      entries.push({ key, value });
    }
    return entries;
  }

  function assertNoMarkerInEntries(entries: readonly CacheEntry[], label: string): void {
    assert.ok(entries.length >= 1, `${label}: the cache must hold real Redis entries`);
    for (const entry of entries) {
      for (const marker of privateScanMarkers) {
        assert.equal(entry.key.includes(marker), false, `${label}: cache key must never contain ${marker}`);
        assert.equal(entry.value.includes(marker), false, `${label}: cache value must never contain ${marker}`);
      }
    }
  }

  afterAll(async () => {
    snapshotPorts?.key.destroy();
    // Final cleanup: force-expire exactly this run's keys before the container
    // stops (the scenario deliberately keeps the warm state across the tests
    // in this file, so cleanup happens once at the end, never between them).
    try {
      const keys = await raw?.keys(`${P09_CACHE_KEY.keyPrefix}:*`);
      for (const key of keys ?? []) await raw?.pexpire(key, 1);
    } catch { /* ignore */ }
    try { await store?.close(); } catch { /* ignore */ }
    try { await raw?.quit(); } catch { /* ignore */ }
    try { await bundle?.app.close(); } catch { /* ignore */ }
    try { await bundle?.store.close(); } catch { /* ignore */ }
    try { await objectServer?.close(); } catch { /* ignore */ }
    try { await container?.stop(); } catch { /* ignore */ }
    await isolated?.dropSchema();
  });

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p09_redis', { maxConnections: 14 });
    container = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .start();
    REDIS_CONFIG.url = `redis://127.0.0.1:${container.getMappedPort(6379)}`;
    store = createRedisCacheStore(REDIS_CONFIG);
    counting = new CountingCacheStore(store);
    await waitUntil(async () => (await store.health()) === 'healthy', 15_000, 'redis ready');
    raw = new Redis(REDIS_CONFIG.url);

    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z')));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: I12_SUBJECT_OWNER,
      handle: `p09_redis_owner_${randomUUID().slice(0, 8)}`,
    });
    objectServer = new P08ObjectServer();
    const objectServerUrl = await objectServer.start();
    const baseConfig = p08Config();
    const config: AttachmentsFeatureConfig = {
      ...baseConfig,
      r2: { ...baseConfig.r2, endpoint: objectServerUrl },
    };
    bundle = buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl,
      attachmentsConfig: config,
    });
    // Legal fixture pre-data: the collection owner's own membership row (the
    // product upload/finalize routes gate on `collection_members`; the owner
    // must be the ACCOUNT subject id, never the OIDC subject string).
    const seeded = await seedControlCollection(isolated.runtime, {
      collectionId: P09_COLLECTION,
      ownerSubjectId: owner.subjectId,
      controlNodeTitle: `p09-redis-control-${randomUUID()}`,
    });
    await isolated.runtime.pool.query(
      `insert into collection_members (collection_id, subject_id, role, granted_at)
       values ($1, $2, 'owner', now())`,
      [P09_COLLECTION, owner.subjectId],
    );
    controlNodeTitle = seeded.controlNodeTitle;
    snapshotPorts = p09SnapshotPorts(isolated.runtime);
  }, 180_000);

  test('warm with the control resource writes a marker-free envelope and the warm hit needs no reload', async () => {
    const first = await reader();
    assert.ok(first.snapshot.nodes.some((node) => node.title === controlNodeTitle),
      'control node must be served on the cold miss (link executed)');
    assert.deepEqual(first.snapshot.attachments, [], 'the gate closes the attachment projection');
    assert.ok(counting.sets >= 1, 'a miss must write cache entries');
    const entries = await scanRunKeys();
    assertNoMarkerInEntries(entries, 'warm write');

    const setsAfterWarm = counting.sets;
    const second = await reader();
    assert.deepEqual(second.snapshot, first.snapshot, 'the warm hit serves the same gate-derived snapshot');
    assert.equal(counting.sets, setsAfterWarm, 'a warm hit must not reload from origin (zero new writes)');
    assert.ok(second.snapshot.nodes.some((node) => node.title === controlNodeTitle));

    const dataKey = await currentDataKey();
    const rawEnvelope = await store.get(dataKey, new AbortController().signal);
    assert.ok(rawEnvelope !== null, 'the exact production data key must exist');
    const decoded = decodeCacheEnvelope<{ snapshot: { attachments: readonly unknown[] } }>(rawEnvelope!, CACHE_LIMITS);
    assert.equal(decoded.kind, 'ok', 'the stored envelope must decode');
    if (decoded.kind === 'ok') {
      assert.deepEqual(decoded.envelope.value.snapshot.attachments, [],
        'the cached envelope must never carry attachment entries');
    }
  });

  test('a private blob finalized AFTER warm never reaches the cache, a warm hit, or a cold rebuild', async () => {
    const postWarmMarker = `p09-postwarm-${randomUUID()}`;
    privateScanMarkers.push(postWarmMarker);
    const uploaded = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
      collectionId: P09_COLLECTION,
      body: p09Body(postWarmMarker),
      mediaType: P09_MEDIA_TYPE,
    });
    const finalized = await p07Finalize(bundle.app, owner, uploaded.blobId, randomUUID());
    assert.equal(finalized.statusCode, 200, finalized.body);
    const rows = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from attachments where blob_id = $1`,
      [uploaded.blobId],
    );
    assert.equal(rows.rows[0]!.count, '1', 'the post-warm blob must be a REAL finalized attachments row');

    // Warm hit: the pre-blob envelope is served without reload and without the marker.
    const setsBeforeHit = counting.sets;
    const hit = await reader();
    assert.equal(counting.sets, setsBeforeHit, 'the warm hit must serve the cached envelope without origin reload');
    assert.ok(hit.snapshot.nodes.some((node) => node.title === controlNodeTitle));
    assert.deepEqual(hit.snapshot.attachments, []);
    assert.equal(JSON.stringify(hit).includes(postWarmMarker), false,
      'the warm hit must never expose the post-warm private blob');

    // Cold rebuild after epoch rotation: the gate re-derives the projection.
    const epochKey = buildCacheEpochKey({ ...P09_CACHE_KEY, domain: domain() });
    await store.rotateEpoch(epochKey, EPOCH_TTL_MS, new AbortController().signal);
    const rebuilt = await reader();
    assert.ok(rebuilt.snapshot.nodes.some((node) => node.title === controlNodeTitle),
      'the cold rebuild must still serve the control node');
    assert.equal(JSON.stringify(rebuilt).includes(postWarmMarker), false,
      'the cold rebuild must never expose the private blob');
    assert.deepEqual(rebuilt.snapshot.attachments, []);

    const entries = await scanRunKeys();
    assertNoMarkerInEntries(entries, 'after post-warm finalize');
    const dataKey = await currentDataKey();
    const rebuiltEnvelope = await store.get(dataKey, new AbortController().signal);
    assert.ok(rebuiltEnvelope !== null);
    assert.equal(rebuiltEnvelope.includes(postWarmMarker), false,
      'the rebuilt envelope must never carry the private marker');
  });

  test('a stale pre-gate envelope with attachment entries is rejected and healed (old artifact migration)', async () => {
    const dataKey = await currentDataKey();
    const legit = await store.get(dataKey, new AbortController().signal);
    assert.ok(legit !== null, 'a legitimate envelope must exist from the previous tests');
    const decoded = decodeCacheEnvelope<{
      snapshot: {
        attachments: readonly unknown[];
        generatedAt: string;
        revision: string;
        collection: { id: string };
      };
      nextCursor: string | null;
    }>(legit, CACHE_LIMITS);
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind !== 'ok') return;

    // Build the stale pre-gate artifact: the SAME validated snapshot but with
    // a marker-bearing attachment entry (as if an old build cached attachment
    // content before the gate existed).
    const marker = `p09-stale-envelope-${randomUUID()}`;
    privateScanMarkers.push(marker);
    const snapshot = structuredClone(decoded.envelope.value.snapshot);
    snapshot.attachments = [{
      id: marker,
      collectionId: snapshot.collection.id,
      subject: { type: 'collection', id: snapshot.collection.id },
      rel: 'attachment',
      url: `https://attachments.example.test/${marker}`,
      mimeType: 'text/plain',
      title: marker,
      visibility: 'public',
      createdAt: snapshot.generatedAt,
      updatedAt: snapshot.generatedAt,
      revision: snapshot.revision,
    }];
    const staleValue = {
      projection: 'public' as const,
      snapshot,
      nextCursor: decoded.envelope.value.nextCursor ?? null,
      byteLength: Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
    };
    // The stale snapshot still passes the FULL COLP validation — the only
    // rejection must be the P4A-P09 cache guard (non-empty attachments).
    assert.equal(isValidPublicationSnapshot(snapshot), true,
      'the stale snapshot must otherwise validate so the guard is the rejection point');
    const encoded = encodeCacheEnvelope(staleValue, {
      writtenAtMs: decoded.envelope.writtenAtMs,
      softExpiresAtMs: decoded.envelope.softExpiresAtMs,
      hardExpiresAtMs: decoded.envelope.hardExpiresAtMs,
    }, CACHE_LIMITS);
    assert.equal(encoded.kind, 'ok', 'the stale envelope must encode with the production codec');
    if (encoded.kind !== 'ok') return;
    await store.set(dataKey, encoded.encoded, decoded.envelope.hardExpiresAtMs, new AbortController().signal);

    // The reader must NOT serve the stale marker-bearing envelope: it is
    // rejected, rebuilt through the gate and healed.
    const served = await reader();
    assert.ok(served.snapshot.nodes.some((node) => node.title === controlNodeTitle),
      'control node must be served after the stale envelope is rejected');
    assert.deepEqual(served.snapshot.attachments, []);
    assert.equal(JSON.stringify(served).includes(marker), false,
      'the stale envelope marker must never be served');

    const healed = await store.get(dataKey, new AbortController().signal);
    assert.ok(healed !== null);
    assert.equal(healed.includes(marker), false, 'the cache must heal the stale envelope through the gate');
    const healedDecoded = decodeCacheEnvelope<{ snapshot: { attachments: readonly unknown[] } }>(healed, CACHE_LIMITS);
    assert.equal(healedDecoded.kind, 'ok');
    if (healedDecoded.kind === 'ok') {
      assert.deepEqual(healedDecoded.envelope.value.snapshot.attachments, [],
        'the healed envelope must carry the gate-closed empty attachment projection');
    }
    const entries = await scanRunKeys();
    assertNoMarkerInEntries(entries, 'after stale-envelope heal');
  });
});
