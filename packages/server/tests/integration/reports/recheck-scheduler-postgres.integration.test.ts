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

  test('RECHECK: independent batch limits must not strand durable runs', async () => {
    await seedSchedule();
    const now = new Date(Date.now());
    const aStart = new Date(now.getTime() - 5 * 86400000);
    const bStart = new Date(now.getTime() - 4.5 * 86400000);
    const aRun = new Date(now.getTime() - 4 * 86400000);
    await isolated.runtime.pool.query(
      "UPDATE digest_schedules SET dtstart=$1, rrule='FREQ=DAILY;COUNT=2' WHERE id='schedule'", [aStart]);
    await isolated.runtime.pool.query(`BEGIN;
      SET CONSTRAINTS ALL DEFERRED;
      INSERT INTO resource_id_ledger(resource_id, resource_type) VALUES ('series-b', 'digest_series');
      INSERT INTO digest_series(id, owner_subject_id, title, slug, visibility, allow_search_indexing, state,
        resource_revision, content_revision, policy_revision, commit_ordinal)
        VALUES ('series-b', 'subject', 'Series B', NULL, 'private', false, 'active', 'r-b', 'c-b', 'p-b', 1);
      INSERT INTO digest_members(series_id, subject_id, role) VALUES ('series-b', 'subject', 'owner');
      COMMIT;`);
    await isolated.runtime.pool.query(`INSERT INTO digest_schedules
      (id, series_id, enabled, rrule, dtstart, time_zone, catch_up_policy, max_catch_up, next_run_at, resource_revision)
      VALUES ('schedule-b', 'series-b', true, 'FREQ=DAILY;COUNT=2', $1, 'UTC', 'skip', 0, NULL, 'sr-b')`, [bStart]);
    const store = createPostgresDigestSchedulerStore(isolated.runtime.pool);
    for (const [scheduleId, instant] of [['schedule', aRun], ['schedule-b', bStart]] as const) {
      await store.upsertRun({ scheduleId, scheduleRevision: scheduleId === 'schedule' ? 'sr1' : 'sr-b', occurrenceKey: instant.toISOString(), scheduledFor: instant.toISOString(),
        state: 'retryable', leaseOwner: null, leaseUntil: null, leaseGeneration: 0, attemptCount: 1,
        nextAttemptAt: null, lastErrorClass: 'connector_error', issueKey: scheduleId + ':issue',
        commandId: scheduleId === 'schedule' ? 'c81a05c1-9943-48aa-a751-f1d857bdee78' : 'c81a05c1-9943-48aa-a751-f1d857bdee79', editionId: null });
    }
    assert.equal((await store.listDue(now, 1))[0]?.id, 'schedule');
    assert.equal((await store.listDueRuns(now, 1))[0]?.scheduleId, 'schedule-b');
    let submissions = 0;
    const scheduler = createDigestScheduler({ store, ownerId: 'recheck', now: () => now, batchSize: 1,
      connector: { submit: async (run) => { submissions++; return { issueKey: run.issueKey!, commandId: run.commandId! }; } } });
    for (let i = 0; i < 3; i++) await scheduler.runOnce();
    const result = await isolated.runtime.pool.query('SELECT state, attempt_count FROM digest_runs ORDER BY schedule_id');
    assert.equal(submissions, 2, JSON.stringify(result.rows));
  });

});
