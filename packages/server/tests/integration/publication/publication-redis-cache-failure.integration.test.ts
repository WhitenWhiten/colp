/**
 * T13 PostgreSQL + Redis end-to-end acceptance — failure, degradation and
 * recovery (plan 12-redis-hot-data-cache-plan.md §6.4 T13, §7.3 rule 8, §7.5
 * "Redis outage" template).
 *
 * Only the test-exclusive Redis container is stopped (redis-server process
 * inside the keep-alive container, T12 pattern) — never a developer Redis.
 * Cleanup and recovery always run in `finally` so no later test or dev
 * instance is polluted (plan §6.4 T13).
 *
 * What is proven through the real HTTP/Application composition:
 * - before the outage the cache works (cold miss then warm hit);
 * - during the outage every cache command rejects fast (bounded, no offline
 *   queue / no unbounded backlog) and anonymous public reads still succeed by
 *   falling back to the authoritative PostgreSQL origin with a bounded latency;
 *   `store.health()` and `/ready/features/cache` report degraded;
 * - the outage response is byte/ETag-identical to the off reference and the
 *   origin loader ran exactly once (no retry storm);
 * - after the redis-server process is restored, health recovers to healthy
 *   (the readiness probe auto-returns to healthy), and the next miss writes
 *   Redis again while a subsequent warm hit loads origin zero times.
 *
 * - concurrent outage traffic above the configured fallback bulkhead is
 *   rejected without starting additional PostgreSQL loads, and an open breaker
 *   skips subsequent epoch/data Redis commands.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { CacheStoreError, CACHE_ERROR_CATEGORY } from '../../../src/infrastructure/cache/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  composeApi,
  insertPublishedCollection,
  newE2ETestScope,
  restoreRedisServer,
  startRedisE2EContainer,
  waitForCacheHealth,
  waitUntil,
  type ComposedApi,
  type E2ETestScope,
  type RedisE2EContainer,
} from '../../support/redis-cache-e2e.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';

interface CapturedResponse {
  readonly statusCode: number;
  readonly bytes: Buffer;
  readonly etag: string | undefined;
  readonly retryAfter: string | undefined;
  readonly body: unknown;
}

async function getMetadata(app: ComposedApi, collectionId: string): Promise<CapturedResponse> {
  const response = await app.app.inject({
    method: 'GET',
    url: `/colp/v0.1/collections/${encodeURIComponent(collectionId)}`,
    headers: { accept: 'application/json' },
  });
  return {
    statusCode: response.statusCode,
    bytes: Buffer.from(response.rawPayload),
    etag: typeof response.headers.etag === 'string' ? response.headers.etag : undefined,
    retryAfter: typeof response.headers['retry-after'] === 'string'
      ? response.headers['retry-after']
      : undefined,
    body: response.json(),
  };
}

function isCacheUnavailable(error: unknown): boolean {
  return error instanceof CacheStoreError && error.category === CACHE_ERROR_CATEGORY.UNAVAILABLE;
}

describeWithPostgres('publication Redis cache failure degradation and recovery (T13)', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let redis: RedisE2EContainer;
  let cursorKeys: ReturnType<typeof createPublicationCursorKeyring>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('t13_redis_cache_failure', {
      maxConnections: 8,
      applicationName: 'known-t13-redis-cache-failure',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    redis = await startRedisE2EContainer();
    cursorKeys = createPublicationCursorKeyring({
      active: { id: 't13-failure-v1', secret: Buffer.alloc(32, 91).toString('base64') },
      retained: [],
    });
  }, 240_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      cursorKeys.destroy();
    } catch (error) {
      errors.push(error);
    }
    if (redis) {
      try {
        await redis.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (isolated) {
      try {
        await isolated.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new Error(`T13 failure cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  test('Redis outage: bounded origin fallback, degraded readiness, then recovery re-enables cache writes and warm hits', async () => {
    const scope: E2ETestScope = newE2ETestScope();
    const serve = composeApi(scope, 'serve', { databaseUrl: isolated.databaseUrl, runtime, redisUrl: redis.url, cursorKeys });
    const off = composeApi(scope, 'off', { databaseUrl: isolated.databaseUrl, runtime, redisUrl: null, cursorKeys });
    try {
      await waitForCacheHealth(serve);
      assert.ok(serve.store, 'serve app must own a Redis store');
      const fixture = await insertPublishedCollection({ pool: runtime.pool, ownerSubjectId: scope.ownerSubject });
      const reference = await getMetadata(off, fixture.collectionId);
      assert.equal(reference.statusCode, 200);

      // Baseline: cache works before the outage (cold miss -> warm hit).
      serve.counters.reset();
      serve.store.reset();
      const baselineMiss = await getMetadata(serve, fixture.collectionId);
      assert.equal(baselineMiss.statusCode, 200);
      assert.equal(serve.counters.metadata.calls.load, 1, 'baseline cold miss loads origin once');
      assert.equal(serve.store.counts.set, 1, 'baseline cold miss writes Redis');
      serve.counters.reset();
      serve.store.reset();
      const baselineHit = await getMetadata(serve, fixture.collectionId);
      assert.equal(baselineHit.statusCode, 200);
      assert.equal(serve.counters.metadata.calls.load, 0, 'baseline warm hit loads origin zero times');
      assert.equal(serve.store.counts.set, 0, 'baseline warm hit does not write Redis');

      // Stop the redis-server *process* inside the test-exclusive container.
      const shutdown = await redis.container.exec(['redis-cli', 'shutdown', 'nosave']);
      if (shutdown.exitCode !== 0) {
        throw new Error(`redis-cli shutdown failed (exit ${shutdown.exitCode}): ${shutdown.output}`);
      }
      try {
        // Synchronize on the real disconnect: poll until a command rejects fast.
        await waitUntil(
          async () => {
            try {
              await serve.store!.get(`t13-outage-probe-${scope.suffix}`, new AbortController().signal);
              return false;
            } catch {
              return true;
            }
          },
          10_000,
          'cache commands to fail after the redis shutdown',
          50,
        );

        // A failing command itself is bounded (no offline queue / no unbounded backlog).
        const commandStarted = performance.now();
        await assert.rejects(
          serve.store!.get(`t13-outage-probe-2-${scope.suffix}`, new AbortController().signal),
          isCacheUnavailable,
          'cache command must reject with cache_unavailable during the outage',
        );
        const commandElapsed = performance.now() - commandStarted;
        assert.ok(
          commandElapsed < 3_000,
          `failing cache command took ${commandElapsed.toFixed(0)}ms (bounded, expected < 3000ms)`,
        );

        assert.equal(await serve.store.health(), 'degraded', 'store health must degrade during the outage');
        assert.equal(await serve.cacheComposition.readiness(), 'degraded',
          'composition readiness must report degraded during the outage');

        // Public read still succeeds through the controlled origin fallback:
        // loader runs exactly once and the response is byte/ETag-identical to
        // the off reference, within a generous bounded latency.
        serve.counters.reset();
        serve.store.reset();
        const fallbackStarted = performance.now();
        const fallback = await getMetadata(serve, fixture.collectionId);
        const fallbackElapsed = performance.now() - fallbackStarted;
        assert.equal(fallback.statusCode, 200, 'anonymous public read must still succeed during the outage');
        assert.equal(serve.counters.metadata.calls.load, 1,
          'outage fallback must load origin exactly once (no retry storm)');
        assert.equal(serve.store.counts.set, 0, 'outage fallback must not write Redis (it is down)');
        assert.deepEqual(fallback.bytes, reference.bytes, 'outage fallback body bytes must equal the off reference');
        assert.equal(fallback.etag, reference.etag, 'outage fallback ETag must equal the off reference');
        assert.ok(
          fallbackElapsed < 5_000,
          `outage fallback request took ${fallbackElapsed.toFixed(0)}ms (bounded, expected < 5000ms)`,
        );

        const capability = await serve.cacheComposition.capabilityReadiness();
        assert.equal(capability.status, 'degraded', 'capability readiness must stay degraded during the outage');
      } finally {
        // Restore the redis-server process inside the same container.
        await restoreRedisServer(redis.container);
      }

      // Recovery: the health probe returns to healthy (the probe is the
      // half-open recovery signal), readiness follows, and a subsequent miss
      // writes the cache again.
      await waitUntil(
        async () => (await serve.store?.health()) === 'healthy',
        45_000,
        'store healthy after the redis restart',
        100,
      );
      assert.equal(await serve.cacheComposition.readiness(), 'healthy',
        'composition readiness must auto-return to healthy after recovery');

      serve.counters.reset();
      serve.store.reset();
      const recoveredMiss = await getMetadata(serve, fixture.collectionId);
      assert.equal(recoveredMiss.statusCode, 200);
      assert.equal(serve.counters.metadata.calls.load, 1, 'post-recovery cold miss loads origin once');
      assert.equal(serve.store.counts.set, 1, 'post-recovery miss must write the cache again');
      assert.deepEqual(recoveredMiss.bytes, reference.bytes, 'post-recovery body must equal the off reference');

      serve.counters.reset();
      serve.store.reset();
      const recoveredHit = await getMetadata(serve, fixture.collectionId);
      assert.equal(recoveredHit.statusCode, 200);
      assert.equal(serve.counters.metadata.calls.load, 0, 'post-recovery warm hit loads origin zero times');
      assert.equal(serve.store.counts.set, 0, 'post-recovery warm hit does not write Redis');
      assert.ok(serve.store.counts.get >= 2, 'post-recovery warm hit still issues Redis GETs');
      assert.deepEqual(recoveredHit.bytes, reference.bytes, 'post-recovery warm hit body must equal the off reference');
    } finally {
      await serve.close();
      await off.close();
    }
  }, 120_000);

  test('Redis outage concurrency is capped by the production fallback bulkhead', async () => {
    const scope: E2ETestScope = newE2ETestScope();
    let releaseLoads!: () => void;
    const loadGate = new Promise<void>((resolve) => { releaseLoads = resolve; });
    const serve = composeApi(
      scope,
      'serve',
      { databaseUrl: isolated.databaseUrl, runtime, redisUrl: redis.url, cursorKeys },
      {
        breakerFailureThreshold: 1,
        breakerCooldownMs: 60_000,
        bulkheadCapacity: 2,
        metadataLoadGate: () => loadGate,
      },
    );
    try {
      await waitForCacheHealth(serve);
      assert.ok(serve.store);
      const fixture = await insertPublishedCollection({ pool: runtime.pool, ownerSubjectId: scope.ownerSubject });
      const shutdown = await redis.container.exec(['redis-cli', 'shutdown', 'nosave']);
      if (shutdown.exitCode !== 0) throw new Error(`redis-cli shutdown failed: ${shutdown.output}`);
      try {
        await waitUntil(
          async () => {
            try {
              await serve.store!.get(`bulkhead-probe-${scope.suffix}`, new AbortController().signal);
              return false;
            } catch {
              return true;
            }
          },
          10_000,
          'cache commands to fail before bulkhead concurrency test',
          50,
        );

        serve.counters.reset();
        serve.store.reset();
        const requests = Array.from({ length: 6 }, () => getMetadata(serve, fixture.collectionId));
        await waitUntil(
          () => serve.counters.metadata.calls.load === 2,
          10_000,
          'exactly two origin loads to occupy the fallback bulkhead',
          10,
        );
        releaseLoads();
        const responses = await Promise.all(requests);
        assert.equal(serve.counters.metadata.calls.load, 2,
          'requests above bulkhead capacity must not start PostgreSQL loads');
        assert.equal(responses.filter((response) => response.statusCode === 200).length, 2);
        // T-10 (RDS-04): bulkhead saturation during a Redis outage is bounded
        // overload — a retryable 503 with Retry-After, never a 500.
        const rejected = responses.filter((response) => response.statusCode === 503);
        assert.equal(rejected.length, 4);
        for (const response of rejected) {
          assert.equal(response.retryAfter, '1');
        }
        assert.equal((await serve.cacheComposition.capabilityReadiness()).circuitState, 'open');

        const getsBeforeOpenBypass = serve.store.counts.get;
        const openBypass = await getMetadata(serve, fixture.collectionId);
        assert.equal(openBypass.statusCode, 200);
        assert.equal(serve.store.counts.get, getsBeforeOpenBypass,
          'open breaker must skip the epoch Redis read');
      } finally {
        releaseLoads();
        await restoreRedisServer(redis.container);
      }
    } finally {
      await serve.close();
    }
  }, 120_000);
});
