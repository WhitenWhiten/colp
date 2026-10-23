import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { transactionDone } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';
import { SYNC_HISTORY_RETENTION_MS as TTL } from '../src/sync-state/history-retention.js';
import { scopeKey } from '../src/sync-state/scope-key.js';

const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test('retains a full grace period, then reclaims queue, receipts, events, Ack history and deletion journals', async () => {
  const store = await seeded(3);
  await store.compactScope(scope, { now: 1_000 });
  await store.compactScope(scope, { now: TTL });
  assert.equal((await store.listQueue(scope)).length, 3);
  assert.equal((await store.listBookmarkEvents(scope)).length, 3);
  await store.compactScope(scope, { now: TTL + 1_000 });
  assert.equal((await store.listQueue(scope)).length, 0);
  assert.equal((await store.listBookmarkEvents(scope)).length, 0);
  assert.equal(await store.getQueueReceipt(scope, 1), null);
  assert.deepEqual((await store.listAckIntents(scope)).map(row => row.intentId).sort(), ['ack-bootstrap', 'ack-current']);
  // Local journal grace starts only after all terminal echoes have been reclaimed.
  await store.compactScope(scope, { now: 2 * TTL + 1_001 });
  assert.deepEqual(await store.listDeletionJournal(scope), []);
  assert.equal((await store.exportScope(scope)).compactSummaries.length, 0);
  await store.auditIntegrity();
});

test('retention and source deletions roll back together after a failed maintenance transaction', async () => {
  const store = await seeded(2);
  await store.compactScope(scope, { now: 10 });
  const before = await store.exportScope(scope);
  await assert.rejects(store.compactScope(scope, { now: TTL + 10, fault: 'after_retention' }), /fault_injected/);
  assert.deepEqual(await store.exportScope(scope), before);
  await store.compactScope(scope, { now: TTL + 10 });
  assert.equal((await store.listQueue(scope)).length, 0);
});

test('bounded resumable passes drain eligible rows past protected heads and survive store restart', async () => {
  const factory = new IDBFactory();
  let store = await seeded(7, factory);
  await change(store, [STORES.queue], tx => {
    tx.objectStore(STORES.queue).put(queue(1, 'terminal', false));
  });
  for (let pass = 0; pass < 8; pass += 1) await store.compactScope(scope, { batch: 2, now: 100 });
  store.close();
  store = createSyncStateStore({ indexedDB: factory }); stores.push(store);
  for (let pass = 0; pass < 12; pass += 1) {
    const report = await store.compactScope(scope, { batch: 2, now: TTL + 100 });
    for (const count of Object.values(report.pruned!)) assert.ok(count <= 2);
  }
  assert.deepEqual((await store.listQueue(scope)).map(row => row.sequence), [1]);
  assert.deepEqual((await store.listBookmarkEvents(scope)).map(row => row.opId), ['op-1']);
  assert.ok(await store.getQueueReceipt(scope, 1));
  assert.equal(await store.getQueueReceipt(scope, 7), null);
});

for (const blocker of ['queue', 'inbox', 'ack', 'recovery', 'pull', 'pull-event', 'native', 'freeze', 'bootstrap'] as const) {
  test(`preserves acknowledged history while ${blocker} recovery references remain live`, async () => {
    const store = await seeded(1);
    await store.compactScope(scope, { now: 100 });
    await change(store, Object.values(STORES), tx => {
      const key = scopeKeyValue!;
      if (blocker === 'queue') tx.objectStore(STORES.queue).put(queue(2, 'unknown'));
      if (blocker === 'inbox') tx.objectStore(STORES.bookmarkEvents).put(event(2, 'pending', null));
      if (blocker === 'ack') tx.objectStore(STORES.ackIntents).put(ack('ack-pending', 'pull', 'future', 'pending'));
      if (blocker === 'recovery') tx.objectStore(STORES.recovery).put({ scopeKey: key, snapshotId: 'snapshot' });
      if (blocker === 'pull') tx.objectStore(STORES.pullPages).put({ scopeKey: key, pageId: 'page', state: 'staged' });
      if (blocker === 'pull-event') tx.objectStore(STORES.pullEvents).put({ scopeKey: key, eventId: 'detached', state: 'awaiting_confirmation' });
      if (blocker === 'native') tx.objectStore(STORES.intents).put({ scopeKey: key, intentId: 'waiting',
        nativeResult: 'result_unknown' });
      if (blocker === 'freeze') tx.objectStore(STORES.engine).put({ scopeKey: key, recoveryFrozen: true });
      if (blocker === 'bootstrap') tx.objectStore(STORES.advancedPlans).put({ scopeKey: key, planId: 'plan', state: 'active' });
    });
    await store.compactScope(scope, { now: TTL + 100 });
    assert.ok(await store.getQueueByOpId(scope, 'op-1'));
    assert.ok(await store.getBookmarkEvent(scope, 'event-1'));
    assert.equal((await store.listDeletionJournal(scope)).length, 1);
  });
}

test('keeps the cursor receipt and referenced bootstrap Acks, and never collects pending exact Ack bytes', async () => {
  const store = await seeded(1);
  await change(store, [STORES.cursors, STORES.ackIntents, STORES.advancedPlans], tx => {
    tx.objectStore(STORES.cursors).put({ scopeKey: scopeKeyValue, cursor: 'current', checkpoint: 'rev',
      evidence: { receiptId: 'receipt-1', operationDigest: 'sha256:op-1' } });
    tx.objectStore(STORES.ackIntents).put(ack('ack-plan', 'bootstrap', 'plan-cursor'));
    tx.objectStore(STORES.advancedPlans).put({ scopeKey: scopeKeyValue, planId: 'old-plan', state: 'completed',
      metadata: { remoteCursor: 'plan-cursor' } });
  });
  await store.compactScope(scope, { now: 1 });
  await store.compactScope(scope, { now: TTL + 1 });
  assert.ok(await store.getQueueByOpId(scope, 'op-1'));
  assert.ok(await store.getQueueReceipt(scope, 1));
  assert.ok((await store.listAckIntents(scope)).some(row => row.intentId === 'ack-plan'));
});

test('legacy rejected receipt outcomes protect their queue and event even without a projected recovery field', async () => {
  const store = await seeded(1);
  await change(store, [STORES.receipts], tx => tx.objectStore(STORES.receipts).put({
    scopeKey: scopeKeyValue, receiptId: 'receipt-1', sequence: 1, opId: 'op-1', operationDigest: 'sha256:op-1',
    kind: 'terminal', resultDigest: 'sha256:result', result: { results: [{ opId: 'op-1', status: 'rejected', code: 'move_conflict' }] } }));
  await store.compactScope(scope, { now: 100 });
  await store.compactScope(scope, { now: TTL + 100 });
  assert.ok(await store.getQueueByOpId(scope, 'op-1'));
  assert.ok(await store.getBookmarkEvent(scope, 'event-1'));
  assert.ok(await store.getQueueReceipt(scope, 1));
});

test('orphan summaries are reclaimed and replay authority facts remain after source history is gone', async () => {
  const store = await seeded(0);
  await change(store, [STORES.compactSummaries, STORES.diagnostics], tx => {
    tx.objectStore(STORES.compactSummaries).put({ scopeKey: scopeKeyValue, kind: 'queue', id: 'missing', opId: 'missing' });
    tx.objectStore(STORES.compactSummaries).put({ scopeKey: scopeKeyValue, kind: 'retention',
      id: JSON.stringify(['ack', 'missing']), eligibleAt: 1 });
    tx.objectStore(STORES.diagnostics).put({ id: `pull-terminal:${scopeKeyValue}:applied`,
      scopeKey: scopeKeyValue, kind: 'pull_terminal_fact', operationId: 'applied', effectDigest: 'sha256:effect' });
  });
  await store.compactScope(scope, { now: 100 });
  assert.ok((await store.exportScope(scope)).compactSummaries.every(row => !String(row.id).includes('missing')));
  assert.deepEqual(await store.pullOperationsCovered(scope, ['applied']), ['applied']);
});

test('the actual Ack completion transaction preserves the latest proof independently of key ordering', async () => {
  const store = await seeded(0);
  for (const id of ['z-completed-first', 'a-completed-last']) {
    await change(store, [STORES.cursors], tx => tx.objectStore(STORES.cursors).put({
      scopeKey: scopeKeyValue, cursor: id, checkpoint: 'rev', evidence: { pullPageId: id, pageDigest: 'sha256:page' } }));
    const { scopeKey: _scopeKey, state: _state, result: _result, ...input } = ack(id, 'pull', id);
    await store.beginAckIntent(scope, input);
    await store.completeAckIntent(scope, id, { ackedCursor: id });
  }
  await store.compactScope(scope, { now: 100 });
  await store.compactScope(scope, { now: TTL + 100 });
  assert.deepEqual((await store.listAckIntents(scope)).map(row => row.intentId).sort(), ['a-completed-last', 'ack-bootstrap']);
  assert.equal((await store.exportScope(scope)).compactionWatermark?.latestCompleteAck?.pull, 'a-completed-last');
});

test('a clock rollback starts a fresh grace period and server-refused terminal operations retain their issue evidence', async () => {
  const store = await seeded(2);
  await store.compactScope(scope, { now: TTL });
  await change(store, [STORES.queue, STORES.receipts], tx => {
    tx.objectStore(STORES.queue).put({ ...queue(2), recovery: { code: 'move_conflict', resultStatus: 'rejected' } });
  });
  await store.compactScope(scope, { now: 1 });
  await store.compactScope(scope, { now: TTL });
  assert.ok(await store.getQueueByOpId(scope, 'op-1'));
  await store.compactScope(scope, { now: TTL + 1 });
  assert.equal(await store.getQueueByOpId(scope, 'op-1'), null);
  assert.ok(await store.getQueueByOpId(scope, 'op-2'));
  assert.ok(await store.getBookmarkEvent(scope, 'event-2'));
});

test('superseded rejections are reclaimed only behind a durably consumed server sequence', async () => {
  const store = await seeded(3);
  await change(store, [STORES.queue], tx => {
    tx.objectStore(STORES.queue).put({ ...queue(1, 'rejected'), recovery: { code: 'recaptured' } });
    tx.objectStore(STORES.queue).put({ ...queue(2, 'rejected'), recovery: { code: 'move_conflict' } });
    tx.objectStore(STORES.queue).put({ ...queue(4, 'rejected'), recovery: { code: 'target_already_deleted' } });
  });
  await store.compactScope(scope, { now: 100 });
  await store.compactScope(scope, { now: TTL + 100 });
  assert.deepEqual((await store.listQueue(scope)).map(row => row.sequence), [2, 4]);
  assert.deepEqual((await store.listBookmarkEvents(scope)).map(row => row.ordinal), [2]);
  assert.equal(await store.getQueueReceipt(scope, 1), null);
  assert.equal((await store.exportScope(scope)).compactionWatermark?.retention?.consumedThroughSequence, 3);
  await store.compactScope(scope, { now: 3 * TTL });
  assert.ok(await store.getQueueByOpId(scope, 'op-4'));
  assert.equal((await store.listDeletionJournal(scope)).length, 1);
});

const scopeKeyValue = scopeKey(scope);
async function seeded(count: number, factory = new IDBFactory()) {
  const store = createSyncStateStore({ indexedDB: factory }); stores.push(store);
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 9e12 },
    checkpoint: { cursor: 'current', serverRevision: 'rev' }, selectedRoots: [], firstRun: 'completed' });
  await change(store, [STORES.queue, STORES.receipts, STORES.bookmarkEvents, STORES.cursors,
    STORES.ackIntents, STORES.compactionWatermarks, STORES.deletionJournal, STORES.sequences], tx => {
    tx.objectStore(STORES.sequences).put({ scopeKey: scopeKeyValue, next: count + 1 });
    for (let sequence = 1; sequence <= count; sequence += 1) {
      tx.objectStore(STORES.queue).put(queue(sequence));
      tx.objectStore(STORES.receipts).put({ scopeKey: scopeKeyValue, receiptId: `receipt-${sequence}`,
        sequence, opId: `op-${sequence}`, operationDigest: `sha256:op-${sequence}`, kind: 'terminal',
        resultDigest: 'sha256:result', result: {} });
      tx.objectStore(STORES.bookmarkEvents).put(event(sequence));
    }
    tx.objectStore(STORES.cursors).put({ scopeKey: scopeKeyValue, cursor: 'current', checkpoint: 'rev',
      evidence: { snapshotId: 'snapshot', pageDigest: 'sha256:page' } });
    for (const row of [ack('ack-old', 'pull', 'old'), ack('ack-current', 'pull', 'current'),
      ack('ack-bootstrap', 'bootstrap', 'bootstrap')]) tx.objectStore(STORES.ackIntents).put(row);
    tx.objectStore(STORES.compactionWatermarks).put({ scopeKey: scopeKeyValue, queueThroughSequence: 0,
      eventThroughOrdinal: 0, compactedAt: 0, remainingEligible: false,
      latestCompleteAck: { pull: 'ack-current', bootstrap: 'ack-bootstrap' } });
    tx.objectStore(STORES.deletionJournal).put({ scopeKey: scopeKeyValue, nativeId: 'deleted', ordinal: 1, kind: 'bookmark' });
  });
  return store;
}

async function change(store: ReturnType<typeof createSyncStateStore>, names: readonly string[],
  write: (tx: IDBTransaction) => void) {
  const tx = (await store.open()).transaction([...names], 'readwrite'); const done = transactionDone(tx);
  write(tx); await done;
}
function queue(sequence: number, status = 'terminal', echoApplied = true) {
  return { scopeKey: scopeKeyValue, sequence, opId: `op-${sequence}`, batchId: `batch-${sequence}`,
    idempotencyKey: `idem-${sequence}`, digest: `sha256:op-${sequence}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'rev-0', operationRevision: `local-${sequence}`, status, retry: { attempt: 0, notBefore: 0 },
    ...(echoApplied ? { echoApplied: true } : {}), payload: { type: 'update_node_content', targetId: `node-${sequence}` } };
}
function event(ordinal: number, status = 'processed', opId: string | null = `op-${ordinal}`) {
  return { scopeKey: scopeKeyValue, eventId: `event-${ordinal}`, ordinal, dedupeKey: `dedupe-${ordinal}`,
    occurredAt: '2026-10-23T00:00:00Z', kind: 'change', nativeId: `native-${ordinal}`, status, opId, details: { title: 'old' } };
}
function ack(intentId: string, kind: 'pull' | 'bootstrap', cursor: string, state: 'pending' | 'complete' = 'complete') {
  const body = JSON.stringify({ sessionId: 'session', cursor });
  return { scopeKey: scopeKeyValue, intentId, kind, cursor, sessionId: 'session', idempotencyKey: intentId,
    endpointIdentity: 'syncAck' as const, mediaType: 'application/json' as const, body,
    bodyDigest: createHash('sha256').update(body).digest('hex'), state,
    ...(state === 'complete' ? { result: { ackedCursor: cursor } } : {}) };
}
