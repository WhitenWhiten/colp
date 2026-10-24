import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { confirmBatch, resumeBatchPlans, undoBatch } from '../src/bookmark-batch-executor.js';
import { previewBatch, toCommitItems } from '../src/bookmark-batch-plan.js';
import { digestJson, validateOperation } from '../src/bookmark-event-codec.js';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';
import { createMemoryBookmarks, parkRemoteDeleteNative } from './bookmark-batch-memory.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-batch', serverOrigin: 'https://known.example',
  accountId: 'account-batch', browserProfileId: 'profile-batch', collectionId: 'collection-batch',
  replicaId: 'replica-batch', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('bookmark batch execute / undo', () => {
  for (const legacy of [false, true]) test(`a consumed delete rejection cannot produce a restore (legacy=${legacy})`, async () => {
    const { store, api } = await setup();
    try {
      const preview = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bm-1'] });
      const deleted = await confirmBatch({ store, scope, api, commandId: 'cmd-delete-rejected', kind: 'delete',
        nativeIds: ['bm-1'], previewDigest: preview.digest, secondConfirm: true });
      const item = deleted.items[0]!;
      const queued = await seedTerminalDelete(store, item.colpId!, item.mappingRevision ?? 'rev-1', {
        results: [{ opId: `del-${item.colpId}`, sequence: 1, status: 'rejected', code: 'resource_not_found' }],
      });
      if (legacy) {
        const row = (await store.listQueue(scope))[0]!;
        const tx = (await store.open()).transaction('outbound_queue', 'readwrite');
        tx.objectStore('outbound_queue').put({ ...row, recovery: undefined });
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
        store.close();
      }
      const undone = await undoBatch({ store, scope, api, planId: deleted.planId, commandId: 'cmd-delete-rejected' });
      assert.equal(undone.undone, 0); assert.equal(undone.failed, 1);
      assert.equal(undone.items[0]?.error, 'delete_rejected');
      assert.equal((await store.listQueue(scope)).some(row => row.payload.type === 'restore_node'), false);
      assert.equal((await store.getQueueByOpId(scope, queued.opId))?.status, 'terminal');
    } finally { store.close(); }
  });

  test('persists the plan before the first Chrome mutation and is idempotent on commandId', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({
      store, scope, api, kind: 'rename', nativeIds: ['bm-1', 'bm-2'],
      titles: { 'bm-1': 'Renamed', 'bm-2': 'Also' },
    });
    assert.equal(preview.items[0]?.colpId, 'node-1');
    const first = await confirmBatch({
      store, scope, api, commandId: 'cmd-rename', kind: 'rename', nativeIds: ['bm-1', 'bm-2'],
      previewDigest: preview.digest, titles: { 'bm-1': 'Renamed', 'bm-2': 'Also' },
    });
    assert.equal(api.node('bm-1')?.title, 'Renamed');
    assert.equal(first.reused, false);
    const replay = await confirmBatch({
      store, scope, api, commandId: 'cmd-rename', kind: 'rename', nativeIds: ['bm-1', 'bm-2'],
      previewDigest: preview.digest, titles: { 'bm-1': 'Renamed', 'bm-2': 'Also' },
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.planId, first.planId);
    assert.equal(api.mutations.filter((item) => item.startsWith('update:')).length, 2);
  });

  test('stale preview digest refuses Chrome writes', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({
      store, scope, api, kind: 'rename', nativeIds: ['bm-1'], titles: { 'bm-1': 'Renamed' },
    });
    await api.update('bm-1', { title: 'Changed' });
    api.mutations.length = 0;
    await assert.rejects(() => confirmBatch({
      store, scope, api, commandId: 'cmd-stale', kind: 'rename', nativeIds: ['bm-1'],
      previewDigest: preview.digest, titles: { 'bm-1': 'Renamed' },
    }), /stale_revision/);
    assert.equal(api.mutations.length, 0);
  });

  test('partial success continues siblings and resume uses the same plan', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({
      store, scope, api, kind: 'rename', nativeIds: ['bm-1', 'bm-2'],
      titles: { 'bm-1': 'A', 'bm-2': 'B' },
    });
    const original = api.update.bind(api);
    api.update = async (id, changes) => {
      if (id === 'bm-2') throw new Error('chrome_mutation_failed');
      return original(id, changes);
    };
    const view = await confirmBatch({
      store, scope, api, commandId: 'cmd-partial', kind: 'rename', nativeIds: ['bm-1', 'bm-2'],
      previewDigest: preview.digest, titles: { 'bm-1': 'A', 'bm-2': 'B' },
    });
    assert.equal(view.state, 'partial');
    assert.equal(view.applied, 1);
    assert.equal(view.failed, 1);
    assert.equal(api.node('bm-1')?.title, 'A');
    assert.equal(api.node('bm-2')?.title, 'Two');
    store.close();
    const reopened = createSyncStateStore({ indexedDB });
    const recorded = await reopened.readBatchPlan(scope, view.planId);
    assert.equal(recorded?.plan.planId, view.planId);
    assert.equal(recorded?.items.find((item) => item.nativeId === 'bm-1')?.colpId, 'node-1');
    assert.equal(recorded?.items.find((item) => item.nativeId === 'bm-1')?.state, 'applied');
    assert.equal(recorded?.items.find((item) => item.nativeId === 'bm-2')?.state, 'failed');
  });

  test('delete undo enqueues restore_node for the original COLP id and is idempotent', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bm-1'] });
    const deleted = await confirmBatch({
      store, scope, api, commandId: 'cmd-del', kind: 'delete', nativeIds: ['bm-1'],
      previewDigest: preview.digest, secondConfirm: true,
    });
    assert.equal(api.node('bm-1'), undefined);
    const item = deleted.items[0]!;
    assert.equal(item.colpId, 'node-1');
    await seedTerminalDelete(store, item.colpId!, item.mappingRevision ?? 'rev-1');
    const undone = await undoBatch({
      store, scope, api, planId: deleted.planId, commandId: 'cmd-del',
    });
    assert.equal(undone.undone, 1);
    const restore = (await store.listQueue(scope)).find((row) => row.payload.type === 'restore_node');
    assert.equal(restore?.payload.targetId, 'node-1');
    assert.equal(restore?.opId, item.reversalId);
    const replay = await undoBatch({
      store, scope, api, planId: deleted.planId, commandId: 'cmd-del',
    });
    assert.equal(replay.undone, 1);
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'restore_node').length, 1);
  });

  test('delete undo still finds the delete row behind more than one queue page', async () => {
    // The queue is never pruned, so any bounded listQueue page eventually
    // stops containing a target's rows. Undo used to read the oldest 1_000
    // rows, miss the delete, throw `delete_not_committed`, and have that code
    // swallowed by undoPlan — leaving the plan 'undoing' and the UI reporting
    // the plain "Deleted." success copy for a restore that never happened.
    const { store, api } = await setup();
    const preview = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bm-1'] });
    const deleted = await confirmBatch({
      store, scope, api, commandId: 'cmd-del-deep', kind: 'delete', nativeIds: ['bm-1'],
      previewDigest: preview.digest, secondConfirm: true,
    });
    const item = deleted.items[0]!;
    const scopeKey = (await store.getScope(scope))!.scopeKey;
    const db = await store.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('outbound_queue', 'readwrite');
      const queue = tx.objectStore('outbound_queue');
      // 1_100 unrelated terminal rows, all older than the delete row below.
      for (let sequence = 1; sequence <= 1_100; sequence += 1) {
        queue.add({ scopeKey, sequence, opId: `filler-${sequence}`, batchId: `filler-${sequence}`,
          idempotencyKey: `filler-${sequence}`, digest: `sha256:filler-${sequence}`, endpointIdentity: 'syncPush',
          mediaType: 'application/json', baseRevision: 'revision-0', operationRevision: `local-filler-${sequence}`,
          status: 'terminal', retry: { attempt: 0, notBefore: 0 },
          payload: { type: 'update_node', opId: `filler-${sequence}`, targetId: `other-${sequence}` } });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
      tx.onabort = () => reject(tx.error as Error);
    });
    await store.advanceSequenceFloor(scope, 1_101);
    await seedTerminalDelete(store, item.colpId!, item.mappingRevision ?? 'rev-1');
    const undone = await undoBatch({ store, scope, api, planId: deleted.planId, commandId: 'cmd-del-deep' });
    assert.equal(undone.undone, 1);
    assert.equal(undone.state, 'undone');
    assert.equal(undone.failed, 0);
    const restore = (await store.listQueueByTarget(scope, item.colpId!))
      .find((row) => row.payload.type === 'restore_node');
    assert.equal(restore?.payload.targetId, item.colpId);
  }, 60_000);

  test('delete undo finds the delete row behind more than one page for its own target', async () => {
    // The by-target lookup is only as good as its window. The index orders a
    // target's rows by `operationRevision`, so a narrow window is truncated
    // BEFORE the delete-type and status filters run: with more rows for one
    // target than the window, the delete row falls outside it and the undo
    // reports a failure for a restore it could have performed. 100 was such a
    // window.
    const { store, api } = await setup();
    const preview = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bm-1'] });
    const deleted = await confirmBatch({
      store, scope, api, commandId: 'cmd-del-busy', kind: 'delete', nativeIds: ['bm-1'],
      previewDigest: preview.digest, secondConfirm: true,
    });
    const item = deleted.items[0]!;
    const scopeKey = (await store.getScope(scope))!.scopeKey;
    const db = await store.open();
    // 1_100 rows that all address the SAME target, ordered before the delete
    // row: past the lookup's 1_000-row ceiling, which is the queue's own bound.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('outbound_queue', 'readwrite');
      const queue = tx.objectStore('outbound_queue');
      for (let sequence = 1; sequence <= 1_100; sequence += 1) {
        queue.add({ scopeKey, sequence, opId: `busy-${sequence}`, batchId: `busy-${sequence}`,
          idempotencyKey: `busy-${sequence}`, digest: `sha256:busy-${sequence}`, endpointIdentity: 'syncPush',
          mediaType: 'application/json', baseRevision: 'revision-0', operationRevision: `aaa-busy-${sequence}`,
          status: 'terminal', retry: { attempt: 0, notBefore: 0 },
          payload: { type: 'update_node', opId: `busy-${sequence}`, targetId: item.colpId } });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
      tx.onabort = () => reject(tx.error as Error);
    });
    await store.advanceSequenceFloor(scope, 1_101);
    await seedTerminalDelete(store, item.colpId!, item.mappingRevision ?? 'rev-1');
    const undone = await undoBatch({ store, scope, api, planId: deleted.planId, commandId: 'cmd-del-busy' });
    assert.equal(undone.failed, 0, 'a busy target must not lose its own delete row');
    assert.equal(undone.undone, 1);
    assert.equal(undone.state, 'undone');
  }, 60_000);

  test('a delete row the lookup cannot see settles the item as failed instead of silently pending', async () => {
    // Guard the other half of the fix: if the delete row genuinely cannot be
    // found, the item must end in 'failed' (visible in the UI) rather than
    // 'undoing' with the error swallowed.
    const { store, api } = await setup();
    const preview = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bm-1'] });
    const deleted = await confirmBatch({
      store, scope, api, commandId: 'cmd-del-missing', kind: 'delete', nativeIds: ['bm-1'],
      previewDigest: preview.digest, secondConfirm: true,
    });
    const undone = await undoBatch({ store, scope, api, planId: deleted.planId, commandId: 'cmd-del-missing' });
    assert.equal(undone.undone, 0);
    assert.equal(undone.failed, 1);
    assert.notEqual(undone.state, 'undoing');
    const recorded = await store.readBatchPlan(scope, deleted.planId);
    assert.equal(recorded?.items[0]?.state, 'failed');
    assert.equal(recorded?.items[0]?.error, 'delete_row_not_found');
  });

  test('worker restart resumes the same pending plan without regenerating item ids', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({
      store, scope, api, kind: 'rename', nativeIds: ['bm-1', 'bm-2'],
      titles: { 'bm-1': 'A', 'bm-2': 'B' },
    });
    const committed = await store.commitBatchPlan(scope, {
      plan: {
        planId: 'cmd-resume', commandId: 'cmd-resume', kind: 'rename', digest: preview.digest,
        treeDigest: preview.treeDigest, boundaryVersion: preview.boundaryVersion, itemCount: 2,
        requiresSecondConfirm: false, createdAt: 10, updatedAt: 10,
      },
      items: toCommitItems(preview, { uuid: () => 'stable' }),
    });
    assert.equal(api.mutations.length, 0);
    const before = committed.items.map((item) => item.operationId);
    store.close();
    const reopened = createSyncStateStore({ indexedDB });
    await resumeBatchPlans({ store: reopened, scope, api });
    const after = await reopened.readBatchPlan(scope, committed.plan.planId);
    assert.deepEqual(after?.items.map((item) => item.operationId), before);
    assert.equal(after?.plan.planId, 'cmd-resume');
    assert.equal(api.node('bm-1')?.title, 'A');
    assert.equal(api.node('bm-2')?.title, 'B');
  });

  test('a permission failure while reading never records a delete as applied', async () => {
    // Reproduces the false success at the real resume entry point: preview saw
    // the node, but the resumed get() is denied. The bookmark still exists.
    const { store, api } = await setup();
    await commitPendingPlan({ store, api }, 'cmd-delete-denied', 'delete', ['bm-1']);
    api.get = async () => { throw new Error('Permission denied'); };
    await resumeBatchPlans({ store, scope, api });
    const after = await store.readBatchPlan(scope, 'cmd-delete-denied');
    assert.equal(after?.plan.state, 'attention');
    assert.equal(after?.items[0]?.state, 'failed');
    assert.equal(after?.items[0]?.error, 'bookmark_permission_denied');
    assert.equal(after?.items.filter((item) => item.state === 'applied').length, 0);
    assert.ok(api.node('bm-1'));
    assert.deepEqual(api.mutations, []);
  });

  test('transient lookup failures fail rename and move without touching Chrome', async () => {
    const { store, api } = await setup();
    const get = api.get.bind(api);
    for (const [planId, kind, nativeId, extra] of [
      ['cmd-rename-lookup', 'rename', 'bm-1', { titles: { 'bm-1': 'A' } }],
      ['cmd-move-lookup', 'move', 'bm-2', { targetParentId: 'folder-a' }],
    ] as const) {
      await commitPendingPlan({ store, api }, planId, kind, [nativeId], extra);
      api.get = async () => { throw new Error('Bookmark service unavailable'); };
      await resumeBatchPlans({ store, scope, api });
      const after = await store.readBatchPlan(scope, planId);
      assert.equal(after?.items[0]?.state, 'failed', planId);
      assert.equal(after?.items[0]?.error, 'bookmark_lookup_failed', planId);
      assert.equal(after?.plan.state, 'attention', planId);
      api.get = get;
    }
    assert.equal(api.node('bm-1')?.title, 'One');
    assert.equal(api.node('bm-2')?.parentId, 'bar');
    assert.deepEqual(api.mutations, []);
  });

  test('a verified not_found remains evidence that a delete is already applied', async () => {
    const { store, api } = await setup();
    await commitPendingPlan({ store, api }, 'cmd-delete-gone', 'delete', ['bm-1']);
    await api.remove('bm-1');
    // Chromium's real missing-id rejection, not the fixture's shorthand error.
    api.get = async () => { throw new Error("Can't find bookmark for id."); };
    api.mutations.length = 0;
    await resumeBatchPlans({ store, scope, api });
    const after = await store.readBatchPlan(scope, 'cmd-delete-gone');
    assert.equal(after?.plan.state, 'completed');
    assert.equal(after?.items[0]?.state, 'applied');
    assert.equal(after?.items[0]?.error, undefined);
    assert.deepEqual(api.mutations, []);
  });

  test('concurrent move skips undo when the postcondition no longer matches', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({
      store, scope, api, kind: 'move', nativeIds: ['bm-1'], targetParentId: 'folder-a',
    });
    const moved = await confirmBatch({
      store, scope, api, commandId: 'cmd-move', kind: 'move', nativeIds: ['bm-1'],
      previewDigest: preview.digest, targetParentId: 'folder-a',
    });
    assert.equal(api.node('bm-1')?.parentId, 'folder-a');
    await api.move('bm-1', { parentId: 'other' });
    const undone = await undoBatch({
      store, scope, api, planId: moved.planId, commandId: 'cmd-move',
    });
    assert.equal(undone.changed, 1);
    assert.equal(undone.undone, 0);
    assert.equal(api.node('bm-1')?.parentId, 'other');
  });

  test('cross-boundary move without second confirm is refused', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({
      store, scope, api, kind: 'move', nativeIds: ['bm-1'], targetParentId: 'other',
    });
    assert.equal(preview.requiresSecondConfirm, true);
    await assert.rejects(() => confirmBatch({
      store, scope, api, commandId: 'cmd-cross', kind: 'move', nativeIds: ['bm-1'],
      previewDigest: preview.digest, targetParentId: 'other',
    }), /confirm_required/);
    assert.equal(api.node('bm-1')?.parentId, 'bar');
  });

  test('confirm rejects empty batches and protected roots without Chrome writes', async () => {
    const { store, api } = await setup();
    await assert.rejects(() => confirmBatch({
      store, scope, api, commandId: 'cmd-empty', kind: 'delete', nativeIds: [],
      previewDigest: 'sha256:none', secondConfirm: true,
    }), /empty_batch/);
    const preview = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bar'] });
    api.mutations.length = 0;
    await assert.rejects(() => confirmBatch({
      store, scope, api, commandId: 'cmd-root', kind: 'delete', nativeIds: ['bar'],
      previewDigest: preview.digest, secondConfirm: true,
    }), /protected_root/);
    assert.equal(api.mutations.length, 0);
  });

  test('parked remote-delete natives are rejected at confirm', async () => {
    const { store, api } = await setup();
    await parkRemoteDeleteNative(store, scope, 'bm-1');
    const preview = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bm-1'] });
    assert.equal(preview.items[0]?.blocked, 'remote_delete_pending');
    api.mutations.length = 0;
    await assert.rejects(() => confirmBatch({
      store, scope, api, commandId: 'cmd-parked', kind: 'delete', nativeIds: ['bm-1'],
      previewDigest: preview.digest, secondConfirm: true,
    }), /remote_delete_pending/);
    assert.equal(api.mutations.length, 0);
    assert.ok(api.node('bm-1'));
  });

  test('executing resume retries only when live tree still matches preDigest', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({
      store, scope, api, kind: 'rename', nativeIds: ['bm-1', 'bm-2'],
      titles: { 'bm-1': 'A', 'bm-2': 'B' },
    });
    const committed = await store.commitBatchPlan(scope, {
      plan: {
        planId: 'cmd-exec', commandId: 'cmd-exec', kind: 'rename', digest: preview.digest,
        treeDigest: preview.treeDigest, boundaryVersion: preview.boundaryVersion, itemCount: 2,
        requiresSecondConfirm: false, createdAt: 10, updatedAt: 10,
      },
      items: toCommitItems(preview, { uuid: () => 'stable' }),
    });
    for (const item of committed.items) {
      await store.settleBatchItem(scope, {
        planId: committed.plan.planId, itemId: item.itemId, expectedCasVersion: item.casVersion,
        expectedState: 'pending', state: 'executing', now: 11,
      });
    }
    await api.update('bm-1', { title: 'Concurrent' });
    api.mutations.length = 0;
    await resumeBatchPlans({ store, scope, api });
    const after = await store.readBatchPlan(scope, committed.plan.planId);
    assert.equal(after?.items.find((item) => item.nativeId === 'bm-1')?.state, 'changed');
    assert.equal(after?.items.find((item) => item.nativeId === 'bm-2')?.state, 'applied');
    assert.equal(api.node('bm-1')?.title, 'Concurrent');
    assert.equal(api.node('bm-2')?.title, 'B');
    assert.deepEqual(api.mutations, ['update:bm-2']);
  });

  test('disconnect resume does not mint a second restore opId', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bm-1'] });
    const deleted = await confirmBatch({
      store, scope, api, commandId: 'cmd-disconnect', kind: 'delete', nativeIds: ['bm-1'],
      previewDigest: preview.digest, secondConfirm: true,
    });
    const item = deleted.items[0]!;
    await seedTerminalDelete(store, item.colpId!, item.mappingRevision ?? 'rev-1');
    await seedRestore(store, item.reversalId, item.colpId!, item.mappingRevision ?? 'rev-1');
    const recorded = await store.readBatchPlan(scope, deleted.planId);
    await store.settleBatchPlan(scope, {
      planId: deleted.planId, expectedCasVersion: recorded!.plan.casVersion, state: 'undoing', now: 20,
    });
    await store.settleBatchItem(scope, {
      planId: deleted.planId, itemId: item.itemId, expectedCasVersion: recorded!.items[0]!.casVersion,
      expectedState: 'applied', state: 'undoing', now: 20,
    });
    store.close();
    const reopened = createSyncStateStore({ indexedDB });
    await resumeBatchPlans({ store: reopened, scope, api });
    const restores = (await reopened.listQueue(scope)).filter((row) => row.payload.type === 'restore_node');
    assert.equal(restores.length, 1);
    assert.equal(restores[0]?.opId, item.reversalId);
    assert.equal(restores[0]?.payload.targetId, 'node-1');
  });
});

async function commitPendingPlan(
  fixture: Awaited<ReturnType<typeof setup>>, planId: string,
  kind: 'rename' | 'move' | 'delete', nativeIds: readonly string[],
  extra: { readonly titles?: Readonly<Record<string, string>>; readonly targetParentId?: string } = {},
): Promise<void> {
  const preview = await previewBatch({ store: fixture.store, scope, api: fixture.api, kind, nativeIds, ...extra });
  await fixture.store.commitBatchPlan(scope, {
    plan: {
      planId, commandId: planId, kind, digest: preview.digest, treeDigest: preview.treeDigest,
      boundaryVersion: preview.boundaryVersion, itemCount: preview.items.length,
      requiresSecondConfirm: preview.requiresSecondConfirm, createdAt: 10, updatedAt: 10,
    },
    items: toCommitItems(preview, { uuid: () => 'stable' }),
  });
}

async function setup() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-batch', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: ['bar'], privateRoots: ['other'],
    boundaryVersion: '1',
  });
  await store.putMapping(scope, {
    nativeId: 'bar', colpId: 'folder-bar', rootNativeId: 'bar', nodeKind: 'folder',
    projection: { revision: 'rev-bar', digest: 'sha256:bar' },
  });
  await store.putMapping(scope, {
    nativeId: 'bm-1', colpId: 'node-1', rootNativeId: 'bar', nodeKind: 'bookmark', parentNativeId: 'bar',
    projection: { revision: 'rev-1', digest: 'sha256:one' },
  });
  await store.putMapping(scope, {
    nativeId: 'bm-2', colpId: 'node-2', rootNativeId: 'bar', nodeKind: 'bookmark', parentNativeId: 'bar',
    projection: { revision: 'rev-2', digest: 'sha256:two' },
  });
  await store.putMapping(scope, {
    nativeId: 'folder-a', colpId: 'node-folder-a', rootNativeId: 'bar', nodeKind: 'folder', parentNativeId: 'bar',
    projection: { revision: 'rev-folder', digest: 'sha256:folder' },
  });
  return { store, api: createMemoryBookmarks() };
}

async function seedRestore(store: ReturnType<typeof createSyncStateStore>, opId: string, targetId: string,
  revision: string) {
  await store.allocateSequenceAndEnqueue(scope, {
    opId, batchId: opId, idempotencyKey: opId, digest: 'sha256:pending', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: revision, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: {
      type: 'restore_node', opId, targetId, baseRevision: revision,
      occurredAt: new Date(1).toISOString(), dependencies: [], payload: { reason: 'bookmark_batch_undo' },
    },
  }, { validateOperation, digestOperation: digestJson });
}

async function seedTerminalDelete(store: ReturnType<typeof createSyncStateStore>, targetId: string, revision: string,
  result?: JsonObject) {
  const queued = await store.allocateSequenceAndEnqueue(scope, {
    opId: `del-${targetId}`, batchId: `del-${targetId}`, idempotencyKey: `del-${targetId}`,
    digest: 'sha256:pending', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: revision, operationRevision: `local-del-${targetId}`, status: 'pending',
    retry: { attempt: 0, notBefore: 0 },
    payload: {
      type: 'delete_node', opId: `del-${targetId}`, targetId, baseRevision: revision,
      occurredAt: new Date(1).toISOString(), dependencies: [], payload: { reason: 'browser_event' },
    },
  }, { validateOperation, digestOperation: digestJson });
  await store.completeQueueWithReceipt(scope, queued.sequence, {
    opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `receipt-${queued.opId}`,
    resultDigest: 'sha256:deleted', ...(result ? { result } : {}),
  });
  return queued;
}
