/**
 * T13 PostgreSQL + Redis end-to-end acceptance — normal chain
 * (plan 12-redis-hot-data-cache-plan.md §6.4 T13, §7.1 HTTP/PostgreSQL
 * integration layer, §7.2/§7.3 anti-false-positive/negative rules).
 *
 * Proves through the real HTTP/Application composition (`buildApiApp` +
 * T10 `createApiCacheComposition` + T06-T08 readers + real PostgreSQL read
 * ports + real Redis store + real config):
 *
 * 1. cold miss: first request loads origin exactly once and writes Redis;
 * 2. warm hit: second identical request loads origin zero times, still issues
 *    Redis GETs, and returns byte/ETag/cursor-equivalent body (never just a
 *    200);
 * 3. off/serve/shadow same-fixture reference: cache-served bytes/ETags are
 *    identical to the reference route;
 * 4. mutation -> real Outbox worker -> epoch invalidation: after the purge
 *    event is completed (not guessed with sleep), the anonymous read never
 *    returns the old epoch; worker replay of the same event is idempotent and
 *    never restores a historical epoch;
 * 5. authenticated owner/member isolation: with the anonymous key already
 *    warmed, authenticated requests still hit the authoritative read port with
 *    zero cache commands and never receive the anonymous cache value;
 * 6. real Snapshot pageCursor and snapshot_expired semantics are unchanged by
 *    the cache.
 *
 * Query counting (plan §6.4 T13): counters wrap only the three real
 * Publication read ports, so fixture setup, mutation writes, authentication
 * and Outbox polling can never leak into the measured window. Counters are
 * reset immediately before every measured request.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';

import {
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
} from '../../../src/infrastructure/outbox/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { loadConfig } from '../../support/test-config.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  composeApi,
  composeWorker,
  currentResourceRevision,
  drainOutbox,
  insertPublishedCollection,
  loginBrowser,
  mutationHeaders,
  newE2ETestScope,
  startRedisE2EContainer,
  strongEtag,
  waitForCacheHealth,
  waitForOutboxSettled,
  waitUntil,
  type ComposedApi,
  type E2ETestScope,
  type RedisE2EContainer,
} from '../../support/redis-cache-e2e.js';
import {
  assertEqualBytes,
  assertWarmHitContract,
  getPublication,
  metadataUrl,
  readDirectoryEpoch,
  readEpoch,
  snapshotUrl,
} from '../../support/publication-redis-cache-postgres-helpers.js';


describeWithPostgres('publication Redis cache end-to-end against real PostgreSQL (T13)', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let redis: RedisE2EContainer;
  let cursorKeys: ReturnType<typeof createPublicationCursorKeyring>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('t13_publication_redis_cache', {
      maxConnections: 8,
      applicationName: 'known-t13-publication-redis-cache',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    redis = await startRedisE2EContainer();
    cursorKeys = createPublicationCursorKeyring({
      active: { id: 't13-publication-v1', secret: Buffer.alloc(32, 92).toString('base64') },
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
      throw new Error(`T13 cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  function serveApp(scope: E2ETestScope): ComposedApi {
    return composeApi(scope, 'serve', { databaseUrl: isolated.databaseUrl, runtime, redisUrl: redis.url, cursorKeys });
  }

  function offApp(scope: E2ETestScope): ComposedApi {
    return composeApi(scope, 'off', { databaseUrl: isolated.databaseUrl, runtime, redisUrl: null, cursorKeys });
  }

  async function shadowApp(scope: E2ETestScope): Promise<ComposedApi> {
    const composed = composeApi(scope, 'shadow', { databaseUrl: isolated.databaseUrl, runtime, redisUrl: redis.url, cursorKeys });
    await waitForCacheHealth(composed);
    return composed;
  }

  test('metadata: cold miss loads PG once, warm hit loads zero and stays byte/ETag equivalent to the off reference', async () => {
    const scope = newE2ETestScope();
    const serve = serveApp(scope);
    const off = offApp(scope);
    try {
      const fixture = await insertPublishedCollection({ pool: runtime.pool, ownerSubjectId: scope.ownerSubject });
      const result = await assertWarmHitContract(
        serve, off, metadataUrl(fixture.collectionId), () => serve.counters.metadata.calls.load,
      );
      const body = result.hit.body as { collection: { title: string; revision: string }; links: Record<string, string> };
      assert.equal(body.collection.title, fixture.title);
      assert.equal(typeof body.collection.revision, 'string');
      assert.equal(typeof body.links.self, 'string');
    } finally {
      await serve.close();
      await off.close();
    }
  }, 90_000);

  test('directory: cold miss loads PG once, warm hit loads zero and stays byte/ETag equivalent to the off reference; cursor shape unchanged', async () => {
    const scope = newE2ETestScope();
    const serve = serveApp(scope);
    const off = offApp(scope);
    try {
      await insertPublishedCollection({ pool: runtime.pool, ownerSubjectId: scope.ownerSubject, title: 'Directory A' });
      await insertPublishedCollection({ pool: runtime.pool, ownerSubjectId: scope.ownerSubject, title: 'Directory B' });

      const url = '/colp/v0.1/directory';
      const result = await assertWarmHitContract(serve, off, url, () => serve.counters.directory.calls.loadPage);
      const body = result.hit.body as { collections: Array<{ title: string }>; nextCursor: string | null };
      assert.ok(body.collections.length >= 2, 'directory page must include both fixtures');
      assert.equal(body.nextCursor, null, 'default page (limit 50) has no continuation');

      // Non-default first page (limit=1) is never cached: loader runs and the
      // nextCursor/body stay identical to the off reference.
      const page = '/colp/v0.1/directory?limit=1';
      serve.counters.reset();
      const servePage = await getPublication(serve, page);
      const offPage = await getPublication(off, page);
      assert.equal(serve.counters.directory.calls.loadPage, 1, 'limit=1 directory page bypasses the cache');
      assertEqualBytes(servePage, offPage, 'directory limit=1 page vs off reference');
    } finally {
      await serve.close();
      await off.close();
    }
  }, 90_000);

  test('snapshot: cold miss loads PG once, warm hit loads zero and stays byte/ETag equivalent to the off reference', async () => {
    const scope = newE2ETestScope();
    const serve = serveApp(scope);
    const off = offApp(scope);
    try {
      const fixture = await insertPublishedCollection({ pool: runtime.pool, ownerSubjectId: scope.ownerSubject });
      const result = await assertWarmHitContract(
        serve, off, snapshotUrl(fixture.collectionId), () => serve.counters.snapshot.calls.loadPage,
      );
      const body = result.hit.body as {
        collection: { title: string; revision: string };
        nodes: Array<{ kind: string }>;
        page: { nextCursor: string | null };
      };
      assert.equal(body.collection.title, fixture.title);
      assert.ok(body.nodes.some((node) => node.kind === 'root'));
      assert.ok(body.nodes.some((node) => node.kind === 'bookmark'));
      assert.equal(body.page.nextCursor, null, 'default first page with 1 child has no continuation');
    } finally {
      await serve.close();
      await off.close();
    }
  }, 90_000);

  test('shadow mode returns the authoritative result, still writes the cache, and stays byte/ETag equivalent to off (same fixture)', async () => {
    const scope = newE2ETestScope();
    const shadow = await shadowApp(scope);
    const off = offApp(scope);
    try {
      const fixture = await insertPublishedCollection({ pool: runtime.pool, ownerSubjectId: scope.ownerSubject });
      const url = metadataUrl(fixture.collectionId);

      shadow.counters.reset();
      shadow.store?.reset();
      const first = await getPublication(shadow, url);
      assert.equal(first.statusCode, 200);
      assert.equal(shadow.counters.metadata.calls.load, 2,
        'shadow miss runs the cached loader and the authoritative origin (documented shadow cost)');
      assert.ok(shadow.store && shadow.store.counts.set >= 1, 'shadow miss must write Redis');

      const reference = await getPublication(off, url);
      assertEqualBytes(first, reference, 'shadow result vs off reference');
    } finally {
      await shadow.close();
      await off.close();
    }
  }, 90_000);

  test('mutation -> real Outbox worker -> epoch invalidation: old epoch is unreachable and worker replay stays idempotent', async () => {
    const scope = newE2ETestScope();
    const serve = serveApp(scope);
    const off = offApp(scope);
    let worker: ReturnType<typeof composeWorker> | undefined;
    try {
      await waitForCacheHealth(serve);
      // Login the owner first: the Better Auth factory mints a fresh opaque
      // local subject_id, so the fixture must use the account's real subject
      // to pass the real ownership authorization gate.
      const owner = await loginBrowser(serve, scope.ownerSubject);
      const fixture = await insertPublishedCollection({ pool: runtime.pool, ownerSubjectId: owner.subjectId });
      const metadataUrlValue = metadataUrl(fixture.collectionId);
      const directoryUrl = '/colp/v0.1/directory';
      const snapshotUrlValue = snapshotUrl(fixture.collectionId);

      // Warm all three anonymous domains (cold miss then warm hit).
      const warm = await assertWarmHitContract(serve, off, metadataUrlValue, () => serve.counters.metadata.calls.load);
      await assertWarmHitContract(serve, off, directoryUrl, () => serve.counters.directory.calls.loadPage);
      await assertWarmHitContract(serve, off, snapshotUrlValue, () => serve.counters.snapshot.calls.loadPage);

      // Real mutation through the real HTTP route: title update on the
      // published collection (commits the canonical transaction + outbox rows).
      const patched = await serve.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${fixture.collectionId}`,
        headers: {
          ...mutationHeaders(owner, `${randomUUID()}`, 'application/merge-patch+json'),
          'if-match': strongEtag(fixture.resourceRevision),
        },
        payload: { title: 'T13 updated title' },
      });
      assert.equal(patched.statusCode, 200, `PATCH must succeed: ${patched.statusCode} ${patched.body}`);

      const purgeRows = await runtime.pool.query<{ outbox_id: string; domain_event_id: string; state: string }>(
        `select outbox_id, domain_event_id, state from outbox_events
          where aggregate_scope = $1 and handler_name = $2 order by outbox_id`,
        [fixture.collectionId, PUBLICATION_CACHE_PURGE_HANDLER_NAME],
      );
      assert.ok((purgeRows.rowCount ?? 0) >= 1, 'the mutation must enqueue a publication.cache_purge.requested event');

      // Process through the real worker: projection sink + social routes +
      // composite purge provider with a worker-owned Redis store.
      worker = composeWorker(scope, isolated.databaseUrl, redis.url);
      await waitUntil(
        async () => (await worker?.store.health()) === 'healthy',
        15_000,
        'worker cache store healthy',
        50,
      );
      await drainOutbox(worker.worker);
      await waitForOutboxSettled(runtime.pool, fixture.collectionId);

      const completed = await runtime.pool.query<{ state: string; attempt_count: number; receipt_count: number }>(
        `select o.state, o.attempt_count,
           (select count(*)::int from outbox_delivery_receipts r
             where r.handler_name = $2 and r.domain_event_id = o.domain_event_id) as receipt_count
           from outbox_events o
          where o.aggregate_scope = $1 and o.handler_name = $2`,
        [fixture.collectionId, PUBLICATION_CACHE_PURGE_HANDLER_NAME],
      );
      for (const row of completed.rows) {
        assert.equal(row.state, 'completed', 'purge event must be completed, never guessed by sleep');
        assert.equal(row.receipt_count, 1, 'purge event must carry exactly one delivery receipt');
      }

      // The epoch must have been rotated at least once (read through the
      // worker-owned store using the production key builder).
      const collectionEpochAfterFirst = await readEpoch(scope, fixture.collectionId, worker.store);
      assert.ok(collectionEpochAfterFirst >= 1, 'collection epoch must be rotated by the worker');
      const directoryEpochAfterFirst = await readDirectoryEpoch(scope, worker.store);
      assert.ok(directoryEpochAfterFirst >= 1, 'directory epoch must be rotated by the worker');

      // After the worker completes, the anonymous read must not return the old
      // epoch: it re-loads origin and serves the new title.
      serve.counters.reset();
      const afterInvalidation = await getPublication(serve, metadataUrlValue);
      assert.equal(afterInvalidation.statusCode, 200);
      assert.equal(serve.counters.metadata.calls.load, 1, 'post-invalidation read must reload origin');
      const afterBody = afterInvalidation.body as { collection: { title: string } };
      assert.equal(afterBody.collection.title, 'T13 updated title', 'old cached title must be unreachable');
      assert.notEqual(afterInvalidation.etag, warm.miss.etag, 'post-invalidation ETag must differ from the old epoch');

      // Directory and snapshot also reflect the new title (the same mutation
      // invalidates metadata + snapshot + directory epochs).
      const directoryAfter = await getPublication(serve, directoryUrl);
      const directoryBody = directoryAfter.body as { collections: Array<{ title: string }> };
      assert.ok(
        directoryBody.collections.some((item) => item.title === 'T13 updated title'),
        'directory must reflect the mutated title',
      );
      const snapshotAfter = await getPublication(serve, snapshotUrlValue);
      const snapshotBody = snapshotAfter.body as { collection: { title: string } };
      assert.equal(snapshotBody.collection.title, 'T13 updated title');

      // Replay semantics (plan §6.4 T13 "worker 重放同一 event 不产生错误"):
      // (a) receipt-guarded redelivery — the event is re-made pending but the
      //     delivery receipt still exists, so the worker skips the provider
      //     (idempotent no-op) and completes without error, leaving the epoch
      //     untouched; (b) crash-before-complete redelivery — the receipt is
      //     cleared so the provider runs again, the epoch strictly advances
      //     and the old epoch is never restored.
      await runtime.pool.query(
        `update outbox_events
            set state = 'pending', attempt_count = 0, lease_generation = 0,
                available_at = current_timestamp - interval '1 second', locked_until = null
          where aggregate_scope = $1 and handler_name = $2`,
        [fixture.collectionId, PUBLICATION_CACHE_PURGE_HANDLER_NAME],
      );
      const epochBeforeReceiptGuard = await readEpoch(scope, fixture.collectionId, worker.store);
      await drainOutbox(worker.worker);
      await waitForOutboxSettled(runtime.pool, fixture.collectionId);
      const guarded = await runtime.pool.query<{ state: string }>(
        `select state from outbox_events
          where aggregate_scope = $1 and handler_name = $2`,
        [fixture.collectionId, PUBLICATION_CACHE_PURGE_HANDLER_NAME],
      );
      for (const row of guarded.rows) {
        assert.equal(row.state, 'completed', 'receipt-guarded replay must complete without error');
      }
      const epochAfterReceiptGuard = await readEpoch(scope, fixture.collectionId, worker.store);
      assert.equal(epochAfterReceiptGuard, epochBeforeReceiptGuard,
        'receipt-guarded replay must not re-run the provider (delivery already acknowledged)');

      // Crash-before-complete redelivery: clear the receipts so the provider
      // effect runs again. The epoch advances monotonically and the old value
      // stays unreachable.
      await runtime.pool.query(
        `delete from outbox_delivery_receipts
          where handler_name = $1 and domain_event_id in (
            select domain_event_id from outbox_events
             where aggregate_scope = $2 and handler_name = $1
          )`,
        [PUBLICATION_CACHE_PURGE_HANDLER_NAME, fixture.collectionId],
      );
      await runtime.pool.query(
        `update outbox_events
            set state = 'pending', attempt_count = 0, lease_generation = 0,
                available_at = current_timestamp - interval '1 second', locked_until = null
          where aggregate_scope = $1 and handler_name = $2`,
        [fixture.collectionId, PUBLICATION_CACHE_PURGE_HANDLER_NAME],
      );
      await drainOutbox(worker.worker);
      await waitForOutboxSettled(runtime.pool, fixture.collectionId);
      const redelivered = await runtime.pool.query<{ state: string; receipt_count: number }>(
        `select o.state,
           (select count(*)::int from outbox_delivery_receipts r
             where r.handler_name = $2 and r.domain_event_id = o.domain_event_id) as receipt_count
           from outbox_events o
          where o.aggregate_scope = $1 and o.handler_name = $2`,
        [fixture.collectionId, PUBLICATION_CACHE_PURGE_HANDLER_NAME],
      );
      for (const row of redelivered.rows) {
        assert.equal(row.state, 'completed', 'crash-before-complete redelivery must complete');
        assert.equal(row.receipt_count, 1, 'redelivery must re-insert exactly one receipt');
      }
      const collectionEpochAfterReplay = await readEpoch(scope, fixture.collectionId, worker.store);
      assert.ok(
        collectionEpochAfterReplay > collectionEpochAfterFirst,
        `redelivery must strictly advance the epoch (${collectionEpochAfterFirst} -> ${collectionEpochAfterReplay})`,
      );

      const afterReplay = await getPublication(serve, metadataUrlValue);
      const afterReplayBody = afterReplay.body as { collection: { title: string } };
      assert.equal(afterReplayBody.collection.title, 'T13 updated title', 'old epoch must never be restored by replay');
      assert.notEqual(afterReplay.etag, warm.miss.etag);
    } finally {
      if (worker) await worker.worker.stop().catch(() => undefined);
      await serve.close();
      await off.close();
    }
  }, 180_000);

  test('authenticated owner/member bypass the warmed anonymous cache and read the authoritative port', async () => {
    const scope = newE2ETestScope();
    const serve = serveApp(scope);
    const off = offApp(scope);
    try {
      await waitForCacheHealth(serve);
      // Login owner + member first and use the accounts' real local subject ids
      // for the fixture so the member projection genuinely applies and the
      // authenticated reads are truly authorized principals.
      const owner = await loginBrowser(serve, scope.ownerSubject);
      const member = await loginBrowser(serve, scope.memberSubject);
      const fixture = await insertPublishedCollection({
        pool: runtime.pool,
        ownerSubjectId: owner.subjectId,
        memberSubjectId: member.subjectId,
      });
      const url = metadataUrl(fixture.collectionId);

      // Warm the anonymous public key (a hit proves it is present).
      const warmed = await assertWarmHitContract(serve, off, url, () => serve.counters.metadata.calls.load);
      const anonymousEtag = warmed.hit.etag;

      for (const client of [owner, member]) {
        serve.counters.reset();
        serve.store?.reset();
        const response = await getPublication(serve, url, {
          accept: 'application/json',
          cookie: client.cookie,
        });
        assert.equal(response.statusCode, 200, 'authenticated metadata read must succeed');
        assert.equal(serve.counters.metadata.calls.load, 1,
          'authenticated read must hit the authoritative read port even when the anonymous key is warm');
        assert.ok(serve.store, 'serve app owns a store');
        assert.equal(serve.store.counts.get, 0, 'authenticated read must issue zero cache commands');
        assert.equal(serve.store.counts.set, 0, 'authenticated read must never write the anonymous cache');
        assert.notEqual(response.etag, anonymousEtag,
          'authenticated member projection must not reuse the anonymous cache ETag');
      }

      // The authoritative member result must equal the off reference for the
      // same authenticated principal (never the cached anonymous body).
      const offOwner = await loginBrowser(off, scope.ownerSubject);
      const offResponse = await getPublication(off, url, {
        accept: 'application/json',
        cookie: offOwner.cookie,
      });
      const serveOwnerResponse = await getPublication(serve, url, {
        accept: 'application/json',
        cookie: owner.cookie,
      });
      assertEqualBytes(serveOwnerResponse, offResponse, 'authenticated owner vs off authenticated reference');

      // Snapshot isolation: owner request loads the authoritative snapshot
      // port with zero cache commands and a different ETag.
      const snapshotUrlValue = snapshotUrl(fixture.collectionId);
      await assertWarmHitContract(serve, off, snapshotUrlValue, () => serve.counters.snapshot.calls.loadPage);
      const anonymousSnapshot = await getPublication(serve, snapshotUrlValue);
      serve.counters.reset();
      serve.store?.reset();
      const ownerSnapshot = await getPublication(serve, snapshotUrlValue, {
        accept: 'application/json',
        cookie: owner.cookie,
      });
      assert.equal(ownerSnapshot.statusCode, 200);
      assert.equal(serve.counters.snapshot.calls.loadPage, 1,
        'authenticated snapshot read must load the authoritative port');
      assert.ok(serve.store, 'serve app owns a store (snapshot isolation)');
      assert.equal(serve.store.counts.get, 0, 'authenticated snapshot read must issue zero cache commands');
      assert.notEqual(ownerSnapshot.etag, anonymousSnapshot.etag,
        'authenticated snapshot must not reuse the anonymous snapshot ETag');
      // Directory isolation follows the same guard: the anonymous default page
      // is warm, yet the owner request loads the authoritative directory port
      // with zero cache commands and a member ETag.
      await assertWarmHitContract(serve, off, '/colp/v0.1/directory', () => serve.counters.directory.calls.loadPage);
      const anonymousDirectory = await getPublication(serve, '/colp/v0.1/directory');
      serve.counters.reset();
      serve.store?.reset();
      const ownerDirectory = await getPublication(serve, '/colp/v0.1/directory', {
        accept: 'application/json',
        cookie: owner.cookie,
      });
      assert.equal(ownerDirectory.statusCode, 200);
      assert.equal(serve.counters.directory.calls.loadPage, 1,
        'authenticated directory read must load the authoritative port');
      assert.equal(serve.store.counts.get, 0, 'authenticated directory read must issue zero cache commands');
      assert.notEqual(ownerDirectory.etag, anonymousDirectory.etag,
        'authenticated directory must not reuse the anonymous directory ETag');
    } finally {
      await serve.close();
      await off.close();
    }
  }, 120_000);

  test('real Snapshot pageCursor and snapshot_expired semantics are unchanged by the cache', async () => {
    const scope = newE2ETestScope();
    const serve = serveApp(scope);
    const off = offApp(scope);
    let worker: ReturnType<typeof composeWorker> | undefined;
    try {
      await waitForCacheHealth(serve);
      // Login the owner first: the OIDC callback assigns a fresh opaque local
      // subject_id, so the fixture must use the account's real subject for the
      // later mutation to pass the ownership gate.
      const owner = await loginBrowser(serve, scope.ownerSubject);
      // Two children so a non-default first page (limit=2, the minimum) exposes
      // a real continuation cursor (first page carries Root + one child).
      const fixture = await insertPublishedCollection({
        pool: runtime.pool,
        ownerSubjectId: owner.subjectId,
        childCount: 2,
      });
      const url = snapshotUrl(fixture.collectionId);

      // Non-default first page (limit=2) is never cached; the cursor and body
      // must be byte/ETag-equivalent to the off reference.
      const firstPage = `${url}?limit=2`;
      serve.counters.reset();
      const serveFirst = await getPublication(serve, firstPage);
      const offFirst = await getPublication(off, firstPage);
      assert.equal(serve.counters.snapshot.calls.loadPage, 1, 'limit=2 snapshot page must bypass the cache');
      assertEqualBytes(serveFirst, offFirst, 'snapshot limit=2 page vs off reference');
      const firstBody = serveFirst.body as { page: { nextCursor: string | null } };
      assert.ok(firstBody.page.nextCursor, 'limit=2 first page must expose a continuation cursor');

      // Continuation (pageCursor) is never cached either.
      const continuationUrl = `${url}?limit=2&pageCursor=${encodeURIComponent(firstBody.page.nextCursor)}`;
      serve.counters.reset();
      const serveContinuation = await getPublication(serve, continuationUrl);
      const offContinuation = await getPublication(off, continuationUrl);
      assert.ok(serve.counters.snapshot.calls.loadPage >= 1, 'snapshot continuation must bypass the cache');
      assertEqualBytes(serveContinuation, offContinuation, 'snapshot continuation vs off reference');

      // Mutate the title (bumps the collection revision) and process the
      // outbox so the continuation's signed revision no longer matches.
      const resourceRevision = await currentResourceRevision(runtime.pool, fixture.collectionId);
      const patched = await serve.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${fixture.collectionId}`,
        headers: {
          ...mutationHeaders(owner, `${randomUUID()}`, 'application/merge-patch+json'),
          'if-match': strongEtag(resourceRevision),
        },
        payload: { title: 'T13 snapshot expired title' },
      });
      assert.equal(patched.statusCode, 200, `PATCH must succeed: ${patched.statusCode} ${patched.body}`);
      worker = composeWorker(scope, isolated.databaseUrl, redis.url);
      await waitUntil(
        async () => (await worker?.store.health()) === 'healthy',
        15_000,
        'worker cache store healthy (snapshot test)',
        50,
      );
      await drainOutbox(worker.worker);
      await waitForOutboxSettled(runtime.pool, fixture.collectionId);

      // The old cursor must now produce snapshot_expired on both serve and off:
      // the cache never masks the error and never serves a stale continuation.
      const serveExpired = await getPublication(serve, continuationUrl);
      const offExpired = await getPublication(off, continuationUrl);
      assert.equal(serveExpired.statusCode, 409);
      assert.equal((serveExpired.body as { code: string }).code, 'snapshot_expired');
      assert.equal(offExpired.statusCode, 409);
      assert.equal((offExpired.body as { code: string }).code, 'snapshot_expired');
      assert.deepEqual(serveExpired.body, offExpired.body, 'snapshot_expired must be identical on serve and off');
    } finally {
      if (worker) await worker.worker.stop().catch(() => undefined);
      await serve.close();
      await off.close();
    }
  }, 180_000);

  test('an aborted request cancels the in-flight PostgreSQL query and rolls back the read transaction', async () => {
    // A dedicated connection holds an ACCESS EXCLUSIVE lock on `collections`,
    // so the next Publication read blocks deterministically inside PostgreSQL
    // (never a timing guess). Aborting the request must cancel that exact
    // backend: the read rejects with the abort reason — never a leaked
    // query_canceled/57014 database error and never a fabricated cache
    // failure — and the Snapshot transaction is rolled back so the pool
    // still serves reads afterwards.
    const lockClient = new Client({
      connectionString: isolated.databaseUrl,
      applicationName: 'known-t13-cancel-lock',
    });
    await lockClient.connect();
    try {
      await lockClient.query('begin');
      await lockClient.query('lock table collections in access exclusive mode');
      const blockedCollectionsQueryCount = async (): Promise<number> => {
        const result = await runtime.pool.query<{ pid: number }>(
          // pg_stat_activity.wait_event_type is the case-sensitive enum 'Lock'
          // for lock waits (not lowercase 'lock'); a wrong case can never match.
          `select pid from pg_stat_activity
            where state = 'active' and wait_event_type = 'Lock'
              and query like '%from collections%' and pid <> pg_backend_pid()`,
        );
        return result.rowCount ?? 0;
      };

      // Metadata: the single locator query blocks on the table lock.
      const metadataController = new AbortController();
      const metadataRead = createPostgresPublicationMetadataReadPort(runtime).load({
        collectionId: 't13-cancel-missing',
        signal: metadataController.signal,
      });
      await waitUntil(
        async () => (await blockedCollectionsQueryCount()) === 1,
        10_000,
        'metadata query blocked on the collections lock',
        50,
      );
      metadataController.abort();
      await assert.rejects(
        metadataRead,
        (error: unknown) => error === metadataController.signal.reason,
        'the aborted metadata read must reject with the abort reason',
      );
      await waitUntil(
        async () => (await blockedCollectionsQueryCount()) === 0,
        10_000,
        'cancelled metadata query settled',
        50,
      );

      // Snapshot: the repeatable-read fence query blocks; abort must cancel
      // the backend and roll the transaction back.
      const snapshotController = new AbortController();
      const snapshotRead = createPostgresPublicationSnapshotReadPort(runtime).loadPage({
        collectionId: 't13-cancel-missing',
        limit: 10,
        signal: snapshotController.signal,
      });
      await waitUntil(
        async () => (await blockedCollectionsQueryCount()) === 1,
        10_000,
        'snapshot fence query blocked on the collections lock',
        50,
      );
      snapshotController.abort();
      await assert.rejects(
        snapshotRead,
        (error: unknown) => error === snapshotController.signal.reason,
        'the aborted snapshot read must reject with the abort reason',
      );
      await waitUntil(
        async () => (await blockedCollectionsQueryCount()) === 0,
        10_000,
        'cancelled snapshot query settled',
        50,
      );
    } finally {
      await lockClient.query('rollback').catch(() => undefined);
      await lockClient.end();
    }

    // The pool still serves reads after both aborts: no leaked transaction and
    // no poisoned connection.
    const metadataAfter = await createPostgresPublicationMetadataReadPort(runtime).load({
      collectionId: 't13-cancel-missing',
    });
    assert.equal(metadataAfter, null);
    const snapshotAfter = await createPostgresPublicationSnapshotReadPort(runtime).loadPage({
      collectionId: 't13-cancel-missing',
      limit: 10,
    });
    assert.equal(snapshotAfter.collection, null);
    assert.equal(snapshotAfter.isolation, 'repeatable read');
  }, 90_000);
});

