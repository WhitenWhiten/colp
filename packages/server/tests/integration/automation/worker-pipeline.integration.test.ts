import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createAjv } from '@know-n/colp/schema';
import { validateAutomation,type RuleDefinition,type ExecutionPolicyInput } from '@know-n/colp/automation';
import { automationWorkerFixture } from '../../support/automation-worker-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationWorkPrincipal,createMcpApplicationContext,createAutomationToolPort,withAutomationCatalog,type McpApplicationFacade } from '../../../src/modules/mcp/index.js';
import { writeAgentPolicy } from '../../../src/infrastructure/collections/index.js';
import { readRepositoryFile } from '../../support/repository-files.js';

describeWithPostgres('AW-31 authenticated polling and typed canonical orchestration',() => {
  let f: Awaited<ReturnType<typeof automationWorkerFixture>>;
  afterEach(async () => { await f?.close(); });
  const read = (path: string,token = f.token) => f.app.inject({ url: '/api/v1/automation-work'+path,headers: { authorization: 'Bearer '+token } });
  const post = (path: string,payload: unknown,command = randomUUID()) => f.app.inject({ method: 'POST',url: '/api/v1/automation-work'+path,
    headers: { authorization: 'Bearer '+f.token,'known-command-id': command },payload });
  async function setup(prefix: string,{ three = false,policyEnabled = true,maxCalls = 1,configure,inspect }: { three?: boolean; policyEnabled?: boolean; maxCalls?: number; configure?: (definition: RuleDefinition,policy: ExecutionPolicyInput) => void; inspect?: (fixture: Awaited<ReturnType<typeof automationWorkerFixture>>) => Promise<void> } = {}) {
    f = await automationWorkerFixture(prefix,100,true,true);const setup = await f.setup();expect((await f.pair(setup.grant)).statusCode).toBe(200);
    const executors = await f.app.inject({ url: '/api/v1/me/automations/executors',headers: { cookie: f.owner.cookie } });
    expect(executors.statusCode,executors.body).toBe(200);const executor = executors.json().items[0];
    const bindings = await f.ownerPost('/binding-sets',{ name: 'Pinned enrichment bindings',values: { ...f.values,researchEnricher: { kind: 'executor',executorId: executor.id } } });
    expect(bindings.statusCode,bindings.body).toBe(201);
    const policy = JSON.parse(readRepositoryFile('docs/automation/design/examples/execution-policy.json'));
    policy.allowAutomaticWrites=true;for (const assignment of policy.assignments) { assignment.allowedDestinations=[executor.id];assignment.maxCalls=maxCalls; }
    const definition = JSON.parse(readRepositoryFile(`docs/automation/design/examples/${three ? 'academic-intake' : 'academic-summary-only'}.json`)) as RuleDefinition;
    definition.scope.collectionId='collection';definition.route.targetIds=[setup.target.id];
    if (three) definition.tasks[2]!.after=['tags'];
    configure?.(definition,policy);
    const savedPolicy = policyEnabled ? await f.ownerPost('/execution-policies',policy) : null;
    if (savedPolicy) expect(savedPolicy.statusCode,savedPolicy.body).toBe(201);
    const ruleInput = { definition,bindingSetId: bindings.json().id,...(savedPolicy ? { executionPolicyId: savedPolicy.json().id } : {}) };
    const rule = await f.ownerPost('/rules',ruleInput);expect(rule.statusCode,rule.body).toBe(201);
    const preview = await f.ownerPost('/rules/preview',{ rule: ruleInput,mode: 'currentState' });expect(preview.statusCode,preview.body).toBe(200);
    const enabled = await f.ownerPost(`/rules/${rule.json().id}/lifecycle`,{ state: 'enabled',pendingRuns: 'hold',reason: 'Enable exact preview',activationPreviewId: preview.json().previewId },String(rule.headers.etag));
    expect(enabled.statusCode,enabled.body).toBe(200);
    await writeAgentPolicy(f.db,f.owner.accountId,f.actor.clientId,'trusted');
    await f.createNode('fresh-paper','root','New paper','https://arxiv.org/abs/new');await (inspect ? inspect(f) : f.inspect());
    return { target: setup.target,rule: rule.json(),ruleInput };
  }
  test.each(['defer', 'review'] as const)('missing predicate input with worker enabled keeps %s work without scheduling tasks',async missingInput => {
    await setup('merge_missing_'+missingInput,{ configure: d => { d.policy.missingInput=missingInput; },inspect: async fixture => {
      await fixture.createNode('missing-predicate','root','Missing input',`https://arxiv.org/${'x'.repeat(2050)}`);
      await fixture.inspect();
    } });
    await f.inspect();
    const run = (await sql<{ id: string; state: string }>`SELECT id,state FROM automation_runs WHERE explanation_json->>'nodeId'='missing-predicate'`.execute(f.db)).rows[0]!;
    expect(run.state).toBe(missingInput === 'defer' ? 'waiting' : 'review');
    expect((await sql`SELECT id FROM automation_jobs WHERE run_id=${run.id}`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT id FROM automation_effect_receipts WHERE run_id=${run.id}`.execute(f.db)).rows).toEqual([]);
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id','=','missing-predicate').executeTakeFirstOrThrow()).parent_id).toBe('root');
  });
  test('worker rules retain daily overflow without starting optional tasks before intake admission',async () => {
    await setup('merge_worker_daily',{ configure: d => { d.policy.maxRunsPerDay=1; } });
    await f.createNode('overflow','root','Overflow paper','https://arxiv.org/abs/overflow');await f.inspect();
    const run = (await sql<{ id: string; state: string }>`SELECT id,state FROM automation_runs WHERE explanation_json->>'nodeId'='overflow'`.execute(f.db)).rows[0]!;
    expect(run.state).toBe('waiting');
    expect((await sql<{ state: string }>`SELECT state FROM automation_jobs WHERE run_id=${run.id}`.execute(f.db)).rows).toEqual([{ state: 'pending' }]);
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id','=','overflow').executeTakeFirstOrThrow()).parent_id).toBe('root');
    await sql`UPDATE automation_intake_reservations SET admission_day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1`.execute(f.db);
    await sql`UPDATE automation_intake_delays SET available_at=clock_timestamp()-interval '1 second'`.execute(f.db);
    const { createAutomationRuntime } = await import('../../../src/infrastructure/automation/runtime.js');
    await f.db.transaction().execute(tx => createAutomationRuntime('server',true)(tx,f.owner,'collection',[]));
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id','=','overflow').executeTakeFirstOrThrow()).parent_id).toBe('academic');
    expect((await sql<{ state: string }>`SELECT state FROM automation_jobs WHERE run_id=${run.id}`.execute(f.db)).rows).toEqual([{ state: 'ready' }]);
  });
  test('real pairing → queue → allowlisted inputs → claim/heartbeat → typed summary → trusted canonical effect; replay cannot duplicate',async () => {
    await setup('aw31_loop');
    const queue = await read('/jobs');expect(queue.statusCode,queue.body).toBe(200);expect(validateAutomation('JobPage',queue.json()).valid).toBe(true);
    expect(queue.json().items).toHaveLength(1);const job = queue.json().items[0];
    const source = await f.db.selectFrom('nodes').select('parent_id').where('id','=','fresh-paper').executeTakeFirstOrThrow();expect(source.parent_id).toBe('academic');
    const inputs = await read(`/jobs/${job.id}/inputs?deliveryHandle=${job.deliveryHandle}`);expect(inputs.statusCode,inputs.body).toBe(200);
    expect(inputs.json().items[0]).toMatchObject({ title: 'New paper',url: 'https://arxiv.org/abs/new',availability: 'available' });
    expect(Object.keys(inputs.json().items[0]).sort()).toEqual(['availability','node','sourceEventId','tags','title','url']);
    expect((await read(`/jobs/${job.id}?deliveryHandle=foreign`)).statusCode).toBe(404);
    const command = randomUUID(),claimed = await post(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle },command);expect(claimed.statusCode,claimed.body).toBe(200);
    const lease = claimed.json();expect((await post(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle },command)).statusCode).toBe(409);
    const heartbeat = await post(`/jobs/${job.id}/heartbeat`,{ claimToken: lease.claimToken,generation: lease.generation,extendSeconds: 120 });expect(heartbeat.statusCode,heartbeat.body).toBe(200);
    const body = { claimToken: lease.claimToken,generation: lease.generation,inputDigest: lease.inputDigest,outputContract: job.task.outputContract,
      output: { kind: 'text',textType: 'summary',text: 'Injected deterministic summary.',language: 'en',evidence: [{ kind: 'source',reference: inputs.json().items[0].sourceEventId,observedAt: new Date().toISOString() }] } };
    const submitId = randomUUID(),accepted = await post(`/jobs/${job.id}/results`,body,submitId);expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json().status).toBe('succeeded');
    expect((await post(`/jobs/${job.id}/results`,body,submitId)).body).toBe(accepted.body);
    expect((await post(`/jobs/${job.id}/results`,body)).json().effectReceiptIds).toEqual(accepted.json().effectReceiptIds);
    expect((await read('/jobs')).json().items).toEqual([]);
    expect(await f.db.selectFrom('annotations').select('id').where('subject_id','=','fresh-paper').execute()).toHaveLength(1);
    expect((await sql`SELECT * FROM automation_effect_receipts WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
    const receipts = await f.db.selectFrom('product_command_receipts').select('result_bytes').execute();
    expect(receipts.map(r => Buffer.from(r.result_bytes ?? []).toString()).join('\n')).not.toContain(lease.claimToken);
  });
  test('the three-task fixture schedules each job once, allows only live descendants and preserves preceding effects',async () => {
    await setup('aw31_three',{ three: true });await f.createNode('topic','academic','Topic');
    const visited = [];
    for (let i=0;i<3;i++) {
      const queue = await read('/jobs');expect(queue.statusCode,queue.body).toBe(200);expect(queue.json().items).toHaveLength(1);
      const job = queue.json().items[0];visited.push(job.task.type);
      const inputs = await read(`/jobs/${job.id}/inputs?deliveryHandle=${job.deliveryHandle}`),leaseResponse = await post(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle });
      expect(leaseResponse.statusCode,leaseResponse.body).toBe(200);const lease=leaseResponse.json();
      if (i===2) expect(inputs.json().items[0].acceptedPredecessors).toEqual([expect.objectContaining({ taskId: 'tags',output: expect.objectContaining({ kind: 'tags' }) })]);
      const evidence = [{ kind: 'source',reference: inputs.json().items[0].sourceEventId,observedAt: new Date().toISOString() }];
      const output = i===0 ? { kind: 'placement',decision: 'move',destination: { ...f.folder,nodeId: 'topic' },reason: 'Live descendant',evidence }
        : i===1 ? { kind: 'tags',mergeMode: 'unionPreserveUser',add: [{ key: 'research',label: 'Research',evidence }] }
          : { kind: 'text',textType: 'summary',text: 'Three-task summary',language: 'en',evidence };
      const result = await post(`/jobs/${job.id}/results`,{ claimToken: lease.claimToken,generation: lease.generation,inputDigest: lease.inputDigest,outputContract: job.task.outputContract,output });
      expect(result.statusCode,result.body).toBe(200);expect(result.json().status).toBe('succeeded');
    }
    expect(visited).toEqual(['classify.refine','tags.generate','summary.generate']);
    expect((await read('/jobs')).json().items).toEqual([]);
    const node = await f.db.selectFrom('nodes').select(['parent_id','payload_json']).where('id','=','fresh-paper').executeTakeFirstOrThrow();
    expect(node.parent_id).toBe('topic');expect(node.payload_json?.tags).toEqual(['research']);
    expect((await sql`SELECT * FROM automation_jobs`.execute(f.db)).rows).toHaveLength(3);
  });
  test('missing execution policy holds every optional call while M1 still commits deterministic placement',async () => {
    await setup('aw31_no_policy',{ policyEnabled: false });
    const node = await f.db.selectFrom('nodes').select('parent_id').where('id','=','fresh-paper').executeTakeFirstOrThrow();expect(node.parent_id).toBe('academic');
    expect((await read('/jobs')).json().items).toEqual([]);
    expect((await sql<{ state: string }>`SELECT state FROM automation_jobs`.execute(f.db)).rows).toEqual([{ state: 'blocked' }]);
    expect((await sql<{ state: string }>`SELECT state FROM automation_runs`.execute(f.db)).rows).toEqual([{ state: 'blocked' }]);
    expect((await sql`SELECT * FROM automation_job_attempts`.execute(f.db)).rows).toEqual([]);
    expect(await f.db.selectFrom('mcp_change_plans').select('plan_id').execute()).toEqual([]);
    const blocked = (await sql<{ id: string; contract_id: string; input_digest: string }>`SELECT id,contract_id,input_digest FROM automation_jobs`.execute(f.db)).rows[0]!;
    const premature = await post(`/jobs/${blocked.id}/results`,{ claimToken: 'missing',generation: 1,inputDigest: blocked.input_digest,outputContract: blocked.contract_id,
      output: { kind: 'text',textType: 'summary',text: 'Premature result',language: 'en',evidence: [{ kind: 'source',reference: 'unknown',observedAt: new Date().toISOString() }] } });
    expect(premature.statusCode,premature.body).toBe(409);
  });
  test('manual approval uses the existing Owner plan ledger before the same durable proposal is reconciled',async () => {
    await setup('aw31_manual');await writeAgentPolicy(f.db,f.owner.accountId,f.actor.clientId,'manual');
    const job = (await read('/jobs')).json().items[0],inputs = (await read(`/jobs/${job.id}/inputs?deliveryHandle=${job.deliveryHandle}`)).json().items;
    const lease = (await post(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle })).json();
    const body = { claimToken: lease.claimToken,generation: lease.generation,inputDigest: lease.inputDigest,outputContract: job.task.outputContract,
      output: { kind: 'text',textType: 'summary',text: 'Approval summary',language: 'en',evidence: [{ kind: 'source',reference: inputs[0].sourceEventId,observedAt: new Date().toISOString() }] } };
    const submitted = await post(`/jobs/${job.id}/results`,body);expect(submitted.statusCode,submitted.body).toBe(200);expect(submitted.json().status).toBe('awaitingApproval');
    const ownerJob = await f.app.inject({ url: `/api/v1/me/automations/jobs/${job.id}`,headers: { cookie: f.owner.cookie } });
    expect(ownerJob.statusCode,ownerJob.body).toBe(200);expect(ownerJob.json().deliveryHandle).toBeUndefined();
    const decision = { decision: 'approve',proposalDigest: submitted.json().proposalDigest,reason: 'Approve this exact summary' };
    const stale = await f.ownerPost(`/jobs/${job.id}/decision`,{ ...decision,proposalDigest: 'a'.repeat(64) },String(ownerJob.headers.etag));
    expect(stale.statusCode,stale.body).toBe(409);
    const approved = await f.ownerPost(`/jobs/${job.id}/decision`,decision,String(ownerJob.headers.etag));
    expect(approved.statusCode,approved.body).toBe(200);
    // The server applies the approved proposal itself; the worker never has to resubmit.
    const applied = await f.app.inject({ url: `/api/v1/me/automations/jobs/${job.id}`,headers: { cookie: f.owner.cookie } });
    expect(applied.json().status).toBe('succeeded');
    expect((await sql`SELECT id FROM automation_effect_receipts WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
    const accepted = await post(`/jobs/${job.id}/results`,body);expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json().status).toBe('succeeded');
    expect(await f.db.selectFrom('mcp_change_plans').select('plan_id').execute()).toHaveLength(1);
    expect((await sql`SELECT id FROM automation_effect_receipts WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
  });
  async function awaitingApproval(prefix: string) {
    await setup(prefix);await writeAgentPolicy(f.db,f.owner.accountId,f.actor.clientId,'manual');
    const job = (await read('/jobs')).json().items[0],inputs = (await read(`/jobs/${job.id}/inputs?deliveryHandle=${job.deliveryHandle}`)).json().items;
    const lease = (await post(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle })).json();
    const submitted = await post(`/jobs/${job.id}/results`,{ claimToken: lease.claimToken,generation: lease.generation,inputDigest: lease.inputDigest,outputContract: job.task.outputContract,
      output: { kind: 'text',textType: 'summary',text: 'Converging summary',language: 'en',evidence: [{ kind: 'source',reference: inputs[0].sourceEventId,observedAt: new Date().toISOString() }] } });
    expect(submitted.json().status).toBe('awaitingApproval');
    const owner = (path: string) => f.app.inject({ url: '/api/v1/me/automations'+path,headers: { cookie: f.owner.cookie } });
    return { job,submitted: submitted.json(),owner };
  }
  test('an approval for a revoked worker is retained for review instead of stranding the run',async () => {
    const { job,submitted,owner } = await awaitingApproval('aw31_revoked_approval');
    expect((await f.revokeWorker()).kind).toBe('succeeded');
    const current = await owner('/jobs/'+job.id);
    const approved = await f.ownerPost(`/jobs/${job.id}/decision`,{ decision: 'approve',proposalDigest: submitted.proposalDigest,reason: 'Approve after revocation' },String(current.headers.etag));
    expect(approved.statusCode,approved.body).toBe(200);
    expect((await owner('/jobs/'+job.id)).json().status).toBe('review');
    expect((await owner('/runs/'+job.runId)).json().status).not.toBe('running');
    expect((await sql`SELECT id FROM automation_effect_receipts WHERE job_id=${job.id}`.execute(f.db)).rows).toEqual([]);
  });
  test('the maintenance sweep settles an expired plan without the original worker',async () => {
    const { job,owner } = await awaitingApproval('aw31_expired_sweep');
    await sql`UPDATE mcp_change_plans SET status='expired' WHERE plan_id=(SELECT plan_id FROM automation_proposals WHERE job_id=${job.id})`.execute(f.db);
    expect(await f.approvals!.sweep(f.owner.accountId)).toBe(1);
    expect((await owner('/jobs/'+job.id)).json().status).toBe('review');
    expect(await f.approvals!.sweep(f.owner.accountId)).toBe(0);
  });
  test('an Owner retry proposes the retained output again after its plan expired, and approval commits it',async () => {
    const { job,submitted,owner } = await awaitingApproval('aw31_repropose');
    const first = (await sql<{ plan_id: string }>`SELECT plan_id FROM automation_proposals WHERE job_id=${job.id}`.execute(f.db)).rows[0]!.plan_id;
    await sql`UPDATE mcp_change_plans SET status='expired' WHERE plan_id=${first}`.execute(f.db);
    expect(await f.approvals!.sweep(f.owner.accountId)).toBe(1);
    const reviewed = await owner('/jobs/'+job.id);expect(reviewed.json().status).toBe('review');
    expect((await owner('/runs/'+job.runId)).json().status).not.toBe('running');
    const retried = await f.ownerPost(`/jobs/${job.id}/retry`,{ reason: 'Propose the retained summary again' },String(reviewed.headers.etag));
    expect(retried.statusCode,retried.body).toBe(200);
    const reproposed = await owner('/jobs/'+job.id);
    expect(reproposed.json()).toMatchObject({ status: 'awaitingApproval',proposalDigest: submitted.proposalDigest });
    expect(reproposed.json().planId).not.toBe(first);
    expect((await owner('/runs/'+job.runId)).json().status).toBe('running');
    const approved = await f.ownerPost(`/jobs/${job.id}/decision`,{ decision: 'approve',proposalDigest: submitted.proposalDigest,reason: 'Approve the new plan' },String(reproposed.headers.etag));
    expect(approved.statusCode,approved.body).toBe(200);
    expect((await owner('/jobs/'+job.id)).json().status).toBe('succeeded');
    expect((await sql`SELECT id FROM automation_effect_receipts WHERE job_id=${job.id}`.execute(f.db)).rows).toHaveLength(1);
    expect((await sql`SELECT count(*)::int AS n FROM automation_job_attempts WHERE job_id=${job.id}`.execute(f.db)).rows).toEqual([{ n: 1 }]);
  });
  test('an Owner rejection is final; retry cannot propose a rejected output again',async () => {
    const { job,submitted,owner } = await awaitingApproval('aw31_rejected_final');
    const current = await owner('/jobs/'+job.id);
    const rejected = await f.ownerPost(`/jobs/${job.id}/decision`,{ decision: 'reject',proposalDigest: submitted.proposalDigest,reason: 'Not this summary' },String(current.headers.etag));
    expect(rejected.statusCode,rejected.body).toBe(200);
    const reviewed = await owner('/jobs/'+job.id);expect(reviewed.json().status).toBe('review');
    const retried = await f.ownerPost(`/jobs/${job.id}/retry`,{ reason: 'Try again' },String(reviewed.headers.etag));
    expect(retried.statusCode,retried.body).toBe(409);
  });
  test('expired leases stay uncertain until Owner retry and retain original pins, cost and generation fencing',async () => {
    await setup('aw31_retry',{ maxCalls: 2 });
    const job = (await read('/jobs')).json().items[0];
    const lease = (await post(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle })).json();
    await sql`UPDATE automation_job_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=${job.id}`.execute(f.db);
    expect((await read('/jobs')).json().items).toEqual([]);
    const current = await f.app.inject({ url: `/api/v1/me/automations/jobs/${job.id}`,headers: { cookie: f.owner.cookie } });
    expect(current.statusCode,current.body).toBe(200);expect(current.json().status).toBe('uncertain');
    const retried = await f.ownerPost(`/jobs/${job.id}/retry`,{ reason: 'Accept unknown cost and explicitly retry' },String(current.headers.etag));
    expect(retried.statusCode,retried.body).toBe(200);expect(retried.json().inputDigest).toBe(job.inputDigest);
    const next = await post(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle });
    expect(next.statusCode,next.body).toBe(200);expect(next.json().generation).toBe(lease.generation+1);
    expect((await post(`/jobs/${job.id}/heartbeat`,{ claimToken: lease.claimToken,generation: lease.generation,extendSeconds: 120 })).statusCode).toBe(409);
    const attempts = (await sql<{ outcome: string }>`SELECT outcome FROM automation_job_attempts WHERE job_id=${job.id} ORDER BY generation`.execute(f.db)).rows;
    expect(attempts.map(a => a.outcome)).toEqual(['unknownOutcome','leased']);
    expect((await sql<{ calls: number; unknown_cost_calls: number }>`SELECT calls,unknown_cost_calls FROM automation_usage_counters`.execute(f.db)).rows).toEqual([{ calls: 2,unknown_cost_calls: 2 }]);
  });
  test('current source edits and revoked credentials prevent reading or claiming previously listed jobs',async () => {
    await setup('aw31_stale');const job = (await read('/jobs')).json().items[0];
    await f.rename('fresh-paper','Owner changed title');
    expect((await read(`/jobs/${job.id}/inputs?deliveryHandle=${job.deliveryHandle}`)).statusCode).toBe(409);
    expect((await post(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle })).statusCode).toBe(409);
    expect((await read('/jobs')).json().items).toEqual([]);
    expect((await sql`SELECT * FROM automation_job_attempts`.execute(f.db)).rows).toEqual([]);
    await f.revokeWorker();expect((await read(`/jobs/${job.id}?deliveryHandle=${job.deliveryHandle}`)).statusCode).toBe(401);
  });
  test('all fifteen MCP tools dispatch real application operations and share worker state with HTTP',async () => {
    const { target,ruleInput } = await setup('aw31_mcp');
    const profile = (await f.app.inject({ url: `/api/v1/me/automations/connection-profiles/${target.configuration.connectionProfileId}`,headers: { cookie: f.owner.cookie } })).json();
    const updated = await f.app.inject({ method: 'PUT',url: `/api/v1/me/automations/connection-profiles/${profile.id}`,
      headers: f.ownerHeaders(randomUUID(),`"${profile.revision}"`),payload: { ...profile.configuration,catalogs: ['automationManager','automationWorker'] } });
    expect(updated.statusCode,updated.body).toBe(200);
    const currentTarget = await f.app.inject({ url: `/api/v1/me/automations/targets/${target.id}`,headers: { cookie: f.owner.cookie } });
    const grant = await f.ownerPost(`/targets/${target.id}/pairings`,{ reason: 'Pair combined MCP profile' },String(currentTarget.headers.etag));
    expect(grant.statusCode,grant.body).toBe(201);
    const verified = await f.verifier.verify({ authorization: 'Bearer '+await f.mint({ scopes: ['automation:work','automation:read','automation:manage'] }) });
    const context = createMcpApplicationContext({ principal: verified.binding,scopes: verified.scopes,abortSignal: new AbortController().signal,
      budgets: { maxDepth: 16,maxNodes: 1000,maxBytes: 100000,maxOperations: 100 },correlationId: randomUUID(),
      authorization: { accountSubjectId: verified.accountSubjectId,automationCredential: { credentialDigest: verified.credentialDigest,connectionId: verified.automationConnectionId,
        expiresAt: verified.expiresAt.toISOString(),issuedAtSeconds: verified.issuedAtSeconds,accountSecurityEpoch: verified.accountSecurityEpoch } } });
    const base: McpApplicationFacade = { listTools: async () => ({ tools: [] }),callTool: async () => { throw new Error('Unexpected standard tool'); },
      listResources: async () => ({ resources: [] }),listResourceTemplates: async () => ({ resourceTemplates: [] }),readResource: async () => ({ contents: [] }) };
    const api = withAutomationCatalog(base,createAutomationToolPort({ access: c => f.worker.access(automationWorkPrincipal(c)),
      configurations: f.uow,worker: f.work,pairing: f.worker,cursorKey: 'worker-test-cursor-at-least-32-bytes' }));
    const called = new Set<string>(),ajv = createAjv({ allErrors: true });
    const call = async (name: string,args: Record<string,unknown> = {}) => {
      called.add(name);const result = await api.callTool(context,name,args);expect(result.kind,JSON.stringify(result)).toBe('complete');
      const text = result.kind === 'complete' ? result.content.find(c => c.type === 'text') : undefined;
      if (!text || text.type !== 'text') throw new Error('Expected JSON tool content');
      const value = JSON.parse(text.text),descriptor = await api.getTool!(context,name);
      const valid = ajv.compile(descriptor!.outputSchema!);expect(valid(value),JSON.stringify(valid.errors)).toBe(true);
      expect(result.kind === 'complete' && result.structuredContent).toEqual(value);return value;
    };
    await call('automation.targets.pair',{ pairingId: grant.json().pairingId,code: grant.json().code });
    expect((await api.listTools(context)).tools).toHaveLength(15);
    const capabilities = await call('automation.rules.describe');
    expect(capabilities.runtimeProfiles).toEqual(['browser-bounded-v1']);
    expect(capabilities).toEqual((await f.app.inject({ url: '/api/v1/me/automations/capabilities',headers: { cookie: f.owner.cookie } })).json());
    expect((await call('automation.bindings.list')).items.length).toBeGreaterThan(0);
    expect((await call('automation.targets.list')).items[0].id).toBe(target.id);
    await call('automation.rules.validate',ruleInput);
    await call('automation.rules.preview',{ rule: ruleInput,mode: 'currentState' });
    const saved = await call('automation.rules.save',{ mode: 'create',rule: ruleInput,commandId: randomUUID() });
    await call('automation.rules.set_state',{ ruleId: saved.id,baseRevision: saved.revision,commandId: randomUUID(),change: { state: 'paused',pendingRuns: 'hold',reason: 'Keep additional rule inactive' } });
    const job = (await call('automation.jobs.list')).items[0];
    expect((await call('automation.jobs.get',{ jobId: job.id,deliveryHandle: job.deliveryHandle })).id).toBe(job.id);
    const inputs = await call('automation.jobs.inputs',{ jobId: job.id,deliveryHandle: job.deliveryHandle });
    const lease = await call('automation.jobs.claim',{ jobId: job.id,commandId: randomUUID(),request: { deliveryHandle: job.deliveryHandle } });
    await call('automation.jobs.heartbeat',{ jobId: job.id,commandId: randomUUID(),request: { claimToken: lease.claimToken,generation: lease.generation,extendSeconds: 120 } });
    const submitted = await call('automation.jobs.submit',{ jobId: job.id,commandId: randomUUID(),request: { claimToken: lease.claimToken,generation: lease.generation,
      inputDigest: lease.inputDigest,outputContract: job.task.outputContract,output: { kind: 'text',textType: 'summary',text: 'MCP summary',language: 'en',
        evidence: [{ kind: 'source',reference: inputs.items[0].sourceEventId,observedAt: new Date().toISOString() }] } } });
    expect(submitted.status).toBe('succeeded');expect((await read('/jobs')).json().items).toEqual([]);
    await f.createNode('second-paper','root','Second paper','https://arxiv.org/abs/second');await f.inspect();
    const second = (await read('/jobs')).json().items[0],secondLease = (await post(`/jobs/${second.id}/claim`,{ deliveryHandle: second.deliveryHandle })).json();
    await call('automation.jobs.fail',{ jobId: second.id,commandId: randomUUID(),request: { claimToken: secondLease.claimToken,generation: secondLease.generation,kind: 'unknownOutcome',code: 'provider_timeout',message: 'Unknown provider outcome' } });
    expect((await read(`/jobs/${second.id}?deliveryHandle=${second.deliveryHandle}`)).json().status).toBe('uncertain');
    expect(called.size).toBe(15);
    await f.revokeWorker();expect((await api.listTools(context)).tools).toEqual([]);
    expect(await api.callTool(context,'automation.jobs.list',{})).toMatchObject({ stableCode: 'unknown_tool' });
  });

  test('permanent failure settles the run and blocks dependent jobs without stranding independent work',async () => {
    await setup('be3_failure',{ three: true,configure: d => { d.tasks[2]!.after=['refine']; } });
    const first = (await read('/jobs')).json().items[0];
    const lease = (await post(`/jobs/${first.id}/claim`,{ deliveryHandle: first.deliveryHandle })).json();
    const failure = await post(`/jobs/${first.id}/failures`,{ claimToken: lease.claimToken,generation: lease.generation,kind: 'permanent',code: 'unsupported',message: 'Cannot classify' });
    expect(failure.statusCode,failure.body).toBe(200);
    const independent = (await read('/jobs')).json().items[0];expect(independent.task.id).toBe('tags');
    const secondLease = (await post(`/jobs/${independent.id}/claim`,{ deliveryHandle: independent.deliveryHandle })).json();
    expect((await post(`/jobs/${independent.id}/failures`,{ claimToken: secondLease.claimToken,generation: secondLease.generation,kind: 'permanent',code: 'unsupported',message: 'Cannot tag' })).statusCode).toBe(200);
    expect((await sql<{ state: string }>`SELECT state FROM automation_runs WHERE id=${first.runId}`.execute(f.db)).rows[0]!.state).toBe('blocked');
    expect((await sql<{ state: string }>`SELECT state FROM automation_jobs WHERE run_id=${first.runId} AND task_id='summary'`.execute(f.db)).rows[0]!.state).toBe('blocked');
  });
  test('a blocked optional input does not starve independent pending jobs',async () => {
    await setup('be3_missing',{ three: true,configure: (d,p) => {
      d.tasks[0]!.inputFields=['readableText'];p.assignments[0]!.allowedData.push('readableText');d.tasks[2]!.after=[];
    } });
    const ready = (await sql<{ task_id: string }>`SELECT task_id FROM automation_jobs WHERE state='ready'`.execute(f.db)).rows;
    expect(ready).toEqual([{ task_id: 'tags' }]);
    const queue = await read('/jobs');expect(queue.statusCode,queue.body).toBe(200);
    expect(queue.json().items.map((j: { task: { id: string } }) => j.task.id)).toEqual(['tags']);
  });
  test('failed deterministic intake cannot satisfy a root classification merely from its admission plan',async () => {
    const { createAutomationAdmission } = await import('../../../src/infrastructure/automation/aggregate-store.js');
    const { createAutomationRuntime } = await import('../../../src/infrastructure/automation/runtime.js');
    const { inspectAutomationOutbox } = await import('../../support/automation-runtime-fixture.js');
    await setup('be3_intake_evidence',{ configure: d => {
      d.tasks[0]!.type='classify.root';d.tasks[0]!.outputContract='placement.subtree.v1';d.tasks[0]!.folderRole='academicRoot';
    },inspect: fixture => inspectAutomationOutbox(fixture.db,async (tx,actor,collection,sources) => {
      await createAutomationAdmission('server',true)(tx,actor,collection,sources);
      // Inject loss of the destination after admission, before the canonical intake executor.
      await tx.updateTable('nodes').set({ deleted_at: new Date() }).where('id','=','academic').execute();
      await createAutomationRuntime('server',true)(tx,actor,collection,[]);
    }) });
    const jobs = (await sql<{ state: string }>`SELECT state FROM automation_jobs`.execute(f.db)).rows;
    expect(jobs).toEqual([{ state: 'blocked' }]);
    expect((await sql`SELECT * FROM automation_effect_receipts`.execute(f.db)).rows).toEqual([]);
  });
  test('a note created after an absent-note input was pinned invalidates the old claim',async () => {
    await setup('be3_note',{ configure: (d,p) => { d.tasks[0]!.inputFields.push('note');p.assignments.find(a => a.taskType==='summary.generate')!.allowedData.push('note'); } });
    const job = (await read('/jobs')).json().items[0];
    const { createPostgresAnnotationMutationUnitOfWork } = await import('../../../src/infrastructure/collections/index.js');
    const { createAnnotation } = await import('../../../src/modules/collections/index.js');
    await createPostgresAnnotationMutationUnitOfWork(f.db).execute(p => createAnnotation(p,{ actor: { principalId: f.owner.accountId,subjectId: f.owner.subjectId,principalType: 'account',creator: { id: 'urn:colp:owner',name: 'Owner' } },
      command: f.command(),collectionId: 'collection',annotationId: 'new-note',annotation: { type: 'note',subject: { type: 'node',id: 'fresh-paper' },format: 'plain',value: 'New owner context',visibility: 'private' } }));
    const claim = await post(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle });
    expect(claim.statusCode,claim.body).toBe(409);
    expect((await sql`SELECT * FROM automation_job_attempts`.execute(f.db)).rows).toEqual([]);
  });

  test('held, waiting and unavailable-collection backlog cannot starve a later actionable run',async () => {
    const { createAutomationAdmission } = await import('../../../src/infrastructure/automation/aggregate-store.js');
    const { executePendingIntake } = await import('../../../src/infrastructure/automation/intake-executor.js');
    const { inspectAutomationOutbox } = await import('../../support/automation-runtime-fixture.js');
    await setup('be3_queue',{ inspect: fixture => inspectAutomationOutbox(fixture.db,async (tx,actor,collection,sources) => {
      await createAutomationAdmission('server',true)(tx,actor,collection,sources);
      await executePendingIntake(tx,actor,collection,'server');
    }) });
    const run = (await sql<{ id: string }>`SELECT id FROM automation_runs`.execute(f.db)).rows[0]!;
    // Persist ineligible backlog using real admitted pins. Waiting runs still need intake admission.
    await sql`INSERT INTO automation_runs(id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state,held,explanation_json)
      SELECT '--held-run-'||n,r.owner_id,r.kind,r.rule_revision_id,r.binding_set_id,r.binding_revision,r.policy_revision,r.member_ids,
        CASE WHEN n>101 THEN 'waiting' ELSE 'running' END,n<=50,
        CASE WHEN n BETWEEN 51 AND 101 THEN r.explanation_json||'{"collectionId":"unavailable-collection"}'::jsonb ELSE r.explanation_json END
      FROM automation_runs r CROSS JOIN generate_series(1,202) n WHERE r.id=${run.id}`.execute(f.db);
    await sql`INSERT INTO automation_jobs(id,run_id,task_id,target_id,target_partition,input_digest,contract_id,state,task_json,execution_context_json)
      SELECT '--held-job-'||n,'--held-run-'||n,j.task_id,j.target_id,j.target_partition,j.input_digest,j.contract_id,'pending',j.task_json,j.execution_context_json
      FROM automation_jobs j CROSS JOIN generate_series(1,202) n WHERE j.run_id=${run.id}`.execute(f.db);
    const queue = await read('/jobs');expect(queue.statusCode,queue.body).toBe(200);
    expect(queue.json().items).toHaveLength(1);expect(queue.json().items[0].runId).toBe(run.id);
    expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM automation_jobs WHERE id LIKE '--held-job-%' AND state='pending'`.execute(f.db)).rows[0]!.count).toBe(202);
  });

  test('replacing a worker rule without an execution policy clears the previous grant',async () => {
    const { rule,ruleInput } = await setup('be3_clear_policy');
    const current = await f.app.inject({ url: `/api/v1/me/automations/rules/${rule.id}`,headers: { cookie: f.owner.cookie } });
    const updated = await f.app.inject({ method: 'PUT',url: `/api/v1/me/automations/rules/${rule.id}`,headers: f.ownerHeaders(randomUUID(),String(current.headers.etag)),
      payload: { definition: ruleInput.definition,bindingSetId: ruleInput.bindingSetId,pendingRuns: 'hold',counterPolicy: 'resetOnSemanticChange' } });
    expect(updated.statusCode,updated.body).toBe(200);expect(updated.json().executionPolicyId).toBeUndefined();
    const stored = await f.app.inject({ url: `/api/v1/me/automations/rules/${rule.id}`,headers: { cookie: f.owner.cookie } });
    expect(stored.json().executionPolicyId).toBeUndefined();
  });
  test('empty sourced tags is an accepted no-op and can satisfy a declared typed predecessor',async () => {
    await setup('be3_empty_tags',{ three: true });
    for (const taskId of ['refine','tags']) {
      const queue = await read('/jobs');expect(queue.statusCode,queue.body).toBe(200);
      const job = queue.json().items[0];expect(job.task.id).toBe(taskId);
      const inputs = (await read(`/jobs/${job.id}/inputs?deliveryHandle=${job.deliveryHandle}`)).json();
      const lease = (await post(`/jobs/${job.id}/claim`,{ deliveryHandle: job.deliveryHandle })).json();
      const output = taskId === 'refine' ? { kind: 'placement',decision: 'keepParent',reason: 'No refinement needed',evidence: [{ kind: 'source',reference: inputs.items[0].sourceEventId,observedAt: new Date().toISOString() }] }
        : { kind: 'tags',mergeMode: 'unionPreserveUser',add: [] };
      const submitted = await post(`/jobs/${job.id}/results`,{ claimToken: lease.claimToken,generation: lease.generation,inputDigest: lease.inputDigest,outputContract: job.task.outputContract,output });
      expect(submitted.statusCode,submitted.body).toBe(200);expect(submitted.json()).toMatchObject({ status: 'succeeded',effectReceiptIds: [] });
    }
    const summary = (await read('/jobs')).json().items[0];expect(summary.task.id).toBe('summary');
    const inputs = (await read(`/jobs/${summary.id}/inputs?deliveryHandle=${summary.deliveryHandle}`)).json();
    expect(inputs.items[0].acceptedPredecessors[0]).toMatchObject({ taskId: 'tags',output: { kind: 'tags',add: [] } });
    expect(await f.db.selectFrom('mcp_change_plans').select('plan_id').execute()).toEqual([]);
  });

});
