import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  EventEnvelopeRegistry, OutboxRouter, PostgresOutboxRepository, VersionedOutboxWorker,
} from '../../../src/infrastructure/outbox/index.js';
import {
  createPostgresSocialFeedOperationsRepository,
  createPostgresSocialFeedProjectionRepository,
  createPostgresSocialFeedWorkerRepository,
  createSocialFeedWorkerRoutes,
  socialCollectionChangeEnvelopeRegistrations,
} from '../../../src/infrastructure/social/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  evaluateFeedCapabilityReadiness,
  rebuildFeedScopeForOperations,
  rebuildSocialFeedProjection,
  replayFeedDeadLettersForOperations,
} from '../../../src/modules/social/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

describeWithPostgres('P5-24 production Feed operations', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_feed_operations', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('reports handler-scoped queue/dead-letter age and replays dead letters without losing attempts', async () => {
    const pool = isolated.runtime.pool;
    await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      values('ops-ready','outbox',current_timestamp),('ops-dead','outbox',current_timestamp),
        ('ops-future','outbox',current_timestamp)`);
    for (const row of [{ id: 'ops-ready', state: 'retryable' },
      { id: 'ops-dead', state: 'dead_letter' },
      { id: 'ops-future', state: 'dead_letter' }]) {
      await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
        handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
        commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,
        dead_lettered_at,last_error) values($1,$1,'social.collection-change',2,
        'social.publish-collection-change','projection_latest_only','collection',$1,$1,'1',1,
        current_timestamp-interval '2 minutes','{}',$2,4,current_timestamp-interval '1 minute',3,
        case when $2='dead_letter' then current_timestamp-interval '30 seconds' end,$3)`,
      [row.id, row.state, row.id === 'ops-future' ? 'unknown event version 99' : 'stable failure']);
    }
    // FIX-L-057: the ops CLI replays through the application wrapper, which captures
    // scope evidence before and after, so production watermark rows are required.
    await pool.query(`insert into social_feed_watermarks(aggregate_scope)
      values('ops-dead'),('ops-future')`);
    const operations = createPostgresSocialFeedOperationsRepository(pool);
    const before = await operations.inspectStatus();
    assert.equal(before.retryCount, 1); assert.equal(before.deadLetterCount, 2);
    assert.equal(before.sourceHighCommitOrdinal, '1');
    assert.equal(before.watermarkHighCommitOrdinal, '0');
    assert.equal(before.maximumCommitLag, '1');
    assert.ok(before.oldestEligibleAgeMs >= 60_000);
    assert.ok(before.oldestDeadLetterAgeMs >= 30_000);
    const replayed = await replayFeedDeadLettersForOperations({ operations,
      aggregateScope: 'ops-dead', limit: 1 });
    assert.deepEqual(replayed.outboxIds, ['ops-dead']);
    assert.equal(replayed.beforeWatermark.aggregateScope, 'ops-dead');
    assert.deepEqual(replayed.beforeWatermark, replayed.afterWatermark);
    assert.deepEqual(replayed.beforeItemIds, []);
    assert.deepEqual(replayed.afterItemIds, []);
    const row = (await pool.query(`select state,attempt_count,lease_generation,last_error
      from outbox_events where outbox_id='ops-dead'`)).rows[0];
    assert.deepEqual(row, { state: 'retryable', attempt_count: 4,
      lease_generation: '3', last_error: 'stable failure' });
    assert.deepEqual((await replayFeedDeadLettersForOperations({ operations,
      aggregateScope: 'ops-future', limit: 1, allowUnknownFutureVersion: false }))
      .outboxIds, []);
    await pool.query(`update outbox_events set state='completed',completed_at=current_timestamp
      where outbox_id='ops-ready'`);
    const claim = await new PostgresOutboxRepository(pool).claim(5_000);
    assert.equal(claim?.outboxId, 'ops-dead');
    assert.equal(claim?.attemptCount, 5);
    assert.equal(claim?.leaseGeneration, '4');
  });

  test('captures complete watermark/item evidence and purge is inclusive, bounded, repeatable and rebuild-safe', async () => {
    const pool = isolated.runtime.pool;
    const projection = createPostgresSocialFeedProjectionRepository(pool);
    const operations = createPostgresSocialFeedOperationsRepository(pool);
    const cutoff = new Date(Date.now() - 86_400_000);
    await seedProfileAndCollection(isolated, 'recipient-live', 'actor-live', 'scope-live');
    await seedProfileAndCollection(isolated, 'recipient-rebuild', 'actor-rebuild', 'scope-rebuild');
    for (const [id, scope, retain] of [
      ['before', 'scope-live', new Date(cutoff.getTime() - 1).toISOString()],
      ['equal', 'scope-live', cutoff.toISOString()],
      ['after', 'scope-live', new Date(cutoff.getTime() + 1).toISOString()],
      ['protected', 'scope-rebuild', new Date(cutoff.getTime() - 3_600_000).toISOString()],
    ]) {
      await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
        values($1,'outbox',current_timestamp)`, [id]);
      await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
        handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
        commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,
        completed_at) values($1,$1,'social.collection-change',2,
        'social.publish-collection-change','projection_latest_only','collection',$2,$2,'1',1,
        $3::timestamptz-interval '90 days','{}','completed',1,current_timestamp,1,current_timestamp)`,
      [id, scope, retain]);
      await pool.query(`insert into social_feed_items(feed_item_id,source_event_id,kind,
      recipient_profile_id,actor_profile_id,collection_id,source_event_version,
      source_commit_ordinal,publication_revision,discoverability_recheck_key,published_at,retain_until)
      values($1,$1,'collection_change','recipient-' || split_part($2,'-',2),
      'actor-' || split_part($2,'-',2),$2,2,1,'r1','publication.collection:' || $2,
      $3::timestamptz-interval '90 days',$3)`, [id, scope, retain]);
    }
    await pool.query(`insert into social_feed_watermarks(aggregate_scope)
      values('scope-live'),('scope-rebuild')`);
    await pool.query(`update social_feed_watermarks set last_commit_ordinal=1,
      last_source_event_id='before',state_revision=state_revision+1 where aggregate_scope='scope-live'`);
    await pool.query(`update social_feed_watermarks set last_commit_ordinal=1,
      last_source_event_id='protected',state_revision=state_revision+1
      where aggregate_scope='scope-rebuild'`);
    await pool.query(`update social_feed_watermarks set projection_state='rebuilding',
      rebuild_generation=rebuild_generation+1,rebuild_high_commit_ordinal=1,
      rebuild_high_source_event_id='protected',rebuild_replayed_commit_ordinal=0,
      rebuild_started_at=current_timestamp,state_revision=state_revision+1
      where aggregate_scope='scope-rebuild'`);
    const before = await operations.captureScope('scope-live');
    assert.deepEqual(before.itemIds, ['after', 'before', 'equal']);
    const first = await projection.purgeExpiredItems({ cutoff, limit: 1,
      aggregateScope: 'scope-live' });
    const second = await projection.purgeExpiredItems({ cutoff, limit: 10,
      aggregateScope: 'scope-live' });
    const third = await projection.purgeExpiredItems({ cutoff, limit: 10,
      aggregateScope: 'scope-live' });
    assert.equal(first.deletedCount, 1); assert.equal(second.deletedCount, 1);
    assert.equal(third.deletedCount, 0);
    assert.deepEqual((await operations.captureScope('scope-live')).itemIds, ['after']);
    assert.deepEqual((await operations.captureScope('scope-rebuild')).itemIds, ['protected']);
    assert.equal((await operations.captureScope('scope-live')).watermark.lastCommitOrdinal, '1');
  });

  test('paged rebuild recovers >10000 retained events with continuation, idempotent pages, dual-apply, cutover and gap fail-closed', async () => {
    const pool = isolated.runtime.pool;
    const operations = createPostgresSocialFeedOperationsRepository(pool);
    const repository = createPostgresSocialFeedWorkerRepository(pool, {
      emitNotificationIntents: false,
    });
    const logger = { info() {}, warn() {}, error() {} };
    function worker() {
      const routes = createSocialFeedWorkerRoutes({ repository, maxRecipientsPerEvent: 100 });
      return new VersionedOutboxWorker({
        repository: new PostgresOutboxRepository(pool),
        router: new OutboxRouter(routes),
        envelopes: new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations),
        logger, metrics: new InMemoryMetrics(), leaseDurationMs: 5_000,
        heartbeatIntervalMs: 1_000, handlerTimeoutMs: 4_000,
        retryPolicy: { maxAttempts: 2, retryDelayMs: () => 1 },
      });
    }
    const config = loadConfig({ DATABASE_URL: isolated.databaseUrl,
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      FEED_REBUILD_MAX_EVENTS: '250', FEED_REBUILD_TIMEOUT_MS: '120000',
      WORKER_LEASE_DURATION_MS: '180000' }).feed!.operations;

    // Live dual-apply re-validates the closed envelope, so the owner/collection identities
    // must be canonical base64url ids (21 chars + [AQgw]) like production entities.
    const ACTOR = 'bcdefghijklmnopqrstuvg';
    const SCOPE = 'ABCDEFGHIJKLMNOPQRSTUA';
    const EVENTS = 10_001;
    const INSERT_BATCH = 500;
    await seedProfileAndCollection(isolated, 'rebuild-recipient', ACTOR, SCOPE);
    await pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
      values('rebuild-recipient',$1,current_timestamp - interval '2 days')`, [ACTOR]);
    // Keep each insert below PostgreSQL's max_locks_per_transaction budget;
    // the trigger-backed dispatch identity ledger acquires one lock per row.
    // The explicit commit ordinals still form one contiguous >10k source
    // stream for the rebuild continuation assertions below.
    for (let start = 1; start <= EVENTS; start += INSERT_BATCH) {
      const end = Math.min(start + INSERT_BATCH - 1, EVENTS);
      await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
        select 'bulk-event-' || value,'outbox',current_timestamp
        from generate_series($1::int,$2::int) value`, [start, end]);
      await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
          handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
          commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,
          completed_at)
        select 'bulk-event-' || value,'bulk-event-' || value,'social.collection-change',2,
          'social.publish-collection-change','projection_latest_only','collection',$3::text,$3::text,
          'c' || value::text || '.p' || value::text,value,
          current_timestamp - interval '1 day',
          jsonb_build_object('collectionId',$3::text,'ownerProfileId',$4::text,'publicationRevision',
            'c' || value::text || '.p' || value::text,
            'discoverabilityRecheckKey','publication.collection:' || $3::text,
            'producerDiscoverability','public_candidate'),
          'completed',1,current_timestamp - interval '1 day',1,current_timestamp
          from generate_series($1::int,$2::int) value`, [start, end, SCOPE, ACTOR]);
    }

    // Interrupt mid-rebuild: capture commits durably, the page replay stalls, abort lands.
    await pool.query(`create function phase5_stall_bulk_rebuild()
      returns trigger language plpgsql as $$ begin
        if new.source_event_id='bulk-event-5000' then perform pg_sleep(0.25); end if;
        return new;
      end $$`);
    await pool.query(`create trigger phase5_stall_bulk_rebuild
      before insert on social_feed_items for each row
      execute function phase5_stall_bulk_rebuild()`);
    const abort = new AbortController();
    const interrupted = rebuildSocialFeedProjection({ repository, aggregateScope: SCOPE,
      maxEvents: 250, maxRecipientsPerEvent: 100, signal: abort.signal });
    const captureDeadline = Date.now() + 5_000;
    while (Date.now() < captureDeadline) {
      const state = await pool.query<{ projection_state: string }>(`select projection_state
        from social_feed_watermarks where aggregate_scope=$1`, [SCOPE]);
      if (state.rows[0]?.projection_state === 'rebuilding') break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    abort.abort();
    await assert.rejects(interrupted, /abort/iu);
    const continuation = (await pool.query(`select rebuild_generation::text,
      rebuild_high_commit_ordinal::text,rebuild_replayed_commit_ordinal::text,
      rebuild_started_at from social_feed_watermarks where aggregate_scope=$1`, [SCOPE])).rows[0];
    assert.ok(BigInt(continuation.rebuild_generation) >= 1n);
    assert.equal(continuation.rebuild_high_commit_ordinal, String(EVENTS));
    assert.ok(BigInt(continuation.rebuild_replayed_commit_ordinal) < BigInt(EVENTS));
    assert.ok(continuation.rebuild_started_at !== null);
    const stuck = await operations.inspectStatus();
    // Earlier evidence tests deliberately leave their own fixture scope rebuilding; the
    // count must be order-robust while the bulk scope itself must be reported.
    assert.ok(stuck.rebuildingScopeCount >= 1);
    const stuckProgress = stuck.rebuilds.find((entry) => entry.aggregateScope === SCOPE);
    assert.ok(stuckProgress);
    assert.equal(stuckProgress.generation, continuation.rebuild_generation);
    assert.equal(stuckProgress.capturedHighCommitOrdinal, String(EVENTS));
    assert.equal(stuckProgress.replayedCommitOrdinal,
      continuation.rebuild_replayed_commit_ordinal);
    assert.equal(stuckProgress.gap, false);
    assert.ok(stuckProgress.progressPercent >= 0 && stuckProgress.progressPercent < 100);
    assert.ok(stuckProgress.etaMs >= 0);
    assert.ok(stuckProgress.startedAt !== null);

    // Live dual-apply: a new event beyond the captured high is projected during the rebuild.
    await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      values('bulk-event-10002','outbox',current_timestamp)`);
    await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
        handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
        commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation)
      values('bulk-event-10002','bulk-event-10002','social.collection-change',2,
        'social.publish-collection-change','projection_latest_only','collection',$1::text,$1::text,
        'c10002.p10002',10002,current_timestamp - interval '1 day',
        jsonb_build_object('collectionId',$1::text,'ownerProfileId',$2::text,'publicationRevision',
          'c10002.p10002','discoverabilityRecheckKey','publication.collection:' || $1::text,
          'producerDiscoverability','public_candidate'),
        'pending',0,current_timestamp,0)`, [SCOPE, ACTOR]);
    assert.equal(await worker().runOnce(), true);
    assert.equal((await pool.query(`select state from outbox_events
      where outbox_id='bulk-event-10002'`)).rows[0]?.state, 'completed');
    assert.equal((await pool.query(`select count(*)::int count from social_feed_items
      where source_event_id='bulk-event-10002'`)).rows[0]?.count, 1);

    await pool.query('drop trigger phase5_stall_bulk_rebuild on social_feed_items');
    await pool.query('drop function phase5_stall_bulk_rebuild()');

    // Resume: the durable continuation replays the remaining pages and cuts over atomically.
    const rebuilt = await rebuildFeedScopeForOperations({ operations, worker: repository,
      aggregateScope: SCOPE, config });
    assert.equal(rebuilt.beforeWatermark.projectionState, 'rebuilding');
    assert.equal(rebuilt.afterWatermark.projectionState, 'live');
    assert.equal(rebuilt.highCommitOrdinal, String(EVENTS));
    assert.equal(rebuilt.afterWatermark.lastCommitOrdinal, '10002');
    assert.ok(rebuilt.eventCount > 0);
    assert.equal((await pool.query(`select count(*)::int count from social_feed_items
      where collection_id=$1 and state='visible'`, [SCOPE])).rows[0]?.count, EVENTS + 1);

    // Duplicate page retry is idempotent: replaying an already-covered ordinal range must not
    // duplicate Feed items.
    await pool.query(`alter table social_feed_watermarks
      disable trigger social_feed_watermarks_transition_guard`);
    await pool.query(`update social_feed_watermarks set projection_state='rebuilding',
        rebuild_generation=rebuild_generation+1,rebuild_high_commit_ordinal=$2::bigint,
        rebuild_high_source_event_id=$3,rebuild_replayed_commit_ordinal=9750,
        rebuild_started_at=current_timestamp,
        state_revision=state_revision+1,state_updated_at=current_timestamp
      where aggregate_scope=$1`, [SCOPE, EVENTS, `bulk-event-${EVENTS}`]);
    await pool.query(`alter table social_feed_watermarks
      enable trigger social_feed_watermarks_transition_guard`);
    const retried = await rebuildFeedScopeForOperations({ operations, worker: repository,
      aggregateScope: SCOPE, config });
    assert.equal(retried.afterWatermark.projectionState, 'live');
    assert.equal((await pool.query(`select count(*)::int count from social_feed_items
      where collection_id=$1 and state='visible'`, [SCOPE])).rows[0]?.count, EVENTS + 1);

    // Capture-time source gap fails closed before any state change: a deleted row inside the
    // retained window must never produce a partial projection.
    const GAP_SCOPE = 'scope-gap';
    await seedProfileAndCollection(isolated, 'gap-recipient', 'gap-actor', GAP_SCOPE);
    await pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
      values('gap-recipient',$1,current_timestamp - interval '2 days')`, ['gap-actor']);
    await pool.query(`insert into social_feed_watermarks(aggregate_scope) values($1)`, [GAP_SCOPE]);
    await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      select 'gap-event-' || value,'outbox',current_timestamp from generate_series(1,60) value`);
    await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
        handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
        commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,
        completed_at)
      select 'gap-event-' || value,'gap-event-' || value,'social.collection-change',2,
        'social.publish-collection-change','projection_latest_only','collection',$2::text,$2::text,
        'c' || value::text || '.p' || value::text,value,
        current_timestamp - interval '1 day',
        jsonb_build_object('collectionId',$2::text,'ownerProfileId',$3::text,'publicationRevision',
          'c' || value::text || '.p' || value::text,
          'discoverabilityRecheckKey','publication.collection:' || $2::text,
          'producerDiscoverability','public_candidate'),
        'completed',1,current_timestamp - interval '1 day',1,current_timestamp
        from generate_series(1,$1::int) value`, [60, GAP_SCOPE, 'gap-actor']);
    await executeWithoutPermanenceGuards(pool, `delete from outbox_events where outbox_id='gap-event-30'`);
    await assert.rejects(rebuildFeedScopeForOperations({ operations, worker: repository,
      aggregateScope: GAP_SCOPE, config }), /source gap/iu);
    const gapScope = await pool.query(`select projection_state from social_feed_watermarks
      where aggregate_scope=$1`, [GAP_SCOPE]);
    assert.ok(!gapScope.rows[0] || gapScope.rows[0].projection_state === 'live');

    // Runtime source gap: rows vanish after capture; ops status reports the gap and the resume
    // fails closed permanently instead of cutting over a partial projection.
    await pool.query(`alter table social_feed_watermarks
      disable trigger social_feed_watermarks_transition_guard`);
    await pool.query(`update social_feed_watermarks set projection_state='rebuilding',
        rebuild_generation=rebuild_generation+1,rebuild_high_commit_ordinal=$2::bigint,
        rebuild_high_source_event_id=$3,rebuild_replayed_commit_ordinal=9950,
        rebuild_started_at=current_timestamp,
        state_revision=state_revision+1,state_updated_at=current_timestamp
      where aggregate_scope=$1`, [SCOPE, EVENTS, `bulk-event-${EVENTS}`]);
    await executeWithoutPermanenceGuards(pool, `delete from outbox_events where aggregate_scope=$1
      and commit_ordinal > 9950 and commit_ordinal <= $2`, [SCOPE, EVENTS]);
    await pool.query(`alter table social_feed_watermarks
      enable trigger social_feed_watermarks_transition_guard`);
    const gapped = await operations.inspectStatus();
    const gappedScope = gapped.rebuilds.find((entry) => entry.aggregateScope === SCOPE);
    assert.ok(gappedScope);
    assert.equal(gappedScope.gap, true);
    assert.equal(gappedScope.capturedHighCommitOrdinal, String(EVENTS));
    assert.ok(gappedScope.progressPercent >= 0);
    await assert.rejects(rebuildFeedScopeForOperations({ operations, worker: repository,
      aggregateScope: SCOPE, config }), /source gap/iu);
  }, 120_000);

  test('database/worker Feed failure is feature-scoped and does not remove Core API readiness', async () => {
    const config = loadConfig({ DATABASE_URL: isolated.databaseUrl, NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' });
    const unavailablePool = new Pool({ connectionString: isolated.databaseUrl, max: 1 });
    await unavailablePool.end();
    const unavailable = createPostgresSocialFeedOperationsRepository(unavailablePool);
    const failedStatus = await unavailable.inspectStatus();
    assert.equal(failedStatus.dependency, 'unavailable');
    const app = buildApiApp({ config, readiness: isolated.runtime,
      collectionMetadataMutationRoutes: 'disabled',
      feedCapabilityReadiness: async () => evaluateFeedCapabilityReadiness(
        failedStatus, config.feed!.operations),
    });
    await app.ready();
    const [global, feed] = await Promise.all([
      app.inject({ method: 'GET', url: '/ready' }),
      app.inject({ method: 'GET', url: '/ready/features/feed' }),
    ]);
    assert.equal(global.statusCode, 200);
    assert.deepEqual(global.json(), { status: 'ready' });
    assert.equal(feed.statusCode, 503);
    assert.deepEqual(feed.json(), { capability: 'feed', status: 'not-ready',
      reason: 'dependency_unavailable' });
    await app.close();
  });
});
