import { afterEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationWorkerFixture } from '../../support/automation-worker-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createSubscriptionStore, type SubscriptionVerifier } from '../../../src/infrastructure/automation/subscription-store.js';
import { parseMcpEventsParams, type McpEventSubscription } from '@know-n/colp/mcp';

describeWithPostgres('AW-27 durable Events subscriptions', () => {
  let f: Awaited<ReturnType<typeof automationWorkerFixture>>;
  afterEach(async () => { await f?.close(); });
  async function setup() {
    f = await automationWorkerFixture('aw27_events');
    const s = await f.setup({ wakeMode: 'events' });
    expect((await f.pair(s.grant)).statusCode).toBe(200);
    return parseMcpEventsParams('events/subscribe',{ name: 'colp.automation.triggered',arguments: { targetId: s.target.id },
      delivery: { mode: 'webhook',url: 'https://receiver.example/callback',secret: 'whsec_'+Buffer.alloc(32,1).toString('base64') } })!;
  }
  // Lifecycle-only test double: AW-28 separately verifies real encryption and callback transport.
  const verifier: SubscriptionVerifier = { verify: async () => {}, encrypt: () => 'opaque-test-ciphertext' };
  test('refresh/restart retain identity; unsubscribe is idempotent; TTL is finite; no plaintext secret persists',async () => {
    const input = await setup(), store = createSubscriptionStore(f.db,f.worker,verifier);
    const first = await store.subscribe(f.actor,input);
    const second = await createSubscriptionStore(f.db,f.worker,verifier).subscribe(f.actor,{ ...input,ttlMs: 1 });
    expect(second.id).toBe(first.id); expect(second.cursor).toBeNull(); expect(second.truncated).toBe(false);
    expect(Date.parse(second.refreshBefore)-Date.now()).toBeGreaterThan(50_000);
    const rows = (await sql`SELECT * FROM automation_event_subscriptions`.execute(f.db)).rows;
    expect(rows).toHaveLength(1);expect(JSON.stringify(rows)).not.toContain(input.delivery.secret);
    await store.unsubscribe(f.actor,input);await store.unsubscribe(f.actor,input);
    expect((await sql<{ state: string; secret_ciphertext: string | null }>`SELECT state,secret_ciphertext FROM automation_event_subscriptions`.execute(f.db)).rows[0]).toEqual({ state: 'revoked',secret_ciphertext: null });
    expect(await createSubscriptionStore(f.db,f.worker).available(f.actor)).toBe(false);
  });
  test('authenticated refresh replaces expiring token observations and bounds the advertised lifetime',async()=>{
    const input=await setup(),store=createSubscriptionStore(f.db,f.worker,verifier),first=await store.subscribe(f.actor,input);
    const verified=await f.verifier.verify({authorization:'Bearer '+await f.mint(),requiredScopes:['automation:work']});
    expect(verified.automationConnectionId).toBe(f.actor.credentialBindingId);
    const actor={...f.actor,...verified.binding,credentialBindingId:verified.automationConnectionId!,credentialDigest:verified.credentialDigest,expiresAt:verified.expiresAt.toISOString(),issuedAtSeconds:verified.issuedAtSeconds,accountSecurityEpoch:verified.accountSecurityEpoch};
    const refreshed=await store.subscribe(actor,input);expect(refreshed.id).toBe(first.id);expect(Date.parse(refreshed.refreshBefore)).toBeLessThanOrEqual(verified.expiresAt.getTime());
    const observation=(await sql<{observation_json:{credentialDigest:string}}>`SELECT observation_json FROM automation_connection_profiles`.execute(f.db)).rows[0]!.observation_json;
    expect(observation.credentialDigest).toBe(verified.credentialDigest);expect(observation.credentialDigest).not.toBe(f.actor.credentialDigest);
    await expect(store.subscribe({...actor,expiresAt:new Date(Date.now()+30_000).toISOString()},input)).rejects.toMatchObject({code:-32602});
  });
  test('slow verification cannot resurrect an unsubscribe or overtake a later refresh',async () => {
    const input = await setup(); let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered=resolve; });
    const blocked = new Promise<void>(resolve => { release=resolve; });
    const slow = createSubscriptionStore(f.db,f.worker,{ ...verifier,verify: async () => { entered();await blocked; } });
    const pending = slow.subscribe(f.actor,input); const failure = expect(pending).rejects.toMatchObject({ code: -32015 });
    await started;
    await createSubscriptionStore(f.db,f.worker,verifier).unsubscribe(f.actor,input);
    release();await failure;
    const row = (await sql<{ state: string }>`SELECT state FROM automation_event_subscriptions`.execute(f.db)).rows[0]!;
    expect(row.state).toBe('revoked');
  });
  test('verification failure and foreign target cannot activate; revoked credentials fail closed',async () => {
    const input = await setup(), store = createSubscriptionStore(f.db,f.worker,{ ...verifier,verify: async () => { throw new Error('private receiver body'); } });
    await expect(store.subscribe(f.actor,input)).rejects.toMatchObject({ code: -32015,message: 'Callback verification failed.' });
    await expect(store.subscribe(f.actor,{ ...input,arguments: { targetId: 'foreign' } } as McpEventSubscription)).rejects.toMatchObject({ code: 'resource_not_found' });
    await f.revocations.revokeClient(f.actor.clientId);
    expect(await store.available(f.actor)).toBe(false);
    await expect(store.subscribe(f.actor,input)).rejects.toMatchObject({ code: 'resource_not_found' });
  });
  test('expired and revoked identities do not consume live slots; revival still respects the active cap',async()=>{
    const input=await setup(),store=createSubscriptionStore(f.db,f.worker,verifier);
    const original=await store.subscribe(f.actor,input);
    await sql`INSERT INTO automation_event_subscriptions(id,owner_id,target_id,profile_id,identity_digest,callback_url,profile_revision,pairing_generation,state,refresh_before)
      SELECT 'retained-'||n,owner_id,target_id,profile_id,'retained-digest-'||n,callback_url,profile_revision,pairing_generation,
        'expired',clock_timestamp()-interval '1 day' FROM automation_event_subscriptions CROSS JOIN generate_series(1,100) n WHERE id=${original.id}`.execute(f.db);
    const other=await store.subscribe(f.actor,{...input,delivery:{...input.delivery,url:'https://receiver.example/other'}});
    expect(other.id).not.toBe(original.id);
    await sql`UPDATE automation_event_subscriptions SET state='active',refresh_before=clock_timestamp()+interval '1 hour'
      WHERE id IN (SELECT id FROM automation_event_subscriptions WHERE id LIKE 'retained-%' ORDER BY id LIMIT 98)`.execute(f.db);
    await expect(store.subscribe(f.actor,{...input,delivery:{...input.delivery,url:'https://receiver.example/full'}})).rejects.toMatchObject({code:'payload_too_large'});
    expect((await store.subscribe(f.actor,input)).id).toBe(original.id);
    await store.unsubscribe(f.actor,input);
    expect((await store.subscribe(f.actor,input)).id).toBe(original.id);
  });

  test('failed callback variants leave no unreferenced durable reservations', async () => {
    const input = await setup();
    const store = createSubscriptionStore(f.db, f.worker, { ...verifier, verify: async () => { throw new Error('challenge failed'); } });
    for (let i = 0; i < 105; i++) {
      await expect(store.subscribe(f.actor, { ...input, delivery: { ...input.delivery, url: `https://receiver.example/hook?nonce=${i}` } }))
        .rejects.toMatchObject({ code: -32015 });
    }
    expect((await sql`SELECT id FROM automation_event_subscriptions`.execute(f.db)).rows).toHaveLength(0);
  });
  test('the retained-row cap is separate from live slots and allows an existing renewal', async () => {
    const input = await setup(), store = createSubscriptionStore(f.db, f.worker, verifier);
    const original = await store.subscribe(f.actor, input);
    await sql`INSERT INTO automation_event_subscriptions(id,owner_id,target_id,profile_id,identity_digest,callback_url,profile_revision,pairing_generation,state,refresh_before)
      SELECT 'history-'||n,owner_id,target_id,profile_id,'history-digest-'||n,callback_url,profile_revision,pairing_generation,
        'expired',clock_timestamp()-interval '1 day' FROM automation_event_subscriptions CROSS JOIN generate_series(1,999) n WHERE id=${original.id}`.execute(f.db);
    await expect(store.subscribe(f.actor, { ...input, delivery: { ...input.delivery, url: 'https://receiver.example/new' } }))
      .rejects.toMatchObject({ code: 'payload_too_large', message: 'Retained subscription limit reached.' });
    expect((await store.subscribe(f.actor, input)).id).toBe(original.id);
  });

});
