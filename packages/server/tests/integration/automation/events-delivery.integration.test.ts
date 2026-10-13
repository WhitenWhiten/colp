import { afterEach,expect,test } from 'vitest';
import { sql } from 'kysely';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createSubscriptionStore } from '../../../src/infrastructure/automation/subscription-store.js';
import { createWebhookCipher } from '../../../src/infrastructure/automation/webhook-signer.js';
import { createDeliveryWorker } from '../../../src/infrastructure/automation/delivery-worker.js';
import { createOwnerDeliveryStore } from '../../../src/infrastructure/automation/delivery-store.js';
const secret='whsec_'+Buffer.alloc(32,9).toString('base64'),cipher=createWebhookCipher(Buffer.alloc(32,8));
describeWithPostgres('AW-29 durable ready wake delivery',() => {
  let f:Awaited<ReturnType<typeof automationPollingFixture>>;
  afterEach(async()=>{await f?.close();});
  async function setup() {
    f=await automationPollingFixture('aw29_delivery',{ wakeMode:'events',pair:async (base,grant)=>{
      expect((await base.pair(grant)).statusCode).toBe(200);
      await createSubscriptionStore(base.db,base.worker,{ ...cipher,verify:async()=>{} }).subscribe(base.actor,{
        name:'colp.automation.triggered',arguments:{targetId:grant.targetId},delivery:{mode:'webhook',url:'https://receiver.example',secret} });
    }});
  }
  const rows=async()=> (await sql<{ id:string;body:string;state:string;attempt_count:number;subscription_id:string }>`SELECT * FROM automation_event_deliveries ORDER BY created_at,id`.execute(f.db)).rows;
  test('atomic ready wake contains references only; retry/restart preserve bytes and acceptance does not execute a job',async()=>{
    await setup();const first=(await rows())[0]!;expect(await rows()).toHaveLength(1);
    expect(first.body).not.toContain('Private paper');expect(JSON.parse(first.body).data).toMatchObject({targetId:f.target.id,matchedCount:1});
    const sent:string[]=[];
    const failing=createDeliveryWorker(f.db,f.worker.authorize,{...cipher,send:async(_url,body)=>{sent.push(body);return {status:503,retryAfter:'1'};}});
    await Promise.all([failing.tick(),failing.tick()]);expect(sent).toHaveLength(1);expect((await rows())[0]?.state).toBe('retrying');
    await sql`UPDATE automation_event_deliveries SET next_attempt_at=clock_timestamp()-interval '1 second'`.execute(f.db);
    const recovered=createDeliveryWorker(f.db,f.worker.authorize,{...cipher,send:async(_url,body)=>{sent.push(body);return {status:204,retryAfter:null};}});
    await recovered.tick();expect(sent).toEqual([first.body,first.body]);expect((await rows())[0]?.state).toBe('accepted');expect(await recovered.tick()).toBe(false);
    expect((await sql<{state:string}>`SELECT state FROM automation_jobs`.execute(f.db)).rows).toEqual([{state:'ready'}]);
    const visible=await f.db.transaction().execute(tx=>createOwnerDeliveryStore(tx,f.owner).list(null,100));expect(visible[0]?.view.state).toBe('accepted');
    expect(JSON.stringify(visible)).not.toContain('receiver.example');
  });
  test('413 terminates only one occurrence while 410 revokes the subscription path',async()=>{
    await setup();const worker=createDeliveryWorker(f.db,f.worker.authorize,{...cipher,send:async()=>({status:413,retryAfter:null})});
    await worker.tick();expect((await rows())[0]?.state).toBe('deadLetter');
    expect((await sql<{state:string}>`SELECT state FROM automation_event_subscriptions`.execute(f.db)).rows[0]?.state).toBe('active');
    await f.createNode('another','root','Another','https://arxiv.org/abs/another');await f.inspect();expect(await rows()).toHaveLength(2);
    await createDeliveryWorker(f.db,f.worker.authorize,{...cipher,send:async()=>({status:410,retryAfter:null})}).tick();
    expect((await sql<{state:string}>`SELECT state FROM automation_event_subscriptions`.execute(f.db)).rows[0]?.state).toBe('revoked');
  });
  test('pause prevents sending and revocation during an in-flight send fences completion',async()=>{
    await setup();let sent=0;
    const worker=createDeliveryWorker(f.db,f.worker.authorize,{...cipher,send:async()=>{
      sent++;await sql`UPDATE automation_targets SET revoked=true WHERE id=${f.target.id}`.execute(f.db);return {status:200,retryAfter:null};
    }});
    await sql`INSERT INTO automation_settings(owner_id,paused) VALUES(${f.owner.accountId},true) ON CONFLICT(owner_id) DO UPDATE SET paused=true`.execute(f.db);
    expect(await worker.tick()).toBe(false);expect(sent).toBe(0);
    await sql`UPDATE automation_settings SET paused=false WHERE owner_id=${f.owner.accountId}`.execute(f.db);
    await worker.tick();expect(sent).toBe(1);expect((await rows())[0]?.state).toBe('cancelled');
  });
});
