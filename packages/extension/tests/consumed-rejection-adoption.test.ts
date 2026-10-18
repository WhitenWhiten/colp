import 'fake-indexeddb/auto';
import { expect, test, vi } from 'vitest';
import { installOutboundPushIndexedDb, setup, scope } from './outbound-push-worker-harness.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
installOutboundPushIndexedDb();

test('historical receipt adoption resumes across pages; claiming does not repeatedly walk terminal receipts', async () => {
  const f = await setup();
  try {
    const db = await f.store.open(); const key = (await f.store.getScope(scope))!.scopeKey;
    const tx = db.transaction(['outbound_queue', 'receipts', 'schema_metadata', 'durable_sequences'], 'readwrite');
    for (let i = 1; i <= 2100; i++) {
      const opId = `historical-${i}`;
      tx.objectStore('outbound_queue').put({ ...f.queued, sequence: i, opId, status: 'terminal', payload: { ...f.queued.payload, opId, sequence: i } });
      tx.objectStore('receipts').put({ scopeKey: key, sequence: i, opId, kind: 'terminal', receiptId: `receipt-${i}`,
        operationDigest: f.queued.digest, resultDigest: 'sha256:history', result: { results: [{ opId, sequence: i,
          status: i === 1500 ? 'rejected' : 'noop', ...(i === 1500 ? { code: 'resource_id_unavailable' } : {}) }] } });
    }
    tx.objectStore('durable_sequences').put({ scopeKey: key, next: 2102 });
    tx.objectStore('outbound_queue').put({ ...f.queued, sequence: 2101, opId: 'fresh', payload: { ...f.queued.payload, sequence: 2101, opId: 'fresh' } });
    // Represents a worker stopped after its first bounded adoption page.
    tx.objectStore('schema_metadata').put({ key: `consumed-rejections-v1:${key}`, after: 1000, complete: false });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    f.store.close();
    // Session refresh re-registers existing scopes; it must preserve unfinished adoption.
    const { scopeKey: _scopeKey, ...registered } = (await f.store.getScope(scope))!;
    await f.store.registerScope(registered);
    expect((await readOpenSyncIssues(f.store, scope)).queue.map(row => row.opId)).toEqual(['historical-1500']);
    const get = IDBIndex.prototype.get; let receiptReads = 0;
    const spy = vi.spyOn(IDBIndex.prototype, 'get').mockImplementation(function(this: IDBIndex, query) {
      if (this.objectStore.name === 'receipts') receiptReads++;
      return get.call(this, query);
    });
    try {
      expect((await readOpenSyncIssues(f.store, scope)).total).toBe(1);
      const lease = await f.store.acquireLease(scope, 'adoption', 10000, 60000);
      expect((await f.store.claimNextQueue(scope, 'adoption', lease.fence, 10000))?.opId).toBe('fresh');
      expect(receiptReads).toBeLessThan(5);
    } finally { spy.mockRestore(); }
  } finally { f.store.close(); }
});
