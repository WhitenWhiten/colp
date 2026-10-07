import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

const PREVIOUS_STABLE_MIGRATION = '202607280200_follows';

describeWithPostgres('P5-10 Feed projection expand migration', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_feed_migration');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('migrates an empty database with projection, transition, retention and query constraints', async () => {
    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select conname name from pg_constraint
       where conrelid in ('social_feed_items'::regclass,'social_feed_watermarks'::regclass)
      union all
      select indexname from pg_indexes
       where schemaname=current_schema()
         and tablename in ('social_feed_items','social_feed_watermarks')
      union all
      select tgname from pg_trigger
       where tgrelid in ('social_feed_items'::regclass,'social_feed_watermarks'::regclass)
         and not tgisinternal`);
    const names = new Set(catalog.rows.map((row) => row.name));
    for (const expected of [
      'social_feed_items_pkey', 'social_feed_items_event_recipient_key',
      'social_feed_items_recipient_fk', 'social_feed_items_actor_fk',
      'social_feed_items_collection_fk', 'social_feed_items_state_shape',
      'social_feed_items_retention_window', 'social_feed_items_transition_guard',
      'social_feed_items_recipient_page_idx', 'social_feed_items_retention_idx',
      'social_feed_items_recipient_kind_page_idx',
      'social_feed_watermarks_pkey', 'social_feed_watermarks_state_shape',
      'social_feed_watermarks_transition_guard',
    ]) assert.ok(names.has(expected), `missing ${expected}`);

    const columns = await isolated.runtime.pool.query<{ column_name: string }>(`
      select column_name from information_schema.columns
       where table_schema=current_schema() and table_name='social_feed_items'`);
    const namesOnly = columns.rows.map((row) => row.column_name);
    for (const forbidden of ['title', 'summary', 'body', 'content', 'payload_json']) {
      assert.equal(namesOnly.includes(forbidden), false, `private/unrecoverable field ${forbidden}`);
    }
  });

  test('upgrades the previous head and recovers down/forward without changing N-1 tables', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase5_feed_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202607290100_social_feed_projections');
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;
      assert.equal(await tablePresent(upgrade, 'social_feed_items'), false);
      await seedProfileAndCollection(upgrade, 'recipient', 'actor', 'collection');

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      assert.equal(await tablePresent(upgrade, 'social_feed_items'), true);
      assert.equal(await tablePresent(upgrade, 'social_feed_watermarks'), true);
      assert.equal(await tablePresent(upgrade, 'follows'), true);

      const down = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (down.error) throw down.error;
      assert.equal(await tablePresent(upgrade, 'social_feed_items'), false);
      assert.equal(await tablePresent(upgrade, 'follows'), true);
      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      assert.equal(await tablePresent(upgrade, 'social_feed_items'), true);
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
