import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { markQueuePullEchoApplied } from '../src/sync-state/pull-queue-echo.js';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';

/**
 * Rule C neighbours of the claim: the other places that walk the queue (batch claim, gap realign,
 * Pull echo) must not turn one unreadable row into an error that stops the lane or the page.
 */
const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const digestOperation = (operation: JsonObject) => `sha256:test-${String(operation.opId)}-${String(operation.sequence)}`;
let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

function payload(opId: string, sequence: number): JsonObject {
  return { opId, replicaId: scope.replicaId, sequence, collectionId: scope.collectionId,
    type: 'update_node_content', targetId: `node-${sequence}`, baseRevision: 'revision-0',
    occurredAt: '2026-08-27T00:00:00Z', dependencies: [], payload: {} };
}
function row(sequence: number, status: string, extra: { recovery?: JsonObject; attempt?: number } = {}) {
  return { sequence, opId: `op-${sequence}`, batchId: `batch-${sequence}`, idempotencyKey: `idempotency-${sequence}`,
    digest: `sha256:op-${sequence}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-0', operationRevision: `local-${sequence}`, status,
    retry: { attempt: extra.attempt ?? 0, notBefore: 0 },
    ...(extra.recovery ? { recovery: extra.recovery } : {}), payload: payload(`op-${sequence}`, sequence) };
}
async function seed(rows: Array<Record<string, unknown> & { sequence: number; status: string; digest: string; opId: string }>) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [] });
  const key = (await store.getScope(scope))!.scopeKey; const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['outbound_queue', 'receipts', 'durable_sequences'], 'readwrite');
    for (const item of rows) tx.objectStore('outbound_queue').add({ ...item, scopeKey: key });
    for (const item of rows) if (item.status === 'terminal') tx.objectStore('receipts').add({ scopeKey: key,
      sequence: item.sequence, opId: item.opId, operationDigest: item.digest, kind: 'terminal',
      receiptId: `receipt-${item.opId}`, resultDigest: `sha256:result-${item.opId}` });
    tx.objectStore('durable_sequences').put({ scopeKey: key, next: Math.max(...rows.map((item) => item.sequence), 0) + 1 });
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error as Error); tx.onabort = () => reject(tx.error as Error);
  });
  const lease = await store.acquireLease(scope, 'owner-1', 1_000, 60_000);
  return { store, key, lease: lease as { fence: number } };
}
async function corrupt(store: Awaited<ReturnType<typeof seed>>['store'], sequence: number, mutate: (value: Record<string, unknown>) => void) {
  const db = await store.open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('outbound_queue', 'readwrite'); const queue = tx.objectStore('outbound_queue');
    queue.openCursor().onsuccess = (event: Event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result; if (!cursor) return;
      const value = cursor.value as Record<string, unknown>;
      if (value.sequence === sequence) { mutate(value); cursor.update(value); }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
}

describe('Rule C a gap realign meets an unreadable row', () => {
  test('an unsent one is held and renumbered with the parked rows; the survivors realign', async () => {
    const { store, lease } = await seed([row(1, 'terminal'), row(2, 'rejected', { recovery: { code: 'payload_too_large' } }),
      row(3, 'gap', { recovery: { code: 'sequence_gap', expectedSequence: 2 }, attempt: 1 }), row(4, 'pending')]);
    await corrupt(store, 4, (value) => { value.endpointIdentity = 'weird'; });
    const result = await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation);
    assert.equal(result.realigned, true);
    assert.deepEqual((await store.listQueue(scope)).map((item) => [item.sequence, item.opId, item.status, item.recovery?.code]), [
      [1, 'op-1', 'terminal', undefined], [2, 'op-3', 'pending', undefined],
      [3, 'op-2', 'rejected', 'payload_too_large'], [4, 'op-4', 'set_aside', 'queue_row_unreadable']]);
    store.close();
  });

  test('one the server may own leaves the lane as it is, without an error', async () => {
    const { store, lease } = await seed([row(1, 'terminal'), row(2, 'rejected', { recovery: { code: 'payload_too_large' } }),
      row(3, 'gap', { recovery: { code: 'sequence_gap', expectedSequence: 2 }, attempt: 1 }),
      { ...row(4, 'unknown', { attempt: 1, recovery: { code: 'push_network_failed' } }), attempt: { sessionId: 'session-1',
        batchId: 'batch-4', idempotencyKey: 'idempotency-4', endpointIdentity: 'syncPush', mediaType: 'application/json',
        body: '{}', bodyDigest: 'sha256:op-4' } }]);
    await corrupt(store, 4, (value) => { value.endpointIdentity = 'weird'; });
    const result = await store.realignQueueAfterGap(scope, 'owner-1', lease.fence, 2_000, digestOperation);
    assert.equal(result.realigned, false);
    assert.deepEqual((await store.listQueue(scope)).map((item) => [item.sequence, item.status]),
      [[1, 'terminal'], [2, 'rejected'], [3, 'gap']]);
    store.close();
  });
});

describe('Rule C a batch claim meets an unreadable row', () => {
  test('the batch ends before it and the head stays claimed', async () => {
    const { store, lease } = await seed([row(1, 'pending'), row(2, 'pending'), row(3, 'pending')]);
    const head = (await store.claimNextQueue(scope, 'owner-1', lease.fence, 1_000))!;
    assert.equal(head.opId, 'op-1');
    await corrupt(store, 2, (value) => { value.retry = 'broken'; });
    const following = await store.claimFollowingQueue(scope, 'owner-1', lease.fence, 1_000, head.sequence, 10, () => true);
    assert.deepEqual(following, []);
    store.close();
  });
});

describe('Rule C a Pull echo for an unreadable row', () => {
  test('the page is not aborted and a readable row is still marked', async () => {
    const { store, key } = await seed([row(1, 'terminal'), row(2, 'terminal')]);
    await corrupt(store, 2, (value) => { value.endpointIdentity = 'weird'; });
    const db = await store.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('outbound_queue', 'readwrite');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      void (async () => {
        await markQueuePullEchoApplied(tx, key, 'op-2', 1_000_000);
        await markQueuePullEchoApplied(tx, key, 'op-1', 1_000_000);
      })().catch((error) => { tx.abort(); reject(error); });
    });
    assert.deepEqual((await store.listQueue(scope)).map((item) => [item.opId, item.echoApplied]), [['op-1', true]]);
    store.close();
  });
});
