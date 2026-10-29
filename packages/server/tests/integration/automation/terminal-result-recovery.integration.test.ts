import { afterEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationJobFixture } from '../../support/automation-job-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { claimJob, submitResult } from '../../../src/modules/automation/index.js';
import { convergeOwnerWork } from '../../../src/infrastructure/automation/owner-maintenance.js';

describeWithPostgres('terminal results without canonical proposals', () => {
  let f: Awaited<ReturnType<typeof automationJobFixture>>;
  afterEach(async () => { await f?.isolated.close(); });
  test.each(['empty', 'invalid'] as const)('%s tags settle the run and its notification before reconcile', async kind => {
    f = await automationJobFixture(`terminal_tags_${kind}`, 'tags');
    const lease = await claimJob(f.leases, f.actor, f.jobId, { deliveryHandle: 'handle' });
    const body = { claimToken: lease.claimToken, generation: lease.generation, inputDigest: lease.inputDigest, outputContract: f.task.outputContract,
      output: { kind: 'tags', mergeMode: 'unionPreserveUser', add: kind === 'empty' ? [] : [{ key: 'x'.repeat(65), label: 'Too long',
        evidence: [{ kind: 'source', reference: f.inputs[0]!.sourceEventId, observedAt: new Date().toISOString() }] }] } };
    await expect(submitResult({ ...f.results, reconcile: async () => { throw Error('interrupted after prepare'); } }, f.actor, f.jobId, body))
      .rejects.toThrow('interrupted after prepare');
    const state = kind === 'empty' ? 'completed' : 'review', activity = kind === 'empty' ? 'run_completed' : 'run_attention';
    const run = async () => (await sql<{ state: string }>`SELECT state FROM automation_runs WHERE id=${f.runId}`.execute(f.db)).rows[0]!.state;
    const notifications = async () => (await sql<{ kind: string }>`SELECT kind FROM activity_items WHERE run_id=${f.runId}`.execute(f.db)).rows;
    expect(await run()).toBe(state);
    expect(await notifications()).toEqual([{ kind: activity }]);
    // Existing installations can already have this orphaned state. Maintenance must heal it too.
    await sql`UPDATE automation_runs SET state='running' WHERE id=${f.runId}`.execute(f.db);
    for (let i = 0; i < 3; i++) await convergeOwnerWork(f.db, f.owner.accountId, 'server');
    expect(await run()).toBe(state);
    expect(await notifications()).toEqual([{ kind: activity }]);
    expect((await submitResult(f.results, f.actor, f.jobId, body)).status).toBe(kind === 'empty' ? 'succeeded' : 'review');
    expect((await sql`SELECT id FROM automation_results WHERE job_id=${f.jobId}`.execute(f.db)).rows).toHaveLength(1);
  });
});
