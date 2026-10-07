import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createProductCommunityClient } from '../../../generated/openapi/product-v1.client.js';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCommunityCommentCommandUnitOfWork,
  createPostgresCommunityCommentManageUnitOfWork,
  createPostgresCommunityCommentQueryUnitOfWork,
  createPostgresCommunityNotificationCommandUnitOfWork,
  createPostgresCommunityNotificationQueryUnitOfWork,
  createPostgresCommunityRankingQueryUnitOfWork,
  createPostgresCommunityTargetQueryUnitOfWork,
  createPostgresCommunityVoteCommandUnitOfWork,
} from '../../../src/infrastructure/community/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/*
 * CS-03/CS-05 durable rank-refresh delivery across a real worker restart:
 *
 * - Vote commands transactionally append `community.rank-refresh` outbox
 *   events with positive commit ordinals (projection_latest_only).
 * - Worker process A drains only the oldest ordinal and stops; a second
 *   event left in an expired 'leased' state simulates a crashed claim.
 * - Worker process B — a fresh `buildWorker` on the same database —
 *   reclaims the expired lease, drains the rest of the backlog in ordinal
 *   order, and advances the projection watermark to the newest ordinal.
 * - Completed events are never re-delivered and the rebuilt snapshot
 *   reflects the final vote authority.
 */

describeWithPostgres('CS-03 rank-refresh worker restart durability', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_rank_restart', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  function testConfig() {
    return loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64') });
  }

  /** Real worker composition: the production repository, router and registry. */
  function workerConfig() {
    return loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', LOG_LEVEL: 'silent', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
      WORKER_CONCURRENCY: '2', WORKER_BATCH_SIZE: '2',
      WORKER_POLL_INTERVAL_MS: '5', WORKER_LEASE_DURATION_MS: '500',
      WORKER_HEARTBEAT_INTERVAL_MS: '100', WORKER_HANDLER_TIMEOUT_MS: '450',
      FEED_REBUILD_TIMEOUT_MS: '400', NOTIFICATION_RECOVERY_TIMEOUT_MS: '400' });
  }

  async function startApp(config: ReturnType<typeof testConfig>) {
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const app = buildApiApp({
      config,
      identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork:
        createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork:
        createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork:
        createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork:
        createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork:
        createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
          etagHmacKey: config.community.cursorHmacKey,
        }),
      communityCommentManageUnitOfWork:
        createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
          etagHmacKey: config.community.cursorHmacKey,
        }),
      communityNotificationQueryUnitOfWork:
        createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork:
        createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
          etagHmacKey: config.community.cursorHmacKey,
        }),
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, origin, factory };
  }

  async function seedCollection(collectionId: string, ownerSubjectId: string): Promise<void> {
    const rootId = `root-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
        [collectionId, rootId]);
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at)
        values($1,$2,$3,'bookmarks','public',$4,current_timestamp,$5,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, ownerSubjectId, 'Restart target', `rr-${collectionId}`, rootId]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp)`, [rootId, collectionId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  interface RefreshEventRow {
    readonly outbox_id: string;
    readonly state: string;
    readonly commit_ordinal: string | null;
  }

  async function refreshEventRows(): Promise<readonly RefreshEventRow[]> {
    const result = await isolated.runtime.pool.query<RefreshEventRow>(
      `select outbox_id, state, commit_ordinal::text
       from outbox_events
       where event_type = 'community.rank-refresh'
         and handler_name = 'community.hot-ranking-refresh'
       order by commit_ordinal`, []);
    return result.rows;
  }

  /** Drain one worker until no claimable event remains (bounded). */
  async function drainWorker(worker: { runOnce(): Promise<boolean> }, limit = 100): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      await isolated.runtime.pool.query(`update outbox_events set available_at=current_timestamp
        where state='retryable'`);
      if (!await worker.runOnce()) return;
    }
    throw new Error('community rank refresh worker drain exceeded its bounded test budget');
  }

  test('a restarted worker reclaims expired leases and drains the backlog in ordinal order', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    const metricsA = new InMemoryMetrics();
    const metricsB = new InMemoryMetrics();
    const runtimeA = buildWorker(workerConfig(), isolated.runtime, metricsA);
    const workerA = runtimeA.outbox!;
    const runtimeB = buildWorker(workerConfig(), isolated.runtime, metricsB);
    const workerB = runtimeB.outbox!;
    try {
      const owner = await issueTestSession({ factory,
        subject: `rr-owner-${randomUUID()}`,
        handle: `ro${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const voter = await issueTestSession({ factory,
        subject: `rr-voter-${randomUUID()}`,
        handle: `rv${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const collectionId = `rr-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await seedCollection(collectionId, owner.subjectId);

      const anonymous = createProductCommunityClient({ origin });
      const client = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: config.productOrigin, csrfToken: voter.csrfToken });

      // Three vote commands → three durable pending refresh events with
      // strictly increasing commit ordinals on the same projection aggregate.
      const target = (await client.resolveTarget(
        { kind: 'collection', id: collectionId })).target;
      await client.setVote({ target, value: 1 }, randomUUID());
      await client.setVote({ target, value: -1 }, randomUUID());
      await client.setVote({ target, value: 1 }, randomUUID());

      const events = await refreshEventRows();
      assert.equal(events.length, 3, 'each vote transactionally appends one refresh event');
      for (const row of events) {
        assert.equal(row.state, 'pending');
        assert.ok(row.commit_ordinal !== null && BigInt(row.commit_ordinal) > 0n);
      }
      const ordinals = events.map((row) => BigInt(row.commit_ordinal!));
      assert.ok(ordinals[0]! < ordinals[1]! && ordinals[1]! < ordinals[2]!,
        'projection_latest_only ordinals are strictly increasing');

      // Worker process A drains only the lowest ordinal, then the middle
      // event is left in an expired 'leased' state — the crashed-claim
      // shape a restart must reclaim — and A stops (process boundary).
      assert.equal(await workerA.runOnce(), true);
      const firstDone = (await refreshEventRows()).filter((row) => row.state === 'completed');
      assert.equal(firstDone.length, 1);
      assert.equal(firstDone[0]!.commit_ordinal, String(ordinals[0]!),
        'the oldest ordinal completes first — newer ordinals never overtake');
      await isolated.runtime.pool.query(
        `update outbox_events set state='leased',
           locked_until = current_timestamp - interval '1 second'
         where outbox_id = $1`, [events[1]!.outbox_id]);
      await workerA.stop();

      // Worker process B — a fresh composition on the same database —
      // reclaims the expired lease and finishes the backlog in order.
      await drainWorker(workerB);
      const delivered = await refreshEventRows();
      for (const row of delivered) {
        assert.equal(row.state, 'completed', `event ${row.outbox_id} must complete`);
      }
      const watermark = await isolated.runtime.pool.query<{ commit_ordinal: string }>(
        `select commit_ordinal::text from outbox_projection_watermarks
         where handler_name = 'community.hot-ranking-refresh'
           and aggregate_id = 'community-ranking'`, []);
      assert.equal(watermark.rows[0]?.commit_ordinal, String(ordinals[2]!),
        'the watermark advances to the newest delivered ordinal');

      // The rebuilt snapshot reflects the terminal vote authority (1 up).
      const page = await anonymous.listRanking({});
      const item = page.items.find((entry) => entry.target.id === collectionId);
      assert.ok(item, 'the restarted worker refresh must serve the voted target');
      assert.equal(item.up, 1);
      assert.equal(item.down, 0);

      // Restarted delivery is exactly-once: no pending/leased rows remain and
      // a completed event re-queued under a covered ordinal is obsolete-skipped.
      const remaining = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text count from outbox_events
         where event_type = 'community.rank-refresh' and state in ('pending','retryable','leased')`,
        []);
      assert.equal(remaining.rows[0]?.count, '0');
      await isolated.runtime.pool.query(
        `update outbox_events set state='retryable', available_at=current_timestamp,
           locked_until=null, completed_at=null, last_error=null
         where outbox_id=$1`, [events[0]!.outbox_id]);
      assert.equal(await workerB.runOnce(), true);
      const replayed = await isolated.runtime.pool.query<{ state: string }>(
        `select state from outbox_events where outbox_id=$1`, [events[0]!.outbox_id]);
      assert.equal(replayed.rows[0]?.state, 'completed',
        'a covered ordinal is obsolete-skipped, never reprojected');
      assert.equal(await workerB.runOnce(), false, 'nothing claimable remains');
    } finally {
      await workerA.stop().catch(() => undefined);
      await workerB.stop().catch(() => undefined);
      await app.close();
    }
  }, 60_000);
});
