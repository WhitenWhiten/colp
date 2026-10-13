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
});
