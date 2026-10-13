import { afterEach, expect, test } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import Fastify from 'fastify';
import type { LocalReceiptInput, Job } from '@know-n/colp/automation';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { automationDeviceFixture, AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { registerAutomationDeviceRoutes } from '../../../src/transport/automation-device-routes.js';
import { placementInputDigest, placementResultDigest } from '../../../src/modules/automation/index.js';
import { installProductAdmission } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';

// JavaScript example is imported as an actual consumer; it has no server/package dependencies.
// @ts-expect-error host-neutral reference is deliberately a standalone .mjs module
import { createWorkerTransport, createFileJournal, runPollingCycle, WorkerHttpError } from '../../../../../examples/worker-script/claim-and-summarize.mjs';
// @ts-expect-error injected reference adapter is JavaScript, not a test-only production executor
import * as summaryAdapter from '../../../../../examples/worker-script/deterministic-summary.mjs';

interface Message { type: string; address?: string; phase?: string; results?: Array<{ status: string; jobId?: string }> }
interface Child {
  process: ChildProcess; messages: Message[]; exited: Promise<unknown>;
  wait(type: string): Promise<Message>;
}

describeWithPostgres('AW-64 authenticated loopback polling and process recovery gate', () => {
  let f: Awaited<ReturnType<typeof automationPollingFixture>>;
  const children: Child[] = [];
  let directory: string;
  let receiptApp: ReturnType<typeof Fastify> | undefined;
  let receiptFixture: Awaited<ReturnType<typeof automationDeviceFixture>> | undefined;
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
      await child.exited;
    }
    await receiptApp?.close(); receiptApp=undefined;
    await receiptFixture?.isolated.close(); receiptFixture=undefined;
    await f?.close();
    if (directory) await rm(directory,{ recursive: true,force: true });
  });
  async function setup(prefix: string, options: Parameters<typeof automationPollingFixture>[1] = {}) {
    directory = await mkdtemp(join(tmpdir(),'aw64-poll-'));
    f = await automationPollingFixture(prefix,options);
  }
  function spawnSupport(name: string): Child {
    const processHandle = fork(fileURLToPath(new URL('../../support/'+name,import.meta.url)),[],{
      serialization: 'advanced',execArgv: name.endsWith('.ts') ? ['--import','tsx'] : [],stdio: ['ignore','ignore','pipe','ipc'],
    });
    // Drain stderr without exposing credentials/private bodies in assertion output.
    processHandle.stderr?.resume();
    const messages: Message[] = [];
    processHandle.on('message',message => messages.push(message as Message));
    const exited = new Promise(resolve => processHandle.once('exit',(code,signal) => resolve({ code,signal })));
    const child: Child = { process: processHandle,messages,exited,wait(type) {
      const existing = messages.find(message => message.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => finish(new Error('Timed out waiting for '+type)),30_000);
        const onMessage = (message: unknown) => { const value = message as Message; if (value.type === type) finish(undefined,value); else if (value.type === 'failure' || value.type === 'failed') finish(new Error('Test child failed before '+type)); };
        const onExit = () => finish(new Error('Test child exited before '+type));
        const onError = () => finish(new Error('Test child could not start'));
        function finish(error?: Error,value?: Message) {
          clearTimeout(timer); processHandle.off('message',onMessage); processHandle.off('exit',onExit); processHandle.off('error',onError);
          if (error) reject(error); else resolve(value!);
        }
        processHandle.on('message',onMessage); processHandle.on('exit',onExit); processHandle.on('error',onError);
      });
    } };
    children.push(child); return child;
  }
  async function host(crash?: 'before' | 'after') {
    const child = spawnSupport('automation-polling-server.ts');
    child.process.send!({ databaseUrl: f.isolated.databaseUrl,config: f.config,jwk: f.publicJwk,origin: 'https://automation.example.test',crash });
    return { child,origin: (await child.wait('listening')).address! };
  }
  function reference(origin: string, options: { three?: boolean; interruptProvider?: boolean } = {}) {
    const child = spawnSupport('automation-reference-worker.mjs');
    child.process.send!({ origin,token: f.token,targetId: f.target.id,journalPath: join(directory,'journal.json'),...options });
    return child;
  }
  const transport = (origin: string, token = f.token) => createWorkerTransport({ baseUrl: origin,accessToken: async () => token });
  const queue = (request: (method: string,path: string) => Promise<{ items: Job[] }>) => request('GET','/jobs?targetId='+f.target.id);
  const ownerRead = (path: string) => f.app.inject({ url: '/api/v1/me/automations'+path,headers: { cookie: f.owner.cookie } });
  async function ledger() {
    return {
      jobs: (await sql<{ id: string; run_id: string; task_id: string; state: string; input_digest: string; generation: number }>`SELECT id,run_id,task_id,state,input_digest,active_generation::int AS generation FROM automation_jobs ORDER BY id`.execute(f.db)).rows,
      plans: await f.db.selectFrom('mcp_change_plans').select(['plan_id','status']).orderBy('plan_id').execute(),
      effects: (await sql<{ id: string; job_id: string | null; operation_id: string; plan_id: string | null; version_id: string | null }>`SELECT id,job_id,operation_id,plan_id,version_id FROM automation_effect_receipts ORDER BY id`.execute(f.db)).rows,
      notes: await f.db.selectFrom('annotations').select(['id','payload_json']).where('subject_id','=','fresh-paper').where('deleted_at','is',null).execute(),
    };
  }

  test('M1 canonical device receipt joins real Sync once without claiming optional worker success', async () => {
    const device = receiptFixture = await automationDeviceFixture('aw64_receipt');
    receiptApp=Fastify({ exposeHeadRoutes: false }); installProductAdmission(receiptApp);
    receiptApp.setErrorHandler((error,request,reply) => sendProductError(request,reply,error instanceof ProductHttpError ? error
      : new ProductHttpError({ statusCode: 500,code: 'internal_error',message: 'Device fixture failed.' })));
    registerAutomationDeviceRoutes(receiptApp,{ unitOfWork: createAutomationDeviceUnitOfWork(device.db,'server'),credentialVerifier: device.http.verifier,
      allowedOrigins: [AUTOMATION_DEVICE_ORIGIN],allowInsecureLoopback: true });
    const receiptOrigin = await receiptApp.listen({ host: '127.0.0.1',port: 0 });
    const receipt = { deviceId: device.replica.deviceId,replicaGeneration: Number(device.replica.leaseGeneration),localReceiptId: randomUUID(),
      operationId: 'aw64-device-create',ruleId: device.rule.id,ruleRevision: '1',bindingRevision: '1',bundleRevision: '1',
      committedNode: { serverUuid: 'server',collectionId: 'collection',nodeId: 'fresh-paper' },
      satisfiedTaskTypes: ['classify.root' as const],resultDigests: [placementResultDigest(device.folder)] };
    const body: LocalReceiptInput = { ...receipt,inputDigest: placementInputDigest(receipt,{ url: 'https://arxiv.org/sync',title: 'Sync paper',tags: [] }) };
    const commandId = randomUUID();
    const postReceipt = () => fetch(receiptOrigin+'/api/v1/automation-device/intake-receipts',{ method: 'POST',headers: {
      authorization: device.http.authorization,origin: AUTOMATION_DEVICE_ORIGIN,'known-sync-session': device.sessionId,
      'known-command-id': commandId,'content-type': 'application/json',
    },body: JSON.stringify(body) });
    const waiting = await postReceipt(); expect(waiting.status).toBe(202); expect((await waiting.json()).state).toBe('waitingForSync');
    await device.syncCreate('fresh-paper','aw64-device-create'); await device.inspect();
    // A new command observes current receipt state; exact replay preserves its original waiting response.
    const accepted = await fetch(receiptOrigin+'/api/v1/automation-device/intake-receipts',{ method: 'POST',headers: {
      authorization: device.http.authorization,origin: AUTOMATION_DEVICE_ORIGIN,'known-sync-session': device.sessionId,
      'known-command-id': randomUUID(),'content-type': 'application/json',
    },body: JSON.stringify(body) });
    expect(accepted.status).toBe(202); expect((await accepted.json()).state).toBe('accepted');
    await device.inspect(); await device.inspect();
    expect((await sql`SELECT id FROM automation_runs`.execute(device.db)).rows).toHaveLength(1);
    expect((await sql`SELECT id FROM automation_jobs`.execute(device.db)).rows).toEqual([]);
    expect((await sql`SELECT plan_id FROM mcp_change_plans`.execute(device.db)).rows).toEqual([]);
    const replay = await postReceipt(); expect((await replay.json()).state).toBe('waitingForSync');
  });

  test('one-job server intake and real reference worker commit exactly one sourced summary', async () => {
    let origin = '';
    await setup('aw64_one',{ pair: async (fixture,grant) => {
      origin = await fixture.app.listen({ host: '127.0.0.1',port: 0 });
      const request = transport(origin,fixture.token);
      await expect(request('GET','/jobs?targetId='+grant.targetId)).rejects.toMatchObject({ status: 404 });
      expect(await runPollingCycle({ request,targetId: grant.targetId,adapter: summaryAdapter,journal: createFileJournal(join(directory,'journal.json')),
        pairing: { pairingId: grant.pairingId,code: grant.code,commandId: randomUUID() } })).toEqual([]);
    } });
    const request = transport(origin), first = await queue(request), second = await queue(request);
    expect(first.items).toHaveLength(1); expect(second.items.map(job => job.id)).toEqual(first.items.map(job => job.id));
    const worker = reference(origin); expect((await worker.wait('completed')).results).toMatchObject([{ status: 'succeeded' }]); await worker.exited;
    expect(worker.messages.filter(message => message.type === 'provider-called')).toHaveLength(1);
    await f.inspect(); await f.inspect();
    const state = await ledger(); expect(state.jobs).toHaveLength(1); expect(state.jobs[0]).toMatchObject({ state: 'succeeded',generation: 1 });
    expect(state.plans).toHaveLength(1); expect(state.plans[0]!.status).toBe('consumed'); expect(state.notes).toHaveLength(1);
    expect(state.notes[0]!.payload_json.value).toContain('Deterministic reference-worker fixture.');
    expect(state.effects.filter(effect => effect.job_id)).toHaveLength(1);
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toHaveLength(1);
    expect((await queue(request)).items).toEqual([]);
    const run = await ownerRead('/runs/'+first.items[0]!.runId); expect(run.statusCode,run.body).toBe(200);
    expect(run.json()).toMatchObject({ status: 'completed',jobIds: [first.items[0]!.id],usage: { succeededJobs: 1,optionalCalls: 1,externalCosts: 'unknownDisclosed' } });
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id','=','fresh-paper').executeTakeFirstOrThrow()).parent_id).toBe('academic');
  });

  test('three-task fixture pins typed predecessors and has exactly one canonical plan/version/effect per step', async () => {
    await setup('aw64_three',{ three: true }); await f.createNode('topic','academic','Live child');
    const origin = await f.app.listen({ host: '127.0.0.1',port: 0 }); const request = transport(origin);
    const tasks: string[] = [];
    for (let step=0;step<3;step++) {
      const page = await queue(request); expect(page.items).toHaveLength(1); const job = page.items[0]!; tasks.push(job.task.type);
      if (step===2) {
        const inputs = await request('GET',`/jobs/${job.id}/inputs?deliveryHandle=${job.deliveryHandle}`);
        expect(inputs.items[0].acceptedPredecessors).toMatchObject([{ taskId: 'tags',output: { kind: 'tags',add: [{ key: 'research' }] } }]);
      }
      const worker = reference(origin,{ three: true }); expect((await worker.wait('completed')).results).toMatchObject([{ status: 'succeeded' }]); await worker.exited;
      // Reconnect/reconciliation cannot repeat this step or recreate its accepted effect.
      await queue(request); await f.inspect();
    }
    expect(tasks).toEqual(['classify.refine','tags.generate','summary.generate']);
    const state = await ledger(); expect(state.jobs).toHaveLength(3); expect(state.jobs.every(job => job.state==='succeeded' && job.generation===1)).toBe(true);
    expect(state.plans).toHaveLength(3); expect(new Set(state.plans.map(plan => plan.plan_id)).size).toBe(3);
    const effects = state.effects.filter(effect => effect.job_id); expect(effects).toHaveLength(3); expect(effects.every(effect => effect.version_id && effect.plan_id)).toBe(true);
    for (const effect of effects) {
      const operation = await f.db.selectFrom('operations').select(['operation_id','commit_ordinal']).where('operation_id','=',effect.operation_id).executeTakeFirstOrThrow();
      expect(operation.commit_ordinal).toBeTruthy();
      const version = await f.db.selectFrom('collection_tree_versions').select('version_id').where('version_id','=',effect.version_id!).executeTakeFirstOrThrow();
      expect(version.version_id).toBe(effect.version_id);
      const job = state.jobs.find(job => job.id===effect.job_id)!;
      const resourceId = job.task_id==='summary' ? 'automation-note-'+job.id : 'fresh-paper';
      expect(await f.db.selectFrom('resource_revisions').select('revision').where('collection_id','=','collection')
        .where('resource_id','=',resourceId).where('ordinal','=',operation.commit_ordinal!).execute()).toHaveLength(1);
      if (job.task_id!=='summary') {
        const facts = (await sql<{ origin: string; root_run_id: string; facts_json: { stageId: string } }>`SELECT origin,root_run_id,facts_json
          FROM automation_event_facts WHERE operation_id=${effect.operation_id}`.execute(f.db)).rows;
        expect(facts).toMatchObject([{ origin: 'automation',root_run_id: job.run_id,facts_json: { stageId: job.id } }]);
      }
      expect((await sql`SELECT version_id FROM mcp_plan_policy_receipts WHERE plan_id=${effect.plan_id}`.execute(f.db)).rows).toHaveLength(1);
      expect((await sql`SELECT plan_id FROM mcp_plan_commit_revisions WHERE plan_id=${effect.plan_id}`.execute(f.db)).rows).toHaveLength(1);
    }
    const node = await f.db.selectFrom('nodes').select(['parent_id','payload_json']).where('id','=','fresh-paper').executeTakeFirstOrThrow();
    expect(node.parent_id).toBe('topic'); expect(node.payload_json?.tags).toEqual(['research']); expect(state.notes).toHaveLength(1);
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toHaveLength(1); expect((await queue(request)).items).toEqual([]);
    const run = await ownerRead('/runs/'+state.jobs[0]!.run_id);
    const refine = effects.find(effect => effect.job_id===state.jobs.find(job => job.task_id==='refine')!.id)!;
    const undo = run.json().effects.find((effect: { id: string }) => effect.id===refine.id);
    expect(undo.undoAvailable).toBe(false);
    const refused = await f.ownerPost(`/runs/${state.jobs[0]!.run_id}/undo`,{ effectReceiptId: undo.id,expectedEffectDigest: undo.effectDigest,reason: 'Later task effects must be preserved' },String(run.headers.etag));
    expect(refused.statusCode,refused.body).toBe(409); expect((await ledger()).effects).toEqual(state.effects);
  });

  test.each(['before','after'] as const)('SIGKILL backend %s canonical commit, then restart backend and worker resumes the same durable submission/plan', async phase => {
    await setup('aw64_crash_'+phase); const server = await host(phase);
    const worker = reference(server.origin), crashed = server.child.wait('crash-window');
    expect((await crashed).phase).toBe(phase);
    const pending = JSON.parse(await readFile(join(directory,'journal.json'),'utf8')); expect(pending.phase).toBe('results');
    expect(pending.body.inputDigest).toBe((await ledger()).jobs[0]!.input_digest);
    server.child.process.kill('SIGKILL'); expect(await server.child.exited).toMatchObject({ signal: 'SIGKILL' });
    await worker.exited;
    const interrupted = await ledger(); expect(interrupted.plans).toHaveLength(1);
    expect(interrupted.notes).toHaveLength(phase==='after' ? 1 : 0);
    expect(interrupted.effects.filter(effect => effect.job_id)).toEqual([]);
    const restarted = await host(), replacement = reference(restarted.origin);
    expect((await replacement.wait('completed')).results).toMatchObject([{ status: 'succeeded' }]); await replacement.exited;
    expect(replacement.messages.filter(message => message.type==='provider-called')).toEqual([]);
    const recovered = await ledger(); expect(recovered.plans.map(plan => plan.plan_id)).toEqual(interrupted.plans.map(plan => plan.plan_id));
    expect(recovered.notes).toHaveLength(1); expect(recovered.effects.filter(effect => effect.job_id)).toHaveLength(1);
    const effect = recovered.effects.find(effect => effect.job_id)!; expect(effect.version_id).toBeTruthy();
    const request = transport(restarted.origin);
    const repeated = await request('POST',`/jobs/${pending.jobId}/results`,pending.body,pending.commandId);
    const distinctCommand = await request('POST',`/jobs/${pending.jobId}/results`,pending.body,randomUUID());
    expect(distinctCommand).toEqual(repeated);
    expect((await ledger()).effects).toEqual(recovered.effects);
    expect((await sql`SELECT generation FROM automation_job_attempts`.execute(f.db)).rows).toHaveLength(1);
    await f.inspect(); expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toHaveLength(1);
  },90_000);

  test('SIGKILL provider worker preserves uncertainty; explicit Owner retry retains original pins and unknown cost', async () => {
    await setup('aw64_uncertain',{ maxCalls: 2 }); const origin = await f.app.listen({ host: '127.0.0.1',port: 0 });
    const worker = reference(origin,{ interruptProvider: true }); await worker.wait('provider-called');
    worker.process.kill('SIGKILL'); await worker.exited;
    const pins = (await ledger()).jobs[0]!, replacement = reference(origin);
    expect((await replacement.wait('completed')).results).toMatchObject([{ status: 'completed' }]); await replacement.exited;
    expect(replacement.messages.filter(message => message.type==='provider-called')).toEqual([]);
    expect((await ledger()).jobs[0]).toMatchObject({ state: 'uncertain',input_digest: pins.input_digest,generation: 1 });
    const current = await ownerRead('/jobs/'+pins.id);
    const retry = await f.ownerPost(`/jobs/${pins.id}/retry`,{ reason: 'Explicitly accept unknown earlier cost' },String(current.headers.etag));
    expect(retry.statusCode,retry.body).toBe(200); expect(retry.json().inputDigest).toBe(pins.input_digest);
    const completed = reference(origin); expect((await completed.wait('completed')).results).toMatchObject([{ status: 'succeeded' }]); await completed.exited;
    const state = await ledger(); expect(state.jobs[0]).toMatchObject({ state: 'succeeded',input_digest: pins.input_digest,generation: 2 });
    expect(state.plans).toHaveLength(1); expect(state.notes).toHaveLength(1);
    expect((await ownerRead('/rules/'+f.rule.id)).json().usage).toMatchObject({ optionalCalls: 2,unknownCostCalls: 2,reservedRuns: 1 });
  });

  test('reference worker reconciles Manual approval without another provider call; claim/heartbeat replay and revocation stay fenced', async () => {
    await setup('aw64_manual',{ trusted: false }); const origin = await f.app.listen({ host: '127.0.0.1',port: 0 }); const request = transport(origin);
    const job = (await queue(request)).items[0]!;
    let firstSubmitCommand = '';
    const auditedRequest = async (method: string,path: string,body?: unknown,command?: string) => {
      const value = await request(method,path,body,command);
      if (path.endsWith('/claim')) {
        await expect(request(method,path,body,command)).rejects.toMatchObject({ status: 409 });
        await expect(request(method,path,body,randomUUID())).rejects.toMatchObject({ status: 409 });
        const heartbeatCommand = randomUUID(), proof = { claimToken: value.claimToken,generation: value.generation,extendSeconds: 120 };
        const heartbeat = await request('POST',`/jobs/${job.id}/heartbeat`,proof,heartbeatCommand);
        expect(heartbeat).toMatchObject({ generation: value.generation,inputDigest: value.inputDigest });
        expect(await request('POST',`/jobs/${job.id}/heartbeat`,proof,heartbeatCommand)).toEqual(heartbeat);
        await expect(request('POST',`/jobs/${job.id}/heartbeat`,{ ...proof,generation: value.generation+1 },randomUUID())).rejects.toMatchObject({ status: 409 });
      }
      if (path.endsWith('/results')) firstSubmitCommand=command!;
      return value;
    };
    const result = await runPollingCycle({ request: auditedRequest,targetId: f.target.id,adapter: summaryAdapter,journal: createFileJournal(join(directory,'journal.json')) });
    expect(result).toMatchObject([{ status: 'awaitingApproval' }]); expect((await ledger()).notes).toEqual([]);
    const pending = JSON.parse(await readFile(join(directory,'journal.json'),'utf8'));
    expect(pending.commandId).not.toBe(firstSubmitCommand);
    expect(await request('POST',`/jobs/${job.id}/results`,pending.body,firstSubmitCommand)).toEqual(result[0]);
    const current = await ownerRead('/jobs/'+job.id);
    const approved = await f.ownerPost(`/jobs/${job.id}/decision`,{ decision: 'approve',proposalDigest: result[0].proposalDigest,reason: 'Approve the exact existing plan' },String(current.headers.etag));
    expect(approved.statusCode,approved.body).toBe(200);
    const resumed = reference(origin); expect((await resumed.wait('completed')).results).toMatchObject([{ status: 'succeeded' }]); await resumed.exited;
    expect(resumed.messages.filter(message => message.type==='provider-called')).toEqual([]);
    const state = await ledger(); expect(state.plans).toHaveLength(1); expect(state.notes).toHaveLength(1);
    expect(state.effects.filter(effect => effect.job_id)).toHaveLength(1);
    await f.revokeWorker();
    await expect(queue(request)).rejects.toBeInstanceOf(WorkerHttpError);
    await expect(request('POST',`/jobs/${job.id}/results`,pending.body,randomUUID())).rejects.toMatchObject({ status: 401 });
    expect((await ledger()).effects).toEqual(state.effects);
  });

  test('a later manual source edit rejects the original typed output before any optional plan/effect', async () => {
    await setup('aw64_stale'); const origin = await f.app.listen({ host: '127.0.0.1',port: 0 }); const request = transport(origin);
    const job = (await queue(request)).items[0]!;
    const original = await ledger(),journal = createFileJournal(join(directory,'journal.json'));
    const result = await runPollingCycle({ request,targetId: f.target.id,journal,adapter: {
      supports: summaryAdapter.supports,
      async generate(args: Parameters<typeof summaryAdapter.generate>[0]) {
        await f.rename('fresh-paper','New manual title'); return summaryAdapter.generate(args);
      },
    } });
    expect(result).toMatchObject([{ jobId: job.id,status: 'stale',effectReceiptIds: [] }]);
    expect(await journal.load()).toBeNull();
    const state = await ledger(); expect(state.plans).toEqual([]); expect(state.notes).toEqual([]); expect(state.effects).toEqual(original.effects);
    expect(state.jobs[0]!.state).toBe('stale');
    expect((await f.db.selectFrom('nodes').select('title').where('id','=','fresh-paper').executeTakeFirstOrThrow()).title).toBe('New manual title');
  });
});
