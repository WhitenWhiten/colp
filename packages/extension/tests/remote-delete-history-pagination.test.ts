import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { digestJson, validateOperation } from '../src/bookmark-event-codec.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createPullApplier } from '../src/pull-applier.js';
import { keepLocalFromDecision, pullEventFromDecision } from '../src/remote-delete-apply.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { validateBookmarkEventRecord } from '../src/sync-state/bookmark-event-validation.js';
import { DEFAULT_MAX_RECORD_BYTES } from '../src/sync-state/codec.js';
import { requestValue, runTransaction, transactionDone } from '../src/sync-state/idb.js';
import { validateQueueRecord, validateReceipt } from '../src/sync-state/queue-validate.js';
import { STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { indexedDB, installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();
const HISTORY_COUNT = 1_000;
type Store = ReturnType<typeof createSyncStateStore>;

async function authoredHistory(store: Store) {
  const db = await store.open();
  const tx = db.transaction([STORES.queue, STORES.receipts, STORES.bookmarkEvents, STORES.sequences], 'readonly');
  const done = transactionDone(tx);
  const rows = await Promise.all([STORES.queue, STORES.receipts, STORES.bookmarkEvents, STORES.sequences]
    .map(name => requestValue(tx.objectStore(name).getAll())));
  await done;
  return rows;
}

/** Bulk-load settled history from a real captured move; only the new move is the test subject. */
async function fillProcessedHistory(store: Store) {
  const [firstEvent] = await store.listBookmarkEventsByNative(scope, 'native-child');
  const [firstQueue] = await store.listQueue(scope);
  assert.equal(firstEvent?.status, 'processed');
  assert.equal(firstQueue?.payload.type, 'move_node');
  assert.ok(firstEvent && firstQueue);
  const key = scopeKey(scope);
  const rows = Array.from({ length: HISTORY_COUNT }, (_, index) => {
    const sequence = index + 1;
    const opId = `history-move-${sequence}`;
    const occurredAt = new Date(Date.UTC(2026, 9, 1) + sequence * 1_000).toISOString();
    const payload = { ...firstQueue.payload, opId, sequence, occurredAt };
    assert.equal(validateOperation(payload), true);
    const queue = validateQueueRecord({ ...firstQueue, sequence, opId, batchId: opId, idempotencyKey: opId,
      digest: digestJson(payload), status: 'terminal', payload }, DEFAULT_MAX_RECORD_BYTES);
    const event = validateBookmarkEventRecord({ ...firstEvent, eventId: `history-event-${sequence}`,
      dedupeKey: `history-dedupe-${sequence}`, ordinal: sequence, opId, occurredAt }, DEFAULT_MAX_RECORD_BYTES);
    const result = { results: [{ opId, sequence, status: 'applied', targetId: 'node-child', revision: `history-${sequence}` }] };
    const receipt = validateReceipt(key, sequence, { opId, operationDigest: queue.digest, kind: 'terminal',
      receiptId: `history-receipt-${sequence}`, resultDigest: digestJson(result), result }, DEFAULT_MAX_RECORD_BYTES);
    return { event, queue, receipt };
  });
  await runTransaction(await store.open(), [STORES.bookmarkEvents, STORES.queue, STORES.receipts,
    STORES.metadata, STORES.sequences], 'readwrite', async tx => {
    tx.objectStore(STORES.bookmarkEvents).delete([key, firstEvent.eventId]);
    for (const row of rows) {
      tx.objectStore(STORES.bookmarkEvents).add(row.event);
      tx.objectStore(STORES.queue).put(row.queue);
      tx.objectStore(STORES.receipts).add(row.receipt);
    }
    tx.objectStore(STORES.metadata).put({ key: `bookmark-event-ordinal:${key}`, next: HISTORY_COUNT + 1 });
    tx.objectStore(STORES.sequences).put({ scopeKey: key, next: HISTORY_COUNT + 1 });
  });
}

test('the 1001st captured move survives remote deletion, Keep local and an IndexedDB reopen', async () => {
  const f = await setup();
  let reopened: Store | undefined;
  try {
    await f.store.putMapping(scope, { nativeId: 'native-node', colpId: 'node-1', rootNativeId: 'native-root',
      parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder',
      projection: { revision: 'revision-old', childrenRevision: 'children-folder', digest: 'folder', content: { title: 'Folder' } } });
    f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'Folder' });
    const api = {
      get: async (id: string) => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
      getChildren: async (id: string) => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })),
    };
    await f.api.move('native-child', { parentId: 'native-node', index: 0 });
    const first = await createBookmarkEventQueue({ scope, store: f.store, api }).moved('native-child', f.api.lastEvent!.details);
    assert.equal(first.outcome, 'staged');
    await fillProcessedHistory(f.store);
    const mapping = await f.store.getMappingByNativeId(scope, 'native-child');
    assert.ok(mapping);
    const { scopeKey: _scopeKey, ...mappedChild } = mapping;
    await f.store.putMapping(scope, { ...mappedChild, projection: { ...mapping.projection, revision: 'history-1000' } });

    // The new event is captured by production ingress, with no flush or synthetic acknowledgement.
    await f.api.move('native-child', { parentId: 'native-root', index: 1 });
    const captured = await createBookmarkEventQueue({ scope, store: f.store, api, autoFlush: false })
      .moved('native-child', f.api.lastEvent!.details);
    assert.equal(captured.outcome, 'staged');
    assert.ok(captured.eventId);
    const pending = await f.store.getBookmarkEvent(scope, captured.eventId);
    assert.equal(pending?.ordinal, HISTORY_COUNT + 1);
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.kind, 'move');
    assert.equal(pending?.opId, null);
    const firstPage = await f.store.listBookmarkEventsByNative(scope, 'native-child', 0, HISTORY_COUNT);
    assert.equal(firstPage.length, HISTORY_COUNT);
    assert.ok(firstPage.every(row => row.status === 'processed'));
    assert.deepEqual(await f.store.listBookmarkEventsByNative(scope, 'native-child', HISTORY_COUNT), [pending]);
    const before = await authoredHistory(f.store);

    const remoteDelete = pullFixtures.subtreeEvent({ sequence: 2, collectionId: scope.collectionId,
      targetId: 'node-1', members: ['node-1', 'node-child'], paged: false });
    await createPullApplier(f.options).stage(f.page([remoteDelete]));
    await createPullApplier(f.options).resume();
    const [decision] = await f.store.listRemoteDeleteDecisions(scope, ['pending']);
    assert.ok(decision, 'the pending move beyond the first inbox page must require a user decision');
    assert.equal(decision.policy, 'confirm');
    assert.deepEqual(decision.nativeIds, ['native-node', 'native-child']);
    assert.equal(f.api.getNode('native-child')?.parentId, 'native-root');
    assert.ok(!f.api.calls.some(call => call.kind === 'delete'), 'no browser deletion before confirmation');

    f.store.close();
    reopened = createSyncStateStore({ indexedDB });
    await createPullApplier({ ...f.options, store: reopened }).resume();
    assert.equal((await reopened.getRemoteDeleteDecision(scope, decision.decisionId))?.state, 'pending');
    assert.deepEqual(await reopened.getBookmarkEvent(scope, captured.eventId), pending);
    await reopened.decideRemoteDelete(scope, { decisionId: decision.decisionId, action: 'keep_local',
      expectedCasVersion: decision.casVersion, deleteRevision: decision.deleteRevision,
      generation: scope.generation, now: Date.now(), permissionGranted: true });
    const event = await reopened.getPullEvent(scope, decision.eventId);
    assert.ok(event);
    await keepLocalFromDecision(reopened, scope, pullEventFromDecision({ payload: event.payload }), decision, Date.now);
    await createPullApplier({ ...f.options, store: reopened }).resume();
    reopened.close();
    reopened = createSyncStateStore({ indexedDB });
    assert.equal(f.api.getNode('native-child')?.parentId, 'native-root');
    assert.equal((await reopened.getLocalSyncExclusion(scope, 'native-child'))?.priorColpId, 'node-child');
    assert.equal((await reopened.getRemoteDeleteDecision(scope, decision.decisionId))?.state, 'keep_local');
    assert.equal(await reopened.getMappingByNativeId(scope, 'native-child'), null);
    assert.equal((await reopened.getCursor(scope))?.cursor, 'cursor-next');
    assert.deepEqual(await authoredHistory(reopened), before, 'Keep local preserves every inbox, queue, digest, receipt and sequence');
    assert.equal(await reopened.getQueueReceipt(scope, HISTORY_COUNT + 1), null, 'the captured move was never acknowledged');
    assert.ok(!f.api.calls.some(call => call.kind === 'delete'));
  } finally { reopened?.close(); f.store.close(); }
}, 60_000);
