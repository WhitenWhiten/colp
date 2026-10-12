import assert from 'node:assert/strict';
import { afterAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('Sync Push request binding upgrade from the deployed release', () => {
  let isolated: IsolatedPostgresRuntime | undefined;
  afterAll(async () => isolated?.close());

  test('appends the new migration after existing history and replays startup safely', async () => {
    isolated = await createIsolatedPostgresRuntime('sync_push_upgrade');
    const { db, pool } = isolated.runtime;
    const migrator = createMigrator(db, undefined, isolated.schema);
    const previous = await migrator.migrateTo('202610260000_mcp_plan_receipt_owner_approval');
    if (previous.error) throw previous.error;
    const tableName = `${isolated.schema}.sync_push_request_bindings`;
    assert.equal((await pool.query('select to_regclass($1) as name', [tableName])).rows[0].name, null);

    const upgraded = await runMigrations(db, 'latest');
    assert.equal(upgraded.results[0]?.migrationName, '202610270100_sync_push_request_bindings');
    assert.ok(upgraded.results.every(result => result.status === 'Success' && result.direction === 'Up'));
    assert.equal((await pool.query('select to_regclass($1) as name', [tableName])).rows[0].name,
      'sync_push_request_bindings');
    assert.deepEqual((await runMigrations(db, 'latest')).results, []);
  });
});
