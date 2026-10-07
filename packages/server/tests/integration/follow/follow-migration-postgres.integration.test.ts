import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PREVIOUS_STABLE_MIGRATION = '202607280100_product_sync_center_reads';
const FOLLOW_MIGRATION = '202607280200_follows';

describeWithPostgres('P5-02 Follow expand migration', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_follow_migration');
    const migrator = createMigrator(isolated.runtime.db, 'migrations', isolated.schema);
    const result = await migrator.migrateTo(FOLLOW_MIGRATION);
    if (result.error) throw result.error;
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('migrates an empty database with stable binding, lifecycle, time and page constraints', async () => {
    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select conname name from pg_constraint where conrelid='follows'::regclass
      union all
      select indexname from pg_indexes
       where schemaname=current_schema() and tablename='follows'
      union all
      select tgname from pg_trigger
       where tgrelid='follows'::regclass and not tgisinternal`);
    const names = new Set(catalog.rows.map((row) => row.name));
    for (const expected of [
      'follows_pkey',
      'follows_actor_profile_fk',
      'follows_target_profile_fk',
      'follows_distinct_profiles',
      'follows_followed_at_finite',
      'follows_actor_page_idx',
      'follows_target_page_idx',
      'follows_binding_immutable',
      'follows_profile_lifecycle_guard',
    ]) assert.ok(names.has(expected), `missing ${expected}`);

    const columns = await isolated.runtime.pool.query<{ column_name: string }>(`
      select column_name from information_schema.columns
       where table_schema=current_schema() and table_name='follows'
       order by ordinal_position`);
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'actor_profile_id', 'target_profile_id', 'followed_at',
    ]);
    for (const forbidden of [
      'social_feed_items', 'notification_preferences', 'notifications',
      'notification_deliveries', 'entitlements', 'memberships', 'receipts',
    ]) assert.equal(await tablePresent(isolated, forbidden), false, `unexpected ${forbidden} table`);
  });

  test('upgrades the previous head, supports N/N-1 identity writers, and recovers down/forward', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase5_follow_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202607280200_follows');
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;
      assert.equal(await tablePresent(upgrade, 'follows'), false);

      await seedProfiles(upgrade, ['actor', 'target']);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      assert.equal(await tablePresent(upgrade, 'follows'), true);

      // N-1 identity code can still rename a locator while N uses stable Profile ids.
      await upgrade.runtime.pool.query(
        `update profile_handles set handle='actor-renamed' where account_id='actor'`,
      );
      await upgrade.runtime.pool.query(
        `insert into follows(actor_profile_id,target_profile_id) values('actor','target')`,
      );
      assert.equal((await upgrade.runtime.pool.query<{ count: number }>(
        `select count(*)::int count from follows`,
      )).rows[0]?.count, 1);

      const down = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (down.error) throw down.error;
      assert.equal(await tablePresent(upgrade, 'follows'), false);
      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      assert.equal(await tablePresent(upgrade, 'follows'), true);
      assert.equal((await upgrade.runtime.pool.query<{ count: number }>(
        `select count(*)::int count from follows`,
      )).rows[0]?.count, 0);
      await migrator.upgradeToCurrentLatest();
    } finally {
      await upgrade.close();
    }
  }, 120_000);
});

async function tablePresent(runtime: IsolatedPostgresRuntime, table: string): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(
    `select to_regclass(current_schema() || '.' || $1) is not null present`, [table],
  )).rows[0]?.present ?? false;
}

async function seedProfiles(runtime: IsolatedPostgresRuntime, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await runtime.runtime.pool.query(
      `insert into accounts(id,subject_id,status) values($1,$2,'active')`, [id, `subject-${id}`],
    );
    await runtime.runtime.pool.query(
      `insert into profiles(account_id,display_name) values($1,$2)`, [id, id],
    );
    await runtime.runtime.pool.query(
      `insert into profile_handles(handle,account_id) values($1,$2)`, [id, id],
    );
  }
}
