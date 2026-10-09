/**
 * P6 Redis + PostgreSQL end-to-end for library collection bookmarkCount
 * (library-collection-bookmark-count-plan.md §5.2 / §7 P6 / §8.1 E2E / §8.2 /
 * §8.4 / §2 #8 fail closed).
 *
 * Proves the HTTP owned-list path reads Redis first; after contentRevision
 * change the old key is unreachable; Redis outage fail-opens with bounded
 * commands. Dedicated Testcontainers Redis + random key prefix; never
 * FLUSHALL/FLUSHDB; never a developer REDIS_URL. Docker/Testcontainers Redis
 * cannot start → throw (T13 fail-closed).
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  startRedisE2EContainer,
  waitUntil,
  type RedisE2EContainer,
} from '../../support/redis-cache-e2e.js';
import {
  asOwnedList,
  bookmarkCountCacheDataKey,
  bookmarkCountsById,
  composeBookmarkCountApi,
  createBookmarkHttp,
  createOwnedCollectionHttp,
  currentContentRevision,
  insertCollectionMember,
  insertOwnedEmptyCollection,
  insertOwnedNestedBookmarkCollection,
  itemFor,
  listOwnedCollections,
  loginBookmarkCountBrowser,
  newBookmarkCountE2EScope,
  redisCommandTotal,
  waitForBookmarkCountCacheHealth,
  type BookmarkCountComposedApi,
} from '../../support/collection-bookmark-count-cache-e2e.js';

const PRIVATE_NO_STORE = 'private, no-store';

describeWithPostgres('collection bookmark-count cache end-to-end against real PostgreSQL (P6)', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let redis: RedisE2EContainer;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p6_bookmark_count_cache', {
      maxConnections: 8,
      applicationName: 'known-p6-bookmark-count-cache',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    redis = await startRedisE2EContainer();
  }, 240_000);

  afterAll(async () => {
    const errors: unknown[] = [];
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
      throw new Error(`P6 cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  function serveApp(scope = newBookmarkCountE2EScope()): BookmarkCountComposedApi {
    return composeBookmarkCountApi(scope, 'serve', {
      databaseUrl: isolated.databaseUrl,
      runtime,
      redisUrl: redis.url,
    });
  }

  function offApp(scope = newBookmarkCountE2EScope()): BookmarkCountComposedApi {
    return composeBookmarkCountApi(scope, 'off', {
      databaseUrl: isolated.databaseUrl,
      runtime,
      redisUrl: null,
    });
  }

  test('cold miss loads origin COUNT once; warm hit COUNT=0, GET>=N, bookmarkCount JSON equal', async () => {
    const serve = serveApp();
    try {
      await waitForBookmarkCountCacheHealth(serve);
      assert.ok(serve.store);
      const owner = await loginBookmarkCountBrowser(serve, serve.scope.ownerSubject);
      const nested = await insertOwnedNestedBookmarkCollection(runtime.pool, owner.subjectId);
      const empty = await insertOwnedEmptyCollection(runtime.pool, owner.subjectId);
      const pageSize = 2;

      serve.resetMeasured();
      const cold = await listOwnedCollections(serve, owner.cookie);
      assert.equal(cold.statusCode, 200);
      assert.equal(cold.cacheControl, PRIVATE_NO_STORE);
      const coldList = asOwnedList(cold.body);
      assert.equal(coldList.items.length, pageSize);
      assert.equal(itemFor(coldList, nested.collectionId).bookmarkCount, 5);
      assert.equal(itemFor(coldList, empty.collectionId).bookmarkCount, 0);
      assert.equal(serve.origin.calls, 1, 'cold list must issue one batch COUNT');
      assert.deepEqual(
        new Set(serve.origin.ids[0]),
        new Set([nested.collectionId, empty.collectionId]),
      );
      assert.ok(serve.store.counts.set >= pageSize, 'cold miss must SET each page collection');
      const coldCounts = bookmarkCountsById(coldList);

      serve.resetMeasured();
      const warm = await listOwnedCollections(serve, owner.cookie);
      assert.equal(warm.statusCode, 200);
      assert.equal(warm.cacheControl, PRIVATE_NO_STORE);
      const warmList = asOwnedList(warm.body);
      assert.equal(serve.origin.calls, 0, 'warm hit must not call origin countBookmarks');
      assert.equal(serve.store.counts.set, 0, 'warm hit must not SET');
      assert.ok(
        serve.store.counts.get >= pageSize,
        `warm hit Redis GET must be >= page size ${pageSize}, got ${serve.store.counts.get}`,
      );
      assert.deepEqual(bookmarkCountsById(warmList), coldCounts);
    } finally {
      await serve.close();
    }
  }, 90_000);

  test('creating a bookmark changes contentRevision; old key is unused; COUNT runs; bookmarkCount +1', async () => {
    const serve = serveApp();
    try {
      await waitForBookmarkCountCacheHealth(serve);
      assert.ok(serve.store);
      const owner = await loginBookmarkCountBrowser(serve, serve.scope.ownerSubject);
      const created = await createOwnedCollectionHttp(serve, owner, 'P6 revision bump');
      await createBookmarkHttp(
        serve, owner, created.id, created.rootId, 'First bookmark', 'https://example.test/p6/first',
      );
      const oldRevision = await currentContentRevision(runtime.pool, created.id);
      assert.notEqual(oldRevision, created.contentRevision);
      const oldKey = bookmarkCountCacheDataKey(serve.scope, created.id, oldRevision);

      serve.resetMeasured();
      const baseline = await listOwnedCollections(serve, owner.cookie);
      assert.equal(baseline.statusCode, 200);
      const baselineList = asOwnedList(baseline.body);
      assert.equal(itemFor(baselineList, created.id).bookmarkCount, 1);
      assert.equal(serve.origin.calls, 1, 'first list after create is a miss');
      assert.ok(serve.store.counts.set >= 1, 'miss must SET the current revision key');

      await createBookmarkHttp(
        serve, owner, created.id, created.rootId, 'Second bookmark', 'https://example.test/p6/second',
      );
      const newRevision = await currentContentRevision(runtime.pool, created.id);
      assert.notEqual(newRevision, oldRevision, 'node create must bump contentRevision');
      const newKey = bookmarkCountCacheDataKey(serve.scope, created.id, newRevision);
      assert.notEqual(newKey, oldKey, 'production key builder must isolate revisions');

      serve.resetMeasured();
      const after = await listOwnedCollections(serve, owner.cookie);
      assert.equal(after.statusCode, 200);
      const afterList = asOwnedList(after.body);
      assert.equal(itemFor(afterList, created.id).bookmarkCount, 2);
      assert.equal(itemFor(afterList, created.id).collection.contentRevision, newRevision);
      assert.equal(serve.origin.calls, 1, 'new revision is a miss and must COUNT');
      assert.ok(serve.store.counts.set >= 1, 'new revision miss must SET');
      assert.equal(
        serve.store.getKeys.includes(oldKey),
        false,
        'old (collectionId, oldRevision) key must not be read as the result',
      );
      assert.ok(
        serve.store.getKeys.includes(newKey),
        'list must GET the production key for the new contentRevision',
      );
    } finally {
      await serve.close();
    }
  }, 90_000);

  test('Redis stop fail-opens with origin COUNT and bounded commands; restore SET then warm loader=0', async () => {
    const serve = serveApp();
    const off = offApp();
    try {
      await waitForBookmarkCountCacheHealth(serve);
      assert.ok(serve.store);
      const owner = await loginBookmarkCountBrowser(serve, serve.scope.ownerSubject);
      const nested = await insertOwnedNestedBookmarkCollection(runtime.pool, owner.subjectId);
      const offOwner = await loginBookmarkCountBrowser(off, serve.scope.ownerSubject);
      const reference = await listOwnedCollections(off, offOwner.cookie);
      assert.equal(reference.statusCode, 200);
      assert.equal(itemFor(asOwnedList(reference.body), nested.collectionId).bookmarkCount, 5);

      serve.resetMeasured();
      const baselineMiss = await listOwnedCollections(serve, owner.cookie);
      assert.equal(baselineMiss.statusCode, 200);
      assert.equal(serve.origin.calls, 1, 'baseline cold miss COUNT once');
      assert.ok(serve.store.counts.set >= 1, 'baseline cold miss writes Redis');
      serve.resetMeasured();
      const baselineHit = await listOwnedCollections(serve, owner.cookie);
      assert.equal(baselineHit.statusCode, 200);
      assert.equal(serve.origin.calls, 0, 'baseline warm hit COUNT=0');

      await redis.shutdownServer();
      try {
        await waitUntil(
          async () => {
            try {
              await serve.store!.get(`p6-outage-probe-${serve.scope.suffix}`, new AbortController().signal);
              return false;
            } catch {
              return true;
            }
          },
          10_000,
          'cache commands to fail after the redis shutdown',
          50,
        );

        serve.resetMeasured();
        const fallback = await listOwnedCollections(serve, owner.cookie);
        assert.equal(fallback.statusCode, 200, 'list must still succeed during Redis outage');
        assert.equal(fallback.cacheControl, PRIVATE_NO_STORE);
        assert.equal(itemFor(asOwnedList(fallback.body), nested.collectionId).bookmarkCount, 5);
        assert.equal(serve.origin.calls, 1, 'outage fallback must COUNT once (no retry storm)');
        assert.equal(serve.store.counts.set, 0, 'outage fallback must not SET');
        const commands = redisCommandTotal(serve.store.counts);
        assert.ok(
          commands <= 8,
          `outage Redis commands ${commands} exceeded the bound (no retry storm)`,
        );
      } finally {
        await redis.restoreServer();
      }

      await waitUntil(
        async () => (await serve.store?.health()) === 'healthy',
        45_000,
        'store healthy after the redis restart',
        100,
      );

      serve.resetMeasured();
      const recoveredMiss = await listOwnedCollections(serve, owner.cookie);
      assert.equal(recoveredMiss.statusCode, 200);
      assert.equal(serve.origin.calls, 1, 'post-recovery miss must COUNT');
      assert.ok(serve.store.counts.set >= 1, 'post-recovery miss must SET');

      serve.resetMeasured();
      const recoveredHit = await listOwnedCollections(serve, owner.cookie);
      assert.equal(recoveredHit.statusCode, 200);
      assert.equal(serve.origin.calls, 0, 'post-recovery warm hit COUNT=0');
      assert.equal(serve.store.counts.set, 0);
      assert.equal(itemFor(asOwnedList(recoveredHit.body), nested.collectionId).bookmarkCount, 5);
    } finally {
      await serve.close();
      await off.close();
    }
  }, 120_000);

  test('unauthenticated GET is 401 with private no-store and does not SET another subject COUNT', async () => {
    const serve = serveApp();
    try {
      await waitForBookmarkCountCacheHealth(serve);
      assert.ok(serve.store);
      const owner = await loginBookmarkCountBrowser(serve, serve.scope.ownerSubject);
      const nested = await insertOwnedNestedBookmarkCollection(runtime.pool, owner.subjectId);

      serve.resetMeasured();
      const denied = await listOwnedCollections(serve);
      assert.equal(denied.statusCode, 401);
      assert.equal(denied.cacheControl, PRIVATE_NO_STORE);
      assert.equal(serve.origin.calls, 0, '401 must not call origin countBookmarks');
      assert.equal(serve.store.counts.set, 0, '401 must not SET another subject COUNT');
      assert.equal(
        serve.store.getKeys.some((key) => key.includes(`{col:${nested.collectionId}}`)),
        false,
        '401 must not address another subject collection cache key',
      );
    } finally {
      await serve.close();
    }
  }, 90_000);

  test('off vs serve bookmarkCount JSON is equal for the same fixture', async () => {
    const scope = newBookmarkCountE2EScope();
    const serve = composeBookmarkCountApi(scope, 'serve', {
      databaseUrl: isolated.databaseUrl,
      runtime,
      redisUrl: redis.url,
    });
    const off = composeBookmarkCountApi(scope, 'off', {
      databaseUrl: isolated.databaseUrl,
      runtime,
      redisUrl: null,
    });
    try {
      await waitForBookmarkCountCacheHealth(serve);
      const owner = await loginBookmarkCountBrowser(serve, scope.ownerSubject);
      const nested = await insertOwnedNestedBookmarkCollection(runtime.pool, owner.subjectId);
      const empty = await insertOwnedEmptyCollection(runtime.pool, owner.subjectId);
      const offOwner = await loginBookmarkCountBrowser(off, scope.ownerSubject);
      assert.equal(offOwner.subjectId, owner.subjectId);

      const offList = await listOwnedCollections(off, offOwner.cookie);
      assert.equal(offList.statusCode, 200);
      serve.resetMeasured();
      const serveList = await listOwnedCollections(serve, owner.cookie);
      assert.equal(serveList.statusCode, 200);
      assert.ok(serve.store && serve.store.counts.set >= 1, 'serve miss must SET');

      const offCounts = bookmarkCountsById(asOwnedList(offList.body));
      const serveCounts = bookmarkCountsById(asOwnedList(serveList.body));
      assert.deepEqual(serveCounts, offCounts);
      assert.equal(offCounts.get(nested.collectionId), 5);
      assert.equal(offCounts.get(empty.collectionId), 0);
    } finally {
      await serve.close();
      await off.close();
    }
  }, 90_000);

  test('policy-only membership leaves contentRevision unchanged and the second list is a cache hit', async () => {
    const serve = serveApp();
    try {
      await waitForBookmarkCountCacheHealth(serve);
      assert.ok(serve.store);
      const owner = await loginBookmarkCountBrowser(serve, serve.scope.ownerSubject);
      const member = await loginBookmarkCountBrowser(serve, serve.scope.memberSubject);
      const nested = await insertOwnedNestedBookmarkCollection(runtime.pool, owner.subjectId);

      serve.resetMeasured();
      const first = await listOwnedCollections(serve, owner.cookie);
      assert.equal(first.statusCode, 200);
      assert.equal(serve.origin.calls, 1);
      assert.ok(serve.store.counts.set >= 1, 'first list miss must SET');
      const revisionBefore = await currentContentRevision(runtime.pool, nested.collectionId);
      assert.equal(itemFor(asOwnedList(first.body), nested.collectionId).collection.contentRevision, revisionBefore);

      await insertCollectionMember(runtime.pool, nested.collectionId, member.subjectId, 'viewer');
      const revisionAfter = await currentContentRevision(runtime.pool, nested.collectionId);
      assert.equal(revisionAfter, revisionBefore, 'policy-only membership must not bump contentRevision');

      serve.resetMeasured();
      const second = await listOwnedCollections(serve, owner.cookie);
      assert.equal(second.statusCode, 200);
      assert.equal(serve.origin.calls, 0, 'unchanged revision must be a cache hit (COUNT=0)');
      assert.equal(serve.store.counts.set, 0);
      assert.ok(serve.store.counts.get >= 1);
      assert.equal(itemFor(asOwnedList(second.body), nested.collectionId).bookmarkCount, 5);
      assert.equal(
        itemFor(asOwnedList(second.body), nested.collectionId).collection.contentRevision,
        revisionBefore,
      );
    } finally {
      await serve.close();
    }
  }, 90_000);
});
