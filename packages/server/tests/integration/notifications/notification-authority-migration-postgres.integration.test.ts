import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PREVIOUS_STABLE_MIGRATION = '202607290100_social_feed_projections';

describeWithPostgres('P5-16 Notification authority expand migration', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_notification_migration');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('migrates an empty database with ownership, uniqueness, state and retention constraints', async () => {
    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select conname name from pg_constraint where conrelid in (
        'notification_preferences'::regclass,'notifications'::regclass,
        'notification_deliveries'::regclass)
      union all select indexname from pg_indexes where schemaname=current_schema()
        and tablename in ('notification_preferences','notifications','notification_deliveries')
      union all select tgname from pg_trigger where tgrelid in (
        'notification_preferences'::regclass,'notifications'::regclass,
        'notification_deliveries'::regclass,'accounts'::regclass) and not tgisinternal`);
    const names = new Set(catalog.rows.map((row) => row.name));
    for (const expected of [
      'notification_preferences_pkey', 'notification_preferences_account_fk',
      'notifications_pkey', 'notifications_owner_identity_key',
      'notifications_event_recipient_type_key', 'notifications_recipient_fk',
      'notifications_recipient_page_idx', 'notifications_recipient_unread_idx',
      'notifications_retention_idx', 'notifications_transition_guard',
      'notifications_actor_guard',
      'notification_deliveries_pkey', 'notification_deliveries_notification_channel_key',
      'notification_deliveries_owner_notification_fk',
      'notification_deliveries_state_due_idx', 'notification_deliveries_transition_guard',
      'notifications_retention_window_state', 'notification_deliveries_retention_idx',
      'accounts_remove_notification_authority',
    ]) assert.ok(names.has(expected), `missing ${expected}`);

    const deliveryColumns = await isolated.runtime.pool.query<{ column_name: string }>(`
      select column_name from information_schema.columns where table_schema=current_schema()
       and table_name='notification_deliveries'`);
    const columns = deliveryColumns.rows.map((row) => row.column_name);
    for (const forbidden of ['provider_secret','provider_token','api_key','access_token',
      'refresh_token','credential']) assert.equal(columns.includes(forbidden), false);
  });

  test('FIX-H-005 backfills legacy rows to the state-aware contract before validating and rolls back without deleting authority data', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase5_notification_retention_contract');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202608090100_notification_retention_state_contract');
      const previous = await migrator.migrateTo('202608020800_notification_email_suppressions');
      if (previous.error) throw previous.error;
      await upgrade.runtime.pool.query(`insert into accounts(id,subject_id,status)
        values('retention-recipient','retention-subject','active')`);
      // Legacy rows under the historical uniform 90-day contract.
      await upgrade.runtime.pool.query(`insert into notifications(notification_id,
          recipient_account_id,source_event_id,notification_type,subject_type,subject_id,
          occurred_at,retain_until)
        values('legacy-unread','retention-recipient','legacy-event-unread','collection_change',
          'collection','legacy-subject','2026-01-01T00:00:00Z','2026-04-01T00:00:00Z')`);
      await upgrade.runtime.pool.query(`insert into notifications(notification_id,
          recipient_account_id,source_event_id,notification_type,subject_type,subject_id,
          occurred_at,retain_until)
        values('legacy-read','retention-recipient','legacy-event-read','collection_change',
          'collection','legacy-subject','2026-01-01T00:00:00Z','2026-04-01T00:00:00Z')`);
      await upgrade.runtime.pool.query(`update notifications set state='read',
          read_at='2026-01-11T00:00:00Z',state_revision=state_revision+1
        where notification_id='legacy-read'`);
      await upgrade.runtime.pool.query(`insert into notification_deliveries(delivery_id,
          notification_id,recipient_account_id,channel,created_at)
        values('legacy-delivery','legacy-unread','retention-recipient','email',
          '2026-01-01T00:00:00Z')`);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const rows = await upgrade.runtime.pool.query<{ notification_id: string;
        retain_until: Date }>(`select notification_id,retain_until from notifications
        where recipient_account_id='retention-recipient' order by notification_id`);
      assert.deepEqual(rows.rows.map((row) => [row.notification_id, row.retain_until.toISOString()]), [
        ['legacy-read', '2026-04-11T00:00:00.000Z'], // read_at + 90 days (< unread deadline)
        ['legacy-unread', '2027-01-01T00:00:00.000Z'], // extended, never shortened
      ]);
      const delivery = await upgrade.runtime.pool.query<{ retain_until: Date }>(`select retain_until
        from notification_deliveries where delivery_id='legacy-delivery'`);
      assert.equal(delivery.rows[0]?.retain_until.toISOString(), '2026-01-31T00:00:00.000Z');
      // The validating CHECK rejects rows that violate the state contract.
      await assert.rejects(upgrade.runtime.pool.query(`insert into notifications(notification_id,
          recipient_account_id,source_event_id,notification_type,subject_type,subject_id,
          occurred_at,retain_until)
        values('illegal','retention-recipient','illegal-event','collection_change',
          'collection','legacy-subject','2026-01-01T00:00:00Z','2026-04-01T00:00:00Z')`),
      (error: unknown) => (error as { constraint?: unknown }).constraint
        === 'notifications_retention_window_state');
      const down = await migrator.migrateTo('202608020800_notification_email_suppressions');
      if (down.error) throw down.error;
      // Rollback must not delete audit/authority data and restores the
      // historical CHECK without failing on migrated state-aware rows.
      assert.equal((await upgrade.runtime.pool.query<{ count: number }>(`select count(*)::int count
        from notifications where recipient_account_id='retention-recipient'`)).rows[0]?.count, 2);
      const restored = await upgrade.runtime.pool.query<{ convalidated: boolean }>(`select
        convalidated from pg_constraint where conname='notifications_retention_window'`);
      assert.equal(restored.rows[0]?.convalidated, false);
      assert.equal(await deliveryRetentionColumnPresent(upgrade), false);
      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      assert.equal(await deliveryRetentionColumnPresent(upgrade), true);
      const validated = await upgrade.runtime.pool.query<{ convalidated: boolean }>(`select
        convalidated from pg_constraint where conname='notifications_retention_window_state'`);
      assert.equal(validated.rows[0]?.convalidated, true);
      const again = await upgrade.runtime.pool.query<{ notification_id: string }>(`select
        notification_id from notifications where recipient_account_id='retention-recipient'
        order by notification_id`);
      assert.deepEqual(again.rows.map((row) => row.notification_id), ['legacy-read', 'legacy-unread']);
      await migrator.upgradeToCurrentLatest();
    } finally { await upgrade.close(); }
  }, 120_000);

  test('upgrades the current head and rolls down/forward without changing Feed ownership', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase5_notification_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202607290200_notification_authority');
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;
      assert.equal(await tablePresent(upgrade, 'notifications'), false);
      assert.equal(await tablePresent(upgrade, 'social_feed_items'), true);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      assert.equal(await tablePresent(upgrade, 'notifications'), true);
      assert.equal(await tablePresent(upgrade, 'notification_preferences'), true);
      assert.equal(await tablePresent(upgrade, 'notification_deliveries'), true);
      const down = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (down.error) throw down.error;
      assert.equal(await tablePresent(upgrade, 'notifications'), false);
      assert.equal(await tablePresent(upgrade, 'social_feed_items'), true);
      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      assert.equal(await tablePresent(upgrade, 'notifications'), true);
      await migrator.upgradeToCurrentLatest();
    } finally { await upgrade.close(); }
  }, 120_000);
});

async function tablePresent(runtime: IsolatedPostgresRuntime, table: string): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(
    `select to_regclass(current_schema() || '.' || $1) is not null present`, [table],
  )).rows[0]?.present ?? false;
}

async function deliveryRetentionColumnPresent(runtime: IsolatedPostgresRuntime): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(`select exists (
    select 1 from information_schema.columns where table_schema=current_schema()
      and table_name='notification_deliveries' and column_name='retain_until') present`)).rows[0]!.present;
}
