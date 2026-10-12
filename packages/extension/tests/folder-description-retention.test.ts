import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
import { collectDescriptionGarbage, retainRemovedDescriptions, restoreCreatedDescriptions } from '../src/sw/folder-description-retention.js';
import { METADATA_RETENTION_MS } from '../src/metadata-retention.js';
afterEach(() => vi.unstubAllGlobals());

test('folder removal retains its description, only the same native folder restores it, and missing folders are collected', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const store = createFolderDescriptionStore(), folder = { id: 'old', title: 'Research', dateAdded: 1 };
  try {
    await store.save(folder, 'Papers'); await retainRemovedDescriptions([folder.id], [folder]);
    expect(await store.get(folder)).toBeNull(); expect(await store.list(true)).toHaveLength(1);
    // A new folder with the same title is not the removed one (6500effd9); an undo of the removal is.
    const sameTitle = { ...folder, id: 'new', dateAdded: 2 };
    await restoreCreatedDescriptions([sameTitle]); expect(await store.get(sameTitle)).toBeNull();
    await restoreCreatedDescriptions([folder]); expect(await store.get(folder)).toMatchObject({ description: 'Papers', state: 'dirty' });
    await collectDescriptionGarbage([{ id: '0', title: 'Root', children: [] }]);
    expect(await store.list()).toEqual([]); expect(await store.list(true)).toHaveLength(1);
  } finally { store.close(); }
});

test('folder retention expires and duplicate folder names are ambiguous', async () => {
  let now = 100; const store = createFolderDescriptionStore({ indexedDB: new IDBFactory(), now: () => now });
  try {
    for (const id of ['a', 'b']) { await store.save({ id, title: 'Same' }, id); await store.remove([id]); }
    await store.restoreRemoved({ id: 'new', title: 'Same' }); expect(await store.get({ id: 'new' })).toBeNull();
    now += METADATA_RETENTION_MS; await store.pruneRemoved(); expect(await store.list(true)).toEqual([]);
  } finally { store.close(); }
});
