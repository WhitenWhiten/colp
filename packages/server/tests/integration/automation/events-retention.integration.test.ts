import { afterEach,expect,test } from 'vitest';
import { sql, type KyselyPlugin } from 'kysely';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { retainAutomationHistory } from '../../../src/infrastructure/automation/retention-worker.js';
import { createSubscriptionStore } from '../../../src/infrastructure/automation/subscription-store.js';
import { createWebhookCipher } from '../../../src/infrastructure/automation/webhook-signer.js';
import { createDeliveryWorker } from '../../../src/infrastructure/automation/delivery-worker.js';
import { readRepositoryFile } from '../../support/repository-files.js';
const cipher=createWebhookCipher(Buffer.alloc(32,1));
describeWithPostgres('AW-44 retention and restore',()=>{
  let f:Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async()=>{await f?.close();});
  async function setup() {
    f=await automationPollingFixture('aw44_retention',{wakeMode:'events',pair:async(base,grant)=>{
      expect((await base.pair(grant)).statusCode).toBe(200);
      await createSubscriptionStore(base.db,base.worker,{...cipher,verify:async()=>{}}).subscribe(base.actor,{name:'colp.automation.triggered',arguments:{targetId:grant.targetId},
        delivery:{mode:'webhook',url:'https://receiver.example',secret:'whsec_'+Buffer.alloc(32,2).toString('base64')}});
    }});
  }
  test('expired wakes leave a terminal record, incident and unchanged ready-job pins',async()=>{
    await setup();const before=(await sql`SELECT * FROM automation_jobs`.execute(f.db)).rows;
    await sql`UPDATE automation_event_deliveries SET created_at=clock_timestamp()-interval '8 days'`.execute(f.db);
    expect(await retainAutomationHistory(f.db,f.owner.accountId)).toBe(1);expect(await retainAutomationHistory(f.db,f.owner.accountId)).toBe(0);
    expect((await sql`SELECT * FROM automation_jobs`.execute(f.db)).rows).toEqual(before);
    expect((await sql<{state:string;last_error_code:string}>`SELECT state,last_error_code FROM automation_event_deliveries`.execute(f.db)).rows).toEqual([{state:'deadLetter',last_error_code:'retention_expired'}]);
    expect((await sql`SELECT id FROM automation_incidents WHERE code='deliveryFailure'`.execute(f.db)).rows).toHaveLength(1);
  });
  test('bounded intake under a slow worker retains queued work and permits configuration reads',async()=>{
    await setup();const started=performance.now();
    for (let i=0;i<25;i++) await f.createNode('load-'+i,'root','Load '+i,'https://arxiv.org/abs/load-'+i);
    await f.inspect();
    const elapsed=performance.now()-started;
    const jobs=(await sql<{n:number}>`SELECT count(*)::int AS n FROM automation_jobs WHERE state='ready'`.execute(f.db)).rows[0]!.n;
    expect(jobs).toBe(26);
    const response=await f.app.inject({url:'/api/v1/me/automations/rules',headers:{cookie:f.owner.cookie}});expect(response.statusCode).toBe(200);
    console.log(JSON.stringify({measurement:'AW-44 queued intake',bookmarks:25,readyJobs:jobs,elapsedMs:Math.round(elapsed)}));
  });
  test('deployment restore SQL pauses, fences external leases and cancels wakes before resume',async()=>{
    await setup();const job=(await f.work!.list(f.actor,{targetId:f.target.id})).items[0]!;
    await f.work!.mutate(f.actor,job.id,'claim',{deliveryHandle:job.deliveryHandle},crypto.randomUUID());
    const script=readRepositoryFile('deploy/restore.sh'),restore=script.split("<<'SQL'\n")[1]!.split('\nSQL')[0]!;
    await sql.raw(restore).execute(f.db);await sql.raw(restore).execute(f.db);
    expect((await sql<{state:string}>`SELECT state FROM automation_jobs`.execute(f.db)).rows[0]?.state).toBe('uncertain');
    expect((await sql<{outcome:string}>`SELECT outcome FROM automation_job_attempts`.execute(f.db)).rows[0]?.outcome).toBe('unknownOutcome');
    expect((await sql<{state:string}>`SELECT state FROM automation_event_subscriptions`.execute(f.db)).rows[0]?.state).toBe('revalidation');
    let sends=0;expect(await createDeliveryWorker(f.db,f.worker.authorize,{...cipher,send:async()=>{sends++;return {status:200,retryAfter:null};}}).tick()).toBe(false);expect(sends).toBe(0);
  });
  test('M1 housekeeping never queries optional worker or Events tables',async()=>{
    await setup();const queries:string[]=[];
    const plugin:KyselyPlugin={transformQuery:({node})=>{queries.push(JSON.stringify(node));return node;},transformResult:async({result})=>result};
    await retainAutomationHistory(f.db.withPlugin(plugin),f.owner.accountId,false);
    expect(queries.join(' ')).toContain('automation_preview_records');
    expect(queries.join(' ')).not.toMatch(/automation_pairings|automation_event_subscriptions|automation_event_deliveries/);
  });

});
