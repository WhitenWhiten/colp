import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { pendingLocalContentFields } from '../src/pull-queue-facts.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('P3-28 pull history pruning', () => {
  test('RECHECK: pre-upgrade applied echo must remain acknowledged after pruning', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active',
      lease: { leaseId: 'lease-1', expiresAt: Date.parse('2099-01-01') },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    const queued = await store.allocateSequenceAndEnqueue(scope, {
      opId: 'old-local-update', batchId: 'batch-old', idempotencyKey: 'key-old',
      digest: 'sha256:old', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'revision-0', operationRevision: 'local-old', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: 'node-1',
        payload: { base: { title: 'Original' }, value: { title: 'Old local title' } } },
    }, { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
      operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-old', resultDigest: 'sha256:result' });
    await store.stagePullPage(scope, { pageId: 'page-1', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
      collectionRevision: 'revision-1', pageDigest: 'sha256:p1', effectPages: [], events: [{
        eventId: 'own-echo', cursor: 'cursor-1', operationId: queued.opId, effectId: queued.opId,
        effectDigest: 'sha256:effect', operationDigest: queued.digest, kind: 'node_content_updated',
        payload: {}, initialState: 'authority_committed',
      }] });
    await store.completePullPage(scope, 'page-1');
    // Reproduce the persisted shape written before echoApplied was introduced.
    store.close();
    const open = indexedDB.open('known-phase3-indexeddb-entry');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const tx = db.transaction('outbound_queue', 'readwrite');
    const rows = tx.objectStore('outbound_queue');
    const request = rows.openCursor();
    request.onsuccess = () => {
      const cursor = request.result; if (!cursor) return;
      const { echoApplied: _, ...oldRow } = cursor.value;
      cursor.update(oldRow); cursor.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
    const mapping = { colpId: 'node-1', nativeId: 'native-1' };
    assert.deepEqual(await pendingLocalContentFields(store, scope, mapping), {});
    await new Promise(resolve => setTimeout(resolve, 5));
    await store.stagePullPage(scope, { pageId: 'page-2', previousCursor: 'cursor-1', nextCursor: 'cursor-2',
      collectionRevision: 'revision-2', pageDigest: 'sha256:p2', effectPages: [], events: [] });
    await store.completePullPage(scope, 'page-2');
    assert.equal(await store.prunePullHistory(scope, 1), 1);
    store.close();
    assert.equal((await store.getQueueByOpId(scope, queued.opId))?.echoApplied, true);
    assert.deepEqual(await pendingLocalContentFields(store, scope, mapping), {},
      'an acknowledged historical title must never become a protected local overlay again');
  });

});
