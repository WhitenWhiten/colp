import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { pendingLocalMoveForEvent } from '../src/pull-local-placement.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { durableEventDetails } from '../src/bookmark-event-codec.js';
import { validateBookmarkEventRecord } from '../src/sync-state/bookmark-event-validation.js';
import { DEFAULT_MAX_RECORD_BYTES } from '../src/sync-state/codec.js';
import { runTransaction } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';
import { installOutboundPushIndexedDb, scope, setupMove } from './outbound-push-worker-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
installOutboundPushIndexedDb();

const target = { nativeId: 'native-bookmark', colpId: 'node-bookmark' };
const destination = { nativeId: 'native-dest', colpId: 'folder-dest' };
const source = { nativeId: 'native-source', colpId: 'folder-source' };
function event() {
  const value = pullFixtures.mutationEvent({ kind: 'move', sequence: 51, collectionId: scope.collectionId,
    targetId: target.colpId, parentId: source.colpId });
  if (value.kind !== 'operation' || value.operation.type !== 'move_node' || value.effect.kind !== 'node_moved') {
    throw new Error('fixture_move_event');
  }
  return { cursor: value.cursor, kind: 'operation' as const, operation: value.operation, effect: value.effect };
}
function replaceOperation(value: ReturnType<typeof event>, operation: ReturnType<typeof event>['operation']) {
  const effect = { ...value.effect, effectId: operation.opId, opId: operation.opId, replicaId: operation.replicaId,
    sequence: operation.sequence, operationDigest: canonicalOperationDigest(operation) };
  return { ...value, operation, effect: { ...effect, effectDigest: canonicalAuthoritativeEffectDigest(effect) } };
}

test('pending and genuinely unknown moves retain only their destination without changing attempts or receipts', async () => {
  const f = await setupMove();
  try {
    const remote = event();
    assert.equal(await pendingLocalMoveForEvent(f.store, scope, target, destination, remote), true);
    assert.equal(await pendingLocalMoveForEvent(f.store, scope, target, source, remote), false);
    const worker = createOutboundPushWorker({ ...f.options, fetch: async () => { throw new TypeError('Failed to fetch'); } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const before = await f.store.getQueueByOpId(scope, f.queued.opId);
    assert.ok(before?.attempt);
    assert.equal(await pendingLocalMoveForEvent(f.store, scope, target, destination, remote), true);
    const own = replaceOperation(remote, { ...remote.operation, opId: f.queued.opId, replicaId: scope.replicaId });
    assert.equal(await pendingLocalMoveForEvent(f.store, scope, target, destination, own), false);
    const resolved = replaceOperation(remote, { ...remote.operation, dependencies: [f.queued.opId],
      source: { adapterProfile: 'known-conflict-resolution' } });
    assert.equal(await pendingLocalMoveForEvent(f.store, scope, target, destination, resolved), false);
    assert.deepEqual(await f.store.getQueueByOpId(scope, f.queued.opId), before);
    assert.equal(await f.store.getQueueReceipt(scope, f.queued.sequence), null);
  } finally { f.store.close(); }
});

test('the newest captured destination takes precedence over an older pending queue destination', async () => {
  const f = await setupMove();
  try {
    await captureMove(f, destination.nativeId, source.nativeId, 'newer-return');
    const before = await f.store.listBookmarkEventsByNative(scope, target.nativeId);
    assert.equal(await pendingLocalMoveForEvent(f.store, scope, target, destination, event()), false);
    assert.equal(await pendingLocalMoveForEvent(f.store, scope, target, source, event()), true);
    await captureMove(f, source.nativeId, destination.nativeId, 'newest-away');
    assert.equal(await pendingLocalMoveForEvent(f.store, scope, target, destination, event()), true);
    assert.equal(await pendingLocalMoveForEvent(f.store, scope, target, source, event()), false);
    const after = await f.store.listBookmarkEventsByNative(scope, target.nativeId);
    assert.deepEqual(after[0], before[0]);
    assert.equal(after.length, 2);
    assert.equal((await f.store.getQueueByOpId(scope, f.queued.opId))?.status, 'pending');
  } finally { f.store.close(); }
});

test('a captured move after 1000 valid content drafts is read through the complete native history', async () => {
  const f = await setupMove();
  try {
    const first = await f.store.stageBookmarkEvent(scope, { eventId: 'content-1', dedupeKey: 'content-1',
      occurredAt: '2026-10-20T00:00:00Z', kind: 'change', nativeId: target.nativeId,
      details: durableEventDetails({ operation: { type: 'update_node_content', targetId: target.colpId,
        baseRevision: 'node-r1', payload: { base: { title: 'Moved' }, value: { title: 'Local' } } } }) });
    // These are validated pending drafts, not receipts or processed/acknowledged
    // operations. The subject move below still enters through the actual store.
    await runTransaction(await f.store.open(), [STORES.bookmarkEvents, STORES.metadata], 'readwrite', async tx => {
      for (let ordinal = 2; ordinal <= 1000; ordinal++) {
        tx.objectStore(STORES.bookmarkEvents).add(validateBookmarkEventRecord({ ...first.event, ordinal,
          eventId: `content-${ordinal}`, dedupeKey: `content-${ordinal}` }, DEFAULT_MAX_RECORD_BYTES));
      }
      tx.objectStore(STORES.metadata).put({ key: `bookmark-event-ordinal:${first.event.scopeKey}`, next: 1001 });
    });
    const last = await captureMove(f, destination.nativeId, source.nativeId, 'last-move');
    assert.equal(last.event.ordinal, 1001);
    const pages: number[] = [];
    const reads = { ...f.store, listBookmarkEventsByNative: async (...args: Parameters<typeof f.store.listBookmarkEventsByNative>) => {
      pages.push(args[2] ?? 0); return f.store.listBookmarkEventsByNative(...args);
    } };
    assert.equal(await pendingLocalMoveForEvent(reads, scope, target, source, event()), true);
    assert.deepEqual(pages, [0, 1000]);
    assert.equal(await f.store.getQueueReceipt(scope, f.queued.sequence), null);
  } finally { f.store.close(); }
});

function captureMove(f: Awaited<ReturnType<typeof setupMove>>, from: string, to: string, id: string) {
  return f.store.stageBookmarkEvent(scope, { eventId: id, dedupeKey: id,
    occurredAt: '2026-10-20T00:00:00Z', kind: 'move', nativeId: target.nativeId,
    details: durableEventDetails({ operation: { type: 'move_node', targetId: target.colpId,
      baseRevision: 'node-r1', payload: {} }, context: { sourceParentNativeId: from, targetParentNativeId: to },
    mapping: { ...target, rootNativeId: 'root-native', parentNativeId: to } }) });
}
