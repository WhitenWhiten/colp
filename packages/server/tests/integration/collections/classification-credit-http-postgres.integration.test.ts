import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { sql } from 'kysely';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountCreditsPort } from '../../../src/infrastructure/identity/index.js';
import { createPostgresClassificationRuntime } from '../../../src/infrastructure/collections/classification-runtime.js';
import { createBookmarkClassificationProvider } from '../../../src/infrastructure/collections/classification-provider-factory.js';
import { createPostgresProductCommandReceiptPort } from '../../../src/infrastructure/database/product-command-receipt.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import { ClassificationProviderError, type BookmarkClassificationProvider } from '../../../src/modules/collections/index.js';
import { createCreditTestDatabase, grantCredits } from '../../support/credit-ledger-fixture.js';
import { seedClassificationTaxonomy } from '../../support/classification-database-fixture.js';
import { classificationHttpHarness, classificationAuthHeaders } from '../../support/classification-http-harness.js';
import { describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const golden=JSON.parse(readFileSync(new URL('../../../../docs/plans/active/cross-module/classification-credits/contracts/golden.json',import.meta.url),'utf8')) as {
  name:string;value:Record<string,unknown>;
}[];
const consent={priceVersion:'bookmark-classify.v1',maxPoints:1};

describeWithPostgres('CR-02 real HTTP managed classification and durable receipts',()=>{
  let isolated:IsolatedPostgresRuntime;
  const cleanup:(()=>Promise<void>)[]=[];
  beforeAll(async()=>{isolated=await createCreditTestDatabase('credits_http');await runMigrations(isolated.runtime.db,'latest');},180000);
  afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
  afterAll(async()=>isolated?.close());

  async function fixture(options:{fail?:boolean;beforeResult?:()=>Promise<void>;free?:boolean;creditEnabled?:boolean;managedAdmissionEnabled?:boolean}={}){
    const input=await seedClassificationTaxonomy(isolated.runtime);
    let calls=0;
    const base=createBookmarkClassificationProvider(null);
    const provider:BookmarkClassificationProvider={...base,async classify(context,execution){
      const answer={folderId:null,confidence:1,probabilities:[{folderId:null,probability:1},
        ...context.candidates!.l1.map(folder=>({folderId:folder.id,probability:0}))]};
      await execution.calls.run('l1',0,{fixture:true},async()=>{
        calls++;
        if(!options.free){
          const holds=await isolated.runtime.pool.query("SELECT id FROM credit_charges WHERE account_id=$1 AND state='reserved'",[input.collectionId]);
          const settings=await isolated.runtime.pool.query("SELECT coalesce((SELECT execution_mode FROM collection_classification_settings WHERE collection_id=$1),'server_managed') AS mode",[input.collectionId]);
          if(settings.rows[0]?.mode==='server_managed')expect(holds.rows).toHaveLength(1);
        }
        await options.beforeResult?.();
        if(options.fail)throw new ClassificationProviderError('unavailable');
        return {answer,modelVersion:'fixture',inputTokens:1,outputTokens:1};
      });
      return {l1:answer,l2:null,tags:[],candidateCoverage:context.candidates!.coverage,modelVersion:'fixture'};
    }};
    const runtime=createPostgresClassificationRuntime(isolated.runtime.db,provider,{
      enabled:true,tagsEnabled:false,managedAdmissionEnabled:options.managedAdmissionEnabled,creditEnabled:options.creditEnabled??!options.free,credits:createPostgresAccountCreditsPort,
      cancelBackend:isolated.runtime.cancelBackend,onError:()=>{},
    });
    const app=classificationHttpHarness(runtime,{principalId:input.collectionId,subjectId:input.ownerSubjectId});
    const origin=await app.listen({port:0,host:'127.0.0.1'});
    cleanup.push(async()=>{await runtime.stop();await app.close();});
    const path=`/api/v1/collections/${input.collectionId}/classification/preview`;
    const body={source:'web',nodeId:input.nodeId,requested:{folder:true,tags:false}};
    const send=(document:unknown={...body,billing:consent},commandId=randomUUID(),signal?:AbortSignal)=>fetch(origin+path,{
      method:'POST',headers:{...classificationAuthHeaders,'content-type':'application/json','known-command-id':commandId},
      body:JSON.stringify(document),signal,
    });
    const fund=(amount=1)=>grantCredits(isolated.runtime.db,{accountId:input.collectionId,grantKey:randomUUID(),amount});
    const events=async()=>(await isolated.runtime.pool.query('SELECT kind,available_delta,reserved_delta FROM credit_ledger_entries WHERE account_id=$1 ORDER BY sequence',[input.collectionId])).rows;
    return {input,runtime,path,body,send,fund,events,calls:()=>calls};
  }

  test('consent, price, limit and funds each become stable refusals; new intent alone starts a provider',async()=>{
    const f=await fixture();
    const cases=[
      {document:f.body,status:422,code:'billing_consent_required'},
      {document:{...f.body,billing:{...consent,priceVersion:'old.v1'}},status:409,code:'credit_price_changed'},
      {document:{...f.body,billing:{...consent,maxPoints:0}},status:409,code:'credit_limit_exceeded'},
      {document:{...f.body,billing:consent},status:409,code:'insufficient_credits'},
    ];
    const replays:{document:unknown;commandId:string;bytes:string;status:number}[]=[];
    for(const current of cases){
      const commandId=randomUUID();const response=await f.send(current.document,commandId);const bytes=await response.text();
      expect(response.status).toBe(current.status);const error=JSON.parse(bytes).error;
      expect(error.code).toBe(current.code);
      if(current.code!=='billing_consent_required')expect(error.creditContext).toEqual({requiredPoints:1,availablePoints:0,
        maxPoints:current.code==='credit_limit_exceeded'?0:1,priceVersion:consent.priceVersion});
      replays.push({...current,commandId,bytes});
    }
    await f.fund(2);
    for(const original of replays){const response=await f.send(original.document,original.commandId);
      expect(response.status).toBe(original.status);expect(await response.text()).toBe(original.bytes);}
    expect(f.calls()).toBe(0);expect((await f.events()).map(e=>e.kind)).toEqual(['grant']);
    const success=await f.send();expect(success.status).toBe(200);
    expect((await success.json()).creditUsage).toEqual(golden.find(f=>f.name==='managed-preview')!.value.creditUsage);
    expect(f.calls()).toBe(1);
  });

  test('billing is fingerprinted; concurrent replay and reading success never charge twice',async()=>{
    const f=await fixture();await f.fund();const command=randomUUID();
    const first=await f.send(undefined,command);expect(first.status).toBe(200);const bytes=await first.text();
    const repeats=await Promise.all([f.send(undefined,command),f.send(undefined,command)]);
    for(const response of repeats){expect(response.status).toBe(200);expect(await response.text()).toBe(bytes);}
    const changed=await f.send({...f.body,billing:{...consent,maxPoints:2}},command);
    expect(changed.status).toBe(409);expect((await changed.json()).error.code).toBe('command_id_reused');
    expect(f.calls()).toBe(1);expect((await f.events()).map(e=>e.kind)).toEqual(['grant','reserve','spend']);
  });

  test('provider failure releases credit and exact retry replays the same failure without another call',async()=>{
    const f=await fixture({fail:true});await f.fund();const command=randomUUID();
    const response=await f.send(undefined,command);const bytes=await response.text();expect(response.status).toBe(503);
    const again=await f.send(undefined,command);expect(again.status).toBe(503);expect(await again.text()).toBe(bytes);
    expect(f.calls()).toBe(1);expect((await f.events()).map(e=>e.kind)).toEqual(['grant','reserve','release']);
    const result=await isolated.runtime.pool.query('SELECT reason_code,available_after,reserved_after FROM credit_ledger_entries WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1',[f.input.collectionId]);
    expect(result.rows[0]).toMatchObject({reason_code:'classification_failed'});
    expect(Number(result.rows[0].available_after)).toBe(1);expect(Number(result.rows[0].reserved_after)).toBe(0);
  });

  test('historical receipt replays original bytes without consent or retroactive credit fields',async()=>{
    const f=await fixture();const commandId=randomUUID();
    const binding={principalId:f.input.collectionId,commandScope:'collections:classification-preview:v1',commandId};
    const fingerprint=canonicalCommandFingerprint({method:'POST',route:f.path,mediaType:'application/json',body:f.body});
    const body={...golden.find(item=>item.name==='legacy-preview')!.value,collectionId:f.input.collectionId};
    const bytes=JSON.stringify(body,null,2);
    await createUnitOfWork(isolated.runtime.db).execute(async({transaction})=>{
      const receipts=createPostgresProductCommandReceiptPort(transaction);await receipts.claim(binding,fingerprint);
      await receipts.complete(binding,fingerprint,{status:200,contractVersion:'1.0.0',mediaType:'application/json',
        stableHeaders:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'},body:Buffer.from(bytes)});
    });
    const response=await f.send(f.body,commandId);expect(response.status).toBe(200);expect(await response.text()).toBe(bytes);
    expect(f.calls()).toBe(0);expect(await f.events()).toEqual([]);
  });

  test('managed admission switch blocks new platform work, replays history exactly, and leaves BYOK enabled',async()=>{
    const f=await fixture({creditEnabled:true,managedAdmissionEnabled:false});
    const commandId=randomUUID();
    const rejected=await f.send(undefined,commandId);expect(rejected.status).toBe(503);
    expect((await rejected.json()).error.code).toBe('feature_temporarily_unavailable');expect(f.calls()).toBe(0);
    expect(await f.events()).toEqual([]);

    const historicalCommandId=randomUUID();
    const binding={principalId:f.input.collectionId,commandScope:'collections:classification-preview:v1',commandId:historicalCommandId};
    const fingerprint=canonicalCommandFingerprint({method:'POST',route:f.path,mediaType:'application/json',body:f.body});
    const bytes=JSON.stringify({legacy:true,creditUsage:{mode:'legacy_free',priceVersion:null,quotedPoints:0,reservedPoints:0,chargedPoints:0,releasedPoints:0}});
    await createUnitOfWork(isolated.runtime.db).execute(async({transaction})=>{
      const receipts=createPostgresProductCommandReceiptPort(transaction);await receipts.claim(binding,fingerprint);
      await receipts.complete(binding,fingerprint,{status:200,contractVersion:'1.0.0',mediaType:'application/json',
        stableHeaders:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store'},body:Buffer.from(bytes)});
    });
    const replay=await f.send(f.body,historicalCommandId);expect(replay.status).toBe(200);expect(await replay.text()).toBe(bytes);expect(f.calls()).toBe(0);

    const profileId=`profile-${randomUUID()}`;
    await sql`INSERT INTO classification_provider_profiles(id,owner_subject_id,label,kind,protocol,model,config_json,secret_envelope,secret_fingerprint,revision,status)
      VALUES(${profileId},${f.input.ownerSubjectId},'Drain BYOK','cloudflare_ai_gateway','cloudflare_ai_run_v1','typesafe/jev',${JSON.stringify({accountId:'a'.repeat(32),gatewayId:'default'})}::jsonb,'{}'::jsonb,'fixture',1,'active')`.execute(isolated.runtime.db);
    await sql`INSERT INTO collection_classification_settings(collection_id,owner_subject_id,auto_tag_mode,max_auto_tags,execution_mode,provider_profile_id,revision)
      VALUES(${f.input.collectionId},${f.input.ownerSubjectId},'off',3,'server_byok',${profileId},1)`.execute(isolated.runtime.db);
    const byok=await f.send(undefined,randomUUID());expect(byok.status).toBe(200);expect(f.calls()).toBe(1);
    expect(await f.events()).toEqual([]);
  });

  test('HTTP disconnect during an authorized call does not refund a successfully persisted result',async()=>{
    let release!:()=>void;let entered!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
    const f=await fixture({beforeResult:async()=>{entered();await barrier;}});await f.fund();
    const commandId=randomUUID(),controller=new AbortController();
    const request=f.send(undefined,commandId,controller.signal);const disconnected=request.catch(()=>null);
    await started;controller.abort();release();await disconnected;
    const deadline=Date.now()+5000;
    let completed=false;
    while(Date.now()<deadline){
      const rows=await isolated.runtime.pool.query('SELECT completed_at FROM product_command_receipts WHERE command_id=$1',[commandId]);
      if(rows.rows[0]?.completed_at){completed=true;break;}
    }
    expect(completed).toBe(true);
    let response=await f.send(undefined,commandId);
    while(response.status===409&&Date.now()<deadline){
      expect((await response.json()).error.code).toBe('command_in_progress');
      response=await f.send(undefined,commandId);
    }
    expect(response.status).toBe(200);
    expect((await response.json()).creditUsage.chargedPoints).toBe(1);expect(f.calls()).toBe(1);
    expect((await f.events()).map(e=>e.kind)).toEqual(['grant','reserve','spend']);
  });

  test('disabled account is rechecked in database admission even if session facts were cached',async()=>{
    const f=await fixture();await f.fund();
    await sql`UPDATE accounts SET status='disabled' WHERE id=${f.input.collectionId}`.execute(isolated.runtime.db);
    const response=await f.send();expect([403,404]).toContain(response.status);expect(f.calls()).toBe(0);
    expect((await f.events()).map(e=>e.kind)).toEqual(['grant']);
  });
});
