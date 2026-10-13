import { lockCollectionReplicaGate } from '../../../src/infrastructure/database/lock-order.js';
import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { validateAutomation } from '@know-n/colp/automation';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
describeWithPostgres('AW-41 immutable manual selection',()=>{
  let f:Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async()=>{await f?.close();});
  const options={folder:{serverUuid:'server',collectionId:'collection',nodeId:'root'},includeDescendants:true,moveFolderedBookmarks:false,tasks:'none'};
  const preview=()=>f.ownerPost(`/rules/${f.rule.id}/run-once/preview`,options);
  test('preview has no effects; exact start preserves explicit folders and duplicate commands return the same manual run',async()=>{
    f=await automationPollingFixture('aw41_manual');await f.createNode('chosen','parent','Explicit','https://arxiv.org/abs/chosen');
    const before=(await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows;
    const p=await preview();expect(p.statusCode,p.body).toBe(200);expect(validateAutomation('RunOncePreview',p.json()).valid).toBe(true);
    expect(p.json()).toMatchObject({canStart:true,sideEffects:false,explicitChoiceCount:2});
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toEqual(before);
    const command=randomUUID(),body={previewId:p.json().id,previewDigest:p.json().previewDigest};
    const start=()=>f.app.inject({method:'POST',url:`/api/v1/me/automations/rules/${f.rule.id}/run-once`,headers:f.ownerHeaders(command),payload:body});
    const started=await start();expect(started.statusCode,started.body).toBe(201);expect(started.json().kind).toBe('manual');
    expect(started.json().childRunIds).toHaveLength(3);expect(validateAutomation('Run',started.json()).valid).toBe(true);
    expect((await start()).body).toBe(started.body);
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id','=','chosen').executeTakeFirstOrThrow()).parent_id).toBe('parent');
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id','=','paper').executeTakeFirstOrThrow()).parent_id).toBe('academic');
    const replay=await f.ownerPost(`/rules/${f.rule.id}/run-once`,body);expect(replay.statusCode,replay.body).toBe(201);expect(replay.json().id).toBe(started.json().id);
    await f.db.transaction().execute(async tx=>{
      await sql`UPDATE collections SET deleted_at=clock_timestamp() WHERE id='collection'`.execute(tx);
      await sql`UPDATE nodes SET deleted_at=clock_timestamp() WHERE collection_id='collection'`.execute(tx);
    });
    expect((await start()).statusCode).toBe(404);
  });
  test('browser root folders are intake roots and competing rules arbitrate run-once placement',async()=>{
    f=await automationPollingFixture('aw41_roots');
    await f.createNode('bar','root','Bookmarks bar');
    // Sync creates role folders; the fixture marks one directly because the Product API cannot.
    await sql`UPDATE nodes SET payload_json=payload_json||'{"folderRole":"bookmarks-bar"}'::jsonb WHERE id='bar'`.execute(f.db);
    await f.createNode('barred','bar','Bar paper','https://arxiv.org/abs/barred');
    const p=await preview();expect(p.statusCode,p.body).toBe(200);expect(p.json().canStart).toBe(true);
    const started=await f.ownerPost(`/rules/${f.rule.id}/run-once`,{previewId:p.json().id,previewDigest:p.json().previewDigest});expect(started.statusCode,started.body).toBe(201);
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id','=','barred').executeTakeFirstOrThrow()).parent_id).toBe('academic');
    const executor=(await f.app.inject({url:'/api/v1/me/automations/executors',headers:{cookie:f.owner.cookie}})).json().items[0];
    const bindings=await f.ownerPost('/binding-sets',{name:'Competing bindings',values:{researchEnricher:{kind:'executor',executorId:executor.id},
      academicRoot:{...f.values.academicRoot,folder:{...f.folder,nodeId:'parent'}}}});expect(bindings.statusCode,bindings.body).toBe(201);
    const competitor={...f.ruleInput,bindingSetId:bindings.json().id,definition:{...f.ruleInput.definition,name:'Competing intake',priority:f.ruleInput.definition.priority+1}};
    const created=await f.ownerPost('/rules',competitor);expect(created.statusCode,created.body).toBe(201);
    const activation=await f.ownerPost('/rules/preview',{rule:competitor,mode:'currentState'});expect(activation.statusCode,activation.body).toBe(200);
    const enabled=await f.ownerPost(`/rules/${created.json().id}/lifecycle`,{state:'enabled',pendingRuns:'hold',reason:'Competing rule',activationPreviewId:activation.json().previewId},String(created.headers.etag));
    expect(enabled.statusCode,enabled.body).toBe(200);
    await f.createNode('later','root','Later paper','https://arxiv.org/abs/later');
    const contested=await preview();expect(contested.statusCode,contested.body).toBe(200);
    expect(contested.json()).toMatchObject({canStart:false});expect(contested.json().blockedCount).toBeGreaterThan(0);
  });
  test('task runs count against the daily limit; run-once never overspends it',async()=>{
    f=await automationPollingFixture('aw41_cap',{dailyLimit:3});
    const p=await f.ownerPost(`/rules/${f.rule.id}/run-once/preview`,{...options,tasks:'all'});expect(p.statusCode,p.body).toBe(200);expect(p.json().canStart).toBe(true);
    const over=await f.ownerPost(`/rules/${f.rule.id}/run-once`,{previewId:p.json().id,previewDigest:p.json().previewDigest});
    expect(over.statusCode,over.body).toBe(409);expect(over.json().error.code).toBe('automation_command_conflict');
    expect((await sql`SELECT id FROM automation_runs WHERE kind='manual'`.execute(f.db)).rows).toEqual([]);
    const placement=await preview();expect(placement.statusCode,placement.body).toBe(200);
    const started=await f.ownerPost(`/rules/${f.rule.id}/run-once`,{previewId:placement.json().id,previewDigest:placement.json().previewDigest});
    expect(started.statusCode,started.body).toBe(201);
  });
  test('unpreviewed, changed options/digest, stale members and foreign Owner fail before effects',async()=>{
    f=await automationPollingFixture('aw41_stale');
    expect((await f.ownerPost(`/rules/${f.rule.id}/run-once`,{})).statusCode).toBe(400);
    const p=await preview();expect(p.statusCode,p.body).toBe(200);
    const request={previewId:p.json().id,previewDigest:p.json().previewDigest};
    expect((await f.ownerPost(`/rules/${f.rule.id}/run-once`,{...request,previewDigest:'wrong'})).statusCode).toBe(409);
    expect((await f.ownerPost(`/rules/${f.rule.id}/run-once`,{...request,tasks:'all'})).statusCode).toBe(400);
    const foreign=await f.issue('manual-foreign');
    const denied=await f.app.inject({method:'POST',url:`/api/v1/me/automations/rules/${f.rule.id}/run-once`,headers:{cookie:foreign.cookie,origin:'https://automation.example.test','x-csrf-token':foreign.csrfToken,'known-command-id':randomUUID()},payload:request});expect(denied.statusCode).toBe(409);
    await f.rename('paper','Changed after preview');
    const stale=await f.ownerPost(`/rules/${f.rule.id}/run-once`,request);expect(stale.statusCode,stale.body).toBe(409);
    expect((await sql`SELECT id FROM automation_runs WHERE kind='manual'`.execute(f.db)).rows).toEqual([]);
  });
  test('rollback cannot leave partial placements; tasks all uses pinned child DAGs and expiration requires refresh',async()=>{
    f=await automationPollingFixture('aw41_atomic');
    const p=await f.ownerPost(`/rules/${f.rule.id}/run-once/preview`,{...options,tasks:'all'});expect(p.statusCode,p.body).toBe(200);
    const input={previewId:p.json().id,previewDigest:p.json().previewDigest};
    await expect(f.uow.execute(f.owner,async ports=>{ports.runtimeEnabled=false;return ports.runOnce!.start(f.rule.id,input);})).rejects.toMatchObject({code:'automation_unsupported_capability'});
    await expect(f.uow.execute(f.owner,async ports=>{await ports.runOnce!.start(f.rule.id,input);throw new Error('crash before commit');})).rejects.toThrow('crash before commit');
    expect((await sql`SELECT id FROM automation_runs WHERE kind='manual'`.execute(f.db)).rows).toEqual([]);
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id','=','paper').executeTakeFirstOrThrow()).parent_id).toBe('root');
    const started=await f.ownerPost(`/rules/${f.rule.id}/run-once`,input);expect(started.statusCode,started.body).toBe(201);expect(started.json().status).toBe('running');
    expect((await sql`SELECT j.id FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id WHERE r.kind='manual' AND j.state='ready'`.execute(f.db)).rows).toHaveLength(2);
    const expired=await f.uow.execute(f.owner,async ports=>{ports.now=async()=>new Date(Date.now()-3600_000);return ports.runOnce!.preview(f.rule.id,options);});
    expect((await f.ownerPost(`/rules/${f.rule.id}/run-once`,{previewId:expired.id,previewDigest:expired.previewDigest})).statusCode).toBe(409);
  });
  test('over-limit snapshot cannot start and is never silently truncated into a runnable selection',async()=>{
    f=await automationPollingFixture('aw41_limit');
    // Capacity fixture bulk-inserts canonical-shaped rows; no source events/effects are claimed for these rows.
    await sql`INSERT INTO resource_id_ledger(resource_id,resource_type) SELECT 'capacity-'||g::text,'node' FROM generate_series(1,1001) g`.execute(f.db);
    const columns=(await sql<{column_name:string}>`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='nodes' AND is_generated='NEVER' ORDER BY ordinal_position`.execute(f.db)).rows.map(r=>r.column_name);
    await sql`INSERT INTO nodes (${sql.join(columns.map(c=>sql.id(c)))}) SELECT ${sql.join(columns.map(c=>c==='id'?sql`'capacity-'||g::text`:c==='position_token'?sql`'z'||lpad(g::text,8,'0')`:sql.ref('n.'+c)))}
      FROM nodes n CROSS JOIN generate_series(1,1001) g WHERE n.id='paper'`.execute(f.db);
    const p=await preview();expect(p.statusCode,p.body).toBe(200);expect(p.json().canStart).toBe(false);expect(p.json().maxMembers).toBe(1000);
    expect((await f.ownerPost(`/rules/${f.rule.id}/run-once`,{previewId:p.json().id,previewDigest:p.json().previewDigest})).statusCode).toBe(409);
  });
  test('start waits for the replica gate without holding a collection lock',async()=>{
    f=await automationPollingFixture('aw41_lock_order');
    const p=await preview();expect(p.statusCode,p.body).toBe(200);
    let ready!:()=>void,release!:()=>void;
    const entered=new Promise<void>(r=>{ready=r;}),released=new Promise<void>(r=>{release=r;});
    const canonical=f.db.transaction().execute(async tx=>{
      await lockCollectionReplicaGate(tx,'collection');ready();await released;
      await tx.selectFrom('collections').select('id').where('id','=','collection').forUpdate().execute();
    });
    await entered;
    const started=f.ownerPost(`/rules/${f.rule.id}/run-once`,{previewId:p.json().id,previewDigest:p.json().previewDigest});
    try {
      await expect.poll(async()=>Number((await sql<{n:string}>`SELECT count(*) AS n FROM pg_locks
        WHERE locktype='advisory' AND classid=1263675657 AND NOT granted`.execute(f.db)).rows[0]!.n),{timeout:5000}).toBeGreaterThan(0);
    } finally {release();}
    await canonical;
    const result=await started;expect(result.statusCode,result.body).toBe(201);
  });

  test('1,000 valid members with 64 tags and shared ancestry fit the preview contract',async()=>{
    f=await automationPollingFixture('aw41_structural_budget');
    const tags=Array.from({length:64},(_,i)=>'tag-'+i);
    await sql`UPDATE nodes SET parent_id='academic',tags=${JSON.stringify(tags)}::jsonb,
      payload_json=jsonb_set(payload_json,'{tags}',${JSON.stringify(tags)}::jsonb) WHERE id='paper'`.execute(f.db);
    await sql`INSERT INTO resource_id_ledger(resource_id,resource_type) SELECT 'tag-capacity-'||g::text,'node' FROM generate_series(1,998) g`.execute(f.db);
    const columns=(await sql<{column_name:string}>`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='nodes' AND is_generated='NEVER' ORDER BY ordinal_position`.execute(f.db)).rows.map(r=>r.column_name);
    await sql`INSERT INTO nodes (${sql.join(columns.map(c=>sql.id(c)))}) SELECT ${sql.join(columns.map(c=>c==='id'?sql`'tag-capacity-'||g::text`:c==='position_token'?sql`'z'||lpad(g::text,8,'0')`:sql.ref('n.'+c)))}
      FROM nodes n CROSS JOIN generate_series(1,998) g WHERE n.id='paper'`.execute(f.db);
    const p=await preview();expect(p.statusCode,p.body).toBe(200);
    expect(p.json()).toMatchObject({canStart:true,matchedCount:1000,maxMembers:1000});
  });

});
