import { afterEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('Deterministic intake predecessor evidence', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await f?.close(); });
  test('verified root completion releases its successor without inventing an external attempt', async () => {
    f = await automationPollingFixture('deterministic_predecessor', { configure: (d, p) => {
      const summary = { ...d.tasks[0]!, after: ['root'] };
      d.tasks = [{ ...summary, id: 'root', type: 'classify.root', outputContract: 'placement.subtree.v1',
        folderRole: 'academicRoot', after: [] }, summary];
      p.assignments.push({ ...p.assignments[0]!, taskType: 'classify.root' });
    } });
    const jobs = (await f.work!.list(f.actor, { targetId: f.target.id })).items;
    expect(jobs.map(j => j.task.id)).toEqual(['summary']);
    const inputs = await f.work!.inputs(f.actor, jobs[0]!.id, { deliveryHandle: jobs[0]!.deliveryHandle! });
    expect(inputs.items[0]!.acceptedPredecessors).toEqual([expect.objectContaining({
      taskId: 'root', output: expect.objectContaining({ kind: 'placement', decision: 'keepParent' }),
    })]);
    expect((await sql`SELECT * FROM automation_job_attempts`.execute(f.db)).rows).toHaveLength(0);
    const proof = (await sql<{ proof_json: { effectReceiptId: string } }>`SELECT proof_json FROM automation_task_completions`.execute(f.db)).rows[0]!;
    expect(proof.proof_json.effectReceiptId).toBeTruthy();
    await expect(sql`UPDATE automation_task_completions SET digest='changed'`.execute(f.db)).rejects.toThrow('immutable');
  });
});
