import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresNotificationAuthorityRepository } from '../../../src/infrastructure/notifications/index.js';
import type { NotificationInput } from '../../../src/modules/notifications/index.js';
import {
  createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-16 PostgreSQL Notification authority repository', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_notification_authority', {
      maxConnections: 8,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedAccounts(isolated, ['recipient-a', 'recipient-b', 'actor', 'actor-soft-delete']);
  }, 120_000);
  afterAll(async () => isolated?.close());

  const notification = (overrides: Partial<NotificationInput> = {}): NotificationInput => ({
    notificationId: 'notification-1', recipientAccountId: 'recipient-a',
    sourceEventId: 'event-1', notificationType: 'collection_change', actorProfileId: 'actor',
    subjectType: 'collection', subjectId: 'collection-1',
    occurredAt: new Date('2026-01-01T00:00:00Z'), ...overrides,
  });

  test('materializes conservative default preferences per active account', async () => {
    const repository = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    const first = await repository.getPreferences('recipient-a');
    const second = await repository.getPreferences('recipient-a');
    assert.deepEqual(first, second);
    assert.equal(first.inAppEnabled, true);
    assert.equal(first.emailEnabled, false);
    assert.equal(first.inAppStateRevision, 0n);
    assert.equal(first.emailStateRevision, 0n);
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from notification_preferences
       where recipient_account_id='recipient-a'`)).rows[0]?.count, 2);
    await assert.rejects(repository.getPreferences('missing-account'), /active account/i);
  });

  test('preference channels have independent database-enforced revision CAS', async () => {
    const repository = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    await repository.getPreferences('recipient-a');
    const updated = await isolated.runtime.pool.query<{ state_revision: string }>(`
      update notification_preferences
         set enabled=false,state_revision=state_revision+1,
             updated_at=updated_at+interval '1 microsecond'
       where recipient_account_id='recipient-a' and channel='in_app' and state_revision=0
       returning state_revision`);
    assert.equal(updated.rows[0]?.state_revision, '1');
    const email = await isolated.runtime.pool.query<{ enabled: boolean; state_revision: string }>(`
      select enabled,state_revision from notification_preferences
       where recipient_account_id='recipient-a' and channel='email'`);
    assert.deepEqual(email.rows[0], { enabled: false, state_revision: '0' });
    await rejectsConstraint(isolated.runtime.pool.query(`update notification_preferences
      set enabled=true,updated_at=updated_at+interval '1 microsecond'
      where recipient_account_id='recipient-a' and channel='in_app'`),
    'notification_preferences_transition_guard');
    await rejectsConstraint(isolated.runtime.pool.query(`update notification_preferences
      set channel='email',state_revision=state_revision+1,
          updated_at=updated_at+interval '1 microsecond'
      where recipient_account_id='recipient-a' and channel='in_app'`),
    'notification_preferences_transition_guard');
  });

  test('concurrent duplicate recipient/event/type writes expose one durable winner', async () => {
    const first = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    const second = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    const results = await Promise.all([
      first.saveNotification(notification()),
      second.saveNotification(notification({ notificationId: 'notification-duplicate' })),
    ]);
    assert.equal(results.filter((result) => result.inserted).length, 1);
    assert.equal(new Set(results.map((result) => result.notification.notificationId)).size, 1);
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from notifications where recipient_account_id='recipient-a'
       and source_event_id='event-1' and notification_type='collection_change'`)
    ).rows[0]?.count, 1);
  });

  test('rejects a conflicting duplicate and MVP Billing/Creator types', async () => {
    const repository = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    await repository.saveNotification(notification({ notificationId: 'notification-binding',
      sourceEventId: 'event-binding' }));
    await assert.rejects(repository.saveNotification(notification({
      notificationId: 'notification-binding-other', sourceEventId: 'event-binding',
      subjectId: 'other-collection',
    })), /immutable facts/i);
    for (const forbidden of ['billing', 'creator']) {
      await assert.rejects(isolated.runtime.pool.query(`insert into notifications(
        notification_id,recipient_account_id,source_event_id,notification_type,
        subject_type,subject_id,occurred_at,retain_until)
        values($1,'recipient-a',$2,$3,'profile','actor',current_timestamp,
          current_timestamp + interval '365 days')`,
      [`notification-${forbidden}`, `event-${forbidden}`, forbidden]), /notification_type/iu);
    }
  });

  test('delivery identity has one winner and no provider secret state', async () => {
    const repository = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    const saved = await repository.saveNotification(notification({
      notificationId: 'notification-delivery', sourceEventId: 'event-delivery',
    }));
    const outcomes = await Promise.all([
      repository.saveDelivery({ deliveryId: 'delivery-a',
        notificationId: saved.notification.notificationId,
        recipientAccountId: 'recipient-a', channel: 'email' }),
      repository.saveDelivery({ deliveryId: 'delivery-b',
        notificationId: saved.notification.notificationId,
        recipientAccountId: 'recipient-a', channel: 'email' }),
    ]);
    assert.equal(outcomes.filter((result) => result.inserted).length, 1);
    assert.equal(new Set(outcomes.map((result) => result.delivery.deliveryId)).size, 1);
    const raw = await isolated.runtime.pool.query<Record<string, unknown>>(
      `select * from notification_deliveries where notification_id=$1`,
      [saved.notification.notificationId],
    );
    assert.equal(raw.rowCount, 1);
    assert.equal(Object.keys(raw.rows[0]!).some((key) =>
      /secret|token|credential|api_key/iu.test(key)), false);
    const ownerBound = await repository.saveNotification(notification({
      notificationId: 'notification-owner-bound', sourceEventId: 'event-owner-bound',
    }));
    await rejectsConstraint(isolated.runtime.pool.query(`insert into notification_deliveries(
      delivery_id,notification_id,recipient_account_id,channel)
      values('delivery-wrong-owner',$1,'recipient-b','email')`,
    [ownerBound.notification.notificationId]), 'notification_deliveries_owner_notification_fk');
  });

  test('read transition is owner-scoped, one-way and concurrent CAS has one winner', async () => {
    const repository = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    const saved = await repository.saveNotification(notification({
      notificationId: 'notification-read', sourceEventId: 'event-read',
    }));
    assert.equal(await repository.markRead({ recipientAccountId: 'recipient-b',
      notificationId: saved.notification.notificationId, expectedStateRevision: 0n }), null);
    const outcomes = await Promise.all([
      repository.markRead({ recipientAccountId: 'recipient-a',
        notificationId: saved.notification.notificationId, expectedStateRevision: 0n }),
      repository.markRead({ recipientAccountId: 'recipient-a',
        notificationId: saved.notification.notificationId, expectedStateRevision: 0n }),
    ]);
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.equal(outcomes.find(Boolean)?.state, 'read');
    assert.equal(outcomes.find(Boolean)?.stateRevision, 1n);
    assert.equal(await repository.markRead({ recipientAccountId: 'recipient-a',
      notificationId: saved.notification.notificationId, expectedStateRevision: 1n }), null);
    await rejectsConstraint(isolated.runtime.pool.query(`update notifications
      set state='unread',read_at=null,state_revision=state_revision+1
      where notification_id=$1`, [saved.notification.notificationId]),
    'notifications_transition_guard');
  });

  test('delivery transition is revision fenced and terminal states cannot move', async () => {
    const repository = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    const saved = await repository.saveNotification(notification({
      notificationId: 'notification-delivery-cas', sourceEventId: 'event-delivery-cas',
    }));
    const delivery = await repository.saveDelivery({ deliveryId: 'delivery-cas',
      notificationId: saved.notification.notificationId,
      recipientAccountId: 'recipient-a', channel: 'email' });
    const outcomes = await Promise.all([
      repository.transitionDelivery({ recipientAccountId: 'recipient-a',
        deliveryId: delivery.delivery.deliveryId, expectedState: 'pending',
        expectedStateRevision: 0n, nextState: 'suppressed' }),
      repository.transitionDelivery({ recipientAccountId: 'recipient-a',
        deliveryId: delivery.delivery.deliveryId, expectedState: 'pending',
        expectedStateRevision: 0n, nextState: 'leased' }),
    ]);
    assert.equal(outcomes.filter(Boolean).length, 1);
    const winner = outcomes.find(Boolean)!;
    if (winner.state === 'suppressed') {
      assert.equal(await repository.transitionDelivery({ recipientAccountId: 'recipient-a',
        deliveryId: winner.deliveryId, expectedState: 'suppressed',
        expectedStateRevision: winner.stateRevision, nextState: 'leased' }), null);
    }
  });

  test('delivery database state graph accepts every legal edge and rejects illegal edges', async () => {
    const repository = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    let sequence = 0;
    const createDelivery = async () => {
      sequence += 1;
      const saved = await repository.saveNotification(notification({
        notificationId: `notification-graph-${sequence}`,
        sourceEventId: `event-graph-${sequence}`,
      }));
      return (await repository.saveDelivery({ deliveryId: `delivery-graph-${sequence}`,
        notificationId: saved.notification.notificationId,
        recipientAccountId: 'recipient-a', channel: 'email' })).delivery;
    };
    const transition = async (deliveryId: string, expectedState: Parameters<
      typeof repository.transitionDelivery>[0]['expectedState'], expectedStateRevision: bigint,
    nextState: Parameters<typeof repository.transitionDelivery>[0]['nextState']) => {
      const result = await repository.transitionDelivery({ recipientAccountId: 'recipient-a',
        deliveryId, expectedState, expectedStateRevision, nextState });
      assert.ok(result, `${expectedState} -> ${nextState} was rejected`);
      return result;
    };

    await transition((await createDelivery()).deliveryId, 'pending', 0n, 'suppressed');
    for (const terminal of ['delivered', 'suppressed', 'dead_letter'] as const) {
      const pending = await createDelivery();
      const leased = await transition(pending.deliveryId, 'pending', 0n, 'leased');
      await transition(leased.deliveryId, 'leased', leased.stateRevision, terminal);
    }
    const retryPath = await createDelivery();
    const firstLease = await transition(retryPath.deliveryId, 'pending', 0n, 'leased');
    const retryable = await transition(firstLease.deliveryId, 'leased',
      firstLease.stateRevision, 'retryable');
    const secondLease = await transition(retryable.deliveryId, 'retryable',
      retryable.stateRevision, 'leased');
    assert.equal(secondLease.attemptCount, 2);

    const retrySuppress = await createDelivery();
    const suppressLease = await transition(retrySuppress.deliveryId, 'pending', 0n, 'leased');
    const suppressRetry = await transition(suppressLease.deliveryId, 'leased',
      suppressLease.stateRevision, 'retryable');
    await transition(suppressRetry.deliveryId, 'retryable',
      suppressRetry.stateRevision, 'suppressed');

    const illegal = await createDelivery();
    await rejectsConstraint(isolated.runtime.pool.query(`update notification_deliveries
      set state='delivered',attempt_count=1,delivered_at=current_timestamp,
          state_revision=state_revision+1,updated_at=current_timestamp
      where delivery_id=$1`, [illegal.deliveryId]), 'notification_deliveries_transition_guard');
  });

  test('database rejects cross-account owner mutation and lifecycle deletion removes owned rows', async () => {
    const repository = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    await repository.getPreferences('recipient-b');
    const saved = await repository.saveNotification(notification({ recipientAccountId: 'recipient-b',
      notificationId: 'notification-owner', sourceEventId: 'event-owner' }));
    await repository.saveDelivery({ deliveryId: 'delivery-owner',
      notificationId: saved.notification.notificationId,
      recipientAccountId: 'recipient-b', channel: 'email' });
    await repository.saveNotification(notification({ recipientAccountId: 'recipient-a',
      actorProfileId: 'recipient-b', notificationId: 'notification-deleted-actor',
      sourceEventId: 'event-deleted-actor', subjectType: 'profile', subjectId: 'recipient-b' }));
    await repository.saveNotification(notification({ recipientAccountId: 'recipient-a',
      actorProfileId: 'actor-soft-delete', notificationId: 'notification-soft-deleted-actor',
      sourceEventId: 'event-soft-deleted-actor', subjectType: 'profile',
      subjectId: 'actor-soft-delete' }));
    await rejectsConstraint(isolated.runtime.pool.query(`update notifications
      set recipient_account_id='recipient-a' where notification_id=$1`,
    [saved.notification.notificationId]), 'notifications_transition_guard');
    await rejectsConstraint(isolated.runtime.pool.query(`update notification_deliveries
      set recipient_account_id='recipient-a' where delivery_id='delivery-owner'`),
    'notification_deliveries_transition_guard');
    await isolated.runtime.pool.query(`update accounts set status='disabled' where id='recipient-b'`);
    for (const table of ['notification_preferences','notifications','notification_deliveries']) {
      assert.equal((await isolated.runtime.pool.query<{ count: number }>(
        `select count(*)::int count from ${table} where recipient_account_id='recipient-b'`,
      )).rows[0]?.count, 0, `${table} survived account deletion`);
    }
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from notifications
       where notification_id='notification-deleted-actor'`)).rows[0]?.count, 0);
    await isolated.runtime.pool.query(`update accounts set deleted_at=current_timestamp
      where id='actor-soft-delete'`);
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from notifications
       where notification_id='notification-soft-deleted-actor'`)).rows[0]?.count, 0);
    for (const actorProfileId of ['recipient-b', 'actor-soft-delete']) {
      await rejectsConstraint(isolated.runtime.pool.query(`insert into notifications(
        notification_id,recipient_account_id,source_event_id,notification_type,
        actor_profile_id,subject_type,subject_id,occurred_at,retain_until)
        values($1,'recipient-a',$2,'follow_activity',$3,'profile',$3,
          current_timestamp,current_timestamp+interval '365 days')`,
      [`notification-inactive-${actorProfileId}`, `event-inactive-${actorProfileId}`,
        actorProfileId]), 'notification_actor_active');
    }
  });

  test('retention purge is inclusive, bounded, database-clock guarded and cascades deliveries', async () => {
    const repository = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    for (const [id, occurredAt] of [
      ['expired', '2025-01-01T00:00:00Z'], ['boundary', '2025-01-02T00:00:00Z'],
      ['newer', '2025-01-02T00:00:01Z'],
    ] as const) {
      const saved = await repository.saveNotification(notification({ notificationId: `notification-${id}`,
        sourceEventId: `event-${id}`, occurredAt: new Date(occurredAt) }));
      await repository.saveDelivery({ deliveryId: `delivery-${id}`,
        notificationId: saved.notification.notificationId,
        recipientAccountId: 'recipient-a', channel: 'email' });
    }
    const purged = await repository.purgeExpiredNotifications({
      cutoff: new Date('2026-01-02T00:00:00Z'), limit: 2,
    });
    assert.deepEqual(new Set(purged.notificationIds),
      new Set(['notification-expired', 'notification-boundary']));
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from notification_deliveries
       where delivery_id in ('delivery-expired','delivery-boundary')`)).rows[0]?.count, 0);
    const current = await repository.saveNotification(notification({
      notificationId: 'notification-current', sourceEventId: 'event-current',
      occurredAt: new Date(),
    }));
    const guarded = await repository.purgeExpiredNotifications({
      cutoff: new Date(Date.now() + 100 * 24 * 60 * 60 * 1_000), limit: 10_000,
    });
    assert.equal(guarded.notificationIds.includes(current.notification.notificationId), false);
  });

  test('retention purge skips locked victims without exceeding its bound', async () => {
    const repository = createPostgresNotificationAuthorityRepository(isolated.runtime.pool);
    for (const [id, occurredAt] of [
      ['locked', '2024-01-01T00:00:00Z'], ['available', '2024-01-01T00:00:01Z'],
    ] as const) {
      await repository.saveNotification(notification({ notificationId: `notification-${id}`,
        sourceEventId: `event-${id}`, occurredAt: new Date(occurredAt) }));
    }
    const locker = await isolated.runtime.pool.connect();
    try {
      await locker.query('begin');
      await locker.query(`select notification_id from notifications
        where notification_id='notification-locked' for update`);
      const purged = await repository.purgeExpiredNotifications({
        cutoff: new Date('2025-01-02T00:00:00Z'), limit: 1,
      });
      assert.deepEqual(purged.notificationIds, ['notification-available']);
      assert.equal((await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
        from notifications where notification_id='notification-locked'`)).rows[0]?.count, 1);
      await locker.query('rollback');
    } finally {
      locker.release();
    }
  });
});

async function seedAccounts(runtime: IsolatedPostgresRuntime, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await runtime.runtime.pool.query(`insert into accounts(id,subject_id,status)
      values($1,$2,'active')`, [id, `subject-${id}`]);
    await runtime.runtime.pool.query(`insert into profiles(account_id,display_name)
      values($1,$2)`, [id, id]);
  }
}

async function rejectsConstraint(promise: Promise<unknown>, constraint: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { constraint?: unknown }).constraint, constraint);
    return true;
  });
}
