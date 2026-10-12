import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import {
  LARGE_QUEUE_CONTRACT_SIZE, createSyncStateStore, type SyncScope,
} from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('P3-31 claim pagination beyond the large-queue contract', () => {
  test('claimNextQueue claims outstanding work behind a full page of terminal rows', async () => {
    // The queue is never pruned. Once a scope accumulates more than one
    // LARGE_QUEUE_CONTRACT_SIZE page of terminal rows, the head claim must
    // keep paging by sequence instead of silently reporting an idle queue —
    // otherwise outbound push wedges forever for long-lived scopes.
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [] });
    const scopeKey = (await store.getScope(scope))!.scopeKey;
    // One full single-page read (contract size + 1) must NOT cover the
    // outstanding row, or the regression stays invisible.
    const total = LARGE_QUEUE_CONTRACT_SIZE + 2;
    const db = await store.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('outbound_queue', 'readwrite');
      const queue = tx.objectStore('outbound_queue');
      for (let sequence = 1; sequence <= total; sequence += 1) {
        queue.add({ scopeKey, sequence, opId: `op-${sequence}`, batchId: `batch-${sequence}`,
          idempotencyKey: `idempotency-${sequence}`, digest: `sha256:op-${sequence}`, endpointIdentity: 'syncPush',
          mediaType: 'application/vnd.collection-protocol.sync+json', baseRevision: 'revision-0',
          operationRevision: 'revision-local-1', status: sequence === total ? 'pending' : 'terminal',
          retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node', targetId: 'node-1' } });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
      tx.onabort = () => reject(tx.error as Error);
    });
    const lease = await store.acquireLease(scope, 'owner-1', 1_000, 60_000);
    assert.equal(lease.outcome, 'acquired');
    const claimed = await store.claimNextQueue(scope, 'owner-1', lease.fence, 2_000);
    assert.equal(claimed?.sequence, total);
    assert.equal(claimed?.status, 'claimed');
    store.close();
  }, 120_000);

  test('claimNextQueue treats a rejected head as settled history and claims the work behind it', async () => {
    // A permanently refused operation ('rejected', retryable:false) is
    // settled history everywhere else — firstOutstanding, commitRecovery and
    // hasRecoverableQueueWork all skip it. The head claim must agree, or one
    // bad operation silently wedges every later local edit forever. A 'gap'
    // or 'blocked' head stays a real order barrier.
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [] });
    const scopeKey = (await store.getScope(scope))!.scopeKey;
    const db = await store.open();
    const seed = (sequence: number, status: string) => ({ scopeKey, sequence, opId: `op-${sequence}`,
      batchId: `batch-${sequence}`, idempotencyKey: `idempotency-${sequence}`, digest: `sha256:op-${sequence}`,
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'revision-0',
      operationRevision: 'revision-local-1', status, retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'update_node', targetId: 'node-1' },
      ...(status === 'rejected' ? { recovery: { code: 'payload_too_large' } } : {}) });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('outbound_queue', 'readwrite');
      const queue = tx.objectStore('outbound_queue');
      queue.add(seed(1, 'rejected'));
      queue.add(seed(2, 'pending'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
      tx.onabort = () => reject(tx.error as Error);
    });
    const lease = await store.acquireLease(scope, 'owner-1', 1_000, 60_000);
    assert.equal(lease.outcome, 'acquired');
    const claimed = await store.claimNextQueue(scope, 'owner-1', lease.fence, 2_000);
    assert.equal(claimed?.sequence, 2);
    assert.equal(claimed?.status, 'claimed');
    // The rejected row itself is never claimed again outside the explicit
    // import retry path.
    assert.equal((await store.listQueue(scope))[0]?.status, 'rejected');
    store.close();
  });

  test('claimNextQueue keeps gap and blocked heads as order barriers', async () => {
    for (const barrier of ['gap', 'blocked'] as const) {
      const isolated = new IDBFactory();
      const store = createSyncStateStore({ indexedDB: isolated });
      await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
        checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [] });
      const scopeKey = (await store.getScope(scope))!.scopeKey;
      const db = await store.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('outbound_queue', 'readwrite');
        const queue = tx.objectStore('outbound_queue');
        queue.add({ scopeKey, sequence: 1, opId: 'op-1', batchId: 'batch-1', idempotencyKey: 'idempotency-1',
          digest: 'sha256:op-1', endpointIdentity: 'syncPush', mediaType: 'application/json',
          baseRevision: 'revision-0', operationRevision: 'revision-local-1', status: barrier,
          retry: { attempt: 1, notBefore: 0 }, recovery: { code: `sequence_${barrier === 'gap' ? 'gap' : 'blocked'}` },
          payload: { type: 'update_node', targetId: 'node-1' } });
        queue.add({ scopeKey, sequence: 2, opId: 'op-2', batchId: 'batch-2', idempotencyKey: 'idempotency-2',
          digest: 'sha256:op-2', endpointIdentity: 'syncPush', mediaType: 'application/json',
          baseRevision: 'revision-0', operationRevision: 'revision-local-1', status: 'pending',
          retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node', targetId: 'node-1' } });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
        tx.onabort = () => reject(tx.error as Error);
      });
      const lease = await store.acquireLease(scope, 'owner-1', 1_000, 60_000);
      assert.equal(await store.claimNextQueue(scope, 'owner-1', lease.fence, 2_000), null,
        `${barrier} head must keep blocking later work`);
      store.close();
    }
  });
});
