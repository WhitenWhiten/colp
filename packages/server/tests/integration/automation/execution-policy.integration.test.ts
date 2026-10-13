import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { readFileSync } from 'node:fs';
import type { ExecutionPolicyInput } from '@know-n/colp/automation';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { registerAutomationRoutes } from '../../../src/transport/product/automation-rule-routes.js';
import { automationPolicyRoutes } from '../../../src/transport/product/automation-policy-routes.js';
import { installProductAdmission } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import { reserveOptionalWork, recordOptionalCall } from '../../../src/infrastructure/automation/usage-store.js';
import { taskExecutionAssignment } from '../../../src/modules/automation/application/executor-policy.js';
import { compatibleAcceptedResult } from '../../../src/modules/automation/application/result-reuse.js';

const ORIGIN = 'https://automation.example.test', BASE = '/api/v1/me/automations';
describeWithPostgres('AW-22 explicit policy and optional-work accounting', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>, app: ReturnType<typeof Fastify>;
  const input = (): ExecutionPolicyInput => JSON.parse(readFileSync('../../docs/automation/design/examples/execution-policy.json', 'utf8'));
  beforeEach(async () => {
    f = await automationRuntimeFixture('aw22', true);
    app = Fastify(); installProductAdmission(app);
    app.setErrorHandler((error, request, reply) => sendProductError(request, reply, error instanceof ProductHttpError ? error
      : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: String(error) })));
    registerAutomationRoutes(app, { identityUnitOfWork: f.identity, unitOfWork: f.uow, allowedOrigins: [ORIGIN], cursorKey: 'aw22-test-cursor-secret' }, automationPolicyRoutes('aw22-test-cursor-secret'));
    await app.ready();
  });
  afterEach(async () => { await app?.close(); await f?.isolated.close(); });
  const headers = (command = randomUUID(), etag?: string) => ({ cookie: f.owner.cookie, origin: ORIGIN, 'x-csrf-token': f.owner.csrfToken,
    'known-command-id': command, ...(etag ? { 'if-match': etag } : {}) });
  test('authenticated create/replay/update, immutable revisions and tenant/CSRF fences', async () => {
    const command = randomUUID(), payload = input();
    const create = () => app.inject({ method: 'POST', url: BASE + '/execution-policies', headers: headers(command), payload });
    const first = await create(), replay = await create(); expect(first.statusCode, first.body).toBe(201); expect(replay.body).toBe(first.body);
    const policy = first.json(), foreign = await f.issue('foreign');
    expect((await app.inject({ url: BASE + '/execution-policies/' + policy.id, headers: { cookie: foreign.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: BASE + '/execution-policies', headers: { ...headers(), origin: 'https://evil.test' }, payload })).statusCode).toBe(403);
    const changed = { ...payload, name: 'Changed' };
    const updates = await Promise.all([1,2].map(() => app.inject({ method: 'PUT', url: BASE + '/execution-policies/' + policy.id,
      headers: headers(randomUUID(), '"1"'), payload: changed })));
    expect(updates.map(r => r.statusCode).sort()).toEqual([200,412]);
    expect(await f.uow.execute(f.owner, p => p.policies.load(policy.id, '1'))).toEqual(policy);
    await expect(sql`UPDATE automation_execution_policy_revisions SET configuration_json='{}' WHERE policy_id=${policy.id}`.execute(f.db)).rejects.toThrow('immutable');
    payload.assignments.push(payload.assignments[0]!);
    expect((await app.inject({ method: 'POST', url: BASE + '/execution-policies', headers: headers(), payload })).statusCode).toBe(400);
  });
  test('concurrent caps reserve once per run, held optional work cannot suppress canonical M1 placement', async () => {
    await f.createNode('budget-a','root','A','https://arxiv.org/abs/a');
    await f.createNode('budget-b','root','B','https://arxiv.org/abs/b');
    await f.inspect();
    const runs = (await sql<{ id: string }>`SELECT id FROM automation_runs ORDER BY id`.execute(f.db)).rows;
    expect(runs).toHaveLength(2);
    const reservations = runs.map(row => ({ ownerId: f.owner.accountId, ruleId: f.rule.id, runId: row.id, jobId: randomUUID(), targetId: 'target' }));
    for (const r of reservations) await sql`INSERT INTO automation_jobs(id,run_id,task_id,target_id,target_partition,input_digest,contract_id,state)
      VALUES(${r.jobId},${r.runId},'summary','target','target','digest','summary.sourced.v1','blocked')`.execute(f.db);
    const reserve = (index: number) => f.db.transaction().execute(tx => reserveOptionalWork(tx, reservations[index]!, 1));
    expect((await Promise.all([reserve(0),reserve(1)])).sort()).toEqual([false,true]);
    const winner = (await sql<{ job_id: string }>`SELECT job_id FROM automation_usage_reservations`.execute(f.db)).rows[0]!.job_id;
    expect(await reserve(reservations.findIndex(r => r.jobId === winner))).toBe(true);
    await f.db.transaction().execute(tx => recordOptionalCall(tx, reservations.find(r => r.jobId === winner)!));
    expect((await sql<{ calls: number; unknown_cost_calls: number }>`SELECT calls,unknown_cost_calls FROM automation_usage_counters`.execute(f.db)).rows)
      .toEqual([{ calls: 1, unknown_cost_calls: 1 }]);
    const { createAutomationRuntime } = await import('../../../src/infrastructure/automation/runtime.js');
    await f.inspect(createAutomationRuntime('server'));
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id','in',['budget-a','budget-b']).execute()).map(r => r.parent_id)).toEqual(['academic','academic']);
  });
  test('no policy means no assignment; reuse requires contract, digest and current authority compatibility', () => {
    const task = { id: 'summary', type: 'summary.generate' as const, after: [], executorRole: 'researchEnricher', required: true,
      outputContract: 'summary.sourced.v1', inputFields: ['title' as const], instruction: 'Summarize' };
    expect(taskExecutionAssignment(null,task).available).toBe(false);
    const policy = { id: 'policy', revision: '1', configuration: input() };
    expect(taskExecutionAssignment(policy,task).available).toBe(true);
    expect(taskExecutionAssignment(policy,{ ...task,inputFields: ['readableText'] }).available).toBe(false);
    const identity = { ownerId: 'owner', inputDigest: 'digest', contractId: 'summary.sourced.v1', authorityDigest: 'current' };
    expect(compatibleAcceptedResult(identity,{ ...identity,status: 'accepted' })).toBe(true);
    for (const patch of [{ ownerId: 'foreign' },{ inputDigest: 'changed' },{ contractId: 'review.sourced.v1' },{ authorityDigest: 'revoked' }])
      expect(compatibleAcceptedResult(identity,{ ...identity,...patch,status: 'accepted' })).toBe(false);
  });
});
