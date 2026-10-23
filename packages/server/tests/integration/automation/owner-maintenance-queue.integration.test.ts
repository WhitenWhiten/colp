import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import { createPostgresOwnerMaintenanceQueue } from '../../../src/infrastructure/automation/owner-maintenance-queue.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('automation maintenance owner admission and distributed leases', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('automation_maintenance_queue');
    const migrator = createMigrator(isolated.runtime.db, undefined, isolated.schema);
    const previous = await migrator.migrateTo('202611010600_incremental_ledger_archives');
    if (previous.error) throw previous.error;
    await isolated.runtime.pool.query("insert into accounts(id,subject_id) select 'unused-'||n,'unused-subject-'||n from generate_series(1,1000) n");
    await isolated.runtime.pool.query("insert into accounts(id,subject_id) values ('owner-before','subject-before'),('owner-after','subject-after')");
    await isolated.runtime.pool.query("insert into automation_settings(owner_id) values ('owner-before')");
    const latest = await migrator.migrateToLatest(); if (latest.error) throw latest.error;
    await isolated.runtime.pool.query("insert into automation_settings(owner_id) values ('owner-after')");
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('backfills and registers automation owners without scanning unused accounts', async () => {
    const owners = await isolated.runtime.pool.query('select owner_id from automation_owner_maintenance order by owner_id');
    assert.deepEqual(owners.rows.map(row => row.owner_id), ['owner-after', 'owner-before']);
  });

  test('replicas claim distinct owners and old generations cannot release a replacement lease', async () => {
    const queue = createPostgresOwnerMaintenanceQueue(isolated.runtime.db);
    const claims = await Promise.all([queue.claim(), queue.claim(), queue.claim()]);
    const held = claims.filter(claim => claim !== null);
    assert.equal(held.length, 2);
    assert.equal(new Set(held.map(claim => claim.ownerId)).size, 2);
    const expired = held[0]!;
    await isolated.runtime.pool.query("update automation_owner_maintenance set lease_until=now()-interval '1 second' where owner_id=$1", [expired.ownerId]);
    const replacement = await queue.claim();
    assert.equal(replacement?.ownerId, expired.ownerId);
    assert.notEqual(replacement?.generation, expired.generation);
    await queue.finish(expired, true);
    assert.equal((await isolated.runtime.pool.query('select lease_until is not null held from automation_owner_maintenance where owner_id=$1', [expired.ownerId])).rows[0].held, true);
    await queue.finish(replacement!, false);
    const released = (await isolated.runtime.pool.query('select lease_until is null released,next_due_at>now() delayed from automation_owner_maintenance where owner_id=$1', [expired.ownerId])).rows[0];
    assert.deepEqual(released, { released: true, delayed: true });
  });
});
