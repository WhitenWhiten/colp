import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
import { METADATA_RETENTION_MS, retainedMetadataFor } from '../src/metadata-retention.js';
import { scopeKey } from '../src/sync-state/scope-key.js';

const authority = (accountId: string) => scopeKey({ environment: 'production', serverId: 'server',
  serverOrigin: 'https://known.test', accountId, browserProfileId: 'profile', collectionId: 'collection',
  replicaId: 'replica', generation: 1 });

test('only exact native restoration reattaches metadata; unrelated and expired tombstones stay isolated', async () => {
  let now = 100;
  const store = createBookmarkAnnotationStore({ indexedDB: new IDBFactory(), now: () => now });
  const original = { id: 'old', title: 'Page', url: 'https://example.test/', dateAdded: 1 };
  try {
    const before = await store.save(original, { tags: ['tag'], note: 'Note' });
    await store.remove(original.id);
    expect(await store.get(original)).toBeNull();
    expect(await store.list()).toEqual([]);
    const unrelated = { ...original, id: 'new', dateAdded: 2 };
    await store.restoreRemoved(unrelated);
    expect(await store.get(unrelated)).toBeNull();
    expect(await store.list(true)).toHaveLength(1);
    await store.restoreRemoved(original);
    expect(await store.get(original)).toMatchObject({ tags: ['tag'], note: 'Note', version: before!.version,
      tagsSync: before!.tagsSync, noteSync: before!.noteSync });
    await store.remove(original.id);
    now += METADATA_RETENTION_MS;
    await store.restoreRemoved(original);
    expect(await store.get(original)).toBeNull();
    await store.pruneRemoved();
    expect(await store.list(true)).toEqual([]);
  } finally { store.close(); }
});

test('ambiguous duplicate bookmarks never receive each other’s retained notes', async () => {
  const store = createBookmarkAnnotationStore({ indexedDB: new IDBFactory() });
  try {
    for (const id of ['a', 'b']) {
      await store.save({ id, title: 'Page', url: 'https://example.test/' }, { tags: [], note: id });
      await store.remove(id);
    }
    await store.restoreRemoved({ id: 'new', title: 'Page', url: 'https://example.test/' });
    expect(await store.get({ id: 'new' })).toBeNull();
  } finally { store.close(); }
});

test('restored annotations retain account authority and unresolved note command identity', async () => {
  const store = createBookmarkAnnotationStore({ indexedDB: new IDBFactory(), now: () => 100 });
  const bookmark = { id: 'bookmark', dateAdded: 1, url: 'https://example.test/', title: 'Page' };
  const binding = { scopeKey: authority('A'), resourceId: 'node-A', revision: 'r1', value: null,
    annotationId: null, supported: true };
  try {
    await store.observeTags(bookmark, { ...binding, value: ['private-A'] });
    await store.observeNote(bookmark, binding);
    await store.save(bookmark, { tags: ['private-A'], note: 'private draft' });
    await store.prepareNote(bookmark, authority('A'), 'node-A');
    const before = await store.get(bookmark);
    expect(before!.noteIntent).toBeDefined();
    await store.remove(bookmark.id);
    await store.restoreRemoved(bookmark);
    const restored = await store.get(bookmark);
    expect(restored!.version).toBe(before!.version);
    expect(restored!.noteIntent).toEqual(before!.noteIntent);
    expect(restored!.noteSync).toEqual(before!.noteSync);
    expect(restored!.tagsSync).toEqual(before!.tagsSync);
    await store.observeTags(bookmark, { scopeKey: authority('B'), resourceId: 'node-B', revision: 'r2', value: [] });
    await store.observeNote(bookmark, { ...binding, scopeKey: authority('B'), resourceId: 'node-B' });
    const after = await store.get(bookmark);
    expect(after!.tagsSync!.remote!.scopeKey).toBe(authority('A'));
    expect(after!.noteSync!.remote!.scopeKey).toBe(authority('A'));
    expect(after!.note).toBe('private draft');
  } finally { store.close(); }
});

test('same-title folders cannot inherit descriptions and exact recovery preserves review versions', async () => {
  const store = createFolderDescriptionStore({ indexedDB: new IDBFactory(), now: () => 100 });
  const folder = { id: 'folder', dateAdded: 1, title: 'Folder' };
  const binding = { scopeKey: authority('A'), colpId: 'folder-A', revision: 'r1', description: 'cloud text' };
  try {
    await store.save(folder, 'private draft');
    await store.observeRemote([{ folder, binding }]);
    const before = await store.get(folder);
    expect(before!.reviewVersion).toBe(before!.version);
    await store.remove([folder.id]);
    const unrelated = { ...folder, id: 'different', dateAdded: 2 };
    await store.restoreRemoved(unrelated);
    expect(await store.get(unrelated)).toBeNull();
    await store.restoreRemoved(folder);
    const restored = await store.get(folder);
    expect(restored!.version).toBe(before!.version);
    expect(restored!.reviewVersion).toBe(before!.reviewVersion);
    expect(restored!.remote).toEqual(before!.remote);
    await store.observeRemote([{ folder, binding: { ...binding, scopeKey: authority('B'), colpId: 'folder-B' } }]);
    expect((await store.get(folder))!.remote!.scopeKey).toBe(authority('A'));
  } finally { store.close(); }
});

test('restoration rejects missing/changed dates, future deletion time, URL mismatch and ambiguous identity', () => {
  const row = { nativeId: 'id', dateAdded: 1, url: 'https://example.test/', removedAt: 100 };
  const node = { id: 'id', dateAdded: 1, url: row.url };
  expect(retainedMetadataFor([row], node, 100)).toBe(row);
  expect(retainedMetadataFor([row], { ...node, dateAdded: undefined }, 100)).toBeUndefined();
  expect(retainedMetadataFor([row], { ...node, dateAdded: 2 }, 100)).toBeUndefined();
  expect(retainedMetadataFor([row], node, 99)).toBeUndefined();
  expect(retainedMetadataFor([row], { ...node, url: 'https://other.test/' }, 100)).toBeUndefined();
  expect(retainedMetadataFor([row, row], node, 100)).toBeUndefined();
});
