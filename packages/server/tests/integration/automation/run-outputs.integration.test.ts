import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { validateAutomation,type Job,type TaskOutput } from '@know-n/colp/automation';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
describeWithPostgres('AW-58 durable run outputs and read watermarks',()=>{
  let f:Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async()=>{await f?.close();});
  async function setup(){f=await automationPollingFixture('aw58_outputs',{configure:(d,p)=>{
    delete d.intake;d.trigger={mode:'countBatch',count:2,distinctBy:'node',partition:'rule'};d.on='node.created';
    d.tasks=[{...d.tasks[0]!,id:'digest',type:'digest.generate',outputContract:'digest.sourced.v1'},
      {...d.tasks[0]!,id:'review',type:'review.generate',outputContract:'review.sourced.v1',after:['digest']}];
    p.assignments=[{...p.assignments[2]!,taskType:'digest.generate'},{...p.assignments[2]!,taskType:'review.generate'}];
  }});await f.createNode('batch-second','root','Second','https://arxiv.org/abs/second');await f.inspect();}
  const get=(path:string)=>f.app.inject({url:'/api/v1/me/automations'+path,headers:{cookie:f.owner.cookie}});
  async function submit(job:Job,text:string){
    const inputs=await f.work!.inputs(f.actor,job.id,{deliveryHandle:job.deliveryHandle!});
    const lease=await f.work!.mutate(f.actor,job.id,'claim',{deliveryHandle:job.deliveryHandle},randomUUID());
    const output:TaskOutput={kind:'text',textType:job.task.type==='digest.generate'?'digest':'review',text,language:'en',evidence:[{kind:'source',reference:inputs.items[0]!.sourceEventId,observedAt:new Date().toISOString()}]};
    const body={claimToken:lease.claimToken,generation:lease.generation,inputDigest:lease.inputDigest,outputContract:job.task.outputContract,output},command=randomUUID();
    const result=await f.work!.mutate(f.actor,job.id,'submit',body,command);expect(result.status).toBe('succeeded');
    expect(await f.work!.mutate(f.actor,job.id,'submit',body,command)).toEqual(result);
  }
  test('accepted text persists without canonical plans; paginated outputs and through-ID read keep a later result unread',async()=>{
    await setup();const first=(await f.work!.list(f.actor,{targetId:f.target.id})).items[0]!;await submit(first,'<script>alert("untrusted")</script> is literal source text.');
    const page1=await get(`/runs/${first.runId}/outputs?limit=1`);expect(page1.statusCode,page1.body).toBe(200);expect(validateAutomation('RunOutputPage',page1.json()).valid).toBe(true);
    const oldOutput=page1.json().items[0];expect(oldOutput.output.text).toContain('<script>');
    expect((await get(`/runs/${first.runId}`)).json()).toMatchObject({unread:true,outputCount:1});
    const second=(await f.work!.list(f.actor,{targetId:f.target.id})).items[0]!;expect(second.task.type).toBe('review.generate');await submit(second,'Later review.');
    const run=await get(`/runs/${first.runId}`);expect(run.json()).toMatchObject({unread:true,outputCount:2});
    const readCommand=randomUUID(),mark=()=>f.app.inject({method:'POST',url:`/api/v1/me/automations/runs/${first.runId}/read`,headers:f.ownerHeaders(readCommand,String(run.headers.etag)),payload:{throughOutputId:oldOutput.id}});
    const read=await mark();expect(read.statusCode,read.body).toBe(200);
    expect((await get(`/runs/${first.runId}`)).json()).toMatchObject({unread:true,outputCount:2});
    const paged=await get(`/runs/${first.runId}/outputs?limit=1`);expect(paged.json().items[0].id).toBe(oldOutput.id);expect(paged.json().nextCursor).toBeTruthy();
    const later=await get(`/runs/${first.runId}/outputs?limit=1&cursor=${encodeURIComponent(paged.json().nextCursor)}`);expect(later.json().items).toHaveLength(1);expect(later.json().items[0].output.text).toBe('Later review.');
    const current=await get(`/runs/${first.runId}`);
    expect((await f.ownerPost(`/runs/${first.runId}/read`,{throughOutputId:later.json().items[0].id},String(current.headers.etag))).statusCode).toBe(200);
    expect((await get(`/runs/${first.runId}`)).json().unread).toBe(false);
    expect((await sql`SELECT * FROM automation_proposals`.execute(f.db)).rows).toEqual([]);expect((await sql`SELECT * FROM automation_effect_receipts`.execute(f.db)).rows).toEqual([]);
    expect((await sql`SELECT * FROM automation_run_outputs`.execute(f.db)).rows).toHaveLength(2);
    await f.db.transaction().execute(async tx=>{
      await sql`UPDATE collections SET deleted_at=clock_timestamp() WHERE id='collection'`.execute(tx);
      await sql`UPDATE nodes SET deleted_at=clock_timestamp() WHERE collection_id='collection'`.execute(tx);
    });expect((await mark()).statusCode).toBe(404);
  });
  test('foreign Owner, output IDs from another run and unavailable source cannot expose or mark text read',async()=>{
    await setup();const job=(await f.work!.list(f.actor,{targetId:f.target.id})).items[0]!;await submit(job,'Private accepted output.');
    const foreign=await f.issue('output-foreign');
    const denied=await f.app.inject({url:`/api/v1/me/automations/runs/${job.runId}/outputs`,headers:{cookie:foreign.cookie}});expect(denied.statusCode).toBe(404);
    const run=await get(`/runs/${job.runId}`);expect((await f.ownerPost(`/runs/${job.runId}/read`,{throughOutputId:'foreign-output'},String(run.headers.etag))).statusCode).toBe(404);
    await sql`UPDATE nodes SET deleted_at=clock_timestamp() WHERE id='fresh-paper'`.execute(f.db);
    const unavailable=await get(`/runs/${job.runId}/outputs`);expect(unavailable.statusCode,unavailable.body).toBe(404);expect(unavailable.body).not.toContain('Private accepted output.');
    expect((await sql`SELECT * FROM automation_run_outputs`.execute(f.db)).rows).toHaveLength(1);
  });
});
