import assert from 'node:assert/strict';
import { afterAll, beforeAll, test, vi } from 'vitest';
import { liveWorker } from './service-worker-live-harness.js';

let f: Awaited<ReturnType<typeof liveWorker>>;
beforeAll(async () => { f = await liveWorker(); });
afterAll(async () => { await f?.close(); });
async function send(message: unknown, origin = f.config.serverOrigin) {
  const responses: unknown[] = [];
  assert.deepEqual(f.external.emit(message, { url: `${origin}/collections` }, response => responses.push(response)), [true]);
  await vi.waitFor(() => assert.equal(responses.length, 1));
  return responses[0];
}

test('the external bridge validates the sender, persists its real draft and deduplicates the opened page', async () => {
  const message = { kind: 'known.subscription.open', requestId: '11111111-1111-4111-8111-111111111111',
    sourceType: 'collection', sourceId: 'collection-reference' };
  assert.deepEqual(await send(message, 'https://foreign.test'), { accepted: false });
  assert.equal(f.opened.length, 0);
  assert.deepEqual(await send(message), { accepted: true, protocolVersion: 1 });
  assert.equal(f.opened.length, 1);
  const { subscriptionStore } = await import('../src/bookmark-subscriptions/store.js');
  const stored = (await subscriptionStore.get('meta', 'external-draft'))?.value as typeof message;
  assert.equal(stored.sourceId, message.sourceId);
  assert.deepEqual(await send(message), { accepted: true, protocolVersion: 1 });
  assert.deepEqual(await send({ ...message, sourceId: 'different' }), { accepted: false });
  assert.equal(f.opened.length, 1); assert.deepEqual(f.api.calls, []);
});

test('a refused tab does not install a successful external-command receipt and may be retried', async () => {
  const message = { kind: 'known.subscription.open', requestId: '22222222-2222-4222-8222-222222222222',
    sourceType: 'collection', sourceId: 'later-reference' };
  const { subscriptionStore } = await import('../src/bookmark-subscriptions/store.js');
  f.tabs.fail = true;
  assert.deepEqual(await send(message), { accepted: false });
  assert.equal(await subscriptionStore.get('meta', `external-request:${message.requestId}`), undefined);
  f.tabs.fail = false;
  assert.deepEqual(await send(message), { accepted: true, protocolVersion: 1 });
  assert.equal(f.opened.length, 2); assert.deepEqual(f.api.calls, []);
});
