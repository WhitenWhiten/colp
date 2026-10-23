import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, expect, test } from 'vitest';
import type { Job, TaskOutput } from '@know-n/colp/automation';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createActivityStore, purgeActivity } from '../../../src/infrastructure/activity/index.js';

describeWithPostgres('run activity triggers and output read bridge', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  let placement: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  afterEach(async () => { await f?.close(); await placement?.isolated.close(); });
  const store = () => createActivityStore(f.db, 'run-activity-cursor-key-at-least-32-bytes');
  test('real output completion records count, output read clears activity, changed state reopens it', async () => {
    f = await automationPollingFixture('activity_runs', { configure: (definition, policy) => {
      delete definition.intake; definition.trigger = { mode: 'countBatch', count: 2, distinctBy: 'node', partition: 'rule' }; definition.on = 'node.created';
      definition.tasks = [{ ...definition.tasks[0]!, id: 'digest', type: 'digest.generate', outputContract: 'digest.sourced.v1' }];
      policy.assignments = [{ ...policy.assignments[0]!, taskType: 'digest.generate' }];
    } });
    await f.createNode('second', 'root', 'Second paper', 'https://arxiv.org/abs/second'); await f.inspect();
    expect(await store().summary(f.owner.accountId)).toMatchObject({ unreadCount: 0, latest: null });
    const job: Job = (await f.work!.list(f.actor, { targetId: f.target.id })).items[0]!;
    const inputs = await f.work!.inputs(f.actor, job.id, { deliveryHandle: job.deliveryHandle! });
    const lease = await f.work!.mutate(f.actor, job.id, 'claim', { deliveryHandle: job.deliveryHandle }, randomUUID());
    const output: TaskOutput = { kind: 'text', textType: 'digest', text: 'An accepted digest.', language: 'en', evidence: [
      { kind: 'source', reference: inputs.items[0]!.sourceEventId, observedAt: new Date().toISOString() }] };
    const result = await f.work!.mutate(f.actor, job.id, 'submit', { claimToken: lease.claimToken, generation: lease.generation,
      inputDigest: lease.inputDigest, outputContract: job.task.outputContract, output }, randomUUID());
    expect(result.status).toBe('succeeded');
    await f.db.transaction().execute(async tx => {
      await sql`INSERT INTO automation_runs(id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state,explanation_json)
        SELECT 'running-manual-child',owner_id,'manual',rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,'completed',
          explanation_json||'{"parentRunId":"manual-parent"}'::jsonb FROM automation_runs WHERE id=${job.runId}`.execute(tx);
      await sql`UPDATE automation_runs SET state='running' WHERE id='running-manual-child'`.execute(tx);
      await sql`INSERT INTO automation_runs(id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state,explanation_json)
        SELECT 'deleted-before-commit',owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,'completed',explanation_json
        FROM automation_runs WHERE id=${job.runId}`.execute(tx);
      await sql`DELETE FROM automation_runs WHERE id='deleted-before-commit'`.execute(tx);
    });
    expect((await store().list(f.owner.accountId, {})).items).toHaveLength(1);
    const activity = (await store().summary(f.owner.accountId)).latest!;
    expect(activity).toMatchObject({ kind: 'run_completed', state: 'unread', count: 1, run: { id: job.runId, outputCount: 1, status: 'completed' } });
    const runPath = `/api/v1/me/automations/runs/${job.runId}`;
    const run = await f.app.inject({ url: runPath, headers: { cookie: f.owner.cookie } });
    const outputs = await f.app.inject({ url: `${runPath}/outputs`, headers: { cookie: f.owner.cookie } });
    const read = await f.app.inject({ method: 'POST', url: `${runPath}/read`, headers: f.ownerHeaders(randomUUID(), String(run.headers.etag)),
      payload: { throughOutputId: outputs.json().items[0].id } });
    expect(read.statusCode, read.body).toBe(200); expect((await store().summary(f.owner.accountId)).unreadCount).toBe(0);
    await sql`UPDATE automation_runs SET state='completed' WHERE id=${job.runId}`.execute(f.db);
    const reread = (await store().summary(f.owner.accountId)).latest!;
    expect(reread.state).toBe('read');
    await f.db.transaction().execute(async tx => {
      await sql`UPDATE automation_runs SET state='partial' WHERE id=${job.runId}`.execute(tx);
      await sql`UPDATE automation_runs SET state='completed' WHERE id=${job.runId}`.execute(tx);
    });
    expect((await store().summary(f.owner.accountId)).latest?.revision).toBe(reread.revision);
    await sql`UPDATE automation_runs SET state='review' WHERE id=${job.runId}`.execute(f.db);
    expect((await store().summary(f.owner.accountId)).latest).toMatchObject({ id: activity.id, kind: 'run_attention', state: 'unread', run: { attention: 'review' } });
    await store().markRead(f.owner.accountId, { ids: [activity.id] });
    await sql`UPDATE automation_jobs SET state='awaitingApproval' WHERE id=${job.id}`.execute(f.db);
    expect((await store().summary(f.owner.accountId)).latest).toMatchObject({ id: activity.id, state: 'unread', run: { attention: 'awaitingApproval' } });
    await sql`UPDATE automation_runs SET state='partial' WHERE id=${job.runId}`.execute(f.db);
    expect((await store().summary(f.owner.accountId)).latest?.kind).toBe('run_partial');
    await sql`UPDATE automation_runs SET state='blocked' WHERE id=${job.runId}`.execute(f.db);
    expect((await store().summary(f.owner.accountId)).latest?.kind).toBe('run_failed');
    await sql`UPDATE activity_items SET read_at=clock_timestamp(),updated_at=clock_timestamp()-interval '91 days'`.execute(f.db);
    expect(await purgeActivity(f.db)).toBe(1);
  });
  test('placement-only runs do not produce activity', async () => {
    placement = await automationRuntimeFixture('activity_placement');
    await placement.createNode('fresh', 'root', 'Fresh paper', 'https://arxiv.org/abs/fresh'); await placement.inspect();
    expect((await sql`SELECT id FROM automation_runs`.execute(placement.db)).rows.length).toBeGreaterThan(0);
    expect((await sql`SELECT id FROM activity_items`.execute(placement.db)).rows).toHaveLength(0);
    await sql`INSERT INTO automation_runs(id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state,explanation_json)
      SELECT 'manual-parent',owner_id,'manual',rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,'completed',
        explanation_json||'{"manualSelection":true}'::jsonb FROM automation_runs LIMIT 1`.execute(placement.db);
    expect((await sql`SELECT id FROM activity_items`.execute(placement.db)).rows).toHaveLength(0);
    await sql`INSERT INTO automation_runs(id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state,explanation_json)
      SELECT 'manual-child',owner_id,'manual',rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,'completed',
        explanation_json||'{"manualSelection":false,"parentRunId":"manual-parent"}'::jsonb FROM automation_runs LIMIT 1`.execute(placement.db);
    expect((await sql`SELECT kind FROM activity_items`.execute(placement.db)).rows).toEqual([{ kind: 'run_completed' }]);
  });
});
