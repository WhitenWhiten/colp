import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { createAutomationWorkerService } from '../../../src/infrastructure/automation/worker-service.js';
import type { Lease } from '@know-n/colp/automation';

describeWithPostgres('optional daily budget recovery', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await f?.close(); });
  test('a job held by the daily server cap becomes claimable when a new budget day starts', async () => {
    f = await automationPollingFixture('review_daily_cap');
    await f.createNode('second-paper', 'root', 'Second paper', 'https://arxiv.org/abs/second'); await f.inspect();
    const worker = createAutomationWorkerService(f.db, 'server', f.worker, f.results!, 'review-cursor-key-at-least-32-bytes', 1);
    const queue = await worker.list(f.actor, { targetId: f.target.id }); expect(queue.items).toHaveLength(2);
    const [first, second] = queue.items;
    const lease = await worker.mutate(f.actor, first!.id, 'claim', { deliveryHandle: first!.deliveryHandle }, randomUUID()) as { claimToken: string; generation: number };
    await worker.mutate(f.actor, first!.id, 'fail', { claimToken: lease.claimToken, generation: lease.generation, kind: 'permanent', code: 'unsupported', message: 'Do not retry first job' }, randomUUID());
    await expect(worker.mutate(f.actor, second!.id, 'claim', { deliveryHandle: second!.deliveryHandle }, randomUUID())).rejects.toMatchObject({ code: 'automation_budget_exceeded' });
    expect((await worker.list(f.actor,{ targetId: f.target.id })).items).toEqual([]);
    // Advance the reservation ledger across UTC midnight without changing the immutable job pins.
    await sql`UPDATE automation_usage_reservations SET day=day-1`.execute(f.db);
    await sql`UPDATE automation_jobs SET budget_retry_after=budget_retry_after-interval '1 day' WHERE budget_block_reason='daily'`.execute(f.db);
    await f.inspect();
    const after = await worker.list(f.actor, { targetId: f.target.id });
    expect(after.items.map(job => job.id)).toContain(second!.id);
    expect(after.items.find(job => job.id===second!.id)?.inputDigest).toBe(second!.inputDigest);
    const next = await worker.mutate(f.actor,second!.id,'claim',{ deliveryHandle: second!.deliveryHandle },randomUUID()) as Lease;
    expect(next).toMatchObject({ generation: 1,inputDigest: second!.inputDigest });
    await worker.mutate(f.actor,second!.id,'fail',{ claimToken: next.claimToken,generation: next.generation,
      kind: 'knownRetryable',code: 'safe',message: 'Known failed attempt' },randomUUID());
    await expect(worker.mutate(f.actor,second!.id,'claim',{ deliveryHandle: second!.deliveryHandle },randomUUID())).rejects.toMatchObject({ code: 'automation_budget_exceeded' });
    await sql`UPDATE automation_usage_reservations SET day=day-2`.execute(f.db);
    expect((await worker.list(f.actor,{ targetId: f.target.id })).items).toEqual([]);
    expect((await sql<{ budget_block_reason: string }>`SELECT budget_block_reason FROM automation_jobs WHERE id=${second!.id}`.execute(f.db)).rows[0]?.budget_block_reason).toBe('calls');
  });
  test('a temporary budget hold preserves pending successors and rechecks source edits on release', async () => {
    f = await automationPollingFixture('review_budget_dag',{ three: true });
    const worker = createAutomationWorkerService(f.db,'server',f.worker,f.results!,'review-cursor-key-at-least-32-bytes',0);
    const job = (await worker.list(f.actor,{ targetId: f.target.id })).items[0]!;
    await expect(worker.mutate(f.actor,job.id,'claim',{ deliveryHandle: job.deliveryHandle },randomUUID())).rejects.toMatchObject({ code: 'automation_budget_exceeded' });
    const states = (await sql<{ task_id: string; state: string }>`SELECT task_id,state FROM automation_jobs WHERE run_id=${job.runId} ORDER BY task_id`.execute(f.db)).rows;
    expect(states).toEqual([{ task_id: 'refine',state: 'blocked' },{ task_id: 'summary',state: 'pending' },{ task_id: 'tags',state: 'pending' }]);
    await f.rename('fresh-paper','Manual edit while budget held');
    await sql`UPDATE automation_jobs SET budget_retry_after=clock_timestamp()-interval '1 second' WHERE id=${job.id}`.execute(f.db);
    expect((await worker.list(f.actor,{ targetId: f.target.id })).items).toEqual([]);
    expect((await sql<{ state: string }>`SELECT state FROM automation_jobs WHERE id=${job.id}`.execute(f.db)).rows[0]?.state).toBe('stale');
    expect((await sql`SELECT job_id FROM automation_job_attempts`.execute(f.db)).rows).toHaveLength(0);
  });
});
