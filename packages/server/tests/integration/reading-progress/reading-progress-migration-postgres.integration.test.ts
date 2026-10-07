import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P2B-18 reading progress expand migration', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_reading_progress_migration');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('migrates an empty database with owner, target, numeric, uniqueness and ordering facts', async () => {
    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select conname name from pg_constraint where conrelid='reading_progress'::regclass
      union all select indexname from pg_indexes where schemaname=current_schema() and tablename='reading_progress'`);
    const names = new Set(catalog.rows.map((row) => row.name));
    for (const expected of ['reading_progress_pkey', 'reading_progress_account_fk',
      'reading_progress_target_type_check', 'reading_progress_status_check',
      'reading_progress_value_range_check', 'reading_progress_state_value_check',
      'reading_progress_completed_facts_check', 'reading_progress_account_target_key',
      'reading_progress_account_updated_idx']) assert.ok(names.has(expected), `missing ${expected}`);
    const column = await isolated.runtime.pool.query<{ data_type: string; numeric_scale: number }>(`
      select data_type,numeric_scale from information_schema.columns
      where table_schema=current_schema() and table_name='reading_progress' and column_name='progress'`);
    assert.deepEqual(column.rows[0], { data_type: 'numeric', numeric_scale: 5 });
  });

  test('upgrades P2B-15 stable schema and supports production down/up', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase2b_reading_progress_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202607250900_reading_progress');
      const previous = await migrator.migrateTo('202607250800_saved_resources'); if (previous.error) throw previous.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.reading_progress') is not null present`)).rows[0]?.present, false);
      const latest = await migrator.migrateToLatest(); if (latest.error) throw latest.error;
      const down = await migrator.migrateTo('202607250800_saved_resources'); if (down.error) throw down.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.reading_progress') is not null present`)).rows[0]?.present, false);
      const up = await migrator.migrateToLatest(); if (up.error) throw up.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.reading_progress') is not null present`)).rows[0]?.present, true);
      await migrator.upgradeToCurrentLatest();
    } finally { await upgrade.close(); }
  }, 120_000);
});
