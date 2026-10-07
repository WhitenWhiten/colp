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
  createPostgresCommunityRankingRefreshUnitOfWork,
  createPostgresCommunityTargetQueryUnitOfWork,
  createPostgresCommunityVoteCommandUnitOfWork,
  createCommunityRankRefreshScheduler,
} from '../../../src/infrastructure/community/index.js';
import { refreshCommunityRanking } from '../../../src/modules/community/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const COLLECTION = 'ranking-it-collection';
const BOOKMARK = 'ranking-it-bookmark';
const SECOND = 'ranking-it-second';
const SERIES = 'ranking-it-series';
const EDITION = 'ranking-it-edition';
const PRIVATE_COLLECTION = 'ranking-it-private';

describeWithPostgres('CS-02 community ranking HTTP', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_ranking_http', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function seedCollection(
    collectionId: string,
    ownerSubjectId: string,
    visibility: 'public' | 'unlisted' | 'private' | 'protected',
    slug: string,
    title = 'Vote target',
  ): Promise<string> {
    const rootId = `root-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
        [collectionId, rootId],
      );
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at)
        values($1,$2,$6,'bookmarks',$5,$4,current_timestamp,$3,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, ownerSubjectId, rootId, slug, visibility, title]);
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
    return rootId;
  }

  async function seedBookmark(nodeId: string, collectionId: string, parentId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id,resource_type,committed_at)
       values($1,'node',current_timestamp)`, [nodeId]);
    await isolated.runtime.pool.query(`insert into nodes(
      id,collection_id,parent_id,kind,is_root,title,url,position_token,
      resource_revision,children_revision,created_at,updated_at)
      values($1,$2,$3,'bookmark',false,'Bookmark','https://example.com/one','a0','r1','ch1',
        current_timestamp,current_timestamp)`, [nodeId, collectionId, parentId]);
  }

  async function seedDigestSeries(seriesId: string, ownerSubjectId: string, slug: string): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'report',current_timestamp)`, [seriesId]);
      await client.query(`insert into digest_series(
        id,owner_subject_id,title,summary,slug,visibility,state,
        resource_revision,content_revision,policy_revision,commit_ordinal,
        created_at,updated_at)
        values($1,$2,'Digest','Weekly digest',$3,'public','active',
          'r1','c1','p1',1,current_timestamp,current_timestamp)`, [seriesId, ownerSubjectId, slug]);
      await client.query(`insert into digest_members(series_id,subject_id,role,granted_at)
        values($1,$2,'owner',current_timestamp)`, [seriesId, ownerSubjectId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedEdition(editionId: string, seriesId: string, sourceCollectionId: string): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'report',current_timestamp)`, [editionId]);
      await client.query(`insert into digest_editions(
        id,series_id,source_collection_id,issue_key,edition_ordinal,
        title_snapshot,summary_snapshot,source_content_revision,source_policy_revision,
        resource_revision,period_start,period_end,state,published_at,created_at,updated_at)
        values($1,$2,$3,'2026-W40',1,'Edition one','Summary','c1','p1','r1',
          current_timestamp - interval '7 days',current_timestamp,'published',current_timestamp,
          current_timestamp,current_timestamp)`, [editionId, seriesId, sourceCollectionId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  function config() {
    return loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64') });
  }

  /** Real worker composition: the production repository, router and envelope registry. */
  function workerConfig() {
    return loadConfig({ ...process.env, DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test', LOG_LEVEL: 'silent', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
      WORKER_CONCURRENCY: '2', WORKER_BATCH_SIZE: '2',
      /* Generous margins: a loaded CI host must be able to run a full
         ranking rebuild well inside the handler timeout, and the inner
         rebuild/recovery deadlines must trip before the handler does.
         A 50ms handler-to-lease gap was the pending-event flake source. */
      WORKER_POLL_INTERVAL_MS: '5', WORKER_LEASE_DURATION_MS: '5000',
      WORKER_HEARTBEAT_INTERVAL_MS: '250', WORKER_HANDLER_TIMEOUT_MS: '4500',
      FEED_REBUILD_TIMEOUT_MS: '4000', NOTIFICATION_RECOVERY_TIMEOUT_MS: '4000' });
  }

  interface RefreshEventRow {
    readonly outbox_id: string;
    readonly domain_event_id: string;
    readonly state: string;
    readonly commit_ordinal: string | null;
    readonly payload_json: { readonly reason?: string };
  }

  async function refreshEventRows(): Promise<readonly RefreshEventRow[]> {
    const result = await isolated.runtime.pool.query<RefreshEventRow>(
      `select outbox_id, domain_event_id, state, commit_ordinal::text, payload_json
       from outbox_events where event_type = 'community.rank-refresh'
       order by commit_ordinal`, []);
    return result.rows;
  }

  /** Drain one worker instance until no claimable event remains (bounded). */
  async function drainWorker(worker: { runOnce(): Promise<boolean> }, limit = 100): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      await isolated.runtime.pool.query(`update outbox_events set available_at=current_timestamp
        where state='retryable'`);
      if (!await worker.runOnce()) return;
    }
    throw new Error('community rank refresh worker drain exceeded its bounded test budget');
  }

  test('durable snapshot serves ranked pages, filters and snapshot pagination', async () => {
    const cfg = config();
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: cfg.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const owner = await issueTestSession({ factory,
      subject: `rank-owner-${randomUUID()}`, handle: `o${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const voterA = await issueTestSession({ factory,
      subject: `rank-a-${randomUUID()}`, handle: `a${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const voterB = await issueTestSession({ factory,
      subject: `rank-b-${randomUUID()}`, handle: `b${randomUUID().replaceAll('-', '').slice(0, 12)}` });

    const rootId = await seedCollection(COLLECTION, owner.subjectId, 'public', 'rank-target', 'Hot guide');
    await seedBookmark(BOOKMARK, COLLECTION, rootId);
    await seedCollection(SECOND, owner.subjectId, 'public', 'rank-second', 'Warm list');
    await seedCollection(PRIVATE_COLLECTION, owner.subjectId, 'private', 'rank-private');
    await seedDigestSeries(SERIES, owner.subjectId, 'rank-digest');
    await seedEdition(EDITION, SERIES, COLLECTION);

    const app = buildApiApp({ config: cfg, identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork: createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork: createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork: createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork: createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork: createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: cfg.community.cursorHmacKey,
      }),
      communityCommentManageUnitOfWork: createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
        etagHmacKey: cfg.community.cursorHmacKey,
      }),
      communityNotificationQueryUnitOfWork: createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork: createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: cfg.community.cursorHmacKey,
      }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const anonymous = createProductCommunityClient({ origin });
      const clientA = createProductCommunityClient({ origin, sessionCookie: voterA.cookie,
        originHeader: cfg.productOrigin, csrfToken: voterA.csrfToken });
      const clientB = createProductCommunityClient({ origin, sessionCookie: voterB.cookie,
        originHeader: cfg.productOrigin, csrfToken: voterB.csrfToken });

      // No snapshot yet: the page is an explicit empty hot-v1 page.
      const empty = await anonymous.listRanking({});
      assert.deepEqual(empty.items, []);
      assert.equal(empty.nextCursor, null);
      assert.equal(empty.scoreVersion, 'hot-v1');

      // Two upvotes on the collection, one on the series, one downvote on
      // the second collection; the bookmark and edition stay zero-vote.
      const target = (await clientA.resolveTarget({ kind: 'collection', id: COLLECTION })).target;
      await clientA.setVote({ target, value: 1 }, randomUUID());
      await clientB.setVote({ target, value: 1 }, randomUUID());
      const secondTarget = (await clientA.resolveTarget({ kind: 'collection', id: SECOND })).target;
      await clientA.setVote({ target: secondTarget, value: -1 }, randomUUID());
      const seriesTarget = (await clientA.resolveTarget({ kind: 'digest_series', id: SERIES })).target;
      await clientB.setVote({ target: seriesTarget, value: 1 }, randomUUID());

      // The vote command wrote the first-accepted-vote authority in its own
      // transaction.
      const firstVoteRows = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text count from community_vote_targets`, []);
      assert.ok(Number(firstVoteRows.rows[0]?.count) >= 3);

      // Durable rebuild: the projection is written from vote authority.
      const refresh = await createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db)
        .execute((ports) => refreshCommunityRanking(ports));
      assert.equal(refresh.scoreVersion, 'hot-v1');
      assert.ok(refresh.itemCount >= 5, `expected >= 5 eligible targets, got ${refresh.itemCount}`);

      const snapshotRow = await isolated.runtime.pool.query<{ count: string; entries: string }>(
        `select count(*)::text count,
          (select count(*)::text from community_rank_entries
             where snapshot_id = (select max(snapshot_id) from community_rank_snapshots)) entries
         from community_rank_snapshots`, []);
      assert.equal(snapshotRow.rows[0]?.entries, String(refresh.itemCount));

      const page = await anonymous.listRanking({});
      assert.equal(page.scoreVersion, 'hot-v1');
      const ids = page.items.map((item) => item.target.id);
      // hot DESC: the two-upvote collection outranks the one-vote series,
      // which outranks zero-vote rows, which outrank the downvoted row.
      assert.equal(ids[0], COLLECTION);
      assert.equal(ids[1], SERIES);
      assert.equal(ids[ids.length - 1], SECOND);
      assert.ok(ids.includes(BOOKMARK), 'zero-vote bookmark is ranked');
      assert.ok(ids.includes(EDITION), 'zero-vote edition is ranked');
      assert.ok(!ids.includes(PRIVATE_COLLECTION), 'private collection is never a candidate');
      const collectionItem = page.items.find((item) => item.target.id === COLLECTION)!;
      assert.equal(collectionItem.up, 2);
      assert.equal(collectionItem.down, 0);
      assert.ok(collectionItem.hot > 0);
      assert.ok(collectionItem.firstVoteAt !== null);
      const zeroVote = page.items.find((item) => item.target.id === BOOKMARK)!;
      assert.equal(zeroVote.hot, 0);
      assert.equal(zeroVote.firstVoteAt, null);

      // Filters precede page selection.
      const collectionsOnly = await anonymous.listRanking({ kind: 'collection' });
      assert.ok(collectionsOnly.items.every((item) => item.target.kind === 'collection'));
      const searched = await anonymous.listRanking({ q: 'hot guide' });
      assert.deepEqual(searched.items.map((item) => item.target.id), [COLLECTION]);

      // Opaque cursor pagination: page 1 of size 2 resumes into the rest.
      const first = await anonymous.listRanking({ limit: 2 });
      assert.equal(first.items.length, 2);
      assert.ok(first.nextCursor);
      const rest = await anonymous.listRanking({ limit: 2, cursor: first.nextCursor! });
      assert.deepEqual(rest.items.map((item) => item.target.id),
        page.items.slice(2, 4).map((item) => item.target.id));

      // Current visibility is re-proven per page: conceal the top target and
      // a fresh first page drops it without rescore. COLLECTION is also the
      // edition's SOURCE and the bookmark's parent: the shared live-source
      // predicate must drop both of them on the per-page re-proof AND on a
      // fresh refresh snapshot — resolver and candidate SQL stay in parity.
      await isolated.runtime.pool.query(
        `update collections set visibility='private' where id=$1`, [COLLECTION]);
      try {
        const concealed = await anonymous.listRanking({});
        assert.ok(!concealed.items.some((item) => item.target.id === COLLECTION));
        assert.ok(!concealed.items.some((item) => item.target.id === EDITION),
          'a privatized source conceals the edition on the per-page re-proof');
        assert.ok(!concealed.items.some((item) => item.target.id === BOOKMARK));
        assert.equal(concealed.items[0]?.target.id, SERIES);

        const hiddenRefresh = await createPostgresCommunityRankingRefreshUnitOfWork(
          isolated.runtime.db).execute((ports) => refreshCommunityRanking(ports));
        assert.equal(hiddenRefresh.itemCount, refresh.itemCount - 3,
          'collection + its bookmark + its sourced edition all leave the candidate set');
        const hiddenPage = await anonymous.listRanking({});
        assert.ok(!hiddenPage.items.some((item) =>
          item.target.id === COLLECTION || item.target.id === EDITION || item.target.id === BOOKMARK));
      } finally {
        await isolated.runtime.pool.query(
          `update collections set visibility='public' where id=$1`, [COLLECTION]);
      }
    } finally {
      await app.close();
    }
  }, 60_000);

  test('vote-produced refresh events deliver through the real outbox worker and refresh the served snapshot', async () => {
    const cfg = config();
    const metrics = new InMemoryMetrics();
    const workerRuntime = buildWorker(workerConfig(), isolated.runtime, metrics);
    const worker = workerRuntime.outbox!;
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: cfg.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const owner = await issueTestSession({ factory,
      subject: `rank-wowner-${randomUUID()}`, handle: `wo${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const voter = await issueTestSession({ factory,
      subject: `rank-wvoter-${randomUUID()}`, handle: `wv${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    const collectionId = 'ranking-it-worker-collection';
    await seedCollection(collectionId, owner.subjectId, 'public', 'rank-worker-target', 'Worker target');

    const app = buildApiApp({ config: cfg, identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork: createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork: createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork: createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork: createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork: createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: cfg.community.cursorHmacKey,
      }),
      communityCommentManageUnitOfWork: createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
        etagHmacKey: cfg.community.cursorHmacKey,
      }),
      communityNotificationQueryUnitOfWork: createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork: createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: cfg.community.cursorHmacKey,
      }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const anonymous = createProductCommunityClient({ origin });
      const client = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: cfg.productOrigin, csrfToken: voter.csrfToken });

      // Two vote commands inside their own transactions produce two pending
      // refresh events with distinct sequence ordinals.
      const target = (await client.resolveTarget({ kind: 'collection', id: collectionId })).target;
      await client.setVote({ target, value: 1 }, randomUUID());
      await client.setVote({ target: (await client.resolveTarget({ kind: 'collection', id: collectionId })).target, value: -1 }, randomUUID());

      const mine = (await refreshEventRows()).filter((row) =>
        row.payload_json.reason === 'vote');
      assert.ok(mine.length >= 2, 'vote commands must enqueue pending refresh events');
      for (const row of mine) {
        assert.ok(row.commit_ordinal !== null && BigInt(row.commit_ordinal) > 0n,
          'projection_latest_only events must carry a real positive commit ordinal');
      }
      const ordinals = [...new Set(mine.map((row) => row.commit_ordinal))];
      assert.equal(ordinals.length, mine.length, 'every refresh event draws a distinct ordinal');

      // Real claim → real route → durable rebuild → complete + watermark.
      await drainWorker(worker);
      const delivered = await refreshEventRows();
      for (const row of delivered) {
        assert.equal(row.state, 'completed', `event ${row.outbox_id} must complete`);
      }
      const topOrdinal = delivered.map((row) => BigInt(row.commit_ordinal!))
        .reduce((max, value) => (value > max ? value : max));
      const watermark = await isolated.runtime.pool.query<{ commit_ordinal: string }>(
        `select commit_ordinal::text from outbox_projection_watermarks
         where handler_name = 'community.hot-ranking-refresh' and aggregate_id = 'community-ranking'`, []);
      assert.equal(watermark.rows[0]?.commit_ordinal, String(topOrdinal),
        'the projection watermark advances to the newest delivered ordinal');

      // The rebuilt snapshot is readable through the same read path the HTTP
      // surface uses: the latest snapshot wins, with the downvote reflected.
      const page = await anonymous.listRanking({});
      const item = page.items.find((entry) => entry.target.id === collectionId);
      assert.ok(item, 'the worker-refreshed snapshot must serve the voted target');
      assert.equal(item.down, 1);

      // The latest_only watermark skip: a stale event re-queued under an
      // ordinal the watermark already covers completes without a rebuild.
      const stale = delivered[0]!;
      await isolated.runtime.pool.query(
        `update outbox_events set state='retryable', available_at=current_timestamp,
           locked_until=null, completed_at=null, last_error=null
         where outbox_id=$1`, [stale.outbox_id]);
      assert.equal(await worker.runOnce(), true);
      const skipped = await isolated.runtime.pool.query<{ state: string }>(
        `select state from outbox_events where outbox_id=$1`, [stale.outbox_id]);
      assert.equal(skipped.rows[0]?.state, 'completed');
      assert.ok(metrics.get('outbox.obsolete_skipped') >= 1,
        'a stale re-queued ordinal must be obsolete-skipped, not rebuilt');
    } finally {
      await app.close();
      await worker.stop();
    }
  }, 60_000);

  test('the durable scheduler enqueues at most one pending refresh event', async () => {
    const scheduler = createCommunityRankRefreshScheduler({
      db: isolated.runtime.db, intervalMs: 60_000,
    });
    const before = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text count from outbox_events
        where event_type = 'community.rank-refresh'`, []);
    const first = await scheduler.runOnce();
    const second = await scheduler.runOnce();
    const after = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text count from outbox_events
        where event_type = 'community.rank-refresh'`, []);
    assert.equal(second, false, 'a pending refresh suppresses duplicates');
    assert.equal(Number(after.rows[0]?.count) - Number(before.rows[0]?.count),
      first ? 1 : 0);
    if (first) {
      // The scheduled enqueue path draws a real sequence ordinal like the
      // vote path — the projection_latest_only claim gate refuses nulls.
      const pending = await isolated.runtime.pool.query<{ commit_ordinal: string | null }>(
        `select commit_ordinal::text from outbox_events
          where event_type = 'community.rank-refresh' and state = 'pending'`, []);
      assert.equal(pending.rows.length, 1);
      assert.ok(pending.rows[0]!.commit_ordinal !== null
        && BigInt(pending.rows[0]!.commit_ordinal) > 0n);
    }
  }, 60_000);
});
