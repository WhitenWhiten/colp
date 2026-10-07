import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import { createPostgresClassificationExecutionStore } from '../../../src/infrastructure/collections/classification-execution-postgres.js';
import { createPostgresClassificationTaxonomyReadPort } from '../../../src/infrastructure/collections/classification-taxonomy-read.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sql } from 'kysely';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountCreditsPort } from '../../../src/infrastructure/identity/index.js';
import { createBookmarkClassificationProvider } from '../../../src/infrastructure/collections/classification-provider-factory.js';
import { createClassificationRunCommands } from '../../../src/infrastructure/collections/classification-run-commands.js';
import { createClassificationRunJobs } from '../../../src/infrastructure/collections/classification-run-jobs.js';
import { createPostgresClassificationRunRuntime } from '../../../src/infrastructure/collections/classification-run-runtime.js';
import { ClassificationProviderError, loadClassificationContext, runClassificationExecution } from '../../../src/modules/collections/index.js';
import { seedClassificationTaxonomy } from '../../support/classification-database-fixture.js';
import { createCreditTestDatabase } from '../../support/credit-ledger-fixture.js';
import { describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('CR-03 classification run billing PostgreSQL contracts', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createCreditTestDatabase('classification_run_credits', 10);
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  const credits = (transaction: Parameters<typeof createPostgresAccountCreditsPort>[0], accountId: string) =>
    createPostgresAccountCreditsPort(transaction, accountId);
  const provider = createBookmarkClassificationProvider(null);

  test('TX-02 reserves the actual N atomically and leaves no partial run when the final action is short', async () => {
    const fixture = await seedClassificationTaxonomy(isolated.runtime);
    const nodeIds = await addBatchNodes(fixture.collectionId, fixture.folderId, 49);
    await grant(fixture.collectionId, 49);
    const commands = createClassificationRunCommands(isolated.runtime.db, provider, {
      creditEnabled: true, credits,
    });
    const document = {
      nodeIds: [fixture.nodeId, ...nodeIds],
      requested: { folder: true, tags: false },
      maxItems: 50,
      billing: { priceVersion: 'bookmark-classify.v1', maxPoints: 50 },
    };
    const outcome = await commands.create({
      actor: { principalId: fixture.collectionId, subjectId: fixture.ownerSubjectId },
      collectionId: fixture.collectionId, commandId: randomUUID(), requestId: randomUUID(), document,
    });
    expect(outcome.kind).toBe('replay');
    if (outcome.kind !== 'replay') return;
    expect(outcome.result.status).toBe(409);
    expect(JSON.parse(Buffer.from(outcome.result.body).toString('utf8')).error).toMatchObject({
      code: 'insufficient_credits', creditContext: { requiredPoints: 50, availablePoints: 49, maxPoints: 50 },
    });
    expect(await count('collection_classification_runs', fixture.collectionId)).toBe(0);
    expect(await count('collection_classification_run_actions', fixture.collectionId)).toBe(0);
    expect(await count('credit_charges', fixture.collectionId)).toBe(0);
    expect(await count('credit_ledger_entries', fixture.collectionId)).toBe(1); // the manual grant only
  });

  test('TX-05 action finish and cancel have one charge terminal state and one terminal ledger event', async () => {
    const fixture = await seedClassificationTaxonomy(isolated.runtime);
    await grant(fixture.collectionId, 2);
    const runtime = createPostgresClassificationRunRuntime(isolated.runtime.db, provider, {
      enabled: () => true, tagsEnabled: () => false, onError: () => {}, creditEnabled: true, credits,
    });
    const input = {
      actor: { principalId: fixture.collectionId, subjectId: fixture.ownerSubjectId },
      collectionId: fixture.collectionId, commandId: randomUUID(), requestId: randomUUID(),
      document: { nodeIds: [fixture.nodeId, fixture.otherNodeId], requested: { folder: true, tags: false }, maxItems: 2,
        billing: { priceVersion: 'bookmark-classify.v1', maxPoints: 2 } },
    };
    const created = await runtime.create(input);
    expect(created.kind).toBe('replay');
    if (created.kind !== 'replay') return;
    const queued = JSON.parse(Buffer.from(created.result.body).toString('utf8')) as { runId: string };
    const jobs = createClassificationRunJobs(isolated.runtime.db, { creditEnabled: true, credits });
    const lease = await jobs.lease(queued.runId);
    expect(lease).not.toBeNull();
    const action = (await jobs.actions(lease!))[0]!;
    expect(await jobs.markRunning(lease!, action.action_id)).toBe(true);
    const current = await runtime.get({ ...input, runId: queued.runId });
    const cancelInput = { ...input, runId: queued.runId, commandId: randomUUID(), ifMatch: current.etag, document: {} };
    const outcomes = await Promise.allSettled([
      jobs.finishAction(lease!, action.action_id, { folderId: null }, null),
      runtime.cancel(cancelInput),
    ]);
    expect(outcomes.some((item) => item.status === 'fulfilled')).toBe(true);
    if(outcomes.some((item) => item.status === 'rejected' && (item.reason as { code?: string }).code === 'precondition_failed')){
      const refreshed=await runtime.get({ ...input, runId: queued.runId });
      await runtime.cancel({ ...cancelInput, commandId: randomUUID(), ifMatch: refreshed.etag });
    }
    const rows = await isolated.runtime.pool.query<{ status: string; credit_charge_id: string | null }>(
      `select a.status, a.credit_charge_id from collection_classification_run_actions a where a.run_id = $1`, [queued.runId]);
    expect(rows.rows).toHaveLength(2);
    const chargeIds = rows.rows.map((row) => row.credit_charge_id).filter((id): id is string => id !== null);
    const charges = await isolated.runtime.pool.query<{ id: string; state: string }>(
      `select id, state from credit_charges where account_id = $1 and id = any($2::uuid[])`, [fixture.collectionId, chargeIds]);
    expect(charges.rows.every((row) => row.state === 'settled' || row.state === 'released')).toBe(true);
    for (const charge of charges.rows) {
      const terminal = await isolated.runtime.pool.query<{ n: string }>(
        `select count(*)::text as n from credit_ledger_entries where account_id=$1 and charge_id=$2::uuid and kind in ('spend','release')`,
        [fixture.collectionId, charge.id]);
      expect(Number(terminal.rows[0]?.n)).toBe(1);
    }
    await runtime.stop();
  });

  test('TX-08 replaying action publication after a worker restart does not spend twice', async () => {
    const fixture = await seedClassificationTaxonomy(isolated.runtime);
    await grant(fixture.collectionId, 1);
    const runtime = createPostgresClassificationRunRuntime(isolated.runtime.db, provider, {
      enabled: () => true, tagsEnabled: () => false, onError: () => {}, creditEnabled: true, credits,
    });
    const input = {
      actor: { principalId: fixture.collectionId, subjectId: fixture.ownerSubjectId },
      collectionId: fixture.collectionId, commandId: randomUUID(), requestId: randomUUID(),
      document: { nodeIds: [fixture.nodeId], requested: { folder: true, tags: false }, maxItems: 1,
        billing: { priceVersion: 'bookmark-classify.v1', maxPoints: 1 } },
    };
    const created = await runtime.create(input);
    if (created.kind !== 'replay') throw new Error('run create did not return receipt');
    const run = JSON.parse(Buffer.from(created.result.body).toString('utf8')) as { runId: string };
    const jobs = createClassificationRunJobs(isolated.runtime.db, { creditEnabled: true, credits });
    const lease = await jobs.lease(run.runId);
    expect(lease).not.toBeNull();
    const action = (await jobs.actions(lease!))[0]!;
    await jobs.markRunning(lease!, action.action_id);
    const {invoked,calls,store,seed}=await successfulChild(fixture,lease!,action);
    expect((await isolated.runtime.pool.query('SELECT state FROM credit_charges WHERE account_id=$1',[fixture.collectionId])).rows).toEqual([{state:'reserved'}]);
    expect((await store.lookup(seed))?.kind).toBe('replay');
    await jobs.release(lease!);
    await sql`UPDATE collection_classification_run_jobs SET available_at=clock_timestamp() WHERE run_id=${run.runId}`.execute(isolated.runtime.db);
    const restarted=createPostgresClassificationRunRuntime(isolated.runtime.db,invoked,{enabled:()=>true,tagsEnabled:()=>false,onError:()=>{},creditEnabled:true,credits});
    restarted.start();
    try{
      await expect.poll(async()=>(await restarted.get({...input,runId:run.runId})).status,{timeout:10_000}).toBe('open');
      expect(calls()).toBe(1);
      expect(await jobs.finishAction(lease!, action.action_id, {folderId:null}, null)).toBe(false);
      expect(await count('credit_ledger_entries',fixture.collectionId)).toBe(3);
      expect((await isolated.runtime.pool.query('SELECT state FROM credit_charges WHERE account_id=$1',[fixture.collectionId])).rows).toEqual([{state:'settled'}]);
    }finally{await restarted.stop();}
    await runtime.stop();
  });

  for(const winner of ['publish','cancel'] as const)test('TX-05 ordered commit race: '+winner+' wins',async()=>{
    const fixture=await seedClassificationTaxonomy(isolated.runtime);await grant(fixture.collectionId,2);
    const runtime=createPostgresClassificationRunRuntime(isolated.runtime.db,provider,{enabled:()=>true,tagsEnabled:()=>false,onError:()=>{},creditEnabled:true,credits});
    const input={actor:{principalId:fixture.collectionId,subjectId:fixture.ownerSubjectId},collectionId:fixture.collectionId,commandId:randomUUID(),requestId:randomUUID(),
      document:{nodeIds:[fixture.nodeId,fixture.otherNodeId],requested:{folder:true,tags:false},maxItems:2,billing:{priceVersion:'bookmark-classify.v1',maxPoints:2}}};
    const created=await runtime.create(input);if(created.kind!=='replay')throw new Error('Run was not created');
    const runId=JSON.parse(Buffer.from(created.result.body).toString('utf8')).runId as string;
    const jobs=createClassificationRunJobs(isolated.runtime.db,{creditEnabled:true,credits});
    const lease=await jobs.lease(runId);if(!lease)throw new Error('Run was not leased');
    const action=(await jobs.actions(lease))[0]!;await jobs.markRunning(lease,action.action_id);
    const child=await successfulChild(fixture,lease,action);
    const current=await runtime.get({...input,runId});
    const cancel={...input,runId,commandId:randomUUID(),ifMatch:current.etag,document:{}};
    let entered!:()=>void,release!:()=>void;
    const reached=new Promise<void>(resolve=>{entered=resolve;});const barrier=new Promise<void>(resolve=>{release=resolve;});
    const faultInjector={async afterCallbackBeforeCommit(){entered();await barrier;}};
    const heldJobs=createClassificationRunJobs(isolated.runtime.db,{creditEnabled:true,credits,faultInjector});
    const heldCommands=createClassificationRunCommands(isolated.runtime.db,provider,{creditEnabled:true,credits,faultInjector});
    const first=winner==='publish'?heldJobs.finishAction(lease,action.action_id,{},null):heldCommands.cancel(cancel);
    void first.catch(()=>{});
    try{
      await reached;
      const second=winner==='publish'?runtime.cancel(cancel):jobs.finishAction(lease,action.action_id,{},null);
      const results=Promise.allSettled([first,second]);
      await expect.poll(async()=>{
        const waits=await sql<{waiting:boolean}>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%credit_lock_account%') AS waiting`.execute(isolated.runtime.db);
        return waits.rows[0]?.waiting;
      },{timeout:200,interval:5}).toBe(true);
      release();const outcomes=await results;
      expect(outcomes[0].status).toBe('fulfilled');
      if(winner==='publish'){
        expect(outcomes[1].status).toBe('rejected');
        const updated=await runtime.get({...input,runId});
        await runtime.cancel({...cancel,commandId:randomUUID(),ifMatch:updated.etag});
      }else expect(outcomes[1]).toMatchObject({status:'fulfilled',value:false});
      const final=await runtime.get({...input,runId});
      expect(final.creditUsage).toMatchObject({reservedPoints:0,chargedPoints:winner==='publish'?1:0,releasedPoints:winner==='publish'?1:2});
      expect(child.calls()).toBe(1);
      const terminal=await isolated.runtime.pool.query('SELECT charge_id,count(*)::int AS count FROM credit_ledger_entries WHERE account_id=$1 AND kind IN (\'spend\',\'release\') GROUP BY charge_id',[fixture.collectionId]);
      expect(terminal.rows).toHaveLength(2);expect(terminal.rows.every(row=>row.count===1)).toBe(true);
    }finally{release();await first.catch(()=>{});await runtime.stop();}
  });

  test('managed worker executes a child provider call and settles the action-owned charge once', async () => {
    const fixture = await seedClassificationTaxonomy(isolated.runtime);
    await grant(fixture.collectionId, 1);
    let providerCalls = 0;
    const managedProvider = {
      ...provider,
      async classify(input: Parameters<typeof provider.classify>[0], execution: Parameters<typeof provider.classify>[1]) {
        providerCalls += 1;
        const answer = {
          folderId: null, confidence: 1,
          probabilities: [...(input.candidates?.l1 ?? []).map(folder => ({ folderId: folder.id, probability: 0 })), { folderId: null, probability: 1 }],
        };
        const result = await execution.calls.run('l1', 0, { fixture: 'managed-batch' }, async () => ({
          answer, modelVersion: 'fixture', inputTokens: 0, outputTokens: 0,
        }));
        return { l1: result.answer, l2: null, tags: [], candidateCoverage: input.candidates!.coverage, modelVersion: 'fixture' };
      },
    };
    const runtime = createPostgresClassificationRunRuntime(isolated.runtime.db, managedProvider, {
      enabled: () => true, tagsEnabled: () => false, onError: () => {}, creditEnabled: true, credits,
    });
    const input = {
      actor: { principalId: fixture.collectionId, subjectId: fixture.ownerSubjectId },
      collectionId: fixture.collectionId, commandId: randomUUID(), requestId: randomUUID(),
      document: { nodeIds: [fixture.nodeId], requested: { folder: true, tags: false }, maxItems: 1,
        billing: { priceVersion: 'bookmark-classify.v1', maxPoints: 1 } },
    };
    const created = await runtime.create(input);
    if (created.kind !== 'replay') throw new Error('run create did not return receipt');
    const runId = (JSON.parse(Buffer.from(created.result.body).toString('utf8')) as { runId: string }).runId;
    runtime.start();
    try {
      await expect.poll(async () => (await runtime.get({ ...input, runId })).status, { timeout: 15_000 }).toBe('open');
      expect(providerCalls).toBe(1);
      const charges = await isolated.runtime.pool.query<{ state: string }>(
        `select state from credit_charges where account_id=$1`, [fixture.collectionId]);
      expect(charges.rows).toEqual([{ state: 'settled' }]);
      const entries = await isolated.runtime.pool.query<{ kind: string }>(
        `select kind from credit_ledger_entries where account_id=$1 order by sequence`, [fixture.collectionId]);
      expect(entries.rows.map(row => row.kind)).toEqual(['grant', 'reserve', 'spend']);
    } finally {
      await runtime.stop();
    }
  });

  test('a created child execution resumes while managed admission is disabled', async () => {
    const fixture = await seedClassificationTaxonomy(isolated.runtime);
    await grant(fixture.collectionId, 1);
    let providerCalls = 0;
    const managedProvider = {
      ...provider,
      async classify(input: Parameters<typeof provider.classify>[0], execution: Parameters<typeof provider.classify>[1]) {
        providerCalls += 1;
        const answer = { folderId: null, confidence: 1,
          probabilities: [...(input.candidates?.l1 ?? []).map(folder => ({ folderId: folder.id, probability: 0 })), { folderId: null, probability: 1 }] };
        const result = await execution.calls.run('l1', 0, { fixture: 'drain-resume' }, async () => ({
          answer, modelVersion: 'fixture', inputTokens: 0, outputTokens: 0,
        }));
        return { l1: result.answer, l2: null, tags: [], candidateCoverage: input.candidates!.coverage, modelVersion: 'fixture' };
      },
    };
    const actor = { principalId: fixture.collectionId, subjectId: fixture.ownerSubjectId };
    const input = { actor, collectionId: fixture.collectionId, commandId: randomUUID(), requestId: randomUUID(),
      document: { nodeIds: [fixture.nodeId], requested: { folder: true, tags: false }, maxItems: 1,
        billing: { priceVersion: 'bookmark-classify.v1', maxPoints: 1 } } };
    const creating = createPostgresClassificationRunRuntime(isolated.runtime.db, managedProvider, {
      enabled: () => true, tagsEnabled: () => false, onError: () => {}, creditEnabled: true, managedAdmissionEnabled: true, credits,
    });
    const created = await creating.create(input);
    if (created.kind !== 'replay') throw new Error('run create did not return receipt');
    const runId = (JSON.parse(Buffer.from(created.result.body).toString()) as { runId: string }).runId;
    await creating.stop();

    const draining = createPostgresClassificationRunRuntime(isolated.runtime.db, managedProvider, {
      enabled: () => true, tagsEnabled: () => false, onError: () => {}, creditEnabled: true, managedAdmissionEnabled: false, credits,
    });
    draining.start();
    try {
      await expect.poll(async () => (await draining.get({ ...input, runId })).actions[0]?.status, { timeout: 15_000 }).toBe('succeeded');
      expect(providerCalls).toBe(1);
      expect((await isolated.runtime.pool.query<{ state: string }>('SELECT state FROM credit_charges WHERE account_id=$1', [fixture.collectionId])).rows)
        .toEqual([{ state: 'settled' }]);
      expect((await isolated.runtime.pool.query<{ kind: string }>('SELECT kind FROM credit_ledger_entries WHERE account_id=$1 ORDER BY sequence', [fixture.collectionId])).rows.map(row => row.kind))
        .toEqual(['grant', 'reserve', 'spend']);
    } finally {
      await draining.stop();
    }
  });

  test('integrity audit accepts a successful no-call action released as classification_unneeded', async () => {
    const fixture = await seedClassificationTaxonomy(isolated.runtime);
    await grant(fixture.collectionId, 1);
    const runtime = createPostgresClassificationRunRuntime(isolated.runtime.db, provider, {
      enabled: () => true, tagsEnabled: () => false, onError: () => {}, creditEnabled: true, credits,
    });
    const input = { actor: { principalId: fixture.collectionId, subjectId: fixture.ownerSubjectId }, collectionId: fixture.collectionId,
      commandId: randomUUID(), requestId: randomUUID(), document: { nodeIds: [fixture.nodeId], requested: { folder: true, tags: false }, maxItems: 1,
        billing: { priceVersion: 'bookmark-classify.v1', maxPoints: 1 } } };
    const created = await runtime.create(input);if (created.kind !== 'replay') throw new Error('run create did not return receipt');
    const runId = (JSON.parse(Buffer.from(created.result.body).toString()) as { runId: string }).runId;
    const jobs = createClassificationRunJobs(isolated.runtime.db, { creditEnabled: true, credits });
    const lease = await jobs.lease(runId);if (!lease) throw new Error('run was not leased');
    const action = (await jobs.actions(lease))[0]!;await jobs.markRunning(lease, action.action_id);
    const child = await successfulChild(fixture, lease, action);
    const execution = await isolated.runtime.db.selectFrom('classification_provider_executions').select('id')
      .where('command_id', '=', action.execution_command_id).executeTakeFirstOrThrow();
    await sql`DELETE FROM classification_call_attempts WHERE execution_id=${execution.id}`.execute(isolated.runtime.db);
    expect(await jobs.finishAction(lease, action.action_id, { folderId: null }, null)).toBe(true);
    const charge = await isolated.runtime.db.selectFrom('credit_charges').select(['state']).where('id', '=', action.credit_charge_id!).executeTakeFirstOrThrow();
    expect(charge.state).toBe('released');
    const release = await isolated.runtime.db.selectFrom('credit_ledger_entries').select(['kind', 'reason_code'])
      .where('charge_id', '=', action.credit_charge_id!).execute();
    expect(release).toContainEqual({ kind: 'release', reason_code: 'classification_unneeded' });
    expect((await sql<{ issue_code: string }>`SELECT * FROM credit_audit_account(${fixture.collectionId},false)`.execute(isolated.runtime.db)).rows)
      .not.toContainEqual({ issue_code: 'action_terminal' });
    expect(child.calls()).toBe(1);
    await runtime.stop();
  });

  test('managed 50-item worker run accounts 30 successes, 10 provider failures and 10 cancellations', async () => {
    const fixture = await seedClassificationTaxonomy(isolated.runtime);
    const labels=[...Array.from({length:29},(_,index)=>`Success ${index}`),
      ...Array.from({length:10},(_,index)=>`Fail ${index}`),
      ...Array.from({length:10},(_,index)=>`Cancel ${index}`)];
    const nodeIds=await addNamedBatchNodes(fixture.collectionId,fixture.folderId,labels);
    await grant(fixture.collectionId,50);
    let cancelProviderRelease!:()=>void;
    const cancelReleased=new Promise<void>(resolve=>{cancelProviderRelease=resolve;});
    const managedProvider={
      ...provider,
      async classify(input:Parameters<typeof provider.classify>[0],execution:Parameters<typeof provider.classify>[1]){
        if(input.bookmark.title.startsWith('Fail'))throw new ClassificationProviderError('credentials');
        if(input.bookmark.title.startsWith('Cancel')){
          await cancelProviderRelease;
          if(execution.signal.aborted)throw new ClassificationProviderError('deadline');
        }
        const answer={folderId:null,confidence:1,probabilities:[...(input.candidates?.l1??[]).map(folder=>({folderId:folder.id,probability:0})),{folderId:null,probability:1}]};
        const result=await execution.calls.run('l1',0,{fixture:'managed-fifty'},async()=>({answer,modelVersion:'fixture',inputTokens:0,outputTokens:0}));
        return {l1:result.answer,l2:null,tags:[],candidateCoverage:input.candidates!.coverage,modelVersion:'fixture'};
      },
    };
    const runtime=createPostgresClassificationRunRuntime(isolated.runtime.db,managedProvider,{enabled:()=>true,tagsEnabled:()=>false,onError:()=>{},creditEnabled:true,credits});
    const input={actor:{principalId:fixture.collectionId,subjectId:fixture.ownerSubjectId},collectionId:fixture.collectionId,
      commandId:randomUUID(),requestId:randomUUID(),document:{nodeIds:[fixture.nodeId,...nodeIds],requested:{folder:true,tags:false},maxItems:50,
        billing:{priceVersion:'bookmark-classify.v1',maxPoints:50}}};
    const created=await runtime.create(input);if(created.kind!=='replay')throw new Error('run create did not return receipt');
    const runId=(JSON.parse(Buffer.from(created.result.body).toString('utf8')) as {runId:string}).runId;
    runtime.start();
    try{
      await expect.poll(async()=>{
        const actions=(await runtime.get({...input,runId})).actions;
        return [actions.filter(action=>action.status==='succeeded').length,actions.filter(action=>action.status==='failed').length];
      },{timeout:30_000}).toEqual([30,10]);
      let cancelled=false;
      for(let attempt=0;attempt<20&&!cancelled;attempt++){
        const beforeCancel=await runtime.get({...input,runId});
        try{await runtime.cancel({...input,runId,commandId:randomUUID(),ifMatch:beforeCancel.etag,document:{}});cancelled=true;}
        catch(error){if((error as {code?:string}).code!=='precondition_failed')throw error;}
      }
      expect(cancelled).toBe(true);
      cancelProviderRelease();
      await expect.poll(async()=>(await runtime.get({...input,runId})).status,{timeout:15_000}).toBe('cancelled');
      const actions=(await runtime.get({...input,runId})).actions;
      expect(actions.filter(action=>action.status==='succeeded')).toHaveLength(30);
      expect(actions.filter(action=>action.status==='failed')).toHaveLength(20);
      const chargeStates=await isolated.runtime.pool.query<{state:string;count:string}>(
        `select state,count(*)::text as count from credit_charges where account_id=$1 group by state`,[fixture.collectionId]);
      expect(new Map(chargeStates.rows.map(row=>[row.state,Number(row.count)]))).toEqual(new Map([['settled',30],['released',20]]));
      const ledgerKinds=await isolated.runtime.pool.query<{kind:string;count:string}>(
        `select kind,count(*)::text as count from credit_ledger_entries where account_id=$1 group by kind`,[fixture.collectionId]);
      expect(new Map(ledgerKinds.rows.map(row=>[row.kind,Number(row.count)]))).toEqual(new Map([['grant',1],['reserve',50],['spend',30],['release',20]]));
      const duplicateTerminals=await isolated.runtime.pool.query<{duplicates:string}>(
        `select count(*)::text as duplicates from (
           select charge_id from credit_ledger_entries where account_id=$1 and kind in ('spend','release')
           group by charge_id having count(*)<>1
         ) terminal`,[fixture.collectionId]);
      expect(Number(duplicateTerminals.rows[0]?.duplicates??0)).toBe(0);
    }finally{
      cancelProviderRelease();
      await runtime.stop();
    }
  },60_000);

  async function successfulChild(fixture:{collectionId:string;ownerSubjectId:string},lease:NonNullable<Awaited<ReturnType<ReturnType<typeof createClassificationRunJobs>['lease']>>>,
    action:Awaited<ReturnType<ReturnType<typeof createClassificationRunJobs>['actions']>>[number]){
    let calls=0;
    const invoked={...provider,async classify(context:Parameters<typeof provider.classify>[0],execution:Parameters<typeof provider.classify>[1]){
      const answer={folderId:null,confidence:1,probabilities:[{folderId:null,probability:1},...context.candidates!.l1.map(folder=>({folderId:folder.id,probability:0}))]};
      await execution.calls.run('l1',0,{},async()=>{calls++;return {answer,modelVersion:'fixture',inputTokens:1,outputTokens:1};});
      return {l1:answer,l2:null,tags:[],candidateCoverage:context.candidates!.coverage,modelVersion:'fixture'};
    }};
    const context=await loadClassificationContext({collectionId:fixture.collectionId,ownerSubjectId:fixture.ownerSubjectId,
      preview:{source:'web',nodeId:action.node_id,requested:{folder:true,tags:false}},tagsEnabled:false},createPostgresClassificationTaxonomyReadPort(isolated.runtime.db));
    const store=createPostgresClassificationExecutionStore(isolated.runtime.db,{creditEnabled:true,credits});
    const seed={binding:{principalId:fixture.collectionId,commandScope:'collections:classification-run-action:v1',commandId:action.execution_command_id},
      collectionId:fixture.collectionId,ownerSubjectId:fixture.ownerSubjectId,requestId:action.execution_command_id,
      fingerprint:canonicalCommandFingerprint({method:'CLASSIFY',route:lease.row.id+'/'+action.action_id,mediaType:'application/json',body:{nodeId:action.node_id,etag:action.node_etag}}),
      context:context!,providerId:provider.id,model:provider.model,policyVersion:provider.policyVersion,promptVersion:provider.promptVersion,
      deadlineAt:new Date(Date.now()+20_000).toISOString(),billingMode:lease.row.billing_mode,billingOwnerKind:'action' as const,creditChargeId:action.credit_charge_id};
    const admitted=await store.admit(seed);if(admitted.kind!=='accepted')throw new Error('Child was not admitted');
    await runClassificationExecution(store,invoked,admitted.executionId,{enabled:()=>true,onError:()=>{}});
    return {invoked,calls:()=>calls,store,seed};
  }

  async function grant(accountId: string, amount: number): Promise<void> {
    await sql`select * from known_credits.grant_credits(
      ${accountId}, ${`cr03-${randomUUID()}`}, ${amount}::bigint,
      current_timestamp - interval '1 second', current_timestamp + interval '1 day',
      'operator', 'manual_grant', 'CR03 test grant')`.execute(isolated.runtime.db);
  }

  async function addBatchNodes(collectionId: string, parentId: string, countToAdd: number): Promise<string[]> {
    const ids = Array.from({ length: countToAdd }, () => `batch-${randomUUID()}`);
    await sql`insert into resource_id_ledger(resource_id,resource_type)
      select id,'node' from unnest(${ids}::text[]) as values(id)`.execute(isolated.runtime.db);
    await sql`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,resource_revision,children_revision)
      select id,${collectionId},${parentId},'bookmark',false,'Batch','https://example.org/batch',null,'[]'::jsonb,'inherit',
        'B'||row_number() over(order by id)::text,'r1','ch1' from unnest(${ids}::text[]) as values(id)`.execute(isolated.runtime.db);
    return ids;
  }

  async function addNamedBatchNodes(collectionId: string, parentId: string, labels: readonly string[]): Promise<string[]> {
    const ids=labels.map(()=>`batch-${randomUUID()}`);
    await sql`insert into resource_id_ledger(resource_id,resource_type)
      select id,'node' from unnest(${ids}::text[]) as values(id)`.execute(isolated.runtime.db);
    await sql`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,resource_revision,children_revision)
      select values.id,${collectionId},${parentId},'bookmark',false,values.label,'https://example.org/batch',null,'[]'::jsonb,'inherit',
        'N'||row_number() over(order by values.id)::text,'r1','ch1'
      from unnest(${ids}::text[],${labels}::text[]) as values(id,label)`.execute(isolated.runtime.db);
    await sql`update nodes set created_at=clock_timestamp()-interval '1 hour' where id=${`b-${collectionId}`}`.execute(isolated.runtime.db);
    await sql`update nodes set created_at=clock_timestamp()-interval '30 minutes'
      where id=any(${ids.slice(0,29)}::text[])`.execute(isolated.runtime.db);
    await sql`update nodes set created_at=clock_timestamp()-interval '20 minutes'
      where id=any(${ids.slice(29,39)}::text[])`.execute(isolated.runtime.db);
    await sql`update nodes set created_at=clock_timestamp()-interval '10 minutes'
      where id=any(${ids.slice(39)}::text[])`.execute(isolated.runtime.db);
    return ids;
  }

  async function count(table: string, accountId: string): Promise<number> {
    if(table==='collection_classification_run_actions'){
      const result=await isolated.runtime.pool.query<{count:string}>('SELECT count(*)::text AS count FROM collection_classification_run_actions a JOIN collection_classification_runs r ON r.id=a.run_id WHERE r.principal_id=$1',[accountId]);
      return Number(result.rows[0]?.count??0);
    }
    const result = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from ${table} where ${table.startsWith('credit_') ? 'account_id' : 'principal_id'}=$1`, [accountId]);
    return Number(result.rows[0]?.count ?? 0);
  }
});
