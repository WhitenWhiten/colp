import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountCreditsPort } from '../../../src/infrastructure/identity/index.js';
import { createPostgresClassificationRunRuntime } from '../../../src/infrastructure/collections/classification-run-runtime.js';
import { createBookmarkClassificationProvider } from '../../../src/infrastructure/collections/classification-provider-factory.js';
import type { BookmarkClassificationProvider } from '../../../src/modules/collections/index.js';
import { createCreditTestDatabase, grantCredits } from '../../support/credit-ledger-fixture.js';
import { seedClassificationTaxonomy } from '../../support/classification-database-fixture.js';
import { classificationHttpHarness, classificationAuthHeaders } from '../../support/classification-http-harness.js';
import { describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

describeWithPostgres('CR-03 real HTTP batch ownership, publication and cancellation',()=>{
  let isolated:IsolatedPostgresRuntime;
  const cleanup:(()=>Promise<void>)[]=[];
  beforeAll(async()=>{isolated=await createCreditTestDatabase('credits_run_http');await runMigrations(isolated.runtime.db,'latest');},180000);
  afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
  afterAll(async()=>isolated?.close());

  async function fixture(beforeResult?:()=>Promise<void>,managedAdmissionEnabled=true,beforeCall?:()=>Promise<void>,singleNode=false){
    const input=await seedClassificationTaxonomy(isolated.runtime);let calls=0;
    const base=createBookmarkClassificationProvider(null);
    const provider:BookmarkClassificationProvider={...base,async classify(context,execution){
      const answer={folderId:null,confidence:1,probabilities:[{folderId:null,probability:1},
        ...context.candidates!.l1.map(folder=>({folderId:folder.id,probability:0}))]};
      await beforeCall?.();
      await execution.calls.run('l1',0,{},async()=>{calls++;await beforeResult?.();return {answer,modelVersion:'fixture',inputTokens:1,outputTokens:1};});
      return {l1:answer,l2:null,tags:[],candidateCoverage:context.candidates!.coverage,modelVersion:'fixture'};
    }};
    const runtime=createPostgresClassificationRunRuntime(isolated.runtime.db,provider,{enabled:()=>true,tagsEnabled:()=>false,
      managedAdmissionEnabled,creditEnabled:true,credits:createPostgresAccountCreditsPort,cancelBackend:isolated.runtime.cancelBackend,onError:()=>{}});
    const app=classificationHttpHarness({preview:async()=>({kind:'in_progress',retryAfterSeconds:1})},
      {runs:runtime,principalId:input.collectionId,subjectId:input.ownerSubjectId});
    const origin=await app.listen({port:0,host:'127.0.0.1'});
    cleanup.push(async()=>{await runtime.stop();await app.close();});
    const path=`/api/v1/collections/${input.collectionId}/classification-runs`;
    const document={sourceFolderIds:singleNode?[]:[input.root],nodeIds:singleNode?[input.nodeId]:[],requested:{folder:true,tags:false},maxItems:50,
      billing:{priceVersion:'bookmark-classify.v1',maxPoints:2}};
    const create=(commandId=randomUUID())=>fetch(origin+path,{method:'POST',headers:{...classificationAuthHeaders,
      'content-type':'application/json','known-command-id':commandId},body:JSON.stringify(document)});
    const get=(id:string)=>fetch(origin+path+'/'+id,{headers:classificationAuthHeaders});
    const cancel=(id:string,etag:string,commandId=randomUUID())=>fetch(origin+path+'/'+id+'/cancel',{method:'POST',headers:{...classificationAuthHeaders,
      'content-type':'application/json','known-command-id':commandId,'if-match':etag},body:'{}'});
    const fund=(amount=2)=>grantCredits(isolated.runtime.db,{accountId:input.collectionId,grantKey:randomUUID(),amount});
    return {input,runtime,path,document,create,get,cancel,fund,calls:()=>calls};
  }

  async function terminal(runId:string){
    const deadline=Date.now()+15_000;
    while(Date.now()<deadline){
      const result=await isolated.runtime.pool.query('SELECT status FROM collection_classification_runs WHERE id=$1',[runId]);
      if(result.rows[0]&&!['queued','running'].includes(result.rows[0].status))return;
      // Observe persisted completion; this delay does not choose a race winner.
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('Batch did not reach a terminal published state');
  }

  test('exact N credits cover all child work once, and create replay preserves the original queued usage',async()=>{
    const f=await fixture();await f.fund();const command=randomUUID();
    const created=await f.create(command);expect(created.status).toBe(201);
    const bytes=await created.text();const queued=JSON.parse(bytes);
    expect(queued.actions).toHaveLength(2);
    expect(queued.creditUsage).toEqual({mode:'managed',priceVersion:'bookmark-classify.v1',quotedPoints:2,reservedPoints:2,chargedPoints:0,releasedPoints:0});
    expect(created.headers.get('location')).toBe(f.path+'/'+queued.runId);expect(created.headers.get('etag')).toBe(queued.etag);
    f.runtime.start();await terminal(queued.runId);
    const current=await f.get(queued.runId);expect(current.status).toBe(200);const body=await current.json();
    expect(body.status).toBe('open');expect(body.actions.every((action:{status:string})=>action.status==='succeeded')).toBe(true);
    expect(body.creditUsage).toEqual({...queued.creditUsage,reservedPoints:0,chargedPoints:2});expect(f.calls()).toBe(2);
    const charges=await isolated.runtime.pool.query('SELECT id,state,task_kind FROM credit_charges WHERE account_id=$1',[f.input.collectionId]);
    expect(charges.rows).toHaveLength(2);expect(charges.rows.every(row=>row.state==='settled'&&row.task_kind==='classification_action')).toBe(true);
    const executions=await isolated.runtime.pool.query('SELECT credit_charge_id,billing_owner_kind FROM classification_provider_executions WHERE principal_id=$1',[f.input.collectionId]);
    expect(executions.rows).toHaveLength(2);
    expect(executions.rows.every(row=>row.billing_owner_kind==='action'&&charges.rows.some(charge=>charge.id===row.credit_charge_id))).toBe(true);
    const replay=await f.create(command);expect(replay.status).toBe(201);expect(await replay.text()).toBe(bytes);
    const events=await isolated.runtime.pool.query('SELECT kind,count(*)::int AS count FROM credit_ledger_entries WHERE account_id=$1 GROUP BY kind',[f.input.collectionId]);
    expect(Object.fromEntries(events.rows.map(row=>[row.kind,row.count]))).toEqual({grant:1,reserve:2,spend:2});
  });

  test('cancel before worker dispatch releases all holds without a provider call',async()=>{
    const f=await fixture();await f.fund();const created=await f.create();expect(created.status).toBe(201);const queued=await created.json();
    const response=await f.cancel(queued.runId,queued.etag);expect(response.status).toBe(200);
    expect((await response.json()).creditUsage).toEqual({...queued.creditUsage,reservedPoints:0,releasedPoints:2});
    f.runtime.start();await terminal(queued.runId);expect(f.calls()).toBe(0);
    const amount=await isolated.runtime.pool.query("SELECT count(*)::int AS count FROM credit_ledger_entries WHERE account_id=$1 AND kind='spend'",[f.input.collectionId]);
    expect(amount.rows[0].count).toBe(0);
  });

  test('TX-06 cancel before D1 send fences a leased child at an explicit provider barrier',async()=>{
    const entered=barrier(),resume=barrier();
    const f=await fixture(undefined,true,async()=>{entered.release();await resume.promise;},true);
    cleanup.push(async()=>{resume.release();});await f.fund();
    const created=await f.create();expect(created.status).toBe(201);const queued=await created.json();
    expect(queued.actions).toHaveLength(1);
    f.runtime.start();await entered.promise;
    const latest=await f.get(queued.runId);const running=await latest.json();
    const cancelled=await f.cancel(queued.runId,running.etag);expect(cancelled.status).toBe(200);
    const body=await cancelled.json();expect(body.status).toBe('cancelled');
    expect(body.creditUsage).toEqual({...queued.creditUsage,reservedPoints:0,releasedPoints:1});
    expect(f.calls()).toBe(0);
    resume.release();await terminal(queued.runId);await f.runtime.stop();
    const attempts=await isolated.runtime.pool.query(`SELECT a.execution_id FROM classification_call_attempts a
      JOIN classification_provider_executions e ON e.id=a.execution_id WHERE e.principal_id=$1`,[f.input.collectionId]);
    expect(attempts.rows).toEqual([]);
    const terminalEvents=await isolated.runtime.pool.query("SELECT kind FROM credit_ledger_entries WHERE account_id=$1 AND kind IN ('spend','release')",[f.input.collectionId]);
    expect(terminalEvents.rows.map(row=>row.kind)).toEqual(['release']);
  });

  test('cancel after dispatch completes child receipts and fences a late provider result',async()=>{
    const entered=barrier(),resume=barrier();let dispatched=0;
    const f=await fixture(async()=>{if(++dispatched===2)entered.release();await resume.promise;});
    cleanup.push(async()=>{resume.release();});await f.fund();
    const created=await f.create();expect(created.status).toBe(201);const queued=await created.json();
    f.runtime.start();await entered.promise;
    const latest=await f.get(queued.runId);const running=await latest.json();
    const cancelled=await f.cancel(queued.runId,running.etag);expect(cancelled.status).toBe(200);
    const body=await cancelled.json();expect(body.status).toBe('cancelled');
    expect(body.creditUsage).toEqual({...queued.creditUsage,reservedPoints:0,releasedPoints:2});
    const children=await isolated.runtime.pool.query(`SELECT r.completed_at FROM product_command_receipts r
      JOIN classification_provider_executions e ON e.principal_id=r.principal_id AND e.command_scope=r.command_scope AND e.command_id=r.command_id
      WHERE e.principal_id=$1`,[f.input.collectionId]);
    expect(children.rows.length).toBeGreaterThan(0);expect(children.rows.every(row=>row.completed_at!==null)).toBe(true);
    resume.release();await f.runtime.stop();
    const after=await f.get(queued.runId);expect((await after.json()).creditUsage).toEqual(body.creditUsage);
    const terminalEvents=await isolated.runtime.pool.query("SELECT kind FROM credit_ledger_entries WHERE account_id=$1 AND kind IN ('spend','release')",[f.input.collectionId]);
    expect(terminalEvents.rows.map(row=>row.kind)).toEqual(['release','release']);
    const cost=await isolated.runtime.pool.query("SELECT sum(settled_microusd)::text AS retained FROM classification_call_attempts a JOIN classification_provider_executions e ON e.id=a.execution_id WHERE e.principal_id=$1",[f.input.collectionId]);
    expect(Number(cost.rows[0].retained)).toBeGreaterThan(0);
  });

  test('insufficient creation stays refused after a grant and leaves no partial run',async()=>{
    const f=await fixture();await f.fund(1);const command=randomUUID();
    const refusal=await f.create(command);const bytes=await refusal.text();expect(refusal.status).toBe(409);
    expect(JSON.parse(bytes).error.creditContext).toMatchObject({requiredPoints:2,availablePoints:1,maxPoints:2});
    await f.fund();const replay=await f.create(command);expect(replay.status).toBe(409);expect(await replay.text()).toBe(bytes);
    const runs=await isolated.runtime.pool.query('SELECT id FROM collection_classification_runs WHERE principal_id=$1',[f.input.collectionId]);
    expect(runs.rows).toEqual([]);expect(f.calls()).toBe(0);
  });

  test('managed admission switch rejects a new platform batch over HTTP without provider work',async()=>{
    const f=await fixture(undefined,false);await f.fund();
    const response=await f.create();expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('feature_temporarily_unavailable');expect(f.calls()).toBe(0);
    const runs=await isolated.runtime.pool.query('SELECT id FROM collection_classification_runs WHERE principal_id=$1',[f.input.collectionId]);
    expect(runs.rows).toEqual([]);
  });
});
