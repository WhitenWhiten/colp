import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { backupLocalDelete, restoreLocalDelete } from '../src/bookmark-local-delete.js';
import { createLocalDeleteStore } from '../src/bookmark-local-delete-store.js';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
import { createMemoryBookmarks } from './bookmark-batch-memory.js';
import type { BatchItemRecord } from '../src/sync-state/batch-repository.js';

const item = (id: string, parentId: string, index: number): BatchItemRecord => ({
  scopeKey: 'local', planId: 'plan', itemId: id, order: 0, nativeId: id, nodeKind: 'folder',
  title: 'Folder', parentNativeId: parentId, index, preDigest: '', operationId: 'delete',
  reversalId: crypto.randomUUID(), state: 'applied', casVersion: 1,
});

test('offline delete Undo restores folder descriptions with the newly created native identities', async () => {
  const factory = new IDBFactory(), previous = globalThis.indexedDB;
  globalThis.indexedDB = factory;
  const descriptions = createFolderDescriptionStore(), journal = createLocalDeleteStore(factory), api = createMemoryBookmarks();
  try {
    await descriptions.save(api.node('folder-a')!, 'Developer tools and documentation');
    const deleted = item('folder-a', 'bar', 2);
    await backupLocalDelete(api, deleted, Date.now(), journal); await api.removeTree('folder-a');
    await restoreLocalDelete(api, deleted, journal);
    const restored = api.node('bar')!.children![2]!;
    assert.notEqual(restored.id, 'folder-a');
    assert.equal((await descriptions.get(restored))?.description, 'Developer tools and documentation');
    const mutations = api.mutations.length;
    await restoreLocalDelete(api, deleted, journal);
    assert.equal(api.mutations.length, mutations);
  } finally { descriptions.close(); await journal.close(); globalThis.indexedDB = previous; }
});

test('a persisted folder snapshot restores nested folders, duplicate URLs and sibling order after reopening', async () => {
  const factory = new IDBFactory(), journal = createLocalDeleteStore(factory), api = createMemoryBookmarks();
  await api.create!({ parentId: 'folder-a', title: 'Nested' });
  const nested = api.node('folder-a')!.children![0]!;
  await api.create!({ parentId: nested.id, title: '', url: 'https://duplicate.test/' });
  await api.create!({ parentId: nested.id, title: 'Second copy', url: 'https://duplicate.test/' });
  const deleted = item('folder-a', 'bar', 2);
  await backupLocalDelete(api, deleted, Date.now(), journal);
  await api.removeTree('folder-a'); await journal.close();
  const reopened = createLocalDeleteStore(factory);
  await restoreLocalDelete(api, deleted, reopened);
  const root = api.node('bar')!.children![2]!;
  assert.equal(root.title, 'Folder A');
  assert.equal(root.children![0]!.title, 'Nested');
  assert.deepEqual(root.children![0]!.children!.map(node => [node.title, node.url]), [['', 'https://duplicate.test/'], ['Second copy', 'https://duplicate.test/']]);
  const creates = api.mutations.length;
  await restoreLocalDelete(api, deleted, reopened);
  assert.equal(api.mutations.length, creates); await reopened.close();
});

test('an interrupted restore resumes recorded identities without recreating the root', async () => {
  const journal = createLocalDeleteStore(new IDBFactory()), api = createMemoryBookmarks();
  await api.create!({ parentId: 'folder-a', title: 'Child', url: 'https://child.test/' });
  const deleted = item('folder-a', 'bar', 2);
  await backupLocalDelete(api, deleted, Date.now(), journal); await api.removeTree('folder-a');
  const snapshot = (await journal.get(deleted.reversalId))!, node = (await journal.node(deleted.reversalId, 0))!;
  await journal.submit(snapshot, node);
  const root = await api.create!({ parentId: 'bar', index: 2, title: node.title });
  await journal.confirm(snapshot, node, root.id);
  await restoreLocalDelete(api, deleted, journal);
  assert.equal(api.node('bar')!.children!.filter(child => child.title === 'Folder A').length, 1);
  assert.equal(api.node(root.id)!.children![0]!.url, 'https://child.test/'); await journal.close();
});

test('a missing original parent never redirects restoration to a default folder', async () => {
  const journal = createLocalDeleteStore(new IDBFactory()), api = createMemoryBookmarks();
  const child = await api.create!({ parentId: 'folder-a', title: 'Child', url: 'https://child.test/' });
  const deleted = item(child.id, 'folder-a', 0);
  await backupLocalDelete(api, deleted, Date.now(), journal); await api.removeTree('folder-a');
  const count = api.mutations.length;
  await assert.rejects(() => restoreLocalDelete(api, deleted, journal));
  assert.equal(api.mutations.length, count);
  assert.ok(await journal.get(deleted.reversalId)); await journal.close();
});

test('an unknown native create retains the backup and is never dispatched again', async () => {
  const journal = createLocalDeleteStore(new IDBFactory()), api = createMemoryBookmarks();
  const deleted = item('folder-a', 'bar', 2);
  await backupLocalDelete(api, deleted, Date.now(), journal); await api.removeTree('folder-a');
  const snapshot = (await journal.get(deleted.reversalId))!, node = (await journal.node(deleted.reversalId, 0))!;
  await journal.submit(snapshot, node); await api.create!({ parentId: 'bar', title: node.title });
  const count = api.mutations.length;
  await assert.rejects(() => restoreLocalDelete(api, deleted, journal), /local_restore_result_unknown/);
  await journal.prune(Date.now() + 86400000);
  assert.ok(await journal.get(deleted.reversalId)); assert.equal(api.mutations.length, count); await journal.close();
});

test('snapshot persistence failure leaves the original data intact', async () => {
  const journal = createLocalDeleteStore(new IDBFactory()), api = createMemoryBookmarks();
  const deleted = item('folder-a', 'bar', 2);
  await assert.rejects(() => backupLocalDelete(api, deleted, Date.now(), { ...journal, async put() { throw new Error('storage_failed'); } }), /storage_failed/);
  assert.ok(api.node('folder-a')); await journal.close();
});
