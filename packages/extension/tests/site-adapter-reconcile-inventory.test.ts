import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { reconcileInventory } from '../src/site-adapters/reconcile-inventory.js';
import type { NativeBinding } from '../src/site-adapters/contracts.js';
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/bookmark-annotation-store.js', () => ({ createBookmarkAnnotationStore: () => ({ getMany: async () => new Map(), close() {} }) }));
const native = (nativeId: string): NativeBinding<'folder'> => ({ nativeId, kind: 'folder', dateAdded: 1, deviceId: 'device', bindingId: nativeId, proof: { kind: 'explicitAdoption', id: nativeId } });
afterEach(() => vi.unstubAllGlobals());

test.each(['collection', 'root'] as const)('empty %s mappings protect themselves and enclosing personal folders', async kind => {
  const db = createSourceDatabase(new IDBFactory());
  const child = { id: 'foreign', title: 'Other mapping', dateAdded: 1, parentId: 'personal', children: [] };
  const tree = { id: 'saved', title: 'Saved', dateAdded: 1, parentId: 'root', children: [{ id: 'personal', title: 'Personal', dateAdded: 1, parentId: 'saved', children: [child] }] };
  vi.stubGlobal('chrome', { bookmarks: { getSubTree: async () => [tree] } });
  try {
    await db.transaction(['meta', 'mounts', 'folderReservations'], 'readwrite', async tx => {
      tx.objectStore('meta').put({ ruleId: 'rule' }, 'archiveConfig:source');
      tx.objectStore('mounts').put({ id: 'mount', root: native('root') }, sourceKey('source', 'rule'));
      tx.objectStore('folderReservations').put({ mountId: 'mount', collectionId: 'saved', native: native('saved'), parent: { kind: 'native', binding: native('root') } }, 'selected');
      if (kind === 'root') tx.objectStore('mounts').put({ id: 'other', root: native('foreign') }, 'other');
      else tx.objectStore('folderReservations').put({ mountId: 'other', collectionId: 'other', native: native('foreign') }, 'other');
    });
    const inventory = await reconcileInventory(db, 'source', ['saved']);
    expect(inventory.nodes.map(n => [n.native.nativeId, n.protected])).toEqual([['personal', true], ['foreign', true]]);
  } finally { await db.close(); }
});

test('a moved collection folder containing another selected empty collection stays protected', async () => {
  const db = createSourceDatabase(new IDBFactory());
  const inner = { id: 'inner', title: 'Inner', parentId: 'saved', dateAdded: 1, children: [] };
  const outer = { id: 'saved', title: 'Saved', parentId: 'personal', dateAdded: 1, children: [inner] };
  vi.stubGlobal('chrome', { bookmarks: { getSubTree: async (id: string) => [id === 'saved' ? outer : inner], get: async () => [{ parentId: 'root' }] } });
  try {
    await db.transaction(['meta', 'mounts', 'folderReservations'], 'readwrite', async tx => {
      tx.objectStore('meta').put({ ruleId: 'rule' }, 'archiveConfig:source');
      tx.objectStore('mounts').put({ id: 'mount', root: native('root') }, sourceKey('source', 'rule'));
      for (const id of ['saved', 'inner']) tx.objectStore('folderReservations').put({ mountId: 'mount', collectionId: id, native: native(id), parent: { kind: 'native', binding: native('root') } }, id);
    });
    const inventory = await reconcileInventory(db, 'source', ['saved', 'inner']);
    expect(inventory.movedFolders.find(f => f.folder.collectionId === 'saved')?.node.protected).toBe(true);
  } finally { await db.close(); }
});
