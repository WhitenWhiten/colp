import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { KNS09_STOP_METRICS, resetKns09MetricsForTests, snapshotKns09Metrics, kns09Paused } from '../src/kns-09-release.js';
import { installOutboundPushIndexedDb, scope, setup } from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

test('a wrongly scoped durable Operation is stopped before HTTP and freezes the real scope', async () => {
  resetKns09MetricsForTests();
  const f = await setup();
  const db = await f.store.open(); const tx = db.transaction('outbound_queue', 'readwrite');
  tx.objectStore('outbound_queue').put({ ...f.queued, payload: { ...f.queued.payload, collectionId: 'different-collection' } });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
  });
  let requests = 0;
  const result = await createOutboundPushWorker({ ...f.options, fetch: async () => {
    requests++; throw new Error('must_not_send');
  } }).drain();
  assert.equal(result.outcome, 'unknown'); assert.equal(requests, 0);
  assert.equal((await f.store.getScope(scope))?.lifecycle, 'recovery_required');
  assert.equal((await f.store.listQueue(scope))[0]?.recovery?.code, 'push_scope_mismatch');
  assert.equal(snapshotKns09Metrics().counters[KNS09_STOP_METRICS.outOfScopeUpload], 1);
  assert.equal(await kns09Paused('ingress'), true);
});
