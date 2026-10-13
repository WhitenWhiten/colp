import { afterEach,expect,test } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationDeviceFixture,AUTOMATION_DEVICE_ORIGIN } from '../../support/automation-device-fixture.js';
import { seedAutomationTarget } from '../../support/automation-target-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createAutomationUnitOfWork,createAutomationRuntime,createAutomationDeviceUnitOfWork } from '../../../src/infrastructure/automation/index.js';
import { createRule,saveBinding,saveExecutionPolicy,previewRule,setLifecycle,placementInputDigest,placementResultDigest } from '../../../src/modules/automation/index.js';
describeWithPostgres('count batch late canonical device completion',()=>{
  let f:Awaited<ReturnType<typeof automationDeviceFixture>>;
  afterEach(async()=>{await f?.isolated.close();});
  test('verified receipts after the source cursor passed still join one exact batch without fabricating a new canonical event',async()=>{
    f=await automationDeviceFixture('aw57_device');const uow=createAutomationUnitOfWork(f.db,'server',{runtimeEnabled:true,workerEnabled:true});
    await seedAutomationTarget(uow,f.owner);
    const configured=await uow.execute(f.owner,async ports=>{
      const executor=await ports.targets.executors.save({name:'Digest storage fixture',kind:'mcpEventsBot',dataLocation:'thirdParty',providerLabel:'Fixture only',capabilities:[],targetId:'target'});
      const binding=await saveBinding(ports,f.owner,{name:'Digest bindings',values:{...f.values,researchEnricher:{kind:'executor',executorId:executor.id}}});
      const p=JSON.parse(readFileSync('../../docs/automation/design/examples/execution-policy.json','utf8'));p.assignments=[{...p.assignments[2],taskType:'digest.generate',allowedDestinations:[executor.id]}];
      const policy=await saveExecutionPolicy(ports.policies,p);
      const definition=JSON.parse(readFileSync('../../docs/automation/design/examples/ten-bookmark-digest.json','utf8'));
      definition.scope.collectionId='collection';definition.route.targetIds=['target'];definition.trigger.count=2;
      const input={definition,bindingSetId:binding.id,executionPolicyId:policy.id},rule=await createRule(ports,f.owner,input);
      const preview=await previewRule(ports,f.owner,{rule:input,mode:'currentState'});
      await setLifecycle(ports,f.owner,rule.id,{state:'enabled',pendingRuns:'hold',reason:'Late completion fixture',activationPreviewId:preview.previewId},`"${rule.revision}"`);return rule;
    });
    const devices=createAutomationDeviceUnitOfWork(f.db,'server'),identity={credential:f.http.credential,sessionId:f.sessionId,origin:AUTOMATION_DEVICE_ORIGIN};
    const bundle=await devices.execute(identity,p=>p.bundle('browser-bounded-v1'));
    await f.syncCreate('late-a','late-op-a');await f.syncCreate('late-b','late-op-b');
    await f.inspect(createAutomationRuntime('server',true));
    expect((await sql`SELECT id FROM automation_runs WHERE kind='batch'`.execute(f.db)).rows).toEqual([]);
    for(const suffix of ['a','b']){
      const input={deviceId:f.replica.deviceId,replicaGeneration:Number(f.replica.leaseGeneration),localReceiptId:randomUUID(),operationId:'late-op-'+suffix,
        ruleId:f.rule.id,ruleRevision:'1',bindingRevision:'1',bundleRevision:bundle.revision,committedNode:{serverUuid:'server',collectionId:'collection',nodeId:'late-'+suffix},
        satisfiedTaskTypes:['classify.root' as const],resultDigests:[placementResultDigest(f.folder)]};
      const receipt={...input,inputDigest:placementInputDigest(input,{url:'https://arxiv.org/sync',title:'Sync paper',tags:[]})};
      expect((await devices.execute(identity,p=>p.accept(receipt))).state).toBe('accepted');
      expect((await devices.execute(identity,p=>p.accept(receipt))).state).toBe('accepted');
    }
    await f.inspect(createAutomationRuntime('server',true));await f.inspect(createAutomationRuntime('server',true));
    const batches=(await sql<{member_ids:string[]}>`SELECT member_ids FROM automation_runs WHERE kind='batch' AND rule_revision_id IN (SELECT id FROM automation_rule_revisions WHERE rule_id=${configured.id})`.execute(f.db)).rows;
    expect(batches).toHaveLength(1);expect(batches[0]!.member_ids).toHaveLength(2);
    expect((await sql`SELECT id FROM automation_jobs WHERE run_id IN (SELECT id FROM automation_runs WHERE kind='batch')`.execute(f.db)).rows).toHaveLength(1);
  });
});
