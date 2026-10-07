import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresNotificationAuthorityRepository,
  createPostgresNotificationOperationsRepository } from '../../../src/infrastructure/notifications/index.js';
import { purgeNotificationRetentionForOperations,
  deriveEmailDeliveryWorkerRunning,
  evaluateNotificationCapabilityReadiness,
  recoverNotificationAccountForOperations,
  replayNotificationDeadLettersForOperations } from '../../../src/modules/notifications/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-25 production Notification operations', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_notification_operations',
      { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    for (const id of ['ops-a', 'ops-b']) {
      await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status)
        values($1,$2,'active')`, [id, `subject-${id}`]);
      await isolated.runtime.pool.query(`insert into profiles(account_id,display_name)
        values($1,$1)`, [id]);
    }
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('captures complete account-scoped authority sets and purge is inclusive, bounded and cascading', async () => {
    const authority = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    const operations = createPostgresNotificationOperationsRepository(isolated.runtime.pool);
    await authority.getPreferences('ops-a');
    await authority.getPreferences('ops-b');
    const cutoff = new Date('2026-01-01T00:00:00.000Z');
    for (const [id, account, occurredAt] of [
      ['old', 'ops-a', '2025-01-01T00:00:00.000Z'],
      ['boundary', 'ops-a', '2025-01-01T00:00:00.000Z'],
      ['current', 'ops-a', '2025-01-01T00:00:00.001Z'],
      ['other', 'ops-b', '2025-01-01T00:00:00.000Z'],
    ] as const) {
      const saved = await authority.saveNotification({ notificationId: `ops-${id}`,
        recipientAccountId: account, sourceEventId: `ops-event-${id}`,
        notificationType: 'follow_activity', actorProfileId: null, subjectType: 'profile',
        subjectId: 'ops-a', occurredAt: new Date(occurredAt) });
      await authority.saveDelivery({ deliveryId: `ops-delivery-${id}`,
        notificationId: saved.notification.notificationId, recipientAccountId: account,
        channel: 'email' });
      if (id !== 'current') {
        await authority.transitionDelivery({ recipientAccountId: account,
          deliveryId: `ops-delivery-${id}`, expectedState: 'pending', expectedStateRevision: 0n,
          nextState: 'suppressed' });
      }
    }
    const evidence = await purgeNotificationRetentionForOperations({ authority, operations,
      recipientAccountId: 'ops-a', cutoff, limit: 2 });
    assert.deepEqual(evidence.beforePreferences.map((row) => row.channel), ['email', 'in_app']);
    assert.deepEqual(evidence.beforeNotifications.map((row) => row.notificationId),
      ['ops-boundary', 'ops-current', 'ops-old']);
    assert.equal(evidence.beforeDeliveries.length, 3);
    assert.deepEqual(new Set(evidence.deletedNotificationIds), new Set(['ops-boundary', 'ops-old']));
    // deliveries were created moments ago, so their 30-day horizon has not
    // elapsed: the independent delivery purge is a no-op here and the
    // notification purge cascades the rest (explicit FK delete order).
    assert.deepEqual(evidence.deletedDeliveryIds, []);
    assert.deepEqual(evidence.afterNotifications.map((row) => row.notificationId), ['ops-current']);
    assert.deepEqual(evidence.afterDeliveries.map((row) => row.deliveryId), ['ops-delivery-current']);
    assert.equal((await operations.captureAccount('ops-b')).notifications.length, 1);
    assert.equal((await purgeNotificationRetentionForOperations({ authority, operations,
      recipientAccountId: 'ops-a', cutoff, limit: 2 })).deletedCount, 0);
  });

  test('FIX-H-005 state-aware purge honors unread 365-day and read 90-day authority cutoffs and is repeatable', async () => {
    const authority = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    // Dedicated account: the purge is account-scoped, so other tests' rows
    // (e.g. ops-current) must never leak into the exact victim/remaining sets.
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status)
      values('ops-purge','ops-purge-subject','active')`);
    // One millisecond anchor. current_timestamp has microseconds, and the
    // cutoff Date keeps only milliseconds, so two live clocks in the same
    // millisecond make read_at + 90 days land after the truncated cutoff.
    const cutoff = (await isolated.runtime.pool.query<{ anchor: Date }>(
      `select date_trunc('milliseconds', current_timestamp) anchor`)).rows[0]!.anchor;
    await isolated.runtime.pool.query(`insert into notifications(notification_id,
        recipient_account_id,source_event_id,notification_type,subject_type,subject_id,
        occurred_at,retain_until)
      values
        ('purge-unread-364',$1,'ev-364','follow_activity','profile','ops-a',
          $2::timestamptz - interval '364 days', $2::timestamptz + interval '1 day'),
        ('purge-unread-365',$1,'ev-365','follow_activity','profile','ops-a',
          $2::timestamptz - interval '365 days', $2::timestamptz),
        ('purge-read-89',$1,'ev-r89','follow_activity','profile','ops-a',
          $2::timestamptz - interval '300 days', $2::timestamptz + interval '65 days'),
        ('purge-read-90',$1,'ev-r90','follow_activity','profile','ops-a',
          $2::timestamptz - interval '300 days', $2::timestamptz + interval '65 days'),
        ('purge-read-late',$1,'ev-rlate','follow_activity','profile','ops-a',
          $2::timestamptz - interval '400 days', $2::timestamptz - interval '35 days'),
        ('purge-fresh',$1,'ev-fresh','follow_activity','profile','ops-a',
          $2::timestamptz, $2::timestamptz + interval '365 days')`, ['ops-purge', cutoff]);
    // Read conversions: the convergence trigger fixes retain_until to the
    // authoritative read boundary (min(unread deadline, read_at+90d)).
    await isolated.runtime.pool.query(`update notifications set state='read',
        read_at=$1::timestamptz - interval '89 days',state_revision=state_revision+1
      where notification_id='purge-read-89'`, [cutoff]);
    await isolated.runtime.pool.query(`update notifications set state='read',
        read_at=$1::timestamptz - interval '90 days',state_revision=state_revision+1
      where notification_id='purge-read-90'`, [cutoff]);
    await isolated.runtime.pool.query(`update notifications set state='read',
        read_at=$1::timestamptz - interval '30 days',state_revision=state_revision+1
      where notification_id='purge-read-late'`, [cutoff]);
    const purged = await authority.purgeExpiredNotifications({ cutoff, limit: 10,
      recipientAccountId: 'ops-purge' });
    assert.deepEqual(new Set(purged.notificationIds), new Set(
      ['purge-unread-365', 'purge-read-90', 'purge-read-late']));
    const remaining = (await isolated.runtime.pool.query<{ notification_id: string }>(`select
      notification_id from notifications where recipient_account_id='ops-purge'
      and notification_id like 'purge-%'`)).rows
      .map((row) => row.notification_id);
    assert.deepEqual(new Set(remaining), new Set(
      ['purge-unread-364', 'purge-read-89', 'purge-fresh']));
    // Repeated purge is a deterministic no-op.
    assert.equal((await authority.purgeExpiredNotifications({ cutoff, limit: 10,
      recipientAccountId: 'ops-purge' })).deletedCount, 0);
  });

  test('FIX-H-005 delivery purge removes only resolved terminal rows after a 30-day horizon and preserves active and unresolved rows', async () => {
    const authority = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    const source = await authority.saveNotification({ notificationId: 'ops-delivery-source-30',
      recipientAccountId: 'ops-a', sourceEventId: 'ops-event-delivery-30',
      notificationType: 'follow_activity', actorProfileId: null, subjectType: 'profile',
      subjectId: 'ops-a', occurredAt: new Date() });
    for (const [id, days] of [['delivered-31', 31], ['delivered-29', 29],
      ['suppressed-40', 40], ['dead-40', 40], ['pending-40', 40]] as const) {
      // One notification per delivery: the (notification_id,channel) email
      // lane is UNIQUE, so each delivery needs its own authority row.
      const owner = await authority.saveNotification({ notificationId: `ops-delivery-src-${id}`,
        recipientAccountId: 'ops-a', sourceEventId: `ops-event-delivery-src-${id}`,
        notificationType: 'follow_activity', actorProfileId: null, subjectType: 'profile',
        subjectId: 'ops-a', occurredAt: new Date() });
      await isolated.runtime.pool.query(`insert into notification_deliveries(delivery_id,
          notification_id,recipient_account_id,channel,created_at)
        values($1,$2,'ops-a','email',current_timestamp - $3::int * interval '1 day')`,
      [`ops-dlv-${id}`, owner.notification.notificationId, days]);
    }
    for (const id of ['delivered-31', 'delivered-29']) {
      await authority.transitionDelivery({ recipientAccountId: 'ops-a',
        deliveryId: `ops-dlv-${id}`, expectedState: 'pending', expectedStateRevision: 0n,
        nextState: 'leased' });
      await authority.transitionDelivery({ recipientAccountId: 'ops-a',
        deliveryId: `ops-dlv-${id}`, expectedState: 'leased', expectedStateRevision: 1n,
        nextState: 'delivered' });
    }
    await authority.transitionDelivery({ recipientAccountId: 'ops-a',
      deliveryId: 'ops-dlv-suppressed-40', expectedState: 'pending',
      expectedStateRevision: 0n, nextState: 'leased' });
    await authority.transitionDelivery({ recipientAccountId: 'ops-a',
      deliveryId: 'ops-dlv-suppressed-40', expectedState: 'leased',
      expectedStateRevision: 1n, nextState: 'suppressed' });
    await authority.transitionDelivery({ recipientAccountId: 'ops-a',
      deliveryId: 'ops-dlv-dead-40', expectedState: 'pending', expectedStateRevision: 0n,
      nextState: 'leased' });
    await authority.transitionDelivery({ recipientAccountId: 'ops-a',
      deliveryId: 'ops-dlv-dead-40', expectedState: 'leased', expectedStateRevision: 1n,
      nextState: 'dead_letter', errorCategory: 'retry_exhausted' });
    // The generated 30-day horizon is provable on every row.
    const horizon = await isolated.runtime.pool.query<{ delivery_id: string;
      created_at: Date; retain_until: Date }>(`select delivery_id,created_at,retain_until
      from notification_deliveries where recipient_account_id='ops-a'
      and delivery_id like 'ops-dlv-%'`);
    for (const row of horizon.rows) {
      assert.equal(row.retain_until.getTime(), row.created_at.getTime() + 30 * 86_400_000);
    }
    const cutoff = (await isolated.runtime.pool.query<{ now: Date }>(
      `select current_timestamp now`)).rows[0]!.now;
    const purged = await authority.purgeExpiredDeliveries({ cutoff, limit: 10,
      recipientAccountId: 'ops-a' });
    assert.deepEqual(new Set(purged.deliveryIds),
      new Set(['ops-dlv-delivered-31', 'ops-dlv-suppressed-40']));
    const remaining = (await isolated.runtime.pool.query<{ delivery_id: string }>(`select
      delivery_id from notification_deliveries where recipient_account_id='ops-a'
      and delivery_id like 'ops-dlv-%'`)).rows
      .map((row) => row.delivery_id);
    assert.deepEqual(new Set(remaining), new Set(
      ['ops-dlv-delivered-29', 'ops-dlv-dead-40', 'ops-dlv-pending-40']));
    // Repeated purge is a deterministic no-op.
    assert.equal((await authority.purgeExpiredDeliveries({ cutoff, limit: 10,
      recipientAccountId: 'ops-a' })).deletedCount, 0);
    // The delivery purge never touches the source Notification authority.
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int
      count from notifications where notification_id='ops-delivery-source-30'`)).rows[0]?.count, 1);
  });

  test('dead-letter replay preserves attempt, lease generation, error and fail-closes future versions', async () => {
    const pool = isolated.runtime.pool;
    for (const [id, error] of [['stable', 'dependency unavailable'],
      ['future', 'unknown event version 99']] as const) {
      await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
        values($1,'outbox',current_timestamp)`, [`ops-outbox-${id}`]);
      await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
        handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
        commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,
        dead_lettered_at,last_error) values($1,$1,'social.follow-created',1,
        'social_follow_activity','delivery_each_event','profile','ops-a','ops-a','1',1,
        current_timestamp,'{}','dead_letter',4,current_timestamp,3,current_timestamp,$2)`,
      [`ops-outbox-${id}`, error]);
    }
    const operations = createPostgresNotificationOperationsRepository(pool);
    const result = await replayNotificationDeadLettersForOperations({ operations,
      recipientAccountId: 'ops-a', limit: 10 });
    assert.deepEqual(result.outboxIds, ['ops-outbox-stable']);
    const rows = await pool.query(`select outbox_id,state,attempt_count,lease_generation,last_error
      from outbox_events where outbox_id like 'ops-outbox-%' order by outbox_id`);
    assert.deepEqual(rows.rows, [
      { outbox_id: 'ops-outbox-future', state: 'dead_letter', attempt_count: 4,
        lease_generation: '3', last_error: 'unknown event version 99' },
      { outbox_id: 'ops-outbox-stable', state: 'retryable', attempt_count: 4,
        lease_generation: '3', last_error: 'dependency unavailable' },
    ]);
  });

  test('FIX-L-063 withdrawal dead-letter replay resolves the affected recipient from the closed payload', async () => {
    const pool = isolated.runtime.pool;
    // A unfollow B writes the withdrawal outbox row with aggregate_scope on the
    // follow TARGET (the envelope identity bound by the social_feed_withdrawal
    // route), while the withdrawal actually updates A's Feed rows. Ops replay
    // by the affected account (A) must recover it from the closed payload
    // actorProfileId and must not pull B's other dead letters — including a
    // withdrawal whose aggregate_scope happens to equal A (B unfollow A).
    for (const [id, actor, target] of [
      ['ops-wd-ab', 'ops-a', 'ops-b'],
      ['ops-wd-ba', 'ops-b', 'ops-a'],
    ] as const) {
      await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
        values($1,'outbox',current_timestamp)`, [id]);
      await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
        handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
        commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,
        dead_lettered_at,last_error) values($1,$1,'social.follow-removed',1,
        'social_feed_withdrawal','delivery_each_event','profile-follow',$2,$3,'1',1,
        current_timestamp,jsonb_build_object('actorProfileId',$2::text,'targetProfileId',$3::text),
        'dead_letter',4,current_timestamp,3,current_timestamp,'dependency unavailable')`,
      [id, actor, target]);
    }
    // B's own Notification dead letter (aggregate_scope=ops-b) is unrelated to A.
    await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      values('ops-wd-notif-b','outbox',current_timestamp)`);
    await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
      handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
      commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,
      dead_lettered_at,last_error) values('ops-wd-notif-b','ops-wd-notif-b',
      'social.follow-created',1,'social_follow_activity','delivery_each_event','profile',
      'ops-b','ops-b','1',1,current_timestamp,'{}','dead_letter',4,current_timestamp,3,
      current_timestamp,'dependency unavailable')`);
    const operations = createPostgresNotificationOperationsRepository(pool);
    const replayedByA = await operations.replayDeadLetters({ recipientAccountId: 'ops-a',
      limit: 10 });
    assert.deepEqual(replayedByA.outboxIds, ['ops-wd-ab'],
      'replay by the affected recipient must recover only the A-unfollow-B withdrawal');
    const states = await pool.query<{ outbox_id: string; state: string }>(`select outbox_id,state
      from outbox_events where outbox_id like 'ops-wd-%' order by outbox_id`);
    assert.deepEqual(states.rows, [
      { outbox_id: 'ops-wd-ab', state: 'retryable' },
      { outbox_id: 'ops-wd-ba', state: 'dead_letter' },
      { outbox_id: 'ops-wd-notif-b', state: 'dead_letter' },
    ]);
    // Re-entrant: repeating the replay for the same account is a no-op.
    assert.deepEqual((await operations.replayDeadLetters({ recipientAccountId: 'ops-a',
      limit: 10 })).outboxIds, []);
    // The target account never pulls the actor's withdrawal dead letter, and
    // its own replay stays strictly account-scoped.
    assert.deepEqual(new Set((await operations.replayDeadLetters({ recipientAccountId: 'ops-b',
      limit: 10 })).outboxIds),
      new Set(['ops-wd-ba', 'ops-wd-notif-b']));
  });

  test('purge races safely with mark-one and preference CAS across two real connections', async () => {
    const pool = isolated.runtime.pool;
    const base = createPostgresNotificationAuthorityRepository(pool);
    const operations = createPostgresNotificationOperationsRepository(pool);
    await base.getPreferences('ops-a');
    const saved = await base.saveNotification({ notificationId: 'ops-race',
      recipientAccountId: 'ops-a', sourceEventId: 'ops-event-race',
      notificationType: 'follow_activity', actorProfileId: null, subjectType: 'profile',
      subjectId: 'ops-a', occurredAt: new Date(Date.now() - 400 * 86_400_000) });
    await base.saveDelivery({ deliveryId: 'ops-delivery-race',
      notificationId: saved.notification.notificationId, recipientAccountId: 'ops-a',
      channel: 'email' });
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('begin');
      const transactionalAuthority = createPostgresNotificationAuthorityRepository(
        first as unknown as typeof pool);
      const read = await transactionalAuthority.markRead({ recipientAccountId: 'ops-a',
        notificationId: 'ops-race', expectedStateRevision: 0n });
      assert.equal(read?.stateRevision, 1n);
      await first.query(`update notification_preferences set enabled=false,
        state_revision=state_revision+1,updated_at=updated_at+interval '1 microsecond'
        where recipient_account_id='ops-a' and channel='in_app' and state_revision=0`);
      const competingAuthority = createPostgresNotificationAuthorityRepository(
        second as unknown as typeof pool);
      const purge = await competingAuthority.purgeExpiredNotifications({
        recipientAccountId: 'ops-a', cutoff: new Date(), limit: 10 });
      assert.equal(purge.notificationIds.includes('ops-race'), false);
      await first.query('commit');
      const after = await operations.captureAccount('ops-a');
      assert.equal(after.notifications.find((row) => row.notificationId === 'ops-race')?.stateRevision,
        '1');
      assert.equal(after.preferences.find((row) => row.channel === 'in_app')?.stateRevision, '1');
      assert.ok(after.deliveries.some((row) => row.deliveryId === 'ops-delivery-race'));
    } finally {
      await first.query('rollback').catch(() => undefined); first.release(); second.release();
    }
  });

  test('purge skips a mark-one locked row and deletes it on the next bounded batch', async () => {
    const pool = isolated.runtime.pool;
    const authority = createPostgresNotificationAuthorityRepository(pool);
    await authority.saveNotification({ notificationId: 'ops-race-lock',
      recipientAccountId: 'ops-a', sourceEventId: 'ops-event-race-lock',
      notificationType: 'follow_activity', actorProfileId: null, subjectType: 'profile',
      subjectId: 'ops-a', occurredAt: new Date(Date.now() - 400 * 86_400_000) });
    const reader = await pool.connect();
    const purger = await pool.connect();
    try {
      await reader.query('begin');
      const readingAuthority = createPostgresNotificationAuthorityRepository(
        reader as unknown as typeof pool);
      const read = await readingAuthority.markRead({ recipientAccountId: 'ops-a',
        notificationId: 'ops-race-lock', expectedStateRevision: 0n });
      assert.equal(read?.stateRevision, 1n);
      const purgingAuthority = createPostgresNotificationAuthorityRepository(
        purger as unknown as typeof pool);
      const firstPurge = await purgingAuthority.purgeExpiredNotifications({
        recipientAccountId: 'ops-a', cutoff: new Date(), limit: 10 });
      assert.equal(firstPurge.notificationIds.includes('ops-race-lock'), false);
      await reader.query('commit');
      const resumedPurge = await purgingAuthority.purgeExpiredNotifications({
        recipientAccountId: 'ops-a', cutoff: new Date(), limit: 10 });
      assert.ok(resumedPurge.notificationIds.includes('ops-race-lock'));
      assert.equal((await pool.query(`select count(*)::int count from notifications
        where notification_id='ops-race-lock'`)).rows[0]?.count, 0);
    } finally {
      await reader.query('rollback').catch(() => undefined); reader.release(); purger.release();
    }
  });

  test('notification operations migration supports N-1 upgrade, rollback and forward recovery', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase5_notification_operations_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202607291500_notification_operations');
      const previous = await migrator.migrateTo('202607290200_notification_authority');
      if (previous.error) throw previous.error;
      assert.equal(await columnPresent(upgrade, 'last_error_category'), false);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      assert.equal(await columnPresent(upgrade, 'last_error_category'), true);
      const down = await migrator.migrateTo('202607290200_notification_authority');
      if (down.error) throw down.error;
      assert.equal(await columnPresent(upgrade, 'last_error_category'), false);
      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      assert.equal(await columnPresent(upgrade, 'last_error_category'), true);
      await migrator.upgradeToCurrentLatest();
    } finally { await upgrade.close(); }
  }, 120_000);

  test('delivery replay preserves attempts and fixed error while fencing with a new revision', async () => {
    const authority = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    const operations = createPostgresNotificationOperationsRepository(isolated.runtime.pool);
    const notification = await authority.saveNotification({ notificationId: 'ops-delivery-source',
      recipientAccountId: 'ops-a', sourceEventId: 'ops-delivery-source-event',
      notificationType: 'follow_activity', actorProfileId: null, subjectType: 'profile',
      subjectId: 'ops-a', occurredAt: new Date() });
    await authority.saveDelivery({ deliveryId: 'ops-delivery-dead',
      notificationId: notification.notification.notificationId, recipientAccountId: 'ops-a',
      channel: 'email' });
    await authority.transitionDelivery({ recipientAccountId: 'ops-a',
      deliveryId: 'ops-delivery-dead', expectedState: 'pending', expectedStateRevision: 0n,
      nextState: 'leased' });
    await authority.transitionDelivery({ recipientAccountId: 'ops-a',
      deliveryId: 'ops-delivery-dead', expectedState: 'leased', expectedStateRevision: 1n,
      nextState: 'dead_letter', errorCategory: 'provider_unavailable' });
    const replay = await operations.replayDeadLetters({ recipientAccountId: 'ops-a', limit: 1 });
    assert.deepEqual(replay.deliveryIds, ['ops-delivery-dead']);
    const row = (await isolated.runtime.pool.query(`select state,attempt_count,state_revision,
      leased_until,last_error_category from notification_deliveries
      where delivery_id='ops-delivery-dead'`)).rows[0];
    assert.deepEqual(row, { state: 'retryable', attempt_count: 1, state_revision: '3',
      leased_until: null, last_error_category: 'provider_unavailable' });
  });

  test('recovery requeues only missing formal source events and is idempotent before Worker claim', async () => {
    const pool = isolated.runtime.pool;
    await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      values('ops-recovery-outbox','outbox',current_timestamp),
        ('ops-recovery-event','event',current_timestamp)`);
    await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
      handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
      commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,
      completed_at) values('ops-recovery-outbox','ops-recovery-event','social.follow-created',1,
      'social_follow_activity','delivery_each_event','profile','ops-a','ops-a','1',1,
      current_timestamp,'{}','completed',1,current_timestamp,1,current_timestamp)`);
    const operations = createPostgresNotificationOperationsRepository(pool);
    // FIX-L-057: the ops CLI runs recovery through the application wrapper, which
    // snapshots the account before and after and merges the replayed outbox ids.
    const first = await recoverNotificationAccountForOperations({ operations,
      recipientAccountId: 'ops-a', limit: 10 });
    assert.deepEqual(first.outboxIds, ['ops-recovery-outbox']);
    assert.deepEqual(first.beforePreferences, first.afterPreferences);
    assert.deepEqual(first.beforeNotifications, first.afterNotifications);
    assert.deepEqual(first.beforeDeliveries, first.afterDeliveries);
    assert.deepEqual((await recoverNotificationAccountForOperations({ operations,
      recipientAccountId: 'ops-a', limit: 10 })).outboxIds, []);
    const row = (await pool.query(`select state,attempt_count,lease_generation,completed_at
      from outbox_events where outbox_id='ops-recovery-outbox'`)).rows[0];
    assert.equal(row.state, 'retryable'); assert.equal(row.attempt_count, 1);
    assert.equal(row.lease_generation, '1'); assert.ok(row.completed_at instanceof Date);
  });

  test('m2: the API reports optionalDelivery degraded/worker_unavailable when the worker is stopped', async () => {
    const pool = isolated.runtime.pool;
    // Make the worker signal deterministic: drop completed/leased outbox rows
    // (which read as 'running') while keeping due work (pending/retryable/
    // dead_letter), so the repository derives worker='stopped' exactly like a
    // stopped process with due work would.
    await executeWithoutPermanenceGuards(pool, `delete from outbox_events where handler_name=any($1::text[])
      and state in ('completed','leased')`,
    [['social_follow_activity', 'social_feed_item_notification']]);
    await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      values('m2-outbox','outbox',current_timestamp),('m2-event','event',current_timestamp)`);
    await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
      handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
      commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation)
      values('m2-outbox','m2-event','social.follow-created',1,'social_follow_activity',
        'delivery_each_event','profile','ops-a','ops-a','1',1,current_timestamp,'{}','pending',0,
        current_timestamp,0)`);
    const operations = createPostgresNotificationOperationsRepository(pool);
    const status = await operations.inspectStatus();
    assert.equal(status.worker, 'stopped',
      'due work with no worker activity must derive worker=stopped (m2)');
    const config = loadConfig({ DATABASE_URL: isolated.databaseUrl, NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' });
    // Mirror the production api.ts wiring exactly: workerRunning is derived
    // from the repository worker signal through deriveEmailDeliveryWorkerRunning.
    const app = buildApiApp({
      config,
      readiness: isolated.runtime,
      collectionMetadataMutationRoutes: 'disabled',
      feedCapabilityReadiness: async () => ({ capability: 'feed', status: 'ready', reason: 'none' }),
      notificationCapabilityReadiness: async () => evaluateNotificationCapabilityReadiness(
        status, config.notifications!.operations,
        { enabled: true, workerRunning: deriveEmailDeliveryWorkerRunning(status.worker) }),
    });
    await app.ready();
    try {
      const notifications = await app.inject({ method: 'GET', url: '/ready/features/notifications' });
      assert.equal(notifications.statusCode, 503);
      assert.deepEqual(notifications.json().optionalDelivery,
        { status: 'degraded', reason: 'worker_unavailable' },
        'the API must report degraded/worker_unavailable when the worker is known-stopped (m2)');
    } finally {
      await app.close();
      // resource_id_ledger rows are immutable by design; only the transient
      // outbox row is removed.
      await executeWithoutPermanenceGuards(pool, `delete from outbox_events where outbox_id='m2-outbox'`);
    }
  });

  test('dependency failure degrades only Notification feature readiness, not global or Feed', async () => {
    const config = loadConfig({ DATABASE_URL: isolated.databaseUrl, NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' });
    const unavailablePool = new Pool({ connectionString: isolated.databaseUrl, max: 1 });
    await unavailablePool.end();
    const status = await createPostgresNotificationOperationsRepository(unavailablePool).inspectStatus();
    const app = buildApiApp({ config, readiness: isolated.runtime,
      collectionMetadataMutationRoutes: 'disabled',
      feedCapabilityReadiness: async () => ({ capability: 'feed', status: 'ready', reason: 'none' }),
      notificationCapabilityReadiness: async () => evaluateNotificationCapabilityReadiness(
        status, config.notifications!.operations),
    });
    await app.ready();
    const [global, feed, notifications] = await Promise.all([
      app.inject({ method: 'GET', url: '/ready' }),
      app.inject({ method: 'GET', url: '/ready/features/feed' }),
      app.inject({ method: 'GET', url: '/ready/features/notifications' }),
    ]);
    assert.equal(global.statusCode, 200); assert.equal(feed.statusCode, 200);
    assert.equal(notifications.statusCode, 503);
    assert.equal(notifications.json().inApp.reason, 'dependency_unavailable');
    await app.close();
  });
});

async function columnPresent(runtime: IsolatedPostgresRuntime, column: string): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(`select exists (
    select 1 from information_schema.columns where table_schema=current_schema()
      and table_name='notification_deliveries' and column_name=$1) present`, [column])).rows[0]!.present;
}
