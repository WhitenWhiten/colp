import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Lease } from '@know-n/colp/automation';
import { up, down } from '../../../migrations/202610301700_automation_budget_holds.js';
import { createAutomationWorkerService } from '../../../src/infrastructure/automation/worker-service.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';

describeWithPostgres('upgrade legacy optional budget holds', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await f?.close(); });
  async function upgradeLegacyBudget(jobId: string) {
    await down(f.db);
    await sql`UPDATE automation_jobs SET explanation='Optional execution budget exhausted.' WHERE id=${jobId}`.execute(f.db);
    await up(f.db);
  }
  test('upgrade releases only recoverable daily holds and preserves spent maxCalls and pins', async () => {
    f = await automationPollingFixture('budget_upgrade');
    const capped = createAutomationWorkerService(f.db,'server',f.worker,f.results!,'migration-cursor-key-at-least-32-bytes',0);
    const job = (await capped.list(f.actor,{ targetId: f.target.id })).items[0]!;
    await expect(capped.mutate(f.actor,job.id,'claim',{ deliveryHandle: job.deliveryHandle },randomUUID())).rejects.toMatchObject({ code: 'automation_budget_exceeded' });
    await upgradeLegacyBudget(job.id);
    const ready = (await f.work!.list(f.actor,{ targetId: f.target.id })).items[0]!;
    expect(ready).toMatchObject({ id: job.id,inputDigest: job.inputDigest,status: 'ready' });
    const lease = await f.work!.mutate(f.actor,job.id,'claim',{ deliveryHandle: job.deliveryHandle },randomUUID()) as Lease;
    await f.work!.mutate(f.actor,job.id,'fail',{ claimToken: lease.claimToken,generation: lease.generation,
      kind: 'knownRetryable',code: 'known',message: 'A recorded failed attempt' },randomUUID());
    await expect(f.work!.mutate(f.actor,job.id,'claim',{ deliveryHandle: job.deliveryHandle },randomUUID())).rejects.toMatchObject({ code: 'automation_budget_exceeded' });
    await upgradeLegacyBudget(job.id);
    expect((await f.work!.list(f.actor,{ targetId: f.target.id })).items).toEqual([]);
    const stored = (await sql<{ budget_block_reason: string; input_digest: string; budget_retry_after: Date | null }>`
      SELECT budget_block_reason,input_digest,budget_retry_after FROM automation_jobs WHERE id=${job.id}`.execute(f.db)).rows[0];
    expect(stored).toEqual({ budget_block_reason: 'calls',input_digest: job.inputDigest,budget_retry_after: null });
    expect((await sql`SELECT generation FROM automation_job_attempts WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
  });
});
