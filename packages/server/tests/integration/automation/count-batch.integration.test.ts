import { up as upgradeAggregation, down as removeAggregationMetadata } from '../../../migrations/202610310000_automation_aggregation_spaces.js';
import { automationDigest } from '@know-n/colp/automation';
import { afterEach,expect,test } from 'vitest';
import { sql } from 'kysely';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationRuntime } from '../../../src/infrastructure/automation/runtime.js';
import type { AutomationSource } from '../../../src/infrastructure/automation/source-position-store.js';
import { readRepositoryFile } from '../../support/repository-files.js';
describeWithPostgres('AW-57 exact durable count batches',()=>{
  let f:Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async()=>{await f?.close();});
  async function setup(){f=await automationPollingFixture('aw57_count',{configure:(d,p)=>{
    delete d.intake;d.on='node.created';d.trigger={mode:'countBatch',count:10,distinctBy:'node',partition:'rule'};
    d.tasks[0]!.type='digest.generate';d.tasks[0]!.outputContract='digest.sourced.v1';p.assignments[2]!.taskType='digest.generate';
  }});}
  async function add(from:number,to:number){for(let i=from;i<=to;i++)await f.createNode('batch-'+i,'root','Member '+i,'https://arxiv.org/abs/batch-'+i);await f.inspect();}
  async function runs(){return(await sql<{id:string;member_ids:string[];state:string}>`SELECT * FROM automation_runs WHERE kind='batch' ORDER BY created_at,id`.execute(f.db)).rows;}
  async function remainder(){return(await sql<{remainder_json:unknown[]}>`SELECT remainder_json FROM automation_aggregate_state WHERE jsonb_array_length(remainder_json)>0`.execute(f.db)).rows.flatMap(r=>r.remainder_json);}
  test('9→10 emits one exact run; 20 plus remainder survives duplicate facts, transaction rollback and restart',async()=>{
    await setup();await add(2,9);expect(await runs()).toHaveLength(0);expect(await remainder()).toHaveLength(9);
    await add(10,10);expect(await runs()).toHaveLength(1);expect((await runs())[0]?.member_ids).toHaveLength(10);
    const job=(await f.work!.list(f.actor,{targetId:f.target.id})).items[0]!;
    const inputs=await f.work!.inputs(f.actor,job.id,{deliveryHandle:job.deliveryHandle!,limit:'4'});expect(inputs.items).toHaveLength(4);expect(inputs.nextCursor).toBeTruthy();
    const page2=await f.work!.inputs(f.actor,job.id,{deliveryHandle:job.deliveryHandle!,limit:'4',cursor:inputs.nextCursor!});expect(page2.items).toHaveLength(4);
    expect(new Set([...inputs.items,...page2.items].map(i=>i.sourceEventId)).size).toBe(8);
    await add(11,23);expect(await runs()).toHaveLength(2);expect(await remainder()).toHaveLength(3);
    const all=(await sql<AutomationSource>`SELECT f.*,o.operation_id,o.commit_ordinal::text FROM automation_event_facts f JOIN operations o ON o.operation_id=f.operation_id
      WHERE f.node_id LIKE 'batch-%' OR f.node_id='fresh-paper' ORDER BY o.commit_ordinal`.execute(f.db)).rows;
    await f.db.transaction().execute(tx=>createAutomationRuntime('server',true)(tx,f.owner,'collection',all));
    expect(await runs()).toHaveLength(2);expect(await remainder()).toHaveLength(3);
    await expect(f.db.transaction().execute(async tx=>{await createAutomationRuntime('server',true)(tx,f.owner,'collection',all);throw new Error('before commit');})).rejects.toThrow('before commit');
    expect(await runs()).toHaveLength(2);expect(await remainder()).toHaveLength(3);
    expect(new Set((await runs()).flatMap(r=>r.member_ids)).size).toBe(20);
    expect((await sql`SELECT id FROM automation_jobs`.execute(f.db)).rows).toHaveLength(2);
  });
  test('a crash before the 10th commit rolls back membership and jobs; pause skips new sources without losing remainder',async()=>{
    await setup();await add(2,9);await f.createNode('ten','root','Ten','https://arxiv.org/abs/ten');
    const sources=(await sql<AutomationSource>`SELECT f.*,o.operation_id,o.commit_ordinal::text FROM automation_event_facts f JOIN operations o ON o.operation_id=f.operation_id WHERE f.node_id='ten'`.execute(f.db)).rows;
    await expect(f.db.transaction().execute(async tx=>{await createAutomationRuntime('server',true)(tx,f.owner,'collection',sources);throw new Error('crash');})).rejects.toThrow('crash');
    expect(await runs()).toHaveLength(0);expect(await remainder()).toHaveLength(9);
    await f.inspect();expect(await runs()).toHaveLength(1);expect(await remainder()).toHaveLength(0);
    await add(11,12);const pause=await f.app.inject({url:'/api/v1/me/automations/pause',headers:{cookie:f.owner.cookie}});
    const paused=await f.ownerPost('/pause',{paused:true},String(pause.headers.etag));expect(paused.statusCode,paused.body).toBe(200);
    await f.createNode('skipped','root','Skipped','https://arxiv.org/abs/skipped');await f.inspect();expect(await remainder()).toHaveLength(2);
    expect((await f.ownerPost('/pause',{paused:false},String(paused.headers.etag))).statusCode).toBe(200);
    await add(13,20);expect(await runs()).toHaveLength(2);expect(await remainder()).toHaveLength(0);
    const skipped=(await sql<{n:number}>`SELECT count(*)::int AS n FROM automation_batch_members WHERE member_json->>'nodeId'='skipped'`.execute(f.db)).rows[0]!;expect(skipped.n).toBe(0);
  });
  test('the intake.completed digest fixture consumes committed placement facts, not original create facts',async()=>{
    f=await automationPollingFixture('aw57_intake',{configure:(d,p)=>{
      delete d.intake;d.on='intake.completed';d.scope.folderRole='academicRoot';d.scope.includeDescendants=true;
      d.trigger={mode:'countBatch',count:2,distinctBy:'node',partition:'rule'};d.tasks[0]!.type='digest.generate';d.tasks[0]!.outputContract='digest.sourced.v1';p.assignments[2]!.taskType='digest.generate';
    }});
    const definition=JSON.parse(readRepositoryFile('packages/node/tests/fixtures/automation/m1-placement.json'));definition.scope.collectionId='collection';
    const input={definition,bindingSetId:f.ruleInput.bindingSetId};const rule=await f.ownerPost('/rules',input);expect(rule.statusCode,rule.body).toBe(201);
    const preview=await f.ownerPost('/rules/preview',{rule:input,mode:'currentState'});
    expect((await f.ownerPost(`/rules/${rule.json().id}/lifecycle`,{state:'enabled',pendingRuns:'hold',reason:'Intake fixture',activationPreviewId:preview.json().previewId},String(rule.headers.etag))).statusCode).toBe(200);
    await f.createNode('a','root','A','https://arxiv.org/a');await f.createNode('b','root','B','https://arxiv.org/b');await f.inspect();await f.inspect();
    expect(await runs()).toHaveLength(1);expect((await runs())[0]?.member_ids).toHaveLength(2);
    const actions=(await sql<{action:string}>`SELECT f.facts_json->>'action' AS action FROM automation_batch_members m JOIN automation_event_facts f ON f.source_event_id=m.source_event_id`.execute(f.db)).rows;
    expect(actions).toEqual([{action:'move'},{action:'move'}]);
  });
  test('semantic revision edits retain old evidence but never mix its remainder into the new rule revision',async()=>{
    await setup();await add(2,9);
    const current=await f.app.inject({url:`/api/v1/me/automations/rules/${f.rule.id}`,headers:{cookie:f.owner.cookie}});
    const input={...f.ruleInput,definition:{...f.ruleInput.definition,priority:101}};
    const edited=await f.app.inject({method:'PUT',url:`/api/v1/me/automations/rules/${f.rule.id}`,headers:f.ownerHeaders(undefined,String(current.headers.etag)),payload:{...input,pendingRuns:'hold',counterPolicy:'resetOnSemanticChange'}});
    expect(edited.statusCode,edited.body).toBe(200);
    const preview=await f.ownerPost('/rules/preview',{rule:input,mode:'currentState'});expect(preview.statusCode,preview.body).toBe(200);
    expect((await f.ownerPost(`/rules/${f.rule.id}/lifecycle`,{state:'enabled',pendingRuns:'hold',reason:'New count revision',activationPreviewId:preview.json().previewId},String(edited.headers.etag))).statusCode).toBe(200);
    await add(10,10);expect(await runs()).toHaveLength(0);expect(await remainder()).toHaveLength(10);
    await add(11,19);expect(await runs()).toHaveLength(1);expect(await remainder()).toHaveLength(9);
  });
  test('concurrent boundary inspections cannot duplicate a batch; unavailable members never get substituted',async()=>{
    await setup();await add(2,9);
    await Promise.all([f.createNode('batch-10','root','Ten','https://arxiv.org/10'),f.createNode('batch-11','root','Eleven','https://arxiv.org/11')]);
    await Promise.all([f.inspect(),f.inspect()]);expect(await runs()).toHaveLength(1);expect(await remainder()).toHaveLength(1);
    const before=(await runs())[0]!.member_ids;
    await f.rename('fresh-paper','Edited after batch pin');
    expect((await f.work!.list(f.actor,{targetId:f.target.id})).items).toEqual([]);
    expect((await runs())[0]!.member_ids).toEqual(before);
    expect((await sql<{state:string}>`SELECT state FROM automation_jobs`.execute(f.db)).rows[0]?.state).toBe('stale');
    await expect(sql`UPDATE automation_batch_members SET member_json='{}' WHERE run_id IS NOT NULL`.execute(f.db)).rejects.toThrow('immutable');
  });
  test.each(['label','budget'] as const)('%s edits preserve the unfinished semantic batch',async kind=>{
    await setup();await add(2,9);
    if(kind==='budget'){
      const id=f.ruleInput.executionPolicyId!;
      const policy=await f.app.inject({url:`/api/v1/me/automations/execution-policies/${id}`,headers:{cookie:f.owner.cookie}});
      const configuration=policy.json().configuration;configuration.assignments[2].maxCalls=2;
      const edited=await f.app.inject({method:'PUT',url:`/api/v1/me/automations/execution-policies/${id}`,
        headers:f.ownerHeaders(undefined,String(policy.headers.etag)),payload:configuration});
      expect(edited.statusCode,edited.body).toBe(200);
    }else{
      const current=await f.app.inject({url:`/api/v1/me/automations/rules/${f.rule.id}`,headers:{cookie:f.owner.cookie}});
      const input={...f.ruleInput,definition:{...f.ruleInput.definition,name:'Label only'}};
      const edited=await f.app.inject({method:'PUT',url:`/api/v1/me/automations/rules/${f.rule.id}`,
        headers:f.ownerHeaders(undefined,String(current.headers.etag)),payload:{...input,pendingRuns:'continuePinned',counterPolicy:'resetOnSemanticChange'}});
      expect(edited.statusCode,edited.body).toBe(200);
      const p=await f.ownerPost('/rules/preview',{rule:input,mode:'currentState'});
      expect((await f.ownerPost(`/rules/${f.rule.id}/lifecycle`,{state:'enabled',pendingRuns:'continuePinned',reason:'Label refresh',activationPreviewId:p.json().previewId},String(edited.headers.etag))).statusCode).toBe(200);
    }
    await add(10,10);expect(await runs()).toHaveLength(1);expect(await remainder()).toHaveLength(0);
    expect((await runs())[0]!.member_ids).toHaveLength(10);
  });

  test('upgrade recognizes an unfinished legacy numeric-revision partition without replacing its members',async()=>{
    await setup();await add(2,9);
    const state=(await sql<{rule_revision_id:string;epoch:string;partition_key:string}>`SELECT rule_revision_id,epoch::text,partition_key FROM automation_aggregate_state`.execute(f.db)).rows[0]!;
    const legacy=automationDigest({kind:'rule',key:f.rule.id,binding:'1',policy:'1'});
    // Storage-version fixture: retain exact canonical events and member payloads;
    // only construct the pre-upgrade partition namespace before running real DDL.
    await f.db.transaction().execute(async tx=>{
      const members=(await sql<{distinct_key:string;source_event_id:string;member_json:unknown;created_at:Date}>`DELETE FROM automation_batch_members WHERE rule_revision_id=${state.rule_revision_id} RETURNING *`.execute(tx)).rows;
      await sql`UPDATE automation_aggregate_state SET partition_key=${legacy} WHERE rule_revision_id=${state.rule_revision_id}`.execute(tx);
      for(const member of members)await sql`INSERT INTO automation_batch_members(rule_revision_id,epoch,partition_key,distinct_key,source_event_id,member_json,created_at)
        VALUES(${state.rule_revision_id},${state.epoch}::bigint,${legacy},${member.distinct_key},${member.source_event_id},${JSON.stringify(member.member_json)}::jsonb,${member.created_at})`.execute(tx);
    });
    await removeAggregationMetadata(f.db);await upgradeAggregation(f.db);
    expect(await remainder()).toHaveLength(9);
    await add(10,10);expect(await runs()).toHaveLength(1);expect(await remainder()).toHaveLength(0);
    expect((await sql<{partition_key:string}>`SELECT DISTINCT partition_key FROM automation_batch_members`.execute(f.db)).rows).toEqual([{partition_key:legacy}]);
  });

  test('semantic binding round trips cannot resurrect an abandoned remainder',async()=>{
    f=await automationPollingFixture('batch_binding_epoch',{configure:(d,p)=>{
      delete d.intake;d.on='node.created';d.scope={folderRole:'academicRoot',includeDescendants:true};
      d.trigger={mode:'countBatch',count:2,distinctBy:'node',partition:'rule'};
      d.tasks[0]!.type='digest.generate';d.tasks[0]!.outputContract='digest.sourced.v1';p.assignments[2]!.taskType='digest.generate';
    }});
    await f.createNode('old-member','academic','Old','https://arxiv.org/old');await f.inspect();
    for(const destination of ['parent','academic']){
      const binding=await f.app.inject({url:`/api/v1/me/automations/binding-sets/${f.ruleInput.bindingSetId}`,headers:{cookie:f.owner.cookie}});
      const values=binding.json().values;values.academicRoot.folder.nodeId=destination;
      const saved=await f.app.inject({method:'PUT',url:`/api/v1/me/automations/binding-sets/${f.ruleInput.bindingSetId}`,
        headers:f.ownerHeaders(undefined,String(binding.headers.etag)),payload:{name:'Bound folders',values}});
      expect(saved.statusCode,saved.body).toBe(200);
      const rule=await f.app.inject({url:`/api/v1/me/automations/rules/${f.rule.id}`,headers:{cookie:f.owner.cookie}});
      const preview=await f.ownerPost('/rules/preview',{rule:f.ruleInput,mode:'currentState'});
      expect((await f.ownerPost(`/rules/${f.rule.id}/lifecycle`,{state:'enabled',pendingRuns:'hold',reason:'Changed scope',activationPreviewId:preview.json().previewId},String(rule.headers.etag))).statusCode).toBe(200);
    }
    await f.createNode('new-one','academic','One','https://arxiv.org/one');await f.inspect();expect(await runs()).toHaveLength(0);
    await f.createNode('new-two','academic','Two','https://arxiv.org/two');await f.inspect();expect(await runs()).toHaveLength(1);
    const members=(await sql<{node_id:string}>`SELECT f.node_id FROM automation_batch_members m JOIN automation_event_facts f ON f.source_event_id=m.source_event_id WHERE m.run_id IS NOT NULL`.execute(f.db)).rows;
    expect(members.map(m=>m.node_id).sort()).toEqual(['new-one','new-two']);
  });

});
