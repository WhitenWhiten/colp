import { seedClassificationTaxonomy } from '../../support/classification-database-fixture.js';
import { createPostgresClassificationRunRuntime } from '../../../src/infrastructure/collections/classification-run-runtime.js';
import { createClassificationRunJobs } from '../../../src/infrastructure/collections/classification-run-jobs.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test, expect } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresClassificationTaxonomyReadPort } from '../../../src/infrastructure/collections/classification-taxonomy-read.js';
import { loadClassificationContext } from '../../../src/modules/collections/application/classification-context.js';
import { createPostgresClassificationExecutionStore } from '../../../src/infrastructure/collections/classification-execution-postgres.js';
import { createBookmarkClassificationProvider } from '../../../src/infrastructure/collections/classification-provider-factory.js';
import { CLASSIFICATION_POLICY, classificationFailureReceipt, type ClassificationExecutionSeed } from '../../../src/modules/collections/index.js';
import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import { sql } from 'kysely';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('CLF-05 authoritative classification taxonomy', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('clf05_taxonomy', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180000);
  afterAll(async () => isolated?.close());

  const seed=(canonical=false,otherNodeId?:string,folderIdOverride?:string)=>seedClassificationTaxonomy(isolated.runtime,canonical,otherNodeId,folderIdOverride);

  async function executionSeed():Promise<ClassificationExecutionSeed>{
    const input=await seed();
    const document={source:'web' as const,nodeId:input.nodeId,requested:{folder:true,tags:false}};
    const context=await loadClassificationContext({...input,preview:document,tagsEnabled:false},createPostgresClassificationTaxonomyReadPort(isolated.runtime.db));
    return {binding:{principalId:input.collectionId,commandScope:'collections:classification-preview:v1',commandId:randomUUID()},
      collectionId:input.collectionId,ownerSubjectId:input.ownerSubjectId,requestId:randomUUID(),context:context!,
      fingerprint:canonicalCommandFingerprint({method:'POST',route:`/api/v1/collections/${input.collectionId}/classification/preview`,mediaType:'application/json',body:document}),
      providerId:'cloudflare_jev',model:'typesafe/jev',policyVersion:CLASSIFICATION_POLICY.version,promptVersion:CLASSIFICATION_POLICY.promptVersion,deadlineAt:new Date(Date.now()+20000).toISOString()};
  }

  test('batch restart retains the child failure code after its receipt committed before action publication',async()=>{
    for(const code of ['contract_drift','context_limit','budget_exhausted'] as const){
      const value=await executionSeed();let sent=0;
      const provider={...createBookmarkClassificationProvider(null),async classify(){sent++;throw new Error('must not resend');}};
      const options={enabled:()=>true,tagsEnabled:()=>false,onError:()=>{}};
      const first=createPostgresClassificationRunRuntime(isolated.runtime.db,provider,options);
      const input={actor:{principalId:value.binding.principalId,subjectId:value.ownerSubjectId},collectionId:value.collectionId,commandId:randomUUID(),requestId:randomUUID(),
        document:{nodeIds:[value.context.snapshot.node!.id],requested:{folder:true,tags:false},maxItems:1}};
      const created=await first.create(input);if(created.kind!=='replay')throw new Error('create failed');
      const runId=JSON.parse(Buffer.from(created.result.body).toString()).runId;
      const jobs=createClassificationRunJobs(isolated.runtime.db),job=(await jobs.lease(runId))!,action=(await jobs.actions(job))[0]!;
      await jobs.markRunning(job,action.action_id);
      const seed={...value,binding:{...value.binding,commandScope:'collections:classification-run-action:v1',commandId:action.execution_command_id},
        fingerprint:canonicalCommandFingerprint({method:'CLASSIFY',route:`${runId}/${action.action_id}`,mediaType:'application/json',body:{nodeId:action.node_id,etag:action.node_etag}})};
      const store=createPostgresClassificationExecutionStore(isolated.runtime.db),admission=await store.admit(seed);
      if(admission.kind!=='accepted')throw new Error('admission failed');
      await store.finish((await store.lease(admission.executionId))!,'failed',classificationFailureReceipt(seed.requestId,code),code);
      // Simulate process loss after durable child completion, before finishAction.
      await sql`UPDATE collection_classification_run_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=${runId}`.execute(isolated.runtime.db);
      const restarted=createPostgresClassificationRunRuntime(isolated.runtime.db,provider,options);restarted.start();
      try{await expect.poll(async()=> (await restarted.get({...input,runId})).actions[0]?.failureCode,{timeout:10000}).toBe(code);expect(sent).toBe(0);}
      finally{await restarted.stop();await first.stop();}
    }
  });
});
