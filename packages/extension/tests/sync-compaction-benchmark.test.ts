import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createSyncStateStore, type QueueOperation, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

describe('sync compaction 100k contract', () => {
  let indexedDB: IDBFactory;
  beforeEach(() => { indexedDB = new IDBFactory(); });

  test('claim and pending event lookup stay bounded with 100k terminal history plus one pending', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({
      ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
      checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [],
    });
    const key = (await store.getScope(scope))!.scopeKey;
    const db = await store.open();
    const tx = db.transaction(
      ['outbound_queue', 'durable_sequences', 'bookmark_events'],
      'readwrite',
    );
    const queue = tx.objectStore('outbound_queue');
    const events = tx.objectStore('bookmark_events');
    for (let sequence = 1; sequence <= 100_000; sequence += 1) {
      const opId = `op-${sequence}`;
      queue.add({
        scopeKey: key, sequence, opId, batchId: `batch-${sequence}`, idempotencyKey: `key-${sequence}`,
        digest: `sha256:${opId}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
        baseRevision: 'revision-0', operationRevision: `local-${sequence}`, status: 'terminal',
        retry: { attempt: 1, notBefore: 0 }, payload: { type: 'update_node', targetId: 'node-1' },
      } satisfies QueueOperation & { scopeKey: string });
      events.add({
        scopeKey: key, eventId: `event-${sequence}`, ordinal: sequence, status: 'processed', opId,
        dedupeKey: `dedupe-${sequence}`, occurredAt: '2026-08-30T00:00:00.000Z', kind: 'change',
        nativeId: `native-${sequence}`, details: { bulky: true },
      });
    }
    queue.add({
      scopeKey: key, sequence: 100_001, opId: 'op-pending', batchId: 'batch-pending',
      idempotencyKey: 'key-pending', digest: 'sha256:op-pending', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: 'revision-0', operationRevision: 'local-pending',
      status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'update_node', targetId: 'node-pending' },
    });
    events.add({
      scopeKey: key, eventId: 'event-pending', ordinal: 100_001, status: 'pending', opId: null,
      dedupeKey: 'dedupe-pending', occurredAt: '2026-08-30T00:00:01.000Z', kind: 'change',
      nativeId: 'native-pending', details: { live: true },
    });
    tx.objectStore('durable_sequences').put({ scopeKey: key, next: 100_002 });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });

    const lease = await store.acquireLease(scope, 'owner-1', 1_000, 90_000);
    assert.equal(lease.outcome, 'acquired');
    const started = Date.now();
    const pendingQueue = await store.listQueue(scope, 'pending', 0, 10);
    const pendingEvents = await store.listBookmarkEventsByStatus(scope, 'pending', 0, 10);
    const claimed = await store.claimNextQueue(scope, 'owner-1', lease.fence, 2_000);
    const lookupMs = Date.now() - started;
    assert.deepEqual(pendingQueue.map((row) => row.opId), ['op-pending']);
    assert.deepEqual(pendingEvents.map((row) => row.eventId), ['event-pending']);
    assert.equal(claimed?.opId, 'op-pending');
    assert.ok(lookupMs < 5_000, `pending lookups took ${lookupMs}ms`);
  }, 180_000);
});
