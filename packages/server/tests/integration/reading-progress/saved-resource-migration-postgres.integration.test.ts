import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';

import { createIsolatedPostgresRuntime, describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P2B-15 saved resources expand migration', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_saved_resource_migration');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('migrates an empty database with ownership, target, live uniqueness and ordering facts', async () => {
    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select conname name from pg_constraint where conrelid='saved_resources'::regclass
      union all select indexname from pg_indexes
       where schemaname=current_schema() and tablename='saved_resources'`);
    const names = new Set(catalog.rows.map((row) => row.name));
    for (const expected of ['saved_resources_pkey', 'saved_resources_account_fk',
      'saved_resources_target_type_check', 'saved_resources_deletion_facts_check',
      'saved_resources_live_target_uidx', 'saved_resources_account_order_idx']) {
      assert.ok(names.has(expected), `missing ${expected}`);
    }
    const ordering = await isolated.runtime.pool.query<{ indexdef: string }>(`
      select indexdef from pg_indexes where schemaname=current_schema()
       and indexname='saved_resources_account_order_idx'`);
    assert.match(ordering.rows[0]?.indexdef ?? '',
      /\(account_id, saved_at DESC, resource_type, resource_id\).*WHERE \(deleted_at IS NULL\)/);
  });

  test('upgrades the previous stable migration and supports down/up through production migrations', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase2b_saved_resource_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202607250800_saved_resources');
      const previous = await migrator.migrateTo('202607250700_publication_relation_projection');
      if (previous.error) throw previous.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.saved_resources') is not null present`)).rows[0]?.present, false);
      const latest = await migrator.migrateToLatest(); if (latest.error) throw latest.error;
      const down = await migrator.migrateTo('202607250700_publication_relation_projection'); if (down.error) throw down.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.saved_resources') is not null present`)).rows[0]?.present, false);
      const up = await migrator.migrateToLatest(); if (up.error) throw up.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.saved_resources') is not null present`)).rows[0]?.present, true);
      await migrator.upgradeToCurrentLatest();
    } finally { await upgrade.close(); }
  }, 120_000);

  test('down refuses Operation-less audits from any module and preserves every audit row', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase2b_saved_resource_audit_guard');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202607250800_saved_resources');
      const latest = await migrator.migrateToLatest(); if (latest.error) throw latest.error;
      for (const [principalId, eventType, details] of [
        ['p-saved', 'saved_resource.saved', { accountId: 'a1', resourceType: 'node', changed: true }],
        ['p-progress', 'reading_progress.upserted', { accountId: 'a1', resourceType: 'node' }],
        ['p-future', 'future_module.recorded', { accountId: 'a2' }],
      ]) await upgrade.runtime.pool.query(`insert into audit_events(operation_id,collection_id,principal_id,event_type,details_json)
        values(null,null,$1,$2,$3)`, [principalId, eventType, details]);
      const before = await upgrade.runtime.pool.query<{ count: string }>(
        'select count(*) count from audit_events where operation_id is null and collection_id is null');
      assert.equal(Number(before.rows[0]?.count), 3);
      const down = await migrator.migrateTo('202607250700_publication_relation_projection');
      assert.ok(down.error, 'down must refuse while Operation-less audits remain');
      assert.match(String(down.error), /saved_resources down refused/);
      assert.match(String(down.error), /saved_resource=1, reading_progress=1, other=1/);
      const after = await upgrade.runtime.pool.query<{ count: string }>(
        'select count(*) count from audit_events where operation_id is null and collection_id is null');
      assert.equal(Number(after.rows[0]?.count), 3, 'refused down must not delete any audit row');
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.saved_resources') is not null present`)).rows[0]?.present, true,
        'refused down must roll back the table drop');
      const pairCheck = await upgrade.runtime.pool.query<{ name: string }>(`
        select conname name from pg_constraint where conrelid='audit_events'::regclass
          and conname='audit_events_authority_pair_check'`);
      assert.equal(pairCheck.rowCount, 1, 'refused down must keep the authority pair check');
      await executeWithoutPermanenceGuards(upgrade.runtime.pool,
        'delete from audit_events where operation_id is null and collection_id is null');
      const retried = await migrator.migrateTo('202607250700_publication_relation_projection');
      if (retried.error) throw retried.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.saved_resources') is not null present`)).rows[0]?.present, false,
        'down completes once the incompatible rows are explicitly removed');
      await migrator.upgradeToCurrentLatest();
    } finally { await upgrade.close(); }
  }, 120_000);
});
