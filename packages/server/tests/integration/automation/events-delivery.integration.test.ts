import { retainAutomationHistory } from '../../../src/infrastructure/automation/retention-worker.js';
import { readAutomationUsage } from '../../../src/infrastructure/automation/usage-read-store.js';
import { randomUUID } from 'node:crypto';
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
    expect(await readAutomationUsage(f.db,f.owner,f.rule.id,undefined,true)).toMatchObject({deliveryCapability:'available',acceptedDeliveries:1,succeededJobs:0});
    expect(await readAutomationUsage(f.db,f.owner,f.rule.id)).toMatchObject({deliveryCapability:'unavailable',acceptedDeliveries:null});
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
  test('two paired inboxes route independently; expiry clears keys and refresh does not replay old work',async()=>{
    await setup();const other=await f.ownerPost('/targets',{...f.target.configuration,name:'Second inbox'});expect(other.statusCode,other.body).toBe(201);
    const grant=await f.ownerPost(`/targets/${other.json().id}/pairings`,{reason:'Pair second inbox'},String(other.headers.etag));expect(grant.statusCode,grant.body).toBe(201);
    expect((await f.pair(grant.json())).statusCode).toBe(200);
    const store=createSubscriptionStore(f.db,f.worker,{...cipher,verify:async()=>{}}),input={name:'colp.automation.triggered' as const,arguments:{targetId:other.json().id},delivery:{mode:'webhook' as const,url:'https://receiver.example',secret}};
    const subscription=await store.subscribe(f.actor,input);expect(subscription.id).not.toBe((await rows())[0]!.subscription_id);
    await f.createNode('routed','root','Routed','https://arxiv.org/routed');await f.inspect();
    expect((await sql`SELECT id FROM automation_event_deliveries WHERE target_id=${other.json().id}`.execute(f.db)).rows).toEqual([]);
    await expect(store.subscribe({...f.actor,clientId:'foreign-client'},input)).rejects.toMatchObject({code:'resource_not_found'});
    await sql`UPDATE automation_event_subscriptions SET refresh_before=clock_timestamp()-interval '1 second' WHERE id=${subscription.id}`.execute(f.db);
    await retainAutomationHistory(f.db,f.owner.accountId);
    expect((await sql<{state:string;secret_ciphertext:string|null}>`SELECT state,secret_ciphertext FROM automation_event_subscriptions WHERE id=${subscription.id}`.execute(f.db)).rows[0]).toEqual({state:'expired',secret_ciphertext:null});
    expect((await store.subscribe(f.actor,input)).id).toBe(subscription.id);
    expect((await sql`SELECT id FROM automation_event_deliveries WHERE target_id=${other.json().id}`.execute(f.db)).rows).toEqual([]);
  });
  test('a fast host claim before the HTTP response does not relabel an accepted callback cancelled',async()=>{
    await setup();const worker=createDeliveryWorker(f.db,f.worker.authorize,{...cipher,send:async(_url,body)=>{
      const event=JSON.parse(body);await f.work!.mutate(f.actor,event.data.jobId,'claim',{deliveryHandle:event.data.deliveryHandle},randomUUID());
      return {status:200,retryAfter:null};
    }});
    await worker.tick();expect((await rows())[0]?.state).toBe('accepted');
    expect((await sql<{state:string}>`SELECT state FROM automation_jobs`.execute(f.db)).rows[0]?.state).toBe('leased');
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
  test('renewal preserves queued wakes and verification failure keeps the active path',async()=>{
    await setup();
    const input={name:'colp.automation.triggered' as const,arguments:{targetId:f.target.id},delivery:{mode:'webhook' as const,url:'https://receiver.example',secret}};
    const store=createSubscriptionStore(f.db,f.worker,{...cipher,verify:async()=>{}});
    await store.subscribe(f.actor,input);
    let sent=0;
    const worker=createDeliveryWorker(f.db,f.worker.authorize,{...cipher,send:async()=>{sent++;return {status:204,retryAfter:null};}});
    await worker.tick();expect(sent).toBe(1);expect((await rows())[0]!.state).toBe('accepted');
    await expect(createSubscriptionStore(f.db,f.worker,{...cipher,verify:async()=>{throw new Error('challenge unavailable');}}).subscribe(f.actor,input)).rejects.toMatchObject({code:-32015});
    await f.createNode('after-renewal','root','Renewal','https://arxiv.org/renewal');await f.inspect();
    await worker.tick();expect(sent).toBe(2);
    expect((await sql<{state:string}>`SELECT state FROM automation_event_subscriptions`.execute(f.db)).rows[0]!.state).toBe('active');
  });

});
