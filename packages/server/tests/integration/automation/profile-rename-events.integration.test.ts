import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, expect, test } from 'vitest';
import { automationPollingFixture } from '../../support/automation-polling-fixture.js';
import { automationWorkerFixture } from '../../support/automation-worker-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createSubscriptionStore } from '../../../src/infrastructure/automation/subscription-store.js';
import { createDeliveryWorker } from '../../../src/infrastructure/automation/delivery-worker.js';
import { createWebhookCipher } from '../../../src/infrastructure/automation/webhook-signer.js';
const cipher = createWebhookCipher(Buffer.alloc(32, 1));
describeWithPostgres('connection profile display edits preserve current authority', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); });
  test('a rename preserves queued delivery and future job wakeups', async () => {
    const f = await automationPollingFixture('profile_rename', { wakeMode: 'events', pair: async (base, grant) => {
      expect((await base.pair(grant)).statusCode).toBe(200);
      await createSubscriptionStore(base.db, base.worker, { ...cipher, verify: async () => {} }).subscribe(base.actor, {
        name: 'colp.automation.triggered', arguments: { targetId: grant.targetId },
        delivery: { mode: 'webhook', url: 'https://receiver.example/hook', secret: 'whsec_' + Buffer.alloc(32, 2).toString('base64') },
      });
    } }); close = f.close;
    const profile = await f.db.selectFrom('automation_connection_profiles').selectAll().executeTakeFirstOrThrow();
    const before = await f.db.selectFrom('automation_event_subscriptions').selectAll().executeTakeFirstOrThrow();
    const response = await f.app.inject({ method: 'PUT', url: `/api/v1/me/automations/connection-profiles/${profile.id}`,
      headers: f.ownerHeaders(randomUUID(), `"${profile.revision}"`), payload: { ...profile.configuration_json, name: 'Display name only' } });
    expect(response.statusCode, response.body).toBe(200);
    const after = await f.db.selectFrom('automation_event_subscriptions').selectAll().executeTakeFirstOrThrow();
    expect(after.profile_revision).toBe(response.json().revision);
    expect(after.generation).toBe(before.generation); expect(after.pairing_generation).toBe(before.pairing_generation);
    let sent = 0;
    const worker = createDeliveryWorker(f.db, f.worker.authorize, { ...cipher, send: async () => { sent++; return { status: 200, retryAfter: null }; } });
    expect(await worker.tick()).toBe(true); expect(sent).toBe(1);
    await f.createNode('after-rename', 'root', 'New paper', 'https://arxiv.org/abs/after-rename'); await f.inspect();
    expect(await worker.tick()).toBe(true); expect(sent).toBe(2);
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM automation_event_deliveries WHERE state='accepted'`.execute(f.db)).rows[0]?.n).toBe(2);
  });
  test('an unused pairing grant survives a profile rename', async () => {
    const f = await automationWorkerFixture('pairing_rename'); close = f.close;
    const s = await f.setup();
    const response = await f.app.inject({ method: 'PUT', url: `/api/v1/me/automations/connection-profiles/${s.profile.id}`,
      headers: f.ownerHeaders(randomUUID(), `"${s.profile.revision}"`), payload: { ...s.profile.configuration, name: 'Renamed before pairing' } });
    expect(response.statusCode, response.body).toBe(200);
    const paired = await f.pair(s.grant); expect(paired.statusCode, paired.body).toBe(200);
  });
});
