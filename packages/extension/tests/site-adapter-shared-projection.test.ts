import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { refreshSharedProjection } from '../src/site-adapters/shared-projection.js';
import type { ManagedBinding } from '../src/site-adapters/managed-client.js';
test('a proven remote semantic move refreshes the source alias without overwriting personal or foreign-library changes', async () => {
  const db = createSourceDatabase(new IDBFactory()), library = { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' };
  const native = { nativeId: 'native', dateAdded: 10, deviceId: 'device', kind: 'bookmark' as const, bindingId: 'original', proof: { kind: 'writeReceipt' as const, id: 'original' } };
  const binding: ManagedBinding = { collectionId: 'library', state: 'active', slot: { kind: 'bookmark', copy: { purpose: 'sourceArchive', sourceAccount: '42', sourceCollectionId: '101',
    content: { site: 'bilibili', identityVersion: 1, itemId: 'video:av:1', accountId: null } } }, node: { nodeId: 'canonical', title: 'Video', url: 'https://www.bilibili.com/video/av1', parentId: 'canonical-topics', revision: 'moved' } };
  const shared = { library, slot: binding.slot, nodeId: 'canonical' }, written = { title: 'Video', url: binding.node.url, parentId: 'source-folder' };
  try {
    await db.transaction(['representations', 'contentBindings'], 'readwrite', async tx => {
      tx.objectStore('representations').put({ native, shared, state: 'active', lastWritten: written }, 'source');
      tx.objectStore('representations').put({ native, shared: { ...shared, library: { ...library, accountId: 'other' } }, state: 'active', lastWritten: written }, 'foreign');
      tx.objectStore('contentBindings').put({ native, shared, state: 'detached', parentId: 'personal', title: 'My title' }, 'edited');
    });
    await refreshSharedProjection(db, library, binding, { native, parentId: 'topics' });
    expect(await db.read('representations', 'source')).toMatchObject({ native, lastWritten: { parentId: 'topics' } });
    expect(await db.read('representations', 'foreign')).toMatchObject({ lastWritten: written });
    expect(await db.read('contentBindings', 'edited')).toMatchObject({ state: 'detached', parentId: 'personal', title: 'My title' });
  } finally { await db.close(); }
});
