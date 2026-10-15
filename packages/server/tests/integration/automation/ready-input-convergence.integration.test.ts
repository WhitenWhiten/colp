import { randomUUID } from 'node:crypto';
import { afterEach,expect,test } from 'vitest';
import { sql } from 'kysely';
import type { Job } from '@know-n/colp/automation';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { convergeOwnerWork,createSubscriptionStore,createDeliveryWorker } from '../../../src/infrastructure/automation/index.js';
import { createWebhookCipher } from '../../../src/infrastructure/automation/webhook-signer.js';
import { createPostgresAnnotationMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createAnnotation,moveCollectionNode } from '../../../src/modules/collections/index.js';

const cipher=createWebhookCipher(Buffer.alloc(32,8)),secret='whsec_'+Buffer.alloc(32,9).toString('base64');
describeWithPostgres('ready work converges without polling a queue',() => {
  let f:Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async()=>{ await f?.close(); });
  async function setup(kind:'source'|'note'|'folder'|'batch'='source') {
    f=await automationPollingFixture('ready_'+kind,{ wakeMode:'events',three:kind==='source',pair:async(base,grant)=>{
      expect((await base.pair(grant)).statusCode).toBe(200);
      if(kind==='folder') Object.assign(base.values.academicRoot,{allowedAncestor:{...base.folder,nodeId:'parent'}});
      await createSubscriptionStore(base.db,base.worker,{...cipher,verify:async()=>{}}).subscribe(base.actor,{
        name:'colp.automation.triggered',arguments:{targetId:grant.targetId},delivery:{mode:'webhook',url:'https://receiver.example',secret} });
    },configure:(d,p)=>{
      if(kind==='note') { d.tasks[0]!.inputFields.push('note');p.assignments.find(a=>a.taskType==='summary.generate')!.allowedData.push('note'); }
      if(kind==='batch') {
        delete d.intake;d.on='node.created';d.trigger={mode:'countBatch',count:2,distinctBy:'node',partition:'rule'};
        d.tasks[0]!.type='digest.generate';d.tasks[0]!.outputContract='digest.sourced.v1';p.assignments[2]!.taskType='digest.generate';
      }
    }});
    if(kind==='batch') { await f.createNode('batch-second','root','Second','https://arxiv.org/second');await f.inspect(); }
    let notification: {jobId:string;deliveryHandle:string}|undefined;
    await createDeliveryWorker(f.db,f.worker.authorize,{...cipher,send:async(_url,body)=>{
      const data=JSON.parse(body).data;notification={jobId:data.jobId,deliveryHandle:data.deliveryHandle};return {status:204,retryAfter:null};
    }}).tick();
    expect(notification).toBeDefined();
    return notification!;
  }
  async function assertStale(id:string) {
    expect((await sql<{state:Job['status']}>`SELECT state FROM automation_jobs WHERE id=${id}`.execute(f.db)).rows[0]!.state).toBe('stale');
    expect((await sql`SELECT * FROM automation_job_attempts WHERE job_id=${id}`.execute(f.db)).rows).toEqual([]);
  }
  test.each(['inputs','claim','maintenance'] as const)('source edits settle ready work and successors through %s after an accepted event',async path=>{
    const event=await setup();
    await f.rename('fresh-paper','Edited after event');
    if(path==='inputs') await expect(f.work!.inputs(f.actor,event.jobId,{deliveryHandle:event.deliveryHandle})).rejects.toMatchObject({code:'automation_stale_input'});
    if(path==='claim') await expect(f.work!.mutate(f.actor,event.jobId,'claim',{deliveryHandle:event.deliveryHandle},randomUUID())).rejects.toMatchObject({code:'automation_stale_input'});
    if(path==='maintenance') await convergeOwnerWork(f.db,f.owner.accountId,'server');
    await assertStale(event.jobId);
    const jobs=(await sql<{task_id:string;state:string}>`SELECT task_id,state FROM automation_jobs ORDER BY task_id`.execute(f.db)).rows;
    expect(jobs).toEqual([{task_id:'refine',state:'stale'},{task_id:'summary',state:'blocked'},{task_id:'tags',state:'stale'}]);
    expect((await sql`SELECT state FROM automation_runs`.execute(f.db)).rows).toEqual([{state:'blocked'}]);
  });
  test.each(['note','folder','batch'] as const)('production claim persists %s drift before returning its error',async kind=>{
    const event=await setup(kind);
    if(kind==='note') await createPostgresAnnotationMutationUnitOfWork(f.db).execute(p=>createAnnotation(p,{
      actor:{principalId:f.owner.accountId,subjectId:f.owner.subjectId,principalType:'account',creator:{id:'urn:colp:owner',name:'Owner'}},command:f.command(),collectionId:'collection',annotationId:'new-note',
      annotation:{type:'note',subject:{type:'node',id:'fresh-paper'},format:'plain',value:'New context',visibility:'private'} }));
    if(kind==='folder') {
      const node=await f.db.selectFrom('nodes').select('resource_revision').where('id','=','academic').executeTakeFirstOrThrow();
      const parents=await f.db.selectFrom('nodes').select(['id','children_revision']).where('id','in',['parent','root']).execute();
      const revisions=new Map(parents.map(parent=>[parent.id,parent.children_revision]));
      await f.canonical.execute(p=>moveCollectionNode(p,{actor:{principalId:f.owner.accountId,subjectId:f.owner.subjectId,principalType:'account'},command:f.command(),collectionId:'collection',nodeId:'academic',ifMatch:`"${node.resource_revision}"`,newParentId:'root',afterId:null,beforeId:null,
        baseSourceParentRevision:revisions.get('parent')!,baseTargetParentRevision:revisions.get('root')!}));
    }
    if(kind==='batch') await f.rename('batch-second','Changed batch member');
    await expect(f.work!.mutate(f.actor,event.jobId,'claim',{deliveryHandle:event.deliveryHandle},randomUUID())).rejects.toMatchObject({code:kind==='folder'?'automation_binding_unavailable':'automation_stale_input'});
    await assertStale(event.jobId);
  });
});
