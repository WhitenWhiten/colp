import { createPostgresClassificationRuntime } from '../../../src/infrastructure/collections/classification-runtime.js';
import { classificationHttpHarness, classificationAuthHeaders } from '../../support/classification-http-harness.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountCreditsPort } from '../../../src/infrastructure/identity/index.js';
import { createPostgresClassificationExecutionStore } from '../../../src/infrastructure/collections/classification-execution-postgres.js';
import { createPostgresClassificationTaxonomyReadPort } from '../../../src/infrastructure/collections/classification-taxonomy-read.js';
import { loadClassificationContext, runClassificationExecution, type ClassificationExecutionSeed } from '../../../src/modules/collections/index.js';
import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import { createCreditTestDatabase, grantCredits } from '../../support/credit-ledger-fixture.js';
import { seedClassificationTaxonomy } from '../../support/classification-database-fixture.js';
import { creditCrashProvider } from '../../support/classification-credit-crash-provider.js';
import { describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('CR06 charged worker SIGKILL commit windows', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createCreditTestDatabase('credit_crash', 8);
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);
  afterAll(async () => isolated?.close());

  async function browserFixture(onCall:()=>Promise<void>){
    const fixture=await seedClassificationTaxonomy(isolated.runtime);
    await grantCredits(isolated.runtime.db,{accountId:fixture.collectionId,grantKey:'initial',amount:1});
    const runtime=createPostgresClassificationRuntime(isolated.runtime.db,creditCrashProvider(onCall),{
      enabled:true,tagsEnabled:false,creditEnabled:true,credits:createPostgresAccountCreditsPort,cancelBackend:isolated.runtime.cancelBackend,onError:()=>{},
    });
    const app=classificationHttpHarness(runtime,{principalId:fixture.collectionId,subjectId:fixture.ownerSubjectId});
    const origin=await app.listen({host:'127.0.0.1',port:0});
    const send=(commandId:string)=>fetch(origin+`/api/v1/collections/${fixture.collectionId}/classification/preview`,{
      method:'POST',headers:{...classificationAuthHeaders,'content-type':'application/json','known-command-id':commandId},
      body:JSON.stringify({source:'web',nodeId:fixture.nodeId,requested:{folder:true,tags:false},billing:{priceVersion:'bookmark-classify.v1',maxPoints:1}}),
    });
    return {fixture,send,async close(){await runtime.stop();await app.close();}};
  }

  test('TX-01 concurrent distinct HTTP commands share the last point and persist the losing refusal',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;
    const f=await browserFixture(async()=>{calls++;await gate;});
    const commands=[randomUUID(),randomUUID()];const requests=commands.map(f.send);
    try{
      const denied=await Promise.race(requests);expect(denied.status).toBe(409);
      const failureBytes=await denied.text();expect(JSON.parse(failureBytes).error.code).toBe('insufficient_credits');
      release();const responses=await Promise.all(requests);
      expect(responses.map(response=>response.status).sort()).toEqual([200,409]);expect(calls).toBe(1);
      await grantCredits(isolated.runtime.db,{accountId:f.fixture.collectionId,grantKey:'after-refusal',amount:3});
      const replay=await f.send(commands[responses.findIndex(response=>response.status===409)]!);
      expect(replay.status).toBe(409);expect(await replay.text()).toBe(failureBytes);expect(calls).toBe(1);
      const charges=await isolated.runtime.db.selectFrom('credit_charges').select('state').where('account_id','=',f.fixture.collectionId).execute();
      expect(charges).toEqual([{state:'settled'}]);
    }finally{release();await Promise.allSettled(requests);await f.close();}
  },30_000);

  test('TX-12 account disable wins the L0 race before a cached session can admit charged work',async()=>{
    let calls=0;const f=await browserFixture(async()=>{calls++;});
    const connection=await isolated.runtime.pool.connect();let committed=false;
    try{
      await connection.query('BEGIN');
      await connection.query('UPDATE accounts SET status=\'disabled\' WHERE id=$1',[f.fixture.collectionId]);
      const response=f.send(randomUUID());
      await expect.poll(async()=>{
        const rows=await sql<{waiting:boolean}>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND pid<>pg_backend_pid() AND wait_event_type='Lock') AS waiting`.execute(isolated.runtime.db);
        return rows.rows[0]?.waiting;
      },{timeout:200,interval:5}).toBe(true);
      await connection.query('COMMIT');committed=true;
      expect((await response).status).toBe(404);expect(calls).toBe(0);
      expect(await isolated.runtime.db.selectFrom('credit_charges').select('id').where('account_id','=',f.fixture.collectionId).execute()).toEqual([]);
    }finally{if(!committed)await connection.query('ROLLBACK');connection.release();await f.close();}
  });

  for (const window of ['reserve_before', 'reserve_after', 'finish_before', 'finish_after', 'dispatch_after']) {
    test('TX-07/09 ' + window + ': restart preserves one financial outcome and never repeats a dispatched call', async () => {
      const fixture = await seedClassificationTaxonomy(isolated.runtime);
      await grantCredits(isolated.runtime.db, { accountId: fixture.collectionId, grantKey: window, amount: 1 });
      const document = { source: 'web' as const, nodeId: fixture.nodeId, requested: { folder: true, tags: false },
        billing: { priceVersion: 'bookmark-classify.v1', maxPoints: 1 } };
      const context = await loadClassificationContext({ ...fixture, preview: document, tagsEnabled: false }, createPostgresClassificationTaxonomyReadPort(isolated.runtime.db));
      let restartedCalls = 0;
      const provider = creditCrashProvider(async () => { restartedCalls++; });
      const commandId = randomUUID();
      const seed: ClassificationExecutionSeed = {
        binding: { principalId: fixture.collectionId, commandScope: 'collections:classification-preview:v1', commandId },
        collectionId: fixture.collectionId, ownerSubjectId: fixture.ownerSubjectId, requestId: commandId,
        fingerprint: canonicalCommandFingerprint({ method: 'POST', route: `/api/v1/collections/${fixture.collectionId}/classification/preview`, mediaType: 'application/json', body: document }),
        context: context!, providerId: provider.id, model: provider.model, policyVersion: provider.policyVersion, promptVersion: provider.promptVersion,
        deadlineAt: new Date(Date.now() + 20_000).toISOString(), source: 'web', billing: document.billing,
      };
      const child = fork(new URL('../../support/classification-credit-crash-worker.ts', import.meta.url), [], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let originalCalls = 0;
      const paused = new Promise<void>((resolve, reject) => {
        child.on('message', (message: { kind: string; reason?: string }) => {
          if (message.kind === 'call') originalCalls++;
          else if (message.kind === 'paused') resolve();
          else reject(new Error('Crash barrier failed: ' + message.kind + ' ' + (message.reason ?? '')));
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Worker exited before crash barrier')));
      });
      child.send({ databaseUrl: isolated.databaseUrl, window, seed });
      try {
        await paused;
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        const chargesBefore = await isolated.runtime.db.selectFrom('credit_charges').select('state').where('account_id', '=', fixture.collectionId).execute();
        expect(chargesBefore).toEqual(window === 'reserve_before' ? [] : [{ state: window === 'finish_after' ? 'settled' : 'reserved' }]);
        // Advance only the abandoned lease clock; the original task deadline and command stay fixed.
        await sql`UPDATE classification_provider_executions SET lease_until=clock_timestamp()-interval '1 second'
          WHERE principal_id=${fixture.collectionId} AND state='running'`.execute(isolated.runtime.db);
        const restarted = createPostgresClassificationExecutionStore(isolated.runtime.db, {
          creditEnabled: true, credits: createPostgresAccountCreditsPort, cancelBackend: isolated.runtime.cancelBackend,
        });
        const prior = await restarted.lookup(seed);
        const admission = prior ?? await restarted.admit(seed);
        if (admission.kind !== 'replay') {
          const execution = await isolated.runtime.db.selectFrom('classification_provider_executions').select('id')
            .where('principal_id', '=', fixture.collectionId).where('command_id', '=', commandId).executeTakeFirstOrThrow();
          await runClassificationExecution(restarted, provider, execution.id, { enabled: () => true, onError: () => {} });
        }
        const final = await restarted.lookup(seed); expect(final?.kind).toBe('replay');
        if (final?.kind !== 'replay') throw new Error('No terminal receipt after restart');
        expect(final.result.status).toBe(window === 'dispatch_after' ? 503 : 200);
        const replay = await restarted.lookup(seed);
        expect(replay).toEqual(final);
        expect(originalCalls + restartedCalls).toBe(1);
        const charges = await isolated.runtime.db.selectFrom('credit_charges').select('state').where('account_id', '=', fixture.collectionId).execute();
        expect(charges).toEqual([{ state: window === 'dispatch_after' ? 'released' : 'settled' }]);
        const events = await isolated.runtime.db.selectFrom('credit_ledger_entries').select('kind').where('account_id', '=', fixture.collectionId).orderBy('sequence').execute();
        expect(events.map(event => event.kind)).toEqual(['grant', 'reserve', window === 'dispatch_after' ? 'release' : 'spend']);
      } finally {
        if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
      }
    }, 30_000);
  }
});
