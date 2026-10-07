import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  EventEnvelopeRegistry,
  OutboxRouter,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
} from '../../../src/infrastructure/outbox/index.js';
import {
  createPostgresSocialFeedOperationsRepository,
  createPostgresSocialFeedWorkerRepository,
  createSocialFeedWorkerRoutes,
  socialCollectionChangeEnvelopeRegistrations,
} from '../../../src/infrastructure/social/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  evaluateFeedCapabilityReadiness,
  publishFeedOperationsMetrics,
} from '../../../src/modules/social/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
const ACTOR_B = 'KiIiIiIiIiIiIiIiIiIiIg';
const ACTOR_C = 'MzMzMzMzMzMzMzMzMzMzMw';
const SCOPE_A = 'Dw8PDw8PDw8PDw8PDw8PDw';
const SCOPE_B = 'Hx8fHx8fHx8fHx8fHx8fHw';
const SCOPE_C = 'JCQkJCQkJCQkJCQkJCQkJA';
const RECIPIENT = 'MjIyMjIyMjIyMjIyMjIyMg';
const RECIPIENT_B = 'NDQ0NDQ0NDQ0NDQ0NDQ0NA';
const RECIPIENT_C = 'NTU1NTU1NTU1NTU1NTU1NQ';

describeWithPostgres('R5-12 Feed fan-out continuation operations visibility', () => {
  let isolated: IsolatedPostgresRuntime;
  const logger = { info() {}, warn() {}, error() {} };

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_fanout_ops', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, RECIPIENT, ACTOR, SCOPE_A);
    await seedProfileAndCollection(isolated, RECIPIENT_B, ACTOR_B, SCOPE_B);
    await seedProfileAndCollection(isolated, RECIPIENT_C, ACTOR_C, SCOPE_C);
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  async function reset(): Promise<void> {
    await executeWithoutPermanenceGuards(isolated.runtime.pool, `
      delete from outbox_events
       where handler_name in ('social.publish-collection-change','social_feed_withdrawal',
         'social_feed_item_notification')`);
    await isolated.runtime.pool.query('delete from social_feed_items');
    await isolated.runtime.pool.query('delete from social_feed_watermarks');
    await isolated.runtime.pool.query('delete from outbox_projection_watermarks');
  }

  async function ensureWatermark(scope: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into social_feed_watermarks(aggregate_scope) values($1)
       on conflict (aggregate_scope) do nothing`,
      [scope],
    );
  }

  /** Recent completed row so inspectStatus reports worker=running while progress is inspected. */
  async function seedWorkerHeartbeat(): Promise<void> {
    const id = `fanout-heartbeat-${Date.now()}`;
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values($1, 'outbox', current_timestamp)`,
      [id],
    );
    await isolated.runtime.pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
        occurred_at, payload_json, state, attempt_count, available_at, lease_generation,
        completed_at)
      values(
        $1, $1, 'social.collection-change', 2, 'social.publish-collection-change',
        'projection_latest_only', 'collection', $2, $2, 'r1', 99,
        current_timestamp, '{}'::jsonb, 'completed', 1, current_timestamp, 1,
        current_timestamp)`,
    [id, SCOPE_A]);
  }

  async function seedActiveProgress(input: {
    readonly scope: string;
    readonly eventId: string;
    readonly commitOrdinal: number;
    readonly candidateCount: number;
    readonly ageMs: number;
    readonly afterRecipient?: string | null;
    readonly outboxState?: 'pending' | 'retryable' | 'leased' | 'completed' | 'dead_letter' | 'absent';
  }): Promise<void> {
    await ensureWatermark(input.scope);
    // Keep last_commit_ordinal at 0 (idle shape) while fan-out is in progress so
    // state_shape stays valid; fanout_commit_ordinal must still exceed it.
    await isolated.runtime.pool.query(`
      update social_feed_watermarks
         set fanout_source_event_id = $2,
             fanout_commit_ordinal = $3,
             fanout_after_recipient_profile_id = $4,
             fanout_candidate_count = $5,
             fanout_started_at = current_timestamp - ($6::text || ' milliseconds')::interval,
             state_revision = state_revision + 1
       where aggregate_scope = $1`,
    [
      input.scope,
      input.eventId,
      input.commitOrdinal,
      input.afterRecipient ?? RECIPIENT,
      input.candidateCount,
      String(input.ageMs),
    ]);
    const state = input.outboxState ?? 'pending';
    if (state === 'absent') return;
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values($1, 'outbox', current_timestamp) on conflict do nothing`,
      [input.eventId],
    );
    const owner = input.scope === SCOPE_A ? ACTOR
      : input.scope === SCOPE_B ? ACTOR_B : ACTOR_C;
    await isolated.runtime.pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
        occurred_at, payload_json, state, attempt_count, available_at, lease_generation,
        locked_until, dead_lettered_at, completed_at, last_error)
      values(
        $1, $1, 'social.collection-change', 2, 'social.publish-collection-change',
        'projection_latest_only', 'collection', $2, $2, 'r1', $3,
        current_timestamp - interval '1 minute', $5::jsonb, $4, 1, current_timestamp, 1,
        case when $4 = 'leased' then current_timestamp + interval '1 minute' end,
        case when $4 = 'dead_letter' then current_timestamp end,
        case when $4 = 'completed' then current_timestamp end,
        case when $4 = 'dead_letter' then 'stable fanout failure' end)`,
    [input.eventId, input.scope, input.commitOrdinal, state, JSON.stringify({
      collectionId: input.scope,
      ownerProfileId: owner,
      publicationRevision: 'r1',
      discoverabilityRecheckKey: `publication.collection:${input.scope}`,
      producerDiscoverability: 'public_candidate',
    })]);
  }

  async function seedWithdrawal(outboxId: string, state: 'pending' | 'retryable' | 'leased'): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values($1, 'outbox', current_timestamp) on conflict do nothing`,
      [outboxId],
    );
    await isolated.runtime.pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
        occurred_at, payload_json, state, attempt_count, available_at, lease_generation,
        locked_until)
      values(
        $1, $1, 'social.follow-removed', 1, 'social_feed_withdrawal', 'delivery_each_event',
        'profile-follow', $2, $3, null, null,
        current_timestamp, '{}'::jsonb, $4, 0, current_timestamp, 0,
        case when $4 = 'leased' then current_timestamp + interval '1 minute' end)`,
    [outboxId, ACTOR, RECIPIENT, state]);
  }

  test('reports 0, 1 and many active progress rows with candidate count and ages', async () => {
    await reset();
    const operations = createPostgresSocialFeedOperationsRepository(isolated.runtime.pool);
    const empty = await operations.inspectStatus();
    assert.equal(empty.fanout.progressBacklog, 0);
    assert.equal(empty.fanout.oldestProgressAgeMs, 0);
    assert.equal(empty.fanout.candidateCount, 0);
    assert.equal(empty.fanout.withdrawalBacklog, 0);

    await seedWorkerHeartbeat();
    await seedActiveProgress({
      scope: SCOPE_A, eventId: 'fanout-one', commitOrdinal: 2,
      candidateCount: 500, ageMs: 15_000,
    });
    const one = await operations.inspectStatus();
    assert.equal(one.fanout.progressBacklog, 1);
    assert.equal(one.fanout.candidateCount, 500);
    assert.ok(one.fanout.oldestProgressAgeMs >= 14_000);
    assert.equal(one.fanout.orphanProgressCount, 0);
    assert.equal(one.fanout.reverseInconsistencyCount, 0);

    await seedActiveProgress({
      scope: SCOPE_B, eventId: 'fanout-two', commitOrdinal: 3,
      candidateCount: 250, ageMs: 45_000,
    });
    await seedActiveProgress({
      scope: SCOPE_C, eventId: 'fanout-three', commitOrdinal: 4,
      candidateCount: 100, ageMs: 5_000,
    });
    const many = await operations.inspectStatus();
    assert.equal(many.fanout.progressBacklog, 3);
    assert.equal(many.fanout.candidateCount, 850);
    assert.ok(many.fanout.oldestProgressAgeMs >= 44_000);
    assert.equal(many.worker, 'running');
    const config = loadConfig({ DATABASE_URL: isolated.databaseUrl,
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' }).feed!.operations;
    assert.equal(evaluateFeedCapabilityReadiness(many, config).reason, 'none');
  });

  test('marks stale progress, dead-letter, orphan progress and reverse inconsistency', async () => {
    await reset();
    const operations = createPostgresSocialFeedOperationsRepository(isolated.runtime.pool);
    const config = {
      ...loadConfig({ DATABASE_URL: isolated.databaseUrl,
        OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' }).feed!.operations,
      fanoutProgressAgeNotReadyMs: 60_000,
      withdrawalBacklogNotReady: 2,
      deadLetterNotReady: 1,
    };

    await seedWorkerHeartbeat();
    await seedActiveProgress({
      scope: SCOPE_A, eventId: 'fanout-stale', commitOrdinal: 2,
      candidateCount: 500, ageMs: 120_000,
    });
    const stale = await operations.inspectStatus();
    assert.equal(stale.fanout.progressBacklog, 1);
    assert.ok(stale.fanout.oldestProgressAgeMs >= 60_000);
    assert.equal(evaluateFeedCapabilityReadiness(stale, config).reason, 'stale_progress');

    await reset();
    await seedWorkerHeartbeat();
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values('fanout-dead', 'outbox', current_timestamp)`,
    );
    await isolated.runtime.pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
        occurred_at, payload_json, state, attempt_count, available_at, lease_generation,
        dead_lettered_at, last_error)
      values(
        'fanout-dead', 'fanout-dead', 'social.collection-change', 2,
        'social.publish-collection-change', 'projection_latest_only', 'collection',
        $1, $1, 'r1', 1, current_timestamp, '{}'::jsonb, 'dead_letter', 8,
        current_timestamp, 1, current_timestamp, 'stable fanout failure')`,
    [SCOPE_A]);
    const dead = await operations.inspectStatus();
    assert.equal(dead.deadLetterCount, 1);
    assert.equal(evaluateFeedCapabilityReadiness(dead, config).reason, 'dead_letter');

    await reset();
    await seedWorkerHeartbeat();
    await seedActiveProgress({
      scope: SCOPE_A, eventId: 'fanout-orphan', commitOrdinal: 2,
      candidateCount: 10, ageMs: 1_000, outboxState: 'absent',
    });
    const orphan = await operations.inspectStatus();
    assert.equal(orphan.fanout.orphanProgressCount, 1);
    assert.equal(evaluateFeedCapabilityReadiness(orphan, config).reason, 'fanout_inconsistency');

    await reset();
    await seedWorkerHeartbeat();
    await seedActiveProgress({
      scope: SCOPE_A, eventId: 'fanout-reverse', commitOrdinal: 2,
      candidateCount: 10, ageMs: 1_000, outboxState: 'completed',
    });
    const reverse = await operations.inspectStatus();
    assert.ok(reverse.fanout.orphanProgressCount + reverse.fanout.reverseInconsistencyCount >= 1);
    assert.equal(evaluateFeedCapabilityReadiness(reverse, config).reason, 'fanout_inconsistency');
  });

  test('withdrawal backlog is visible and independent from fan-out progress', async () => {
    await reset();
    await seedWorkerHeartbeat();
    const operations = createPostgresSocialFeedOperationsRepository(isolated.runtime.pool);
    await seedWithdrawal('withdraw-1', 'pending');
    await seedWithdrawal('withdraw-2', 'retryable');
    const status = await operations.inspectStatus();
    assert.equal(status.fanout.withdrawalBacklog, 2);
    assert.equal(status.fanout.progressBacklog, 0);
    const config = {
      ...loadConfig({ DATABASE_URL: isolated.databaseUrl,
        OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' }).feed!.operations,
      withdrawalBacklogNotReady: 2,
    };
    assert.equal(evaluateFeedCapabilityReadiness(status, config).reason, 'withdrawal_backlog');
  });

  test('after fan-out completion progress gauges return to zero', async () => {
    await reset();
    const pool = isolated.runtime.pool;
    await pool.query(
      `insert into follows(actor_profile_id, target_profile_id, followed_at)
       values($1, $2, current_timestamp) on conflict do nothing`,
      [RECIPIENT, ACTOR],
    );
    await ensureWatermark(SCOPE_A);
    const eventId = 'fanout-complete-zero';
    await pool.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values($1, 'outbox', current_timestamp)`,
      [eventId],
    );
    await pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
        occurred_at, payload_json, state, attempt_count, available_at, lease_generation)
      values(
        $1, $1, 'social.collection-change', 2, 'social.publish-collection-change',
        'projection_latest_only', 'collection', $2, $2, 'r1', 1,
        current_timestamp, $3::jsonb, 'pending', 0, current_timestamp, 0)`,
    [eventId, SCOPE_A, JSON.stringify({
      collectionId: SCOPE_A,
      ownerProfileId: ACTOR,
      publicationRevision: 'r1',
      discoverabilityRecheckKey: `publication.collection:${SCOPE_A}`,
      producerDiscoverability: 'public_candidate',
    })]);

    const metrics = new InMemoryMetrics();
    const worker = new VersionedOutboxWorker({
      repository: new PostgresOutboxRepository(pool),
      router: new OutboxRouter(createSocialFeedWorkerRoutes({
        repository: createPostgresSocialFeedWorkerRepository(pool, {
          emitNotificationIntents: false,
        }),
        maxRecipientsPerEvent: 500,
        metrics,
      })),
      envelopes: new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations),
      logger,
      metrics,
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 5_000,
      handlerTimeoutMs: 20_000,
      retryPolicy: { maxAttempts: 8, retryDelayMs: () => 1 },
    });
    assert.equal(await worker.runOnce(), true);
    const operations = createPostgresSocialFeedOperationsRepository(pool);
    const status = await operations.inspectStatus();
    assert.equal(status.fanout.progressBacklog, 0);
    assert.equal(status.fanout.oldestProgressAgeMs, 0);
    assert.equal(status.fanout.candidateCount, 0);
    publishFeedOperationsMetrics(status, metrics);
    assert.equal(metrics.get('feed.fanout.progress_backlog'), 0);
    assert.equal(metrics.get('feed.fanout.oldest_progress_age_ms'), 0);
    assert.ok(metrics.get('feed.fanout.completed') >= 1
      || metrics.get('feed.fanout.slice_applied') >= 1);
  });

  test('lease-owner crash leaves durable progress visible for worker reclaim', async () => {
    await reset();
    await seedActiveProgress({
      scope: SCOPE_A, eventId: 'fanout-crash', commitOrdinal: 2,
      candidateCount: 500, ageMs: 8_000, outboxState: 'pending',
    });
    // Simulate crashed lease owner: row is claimable, watermark still has continuation cursor.
    const operations = createPostgresSocialFeedOperationsRepository(isolated.runtime.pool);
    const status = await operations.inspectStatus();
    assert.equal(status.fanout.progressBacklog, 1);
    assert.equal(status.fanout.orphanProgressCount, 0);
    assert.ok(status.fanout.candidateCount >= 500);
    const claim = await new PostgresOutboxRepository(isolated.runtime.pool).claim(5_000);
    assert.equal(claim?.outboxId, 'fanout-crash');
    assert.equal(claim?.eventId, 'fanout-crash');
  });

  test('operations inspect and dead-letter requeue remain safe under a concurrent worker', async () => {
    await reset();
    const pool = isolated.runtime.pool;
    await seedActiveProgress({
      scope: SCOPE_A, eventId: 'fanout-live-ops', commitOrdinal: 2,
      candidateCount: 500, ageMs: 2_000, outboxState: 'pending',
    });
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values('fanout-dlq', 'outbox', current_timestamp)`,
    );
    await pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
        occurred_at, payload_json, state, attempt_count, available_at, lease_generation,
        dead_lettered_at, last_error)
      values(
        'fanout-dlq', 'fanout-dlq', 'social.collection-change', 2,
        'social.publish-collection-change', 'projection_latest_only', 'collection',
        $1, $1, 'r1', 9, current_timestamp, '{}'::jsonb, 'dead_letter', 8,
        current_timestamp, 3, current_timestamp, 'stable fanout failure')`,
    [SCOPE_B]);
    await ensureWatermark(SCOPE_B);

    const operations = createPostgresSocialFeedOperationsRepository(pool);
    const runtime = buildWorker(loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      WORKER_CONCURRENCY: '1',
      WORKER_BATCH_SIZE: '1',
      FEED_FANOUT_PAGE_SIZE: '500',
    }), isolated.runtime);
    assert.ok(runtime.outbox);

    const inspectPromise = operations.inspectStatus();
    const workerPromise = runtime.outbox.runOnce();
    const [status] = await Promise.all([inspectPromise, workerPromise]);
    assert.ok(status.fanout.progressBacklog >= 0);
    assert.ok(Number.isFinite(status.fanout.oldestProgressAgeMs));

    const before = await operations.captureScope(SCOPE_B);
    const replayed = await operations.replayDeadLetters({ aggregateScope: SCOPE_B, limit: 1 });
    assert.deepEqual(replayed.outboxIds, ['fanout-dlq']);
    const row = (await pool.query(
      `select state, attempt_count, lease_generation, last_error
         from outbox_events where outbox_id='fanout-dlq'`,
    )).rows[0];
    assert.equal(row.state, 'retryable');
    assert.equal(row.attempt_count, 8);
    assert.equal(row.lease_generation, '3');
    assert.equal(row.last_error, 'stable fanout failure');
    const after = await operations.captureScope(SCOPE_B);
    assert.equal(after.watermark.lastCommitOrdinal, before.watermark.lastCommitOrdinal);
    // Requeue must not complete the outbox or clear authority/progress by itself.
    assert.notEqual(row.state, 'completed');
  });

  test('secret scan: published metrics never include profile, recipient or event ids', async () => {
    await reset();
    await seedActiveProgress({
      scope: SCOPE_A, eventId: 'secret-event-marker-99', commitOrdinal: 2,
      candidateCount: 42, ageMs: 3_000, afterRecipient: 'secret-recipient-marker-99',
    });
    const operations = createPostgresSocialFeedOperationsRepository(isolated.runtime.pool);
    const status = await operations.inspectStatus();
    const series = new Map<string, number>();
    publishFeedOperationsMetrics(status, {
      gauge(name, value) { series.set(name, value); },
    });
    const serialized = JSON.stringify({ status, metrics: [...series] });
    for (const marker of [
      'secret-event-marker-99', 'secret-recipient-marker-99', SCOPE_A, ACTOR, RECIPIENT,
    ]) {
      assert.doesNotMatch(JSON.stringify([...series]), new RegExp(marker, 'u'));
    }
    assert.equal(status.fanout.progressBacklog, 1);
    assert.equal(status.fanout.candidateCount, 42);
    assert.ok(!serialized.includes('postgres://'));
  });
});
