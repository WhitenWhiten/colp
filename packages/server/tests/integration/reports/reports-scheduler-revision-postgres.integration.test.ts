import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresDigestSchedulerStore, createPostgresReportRunLedgerPort } from '../../../src/infrastructure/reports/index.js';
import { createDigestScheduler } from '../../../src/modules/reports/application/scheduler.js';
import { deterministicRunIdentity } from '../../../src/modules/reports/application/schedule.js';
import type { DigestRun } from '../../../src/modules/reports/domain/types.js';
import { up as expandRunRevision } from '../../../migrations/202610210000_digest_run_schedule_revision.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('digest schedule revision claim fence', () => {
  let isolated: IsolatedPostgresRuntime;
  const now = new Date('2026-09-04T09:01:00Z');
  const instant = new Date('2026-09-04T09:00:00Z');
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('reports_schedule_revision', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => {
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      'TRUNCATE digest_runs, digest_schedules, digest_members, digest_series, accounts, resource_id_ledger CASCADE');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query("INSERT INTO accounts(id, subject_id, status) VALUES ('account', 'subject', 'active')");
      await client.query("INSERT INTO resource_id_ledger(resource_id, resource_type) VALUES ('series', 'digest_series')");
      await client.query("INSERT INTO digest_series(id, owner_subject_id, title, visibility, allow_search_indexing, state, resource_revision, content_revision, policy_revision, commit_ordinal) VALUES ('series', 'subject', 'Series', 'private', false, 'active', 'r1', 'c1', 'p1', 1)");
      await client.query("INSERT INTO digest_members(series_id, subject_id, role) VALUES ('series', 'subject', 'owner')");
      await client.query("INSERT INTO digest_schedules(id, series_id, enabled, rrule, dtstart, time_zone, catch_up_policy, max_catch_up, next_run_at, resource_revision) VALUES ('schedule', 'series', true, 'FREQ=DAILY', '2026-09-03T09:00:00Z', 'UTC', 'skip', 0, $1, 'sr1')", [instant]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  });

  function pendingRun() {
    return { scheduleId: 'schedule', scheduleRevision: 'sr1',
      ...deterministicRunIdentity('schedule', instant), scheduledFor: instant.toISOString(),
      state: 'pending' as const, leaseOwner: null, leaseUntil: null, leaseGeneration: 0,
      attemptCount: 0, nextAttemptAt: null, lastErrorClass: null, editionId: null };
  }

  async function changeRule() {
    await isolated.runtime.pool.query("UPDATE digest_schedules SET rrule = 'FREQ=WEEKLY', dtstart = '2026-09-05T12:00:00Z', resource_revision = 'sr2', next_run_at = NULL WHERE id = 'schedule'");
  }

  async function claim(run: DigestRun, legacy: boolean) {
    if (legacy) return (await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresReportRunLedgerPort(transaction).claimDue(now, 'worker', 30_000, 10)))[0] ?? null;
    return createPostgresDigestSchedulerStore(isolated.runtime.pool)
      .claimRun(run.id, 'worker', 30_000, now, run.leaseGeneration);
  }

  test('never submits a discovered occurrence removed by a committed schedule edit', async () => {
    const realStore = createPostgresDigestSchedulerStore(isolated.runtime.pool);
    let submissions = 0;
    const scheduler = createDigestScheduler({ ownerId: 'worker', now: () => now,
      store: { ...realStore, async listDue(at, limit) {
        const snapshots = await realStore.listDue(at, limit);
        assert.equal(snapshots[0]?.resourceRevision, 'sr1');
        await changeRule();
        return snapshots;
      } },
      connector: { async submit(run) { submissions++;
        return { issueKey: run.issueKey!, commandId: run.commandId! }; } },
    });
    assert.equal(await scheduler.runOnce(), 0);
    assert.equal(submissions, 0);
    assert.deepEqual((await isolated.runtime.pool.query('SELECT state, last_error_class FROM digest_runs')).rows,
      [{ state: 'cancelled', last_error_class: 'schedule_revision_changed' }]);
    assert.equal((await realStore.getSchedule('schedule'))?.nextRunAt, null);
  });

  for (const legacy of [false, true]) {
    test('claim rechecks a committed revision under the schedule lock; legacy=' + legacy, async () => {
      const store = createPostgresDigestSchedulerStore(isolated.runtime.pool);
      const run = await store.upsertRun(pendingRun());
      const editor = await isolated.runtime.pool.connect();
      let work: Promise<DigestRun | null> | undefined;
      try {
        await editor.query('BEGIN');
        await editor.query("SELECT id FROM digest_schedules WHERE id = 'schedule' FOR UPDATE");
        work = claim(run, legacy);
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          const activity = await isolated.runtime.pool.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%digest_schedules%FOR UPDATE%') AS waiting");
          waiting = activity.rows[0]?.waiting === true;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, 'claim must serialize with schedule edits');
        await editor.query("UPDATE digest_schedules SET dtstart = '2026-09-05T12:00:00Z', resource_revision = 'sr2' WHERE id = 'schedule'");
        await editor.query('COMMIT');
        assert.equal(await work, null);
        assert.equal((await isolated.runtime.pool.query('SELECT state FROM digest_runs')).rows[0]?.state, 'cancelled');
      } finally {
        await editor.query('ROLLBACK').catch(() => undefined);
        editor.release();
        await work?.catch(() => undefined);
      }
    });

    test('keeps a still-valid occurrence and its idempotency identity; legacy=' + legacy, async () => {
      const store = createPostgresDigestSchedulerStore(isolated.runtime.pool);
      const run = await store.upsertRun(pendingRun());
      await isolated.runtime.pool.query("UPDATE digest_schedules SET rrule = 'FREQ=DAILY;INTERVAL=2', dtstart = $1, resource_revision = 'sr2' WHERE id = 'schedule'", [instant]);
      const claimed = await claim(run, legacy);
      assert.ok(claimed);
      assert.equal(claimed.scheduleRevision, 'sr2');
      assert.equal(claimed.id, run.id);
      assert.equal(claimed.commandId, run.commandId);
      assert.equal(claimed.issueKey, run.issueKey);
    });
  }

  for (const state of ['retryable', 'leased'] as const) {
    test('cancels stale durable ' + state + ' work after worker restart', async () => {
      const store = createPostgresDigestSchedulerStore(isolated.runtime.pool);
      const run = await store.upsertRun(pendingRun());
      assert.ok(await claim(run, false));
      if (state === 'retryable') await store.retryRun(run.id, 'worker', 'connector_error', new Date(now.getTime() - 1), 1);
      else await isolated.runtime.pool.query('UPDATE digest_runs SET lease_until = $1 WHERE id = $2',
        [new Date(now.getTime() - 1), run.id]);
      await changeRule();
      let submissions = 0;
      const restarted = createDigestScheduler({ store: { ...store, listDue: async () => [] },
        ownerId: 'restarted-worker', now: () => now, connector: { async submit(value) {
          submissions++; return { issueKey: value.issueKey!, commandId: value.commandId! };
        } } });
      assert.equal(await restarted.runOnce(), 0);
      assert.equal(submissions, 0);
      assert.deepEqual((await isolated.runtime.pool.query('SELECT state, lease_owner, lease_until, next_attempt_at FROM digest_runs')).rows,
        [{ state: 'cancelled', lease_owner: null, lease_until: null, next_attempt_at: null }]);
    });
  }

  for (const stillValid of [false, true]) {
    test('revalidates historical rows with no revision; stillValid=' + stillValid, async () => {
      const store = createPostgresDigestSchedulerStore(isolated.runtime.pool);
      const run = await store.upsertRun(pendingRun());
      await isolated.runtime.pool.query('UPDATE digest_runs SET schedule_revision = NULL WHERE id = $1', [run.id]);
      await expandRunRevision(isolated.runtime.db);
      assert.equal((await store.listDueRuns(now, 10))[0]?.scheduleRevision, null);
      if (!stillValid) await changeRule();
      const claimed = await claim(run, false);
      if (stillValid) {
        assert.ok(claimed);
        assert.equal(claimed.scheduleRevision, 'sr1');
        assert.equal(claimed.commandId, run.commandId);
      } else {
        assert.equal(claimed, null);
        assert.equal((await isolated.runtime.pool.query('SELECT state FROM digest_runs')).rows[0]?.state, 'cancelled');
      }
    });
  }

  test('a later rule can readmit a cancelled occurrence without duplicating a successful command', async () => {
    const store = createPostgresDigestSchedulerStore(isolated.runtime.pool);
    const run = await store.upsertRun(pendingRun());
    await changeRule();
    assert.equal(await claim(run, false), null);
    assert.equal(await claim(run, false), null, 'the same revision cannot revive a cancelled occurrence');
    await isolated.runtime.pool.query("UPDATE digest_schedules SET rrule = 'FREQ=DAILY', dtstart = $1, resource_revision = 'sr3' WHERE id = 'schedule'", [instant]);
    const rediscovered = await store.upsertRun({ ...pendingRun(), scheduleRevision: 'sr3' });
    assert.equal(rediscovered.id, run.id);
    const claimed = await claim(rediscovered, false);
    assert.ok(claimed);
    assert.equal(claimed.scheduleRevision, 'sr3');
    assert.equal(claimed.commandId, run.commandId);
    assert.equal(await store.completeRun(claimed.id, 'worker', claimed.leaseGeneration), true);
    await isolated.runtime.pool.query("UPDATE digest_schedules SET resource_revision = 'sr4' WHERE id = 'schedule'");
    const completed = await store.upsertRun({ ...pendingRun(), scheduleRevision: 'sr4' });
    assert.equal(await claim(completed, false), null);
    assert.equal(completed.state, 'succeeded');
  });

  test('a schedule disabled before claim still blocks submission', async () => {
    const store = createPostgresDigestSchedulerStore(isolated.runtime.pool);
    const run = await store.upsertRun(pendingRun());
    await isolated.runtime.pool.query("UPDATE digest_schedules SET enabled = false, resource_revision = 'sr2', deleted_at = current_timestamp WHERE id = 'schedule'");
    assert.equal(await claim(run, false), null);
    assert.equal(await claim(run, true), null);
    assert.equal((await isolated.runtime.pool.query('SELECT attempt_count FROM digest_runs')).rows[0]?.attempt_count, 0);
  });
});
