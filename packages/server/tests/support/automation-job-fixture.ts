import { seedAutomationTarget } from './automation-target-fixture.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import type { RuleDefinition, TaskInput } from '@know-n/colp/automation';
import { automationRuntimeFixture } from './automation-runtime-fixture.js';
import { saveExecutionPolicy, type WorkPrincipal } from '../../src/modules/automation/index.js';
import { createJobLeaseStore } from '../../src/infrastructure/automation/lease-store.js';
import { createResultSubmissionPort } from '../../src/infrastructure/automation/result-store.js';
import { createProposalPlanGateway } from '../../src/infrastructure/automation/proposal-plan-gateway.js';
import { createPhase4bMcpWriteComposition, createMcpChangePlanRateLimitPort } from '../../src/bootstrap/mcp-write-composition.js';

/** AW-24 service fixture: real canonical source/run; explicit M2 pins, before AW-31 admission is mounted. */
export async function automationJobFixture(prefix: string,kind: 'summary' | 'tags' | 'move' = 'summary',options: { afterCanonicalCommit?: () => Promise<void>; beforeCanonicalCommit?: () => Promise<void> } = {}) {
  const f = await automationRuntimeFixture(prefix,true);
  await seedAutomationTarget(f.uow,f.owner);
  await f.createNode('job-paper','root','Job paper','https://arxiv.org/abs/job'); await f.inspect();
  const run = (await sql<{ id: string; rule_revision_id: string; member_ids: string[] }>`SELECT * FROM automation_runs`.execute(f.db)).rows[0]!;
  const definition = JSON.parse(readFileSync('../../docs/automation/design/examples/academic-summary-only.json','utf8')) as RuleDefinition;
  const task = definition.tasks[0]!;
  if (kind === 'tags') { task.type='tags.generate';task.outputContract='tags.sourced.v1'; }
  if (kind === 'move') { task.type='classify.refine';task.outputContract='placement.subtree.v1';task.folderRole='academicRoot'; }
  const policy = await f.uow.execute(f.owner,async p => {
    const policy = JSON.parse(readFileSync('../../docs/automation/design/examples/execution-policy.json','utf8'));
    policy.allowAutomaticWrites=true;
    const saved = await saveExecutionPolicy(p.policies,policy);
    const previous = (await p.rules.load(f.owner.accountId,f.rule.id))!;
    const updated = { ...previous,definitionRevisionId: randomUUID(),definitionRevision: '2',view: { ...previous.view,revision: '3',executionPolicyId: saved.id,
      definition: { ...previous.view.definition,roles: definition.roles,tasks: [task] } } };
    await p.rules.save(f.owner.accountId,updated);
    return { saved,revisionId: updated.definitionRevisionId };
  });
  await sql`UPDATE automation_runs SET rule_revision_id=${policy.revisionId},policy_revision='1',state='running' WHERE id=${run.id}`.execute(f.db);
  const node = await f.db.selectFrom('nodes').select('resource_revision').where('id','=','job-paper').executeTakeFirstOrThrow();
  const jobId = randomUUID(), inputs: TaskInput[] = [{ sourceEventId: run.member_ids[0]!,availability: 'available',node: { serverUuid: 'server',collectionId: 'collection',nodeId: 'job-paper' },title: 'Job paper',url: 'https://arxiv.org/abs/job',tags: [] }];
  await sql`INSERT INTO automation_jobs(id,run_id,task_id,target_id,target_partition,input_digest,contract_id,state,delivery_handle,
    task_json,input_json,input_revision,authority_digest,allowed_folders) VALUES(${jobId},${run.id},${task.id},'target','target',${'a'.repeat(64)},${task.outputContract},'ready','handle',
      ${JSON.stringify(task)}::jsonb,${JSON.stringify(inputs)}::jsonb,${node.resource_revision},'authority',${JSON.stringify([f.folder])}::jsonb)`.execute(f.db);
  const actor: WorkPrincipal = { ...f.owner,clientId: 'client',credentialBindingId: 'credential',scopes: ['automation:work'],resourceAudience: 'colp://known/collections',securityEpoch: 'epoch' };
  const authorize = async (_tx: unknown,principal: WorkPrincipal,target: string) => {
    if (principal.accountId !== actor.accountId || principal.clientId !== 'client' || principal.credentialBindingId !== 'credential' || target !== 'target') throw new Error('Target binding rejected');
  };
  let results: ReturnType<typeof createResultSubmissionPort>;
  const composition = createPhase4bMcpWriteComposition({ db: f.db,serverUuid: '11111111-1111-4111-8111-111111111111',approvalBaseUri: 'https://automation.example.test/approvals',requestStateKey: 'aw24-request-state-key-at-least-32-bytes',
    allowedScopes: ['automation:work'],rateLimit: createMcpChangePlanRateLimitPort({ maxPlans: 100,windowMs: 60_000 }),
    beforeBeginCommit: async ({ transaction,planId }) => { await results.guard(transaction,planId); await options.beforeCanonicalCommit?.(); } });
  const gateway = createProposalPlanGateway(f.db,composition.changePlanOptions);
  results = createResultSubmissionPort(f.db,'server',authorize,gateway,options);
  const leases = createJobLeaseStore(f.db,authorize,100);
  return { ...f,actor,jobId,runId: run.id,task,inputs,results,leases,composition };
}
