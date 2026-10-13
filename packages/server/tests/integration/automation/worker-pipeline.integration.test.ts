import { afterEach,expect,test } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createAjv } from '@know-n/colp/schema';
import { validateAutomation,type RuleDefinition } from '@know-n/colp/automation';
import { automationWorkerFixture } from '../../support/automation-worker-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationWorkPrincipal,createMcpApplicationContext,createAutomationToolPort,withAutomationCatalog,type McpApplicationFacade } from '../../../src/modules/mcp/index.js';
import { writeAgentPolicy } from '../../../src/infrastructure/collections/index.js';

describeWithPostgres('AW-31 authenticated polling and typed canonical orchestration',() => {
  let f: Awaited<ReturnType<typeof automationWorkerFixture>>;
  afterEach(async () => { await f?.close(); });
  const read = (path: string,token = f.token) => f.app.inject({ url: '/api/v1/automation-work'+path,headers: { authorization: 'Bearer '+token } });
  const post = (path: string,payload: unknown,command = randomUUID()) => f.app.inject({ method: 'POST',url: '/api/v1/automation-work'+path,
    headers: { authorization: 'Bearer '+f.token,'known-command-id': command },payload });
  async function setup(prefix: string,three = false,policyEnabled = true,maxCalls = 1) {
    f = await automationWorkerFixture(prefix,100,true,true);const setup = await f.setup();expect((await f.pair(setup.grant)).statusCode).toBe(200);
    const executors = await f.app.inject({ url: '/api/v1/me/automations/executors',headers: { cookie: f.owner.cookie } });
    expect(executors.statusCode,executors.body).toBe(200);const executor = executors.json().items[0];
    const bindings = await f.ownerPost('/binding-sets',{ name: 'Pinned enrichment bindings',values: { ...f.values,researchEnricher: { kind: 'executor',executorId: executor.id } } });
    expect(bindings.statusCode,bindings.body).toBe(201);
    const policy = JSON.parse(readFileSync('../../docs/automation/design/examples/execution-policy.json','utf8'));
    policy.allowAutomaticWrites=true;for (const assignment of policy.assignments) { assignment.allowedDestinations=[executor.id];assignment.maxCalls=maxCalls; }
    const savedPolicy = policyEnabled ? await f.ownerPost('/execution-policies',policy) : null;
    if (savedPolicy) expect(savedPolicy.statusCode,savedPolicy.body).toBe(201);
    const definition = JSON.parse(readFileSync(`../../docs/automation/design/examples/${three ? 'academic-intake' : 'academic-summary-only'}.json`,'utf8')) as RuleDefinition;
    definition.scope.collectionId='collection';definition.route.targetIds=[setup.target.id];
    if (three) definition.tasks[2]!.after=['tags'];
    const ruleInput = { definition,bindingSetId: bindings.json().id,...(savedPolicy ? { executionPolicyId: savedPolicy.json().id } : {}) };
    const rule = await f.ownerPost('/rules',ruleInput);expect(rule.statusCode,rule.body).toBe(201);
    const preview = await f.ownerPost('/rules/preview',{ rule: ruleInput,mode: 'currentState' });expect(preview.statusCode,preview.body).toBe(200);
    const enabled = await f.ownerPost(`/rules/${rule.json().id}/lifecycle`,{ state: 'enabled',pendingRuns: 'hold',reason: 'Enable exact preview',activationPreviewId: preview.json().previewId },String(rule.headers.etag));
    expect(enabled.statusCode,enabled.body).toBe(200);
    await writeAgentPolicy(f.db,f.owner.accountId,f.actor.clientId,'trusted');
    await f.createNode('fresh-paper','root','New paper','https://arxiv.org/abs/new');await f.inspect();
    return { target: setup.target,rule: rule.json(),ruleInput };
  }
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
    await setup('aw31_three',true);await f.createNode('topic','academic','Topic');
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
    await setup('aw31_no_policy',false,false);
    const node = await f.db.selectFrom('nodes').select('parent_id').where('id','=','fresh-paper').executeTakeFirstOrThrow();expect(node.parent_id).toBe('academic');
    expect((await read('/jobs')).json().items).toEqual([]);
    expect((await sql<{ state: string }>`SELECT state FROM automation_jobs`.execute(f.db)).rows).toEqual([{ state: 'blocked' }]);
    expect((await sql`SELECT * FROM automation_job_attempts`.execute(f.db)).rows).toEqual([]);
    expect(await f.db.selectFrom('mcp_change_plans').select('plan_id').execute()).toEqual([]);
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
    const accepted = await post(`/jobs/${job.id}/results`,body);expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json().status).toBe('succeeded');
    expect(await f.db.selectFrom('mcp_change_plans').select('plan_id').execute()).toHaveLength(1);
  });
  test('expired leases stay uncertain until Owner retry and retain original pins, cost and generation fencing',async () => {
    await setup('aw31_retry',false,true,2);
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
      authorization: { accountSubjectId: verified.accountSubjectId,automationCredential: { credentialDigest: verified.credentialDigest,
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

});
