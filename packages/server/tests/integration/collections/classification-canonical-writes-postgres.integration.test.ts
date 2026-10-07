import { seedCanonicalClassificationFixture } from '../../support/classification-database-fixture.js';
import { createClassificationRunApply } from '../../../src/infrastructure/collections/classification-run-apply.js';
import { createPostgresClassificationRunRuntime } from '../../../src/infrastructure/collections/classification-run-runtime.js';

import { type BookmarkClassificationProvider } from '../../../src/modules/collections/index.js';

import { classificationHttpHarness, classificationAuthHeaders } from '../../support/classification-http-harness.js';
import { createPostgresClassifyInboxAcceptUnitOfWork } from '../../../src/infrastructure/collections/classify-inbox-accept-postgres.js';
import { createPostgresClassificationConfirmationUnitOfWork } from '../../../src/infrastructure/collections/classification-confirmation-postgres.js';
import { acceptClassifyInboxItem, confirmCollectionBookmarkClassification } from '../../../src/modules/collections/index.js';

import { randomUUID, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, test, expect } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';

import { createBookmarkClassificationProvider } from '../../../src/infrastructure/collections/classification-provider-factory.js';

import { sql } from 'kysely';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('CLF canonical classification writes', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('clf_canonical_writes', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180000);
  afterAll(async () => isolated?.close());

  const seedCanonical=(otherNodeId?:string,extra?:Parameters<typeof seedCanonicalClassificationFixture>[2])=>seedCanonicalClassificationFixture(isolated.runtime,otherNodeId,extra);

  async function openCanonicalRun(){
    const input=await seedCanonical();
    const provider:BookmarkClassificationProvider={...createBookmarkClassificationProvider(null),async classify(value,execution){
      const answer={folderId:null,confidence:1,probabilities:[...value.candidates!.l1.map(folder=>({folderId:folder.id,probability:0})),{folderId:null,probability:1}]};
      const result=await execution.calls.run('l1',0,{fixture:'apply'},async()=>({answer,modelVersion:'fixture',inputTokens:0,outputTokens:0}));
      return {l1:result.answer,l2:null,tags:[],candidateCoverage:value.candidates!.coverage,modelVersion:'fixture'};
    }};
    const runtime=createPostgresClassificationRunRuntime(isolated.runtime.db,provider,{enabled:()=>true,tagsEnabled:()=>true,onError:()=>{}});
    const request={actor:{principalId:input.collectionId,subjectId:input.ownerSubjectId},collectionId:input.collectionId,commandId:randomUUID(),requestId:randomUUID(),
      document:{nodeIds:[input.nodeId,input.otherNodeId],requested:{folder:true,tags:false},maxItems:50}};
    const receipt=await runtime.create(request);if(receipt.kind!=='replay')throw new Error('no receipt');
    const runId=JSON.parse(Buffer.from(receipt.result.body).toString()).runId as string;
    runtime.start();
    try{await expect.poll(async()=>(await runtime.get({...request,runId})).status,{timeout:10000}).toBe('open');}
    finally{await runtime.stop();}
    const run=await runtime.get({...request,runId});expect(run.actions.every(action=>action.status==='succeeded')).toBe(true);
    return {input,provider,runtime,request,run};
  }

  test('batch Apply atomically moves and tags all selections, exact replays, and consumes the run once',async()=>{
    const {input,runtime,request,run}=await openCanonicalRun();
    const app=classificationHttpHarness({preview:async()=>{throw new Error('unused');}},{runs:runtime,principalId:input.collectionId,subjectId:input.ownerSubjectId});
    const document={selections:run.actions.map(action=>({actionId:action.actionId,folderId:input.folderId,addTags:['ai']}))};
    const apply={method:'POST' as const,url:`/api/v1/collections/${input.collectionId}/classification-runs/${run.runId}/apply`,
      headers:{...classificationAuthHeaders,'known-command-id':randomUUID(),'if-match':run.etag},payload:document};
    try{
      const result=await app.inject(apply);expect(result.statusCode,result.body).toBe(200);
      expect(result.json()).toMatchObject({runId:run.runId,status:'applied',appliedNodeIds:run.actions.map(action=>action.nodeId)});
      expect(result.json().receipts.flatMap((receipt:{operationIds:string[]})=>receipt.operationIds)).toHaveLength(3);
      const repeated=await app.inject(apply);expect(repeated.body).toBe(result.body);expect(repeated.headers.etag).toBe(result.headers.etag);
      const evidence=await isolated.runtime.db.selectFrom('collection_classification_evidence').selectAll().where('collection_id','=',input.collectionId).execute();
      expect(evidence).toHaveLength(run.actions.length);expect(evidence.every(row=>row.source==='run_apply'&&row.command_id===apply.headers['known-command-id']&&row.folder_id===input.folderId)).toBe(true);
      const current=await runtime.get({...request,runId:run.runId});expect(current.status).toBe('applied');
      const again=await app.inject({...apply,headers:{...apply.headers,'known-command-id':randomUUID(),'if-match':current.etag}});
      expect(again.statusCode).toBe(409);expect(again.json().error.code).toBe('mutation_conflict');
      const nodes=await isolated.runtime.db.selectFrom('nodes').select(['parent_id','tags']).where('id','in',[input.nodeId,input.otherNodeId]).execute();
      expect(nodes.every(node=>node.parent_id===input.folderId&&Array.isArray(node.tags)&&node.tags.includes('ai'))).toBe(true);
    }finally{await app.close();}
  },20000);

  test('batch Apply rolls back nodes, canonical operations, run state and receipt on commit failure',async()=>{
    const {input,provider,request,run,runtime}=await openCanonicalRun();
    const before=await isolated.runtime.db.selectFrom('nodes').select(['id','parent_id','tags','resource_revision']).where('collection_id','=',input.collectionId).orderBy('id').execute();
    const apply=createClassificationRunApply(isolated.runtime.db,provider,{enabled:()=>true,tagsEnabled:()=>true,
      faultInjector:{afterCallbackBeforeCommit(){throw new Error('injected_apply_rollback');}}});
    const intent={...request,runId:run.runId,commandId:randomUUID(),ifMatch:run.etag,
      document:{selections:run.actions.map(action=>({actionId:action.actionId,folderId:input.folderId,addTags:['ai']}))}};
    await expect(apply(intent)).rejects.toThrow('injected_apply_rollback');
    expect(await isolated.runtime.db.selectFrom('collection_classification_evidence').select('evidence_id').where('collection_id','=',input.collectionId).execute()).toHaveLength(0);
    expect(await isolated.runtime.db.selectFrom('nodes').select(['id','parent_id','tags','resource_revision']).where('collection_id','=',input.collectionId).orderBy('id').execute()).toEqual(before);
    expect((await runtime.get({...request,runId:run.runId})).status).toBe('open');
    expect(await isolated.runtime.db.selectFrom('operations').select('operation_id').where('collection_id','=',input.collectionId).execute()).toHaveLength(0);
    expect(await isolated.runtime.db.selectFrom('audit_events').select('id').where('collection_id','=',input.collectionId).execute()).toHaveLength(0);
    expect(await isolated.runtime.db.selectFrom('outbox_events').select('outbox_id').where('aggregate_scope','=',input.collectionId).execute()).toHaveLength(0);
    expect(await isolated.runtime.db.selectFrom('product_command_receipts').select('command_id').where('command_id','=',intent.commandId).execute()).toHaveLength(0);
    await expect(runtime.apply({...intent,document:{selections:[{...intent.document.selections[0]!,addTags:['invented']}]}})).rejects.toMatchObject({code:'invalid_input'});
    await expect(runtime.apply({...intent,document:{selections:[{...intent.document.selections[0]!,actionId:'unknown'}]}})).rejects.toMatchObject({code:'invalid_input'});
    await sql`UPDATE collections SET content_revision='changed' WHERE id=${input.collectionId}`.execute(isolated.runtime.db);
    await expect(runtime.apply(intent)).rejects.toMatchObject({code:'revision_conflict'});
  },20000);

  test('batch Apply accepts all 50 maximum opaque IDs and three 64-character escaped Chinese tags in one HTTP transaction',async()=>{
    const ids=Array.from({length:50},(_,i)=>'n'.repeat(125)+String(i).padStart(3,'0'));
    const tags=['甲'.repeat(64),'乙'.repeat(64),'丙'.repeat(64)],folderId='f'.repeat(128);
    const input=await seedCanonical(undefined,{nodeIds:ids,tags,folderId});let next=0;
    // Missing settings default to suggest, so a tags request now calls the provider.
    // A disabled upstream fails every action; this case only needs an open run to Apply.
    const provider:BookmarkClassificationProvider={...createBookmarkClassificationProvider(null),async classify(value,execution){
      const answers:{tag:string;noul:number}[]=[];
      for(const [index,chunk] of value.candidates!.tagChunks.entries()){
        const result=await execution.calls.run('tags',index,{fixture:chunk},async()=>({answer:chunk.map(tag=>({tag,noul:0})),modelVersion:'fixture',inputTokens:0,outputTokens:0}));
        answers.push(...result.answer as {tag:string;noul:number}[]);
      }
      return {l1:null,l2:null,tags:answers,candidateCoverage:value.candidates!.coverage,modelVersion:'fixture'};
    }};
    const runtime=createPostgresClassificationRunRuntime(isolated.runtime.db,provider,{
      enabled:()=>true,tagsEnabled:()=>true,onError:()=>{},idGenerator:()=>'a'.repeat(125)+String(next++).padStart(3,'0')});
    const request={actor:{principalId:input.collectionId,subjectId:input.ownerSubjectId},collectionId:input.collectionId,commandId:randomUUID(),requestId:randomUUID(),
      document:{nodeIds:ids,requested:{folder:false,tags:true},maxItems:50}};
    const queued=await runtime.create(request);if(queued.kind!=='replay')throw new Error('no receipt');
    const runId=JSON.parse(Buffer.from(queued.result.body).toString()).runId as string;
    runtime.start();
    try{await expect.poll(async()=>(await runtime.get({...request,runId})).status,{timeout:20000}).toBe('open');}
    finally{await runtime.stop();}
    const run=await runtime.get({...request,runId});expect(run.actions.filter(action=>action.status!=='succeeded')).toEqual([]);expect(run.actions).toHaveLength(50);
    const body=JSON.stringify({selections:run.actions.map(action=>({actionId:action.actionId,folderId,addTags:tags}))})
      .replace(/"([^"\\]*)"/g,(_match,part:string)=>'"'+Array.from(part).map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"');
    expect(Buffer.byteLength(body)).toBeGreaterThan(128*1024);expect(Buffer.byteLength(body)).toBeLessThan(256*1024);
    const app=classificationHttpHarness({preview:async()=>{throw new Error('unused');}},{runs:runtime,principalId:input.collectionId,subjectId:input.ownerSubjectId});
    try{
      const result=await app.inject({method:'POST',url:`/api/v1/collections/${input.collectionId}/classification-runs/${runId}/apply`,
        headers:{...classificationAuthHeaders,'known-command-id':randomUUID(),'if-match':run.etag,'content-type':'application/json'},payload:body});
      expect(result.statusCode,result.body).toBe(200);expect(result.json().appliedNodeIds).toHaveLength(50);
      const nodes=await isolated.runtime.db.selectFrom('nodes').select(['tags','parent_id']).where('id','in',ids).execute();
      expect(nodes.every(node=>node.parent_id===folderId&&JSON.stringify(node.tags)===JSON.stringify(tags))).toBe(true);
    }finally{await app.close();}
  },60000);

  test('batch cancel versus Apply has one winner, no partial node writes and no second application',async()=>{
    const {input,runtime,request,run}=await openCanonicalRun();
    const selections=run.actions.map(action=>({actionId:action.actionId,folderId:input.folderId,addTags:['ai']}));
    const results=await Promise.allSettled([
      runtime.apply({...request,runId:run.runId,ifMatch:run.etag,commandId:randomUUID(),document:{selections}}),
      runtime.cancel({...request,runId:run.runId,ifMatch:run.etag,commandId:randomUUID(),document:{}}),
    ]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const final=await runtime.get({...request,runId:run.runId});expect(['applied','cancelled']).toContain(final.status);
    const operations=await isolated.runtime.db.selectFrom('operations').select('operation_id').where('collection_id','=',input.collectionId).execute();
    expect(operations).toHaveLength(final.status==='applied'?3:0);
    await expect(runtime.apply({...request,runId:run.runId,ifMatch:final.etag,commandId:randomUUID(),document:{selections}})).rejects.toThrow('Only an open');
  },20000);

  test('confirmation HTTP atomically moves and unions tags, no-ops and replays original ETag',async()=>{
    const input=await seedCanonical(),commands=createPostgresClassificationConfirmationUnitOfWork(isolated.runtime.db);
    const app=classificationHttpHarness({preview:async()=>{throw new Error('no provider');}},{principalId:input.collectionId,subjectId:input.ownerSubjectId,confirmation:commands});
    try{
      const nodeId=`b2-${input.collectionId}`;
      const request={method:'POST' as const,url:`/api/v1/collections/${input.collectionId}/nodes/${nodeId}/classification-confirmations`,
        headers:{...classificationAuthHeaders,'known-command-id':randomUUID(),'if-match':'"r1"'},payload:{folderId:input.folderId,addTags:['ai']}};
      const result=await app.inject(request);expect(result.statusCode,result.body).toBe(200);
      expect(result.json()).toMatchObject({nodeId,parentId:input.folderId,tags:['AI','ai']});expect(result.json().operationIds).toHaveLength(2);
      expect(result.headers.etag).toBe(result.json().etag);
      const node=await isolated.runtime.db.selectFrom('nodes').select(['parent_id','tags','resource_revision']).where('id','=',nodeId).executeTakeFirstOrThrow();
      expect(node).toMatchObject({parent_id:input.folderId,tags:['AI','ai']});expect(result.headers.etag).toBe(`"${node.resource_revision}"`);
      const operations=await isolated.runtime.db.selectFrom('operations').select('operation_id').where('collection_id','=',input.collectionId).execute();expect(operations).toHaveLength(2);
      const noop=await app.inject({...request,headers:{...request.headers,'known-command-id':randomUUID(),'if-match':result.json().etag}});
      expect(noop.statusCode,noop.body).toBe(200);expect(noop.json().operationIds).toEqual([]);expect(noop.headers.etag).toBe(result.headers.etag);
      const replay=await app.inject(request);expect(replay.body).toBe(result.body);expect(replay.headers.etag).toBe(result.headers.etag);
      expect(replay.headers['content-type']).toBe(result.headers['content-type']);
      const stale=await app.inject({...request,headers:{...request.headers,'known-command-id':randomUUID()}});expect(stale.statusCode).toBe(412);
      const forged=await app.inject({...request,headers:{...request.headers,'known-command-id':randomUUID(),'if-match':result.json().etag},payload:{folderId:null,addTags:['new-tag']}});
      expect(forged.statusCode).toBe(422);
      const sidecar=await isolated.runtime.db.selectFrom('collection_classify_inbox_decision').select('node_id').where('collection_id','=',input.collectionId).execute();expect(sidecar).toEqual([]);
    }finally{await app.close();}
  });

  test('confirmation rollback covers move, tags, operations and receipt; owner and union limits are enforced',async()=>{
    const input=await seedCanonical(),nodeId=`b2-${input.collectionId}`;
    const command={actor:{principalId:input.collectionId,subjectId:input.ownerSubjectId},collectionId:input.collectionId,nodeId,
      commandId:randomUUID(),ifMatch:'"r1"',document:{folderId:input.folderId,addTags:['ai']}};
    const commands=createPostgresClassificationConfirmationUnitOfWork(isolated.runtime.db);
    await expect(commands.execute(ports=>confirmCollectionBookmarkClassification(ports,{...command,actor:{...command.actor,subjectId:'foreign'}}))).rejects.toMatchObject({outcome:'conceal'});
    // Failure during the second canonical mutation must roll back the already executed move.
    await expect(commands.execute(ports=>confirmCollectionBookmarkClassification({...ports,collection:{...ports.collection,canonical:{...ports.collection.canonical,
      execute:async value=>{if(value.mutation.action==='update')throw new Error('tag write failed');return ports.collection.canonical.execute(value);}}}},command))).rejects.toThrow('tag write failed');
    const node=await isolated.runtime.db.selectFrom('nodes').select(['parent_id','tags','resource_revision']).where('id','=',nodeId).executeTakeFirstOrThrow();
    expect(node).toMatchObject({parent_id:`deep-${input.collectionId}`,tags:['AI'],resource_revision:'r1'});
    expect(await isolated.runtime.db.selectFrom('operations').select('operation_id').where('collection_id','=',input.collectionId).execute()).toEqual([]);
    expect(await isolated.runtime.db.selectFrom('product_command_receipts').select('command_id').where('command_id','=',command.commandId).execute()).toEqual([]);
    await sql`UPDATE nodes SET tags=${JSON.stringify(Array.from({length:64},(_,i)=>`tag-${i}`))}::jsonb WHERE id=${nodeId}`.execute(isolated.runtime.db);
    await expect(commands.execute(ports=>confirmCollectionBookmarkClassification(ports,command))).rejects.toMatchObject({code:'invalid_node_tags'});
    for(const folderId of [input.root,input.nodeId,'missing'])await expect(commands.execute(ports=>confirmCollectionBookmarkClassification(ports,{...command,document:{folderId,addTags:[]}}))).rejects.toMatchObject({outcome:'conceal'});
  });

  test('confirmation supports 128-byte bookmark IDs and fences concurrent tag-only decisions',async()=>{
    const input=await seedCanonical('中'.repeat(42)+'ab');
    const commands=createPostgresClassificationConfirmationUnitOfWork(isolated.runtime.db);
    const request={actor:{principalId:input.collectionId,subjectId:input.ownerSubjectId},collectionId:input.collectionId,nodeId:input.otherNodeId,
      commandId:randomUUID(),ifMatch:'"r1"',document:{folderId:null,addTags:['ai']}};
    const outcomes=await Promise.allSettled([request,{...request,commandId:randomUUID()}].map(value=>commands.execute(ports=>confirmCollectionBookmarkClassification(ports,value))));
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const failed=outcomes.find(result=>result.status==='rejected');expect(failed?.status==='rejected'&&failed.reason).toMatchObject({code:'precondition_failed'});
    const success=outcomes.find(result=>result.status==='fulfilled');
    if(success?.status==='fulfilled'&&success.value.kind==='succeeded'){
      expect(success.value.result.nodeId).toBe(input.otherNodeId);expect(success.value.result.operationIds).toHaveLength(1);
      expect(success.value.result.parentId).toBe(`deep-${input.collectionId}`);expect(success.value.result.tags).toEqual(['AI','ai']);
    }
  });

  test('Accept HTTP addTags atomically writes move, union, sidecar and one outer receipt with replay',async()=>{
    const input=await seedCanonical(),accept=createPostgresClassifyInboxAcceptUnitOfWork(isolated.runtime.db);
    const donor=randomBytes(16).toString('base64url');
    await isolated.runtime.pool.query("INSERT INTO resource_id_ledger(resource_id,resource_type) VALUES ($1,'node')",[donor]);
    await isolated.runtime.pool.query("INSERT INTO nodes(id,collection_id,parent_id,kind,is_root,title,url,tags,position_token,resource_revision,children_revision) VALUES ($1,$2,$3,'bookmark',false,'Donor','https://example.org/donor','[\"extra\"]','Z','r1','ch1')",[donor,input.collectionId,input.root]);
    const app=classificationHttpHarness({preview:async()=>{throw new Error('no provider');}},{principalId:input.collectionId,subjectId:input.ownerSubjectId,inboxAccept:accept});
    try{
      const request={method:'POST' as const,url:`/api/v1/me/classify-inbox/${input.nodeId}/accept`,
        headers:{...classificationAuthHeaders,'known-command-id':randomUUID(),'if-match':'"r1"'},payload:{suggestionId:input.folderId,addTags:['extra']}};
      const invalid=await app.inject({...request,payload:{...request.payload,addTags:['forged']}});expect(invalid.statusCode).toBe(422);
      expect(await isolated.runtime.db.selectFrom('collection_classify_inbox_decision').select('node_id').where('node_id','=',input.nodeId).execute()).toEqual([]);
      await expect(accept.execute(ports=>acceptClassifyInboxItem({...ports,inbox:{...ports.inbox,insertAccepted:async()=> 'blocked'}},{
        actor:{principalId:input.collectionId,subjectId:input.ownerSubjectId},nodeId:input.nodeId,commandId:randomUUID(),ifMatch:'"r1"',body:request.payload,
      }))).rejects.toMatchObject({code:'resource_not_found'});
      expect(await isolated.runtime.db.selectFrom('operations').select('operation_id').where('collection_id','=',input.collectionId).execute()).toEqual([]);
      const result=await app.inject(request);expect(result.statusCode,result.body).toBe(200);expect(result.json()).toEqual({nodeId:input.nodeId,decision:'accepted',folderId:input.folderId});
      const node=await isolated.runtime.db.selectFrom('nodes').select(['parent_id','tags','resource_revision']).where('id','=',input.nodeId).executeTakeFirstOrThrow();
      expect(node).toMatchObject({parent_id:input.folderId,tags:['AI','ai','extra']});
      expect(await isolated.runtime.db.selectFrom('operations').select('operation_id').where('collection_id','=',input.collectionId).execute()).toHaveLength(2);
      expect(await isolated.runtime.db.selectFrom('product_command_receipts').select('command_scope').where('command_id','=',request.headers['known-command-id']).execute()).toEqual([{command_scope:'collections:classify-inbox-accept:v1'}]);
      const replay=await app.inject(request);expect(replay.body).toBe(result.body);expect(replay.headers['content-type']).toBe(result.headers['content-type']);
      const reused=await app.inject({...request,payload:{...request.payload,addTags:['AI']}});expect(reused.statusCode).toBe(409);
      const again=await app.inject({...request,headers:{...request.headers,'known-command-id':randomUUID(),'if-match':`"${node.resource_revision}"`}});expect(again.statusCode).toBe(200);
      expect(await isolated.runtime.db.selectFrom('operations').select('operation_id').where('collection_id','=',input.collectionId).execute()).toHaveLength(2);
    }finally{await app.close();}
  });

});
