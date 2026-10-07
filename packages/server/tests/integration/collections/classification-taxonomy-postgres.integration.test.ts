import { seedClassificationTaxonomy, seedCanonicalClassificationFixture } from '../../support/classification-database-fixture.js';

import { createPostgresClassificationRunRuntime } from '../../../src/infrastructure/collections/classification-run-runtime.js';
import { createClassificationRunJobs } from '../../../src/infrastructure/collections/classification-run-jobs.js';
import { ClassificationProviderError, type BookmarkClassificationProvider } from '../../../src/modules/collections/index.js';
import { observeClassificationWork } from '../../../src/infrastructure/collections/classification-metrics.js';
import { classificationHttpHarness, classificationAuthHeaders } from '../../support/classification-http-harness.js';

import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test, expect } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresClassificationTaxonomyReadPort } from '../../../src/infrastructure/collections/classification-taxonomy-read.js';
import { loadClassificationContext } from '../../../src/modules/collections/application/classification-context.js';
import { createPostgresClassificationSettingsRuntime } from '../../../src/infrastructure/collections/classification-settings-postgres.js';
import { updateClassificationSettings, classificationSettingsEtag } from '../../../src/modules/collections/application/classification-settings.js';
import { createPostgresClassificationExecutionStore } from '../../../src/infrastructure/collections/classification-execution-postgres.js';
import { createPostgresClassificationRuntime } from '../../../src/infrastructure/collections/classification-runtime.js';
import { createCloudflareJevClassificationProvider, createCloudflareUpstream } from '../../../src/infrastructure/collections/classification-provider-cloudflare-jev.js';
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

  test('browser role metadata promotes topic folders and samples existing bookmarks without using the target itself', async () => {
    const input = await seedCanonicalClassificationFixture(isolated.runtime);
    await sql`UPDATE nodes SET payload_json=jsonb_set(payload_json, '{folderRole}', '"other-bookmarks"'::jsonb) WHERE id=${input.folderId}`.execute(isolated.runtime.db);
    const reads = createPostgresClassificationTaxonomyReadPort(isolated.runtime.db);
    const context = await loadClassificationContext({ ...input, tagsEnabled: false,
      preview: { source: 'extension', nodeId: input.nodeId, requested: { folder: true, tags: false } } }, reads);
    expect(context?.candidates?.l1.map(folder => folder.id)).toEqual([`deep-${input.collectionId}`]);
    expect(context?.candidates?.l1[0]).toMatchObject({ parentId: input.folderId, depth: 2,
      bookmarkExamples: [{ title: 'Another', hostname: 'example.org', bookmarkId: input.otherNodeId }] });
    const withoutSelf = await reads.loadSnapshot({ ...input, nodeId: input.otherNodeId });
    expect(withoutSelf?.folders.find(folder => folder.id === `deep-${input.collectionId}`)?.bookmarkExamples).toBeUndefined();
  });

  test('owner snapshot filters root/deleted nodes, includes Description and exact live-bookmark vocabulary', async () => {
    const input = await seed(); const reads = createPostgresClassificationTaxonomyReadPort(isolated.runtime.db);
    const snapshot = await reads.loadSnapshot(input);
    expect(snapshot?.folders).toHaveLength(2);
    expect(snapshot?.folders.find(f => f.id === input.folderId)).toMatchObject({parentId: null, description: 'folder scope'});
    expect(snapshot?.tagUsage).toEqual([{tag: 'AI', count: 2}, {tag: 'ai', count: 1}]);
    expect(snapshot?.node).toMatchObject({description: 'bookmark description', resourceRevision: 'r1', tags: ['AI', 'ai']});
    expect(snapshot?.contentRevision).toBe('c1'); expect(snapshot?.summary).toBe('collection scope');
    const context = await loadClassificationContext({ ...input, tagsEnabled: true, preview: {source: 'web', nodeId: input.nodeId, requested: {folder: true, tags: true}} }, reads);
    expect(context?.candidates?.tags).toEqual([]); // Already present, not proposed again.
    expect(context?.bookmark.title).toBe('AI resource');
    const off = await loadClassificationContext({ ...input, tagsEnabled: false, preview: {source: 'web', nodeId: input.nodeId, requested: {folder: false, tags: true}} }, reads);
    expect(off?.candidates).toBeNull(); expect(off?.requested).toEqual({folder: false, tags: false});
  });

  test('nonowners, deleted collections, foreign or nonbookmark node IDs cannot expose context', async () => {
    const input = await seed(); const foreign = await seed();
    const reads = createPostgresClassificationTaxonomyReadPort(isolated.runtime.db);
    for (const role of ['editor', 'viewer'] as const) {
      await isolated.runtime.db.insertInto('collection_members').values({collection_id: input.collectionId, subject_id: `${role}-${input.collectionId}`, role, granted_at: new Date()}).execute();
      expect(await reads.loadSnapshot({...input, ownerSubjectId: `${role}-${input.collectionId}`})).toBeNull();
    }
    expect(await reads.loadSnapshot({...input, ownerSubjectId: foreign.ownerSubjectId})).toBeNull();
    expect(await reads.loadSnapshot({...input, nodeId: foreign.nodeId})).toBeNull();
    expect(await reads.loadSnapshot({...input, nodeId: input.folderId})).toBeNull();
    await isolated.runtime.db.transaction().execute(async transaction => {
      const deleted_at = new Date();
      await transaction.updateTable('collections').set({deleted_at}).where('id','=',input.collectionId).execute();
      await transaction.updateTable('nodes').set({deleted_at}).where('collection_id','=',input.collectionId).execute();
    });
    expect(await reads.loadSnapshot(input)).toBeNull();
  });

  test('concurrent metadata/tag changes do not mix revisions; read does not hold collection row lock', async () => {
    const input = await seed();
    const reads = createPostgresClassificationTaxonomyReadPort(isolated.runtime.db, { faultInjector: { async afterCollectionRead() {
      await isolated.runtime.db.transaction().execute(async transaction => {
        await transaction.updateTable('collections').set({content_revision: 'c2', summary: 'new scope'}).where('id','=',input.collectionId).execute();
        await transaction.updateTable('nodes').set({description: 'new description', tags: JSON.stringify(['new-tag']), resource_revision: 'r2'}).where('id','=',input.nodeId).execute();
      });
    } } });
    const snapshot = await reads.loadSnapshot(input);
    expect(snapshot?.contentRevision).toBe('c1'); expect(snapshot?.summary).toBe('collection scope');
    expect(snapshot?.node?.resourceRevision).toBe('r1'); expect(snapshot?.node?.tags).toEqual(['AI','ai']);
    const current = await createPostgresClassificationTaxonomyReadPort(isolated.runtime.db).loadSnapshot(input);
    expect(current?.contentRevision).toBe('c2'); expect(current?.node?.tags).toEqual(['new-tag']);
  });

  test('aggregate byte overflow is rejected, never reported as partial taxonomy', async () => {
    const input = await seed();
    // Existing field caps allow enough legitimate nodes to exceed the aggregate.
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO resource_id_ledger(resource_id,resource_type) SELECT $1 || '-large-' || n,'node' FROM generate_series(1,600) n", [input.collectionId]);
      await client.query(`INSERT INTO nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,resource_revision,children_revision)
        SELECT $1 || '-large-' || n,$1,$2,'bookmark',false,'large','https://example.org/',repeat('a',4000),'[]','inherit','z' || lpad(n::text,5,'0') || 'V','r1','ch1' FROM generate_series(1,600) n`, [input.collectionId, input.root]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await expect(createPostgresClassificationTaxonomyReadPort(isolated.runtime.db).loadSnapshot(input)).rejects.toMatchObject({code: 'payload_too_large'});
  });

  test('10001-node sentinel rejects excess tree instead of silently losing candidates', async () => {
    const input = await seed(); const client = await isolated.runtime.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO resource_id_ledger(resource_id,resource_type) SELECT $1 || '-n-' || n,'node' FROM generate_series(1,10000) n", [input.collectionId]);
      await client.query(`INSERT INTO nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,resource_revision,children_revision)
        SELECT $1 || '-n-' || n,$1,$2,'folder',false,'x',null,null,null,'inherit','z' || lpad(n::text,5,'0') || 'V','r1','ch1' FROM generate_series(1,10000) n`, [input.collectionId, input.root]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await expect(createPostgresClassificationTaxonomyReadPort(isolated.runtime.db).loadSnapshot(input)).rejects.toMatchObject({code: 'payload_too_large'});
  });

  test('settings virtual default, concurrent first PATCH CAS, exact replay and context consumer share real persistence', async () => {
    const input = await seed(); const runtime = createPostgresClassificationSettingsRuntime(isolated.runtime.db);
    const defaults = await runtime.reads.loadOwned(input);
    expect(defaults).toMatchObject({revision: '0', autoTagMode: 'suggest', executionMode: 'server_managed', providerProfileId: null});
    const command = {actor: {principalId: input.collectionId, subjectId: input.ownerSubjectId}, collectionId: input.collectionId,
      commandId: randomUUID(), ifMatch: classificationSettingsEtag(defaults!), patch: {autoTagMode: 'suggest' as const}};
    const concurrent = await Promise.allSettled([command, {...command, commandId: randomUUID()}].map(c => runtime.commands.execute(ports => updateClassificationSettings(ports, c))));
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = concurrent.findIndex(result => result.status === 'fulfilled');
    // The second command's UUID need not be exposed to assert persistence; use
    // a separate known command to check exact replay after another revision.
    expect(winner).toBeGreaterThanOrEqual(0);
    const current = await runtime.reads.loadOwned(input);
    expect(current?.revision).toBe('1'); expect(current?.autoTagMode).toBe('suggest');
    const known = {...command, commandId: randomUUID(), ifMatch: classificationSettingsEtag(current!), patch: {maxAutoTags: 2}};
    const first = await runtime.commands.execute(ports => updateClassificationSettings(ports, known));
    expect(first.kind).toBe('succeeded');
    const updated = await runtime.reads.loadOwned(input);
    await runtime.commands.execute(ports => updateClassificationSettings(ports, {...known, commandId: randomUUID(), ifMatch: classificationSettingsEtag(updated!), patch: {maxAutoTags: 1}}));
    const replay = await runtime.commands.execute(ports => updateClassificationSettings(ports, known));
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') expect(JSON.parse(Buffer.from(replay.body).toString()).maxAutoTags).toBe(2);
    const context = await loadClassificationContext({...input, tagsEnabled: true, preview:{source:'extension', bookmark:{title:'incoming',url:'https://example.org/',description:null}, requested:{folder:false,tags:true}}}, createPostgresClassificationTaxonomyReadPort(isolated.runtime.db));
    expect(context?.candidates?.tags).toEqual(['AI','ai']);
    expect(context?.snapshot.settings.maxAutoTags).toBe(1);
    const reused = await runtime.commands.execute(ports => updateClassificationSettings(ports, {...known, patch:{maxAutoTags:0}}));
    expect(reused.kind).toBe('reused');
  });

  test('a rate-limited retry is persisted as a second dispatch of the same logical call', async () => {
    const {store,lease}=await admitted();
    await store.prepare(lease,'l1',0,'digest');await store.dispatch(lease,'l1',0);
    const dispatched=await isolated.runtime.db.selectFrom('classification_call_attempts').select('attempt_number')
      .where('execution_id','=',lease.id).where('stage','=','l1').executeTakeFirstOrThrow();
    expect(dispatched.attempt_number).toBe(1);
    await store.completeCall(lease,'l1',0,{answer:{folderId:null},modelVersion:'jev-1.13.0',inputTokens:10,outputTokens:1,attemptNumber:2});
    const retried=await isolated.runtime.db.selectFrom('classification_call_attempts').select(['state','attempt_number'])
      .where('execution_id','=',lease.id).where('stage','=','l1').executeTakeFirstOrThrow();
    expect(retried).toEqual({state:'succeeded',attempt_number:2});
  });

  async function executionSeed():Promise<ClassificationExecutionSeed>{
    const input=await seed();
    const document={source:'web' as const,nodeId:input.nodeId,requested:{folder:true,tags:false}};
    const context=await loadClassificationContext({...input,preview:document,tagsEnabled:false},createPostgresClassificationTaxonomyReadPort(isolated.runtime.db));
    return {binding:{principalId:input.collectionId,commandScope:'collections:classification-preview:v1',commandId:randomUUID()},
      collectionId:input.collectionId,ownerSubjectId:input.ownerSubjectId,requestId:randomUUID(),context:context!,
      fingerprint:canonicalCommandFingerprint({method:'POST',route:`/api/v1/collections/${input.collectionId}/classification/preview`,mediaType:'application/json',body:document}),
      providerId:'cloudflare_jev',model:'typesafe/jev',policyVersion:CLASSIFICATION_POLICY.version,promptVersion:CLASSIFICATION_POLICY.promptVersion,deadlineAt:new Date(Date.now()+20000).toISOString()};
  }
  async function admitted(){
    const seed=await executionSeed(),store=createPostgresClassificationExecutionStore(isolated.runtime.db);
    const admission=await store.admit(seed);if(admission.kind!=='accepted')throw new Error('admission failed');
    const lease=await store.lease(admission.executionId);if(!lease)throw new Error('lease failed');
    return {seed,store,lease};
  }

  test('execution claim and input snapshot roll back together before commit',async()=>{
    const value=await executionSeed();
    const broken=createPostgresClassificationExecutionStore(isolated.runtime.db,{faultInjector:{afterCallbackBeforeCommit(){throw new Error('simulated crash');}}});
    await expect(broken.admit(value)).rejects.toThrow('simulated crash');
    expect(await isolated.runtime.db.selectFrom('product_command_receipts').select('command_id').where('command_id','=',value.binding.commandId).execute()).toHaveLength(0);
    expect(await isolated.runtime.db.selectFrom('classification_provider_executions').select('id').where('command_id','=',value.binding.commandId).execute()).toHaveLength(0);
  });

  test('dispatch crash, independent-store lease takeover and stale result cannot cause a second call',async()=>{
    const {seed,store,lease}=await admitted();
    await store.prepare(lease,'l1',0,'digest');await store.dispatch(lease,'l1',0);
    await sql`UPDATE classification_provider_executions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${lease.id}`.execute(isolated.runtime.db);
    const restarted=createPostgresClassificationExecutionStore(isolated.runtime.db);const newer=await restarted.lease(lease.id);expect(newer).not.toBeNull();
    await expect(restarted.prepare(newer!,'l1',0,'digest')).rejects.toMatchObject({code:'outcome_unknown'});
    expect(await store.heartbeat(lease)).toBe(false);
    await expect(store.completeCall(lease,'l1',0,{answer:{},modelVersion:'jev-1.13.0',inputTokens:10,outputTokens:1})).rejects.toMatchObject({code:'lease_lost'});
    await restarted.finish(newer!,'outcome_unknown',classificationFailureReceipt(seed.requestId,'outcome_unknown'));
    const replay=await restarted.lookup(seed);expect(replay?.kind).toBe('replay');
    if(replay?.kind==='replay')expect(replay.result.status).toBe(503);
    const attempt=await isolated.runtime.db.selectFrom('classification_call_attempts').selectAll().where('execution_id','=',lease.id).executeTakeFirstOrThrow();
    expect(attempt.state).toBe('unknown');expect(attempt.attempt_number).toBe(1);expect(String(attempt.settled_microusd)).toBe('2000');
  });

  test('successful stage survives restart, changed input is refused, and reaper keeps terminal receipt',async()=>{
    const {seed,store,lease}=await admitted();const result={answer:{folderId:null},modelVersion:'jev-1.13.0',inputTokens:10,outputTokens:1};
    await store.prepare(lease,'l1',0,'digest');await store.dispatch(lease,'l1',0);await store.completeCall(lease,'l1',0,result);
    await sql`UPDATE classification_provider_executions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${lease.id}`.execute(isolated.runtime.db);
    const restarted=createPostgresClassificationExecutionStore(isolated.runtime.db),newer=(await restarted.lease(lease.id))!;
    expect(await restarted.prepare(newer,'l1',0,'digest')).toEqual(result);
    await expect(restarted.prepare(newer,'l1',0,'other')).rejects.toMatchObject({code:'contract_drift'});
    await sql`UPDATE classification_provider_executions SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=${lease.id}`.execute(isolated.runtime.db);
    await restarted.reap();expect((await restarted.lookup(seed))?.kind).toBe('replay');
    await sql`UPDATE classification_provider_executions SET completed_at=clock_timestamp()-interval '31 minutes' WHERE id=${lease.id}`.execute(isolated.runtime.db);
    await restarted.reap();
    expect((await isolated.runtime.db.selectFrom('classification_provider_executions').select('input_json').where('id','=',lease.id).executeTakeFirstOrThrow()).input_json).toBeNull();
    expect((await restarted.lookup(seed))?.kind).toBe('replay');
  });

  test('shared account/profile in-flight admission caps calls and refunds proven rejection',async()=>{
    const value=await executionSeed(),store=createPostgresClassificationExecutionStore(isolated.runtime.db),other=createPostgresClassificationExecutionStore(isolated.runtime.db);
    const leases=[];
    for(let i=0;i<5;i++){
      const next={...value,binding:{...value.binding,commandId:randomUUID()}};
      const accepted=await store.admit(next);if(accepted.kind!=='accepted')throw new Error('admission failed');
      const lease=(await other.lease(accepted.executionId))!;leases.push(lease);await other.prepare(lease,'l1',0,'digest');
      if(i<4)await other.dispatch(lease,'l1',0);else await expect(other.dispatch(lease,'l1',0)).rejects.toMatchObject({code:'budget_exhausted'});
    }
    await store.rejectCall(leases[0]!,'l1',0,true);await other.dispatch(leases[4]!,'l1',0);
    for(const lease of leases)await store.finish(lease,'failed',classificationFailureReceipt(value.requestId,'disabled'));
    const budget=(await sql<{spent:string}>`SELECT spent_microusd::text AS spent FROM classification_spend_budgets WHERE scope=${`account:${value.binding.principalId}`}`.execute(isolated.runtime.db)).rows[0];
    expect(budget?.spent).toBe('8000');
  });

  test('two real HTTP processes share the four-call quota and expose bounded execution gauges',async()=>{
    const value=await executionSeed();
    const children=[0,1].map(()=>fork(new URL('../../support/classification-crash-worker.ts',import.meta.url),[],
      {execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']}));
    const requests:Promise<Response|null>[]=[];
    try{
      const addresses=await Promise.all(children.map(async child=>{
        const ready=once(child,'message');
        child.send({databaseUrl:isolated.databaseUrl,principalId:value.binding.principalId,subjectId:value.ownerSubjectId,holdFirst:true});
        const [message]=await ready;expect(message.kind).toBe('ready');return message.address as string;
      }));
      const path=`/api/v1/collections/${value.collectionId}/classification/preview`;
      const body=JSON.stringify({source:'web',nodeId:value.context.snapshot.node!.id,requested:{folder:true,tags:false}});
      for(let i=0;i<6;i++){
        requests.push(fetch(addresses[i%2]+path,{method:'POST',
          headers:{...classificationAuthHeaders,'known-command-id':randomUUID(),'content-type':'application/json'},body}).catch(()=>null));
        // Fill each reservation before racing overflow requests; transient advisory-lock
        // contention may reject admission before the numerical limit is reached.
        if(i<4)await expect.poll(async()=>Number((await sql<{n:string}>`SELECT count(*)::text AS n FROM classification_call_attempts a
          JOIN classification_provider_executions e ON e.id=a.execution_id WHERE e.principal_id=${value.binding.principalId}
          AND a.state='dispatching'`.execute(isolated.runtime.db)).rows[0]!.n),{timeout:1000,intervals:[20,50]}).toBe(i+1);
      }
      const gauges:Record<string,number>={};await observeClassificationWork(isolated.runtime.db,(name,value)=>{gauges[name]=value;});
      expect(gauges['classification.execution.calls']).toBe(4);
      expect(gauges['classification.execution.running']).toBeGreaterThanOrEqual(4);
      expect(Object.keys(gauges)).toEqual(expect.arrayContaining(['classification.execution.pending','classification.execution.overdue']));
      const results=await Promise.all(requests);
      expect(results.every(response=>response?.status===503)).toBe(true);
      const attempts=(await sql<{n:string}>`SELECT count(*)::text AS n FROM classification_call_attempts a
        JOIN classification_provider_executions e ON e.id=a.execution_id WHERE e.principal_id=${value.binding.principalId}
        AND a.attempt_number=1`.execute(isolated.runtime.db)).rows[0]!;
      expect(Number(attempts.n)).toBe(4);
      const spend=(await sql<{spent:string}>`SELECT spent_microusd::text AS spent FROM classification_spend_budgets
        WHERE scope=${`account:${value.binding.principalId}`}`.execute(isolated.runtime.db)).rows[0]!;
      expect(spend.spent).toBe('8000'); // Timeouts after dispatch are not proven unaccepted.
    }finally{
      await Promise.all(children.map(async child=>{if(child.exitCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}}));
      await Promise.allSettled(requests);
      await sql`UPDATE classification_provider_executions SET deadline_at=clock_timestamp()-interval '1 second'
        WHERE principal_id=${value.binding.principalId} AND state IN ('pending','running')`.execute(isolated.runtime.db);
      await createPostgresClassificationExecutionStore(isolated.runtime.db).reap();
    }
  },30000);

  test('HTTP production adapter executes durable stages, writes no Nodes and exact-replays after Node deletion',async()=>{
    const value=await executionSeed();let calls=0;
    const transport:typeof fetch=async(_url,init)=>{
      calls++;const body=JSON.parse(String(init?.body));const questions=body.input.questions;
      const keys=Object.keys(questions.folder.criteria);const chosen=keys.find(k=>k==='f0')!;
      const answers:Record<string,unknown>={folder:{choice:chosen,confidence:0.95,probabilities:Object.fromEntries(keys.map(k=>[k,k===chosen?0.95:0.05]))}};
      if(questions.specific)answers.specific={noul:0.95};
      const active=await isolated.runtime.db.selectFrom('classification_call_attempts').select('state').where('state','=','dispatching').execute();expect(active.length).toBeGreaterThan(0);
      // Independent write can acquire the collection lock while the provider is awaited.
      await isolated.runtime.db.transaction().execute(async tx=>{await tx.selectFrom('collections').select('id').where('id','=',value.collectionId).forUpdate().execute();});
      return Response.json({success:true,result:{model:'jev-1.13.0',answers,usage:{input_tokens:100,output_tokens:10}}});
    };
    const provider=createCloudflareJevClassificationProvider(createCloudflareUpstream({accountId:'a'.repeat(32),gatewayId:'test',accessKey:'test-only-secret',expectedModelVersion:'jev-1.13.0'}),transport);
    const runtime=createPostgresClassificationRuntime(isolated.runtime.db,provider,{enabled:true,tagsEnabled:false,onError:()=>{}});
    const request={actor:{principalId:value.binding.principalId,subjectId:value.ownerSubjectId},collectionId:value.collectionId,commandId:value.binding.commandId,requestId:value.requestId,
      document:{source:'web',nodeId:value.context.snapshot.node!.id,requested:{folder:true,tags:false}}};
    const before=await isolated.runtime.db.selectFrom('nodes').select(['id','resource_revision','parent_id','tags']).where('collection_id','=',value.collectionId).orderBy('id').execute();
    const app=classificationHttpHarness(runtime,{principalId:value.binding.principalId,subjectId:value.ownerSubjectId});
    const http={method:'POST' as const,url:`/api/v1/collections/${value.collectionId}/classification/preview`,headers:{...classificationAuthHeaders,'known-command-id':request.commandId},payload:request.document};
    const result=await app.inject(http);expect(result.statusCode).toBe(200);expect(result.json().folder.decision).toBe('l2');
    const reused=await app.inject({...http,payload:{...request.document,requested:{folder:true,tags:true}}});
    expect(reused.statusCode).toBe(409);expect(reused.json().error.code).toBe('command_id_reused');
    expect(calls).toBe(2);
    expect(await isolated.runtime.db.selectFrom('nodes').select(['id','resource_revision','parent_id','tags']).where('collection_id','=',value.collectionId).orderBy('id').execute()).toEqual(before);
    await isolated.runtime.db.updateTable('nodes').set({deleted_at:new Date()}).where('id','=',value.context.snapshot.node!.id).execute();
    const replay=await app.inject(http);expect(replay.statusCode).toBe(200);expect(replay.body).toBe(result.body);
    expect(replay.headers['content-type']).toBe(result.headers['content-type']);expect(replay.headers['cache-control']).toBe('private, no-store');expect(calls).toBe(2);
    await app.close();
    const stored=await isolated.runtime.db.selectFrom('classification_provider_executions').select('input_json').where('command_id','=',value.binding.commandId).executeTakeFirstOrThrow();
    expect(JSON.stringify(stored)).not.toContain('test-only-secret');await runtime.stop();
  });

  test('deadline reaper atomically closes an ambiguous dispatch and rejects a late completion',async()=>{
    const {seed,store,lease}=await admitted();await store.prepare(lease,'l1',0,'digest');await store.dispatch(lease,'l1',0);
    await sql`UPDATE classification_provider_executions SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=${lease.id}`.execute(isolated.runtime.db);
    expect(await store.reap()).toBeGreaterThan(0);
    expect((await isolated.runtime.db.selectFrom('classification_provider_executions').select('state').where('id','=',lease.id).executeTakeFirstOrThrow()).state).toBe('outcome_unknown');
    await expect(store.completeCall(lease,'l1',0,{answer:{},modelVersion:'jev-1.13.0',inputTokens:10,outputTokens:1})).rejects.toMatchObject({code:'lease_lost'});
    const replay=await store.lookup(seed);expect(replay?.kind).toBe('replay');if(replay?.kind==='replay')expect(replay.result.status).toBe(503);
  });

  test('completion crash cannot commit terminal execution without its receipt',async()=>{
    const {seed,store,lease}=await admitted();await store.prepare(lease,'l1',0,'digest');await store.dispatch(lease,'l1',0);
    await store.completeCall(lease,'l1',0,{answer:{},modelVersion:'jev-1.13.0',inputTokens:10,outputTokens:1});
    const broken=createPostgresClassificationExecutionStore(isolated.runtime.db,{faultInjector:{afterCallbackBeforeCommit(){throw new Error('completion crash');}}});
    await expect(broken.finish(lease,'failed',classificationFailureReceipt(seed.requestId,'disabled'))).rejects.toThrow('completion crash');
    expect((await isolated.runtime.db.selectFrom('classification_provider_executions').select('state').where('id','=',lease.id).executeTakeFirstOrThrow()).state).toBe('running');
    expect((await store.lookup(seed))?.kind).toBe('in_progress');
    await store.finish(lease,'failed',classificationFailureReceipt(seed.requestId,'disabled'));expect((await store.lookup(seed))?.kind).toBe('replay');
  });

  test('tags-off preview needs no provider credentials or billable attempts',async()=>{
    const value=await executionSeed(),settings=createPostgresClassificationSettingsRuntime(isolated.runtime.db);
    const owned=await settings.reads.loadOwned({collectionId:value.collectionId,ownerSubjectId:value.ownerSubjectId});
    expect((await settings.commands.execute(ports=>updateClassificationSettings(ports,{actor:{principalId:value.collectionId,subjectId:value.ownerSubjectId},
      collectionId:value.collectionId,commandId:randomUUID(),ifMatch:classificationSettingsEtag(owned!),patch:{autoTagMode:'off'}}))).kind).toBe('succeeded');
    const runtime=createPostgresClassificationRuntime(isolated.runtime.db,createBookmarkClassificationProvider(null),{enabled:true,tagsEnabled:true,onError:()=>{}});
    const result=await runtime.preview({actor:{principalId:value.binding.principalId,subjectId:value.ownerSubjectId},collectionId:value.collectionId,
      commandId:value.binding.commandId,requestId:value.requestId,document:{source:'web',nodeId:value.context.snapshot.node!.id,requested:{folder:false,tags:true}}});
    expect(result.kind).toBe('replay');if(result.kind==='replay'){
      expect(result.result.status).toBe(200);expect(JSON.parse(Buffer.from(result.result.body).toString()).tags).toMatchObject({mode:'off',candidates:[]});
    }
    const attempts=await isolated.runtime.db.selectFrom('classification_call_attempts as a').innerJoin('classification_provider_executions as e','e.id','a.execution_id').select('a.stage').where('e.collection_id','=',value.collectionId).execute();
    expect(attempts).toHaveLength(0);await runtime.stop();
  });

  test('admission cancellation stops the actual PostgreSQL statement without leaving a claim',async()=>{
    const value=await executionSeed(),controller=new AbortController();
    const store=createPostgresClassificationExecutionStore(isolated.runtime.db,{signal:controller.signal,cancelBackend:isolated.runtime.cancelBackend,
      faultInjector:{async beforeCallback(tx){await sql`SELECT pg_sleep(3)`.execute(tx);}}});
    const timeout=setTimeout(()=>controller.abort(new Error('preview deadline')),100);
    const started=Date.now();
    try{await expect(store.lookup(value)).rejects.toThrow('preview deadline');}finally{clearTimeout(timeout);}
    expect(Date.now()-started).toBeLessThan(2000);
    expect(await isolated.runtime.db.selectFrom('product_command_receipts').select('command_id').where('command_id','=',value.binding.commandId).execute()).toHaveLength(0);
  });
  test('SIGKILL after HTTP L2 dispatch preserves L1 and converges to a stable receipt without resending',async()=>{
    const value=await executionSeed();
    const child=fork(new URL('../../support/classification-crash-worker.ts',import.meta.url),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
    let errors='';child.stderr?.on('data',data=>{errors+=String(data);});
    const message=()=>Promise.race([once(child,'message').then(([value])=>value as {kind:string;address?:string}),
      once(child,'exit').then(()=>{throw new Error(`Worker exited: ${errors}`);})]);
    const ready=message();child.send({databaseUrl:isolated.databaseUrl,principalId:value.binding.principalId,subjectId:value.ownerSubjectId});
    let runtime:ReturnType<typeof createPostgresClassificationRuntime>|undefined;
    let app:ReturnType<typeof classificationHttpHarness>|undefined;
    try{
      const started=await ready;expect(started.kind).toBe('ready');
      const dispatched=message();
      const path=`/api/v1/collections/${value.collectionId}/classification/preview`;
      const headers={...classificationAuthHeaders,'known-command-id':value.binding.commandId,'content-type':'application/json'};
      const payload={source:'web',nodeId:value.context.snapshot.node!.id,requested:{folder:true,tags:false}};
      const disconnected=fetch(started.address+path,{method:'POST',headers,body:JSON.stringify(payload)}).catch(()=>null);
      expect((await dispatched).kind).toBe('dispatch');
      const exited=once(child,'exit');child.kill('SIGKILL');await exited;expect(await disconnected).toBeNull();
      const attempts=await isolated.runtime.db.selectFrom('classification_call_attempts').select(['stage','state'])
        .where('execution_id','in',isolated.runtime.db.selectFrom('classification_provider_executions').select('id').where('command_id','=',value.binding.commandId)).orderBy('stage').execute();
      expect(attempts).toEqual([{stage:'l1',state:'succeeded'},{stage:'l2',state:'dispatching'}]);
      let sent=0;
      const provider={...createBookmarkClassificationProvider(null),async classify(){sent++;throw new Error('must not resend');}};
      runtime=createPostgresClassificationRuntime(isolated.runtime.db,provider,{enabled:true,tagsEnabled:false,onError:()=>{}});
      runtime.start();app=classificationHttpHarness(runtime,{principalId:value.binding.principalId,subjectId:value.ownerSubjectId});
      const request={method:'POST' as const,url:path,headers,payload};
      const pending=await app.inject(request);expect(pending.statusCode).toBe(409);expect(pending.json().error.code).toBe('command_in_progress');
      await expect.poll(async()=>{const result=await app!.inject(request);return result.statusCode;},{timeout:30000,interval:500}).toBe(503);
      const terminal=await app.inject(request),replay=await app.inject(request);
      expect(terminal.json().error.sameRequestRetrySafe).toBe(false);expect(replay.body).toBe(terminal.body);expect(sent).toBe(0);
      const count=await isolated.runtime.db.selectFrom('classification_call_attempts').select('attempt_number')
        .where('execution_id','in',isolated.runtime.db.selectFrom('classification_provider_executions').select('id').where('command_id','=',value.binding.commandId)).execute();
      expect(count.map(a=>a.attempt_number)).toEqual([1,1]);
    }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await app?.close();await runtime?.stop();}
  },45000);

  test('batch create queues without provider work, durable workers publish results and TTL preserves the original receipt',async()=>{
    const value=await executionSeed();let calls=0;
    const provider:BookmarkClassificationProvider={...createBookmarkClassificationProvider(null),async classify(input,execution){
      calls++;
      const answer={folderId:null,confidence:1,probabilities:[...input.candidates!.l1.map(folder=>({folderId:folder.id,probability:0})),{folderId:null,probability:1}]};
      const result=await execution.calls.run('l1',0,{fixture:'batch'},async()=>({answer,modelVersion:'fixture',inputTokens:0,outputTokens:0}));
      return {l1:result.answer,l2:null,tags:[],candidateCoverage:input.candidates!.coverage,modelVersion:'fixture'};
    }};
    const runtime=createPostgresClassificationRunRuntime(isolated.runtime.db,provider,{enabled:()=>true,tagsEnabled:()=>false,onError:()=>{}});
    const input={actor:{principalId:value.binding.principalId,subjectId:value.ownerSubjectId},collectionId:value.collectionId,
      commandId:randomUUID(),requestId:randomUUID(),document:{sourceFolderIds:[value.context.snapshot.folders[0]!.id],nodeIds:[value.context.snapshot.node!.id],requested:{folder:true,tags:false},maxItems:50}};
    const app=classificationHttpHarness({preview:async()=>({kind:'in_progress',retryAfterSeconds:1})},{runs:runtime,principalId:input.actor.principalId,subjectId:input.actor.subjectId});
    const http=await app.inject({method:'POST',url:`/api/v1/collections/${input.collectionId}/classification-runs`,
      headers:{...classificationAuthHeaders,'known-command-id':input.commandId},payload:input.document});
    expect(http.statusCode).toBe(201);expect(http.headers.location).toContain(http.json().runId);expect(http.headers.etag).toBe(http.json().etag);
    await app.close();
    const queued=await runtime.create(input);expect(queued.kind).toBe('replay');if(queued.kind!=='replay')throw new Error('no receipt');
    expect(queued.result.status).toBe(201);expect(calls).toBe(0);
    const run=JSON.parse(Buffer.from(queued.result.body).toString()) as {runId:string;status:string;actions:unknown[]};
    expect(run.status).toBe('queued');expect(run.actions).toHaveLength(2);
    runtime.start();
    try{
      await expect.poll(async()=>(await runtime.get({...input,runId:run.runId})).status,{timeout:15000}).toBe('open');
      const open=await runtime.get({...input,runId:run.runId});expect(open.actions.every(action=>['succeeded','failed'].includes(action.status))).toBe(true);
      expect(open.actions.some(action=>action.status==='succeeded')).toBe(true);
      expect(await runtime.create(input)).toEqual(queued);
      await sql`UPDATE collection_classification_runs SET created_at=clock_timestamp()-interval '40 minutes',
        deadline_at=clock_timestamp()-interval '36 minutes',expires_at=clock_timestamp()-interval '10 minutes' WHERE id=${run.runId}`.execute(isolated.runtime.db);
      await createClassificationRunJobs(isolated.runtime.db).reap();
      await expect(runtime.get({...input,runId:run.runId})).rejects.toMatchObject({code:'resource_not_found'});
      expect(await runtime.create(input)).toEqual(queued);
      expect((await isolated.runtime.db.selectFrom('collection_classification_runs').select('snapshot_json').where('id','=',run.runId).executeTakeFirstOrThrow()).snapshot_json).toBeNull();
    }finally{await runtime.stop();}
  },30000);

  test('batch cancellation and deadline close all pending actions without calling a provider',async()=>{
    const value=await executionSeed();let calls=0,enabled=true;
    const runtime=createPostgresClassificationRunRuntime(isolated.runtime.db,{...createBookmarkClassificationProvider(null),async classify(){calls++;throw new ClassificationProviderError('disabled');}},
      {enabled:()=>enabled,tagsEnabled:()=>false,onError:()=>{}});
    const input={actor:{principalId:value.binding.principalId,subjectId:value.ownerSubjectId},collectionId:value.collectionId,commandId:randomUUID(),requestId:randomUUID(),
      document:{nodeIds:[value.context.snapshot.node!.id],requested:{folder:true,tags:false},maxItems:50}};
    const queued=await runtime.create(input);if(queued.kind!=='replay')throw new Error('no receipt');
    const run=JSON.parse(Buffer.from(queued.result.body).toString()) as {runId:string;etag:string};
    const cancel={...input,runId:run.runId,commandId:randomUUID(),ifMatch:run.etag,document:{}};
    const cancelled=await runtime.cancel(cancel);expect(await runtime.cancel(cancel)).toEqual(cancelled);
    expect((await runtime.cancel({...cancel,ifMatch:'"changed"'})).kind).toBe('reused');
    expect((await runtime.get({...input,runId:run.runId})).actions[0]).toMatchObject({status:'failed',failureCode:'cancelled'});
    const second=await runtime.create({...input,commandId:randomUUID()});if(second.kind!=='replay')throw new Error('no receipt');
    const secondId=JSON.parse(Buffer.from(second.result.body).toString()).runId as string;
    await sql`UPDATE collection_classification_runs SET created_at=clock_timestamp()-interval '5 minutes',
      deadline_at=clock_timestamp()-interval '1 second' WHERE id=${secondId}`.execute(isolated.runtime.db);
    await createClassificationRunJobs(isolated.runtime.db).reap();
    expect((await runtime.get({...input,runId:secondId})).actions[0]).toMatchObject({status:'failed',failureCode:'deadline_exceeded'});
    const third=await runtime.create({...input,commandId:randomUUID()});if(third.kind!=='replay')throw new Error('no receipt');
    const thirdId=JSON.parse(Buffer.from(third.result.body).toString()).runId as string;
    enabled=false;runtime.start();
    try{await expect.poll(async()=>(await runtime.get({...input,runId:thirdId})).status,{timeout:10000}).toBe('cancelled');}
    finally{await runtime.stop();}
    expect(calls).toBe(0);
  });

  test('batch handles 50 ordered actions, partial/all failures and restart without resending unknown calls',async()=>{
    const value=await executionSeed();const ids=Array.from({length:50},()=>randomUUID());
    await sql`INSERT INTO resource_id_ledger(resource_id,resource_type) SELECT unnest(${ids}::text[]),'node'`.execute(isolated.runtime.db);
    await sql`INSERT INTO nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,resource_revision,children_revision)
      SELECT id,${value.collectionId},${value.context.snapshot.folders[0]!.id},'bookmark',false,'Batch '||n::text,
        'https://example.org/batch/'||n::text,NULL,'[]'::jsonb,'inherit','X'||n::text,'r1','ch1'
      FROM unnest(${ids}::text[]) WITH ORDINALITY AS seed(id,n)`.execute(isolated.runtime.db);
    let unavailable=false;const dispatched=new Map<string,number>();
    const provider:BookmarkClassificationProvider={...createBookmarkClassificationProvider(null),async classify(input,execution){
      if(unavailable||input.bookmark.title==='Batch 3')throw new ClassificationProviderError('credentials');
      const answer={folderId:null,confidence:1,probabilities:[...input.candidates!.l1.map(folder=>({folderId:folder.id,probability:0})),{folderId:null,probability:1}]};
      const result=await execution.calls.run('l1',0,{fixture:'fifty'},async()=>{
        dispatched.set(execution.executionId,(dispatched.get(execution.executionId)??0)+1);
        return {answer,modelVersion:'fixture',inputTokens:0,outputTokens:0};
      });return {l1:result.answer,l2:null,tags:[],candidateCoverage:input.candidates!.coverage,modelVersion:'fixture'};
    }};
    const make=()=>createPostgresClassificationRunRuntime(isolated.runtime.db,provider,{enabled:()=>true,tagsEnabled:()=>false,onError:()=>{}});
    let runtime=make();
    const input={actor:{principalId:value.binding.principalId,subjectId:value.ownerSubjectId},collectionId:value.collectionId,commandId:randomUUID(),requestId:randomUUID(),
      document:{nodeIds:ids,requested:{folder:true,tags:false},maxItems:50}};
    const queued=await runtime.create(input);if(queued.kind!=='replay')throw new Error('no receipt');
    const runId=JSON.parse(Buffer.from(queued.result.body).toString()).runId as string;
    // Reconstruct the entire runtime before processing queued work.
    await runtime.stop();runtime=make();runtime.start();
    try{
      await expect.poll(async()=>(await runtime.get({...input,runId})).status,{timeout:20000}).toBe('open');
      const run=await runtime.get({...input,runId});expect(run.actions).toHaveLength(50);
      expect(run.actions.every(action=>action.status==='succeeded'||action.status==='failed')).toBe(true);
      expect(run.actions.some(action=>action.status==='failed')).toBe(true);
      expect([...dispatched.values()].every(count=>count===1)).toBe(true);
      unavailable=true;
      const failed=await runtime.create({...input,commandId:randomUUID()});if(failed.kind!=='replay')throw new Error('no receipt');
      const failedId=JSON.parse(Buffer.from(failed.result.body).toString()).runId as string;
      await expect.poll(async()=>(await runtime.get({...input,runId:failedId})).status,{timeout:20000}).toBe('failed');
      expect((await runtime.get({...input,runId:failedId})).failureCode).toBe('all_actions_failed');
    }finally{await runtime.stop();}
  },60000);

  test('batch restart preserves a dispatched unknown outcome and fences old job generations',async()=>{
    const value=await executionSeed();let calls=0;
    const provider:BookmarkClassificationProvider={...createBookmarkClassificationProvider(null),async classify(_input,execution){
      await execution.calls.run('l1',0,{fixture:'restart'},async()=>{
        calls++;return new Promise((_resolve,reject)=>execution.signal.addEventListener('abort',()=>reject(new Error('interrupted')),{once:true}));
      });throw new Error('unreachable');
    }};
    const make=()=>createPostgresClassificationRunRuntime(isolated.runtime.db,provider,{enabled:()=>true,tagsEnabled:()=>false,onError:()=>{}});
    let runtime=make();const input={actor:{principalId:value.binding.principalId,subjectId:value.ownerSubjectId},collectionId:value.collectionId,
      commandId:randomUUID(),requestId:randomUUID(),document:{nodeIds:[value.context.snapshot.node!.id],requested:{folder:true,tags:false},maxItems:1}};
    const queued=await runtime.create(input);if(queued.kind!=='replay')throw new Error('no receipt');
    const runId=JSON.parse(Buffer.from(queued.result.body).toString()).runId as string;
    runtime.start();await expect.poll(()=>calls,{timeout:10000}).toBe(1);await runtime.stop();
    runtime=make();runtime.start();
    try{
      await expect.poll(async()=>(await runtime.get({...input,runId})).status,{timeout:15000}).toBe('failed');
      expect((await runtime.get({...input,runId})).actions[0]).toMatchObject({status:'failed',failureCode:'outcome_unknown'});
      expect(calls).toBe(1);
    }finally{await runtime.stop();}
  },30000);

  test('batch deadline publishes successful items and ambiguous in-flight failures within one reaper interval',async()=>{
    const value=await executionSeed();let dispatched=0;
    const provider:BookmarkClassificationProvider={...createBookmarkClassificationProvider(null),async classify(input,execution){
      const answer={folderId:null,confidence:1,probabilities:[...input.candidates!.l1.map(folder=>({folderId:folder.id,probability:0})),{folderId:null,probability:1}]};
      const result=await execution.calls.run('l1',0,{fixture:'partial-deadline'},async()=>{
        dispatched++;
        if(input.bookmark.title==='Another')return new Promise<never>((_resolve,reject)=>execution.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
        return {answer,modelVersion:'fixture',inputTokens:0,outputTokens:0};
      });return {l1:result.answer,l2:null,tags:[],candidateCoverage:input.candidates!.coverage,modelVersion:'fixture'};
    }};
    const runtime=createPostgresClassificationRunRuntime(isolated.runtime.db,provider,{enabled:()=>true,tagsEnabled:()=>false,onError:()=>{}});
    const input={actor:{principalId:value.binding.principalId,subjectId:value.ownerSubjectId},collectionId:value.collectionId,commandId:randomUUID(),requestId:randomUUID(),
      document:{nodeIds:[value.context.snapshot.node!.id,`b2-${value.collectionId}`],requested:{folder:true,tags:false},maxItems:50}};
    const queued=await runtime.create(input);if(queued.kind!=='replay')throw new Error('no receipt');
    const runId=JSON.parse(Buffer.from(queued.result.body).toString()).runId as string;
    runtime.start();
    try{
      await expect.poll(async()=>[dispatched,(await runtime.get({...input,runId})).actions.filter(action=>action.status==='succeeded').length],{timeout:10000}).toEqual([2,1]);
      await sql`UPDATE collection_classification_runs SET created_at=clock_timestamp()-interval '5 minutes',deadline_at=clock_timestamp()-interval '1 second'
        WHERE id=${runId}`.execute(isolated.runtime.db);
      await expect.poll(async()=>(await runtime.get({...input,runId})).status,{timeout:7000}).toBe('open');
      const result=await runtime.get({...input,runId});
      expect(result.actions.filter(action=>action.status==='succeeded')).toHaveLength(1);
      expect(result.actions.find(action=>action.status==='failed')?.failureCode).toBe('outcome_unknown');
      expect(dispatched).toBe(2);
    }finally{await runtime.stop();}
  },30000);

  test('SIGKILL batch worker recovers the durable job and never resends the dispatched action',async()=>{
    const value=await executionSeed();
    const child=fork(new URL('../../support/classification-crash-worker.ts',import.meta.url),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
    const ready=once(child,'message');child.send({databaseUrl:isolated.databaseUrl,principalId:value.binding.principalId,subjectId:value.ownerSubjectId,holdFirst:true,batch:true});
    let runtime:ReturnType<typeof createPostgresClassificationRunRuntime>|undefined;
    try{
      const [started]=await ready;expect(started.kind).toBe('ready');
      const dispatched=once(child,'message');const commandId=randomUUID();
      const request={actor:{principalId:value.binding.principalId,subjectId:value.ownerSubjectId},collectionId:value.collectionId,commandId,requestId:randomUUID(),
        document:{nodeIds:[value.context.snapshot.node!.id],requested:{folder:true,tags:false},maxItems:1}};
      const response=await fetch(`${started.address}/api/v1/collections/${value.collectionId}/classification-runs`,{method:'POST',
        headers:{...classificationAuthHeaders,'known-command-id':commandId,'content-type':'application/json'},body:JSON.stringify(request.document)});
      expect(response.status).toBe(201);const queued=await response.json() as {runId:string};
      expect((await dispatched)[0].kind).toBe('dispatch');
      const exited=once(child,'exit');child.kill('SIGKILL');await exited;
      let repeated=0;
      runtime=createPostgresClassificationRunRuntime(isolated.runtime.db,{...createBookmarkClassificationProvider(null),async classify(){repeated++;throw new Error('must not resend');}},
        {enabled:()=>true,tagsEnabled:()=>false,onError:()=>{}});runtime.start();
      await expect.poll(async()=>(await runtime!.get({...request,runId:queued.runId})).status,{timeout:40000}).toBe('failed');
      expect((await runtime.get({...request,runId:queued.runId})).actions[0]).toMatchObject({status:'failed',failureCode:'outcome_unknown'});
      expect(repeated).toBe(0);
      const attempts=await sql<{state:string;attempt_number:number}>`SELECT a.state,a.attempt_number FROM classification_call_attempts a
        JOIN classification_provider_executions e ON e.id=a.execution_id WHERE e.collection_id=${value.collectionId}`.execute(isolated.runtime.db);
      expect(attempts.rows).toEqual([{state:'unknown',attempt_number:1}]);
      const replay=await runtime.create(request);if(replay.kind!=='replay')throw new Error('missing create receipt');
      expect(JSON.parse(Buffer.from(replay.result.body).toString()).status).toBe('queued');
    }finally{
      await runtime?.stop();
      if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
    }
  },60000);

  test('success receipt holds owner and collection fences through commit',async()=>{
    for(const target of ['owner','taxonomy','settings'] as const){
      const {seed,lease}=await admitted();let entered!:()=>void,release!:()=>void;
      const reached=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
      const store=createPostgresClassificationExecutionStore(isolated.runtime.db,{faultInjector:{async afterCallbackBeforeCommit(){entered();await gate;}}});
      const result={...classificationFailureReceipt(seed.requestId,'disabled'),status:200};
      const completion=store.finish(lease,'succeeded',result);await reached;
      const writer=await isolated.runtime.pool.connect();
      try{
        await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");
        const mutation=target==='owner'?writer.query("UPDATE accounts SET status='disabled' WHERE id=$1",[seed.binding.principalId])
          :target==='taxonomy'?writer.query("UPDATE collections SET content_revision='changed' WHERE id=$1",[seed.collectionId])
          :writer.query('SELECT id FROM collections WHERE id=$1 FOR UPDATE',[seed.collectionId]);
        await expect(mutation).rejects.toMatchObject({code:'55P03'});
      }finally{await writer.query('ROLLBACK');writer.release();release();await completion;}
      expect((await createPostgresClassificationExecutionStore(isolated.runtime.db).lookup(seed))?.kind).toBe('replay');
    }
  });

});
