import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, test } from 'vitest';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createActivityStore } from '../../../src/infrastructure/activity/index.js';
import { expireOwnerLeases } from '../../../src/infrastructure/automation/worker-inputs.js';
import { up, down } from '../../../migrations/202611040300_activity_uncertain_jobs.js';

describeWithPostgres('unknown automation result attention', () => {
  test('notifies expired work once, clears on explicit retry, and reopens for a new unknown attempt', async () => {
    const f = await automationPollingFixture('uncertain_activity', { maxCalls: 3 });
    try {
      const activity = createActivityStore(f.db, 'uncertain-activity-cursor-key-at-least-32-bytes');
      const job = (await f.work!.list(f.actor, { targetId: f.target.id })).items[0]!;
      const expire = async () => {
        await sql`UPDATE automation_job_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=${job.id}`.execute(f.db);
        await f.db.transaction().execute(tx => expireOwnerLeases(tx, f.owner.accountId));
      };
      await f.work!.mutate(f.actor, job.id, 'claim', { deliveryHandle: job.deliveryHandle }, randomUUID());
      await expire();
      const first = (await activity.summary(f.owner.accountId)).latest!;
      expect(first).toMatchObject({ kind: 'run_attention', state: 'unread', run: { id: job.runId, status: 'uncertain', attention: 'review' } });
      await activity.markRead(f.owner.accountId, { ids: [first.id] }, randomUUID());
      await expire();
      expect((await activity.summary(f.owner.accountId)).unreadCount).toBe(0);
      const current = await f.app.inject({ url: `/api/v1/me/automations/jobs/${job.id}`, headers: { cookie: f.owner.cookie } });
      const retried = await f.ownerPost(`/jobs/${job.id}/retry`, { reason: 'Reviewed external state before retrying' }, String(current.headers.etag));
      expect(retried.statusCode, retried.body).toBe(200);
      expect((await activity.summary(f.owner.accountId)).latest).toBeNull();
      await f.work!.mutate(f.actor, job.id, 'claim', { deliveryHandle: job.deliveryHandle }, randomUUID());
      await expire();
      expect((await activity.summary(f.owner.accountId)).latest).toMatchObject({ state: 'unread', run: { status: 'uncertain' } });
      await sql`UPDATE automation_runs SET revision=revision+1,state='running' WHERE id=${job.runId}`.execute(f.db);
      expect((await activity.summary(f.owner.accountId)).latest?.run?.status).toBe('uncertain');
      await down(f.db); await up(f.db);
      expect((await activity.summary(f.owner.accountId)).latest?.run?.status).toBe('uncertain');
      await sql`UPDATE automation_runs SET state='cancelled' WHERE id=${job.runId}`.execute(f.db);
      expect((await activity.summary(f.owner.accountId)).latest).toBeNull();
    } finally { await f.close(); }
  });
});
