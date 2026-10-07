import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  EventEnvelopeRegistry, OutboxRouter, PostgresOutboxRepository, VersionedOutboxWorker,
} from '../../../src/infrastructure/outbox/index.js';
import {
  createPostgresSocialFeedWorkerRepository,
  createPostgresSocialFeedOperationsRepository,
  createSocialFeedWorkerRoutes,
  socialCollectionChangeEnvelopeRegistrations,
} from '../../../src/infrastructure/social/index.js';
import {
  rebuildSocialFeedProjection,
  rebuildFeedScopeForOperations,
} from '../../../src/modules/social/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

describeWithPostgres('P5-11 production Feed worker registry', () => {
  const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
  const COLLECTION = 'Dw8PDw8PDw8PDw8PDw8PDw';
  let isolated: IsolatedPostgresRuntime;
  let outbox: PostgresOutboxRepository;
  const logger = { info() {}, warn() {}, error() {} };

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_feed_worker', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, 'follower-before', ACTOR, COLLECTION);
    for (const id of ['follower-after', 'unfollowed', 'takeover-follower']) {
      await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status)
        values($1,$2,'active')`, [id, `subject-${id}`]);
      await isolated.runtime.pool.query(
        'insert into profiles(account_id,display_name) values($1,$1)', [id]);
    }
    outbox = new PostgresOutboxRepository(isolated.runtime.pool);
  }, 120_000);
  afterAll(async () => isolated?.close());

  function worker(maxRecipients = 100) {
    const routes = createSocialFeedWorkerRoutes({
      repository: createPostgresSocialFeedWorkerRepository(isolated.runtime.pool, {
        emitNotificationIntents: false,
      }),
      maxRecipientsPerEvent: maxRecipients,
    });
    return new VersionedOutboxWorker({ repository: outbox, router: new OutboxRouter(routes),
      envelopes: new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations),
      logger, metrics: new InMemoryMetrics(), leaseDurationMs: 5_000,
      heartbeatIntervalMs: 1_000, handlerTimeoutMs: 4_000,
      retryPolicy: { maxAttempts: 2, retryDelayMs: () => 1 } });
  }

  function productionWorker() {
    const runtime = buildWorker(loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      WORKER_CONCURRENCY: '1',
      WORKER_BATCH_SIZE: '1',
    }), isolated.runtime);
    assert.ok(runtime.outbox);
    return runtime.outbox;
  }

  async function follow(id: string, at: string) {
    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
      values($1,$2,$3)`, [id, ACTOR, at]);
  }

  async function event(id: string, ordinal: number, options: {
    version?: number; occurredAt?: string; disposition?: 'public_candidate' | 'remove';
  } = {}) {
    const version = options.version ?? 2;
    const occurredAt = options.occurredAt ?? '2026-07-29T10:00:00.000Z';
    const payload: Record<string, unknown> = { collectionId: COLLECTION, ownerProfileId: ACTOR,
      publicationRevision: `c${ordinal}.p${ordinal}`,
      discoverabilityRecheckKey: `publication.collection:${COLLECTION}` };
    if (version === 2) payload.producerDiscoverability = options.disposition ?? 'public_candidate';
    await isolated.runtime.pool.query(`insert into resource_id_ledger(
      resource_id,resource_type,committed_at) values($1,'outbox',current_timestamp)`, [id]);
    await isolated.runtime.pool.query(`insert into outbox_events(
      outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
      aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,
      occurred_at,payload_json,state,attempt_count,available_at,lease_generation)
      values($1,$1,'social.collection-change',$2,'social.publish-collection-change',
        'projection_latest_only','collection',$3,$3,$4,$5,$6,$7,
        'pending',0,current_timestamp,0)`,
    [id, version, COLLECTION, `c${ordinal}.p${ordinal}`, ordinal, occurredAt, payload]);
  }

  test('real registry projects current event-time followers without rescanning historical rows', async () => {
    await follow('follower-before', '2026-07-29T09:00:00Z');
    await follow('follower-after', '2026-07-29T11:00:00Z');
    await follow('unfollowed', '2026-07-29T09:00:00Z');
    await event('social-event-100', 100);
    assert.equal(await productionWorker().runOnce(), true);
    const rows = await isolated.runtime.pool.query<{ recipient_profile_id: string }>(`
      select recipient_profile_id from social_feed_items where source_event_id='social-event-100'`);
    assert.deepEqual(rows.rows.map((row) => row.recipient_profile_id).sort(),
      ['follower-before', 'unfollowed']);
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(
      `select state from outbox_events where outbox_id='social-event-100'`)).rows[0]?.state, 'completed');
    // P5-17 production composition consumes the two per-recipient notification intents emitted
    // by this production Feed projection before this P5-11-only harness resumes.
    await productionWorker().runOnce();
    await productionWorker().runOnce();
    await isolated.runtime.pool.query(
      `delete from follows where actor_profile_id='unfollowed' and target_profile_id=$1`, [ACTOR]);
    await event('social-event-101', 101);
    await worker().runOnce();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items where source_event_id='social-event-101'
        and recipient_profile_id='unfollowed'`)).rows[0]?.count, 0);
    // Direct SQL deliberately bypasses the canonical Unfollow Outbox. Public collection events
    // must not compensate with an unbounded historical sweep; the query recheck hides this row.
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`
      select state from social_feed_items where source_event_id='social-event-100'
        and recipient_profile_id='unfollowed'`)).rows[0]?.state, 'visible');
    await event('social-event-late', 99, { version: 1 });
    await worker().runOnce();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items where source_event_id='social-event-late'`))
      .rows[0]?.count, 0);
  });

  test('current discoverability overrides producer facts and withdraws older visible items', async () => {
    await isolated.runtime.pool.query(`update collections set visibility='private',
      policy_revision='p102',commit_ordinal=102 where id=$1`, [COLLECTION]);
    await event('social-event-tightened', 102, { disposition: 'public_candidate' });
    await worker().runOnce();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items
       where collection_id=$1 and state='visible'`, [COLLECTION])).rows[0]?.count, 0);
    assert.equal((await isolated.runtime.pool.query<{ withdrawal_reason: string }>(`
      select withdrawal_reason from social_feed_items where source_event_id='social-event-100'
        and recipient_profile_id='follower-before'`))
      .rows[0]?.withdrawal_reason, 'discoverability_revoked');
    const deletion = await isolated.runtime.pool.connect();
    try {
      await deletion.query('begin');
      await deletion.query(`update nodes set deleted_at=current_timestamp
        where collection_id=$1 and is_root=true`, [COLLECTION]);
      await deletion.query(`update collections set deleted_at=current_timestamp
        where id=$1`, [COLLECTION]);
      await deletion.query('commit');
    } finally {
      deletion.release();
    }
    await isolated.runtime.pool.query(`update accounts set status='disabled' where id=$1`, [ACTOR]);
    await event('social-event-deleted-owner', 103, { disposition: 'public_candidate' });
    await worker().runOnce();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items
      where collection_id=$1 and state='visible'`, [COLLECTION])).rows[0]?.count, 0);
    const restoration = await isolated.runtime.pool.connect();
    try {
      await restoration.query('begin');
      await restoration.query('update collections set deleted_at=null where id=$1', [COLLECTION]);
      await restoration.query(`update nodes set deleted_at=null
        where collection_id=$1 and is_root=true`, [COLLECTION]);
      await restoration.query('commit');
    } finally {
      restoration.release();
    }
    await isolated.runtime.pool.query(`update accounts set status='active' where id=$1`, [ACTOR]);
    // accounts_remove_inactive_follows deletes edges when the owner is disabled; restore
    // the event-time Follow fixture before later over-cap / takeover cases resume.
    await follow('follower-before', '2026-07-29T09:00:00Z');
    await follow('follower-after', '2026-07-29T11:00:00Z');
  });

  test('unknown versions dead-letter while over-cap fan-out makes bounded recoverable progress', async () => {
    // FIX-M-027 ordinal-density contract: one social row per collection commit ordinal, so the
    // unknown-version fixture must not share ordinal 103 with the completed deleted-owner event.
    await event('social-event-unknown', 98, { version: 3,
      occurredAt: new Date(Date.now() - 91 * 86_400_000).toISOString() });
    await worker().runOnce();
    await isolated.runtime.pool.query(
      `update outbox_events set available_at=current_timestamp where outbox_id='social-event-unknown'`);
    await worker().runOnce();
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(
      `select state from outbox_events where outbox_id='social-event-unknown'`)).rows[0]?.state,
    'dead_letter');
    await isolated.runtime.pool.query(`update collections set visibility='public',
      publication_slug='feed-collection',published_at=current_timestamp,
      policy_revision='p104',commit_ordinal=104 where id=$1`, [COLLECTION]);
    await follow('takeover-follower', '2026-07-29T09:00:00Z');
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status)
      select 'bulk-' || lpad(value::text,4,'0'),
        'subject-bulk-' || lpad(value::text,4,'0'),'active'
      from generate_series(1,1001) value`);
    await isolated.runtime.pool.query(`insert into profiles(account_id,display_name)
      select id,id from accounts where id like 'bulk-%'`);
    await isolated.runtime.pool.query(`insert into follows(
        actor_profile_id,target_profile_id,followed_at)
      select id,$1,'2026-07-29T09:00:00Z' from accounts where id like 'bulk-%'`, [ACTOR]);
    await isolated.runtime.pool.query(`create function phase5_fail_last_feed_item()
      returns trigger language plpgsql as $$ begin
        if new.recipient_profile_id='bulk-1001' then
          raise exception 'injected final page failure';
        end if;
        return new;
      end $$`);
    await isolated.runtime.pool.query(`create trigger phase5_fail_last_feed_item
      before insert on social_feed_items for each row
      execute function phase5_fail_last_feed_item()`);
    await event('social-event-cap', 104);
    // R5-04: live fan-out continues page-by-page; a failing late page must not erase prior slices.
    assert.equal(await worker(100).runOnce(), true);
    const afterFirstSlice = await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items where source_event_id='social-event-cap'`);
    assert.ok(afterFirstSlice.rows[0]!.count <= 100);
    assert.equal((await isolated.runtime.pool.query<{ last_commit_ordinal: string }>(`
      select last_commit_ordinal::text from social_feed_watermarks where aggregate_scope=$1`,
    [COLLECTION]))
      .rows[0]?.last_commit_ordinal, '103');
    await isolated.runtime.pool.query('drop trigger phase5_fail_last_feed_item on social_feed_items');
    await isolated.runtime.pool.query('drop function phase5_fail_last_feed_item()');
    let guard = 0;
    while (guard < 32) {
      const state = await isolated.runtime.pool.query<{ state: string }>(
        `select state from outbox_events where outbox_id='social-event-cap'`);
      if (state.rows[0]?.state === 'completed') break;
      await isolated.runtime.pool.query(`update outbox_events set available_at=current_timestamp
        where outbox_id='social-event-cap'`);
      await worker(100).runOnce();
      guard += 1;
    }
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items where source_event_id='social-event-cap'`))
      .rows[0]!.count > 1_000, true);
    const boundaryRecipients = await isolated.runtime.pool.query<{ recipient_profile_id: string }>(`
      select recipient_profile_id from social_feed_items
      where source_event_id='social-event-cap' and recipient_profile_id not like 'bulk-%'
      order by recipient_profile_id`);
    const nonBulk = boundaryRecipients.rows.map((row) => row.recipient_profile_id);
    assert.ok(nonBulk.includes('takeover-follower'));
    assert.ok(nonBulk.includes('follower-before'));
    assert.equal(nonBulk.includes('follower-after'), false);
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(
      `select state from outbox_events where outbox_id='social-event-cap'`)).rows[0]?.state,
    'completed');
    await isolated.runtime.pool.query(
      `delete from social_feed_items where recipient_profile_id like 'bulk-%'`,
    );
    await isolated.runtime.pool.query(`delete from follows where actor_profile_id like 'bulk-%'`);
    await isolated.runtime.pool.query(`delete from profiles where account_id like 'bulk-%'`);
    await isolated.runtime.pool.query(`delete from accounts where id like 'bulk-%'`);
  }, 30_000);

  test('expired lease owner is fenced, takeover wins, and retained events rebuild with concurrent high water', async () => {
    await event('social-event-takeover', 105);
    const oldClaim = await outbox.claim(100);
    assert.equal(oldClaim?.outboxId, 'social-event-takeover');
    const repository = createPostgresSocialFeedWorkerRepository(isolated.runtime.pool, {
      emitNotificationIntents: false,
    });
    const validated = new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations)
      .validate({ event_id: oldClaim!.eventId, event_type: oldClaim!.eventType,
        event_version: oldClaim!.eventVersion, aggregate_identity: { aggregate_type: oldClaim!.aggregateType,
          aggregate_id: oldClaim!.aggregateId, aggregate_scope: oldClaim!.aggregateScope },
        aggregate_revision: oldClaim!.aggregateRevision, commit_ordinal: oldClaim!.commitOrdinal,
        occurred_at: oldClaim!.occurredAt.toISOString(), payload: oldClaim!.payload });
    const route = createSocialFeedWorkerRoutes({ repository, maxRecipientsPerEvent: 100 })[1]!;
    await isolated.runtime.pool.query(`create function phase5_stall_old_attempt()
      returns trigger language plpgsql as $$ begin
        if new.source_event_id='social-event-takeover'
          and new.recipient_profile_id='takeover-follower' then perform pg_sleep(1.0); end if;
        return new;
      end $$`);
    await isolated.runtime.pool.query(`create trigger phase5_stall_old_attempt
      before insert on social_feed_items for each row execute function phase5_stall_old_attempt()`);
    const oldWrite = route.handle({ envelope: validated, idempotencyKey: validated.event_id,
      attempt: { outboxId: oldClaim!.outboxId, leaseGeneration: oldClaim!.leaseGeneration },
      signal: new AbortController().signal });
    await waitForCondition(async () => {
      const active = await isolated.runtime.pool.query<{ count: number }>(`
        select count(*)::int count from pg_stat_activity
        where datname=current_database() and pid <> pg_backend_pid()
          and state='active' and wait_event='PgSleep'
          and query like '%social_feed_items%'
      `);
      return (active.rows[0]?.count ?? 0) > 0;
    }, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      description: 'the old feed attempt to enter the controlled PostgreSQL stall',
    });
    await isolated.runtime.pool.query(`update outbox_events set locked_until=current_timestamp
      where outbox_id='social-event-takeover'`);
    const newClaim = await outbox.claim(5_000);
    assert.equal(newClaim?.leaseGeneration, '2');
    await assert.rejects(oldWrite, /attempt lease was lost/u);
    await isolated.runtime.pool.query('drop trigger phase5_stall_old_attempt on social_feed_items');
    await isolated.runtime.pool.query('drop function phase5_stall_old_attempt()');
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items
      where source_event_id='social-event-takeover'`)).rows[0]?.count, 0);
    assert.equal((await isolated.runtime.pool.query<{ last_commit_ordinal: string }>(`
      select last_commit_ordinal::text from social_feed_watermarks where aggregate_scope=$1`,
    [COLLECTION])).rows[0]?.last_commit_ordinal, '104');
    await route.handle({ envelope: validated, idempotencyKey: validated.event_id,
      attempt: { outboxId: newClaim!.outboxId, leaseGeneration: newClaim!.leaseGeneration },
      signal: new AbortController().signal });
    assert.equal(await outbox.complete(newClaim!), true);

    await event('social-event-crash', 106);
    const crashClaim = await outbox.claim(5_000);
    assert.equal(crashClaim?.outboxId, 'social-event-crash');
    const crashEnvelope = new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations)
      .validate({ event_id: crashClaim!.eventId, event_type: crashClaim!.eventType,
        event_version: crashClaim!.eventVersion, aggregate_identity: {
          aggregate_type: crashClaim!.aggregateType, aggregate_id: crashClaim!.aggregateId,
          aggregate_scope: crashClaim!.aggregateScope }, aggregate_revision: crashClaim!.aggregateRevision,
        commit_ordinal: crashClaim!.commitOrdinal, occurred_at: crashClaim!.occurredAt.toISOString(),
        payload: crashClaim!.payload });
    await route.handle({ envelope: crashEnvelope, idempotencyKey: crashEnvelope.event_id,
      attempt: { outboxId: crashClaim!.outboxId, leaseGeneration: crashClaim!.leaseGeneration },
      signal: new AbortController().signal });
    await isolated.runtime.pool.query(`update outbox_events set locked_until=current_timestamp
      where outbox_id='social-event-crash'`);
    assert.equal(await worker().runOnce(), true);
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(
      `select state from outbox_events where outbox_id='social-event-crash'`)).rows[0]?.state,
    'completed');
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items where source_event_id='social-event-crash'
        and recipient_profile_id='takeover-follower'`)).rows[0]?.count, 1);

    await event('social-event-unresolved-rebuild', 107);
    await assert.rejects(rebuildSocialFeedProjection({ repository,
      aggregateScope: COLLECTION, maxEvents: 20, maxRecipientsPerEvent: 100 }),
    /retained source row is unresolved/u);
    assert.equal(await worker().runOnce(), true);

    await isolated.runtime.pool.query(`delete from social_feed_items
      where source_event_id='social-event-cap' and recipient_profile_id='takeover-follower'`);
    // Rebuild captures and deletes the scope in one durable transaction, so the interrupt
    // window is the page replay: stall the row insert that the replay must produce.
    await isolated.runtime.pool.query(`create function phase5_stall_rebuild_replay()
      returns trigger language plpgsql as $$ begin
        if new.source_event_id='social-event-crash'
          and new.recipient_profile_id='takeover-follower' then perform pg_sleep(0.25); end if;
        return new;
      end $$`);
    await isolated.runtime.pool.query(`create trigger phase5_stall_rebuild_replay
      before insert on social_feed_items for each row
      execute function phase5_stall_rebuild_replay()`);
    const abort = new AbortController();
    const interrupted = rebuildSocialFeedProjection({ repository, aggregateScope: COLLECTION,
      maxEvents: 20, maxRecipientsPerEvent: 100, maxTotalRecipients: 10_000,
      signal: abort.signal });
    await waitForCondition(async () => {
      const state = await isolated.runtime.pool.query<{ projection_state: string }>(`
        select projection_state from social_feed_watermarks where aggregate_scope=$1`, [COLLECTION]);
      return state.rows[0]?.projection_state === 'rebuilding';
    }, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      description: 'the social feed projection to enter rebuilding state',
    });
    assert.equal((await isolated.runtime.pool.query<{ projection_state: string }>(`
      select projection_state from social_feed_watermarks where aggregate_scope=$1`,
    [COLLECTION])).rows[0]?.projection_state, 'rebuilding');
    abort.abort();
    await assert.rejects(interrupted, /abort/iu);
    assert.equal((await isolated.runtime.pool.query<{ projection_state: string }>(`
      select projection_state from social_feed_watermarks where aggregate_scope=$1`,
    [COLLECTION])).rows[0]?.projection_state, 'rebuilding');

    const operations = createPostgresSocialFeedOperationsRepository(isolated.runtime.pool);
    const rebuilding = rebuildFeedScopeForOperations({ operations, worker: repository,
      aggregateScope: COLLECTION, config: loadConfig({ DATABASE_URL: isolated.databaseUrl,
        OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
        WORKER_LEASE_DURATION_MS: '60000' }).feed!.operations });
    await event('social-event-during-rebuild', 108);
    const processing = worker().runOnce();
    const [rebuilt] = await Promise.all([rebuilding, processing]);
    await isolated.runtime.pool.query('drop trigger phase5_stall_rebuild_replay on social_feed_items');
    await isolated.runtime.pool.query('drop function phase5_stall_rebuild_replay()');
    assert.ok(rebuilt.eventCount >= 1);
    assert.equal(rebuilt.beforeWatermark.projectionState, 'rebuilding');
    assert.equal(rebuilt.afterWatermark.projectionState, 'live');
    assert.equal(new Set(rebuilt.beforeItemIds).size, rebuilt.beforeItemIds.length);
    assert.equal(new Set(rebuilt.afterItemIds).size, rebuilt.afterItemIds.length);
    assert.ok(rebuilt.afterItemIds.length >= rebuilt.beforeItemIds.length);
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items
      where source_event_id in ('social-event-cap','social-event-during-rebuild')
        and recipient_profile_id='takeover-follower' and state='visible'`)).rows[0]?.count, 2);
    assert.equal((await isolated.runtime.pool.query<{ last_commit_ordinal: string }>(`
      select last_commit_ordinal::text from social_feed_watermarks
       where aggregate_scope=$1`, [COLLECTION])).rows[0]?.last_commit_ordinal, '108');
  }, 30_000);

  test('production worker runtime stops and a fresh runtime resumes real Outbox delivery', async () => {
    async function waitUntilCompleted(outboxId: string): Promise<void> {
      await waitForCondition(async () => {
        const row = await isolated.runtime.pool.query<{ state: string }>(
          'select state from outbox_events where outbox_id=$1', [outboxId],
        );
        return row.rows[0]?.state === 'completed';
      }, {
        timeoutMs: 10_000,
        pollIntervalMs: 10,
        description: `social feed worker to complete ${outboxId}`,
      });
    }

    await event('social-event-lifecycle-1', 109);
    const firstRuntime = productionWorker();
    firstRuntime.start();
    await waitUntilCompleted('social-event-lifecycle-1');
    await firstRuntime.stop();

    await event('social-event-lifecycle-2', 110, { version: 1 });
    const restartedRuntime = productionWorker();
    restartedRuntime.start();
    await waitUntilCompleted('social-event-lifecycle-2');
    await restartedRuntime.stop();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items
      where source_event_id in ('social-event-lifecycle-1','social-event-lifecycle-2')
        and recipient_profile_id='takeover-follower'`)).rows[0]?.count, 2);
  }, 30_000);
});
