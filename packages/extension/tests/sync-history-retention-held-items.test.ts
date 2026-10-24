import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { transactionDone } from '../src/sync-state/idb.js';
import { SYNC_HISTORY_RETENTION_MS as TTL } from '../src/sync-state/history-retention.js';
import { STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';

/**
 * W2A-04: one change set aside for a decision (a stuck item, a damaged saved change) pinned the reclamation of
 * every settled queue row, receipt and event of the scope for as long as it was held, so history grew without
 * bound (and the cost of releasing the item with it). A held item no longer pins the rest; it still pins the
 * deletion journal, which guards against a stale create resurrecting a removed bookmark.
 */
const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const key = scopeKey(scope);
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const queue = (sequence: number, status = 'terminal', echoApplied = true) => ({ scopeKey: key, sequence, opId: `op-${sequence}`,
  batchId: `batch-${sequence}`, idempotencyKey: `idem-${sequence}`, digest: `sha256:op-${sequence}`, endpointIdentity: 'syncPush',
  mediaType: 'application/json', baseRevision: 'rev-0', operationRevision: `local-${sequence}`, status,
  retry: { attempt: 0, notBefore: 0 }, ...(echoApplied ? { echoApplied: true } : {}),
  payload: { type: 'update_node_content', targetId: `node-${sequence}` } });
const event = (ordinal: number, opId: string) => ({ scopeKey: key, eventId: `event-${ordinal}`, ordinal, dedupeKey: `dedupe-${ordinal}`,
  occurredAt: '2026-10-23T00:00:00Z', kind: 'change', nativeId: `native-${ordinal}`, status: 'processed', opId, details: { title: 'old' } });

const ack = (intentId: string, cursor: string) => {
  const body = JSON.stringify({ sessionId: 'session', cursor });
  return { scopeKey: key, intentId, kind: 'pull', cursor, sessionId: 'session', idempotencyKey: intentId, endpointIdentity: 'syncAck',
    mediaType: 'application/json', body, bodyDigest: createHash('sha256').update(body).digest('hex'), state: 'complete',
    result: { ackedCursor: cursor } };
};

async function change(store: ReturnType<typeof createSyncStateStore>, names: readonly string[], write: (tx: IDBTransaction) => void) {
  const tx = (await store.open()).transaction([...names], 'readwrite'); const done = transactionDone(tx);
  write(tx); await done;
}

/** Three settled changes (sequences 1-3) and one held item (sequence 4, status set_aside). */
async function withHeldItem() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); stores.push(store);
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 9e12 },
    checkpoint: { cursor: 'current', serverRevision: 'rev' }, selectedRoots: [], firstRun: 'completed' });
  await change(store, [STORES.queue, STORES.receipts, STORES.bookmarkEvents, STORES.cursors, STORES.compactionWatermarks,
    STORES.deletionJournal, STORES.sequences, STORES.ackIntents], tx => {
    tx.objectStore(STORES.sequences).put({ scopeKey: key, next: 5 });
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      tx.objectStore(STORES.queue).put(queue(sequence));
      tx.objectStore(STORES.receipts).put({ scopeKey: key, receiptId: `receipt-${sequence}`, sequence, opId: `op-${sequence}`,
        operationDigest: `sha256:op-${sequence}`, kind: 'terminal', resultDigest: 'sha256:result', result: {} });
      tx.objectStore(STORES.bookmarkEvents).put(event(sequence, `op-${sequence}`));
    }
    tx.objectStore(STORES.queue).put({ ...queue(4, 'set_aside', false), recovery: { code: 'push_request_refused' } });
    tx.objectStore(STORES.bookmarkEvents).put(event(4, 'op-4'));
    tx.objectStore(STORES.cursors).put({ scopeKey: key, cursor: 'current', checkpoint: 'rev',
      evidence: { snapshotId: 'snapshot', pageDigest: 'sha256:page' } });
    tx.objectStore(STORES.ackIntents).put(ack('ack-current', 'current'));
    tx.objectStore(STORES.compactionWatermarks).put({ scopeKey: key, queueThroughSequence: 0, eventThroughOrdinal: 0, compactedAt: 0,
      remainingEligible: false, latestCompleteAck: { pull: 'ack-current' } });
    tx.objectStore(STORES.deletionJournal).put({ scopeKey: key, nativeId: 'deleted', ordinal: 1, kind: 'bookmark' });
  });
  return store;
}

test('a held item does not pin the history of the changes settled around it', async () => {
  const store = await withHeldItem();
  await store.compactScope(scope, { now: 1_000 });
  await store.compactScope(scope, { now: TTL + 1_000 });
  assert.deepEqual((await store.listQueue(scope)).map(row => [row.sequence, row.status]), [[4, 'set_aside']],
    'the settled rows and receipts are reclaimed, the held item stays');
  assert.deepEqual((await store.listBookmarkEvents(scope)).map(row => row.ordinal), [4]);
  assert.equal(await store.getQueueReceipt(scope, 1), null);
});

test('it still holds the deletion journal until the item is resolved, then the journal goes after its own grace', async () => {
  const store = await withHeldItem();
  await store.compactScope(scope, { now: 1_000 });
  await store.compactScope(scope, { now: TTL + 1_000 });
  await store.compactScope(scope, { now: 3 * TTL });
  assert.equal((await store.listDeletionJournal(scope)).length, 1, 'a stale create could resurrect the removed bookmark');

  await change(store, [STORES.queue, STORES.bookmarkEvents], tx => {
    tx.objectStore(STORES.queue).delete([key, 4]); tx.objectStore(STORES.bookmarkEvents).delete([key, 'event-4']);
  });
  await store.compactScope(scope, { now: 3 * TTL + 1_000 });
  await store.compactScope(scope, { now: 5 * TTL });
  assert.deepEqual(await store.listDeletionJournal(scope), []);
});

test('live work that is not a held item still pins everything, as before', async () => {
  const store = await withHeldItem();
  await change(store, [STORES.queue], tx => { tx.objectStore(STORES.queue).put(queue(5, 'unknown', false)); });
  await store.compactScope(scope, { now: 1_000 });
  await store.compactScope(scope, { now: TTL + 1_000 });
  assert.deepEqual((await store.listQueue(scope)).map(row => row.sequence), [1, 2, 3, 4, 5]);
});
