import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { transactionDone } from '../src/sync-state/idb.js';
import { SYNC_HISTORY_RETENTION_MS as TTL } from '../src/sync-state/history-retention.js';
import { isDamagedRowError, retentionBatch } from '../src/sync-state/history-retention-io.js';
import { STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { ack as pullAck, emptyPullPage, json, scope as engineScope, setup } from './durable-sync-engine-harness.js';

/**
 * W2A-12: one saved row the code cannot interpret (a field missing) made the compaction and the history pruning
 * throw at that row on every pass, so nothing around it was ever reclaimed (the pass rolls back as a whole). A
 * damaged row is now stepped over: it stays where it is, is counted, and everything else goes on.
 */
const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const key = scopeKey(scope);
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const queue = (sequence: number) => ({ scopeKey: key, sequence, opId: `op-${sequence}`, batchId: `batch-${sequence}`,
  idempotencyKey: `idem-${sequence}`, digest: `sha256:op-${sequence}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
  baseRevision: 'rev-0', operationRevision: `local-${sequence}`, status: 'terminal', retry: { attempt: 0, notBefore: 0 }, echoApplied: true,
  payload: { type: 'update_node_content', targetId: `node-${sequence}` } });
const event = (ordinal: number) => ({ scopeKey: key, eventId: `event-${ordinal}`, ordinal, dedupeKey: `dedupe-${ordinal}`,
  occurredAt: '2026-10-23T00:00:00Z', kind: 'change', nativeId: `native-${ordinal}`, status: 'processed', opId: `op-${ordinal}`,
  details: { title: 'old' } });
const ack = (cursor: string) => {
  const body = JSON.stringify({ sessionId: 'session', cursor });
  return { scopeKey: key, intentId: 'ack-current', kind: 'pull', cursor, sessionId: 'session', idempotencyKey: 'ack-current',
    endpointIdentity: 'syncAck', mediaType: 'application/json', body, bodyDigest: createHash('sha256').update(body).digest('hex'),
    state: 'complete', result: { ackedCursor: cursor } };
};

/** Three settled changes with their receipts and events; the second change's saved row and the first change's event are damaged. */
async function withDamagedRows() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); stores.push(store);
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 9e12 },
    checkpoint: { cursor: 'current', serverRevision: 'rev' }, selectedRoots: [], firstRun: 'completed' });
  const tx = (await store.open()).transaction([STORES.queue, STORES.receipts, STORES.bookmarkEvents, STORES.cursors,
    STORES.compactionWatermarks, STORES.sequences, STORES.ackIntents], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORES.sequences).put({ scopeKey: key, next: 4 });
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    const { payload: _payload, ...withoutPayload } = queue(sequence);
    tx.objectStore(STORES.queue).put(sequence === 2 ? withoutPayload : queue(sequence));
    tx.objectStore(STORES.receipts).put({ scopeKey: key, receiptId: `receipt-${sequence}`, sequence, opId: `op-${sequence}`,
      operationDigest: `sha256:op-${sequence}`, kind: 'terminal', resultDigest: 'sha256:result', result: {} });
    const { details: _details, ...withoutDetails } = event(sequence);
    tx.objectStore(STORES.bookmarkEvents).put(sequence === 1 ? withoutDetails : event(sequence));
  }
  tx.objectStore(STORES.cursors).put({ scopeKey: key, cursor: 'current', checkpoint: 'rev',
    evidence: { snapshotId: 'snapshot', pageDigest: 'sha256:page' } });
  tx.objectStore(STORES.ackIntents).put(ack('current'));
  tx.objectStore(STORES.compactionWatermarks).put({ scopeKey: key, queueThroughSequence: 0, eventThroughOrdinal: 0, compactedAt: 0,
    remainingEligible: false, latestCompleteAck: { pull: 'ack-current' } });
  await done;
  return store;
}

async function keysOf(store: ReturnType<typeof createSyncStateStore>, name: string) {
  const tx = (await store.open()).transaction(name, 'readonly'); const done = transactionDone(tx);
  const request = tx.objectStore(name).getAllKeys();
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await done;
  return keys.map(row => (row as unknown[])[1]);
}

test('damaged rows are stepped over and counted; the changes settled around them are still reclaimed', async () => {
  const store = await withDamagedRows();
  const first = await store.compactScope(scope, { now: 1_000 });
  assert.equal(first.damagedRows, 2, 'the walk stopped at the damaged saved change and at the damaged event');
  assert.equal(first.pruned?.damaged, 3, 'the pruning passed over the damaged event and the damaged saved change');
  const second = await store.compactScope(scope, { now: TTL + 1_000 });
  assert.equal(second.pruned?.queue, 1);
  assert.equal(second.pruned?.events, 1);
  assert.deepEqual(await keysOf(store, STORES.queue), [1, 2], 'change 3 is gone with its receipt; the damaged change stays');
  assert.deepEqual(await keysOf(store, STORES.bookmarkEvents), ['event-1', 'event-2']);
  assert.deepEqual(await keysOf(store, STORES.receipts), ['receipt-1', 'receipt-2']);
});

test('only a row the code cannot interpret is stepped over; a storage failure still ends the pass', async () => {
  const factory = new IDBFactory();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('retention-batch', 1);
    request.onupgradeneeded = () => { const rows = request.result.createObjectStore('rows', { keyPath: 'id' }); for (const id of [1, 2, 3]) rows.put({ id }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const visited: number[] = []; const damaged = { count: 0 };
  const rows = () => database.transaction('rows', 'readonly').objectStore('rows');
  const readMissingField = (row: object) => (row as { missing: { field: string } }).missing.field;
  await retentionBatch<{ id: number }>(rows(), IDBKeyRange.lowerBound(0), 10, async row => {
    visited.push(row.id);
    if (row.id === 1) readMissingField(row);
    if (row.id === 2) throw new RangeError('out of range');
  }, damaged);
  assert.deepEqual([visited, damaged.count], [[1, 2, 3], 2]);

  await assert.rejects(retentionBatch<{ id: number }>(rows(), IDBKeyRange.lowerBound(0), 10, async () => {
    throw new DOMException('the disk is full', 'QuotaExceededError');
  }, damaged), /the disk is full/);
  assert.equal(damaged.count, 2, 'a storage failure is not counted as a damaged row');
  assert.equal(isDamagedRowError(new DOMException('bad key', 'DataError')), true);
  assert.equal(isDamagedRowError(new DOMException('aborted', 'AbortError')), false);
  database.close();
});

test('the engine leaves a diagnostic when an idle compaction stepped over a damaged row, and the wake carries on', async () => {
  const report = { watermark: { scopeKey: key, queueThroughSequence: 0, eventThroughOrdinal: 0, compactedAt: 0, remainingEligible: false },
    compactedQueue: 0, compactedEvents: 0, summaries: [], damagedRows: 1 };
  const fixture = await setup({ compactScope: async () => report });
  try {
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, pullAck('cursor-1')));
    await fixture.engine.wake('manual');
    assert.equal((await fixture.store.getEngineState(engineScope))?.phase, 'sleeping');
    const records = (await fixture.store.exportDiagnostics()).records as Array<Record<string, unknown>>;
    assert.ok(records.some(row => row.kind === 'idle_compaction' && row.code === 'compaction_rows_damaged'));
    assert.ok(!records.some(row => row.code === 'compaction_failed'));
  } finally { fixture.store.close(); }
});
