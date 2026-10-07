import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

describeWithPostgres('P5-17 production social Notification worker lifecycle', () => {
  const RECIPIENT = 'EREREREREREREREREREREQ';
  const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
  const COLLECTION = 'FBQUFBQUFBQUFBQUFBQUFA';
  let isolated: IsolatedPostgresRuntime;
  let metrics: InMemoryMetrics;
  let worker: NonNullable<ReturnType<typeof buildWorker>['outbox']>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_notification_worker',
      { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, RECIPIENT, ACTOR, COLLECTION);
    metrics = new InMemoryMetrics();
    const runtime = buildWorker(loadConfig({ DATABASE_URL: isolated.databaseUrl,
      LOG_LEVEL: 'silent', OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs', WORKER_CONCURRENCY: '2', WORKER_BATCH_SIZE: '2',
      WORKER_POLL_INTERVAL_MS: '5', WORKER_LEASE_DURATION_MS: '500',
      WORKER_HEARTBEAT_INTERVAL_MS: '100', WORKER_HANDLER_TIMEOUT_MS: '450',
      FEED_REBUILD_TIMEOUT_MS: '400', NOTIFICATION_RECOVERY_TIMEOUT_MS: '400' }),
    isolated.runtime, metrics);
    assert.ok(runtime.outbox);
    worker = runtime.outbox;
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function appendFollow(outboxId: string, eventId: string,
    type: 'social.follow-created' | 'social.follow-removed', occurredAt = new Date()) {
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values($1,'social-domain-event'),($2,'social-outbox') on conflict do nothing`,
    [eventId, outboxId]);
    await isolated.runtime.pool.query(`insert into outbox_events(outbox_id,domain_event_id,
      event_type,event_version,handler_name,handler_mode,aggregate_type,aggregate_id,
      aggregate_scope,aggregate_revision,commit_ordinal,occurred_at,payload_json,state,
      attempt_count,available_at,lease_generation)
      values($1,$2,$3,1,'social_follow_activity','delivery_each_event','profile-follow',$4,$5,
        null,null,$6,$7,'pending',0,current_timestamp,0)`,
    [outboxId, eventId, type, ACTOR, RECIPIENT, occurredAt,
      { actorProfileId: ACTOR, targetProfileId: RECIPIENT }]);
  }

  async function appendCollection(outboxId: string, eventId: string, ordinal: number,
    version = 2) {
    const payload: Record<string, unknown> = { collectionId: COLLECTION, ownerProfileId: ACTOR,
      publicationRevision: `c${ordinal}.p${ordinal}`,
      discoverabilityRecheckKey: `publication.collection:${COLLECTION}` };
    if (version === 2) payload.producerDiscoverability = 'public_candidate';
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values($1,'social-domain-event'),($2,'outbox')`, [eventId, outboxId]);
    await isolated.runtime.pool.query(`insert into outbox_events(outbox_id,domain_event_id,
      event_type,event_version,handler_name,handler_mode,aggregate_type,aggregate_id,
      aggregate_scope,aggregate_revision,commit_ordinal,occurred_at,payload_json,state,
      attempt_count,available_at,lease_generation)
      values($1,$2,'social.collection-change',$3,'social.publish-collection-change',
      'projection_latest_only','collection',$4,$4,$5,$6,current_timestamp,$7,'pending',0,
      current_timestamp,0)`, [outboxId, eventId, version, COLLECTION,
      `c${ordinal}.p${ordinal}`, ordinal, payload]);
  }

  async function forceReady(): Promise<void> {
    await isolated.runtime.pool.query(`update outbox_events set available_at=current_timestamp
      where state='retryable'`);
  }

  async function drain(limit = 100): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      await forceReady();
      if (!await worker.runOnce()) return;
    }
    throw new Error('P5-17 worker drain exceeded its bounded test budget');
  }

  async function setPreference(channel: 'in_app' | 'email', enabled: boolean): Promise<void> {
    await isolated.runtime.pool.query(`insert into notification_preferences(
      recipient_account_id,channel,enabled) values($1,$2,$3)
      on conflict(recipient_account_id,channel) do update set enabled=excluded.enabled,
      state_revision=notification_preferences.state_revision+1,updated_at=current_timestamp`,
    [RECIPIENT, channel, enabled]);
  }

  /**
   * Bind Follow authority to a PG-derived followed_at in the past, then return a
   * millisecond occurredAt strictly after it. Host/container clock skew otherwise
   * lets `new Date()` land before PG `current_timestamp` follows and the worker
   * completes the outbox as ineligible without inserting a notification.
   */
  async function ensureFollowAuthorityOccurredAt(): Promise<Date> {
    await isolated.runtime.pool.query(
      `delete from follows where actor_profile_id=$1 and target_profile_id=$2`,
      [ACTOR, RECIPIENT]);
    const followedAt = (await isolated.runtime.pool.query<{ followed_at: Date }>(`
      insert into follows(actor_profile_id,target_profile_id,followed_at)
        values($1,$2, date_trunc('milliseconds', current_timestamp) - interval '60 seconds')
      returning followed_at`, [ACTOR, RECIPIENT])).rows[0]!.followed_at;
    await setPreference('in_app', true);
    return new Date(followedAt.getTime() + 1_000);
  }

  test('Follow events re-read current authority/preferences and deduplicate recipient/event/type', async () => {
    const followedAt = (await isolated.runtime.pool.query<{ followed_at: Date }>(`
      insert into follows(actor_profile_id,target_profile_id,followed_at)
      values($1,$2,date_trunc('milliseconds',current_timestamp)-interval '60 seconds'
        + interval '0.5 milliseconds') returning followed_at`, [ACTOR, RECIPIENT])).rows[0]!.followed_at;
    // PostgreSQL retains the extra microseconds while the Product event's JS Date is millisecond-only.
    await appendFollow('p517-follow-outbox-1', 'p517-follow-event-1', 'social.follow-created', followedAt);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where recipient_account_id=$1 and source_event_id=$2
      and notification_type='follow_activity'`, [RECIPIENT, 'p517-follow-event-1']))
      .rows[0]?.count, 1);
    assert.deepEqual((await isolated.runtime.pool.query<{ recipient_account_id: string }>(`select
      recipient_account_id from notifications where source_event_id='p517-follow-event-1'`))
      .rows.map((row) => row.recipient_account_id), [RECIPIENT]);
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notification_deliveries where recipient_account_id=$1`, [RECIPIENT])).rows[0]?.count, 0);
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`select state
      from outbox_events where outbox_id='p517-follow-outbox-1'`)).rows[0]?.state, 'completed');

    await isolated.runtime.pool.query(`update outbox_events set state='retryable',
      available_at=current_timestamp,locked_until=null,completed_at=null,last_error=null
      where outbox_id='p517-follow-outbox-1'`);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where recipient_account_id=$1 and source_event_id=$2`,
    [RECIPIENT, 'p517-follow-event-1'])).rows[0]?.count, 1);

    await setPreference('email', true);
    await appendFollow('p517-follow-outbox-email', 'p517-follow-event-email',
      'social.follow-created', followedAt);
    await drain();
    assert.deepEqual((await isolated.runtime.pool.query<{ state: string;
      provider_message_id: string | null }>(`select delivery.state,delivery.provider_message_id
      from notification_deliveries delivery join notifications notification
      on notification.notification_id=delivery.notification_id
      where notification.source_event_id='p517-follow-event-email' and delivery.channel='email'`))
      .rows, [{ state: 'pending', provider_message_id: null }]);

    await setPreference('in_app', false);
    await appendFollow('p517-follow-outbox-pref-off', 'p517-follow-event-pref-off',
      'social.follow-created', followedAt);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-follow-event-pref-off'`)).rows[0]?.count, 0);
    await setPreference('in_app', true);

    await isolated.runtime.pool.query(`delete from follows where actor_profile_id=$1
      and target_profile_id=$2`, [ACTOR, RECIPIENT]);
    await appendFollow('p517-follow-outbox-unfollowed', 'p517-follow-event-unfollowed',
      'social.follow-created', followedAt);
    await appendFollow('p517-follow-outbox-removed', 'p517-follow-event-removed',
      'social.follow-removed');
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id in
      ('p517-follow-event-unfollowed','p517-follow-event-removed')`)).rows[0]?.count, 0);

    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,
      followed_at) values($1,$2,current_timestamp)`, [ACTOR, RECIPIENT]);
    await appendFollow('p517-follow-outbox-refollow-old', 'p517-follow-event-refollow-old',
      'social.follow-created', followedAt);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-follow-event-refollow-old'`)).rows[0]?.count, 0);
  });

  test('Feed producer and notification consumer re-read Follow/Collection/Profile/Account authority', async () => {
    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id)
      values($1,$2) on conflict do nothing`, [RECIPIENT, ACTOR]);
    await isolated.runtime.pool.query(`update collections set visibility='public',
      publication_slug='p517-public',published_at=current_timestamp,deleted_at=null,
      content_revision='c201',policy_revision='p201',commit_ordinal=201 where id=$1`, [COLLECTION]);
    await appendCollection('p517-collection-outbox-201', 'p517-collection-event-201', 201);
    assert.equal(await worker.runOnce(), true);
    const intent = await isolated.runtime.pool.query<{ outbox_id: string; payload_json: Record<string, unknown> }>(`
      select outbox_id,payload_json from outbox_events
      where event_type='social.feed-item-published'
      and payload_json->>'sourceEventId'='p517-collection-event-201'`);
    assert.equal(intent.rows.length, 1);
    assert.deepEqual(Object.keys(intent.rows[0]!.payload_json).sort(), [
      'collectionId', 'discoverabilityRecheckKey', 'feedItemId', 'recipientProfileId', 'sourceEventId',
    ]);
    assert.ok(Buffer.byteLength(JSON.stringify(intent.rows[0]!.payload_json), 'utf8') <= 2_048);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where recipient_account_id=$1 and source_event_id=$2
      and notification_type='collection_change'`, [RECIPIENT, 'p517-collection-event-201']))
      .rows[0]?.count, 1);

    await isolated.runtime.pool.query(`update collections set visibility='public',
      content_revision='c202',policy_revision='p202',commit_ordinal=202 where id=$1`, [COLLECTION]);
    await appendCollection('p517-collection-outbox-202', 'p517-collection-event-202', 202);
    assert.equal(await worker.runOnce(), true);
    await isolated.runtime.pool.query(`update collections set visibility='private',
      policy_revision='p203',commit_ordinal=203 where id=$1`, [COLLECTION]);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-collection-event-202'`)).rows[0]?.count, 0);

    await appendCollection('p517-collection-outbox-late', 'p517-collection-event-late', 200, 1);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-collection-event-late'`)).rows[0]?.count, 0);
  });

  test('authority transaction rolls back on crash, stale lease takeover, and retries exactly once', async () => {
    const occurredAt = await ensureFollowAuthorityOccurredAt();
    await isolated.runtime.pool.query(`create function p517_fail_notification_once()
      returns trigger language plpgsql as $$ begin
        if new.source_event_id='p517-crash-event' then raise exception 'P517_MARKER crash'; end if;
        return new; end $$`);
    await isolated.runtime.pool.query(`create trigger p517_fail_notification_once before insert
      on notifications for each row execute function p517_fail_notification_once()`);
    await appendFollow('p517-crash-outbox', 'p517-crash-event', 'social.follow-created', occurredAt);
    assert.equal(await worker.runOnce(), true);
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-crash-event'`)).rows[0]?.count, 0);
    await isolated.runtime.pool.query('drop trigger p517_fail_notification_once on notifications');
    await isolated.runtime.pool.query('drop function p517_fail_notification_once()');
    await forceReady();
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-crash-event'`)).rows[0]?.count, 1);

    await isolated.runtime.pool.query(`create function p517_stall_old_owner()
      returns trigger language plpgsql as $$ begin
        if new.source_event_id='p517-takeover-event' and exists(select 1 from outbox_events
          where domain_event_id='p517-takeover-event' and lease_generation=1) then
          perform pg_sleep(0.30); end if; return new; end $$`);
    await isolated.runtime.pool.query(`create trigger p517_stall_old_owner before insert
      on notifications for each row execute function p517_stall_old_owner()`);
    await appendFollow('p517-takeover-outbox', 'p517-takeover-event', 'social.follow-created', occurredAt);
    const oldAttempt = worker.runOnce();
    await waitForCondition(async () => {
      const active = await isolated.runtime.pool.query<{ count: number }>(`
        select count(*)::int count from pg_stat_activity
        where datname=current_database() and pid <> pg_backend_pid()
          and state='active' and wait_event='PgSleep'
          and query like '%notifications%'
      `);
      return (active.rows[0]?.count ?? 0) > 0;
    }, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      description: 'the old notification attempt to enter the controlled PostgreSQL stall',
    });
    await isolated.runtime.pool.query(`update outbox_events set locked_until=current_timestamp
      where outbox_id='p517-takeover-outbox'`);
    const newAttempt = worker.runOnce();
    await Promise.all([oldAttempt, newAttempt]);
    await isolated.runtime.pool.query('drop trigger p517_stall_old_owner on notifications');
    await isolated.runtime.pool.query('drop function p517_stall_old_owner()');
    await forceReady();
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-takeover-event'`)).rows[0]?.count, 1);
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notification_deliveries delivery join notifications notification
        on notification.notification_id=delivery.notification_id
      where notification.source_event_id='p517-takeover-event'`)).rows[0]?.count, 1);
    assert.ok((await isolated.runtime.pool.query<{ lease_generation: string }>(`select
      lease_generation::text from outbox_events where outbox_id='p517-takeover-outbox'`))
      .rows[0]!.lease_generation >= '2');
  }, 30_000);

  test('post-authority completion failure, unknown versions, telemetry and stop/restart stay bounded', async () => {
    const occurredAt = await ensureFollowAuthorityOccurredAt();
    await appendFollow('p517-complete-fail-outbox', 'p517-complete-fail-event',
      'social.follow-created', occurredAt);
    await isolated.runtime.pool.query(`create function p517_fail_complete()
      returns trigger language plpgsql as $$ begin
        if new.outbox_id='p517-complete-fail-outbox' and new.state='completed' then
          raise exception 'injected completion failure'; end if; return new; end $$`);
    await isolated.runtime.pool.query(`create trigger p517_fail_complete before update on outbox_events
      for each row execute function p517_fail_complete()`);
    await worker.runOnce();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-complete-fail-event'`)).rows[0]?.count, 1);
    await isolated.runtime.pool.query('drop trigger p517_fail_complete on outbox_events');
    await isolated.runtime.pool.query('drop function p517_fail_complete()');
    await forceReady();
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-complete-fail-event'`)).rows[0]?.count, 1);

    await appendFollow('p517-unknown-outbox', 'p517-unknown-event', 'social.follow-created', occurredAt);
    await isolated.runtime.pool.query(`update outbox_events set event_version=99,
      payload_json=jsonb_build_object('secret','P517_SECRET_CONTENT')
      where outbox_id='p517-unknown-outbox'`);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await forceReady();
      await worker.runOnce();
    }
    const unknown = await isolated.runtime.pool.query<{ state: string; last_error: string }>(`
      select state,last_error from outbox_events where outbox_id='p517-unknown-outbox'`);
    assert.equal(unknown.rows[0]?.state, 'dead_letter');
    assert.doesNotMatch(unknown.rows[0]?.last_error ?? '', /P517_SECRET_CONTENT/u);
    assert.equal(metrics.get('outbox.dead_letter') >= 1, true);
    assert.equal(metrics.get('notification.social.created') >= 1, true);

    await isolated.runtime.pool.query(`create function p517_stall_before_authority_commit()
      returns trigger language plpgsql as $$ begin
        if new.source_event_id='p517-lifecycle-event' then perform pg_sleep(0.30); end if;
        return new; end $$`);
    await isolated.runtime.pool.query(`create trigger p517_stall_before_authority_commit
      before insert on notifications for each row
      execute function p517_stall_before_authority_commit()`);
    await appendFollow('p517-lifecycle-outbox', 'p517-lifecycle-event', 'social.follow-created', occurredAt);
    worker.start();
    await waitForCondition(async () => {
      const active = await isolated.runtime.pool.query<{ count: number }>(`
        select count(*)::int count from pg_stat_activity
        where datname=current_database() and pid <> pg_backend_pid()
          and state='active' and wait_event='PgSleep'
          and query like '%notifications%'
      `);
      return (active.rows[0]?.count ?? 0) > 0;
    }, {
      timeoutMs: 5_000,
      pollIntervalMs: 5,
      description: 'the lifecycle notification insert to enter the controlled PostgreSQL stall',
    });
    await worker.stop();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-lifecycle-event'`)).rows[0]?.count, 0);
    await isolated.runtime.pool.query(
      'drop trigger p517_stall_before_authority_commit on notifications');
    await isolated.runtime.pool.query('drop function p517_stall_before_authority_commit()');
    await forceReady();
    worker.start();
    await waitForCondition(async () => {
      const row = await isolated.runtime.pool.query<{ state: string }>(
        `select state from outbox_events where outbox_id='p517-lifecycle-outbox'`);
      return row.rows[0]?.state === 'completed';
    }, {
      timeoutMs: 5_000,
      pollIntervalMs: 5,
      description: 'the restarted notification worker to complete the lifecycle event',
    });
    await worker.stop();
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(
      `select state from outbox_events where outbox_id='p517-lifecycle-outbox'`))
      .rows[0]?.state, 'completed');

    await isolated.runtime.pool.query(`update accounts set status='disabled' where id=$1`, [ACTOR]);
    await appendFollow('p517-disabled-actor-outbox', 'p517-disabled-actor-event',
      'social.follow-created');
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='p517-disabled-actor-event'`)).rows[0]?.count, 0);
  }, 30_000);

  test('CG-F010 delivery-time official hide_public suppresses a pending collection-change notification', async () => {
    // The previous lifecycle case disabled the actor and the 202-case set the
    // collection private; re-arm both exactly like the 201 collection-change
    // test (the collection-change follower authority is RECIPIENT -> ACTOR).
    await isolated.runtime.pool.query(`update accounts set status='active' where id=$1`, [ACTOR]);
    await isolated.runtime.pool.query(`update accounts set status='active' where id=$1`, [RECIPIENT]);
    await isolated.runtime.pool.query(`update collections set visibility='public',
      publication_slug='cg010-public',published_at=current_timestamp,deleted_at=null,
      content_revision='c9100',policy_revision='p9100',commit_ordinal=9100 where id=$1`, [COLLECTION]);
    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id)
      values($1,$2) on conflict do nothing`, [RECIPIENT, ACTOR]);
    // Control: before any hide the delivery is emitted (mirrors the 201 case).
    await appendCollection('cg010-outbox-ok', 'cg010-event-ok', 9100, 2);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='cg010-event-ok'`)).rows[0]?.count, 1,
      'before hide the collection-change delivery is emitted');

    // Official hide_public on the target collection lands BEFORE the next
    // publication event is drained: the pending delivery must be suppressed.
    await isolated.runtime.pool.query(`insert into moderation_cases(
      id, reporter_account_id, target_kind, target_id, target_json, target_fingerprint,
      category, description, status, revision, created_at, updated_at)
      values('cg010-case', $1, 'collection', $2, '{"kind":"collection"}'::jsonb,
        'cg010-case-fp', 'spam', 'cg010 fixture', 'submitted', '1', now(), now())`,
    [RECIPIENT, COLLECTION]);
    await isolated.runtime.pool.query(`insert into moderation_actions(
      id, case_id, target_kind, target_id, target_json, target_fingerprint,
      action, reason, actor_account_id, state, revision, created_at)
      values('cg010-hide', 'cg010-case', 'collection', $1, '{"kind":"collection"}'::jsonb,
        'cg010-hide-fp', 'hide_public', 'cg010 hide fixture', $2, 'active', '1', now())`,
    [COLLECTION, ACTOR]);
    await appendCollection('cg010-outbox-hidden', 'cg010-event-hidden', 9101, 2);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from notifications where source_event_id='cg010-event-hidden'`)).rows[0]?.count, 0,
      'a hidden collection must not deliver its collection-change notification');
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`select state
      from outbox_events where outbox_id='cg010-outbox-hidden'`)).rows[0]?.state, 'completed',
      'the suppressed delivery settles as completed');
  }, 30_000);
});