import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createLocalBatchStore } from '../src/bookmark-batch-local-store.js';
import { confirmBatch, previewOrThrow } from '../src/bookmark-batch-executor.js';
import { createMemoryBookmarks } from './bookmark-batch-memory.js';

for (const mutation of ['add', 'rename', 'remove'] as const) test(`folder deletion rejects a ${mutation} to its descendants after preview`, async () => {
  const store = createLocalBatchStore(new IDBFactory()), local = store.local, api = createMemoryBookmarks();
  const child = await api.create!({ parentId: 'folder-a', title: 'Child', url: 'https://child.test/' });
  const preview = await previewOrThrow({ local, api, kind: 'delete', nativeIds: ['folder-a'] });
  if (mutation === 'add') await api.create!({ parentId: 'folder-a', title: 'Unseen', url: 'https://unseen.test/' });
  if (mutation === 'rename') await api.update(child.id, { title: 'Unseen edit' });
  if (mutation === 'remove') await api.remove(child.id);
  api.mutations.length = 0;
  await assert.rejects(() => confirmBatch({ local, api, kind: 'delete', nativeIds: ['folder-a'], commandId: crypto.randomUUID(),
    previewDigest: preview.digest, secondConfirm: true }), /stale_revision/);
  assert.ok(api.node('folder-a')); assert.deepEqual(api.mutations, []); await store.close();
});

test('folder deletion rechecks descendants after committing the plan and before removeTree', async () => {
  const store = createLocalBatchStore(new IDBFactory()), local = store.local, api = createMemoryBookmarks();
  const preview = await previewOrThrow({ local, api, kind: 'delete', nativeIds: ['folder-a'] });
  const commit = local.commitBatchPlan;
  const interrupted = { ...local, async commitBatchPlan(...args: Parameters<typeof commit>) {
    const result = await commit(...args);
    await api.create!({ parentId: 'folder-a', title: 'New after commit', url: 'https://new.test/' });
    return result;
  } };
  const view = await confirmBatch({ local: interrupted, api, kind: 'delete', nativeIds: ['folder-a'], commandId: crypto.randomUUID(),
    previewDigest: preview.digest, secondConfirm: true });
  assert.equal(view.changed, 1); assert.equal(view.applied, 0);
  assert.equal(api.node('folder-a')!.children![0]!.title, 'New after commit');
  assert.equal(api.mutations.includes('removeTree:folder-a'), false); await store.close();
});
