import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { validateAutomation } from '@know-n/colp/automation';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';

describeWithPostgres('AW-55 authorized waiting and budget observations', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async () => { await f?.close(); });
  const ownerRead = (path: string, cookie = f.owner.cookie) => f.app.inject({ url: '/api/v1/me/automations'+path,headers: { cookie } });
  const work = (path: string, body?: unknown, commandId = randomUUID()) => f.app.inject({ method: body ? 'POST' : 'GET',url: '/api/v1/automation-work'+path,
    headers: { authorization: 'Bearer '+f.token,...(body ? { 'known-command-id': commandId } : {}) },...(body ? { payload: body } : {}) });
  async function ruleUsage() {
    const response = await ownerRead(`/rules/${f.rule.id}`); expect(response.statusCode,response.body).toBe(200);
    expect(validateAutomation('Rule',response.json()).valid).toBe(true); return response.json().usage;
  }
  async function claim() {
    const job = (await work('/jobs')).json().items[0];
    const inputs = (await work(`/jobs/${job.id}/inputs?deliveryHandle=${job.deliveryHandle}`)).json().items;
    const response = await work(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle }); expect(response.statusCode,response.body).toBe(200);
    return { job,inputs,lease: response.json() };
  }
  function summary(claimed: Awaited<ReturnType<typeof claim>>, cost?: number) {
    return { claimToken: claimed.lease.claimToken,generation: claimed.lease.generation,inputDigest: claimed.lease.inputDigest,outputContract: claimed.job.task.outputContract,
      output: { kind: 'text',textType: 'summary',text: 'Private summary body',language: 'en',evidence: [{ kind: 'source',reference: claimed.inputs[0].sourceEventId,observedAt: new Date().toISOString() }] },
      ...(cost === undefined ? {} : { usageCostMicros: cost }) };
  }
  test('rule/list/run counts, unknown/known costs, daily reservations and replay stay separate from delivery', async () => {
    f = await automationPollingFixture('aw55_usage');
    expect(await ruleUsage()).toMatchObject({ admittedRuns: 1,readyJobs: 1,succeededJobs: 0,optionalCalls: 0,externalCosts: 'notApplicable',dailyRunLimit: 100,reservedRuns: 0,remainingRuns: 100,deliveryCapability: 'unavailable',acceptedDeliveries: null });
    const claimed = await claim();
    expect(await ruleUsage()).toMatchObject({ leasedJobs: 1,unknownCostCalls: 1,optionalCalls: 1,externalCosts: 'unknownDisclosed',reservedRuns: 1,remainingRuns: 99 });
    const command = randomUUID(), body = summary(claimed,1250);
    const result = await work(`/jobs/${claimed.job.id}/results`,body,command); expect(result.statusCode,result.body).toBe(200);
    expect((await work(`/jobs/${claimed.job.id}/results`,body,command)).body).toBe(result.body);
    expect((await work(`/jobs/${claimed.job.id}/results`,body)).statusCode).toBe(200);
    const usage = await ruleUsage();
    expect(usage).toMatchObject({ readyJobs: 0,succeededJobs: 1,optionalCalls: 1,unknownCostCalls: 0,reportedCostMicros: '1250',externalCosts: 'known',reservedRuns: 1 });
    const run = await ownerRead(`/runs/${claimed.job.runId}`); expect(run.statusCode,run.body).toBe(200);
    expect(validateAutomation('Run',run.json()).valid).toBe(true); expect(run.json().usage).toMatchObject({ succeededJobs: 1,reportedCostMicros: '1250' });
    const list = await ownerRead('/rules'); const { periodEnd: _observedAt,...stableUsage } = usage;
    expect(list.json().items[0].usage).toMatchObject(stableUsage);
    const serialized = JSON.stringify(usage); for (const secret of ['Private paper title','Private summary body',f.token,claimed.lease.claimToken,'https://arxiv.org']) expect(serialized).not.toContain(secret);
    const counters = (await sql<{ calls: number; unknown_cost_calls: number; reported: string }>`SELECT calls,unknown_cost_calls,reported_cost_micros::text AS reported FROM automation_usage_counters`.execute(f.db)).rows;
    expect(counters).toEqual([{ calls: 1,unknown_cost_calls: 0,reported: '1250' }]);
    const other = await f.issue('other'); expect((await ownerRead(`/rules/${f.rule.id}`,other.cookie)).statusCode).toBe(404);
    expect((await ownerRead(`/runs/${claimed.job.runId}`,other.cookie)).statusCode).toBe(404);
    await f.db.updateTable('collections').set({ owner_subject_id: other.subjectId }).where('id','=','collection').execute();
    expect((await ownerRead(`/runs/${claimed.job.runId}`)).statusCode).toBe(404);
    expect(await ruleUsage()).toMatchObject({ admittedRuns: 0,succeededJobs: 0,optionalCalls: 0,reportedCostMicros: '0' });
  });
  test('Manual approval, pause, uncertainty, policy block and exhausted call budget are explicit', async () => {
    f = await automationPollingFixture('aw55_wait',{ trusted: false,maxCalls: 2 });
    const claimed = await claim(), response = await work(`/jobs/${claimed.job.id}/results`,summary(claimed));
    expect(response.statusCode,response.body).toBe(200); expect(response.json().status).toBe('awaitingApproval');
    expect(await ruleUsage()).toMatchObject({ awaitingApprovalJobs: 1,succeededJobs: 0,unknownCostCalls: 1,externalCosts: 'unknownDisclosed',acceptedDeliveries: null });
    const pause = await ownerRead('/pause'); expect((await f.ownerPost('/pause',{ paused: true,reason: 'Observe held work' },String(pause.headers.etag))).statusCode).toBe(200);
    expect(await ruleUsage()).toMatchObject({ heldJobs: 1,awaitingApprovalJobs: 1,succeededJobs: 0 });
    await f.close();
    f = await automationPollingFixture('aw55_unknown',{ maxCalls: 1 });
    const uncertain = await claim();
    const failure = await work(`/jobs/${uncertain.job.id}/failures`,{ claimToken: uncertain.lease.claimToken,generation: uncertain.lease.generation,kind: 'unknownOutcome',code: 'lost',message: 'External result lost' });
    expect(failure.statusCode,failure.body).toBe(200);
    expect(await ruleUsage()).toMatchObject({ uncertainJobs: 1,unknownCostCalls: 1,succeededJobs: 0 });
    await f.close();
    f = await automationPollingFixture('aw55_budget',{ maxCalls: 1 });
    const retry = await claim();
    expect((await work(`/jobs/${retry.job.id}/failures`,{ claimToken: retry.lease.claimToken,generation: retry.lease.generation,kind: 'knownRetryable',code: 'safe',message: 'Explicitly known failure' })).statusCode).toBe(200);
    expect((await work(`/jobs/${retry.job.id}/claim`,{ deliveryHandle: retry.job.deliveryHandle })).statusCode).toBe(409);
    expect(await ruleUsage()).toMatchObject({ budgetBlockedJobs: 1,policyBlockedJobs: 1,succeededJobs: 0,optionalCalls: 1,unknownCostCalls: 1 });
    await f.close();
    f = await automationPollingFixture('aw55_policy',{ policyEnabled: false });
    expect(await ruleUsage()).toMatchObject({ policyBlockedJobs: 1,optionalCalls: 0,externalCosts: 'notApplicable',succeededJobs: 0 });
  });
  test('late explicit zero cost resolves only its attempt; UTC reservation day resets without erasing unknown history', async () => {
    f = await automationPollingFixture('aw55_day'); const claimed = await claim();
    await sql`UPDATE automation_job_attempts SET created_at=created_at-interval '1 day'`.execute(f.db);
    await sql`UPDATE automation_usage_counters SET day=day-1`.execute(f.db);
    await sql`UPDATE automation_usage_reservations SET day=day-1`.execute(f.db);
    expect(await ruleUsage()).toMatchObject({ reservedRuns: 0,remainingRuns: 100,unknownCostCalls: 1 });
    const result = await work(`/jobs/${claimed.job.id}/results`,summary(claimed,0)); expect(result.statusCode,result.body).toBe(200);
    expect(await ruleUsage()).toMatchObject({ optionalCalls: 1,unknownCostCalls: 0,reportedCostMicros: '0',externalCosts: 'known' });
    expect((await sql<{ unknown: number }>`SELECT unknown_cost_calls AS unknown FROM automation_usage_counters`.execute(f.db)).rows).toEqual([{ unknown: 0 }]);
  });
});
