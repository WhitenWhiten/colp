import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createDigestScheduler } from '../../../src/modules/reports/application/scheduler.js';
import {
  createPostgresDigestSchedulerStore,
  createPostgresReportRunLedgerPort,
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

  test('REVIEW: a persisted retry remains runnable after a two-day worker outage', async () => {
    await seedSchedule();
    const scheduled = new Date(Date.now() - 3 * 86_400_000);
    scheduled.setUTCMilliseconds(0);
    await isolated.runtime.pool.query(
      "UPDATE digest_schedules SET dtstart = $1, rrule = 'FREQ=DAILY;COUNT=1' WHERE id = 'schedule'", [scheduled]);
    const store = createPostgresDigestSchedulerStore(isolated.runtime.pool);
    let current = new Date(scheduled.getTime() + 60_000);
    let submissions = 0;
    const connector = { submit: async (run: { issueKey: string | null; commandId: string | null }) => {
      submissions += 1;
      if (submissions === 1) throw new Error('temporary connector outage');
      return { issueKey: run.issueKey!, commandId: run.commandId! };
    } };
    await createDigestScheduler({ store, connector, ownerId: 'review-before', now: () => current }).runOnce();
    current = new Date(current.getTime() + 2 * 86_400_000);
    assert.equal((await store.listDue(current, 20)).length, 1, 'durable retry is still due');
    await createDigestScheduler({ store, connector, ownerId: 'review-after', now: () => current }).runOnce();
    const rows = await isolated.runtime.pool.query('SELECT state, attempt_count FROM digest_runs');
    assert.deepEqual(rows.rows, [{ state: 'succeeded', attempt_count: 2 }]);
  });

  test('upserts one occurrence and permits only one concurrent generation-fenced claim', async () => {
    await seedSchedule();
    const store = createPostgresDigestSchedulerStore(isolated.runtime.pool, { idGenerator: () => 'run-1' });
    const now = new Date('2026-09-04T10:00:00.000Z');
    assert.equal((await store.listDue(now, 10)).length, 1);
    const value = {
      scheduleId: 'schedule', scheduleRevision: 'sr1', occurrenceKey: '2026-09-04T09:00:00.000Z',
      scheduledFor: '2026-09-04T09:00:00.000Z', state: 'pending' as const,
      leaseOwner: null, leaseUntil: null, leaseGeneration: 0, attemptCount: 0,
      nextAttemptAt: null, lastErrorClass: null,
      issueKey: 'schedule:2026-09-04T09:00:00.000Z',
      commandId: 'c81a05c1-9943-48aa-a751-f1d857bdee78', editionId: null,
    };
    const first = await store.upsertRun(value);
    const second = await store.upsertRun(value);
    assert.equal(second.id, first.id);
    const [left, right] = await Promise.all([
      store.claimRun(first.id, 'worker-a', 30_000, now, 0),
      store.claimRun(first.id, 'worker-b', 30_000, now, 0),
    ]);
    assert.equal((left === null) === (right === null), false, 'exactly one claimant wins');
    const winner = left ?? right;
    assert.equal(winner?.leaseGeneration, 1);
    assert.equal(winner?.attemptCount, 1);
    assert.equal(await store.completeRun(first.id, 'wrong-owner', 1), false);
    assert.equal(await store.completeRun(first.id, winner!.leaseOwner!, 0), false);
    assert.equal(await store.completeRun(first.id, winner!.leaseOwner!, 1), true);
  });

  test('retry uses a bounded safe error class and can be reclaimed after the backoff', async () => {
    await seedSchedule();
    const store = createPostgresDigestSchedulerStore(isolated.runtime.pool, { idGenerator: () => 'run-2' });
    const now = new Date('2026-09-04T10:00:00.000Z');
    const run = await store.upsertRun({
      scheduleId: 'schedule', scheduleRevision: 'sr1', occurrenceKey: '2026-09-04T09:00:00.000Z',
      scheduledFor: '2026-09-04T09:00:00.000Z', state: 'pending', leaseOwner: null,
      leaseUntil: null, leaseGeneration: 0, attemptCount: 0, nextAttemptAt: null,
      lastErrorClass: null, issueKey: 'schedule:2026-09-04T09:00:00.000Z',
      commandId: 'c81a05c1-9943-48aa-a751-f1d857bdee78', editionId: null,
    });
    const claimed = await store.claimRun(run.id, 'worker', 30_000, now, 0);
    assert.ok(claimed);
    const retryAt = new Date(now.getTime() + 1_000);
    assert.equal(await store.retryRun(run.id, 'worker', 'raw secret / stack', retryAt, 1), true);
    assert.equal(await store.claimRun(run.id, 'worker', 30_000, now, 1), null);
    const reclaimed = await store.claimRun(run.id, 'worker', 30_000, new Date(retryAt.getTime() + 1), 1);
    assert.equal(reclaimed?.leaseGeneration, 2);
    assert.equal(reclaimed?.attemptCount, 2);
    assert.equal(await store.failRun?.(run.id, 'worker', 'connector_error', 2), true);
    const row = await isolated.runtime.pool.query<{ state: string; last_error_class: string | null }>(
      'SELECT state, last_error_class FROM digest_runs WHERE id = $1', [run.id]);
    assert.deepEqual(row.rows[0], { state: 'failed', last_error_class: 'connector_error' });
  });

  test('does not claim future runs and fences deleted owners', async () => {
    await seedSchedule();
    let runSequence = 0;
    const store = createPostgresDigestSchedulerStore(
      isolated.runtime.pool,
      { idGenerator: () => `run-future-${++runSequence}` },
    );
    const now = new Date('2026-09-04T10:00:00.000Z');
    const future = await store.upsertRun({
      scheduleId: 'schedule', scheduleRevision: 'sr1', occurrenceKey: '2026-09-05T09:00:00.000Z',
      scheduledFor: '2026-09-05T09:00:00.000Z', state: 'pending', leaseOwner: null,
      leaseUntil: null, leaseGeneration: 0, attemptCount: 0, nextAttemptAt: null,
      lastErrorClass: null, issueKey: 'schedule:2026-09-05T09:00:00.000Z',
      commandId: 'c81a05c1-9943-48aa-a751-f1d857bdee79', editionId: null,
    });
    assert.equal(await store.claimRun(future.id, 'worker', 30_000, now, 0), null);
    const claimed = await store.claimRun(
      future.id, 'worker', 30_000, new Date('2026-09-05T09:00:00.000Z'), 0,
    );
    assert.equal(claimed?.leaseGeneration, 1);
    assert.equal(await store.completeRun(future.id, 'worker', 1), true);

    await isolated.runtime.pool.query(
      `UPDATE accounts SET status = 'active', deleted_at = '2026-09-04T10:00:00Z' WHERE id = 'account'`,
    );
    const deletedOwnerRun = await store.upsertRun({
      scheduleId: 'schedule', scheduleRevision: 'sr1', occurrenceKey: '2026-09-06T09:00:00.000Z',
      scheduledFor: '2026-09-06T09:00:00.000Z', state: 'pending', leaseOwner: null,
      leaseUntil: null, leaseGeneration: 0, attemptCount: 0, nextAttemptAt: null,
      lastErrorClass: null, issueKey: 'schedule:2026-09-06T09:00:00.000Z',
      commandId: 'c81a05c1-9943-48aa-a751-f1d857bdee80', editionId: null,
    });
    assert.equal((await store.listDue(new Date('2026-09-06T10:00:00.000Z'), 10)).length, 0);
    assert.equal(
      await store.claimRun(deletedOwnerRun.id, 'worker', 30_000, new Date('2026-09-06T10:00:00.000Z'), 0),
      null,
    );
  });

  test('account deletion wins the owner lock race before a scheduler claim', async () => {
    await seedSchedule();
    const store = createPostgresDigestSchedulerStore(
      isolated.runtime.pool,
      { idGenerator: () => 'run-owner-race' },
    );
    const now = new Date('2026-09-04T10:00:00.000Z');
    const run = await store.upsertRun({
      scheduleId: 'schedule', scheduleRevision: 'sr1', occurrenceKey: '2026-09-04T09:00:00.000Z',
      scheduledFor: '2026-09-04T09:00:00.000Z', state: 'pending', leaseOwner: null,
      leaseUntil: null, leaseGeneration: 0, attemptCount: 0, nextAttemptAt: null,
      lastErrorClass: null, issueKey: 'schedule:2026-09-04T09:00:00.000Z',
      commandId: 'c81a05c1-9943-48aa-a751-f1d857bdee86', editionId: null,
    });
    const lifecycle = await isolated.runtime.pool.connect();
    let claim: Promise<Awaited<ReturnType<typeof store.claimRun>>> | undefined;
    try {
      await lifecycle.query('BEGIN');
      await lifecycle.query(`SELECT id FROM accounts WHERE id = 'account' FOR UPDATE`);
      claim = store.claimRun(run.id, 'worker', 30_000, now, 0);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
               AND wait_event_type = 'Lock'
               AND query LIKE '%SELECT subject_id FROM accounts%'
          ) AS waiting`);
        waiting = blocked.rows[0]?.waiting === true;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'scheduler claim must wait on the account lifecycle lock');
      await lifecycle.query(
        `UPDATE accounts SET status = 'deleted', deleted_at = current_timestamp WHERE id = 'account'`,
      );
      await lifecycle.query('COMMIT');
      assert.equal(await claim, null);
    } finally {
      try { await lifecycle.query('ROLLBACK'); } catch { /* already committed */ }
      lifecycle.release();
      if (claim) await claim.catch(() => undefined);
    }
  });

  test('schedule pointer advancement is fenced by the schedule resource revision', async () => {
    await seedSchedule();
    const store = createPostgresDigestSchedulerStore(isolated.runtime.pool);
    const next = new Date('2026-09-05T09:00:00.000Z');
    await store.advanceSchedule?.('schedule', next, 'stale-revision');
    const stale = await isolated.runtime.pool.query<{ next_run_at: Date | null }>(
      'SELECT next_run_at FROM digest_schedules WHERE id = $1', ['schedule']);
    assert.equal(stale.rows[0]?.next_run_at, null);
    await store.advanceSchedule?.('schedule', next, 'sr1');
    const advanced = await isolated.runtime.pool.query<{ next_run_at: Date | null }>(
      'SELECT next_run_at FROM digest_schedules WHERE id = $1', ['schedule']);
    assert.equal(advanced.rows[0]?.next_run_at?.toISOString(), next.toISOString());
  });

  test('schedule pointer cannot overtake a retryable run during backoff', async () => {
    await seedSchedule();
    let runSequence = 0;
    const store = createPostgresDigestSchedulerStore(
      isolated.runtime.pool,
      { idGenerator: () => `run-backoff-${++runSequence}` },
    );
    const now = new Date('2026-09-04T10:00:00.000Z');
    const run = await store.upsertRun({
      scheduleId: 'schedule', scheduleRevision: 'sr1', occurrenceKey: '2026-09-04T09:00:00.000Z',
      scheduledFor: '2026-09-04T09:00:00.000Z', state: 'pending', leaseOwner: null,
      leaseUntil: null, leaseGeneration: 0, attemptCount: 0, nextAttemptAt: null,
      lastErrorClass: null, issueKey: 'schedule:2026-09-04T09:00:00.000Z',
      commandId: 'c81a05c1-9943-48aa-a751-f1d857bdee81', editionId: null,
    });
    const claimed = await store.claimRun(run.id, 'worker', 30_000, now, 0);
    assert.ok(claimed);
    assert.equal(await store.retryRun(
      run.id, 'worker', 'connector_error', new Date(now.getTime() + 60_000), 1,
    ), true);
    await store.advanceSchedule?.('schedule', new Date('2026-09-05T09:00:00.000Z'), 'sr1');
    const row = await isolated.runtime.pool.query<{ next_run_at: Date | null }>(
      'SELECT next_run_at FROM digest_schedules WHERE id = $1', ['schedule']);
    assert.equal(row.rows[0]?.next_run_at, null);
  });

  test('legacy run ledger claimDue applies the same schedule and owner fences', async () => {
    await seedSchedule();
    const future = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresReportRunLedgerPort(transaction, () => 'legacy-future').upsertOccurrence({
        scheduleId: 'schedule', scheduleRevision: 'sr1', occurrenceKey: '2026-09-06T09:00:00.000Z',
        scheduledFor: '2026-09-06T09:00:00.000Z', state: 'pending', leaseOwner: null,
        leaseUntil: null, leaseGeneration: 0, attemptCount: 0, nextAttemptAt: null,
        lastErrorClass: null, issueKey: 'schedule:2026-09-06T09:00:00.000Z',
        commandId: 'c81a05c1-9943-48aa-a751-f1d857bdee82', editionId: null,
      }));
    const beforeOccurrence = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresReportRunLedgerPort(transaction).claimDue(
        new Date('2026-09-04T10:00:00.000Z'), 'legacy-worker', 30_000, 10,
      ));
    assert.deepEqual(beforeOccurrence, []);
    assert.equal(future.state, 'pending');

    await isolated.runtime.pool.query(
      `UPDATE accounts SET status = 'active', deleted_at = '2026-09-04T10:00:00Z' WHERE id = 'account'`,
    );
    await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresReportRunLedgerPort(transaction, () => 'legacy-deleted').upsertOccurrence({
        scheduleId: 'schedule', scheduleRevision: 'sr1', occurrenceKey: '2026-09-04T09:00:00.000Z',
        scheduledFor: '2026-09-04T09:00:00.000Z', state: 'pending', leaseOwner: null,
        leaseUntil: null, leaseGeneration: 0, attemptCount: 0, nextAttemptAt: null,
        lastErrorClass: null, issueKey: 'schedule:2026-09-04T09:00:00.000Z',
        commandId: 'c81a05c1-9943-48aa-a751-f1d857bdee83', editionId: null,
      }));
    const afterOwnerDelete = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresReportRunLedgerPort(transaction).claimDue(
        new Date('2026-09-04T10:00:00.000Z'), 'legacy-worker', 30_000, 10,
      ));
    assert.deepEqual(afterOwnerDelete, []);
  });

  test('generation-fenced completion paths reject an expired lease', async () => {
    await seedSchedule();
    let runSequence = 0;
    const store = createPostgresDigestSchedulerStore(
      isolated.runtime.pool,
      { idGenerator: () => `run-expired-${++runSequence}` },
    );
    const now = new Date('2026-09-04T10:00:00.000Z');
    const run = await store.upsertRun({
      scheduleId: 'schedule', scheduleRevision: 'sr1', occurrenceKey: '2026-09-04T09:00:00.000Z',
      scheduledFor: '2026-09-04T09:00:00.000Z', state: 'pending', leaseOwner: null,
      leaseUntil: null, leaseGeneration: 0, attemptCount: 0, nextAttemptAt: null,
      lastErrorClass: null, issueKey: 'schedule:2026-09-04T09:00:00.000Z',
      commandId: 'c81a05c1-9943-48aa-a751-f1d857bdee84', editionId: null,
    });
    const claimed = await store.claimRun(run.id, 'worker', 30_000, now, 0);
    assert.ok(claimed);
    await isolated.runtime.pool.query(
      `UPDATE digest_runs SET lease_until = current_timestamp - interval '1 second' WHERE id = $1`,
      [run.id],
    );
    assert.equal(await store.completeRun(run.id, 'worker', 1), false);
    assert.equal(await store.retryRun(
      run.id, 'worker', 'connector_error', new Date(now.getTime() + 1_000), 1,
    ), false);
    assert.equal(await store.failRun?.(run.id, 'worker', 'connector_error', 1), false);
    const row = await isolated.runtime.pool.query<{ state: string; lease_owner: string | null }>(
      'SELECT state, lease_owner FROM digest_runs WHERE id = $1', [run.id],
    );
    assert.deepEqual(row.rows[0], { state: 'leased', lease_owner: 'worker' });
  });

  test('legacy run ledger completion and retry also reject an expired lease', async () => {
    await seedSchedule();
    const now = new Date('2026-09-04T10:00:00.000Z');
    const claimed = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => {
      const port = createPostgresReportRunLedgerPort(transaction, () => 'legacy-expired');
      return port.upsertOccurrence({
        scheduleId: 'schedule', scheduleRevision: 'sr1', occurrenceKey: '2026-09-04T09:00:00.000Z',
        scheduledFor: '2026-09-04T09:00:00.000Z', state: 'pending', leaseOwner: null,
        leaseUntil: null, leaseGeneration: 0, attemptCount: 0, nextAttemptAt: null,
        lastErrorClass: null, issueKey: 'schedule:2026-09-04T09:00:00.000Z',
        commandId: 'c81a05c1-9943-48aa-a751-f1d857bdee85', editionId: null,
      }).then(async (run) => {
        const rows = await port.claimDue(now, 'legacy-worker', 30_000, 1);
        assert.equal(rows.length, 1);
        return rows[0] ?? run;
      });
    });
    await isolated.runtime.pool.query(
      `UPDATE digest_runs SET lease_until = current_timestamp - interval '1 second' WHERE id = $1`,
      [claimed.id],
    );
    const complete = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresReportRunLedgerPort(transaction).complete(claimed, 'legacy-worker'));
    const retry = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresReportRunLedgerPort(transaction).retry(
        claimed, 'legacy-worker', 'connector_error', new Date(now.getTime() + 1_000),
      ));
    assert.equal(complete, 'lease_lost');
    assert.equal(retry, 'lease_lost');
  });
});
