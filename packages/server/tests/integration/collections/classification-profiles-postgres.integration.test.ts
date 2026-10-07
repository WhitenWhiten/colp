import {createClassificationRunCommands} from '../../../src/infrastructure/collections/classification-run-commands.js';
import {SYNTHETIC_PIPELINE_CALIBRATION,SYNTHETIC_DEPLOYMENT_IDENTITY} from '../../support/classification-auto-calibration.js';
import {createCollectionNode} from '../../../src/modules/collections/index.js';
import {createPostgresClassificationConfirmationUnitOfWork} from '../../../src/infrastructure/collections/classification-confirmation-postgres.js';
import {createPostgresClassificationAutoTagProcessor} from '../../../src/infrastructure/collections/classification-auto-tag-process.js';
import {PostgresOutboxRepository} from '../../../src/infrastructure/outbox/repository.js';
import {CLASSIFICATION_AUTO_TAG_HANDLER} from '../../../src/infrastructure/outbox/classification-auto-tag.js';
import {createClassificationRunJobs} from '../../../src/infrastructure/collections/classification-run-jobs.js';
import {createPostgresClassificationRunRuntime} from '../../../src/infrastructure/collections/classification-run-runtime.js';
import {createClassificationProfileProbes} from '../../../src/infrastructure/collections/classification-profile-probes.js';
import {randomUUID} from 'node:crypto';
import {sql} from 'kysely';
import {beforeAll,afterAll,test,expect} from 'vitest';
import {runMigrations} from '../../../src/infrastructure/database/index.js';
import {createIsolatedPostgresRuntime,describeWithPostgres,type IsolatedPostgresRuntime} from '../../support/postgres-test-runtime.js';
import {seedCanonicalClassificationFixture} from '../../support/classification-database-fixture.js';
import {classificationHttpHarness,classificationAuthHeaders} from '../../support/classification-http-harness.js';
import {createPostgresClassificationProfilesRuntime} from '../../../src/infrastructure/collections/classification-profiles-runtime.js';
import {createClassificationSecretProtector} from '../../../src/infrastructure/security/classification-secret-envelope.js';
import {createPostgresClassificationSettingsRuntime} from '../../../src/infrastructure/collections/classification-settings-postgres.js';
import {createProfileAwareClassificationProvider} from '../../../src/infrastructure/collections/classification-profile-provider.js';
import {createBookmarkClassificationProvider} from '../../../src/infrastructure/collections/classification-provider-factory.js';
import {createPostgresClassificationRuntime} from '../../../src/infrastructure/collections/classification-runtime.js';
import {CLASSIFICATION_SETTINGS_V2_MEDIA} from '../../../src/modules/collections/index.js';
const BASE='/api/v1/me/classification-provider-profiles';
const secret='test-profile-token';
const createDocument={kind:'cloudflare_ai_gateway',label:'Fixture',model:'typesafe/jev',config:{accountId:'a'.repeat(32),gatewayId:'default'},secret};
const protector=createClassificationSecretProtector([{id:'fixture',version:1,key:Buffer.alloc(32,1)}],Buffer.alloc(32,2));
describeWithPostgres('CLF-07 server BYOK encrypted profile runtime',()=>{
  let isolated:IsolatedPostgresRuntime;
  beforeAll(async()=>{isolated=await createIsolatedPostgresRuntime('clf_profiles',{maxConnections:6});await runMigrations(isolated.runtime.db,'latest');},180000);
  afterAll(async()=>isolated?.close());
  async function fixture(){
    const input=await seedCanonicalClassificationFixture(isolated.runtime),calls:{body:unknown;authorization:string}[]=[];
    let onCall:(()=>Promise<Response|null>)|undefined;
    const transport:typeof fetch=async(_url,options)=>{
      const body=JSON.parse(String(options?.body));calls.push({body,authorization:new Headers(options?.headers).get('authorization')??''});
      const override=await onCall?.();if(override)return override;
      const answers=Object.fromEntries(Object.entries(body.input.questions as Record<string,{type:string;criteria:Record<string,string>}>).map(([id,q])=>{
        const keys=Object.keys(q.criteria);return [id,q.type==='noul'?{noul:0.99}:{choice:keys[0],confidence:1,probabilities:Object.fromEntries(keys.map((key,index)=>[key,index===0?1:0]))}];
      }));
      return new Response(JSON.stringify({model:'jev-1.13.0',answers,usage:{input_tokens:10,output_tokens:0}}));
    };
    const profiles=createPostgresClassificationProfilesRuntime(isolated.runtime.db,protector,{enabled:()=>true,transport});
    const provider=createProfileAwareClassificationProvider(isolated.runtime.db,createBookmarkClassificationProvider(null),protector,{enabled:()=>true,transport});
    const preview=createPostgresClassificationRuntime(isolated.runtime.db,provider,{enabled:true,tagsEnabled:true,onError:()=>{}});
    const app=classificationHttpHarness(preview,{principalId:input.collectionId,subjectId:input.ownerSubjectId,profiles,settings:createPostgresClassificationSettingsRuntime(isolated.runtime.db)});
    const headers=(commandId=randomUUID())=>({...classificationAuthHeaders,'known-command-id':commandId});
    const create=()=>app.inject({method:'POST',url:BASE,headers:headers(),payload:createDocument});
    const probe=(id:string,commandId=randomUUID())=>app.inject({method:'POST',url:`${BASE}/${id}/test`,headers:headers(commandId)});
    return {input,calls,profiles,provider,preview,app,headers,create,probe,onCall:(value:typeof onCall)=>{onCall=value;},async close(){await preview.stop();await profiles.stop();await app.close();}};
  }
  test('HTTP create/list/replay are write-only; probe is fixed; rotate/clear CAS and referenced delete are atomic',async()=>{
    const f=await fixture();try{
      const commandId=randomUUID(),request={method:'POST' as const,url:BASE,headers:f.headers(commandId),payload:createDocument};
      const created=await f.app.inject(request);expect(created.statusCode).toBe(201);expect(created.headers.location).toBe(`${BASE}/${created.json().profileId}`);expect(created.body).not.toContain(secret);
      expect(created.json()).toMatchObject({status:'disabled',lastTestedAt:null});const id=created.json().profileId;
      const replayed=await f.app.inject(request);expect(replayed.body).toBe(created.body);expect(replayed.headers.location).toBe(created.headers.location);
      const changed=await f.app.inject({...request,payload:{...createDocument,secret:'other-token'}});expect(changed.statusCode).toBe(409);
      const row=await isolated.runtime.db.selectFrom('classification_provider_profiles').selectAll().where('id','=',id).executeTakeFirstOrThrow();
      expect(JSON.stringify(row,(_k,v)=>typeof v==='bigint'?String(v):v)).not.toContain(secret);
      const listed=await f.app.inject({url:BASE,headers:classificationAuthHeaders});expect(listed.json().profiles).toHaveLength(1);expect(listed.headers['cache-control']).toBe('private, no-store');
      expect(JSON.stringify(listed.json())).not.toMatch(/secret|ciphertext|accountId|gatewayId/u);
      const tested=await f.probe(id);expect(tested.statusCode).toBe(200);expect(tested.json().status).toBe('ok');expect(Object.keys(tested.json()).sort()).toEqual(['capabilities','checkedAt','profileId','status']);expect(f.calls).toHaveLength(1);
      expect(JSON.stringify(f.calls[0]?.body)).not.toMatch(/collection scope|bookmark description|AI resource/u);expect(f.calls[0]?.authorization).toBe(`Bearer ${secret}`);
      const settingsUrl=`/api/v1/collections/${f.input.collectionId}/classification-settings`;
      const current=await f.app.inject({url:settingsUrl,headers:{...classificationAuthHeaders,accept:CLASSIFICATION_SETTINGS_V2_MEDIA}});
      const settings=await f.app.inject({method:'PATCH',url:settingsUrl,headers:{...f.headers(),'content-type':CLASSIFICATION_SETTINGS_V2_MEDIA,'if-match':current.headers.etag!},
        payload:JSON.stringify({executionMode:'server_byok',providerProfileId:id,autoTagMode:'suggest'})});
      expect(settings.statusCode).toBe(200);expect(settings.json()).toMatchObject({contractVersion:'2.0.0',executionMode:'server_byok',providerProfileId:id});
      expect((await f.app.inject({url:settingsUrl,headers:classificationAuthHeaders})).statusCode).toBe(404);
      const deletion=await f.app.inject({method:'DELETE',url:`${BASE}/${id}`,headers:{...f.headers(),'if-match':tested.headers.etag!}});expect(deletion.statusCode).toBe(409);
      const clear=await f.app.inject({method:'PATCH',url:`${BASE}/${id}`,headers:{...f.headers(),'if-match':tested.headers.etag!},payload:{secret:null}});expect(clear.statusCode).toBe(200);expect(clear.json().status).toBe('disabled');
      expect((await isolated.runtime.db.selectFrom('classification_provider_profiles').select('secret_envelope').where('id','=',id).executeTakeFirstOrThrow()).secret_envelope).toBeNull();
      expect((await f.probe(id)).statusCode).toBe(503);expect(f.calls).toHaveLength(1);
      const receipts=await isolated.runtime.db.selectFrom('product_command_receipts').selectAll().where('principal_id','=',f.input.collectionId).execute();
      expect(JSON.stringify(receipts,(_k,v)=>typeof v==='bigint'?String(v):v)).not.toContain(secret);
    }finally{await f.close();}
  });
  test('unprobed custom/other presets and unauthorized requests cause no network or stored credential',async()=>{
    const f=await fixture();try{
      for(const kind of ['custom_jev_http','typesafe_official','vercel_ai_gateway'])expect((await f.app.inject({method:'POST',url:BASE,headers:f.headers(),payload:{...createDocument,kind}})).statusCode).toBe(422);
      expect((await f.app.inject({method:'POST',url:BASE,headers:{origin:'https://app.example.test'},payload:createDocument})).statusCode).toBe(401);
      expect((await f.app.inject({method:'POST',url:BASE,headers:{...f.headers(),origin:'https://evil.example'},payload:createDocument})).statusCode).toBe(403);
      expect(f.calls).toHaveLength(0);expect((await f.profiles.list(f.input.ownerSubjectId)).profiles).toHaveLength(0);
    }finally{await f.close();}
  });
  test('unknown probe is never resent; expired dispatched probe recovers a stable receipt',async()=>{
    const f=await fixture();try{
      const id=(await f.create()).json().profileId,commandId=randomUUID();f.onCall(async()=>{throw new Error('private upstream failure '+secret);});
      const result=await f.probe(id,commandId);expect(result.statusCode).toBe(200);expect(result.json().status).toBe('failed');expect(result.body).not.toContain(secret);
      expect((await f.probe(id,commandId)).body).toBe(result.body);expect(f.calls).toHaveLength(1);
      const row=await isolated.runtime.db.selectFrom('classification_profile_tests').selectAll().where('command_id','=',commandId).executeTakeFirstOrThrow();
      expect(row.state).toBe('outcome_unknown');expect(Number(row.reserved_microusd)).toBe(2000);expect(row.settled_microusd).toBeNull();
    }finally{await f.close();}
  });
  async function activate(f:Awaited<ReturnType<typeof fixture>>){
    const profile=(await f.create()).json();const tested=await f.probe(profile.profileId);expect(tested.statusCode).toBe(200);
    const path=`/api/v1/collections/${f.input.collectionId}/classification-settings`;
    const initial=await f.app.inject({url:path,headers:{...classificationAuthHeaders,accept:CLASSIFICATION_SETTINGS_V2_MEDIA}});
    expect((await f.app.inject({method:'PATCH',url:path,headers:{...f.headers(),'content-type':CLASSIFICATION_SETTINGS_V2_MEDIA,'if-match':initial.headers.etag!},
      payload:JSON.stringify({executionMode:'server_byok',providerProfileId:profile.profileId,autoTagMode:'suggest'})})).statusCode).toBe(200);
    return {...profile,...tested.json(),etag:tested.headers.etag};
  }
  test('preview uses the encrypted account credential and rotation fences a dispatched result without fallback',async()=>{
    const f=await fixture();try{
      const profile=await activate(f);const path=`/api/v1/collections/${f.input.collectionId}/classification/preview`;
      const document={source:'web',nodeId:f.input.nodeId,requested:{folder:true,tags:false}};
      const preview=await f.app.inject({method:'POST',url:path,headers:f.headers(),payload:document});expect(preview.statusCode).toBe(200);
      expect(f.calls.length).toBeGreaterThan(1);expect(f.calls.every(call=>call.authorization===`Bearer ${secret}`)).toBe(true);
      let rotated=false;
      f.onCall(async()=>{
        if(!rotated){rotated=true;expect((await f.app.inject({method:'PATCH',url:`${BASE}/${profile.profileId}`,headers:{...f.headers(),'if-match':profile.etag},payload:{secret:'rotated-fixture-token'}})).statusCode).toBe(200);}
        return null;
      });
      const commandId=randomUUID(),request={method:'POST' as const,url:path,headers:f.headers(commandId),payload:document};
      const rejected=await f.app.inject(request);expect(rejected.statusCode).toBe(409);
      const calls=f.calls.length;expect((await f.app.inject(request)).body).toBe(rejected.body);expect(f.calls).toHaveLength(calls);
      expect((await f.app.inject({...request,headers:f.headers()})).statusCode).toBe(503);expect(f.calls).toHaveLength(calls);
    }finally{await f.close();}
  });
  test('an open batch cannot apply after profile revocation',async()=>{
    const f=await fixture();const runs=createPostgresClassificationRunRuntime(isolated.runtime.db,f.provider,{enabled:()=>true,tagsEnabled:()=>true,profilesEnabled:()=>true,onError:()=>{}});
    try{
      const profile=await activate(f),actor={principalId:f.input.collectionId,subjectId:f.input.ownerSubjectId};
      const created=await runs.create({actor,collectionId:f.input.collectionId,commandId:randomUUID(),requestId:'byok-run',document:{sourceFolderIds:[f.input.root],maxItems:1,requested:{folder:true,tags:false}}});
      if(created.kind!=='replay')throw new Error('missing create receipt');const runId=JSON.parse(Buffer.from(created.result.body).toString()).runId;
      runs.start();let run=await runs.get({actor,collectionId:f.input.collectionId,runId});
      for(let index=0;index<100&&run.status!=='open';index++){await new Promise(resolve=>setTimeout(resolve,50));run=await runs.get({actor,collectionId:f.input.collectionId,runId});}
      expect(run.status).toBe('open');
      await f.app.inject({method:'PATCH',url:`${BASE}/${profile.profileId}`,headers:{...f.headers(),'if-match':profile.etag},payload:{secret:null}});
      await expect(runs.apply({actor,collectionId:f.input.collectionId,runId,commandId:randomUUID(),ifMatch:run.etag,
        document:{selections:[{actionId:run.actions[0]!.actionId,folderId:f.input.folderId,addTags:[]}]}})).rejects.toMatchObject({code:'revision_conflict'});
      await createClassificationRunJobs(isolated.runtime.db).reap();
      expect(await runs.get({actor,collectionId:f.input.collectionId,runId})).toMatchObject({status:'failed',failureCode:'configuration_changed'});
    }finally{await runs.stop();await f.close();}
  });
  test('restart reaps an expired dispatched probe and preserves its receipt without another send',async()=>{
    const f=await fixture();try{
      const id=(await f.create()).json().profileId,commandId=randomUUID(),probes=createClassificationProfileProbes(isolated.runtime.db,protector,{enabled:()=>true,signal:new AbortController().signal});
      const input={actor:{principalId:f.input.collectionId,subjectId:f.input.ownerSubjectId},profileId:id,commandId,requestId:'restart-probe'};
      const admitted=await probes.admit(input);expect(admitted.kind).toBe('accepted');
      await sql`UPDATE classification_profile_tests SET state='dispatching',dispatched_at=clock_timestamp()-interval '1 minute',deadline_at=clock_timestamp()-interval '1 second',reserved_microusd=2000 WHERE command_id=${commandId}`.execute(isolated.runtime.db);
      await probes.reap();const result=await probes.admit(input);expect(result.kind).toBe('replay');
      if(result.kind==='replay')expect(result.result.status).toBe(503);expect(f.calls).toHaveLength(0);
      expect((await isolated.runtime.db.selectFrom('classification_profile_tests').select('state').where('command_id','=',commandId).executeTakeFirstOrThrow()).state).toBe('outcome_unknown');
    }finally{await f.close();}
  });

  test('another account cannot test, rotate, delete or reference an owned profile',async()=>{
    const owner=await fixture(),other=await fixture();try{
      const profile=(await owner.create()).json();
      expect((await other.probe(profile.profileId)).statusCode).toBe(404);
      expect((await other.app.inject({method:'PATCH',url:`${BASE}/${profile.profileId}`,headers:{...other.headers(),'if-match':profile.etag},payload:{secret:'foreign-secret'}})).statusCode).toBe(404);
      expect((await other.app.inject({method:'DELETE',url:`${BASE}/${profile.profileId}`,headers:{...other.headers(),'if-match':profile.etag}})).statusCode).toBe(404);
      expect((await other.profiles.list(other.input.ownerSubjectId)).profiles).toHaveLength(0);expect(other.calls).toHaveLength(0);
      await owner.probe(profile.profileId);
      const url=`/api/v1/collections/${other.input.collectionId}/classification-settings`;
      const read=await other.app.inject({url,headers:{...classificationAuthHeaders,accept:CLASSIFICATION_SETTINGS_V2_MEDIA}});
      expect((await other.app.inject({method:'PATCH',url,headers:{...other.headers(),'content-type':CLASSIFICATION_SETTINGS_V2_MEDIA,'if-match':read.headers.etag!},
        payload:JSON.stringify({executionMode:'server_byok',providerProfileId:profile.profileId})})).statusCode).toBe(422);
    }finally{await owner.close();await other.close();}
  });

  test('canonical creation uses the same encrypted BYOK provider path for the automatic tag job',async()=>{
    const f=await fixture();try{
      const profile=await activate(f);
      await sql`UPDATE collection_classification_settings SET auto_tag_mode='auto',revision=revision+1 WHERE collection_id=${f.input.collectionId}`.execute(isolated.runtime.db);
      const created=await createPostgresClassificationConfirmationUnitOfWork(isolated.runtime.db).execute(({collection})=>createCollectionNode(collection,{
        actor:{principalId:f.input.collectionId,subjectId:f.input.ownerSubjectId,principalType:'account'},collectionId:f.input.collectionId,parentId:f.input.root,
        command:{commandId:randomUUID(),fingerprint:'byok-auto-bookmark'},afterId:null,beforeId:null,node:{kind:'bookmark',title:'BYOK automatic tags',url:'https://example.org/byok-auto',description:null,tags:['manual'],visibility:'inherit'}}));
      if(created.kind!=='created')throw new Error('missing node');
      const job=await isolated.runtime.db.selectFrom('collection_classification_tag_jobs').selectAll().where('node_id','=',created.node.id).executeTakeFirstOrThrow();
      expect(job.profile_id).toBe(profile.profileId);expect(job.profile_revision).toBe('2');
      await sql`UPDATE outbox_events SET state='completed',completed_at=clock_timestamp() WHERE handler_name<>${CLASSIFICATION_AUTO_TAG_HANDLER}`.execute(isolated.runtime.db);
      const repository=new PostgresOutboxRepository(isolated.runtime.pool),claim=await repository.claim(30000);if(!claim)throw new Error('missing job');
      const process=createPostgresClassificationAutoTagProcessor(isolated.runtime.db,f.provider,{enabled:()=>true,profilesEnabled:()=>true,calibration:()=>SYNTHETIC_PIPELINE_CALIBRATION,identity:SYNTHETIC_DEPLOYMENT_IDENTITY,metric:()=>{}});
      expect(await process(job.id,{signal:new AbortController().signal,attempt:{outboxId:claim.outboxId,leaseGeneration:claim.leaseGeneration},idempotencyKey:claim.eventId,
        envelope:{event_id:claim.eventId,event_type:claim.eventType,event_version:claim.eventVersion,aggregate_identity:{aggregate_type:claim.aggregateType,aggregate_id:claim.aggregateId,aggregate_scope:claim.aggregateScope},
          aggregate_revision:claim.aggregateRevision,commit_ordinal:claim.commitOrdinal,occurred_at:claim.occurredAt.toISOString(),payload:claim.payload as {jobId:string}}})).toBe('complete');
      await repository.complete(claim);
      expect((await isolated.runtime.db.selectFrom('nodes').select('tags').where('id','=',created.node.id).executeTakeFirstOrThrow()).tags).toEqual(['manual','AI','ai']);
      expect(f.calls.every(call=>call.authorization===`Bearer ${secret}`)).toBe(true);
      expect(await isolated.runtime.db.selectFrom('collection_classification_evidence').select('evidence_id').where('node_id','=',created.node.id).execute()).toHaveLength(0);
    }finally{await f.close();}
  });

  test('a stale pending processor cannot settle or refund another processor dispatch',async()=>{
    const f=await fixture();const gate=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};};
    const entered=gate(),release=gate(),network=gate(),networkRelease=gate();
    let workA:Promise<void>|undefined,workB:Promise<void>|undefined;
    try{
      const profile=(await f.create()).json(),actor={principalId:f.input.collectionId,subjectId:f.input.ownerSubjectId};
      const delayed={...protector,async withSecret(...args:Parameters<typeof protector.withSecret>){entered.resolve();await release.promise;return protector.withSecret(...args);}};
      const options={enabled:()=>true,signal:new AbortController().signal,transport:async()=>{network.resolve();await networkRelease.promise;throw new Error('response lost');}};
      const a=createClassificationProfileProbes(isolated.runtime.db,protector,options),b=createClassificationProfileProbes(isolated.runtime.db,delayed,options);
      const admitted=await a.admit({actor,profileId:profile.profileId,commandId:randomUUID(),requestId:'concurrent-probe'});
      if(admitted.kind!=='accepted')throw new Error('admission failed');
      workB=b.process(admitted.id);await entered.promise;workA=a.process(admitted.id);await network.promise;
      await f.app.inject({method:'PATCH',url:`${BASE}/${profile.profileId}`,headers:{...f.headers(),'if-match':profile.etag},payload:{secret:'rotated-test-token'}});
      release.resolve();await workB;
      const row=await isolated.runtime.db.selectFrom('classification_profile_tests').selectAll().where('id','=',admitted.id).executeTakeFirstOrThrow();
      expect(row.state).toBe('dispatching');expect(row.settled_microusd).toBeNull();
      const budget=await isolated.runtime.db.selectFrom('classification_spend_budgets').select('spent_microusd').where('scope','=',`account:${actor.principalId}`).executeTakeFirstOrThrow();
      expect(Number(budget.spent_microusd)).toBe(2000);
    }finally{release.resolve();networkRelease.resolve();await Promise.allSettled([workA,workB]);await f.close();}
  });
  test('lost encryption keys preserve private metadata and reap admitted probes',async()=>{
    const f=await fixture();const missing=createPostgresClassificationProfilesRuntime(isolated.runtime.db,null,{enabled:()=>true});
    try{
      const profile=(await f.create()).json(),input={actor:{principalId:f.input.collectionId,subjectId:f.input.ownerSubjectId},profileId:profile.profileId,commandId:randomUUID(),requestId:'lost-key'};
      const probes=createClassificationProfileProbes(isolated.runtime.db,protector,{enabled:()=>true,signal:new AbortController().signal});
      const admitted=await probes.admit(input);expect(admitted.kind).toBe('accepted');
      await sql`UPDATE classification_profile_tests SET state='dispatching',dispatched_at=clock_timestamp()-interval '1 minute',deadline_at=clock_timestamp()-interval '1 second',reserved_microusd=2000 WHERE command_id=${input.commandId}`.execute(isolated.runtime.db);
      expect((await missing.list(f.input.ownerSubjectId)).profiles[0]?.profileId).toBe(profile.profileId);
      await expect(missing.test(input)).rejects.toMatchObject({code:'feature_temporarily_unavailable'});
      missing.start();
      await expect.poll(async()=> (await isolated.runtime.db.selectFrom('classification_profile_tests').select('state').where('command_id','=',input.commandId).executeTakeFirstOrThrow()).state).toBe('outcome_unknown');
      expect((await probes.admit(input)).kind).toBe('replay');expect(f.calls).toHaveLength(0);
    }finally{await missing.stop();await f.close();}
  });
  test('profile rotation after snapshot rejects batch admission without a queued run',async()=>{
    const f=await fixture();try{
      const profile=await activate(f);let commits=0;
      const commands=createClassificationRunCommands(isolated.runtime.db,f.provider,{faultInjector:{async afterCommitAcknowledged(){
        if(++commits===2)await f.app.inject({method:'PATCH',url:`${BASE}/${profile.profileId}`,headers:{...f.headers(),'if-match':profile.etag},payload:{secret:null}});
      }}});
      await expect(commands.create({actor:{principalId:f.input.collectionId,subjectId:f.input.ownerSubjectId},collectionId:f.input.collectionId,commandId:randomUUID(),requestId:'rotated-admission',
        document:{nodeIds:[f.input.nodeId],requested:{folder:true,tags:false},maxItems:1}})).rejects.toMatchObject({code:'revision_conflict'});
      expect(await isolated.runtime.db.selectFrom('collection_classification_runs').select('id').where('collection_id','=',f.input.collectionId).execute()).toHaveLength(0);
      expect(f.calls).toHaveLength(1);
    }finally{await f.close();}
  });

  test('profile and settings transport accept the planned 16 KiB budget and reject larger bodies',async()=>{
    const f=await fixture();try{
      const headers={...f.headers(),'content-type':'application/json'};
      const padded=JSON.stringify(createDocument)+' '.repeat(9000);
      expect((await f.app.inject({method:'POST',url:BASE,headers,payload:padded})).statusCode).toBe(201);
      expect((await f.app.inject({method:'POST',url:BASE,headers:f.headers(),payload:{...createDocument,label:'x'.repeat(80)}})).statusCode).toBe(201);
      expect((await f.app.inject({method:'POST',url:BASE,headers:{...headers,'known-command-id':randomUUID()},payload:padded+' '.repeat(8000)})).statusCode).toBe(413);
      const url=`/api/v1/collections/${f.input.collectionId}/classification-settings`,current=await f.app.inject({url,headers:classificationAuthHeaders});
      expect((await f.app.inject({method:'PATCH',url,headers:{...headers,'known-command-id':randomUUID(),'if-match':current.headers.etag!},
        payload:JSON.stringify({autoTagMode:'suggest'})+' '.repeat(9000)})).statusCode).toBe(200);
    }finally{await f.close();}
  });

});
