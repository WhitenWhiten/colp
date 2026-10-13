import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationDigest,type SubmitResultInput } from '@know-n/colp/automation';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';

describeWithPostgres('worker submission settlement and pause recovery', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await f?.close(); });
  const read = (path: string) => f.app.inject({ url: '/api/v1/me/automations'+path, headers: { cookie: f.owner.cookie } });
  const work = (path: string, body?: unknown, commandId = randomUUID()) => f.app.inject({ method: body ? 'POST' : 'GET', url: '/api/v1/automation-work'+path,
    headers: { authorization: 'Bearer '+f.token, ...(body ? { 'known-command-id': commandId } : {}) }, ...(body ? { payload: body } : {}) });
  async function claimed() {
    const job = (await work('/jobs')).json().items[0];
    const inputs = (await work(`/jobs/${job.id}/inputs?deliveryHandle=${job.deliveryHandle}`)).json().items;
    const claim = await work(`/jobs/${job.id}/claim`, { deliveryHandle: job.deliveryHandle });
    expect(claim.statusCode).toBe(200);
    const lease = claim.json();
    return { job, body: { claimToken: lease.claimToken, generation: lease.generation, inputDigest: lease.inputDigest, outputContract: job.task.outputContract,
      output: { kind: 'text', textType: 'summary', text: 'Review probe summary', language: 'en', evidence: [{ kind: 'source', reference: inputs[0].sourceEventId, observedAt: new Date().toISOString() }] } } };
  }
  test('stale submitted output settles the job instead of becoming external uncertainty', async () => {
    f = await automationPollingFixture('review_stale'); const { job, body } = await claimed();
    expect((await work(`/jobs/${job.id}/results`, { ...body,inputDigest: '0'.repeat(64) })).statusCode).toBe(409);
    expect((await read('/jobs/'+job.id)).json().status).toBe('leased');
    await f.rename('fresh-paper', 'Manual edit');
    const command = randomUUID(), response = await work(`/jobs/${job.id}/results`, body, command);
    expect(response.statusCode,response.body).toBe(200); expect(response.json()).toMatchObject({ status: 'stale',effectReceiptIds: [] });
    expect((await work(`/jobs/${job.id}/results`, body, command)).body).toBe(response.body);
    expect((await work(`/jobs/${job.id}/results`, body)).json()).toEqual(response.json());
    await work('/jobs'); await f.inspect();
    const row = (await sql<{ state: string }>`SELECT state FROM automation_jobs WHERE id=${job.id}`.execute(f.db)).rows[0];
    expect(row?.state).toBe('stale');
    expect((await read('/runs/'+job.runId)).json().status).toBe('review');
    expect((await sql`SELECT id FROM automation_results WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
    expect((await sql`SELECT job_id FROM automation_job_attempts WHERE job_id=${job.id} AND outcome='submitted'`.execute(f.db)).rows).toHaveLength(1);
    expect((await sql`SELECT plan_id FROM automation_proposals WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(0);
  });
  test('unrelated collection edit after approval returns a domain conflict rather than 500', async () => {
    f = await automationPollingFixture('review_drift', { trusted: false }); const { job, body } = await claimed();
    const submitted = await work(`/jobs/${job.id}/results`, body); expect(submitted.json().status).toBe('awaitingApproval');
    const current = await read('/jobs/'+job.id);
    const approved = await f.ownerPost(`/jobs/${job.id}/decision`, { decision: 'approve', proposalDigest: submitted.json().proposalDigest, reason: 'Approve exact proposal' }, String(current.headers.etag));
    expect(approved.statusCode, approved.body).toBe(200);
    await f.createNode('unrelated', 'root', 'Unrelated folder');
    const response = await work(`/jobs/${job.id}/results`, body);
    expect(response.statusCode,response.body).toBe(200); expect(response.json()).toMatchObject({ status: 'stale',effectReceiptIds: [] });
    expect((await work(`/jobs/${job.id}/results`, body)).json()).toEqual(response.json());
    expect((await read('/runs/'+job.runId)).json().status).toBe('review');
    expect((await sql`SELECT * FROM automation_effect_receipts WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(0);
    expect(await f.db.selectFrom('mcp_change_plans').select('plan_id').execute()).toHaveLength(1);
  });
  test('Owner rejection settles a single-job run even without original worker resubmission', async () => {
    f = await automationPollingFixture('review_reject', { trusted: false }); const { job, body } = await claimed();
    const submitted = await work(`/jobs/${job.id}/results`, body); expect(submitted.json().status).toBe('awaitingApproval');
    const current = await read('/jobs/'+job.id);
    const rejected = await f.ownerPost(`/jobs/${job.id}/decision`, { decision: 'reject', proposalDigest: submitted.json().proposalDigest, reason: 'Reject exact proposal' }, String(current.headers.etag));
    expect(rejected.statusCode, rejected.body).toBe(200);
    await work('/jobs'); await f.inspect();
    expect((await read('/jobs/'+job.id)).json().status).toBe('review');
    expect((await read('/runs/'+job.runId)).json().status).toBe('review');
    expect((await work(`/jobs/${job.id}/results`,body)).json().status).toBe('review');
  });
  test('recovery of an expired staged proposal retains one plan and settles as review', async () => {
    f = await automationPollingFixture('review_expired', { trusted: false }); const { job,body } = await claimed();
    // Stop at the real prepare/reconcile boundary. The persisted proposal ages before its first Plan is built.
    await f.results!.prepare(f.actor,job.id,body as SubmitResultInput,automationDigest({ inputDigest: body.inputDigest,outputContract: body.outputContract,output: body.output }));
    expect(await f.db.selectFrom('mcp_change_plans').select('plan_id').execute()).toHaveLength(0);
    await sql`UPDATE automation_proposals SET created_at=created_at-interval '25 hours' WHERE job_id=${job.id}`.execute(f.db);
    const response = await work(`/jobs/${job.id}/results`,body);
    expect(response.statusCode,response.body).toBe(200); expect(response.json()).toMatchObject({ status: 'review',effectReceiptIds: [] });
    expect((await read('/runs/'+job.runId)).json().status).toBe('review');
    expect(await f.db.selectFrom('mcp_change_plans').select('plan_id').execute()).toHaveLength(1);
    expect((await sql`SELECT id FROM automation_results WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
  });
  test('pausing preserves an already running task output as a proposal without applying effects', async () => {
    f = await automationPollingFixture('review_pause'); const { job, body } = await claimed();
    const before = await read('/pause');
    expect((await f.ownerPost('/pause', { paused: true, reason: 'Hold effects' }, String(before.headers.etag))).statusCode).toBe(200);
    const heartbeat = await work(`/jobs/${job.id}/heartbeat`,{ claimToken: body.claimToken,generation: body.generation,extendSeconds: 120 });
    expect(heartbeat.statusCode,heartbeat.body).toBe(200);
    expect((await work('/jobs')).statusCode).toBe(503);
    const command = randomUUID(), response = await work(`/jobs/${job.id}/results`, body,command);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().status).toBe('committing');
    expect((await sql`SELECT * FROM automation_results WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
    expect((await sql`SELECT * FROM automation_effect_receipts WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(0);
    await sql`UPDATE automation_job_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=${job.id}`.execute(f.db);
    const paused = await read('/pause');
    expect((await f.ownerPost('/pause',{ paused: false,reason: 'Resume exact saved proposal' },String(paused.headers.etag))).statusCode).toBe(200);
    expect((await work(`/jobs/${job.id}/results`,body,command)).body).toBe(response.body);
    const resumed = await work(`/jobs/${job.id}/results`,body);
    expect(resumed.statusCode,resumed.body).toBe(200); expect(resumed.json().status).toBe('succeeded');
    expect((await sql`SELECT id FROM automation_results WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
    expect((await sql`SELECT job_id FROM automation_job_attempts WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
    expect((await sql`SELECT id FROM automation_effect_receipts WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
  });
});
