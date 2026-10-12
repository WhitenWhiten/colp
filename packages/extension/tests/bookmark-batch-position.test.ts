import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createLocalBatchStore } from '../src/bookmark-batch-local-store.js';
import { confirmBatch, previewOrThrow, resumeBatchPlans, undoBatch } from '../src/bookmark-batch-executor.js';
import { itemPostDigest, toCommitItems } from '../src/bookmark-batch-plan.js';
import { backupLocalDelete } from '../src/bookmark-local-delete.js';
import { createMemoryBookmarks } from './bookmark-batch-memory.js';

async function fixture() {
  const factory = new IDBFactory(), store = createLocalBatchStore(factory);
  return { factory, store, local: store.local, api: createMemoryBookmarks() };
}

for (const ids of [['bm-1', 'bm-2'], ['bm-2', 'bm-1']]) test(`adjacent deletion and undo preserve order for selection ${ids.join(',')}`, async () => {
  const f = await fixture(), preview = await previewOrThrow({ ...f, kind: 'delete', nativeIds: ids });
  const commandId = crypto.randomUUID(), deleted = await confirmBatch({ ...f, kind: 'delete', nativeIds: ids, commandId, previewDigest: preview.digest, secondConfirm: true });
  assert.equal(deleted.applied, 2); assert.equal(deleted.changed, 0);
  assert.equal(f.api.node('bm-1'), undefined); assert.equal(f.api.node('bm-2'), undefined);
  const undone = await undoBatch({ ...f, planId: commandId, commandId });
  assert.equal(undone.undone, 2);
  assert.deepEqual(f.api.node('bar')!.children!.map(node => node.title), ['One', 'Two', 'Folder A']); await f.store.close();
});

test('batch moves preserve selection order in the destination and reverse correctly after reopening', async () => {
  const f = await fixture(), nativeIds = ['bm-1', 'bm-2'];
  const preview = await previewOrThrow({ ...f, kind: 'move', nativeIds, targetParentId: 'other' });
  const commandId = crypto.randomUUID(), moved = await confirmBatch({ ...f, kind: 'move', nativeIds, targetParentId: 'other', commandId, previewDigest: preview.digest });
  assert.equal(moved.applied, 2); assert.equal(moved.changed, 0);
  assert.deepEqual(f.api.node('other')!.children!.map(node => node.title), ['Local', 'One', 'Two']);
  await f.store.close(); const reopened = createLocalBatchStore(f.factory);
  const undone = await undoBatch({ ...f, local: reopened.local, planId: commandId, commandId });
  assert.equal(undone.undone, 2); assert.equal(undone.changed, 0);
  assert.deepEqual(f.api.node('bar')!.children!.map(node => node.title), ['One', 'Two', 'Folder A']);
  assert.deepEqual(f.api.node('other')!.children!.map(node => node.title), ['Local']); await reopened.close();
});

for (const mutation of ['rename', 'move'] as const) test(`a real concurrent ${mutation} is not mistaken for an index shift`, async () => {
  const f = await fixture(), nativeIds = ['bm-1', 'bm-2'], preview = await previewOrThrow({ ...f, kind: 'delete', nativeIds });
  const remove = f.api.remove;
  f.api.remove = async id => { await remove(id); if (id === 'bm-1') {
    if (mutation === 'rename') await f.api.update('bm-2', { title: 'User edit' });
    else await f.api.move('bm-2', { parentId: 'other' });
  } };
  const view = await confirmBatch({ ...f, kind: 'delete', nativeIds, commandId: crypto.randomUUID(), previewDigest: preview.digest, secondConfirm: true });
  assert.equal(view.applied, 1); assert.equal(view.changed, 1); assert.ok(f.api.node('bm-2')); await f.store.close();
});

test('worker restart resumes the next sibling from a durable deletion receipt', async () => {
  const f = await fixture(), nativeIds = ['bm-1', 'bm-2'], preview = await previewOrThrow({ ...f, kind: 'delete', nativeIds });
  const commandId = crypto.randomUUID();
  const committed = await f.local.commitBatchPlan({ plan: { planId: commandId, commandId, kind: 'delete', digest: preview.digest,
    treeDigest: preview.treeDigest, boundaryVersion: preview.boundaryVersion, itemCount: 2, requiresSecondConfirm: true, createdAt: Date.now(), updatedAt: Date.now() },
    items: toCommitItems(preview, { uuid: () => crypto.randomUUID() }) });
  const first = committed.items[0]!, started = await f.local.settleBatchItem({ planId: commandId, itemId: first.itemId,
    expectedCasVersion: first.casVersion, expectedState: 'pending', state: 'executing', now: Date.now() });
  await backupLocalDelete(f.api, first, Date.now()); await f.api.remove(first.nativeId);
  await f.local.settleBatchItem({ planId: commandId, itemId: first.itemId, expectedCasVersion: started.casVersion, expectedState: 'executing', state: 'applied', now: Date.now(),
    postIndex: 0, postDigest: itemPostDigest({ nativeId: first.nativeId, title: first.title, url: first.url, parentId: first.parentNativeId, index: first.index, kind: first.nodeKind, deleted: true }) });
  await f.store.close(); const reopened = createLocalBatchStore(f.factory);
  const resumed = await resumeBatchPlans({ ...f, local: reopened.local });
  assert.equal(resumed[0]!.applied, 2); assert.equal(resumed[0]!.changed, 0);
  const undone = await undoBatch({ ...f, local: reopened.local, planId: commandId, commandId });
  assert.equal(undone.undone, 2); assert.deepEqual(f.api.node('bar')!.children!.map(node => node.title), ['One', 'Two', 'Folder A']); await reopened.close();
});

test('a folder and selected child are deleted once as one subtree and restored once', async () => {
  const f = await fixture(), child = await f.api.create!({ parentId: 'folder-a', title: 'Child', url: 'https://child.test/' });
  const nativeIds = [child.id, 'folder-a'], preview = await previewOrThrow({ ...f, kind: 'delete', nativeIds });
  assert.deepEqual(preview.items.map(item => item.nativeId), ['folder-a']);
  const commandId = crypto.randomUUID(), deleted = await confirmBatch({ ...f, kind: 'delete', nativeIds, commandId, previewDigest: preview.digest, secondConfirm: true });
  assert.equal(deleted.applied, 1);
  const undone = await undoBatch({ ...f, planId: commandId, commandId });
  assert.equal(undone.undone, 1); assert.equal(f.api.node('bar')!.children![2]!.children![0]!.title, 'Child'); await f.store.close();
});
