import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createDigestScheduler } from '../../../src/modules/reports/application/scheduler.js';
import {
  createPostgresDigestSchedulerStore,
} from '../../../src/infrastructure/reports/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('reports scheduler durable run ledger', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('reports_scheduler_store', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  beforeEach(async () => {
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `TRUNCATE digest_runs, digest_schedules, digest_members, digest_series,
       accounts, resource_id_ledger CASCADE`);
  });

  afterAll(async () => isolated?.close());

  async function seedSchedule(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`INSERT INTO accounts(id, subject_id, status) VALUES ('account', 'subject', 'active')`);
      await client.query(`INSERT INTO resource_id_ledger(resource_id, resource_type)
        VALUES ('series', 'digest_series'), ('source', 'collection'), ('root', 'node')`);
      await client.query(`INSERT INTO digest_series(
        id, owner_subject_id, title, slug, visibility, allow_search_indexing, state,
        resource_revision, content_revision, policy_revision, commit_ordinal
      ) VALUES ('series', 'subject', 'Series', NULL, 'private', false, 'active', 'r1', 'c1', 'p1', 1)`);
      await client.query(`INSERT INTO digest_members(series_id, subject_id, role)
        VALUES ('series', 'subject', 'owner')`);
      await client.query(`INSERT INTO digest_schedules(
        id, series_id, enabled, rrule, dtstart, time_zone, catch_up_policy,
        max_catch_up, next_run_at, resource_revision
      ) VALUES ('schedule', 'series', true, 'FREQ=DAILY',
        '2026-09-03T09:00:00Z', 'UTC', 'skip', 0, NULL, 'sr1')`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  test('AUDIT: an exhausted finite schedule must not starve another schedule', async () => {
    await seedSchedule();
    const now = new Date();
    const old = new Date(now.getTime() - 3 * 86400000);
    const due = new Date(now.getTime() - 60000);
    await isolated.runtime.pool.query("UPDATE digest_schedules SET dtstart=$1,rrule='FREQ=DAILY;COUNT=1' WHERE id='schedule'", [old]);
    await isolated.runtime.pool.query(`BEGIN; SET CONSTRAINTS ALL DEFERRED;
      INSERT INTO resource_id_ledger(resource_id,resource_type) VALUES ('series-b','digest_series');
      INSERT INTO digest_series(id,owner_subject_id,title,visibility,allow_search_indexing,state,
        resource_revision,content_revision,policy_revision,commit_ordinal)
        VALUES ('series-b','subject','B','private',false,'active','rb','cb','pb',1);
      INSERT INTO digest_members(series_id,subject_id,role) VALUES ('series-b','subject','owner'); COMMIT;`);
    await isolated.runtime.pool.query(`INSERT INTO digest_schedules
      (id,series_id,enabled,rrule,dtstart,time_zone,catch_up_policy,max_catch_up,next_run_at,resource_revision)
      VALUES ('schedule-b','series-b',true,'FREQ=DAILY;COUNT=1',$1,'UTC','skip',0,NULL,'sr-b')`, [due]);
    const store = createPostgresDigestSchedulerStore(isolated.runtime.pool);
    let submitted = 0;
    const scheduler = createDigestScheduler({ store, ownerId: 'audit', now: () => now, batchSize: 1,
      connector: { submit: async run => { submitted++; return { issueKey: run.issueKey!, commandId: run.commandId! }; } } });
    for (let n=0;n<3;n++) await scheduler.runOnce();
    assert.equal(submitted,1, 'due schedule B should be discovered even after A has no future recurrence');
  });
  test('sparse recurrence resumes after its empty discovery horizon across restarts', async () => {
    await seedSchedule();
    let now = new Date('2026-09-19T10:00:00Z');
    await isolated.runtime.pool.query("UPDATE digest_schedules SET dtstart='2026-09-01T09:00:00Z', rrule='FREQ=YEARLY;INTERVAL=2' WHERE id='schedule'");
    let submitted = 0;
    const run = () => createDigestScheduler({ store: createPostgresDigestSchedulerStore(isolated.runtime.pool),
      ownerId: 'sparse', now: () => now, batchSize: 1,
      connector: { submit: async value => { submitted++; return { issueKey: value.issueKey!, commandId: value.commandId! }; } },
    }).runOnce();
    await run();
    const checkpoint = await isolated.runtime.pool.query('SELECT next_run_at FROM digest_schedules WHERE id=$1', ['schedule']);
    assert.ok(checkpoint.rows[0].next_run_at > now);
    now = checkpoint.rows[0].next_run_at;
    await run();
    assert.equal(submitted, 0);
    now = new Date('2028-09-01T09:00:00Z');
    await run();
    assert.equal(submitted, 1);
  });

});
