import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceLayout, type LayoutNativeNode } from '../src/site-adapters/layout.js';
import { representationKey } from '../src/site-adapters/reservations.js';
import type { NativeBinding, Representation } from '../src/site-adapters/contracts.js';
test('sync callbacks and same-parent reordering preserve ownership while actual edits and deletion stop reconstruction', async () => {
  const db = createSourceDatabase(new IDBFactory());
  const native: NativeBinding<'bookmark'> = { nativeId: 'bookmark', bindingId: 'proof', deviceId: 'device', dateAdded: 10, kind: 'bookmark', proof: { kind: 'writeReceipt', id: 'command' } };
  const representation: Representation = { connectionId: 'source', itemId: 'post', purpose: 'sourceArchive', sourceCollectionId: 'saved', mountId: 'mount', native,
    state: 'active', manualRevision: 0, lastWritten: { title: 'Original', parentId: 'folder', url: 'https://posts.test' },
    shared: { library: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' }, nodeId: 'canonical',
      slot: { kind: 'bookmark', copy: { purpose: 'sourceArchive', content: { site: 'fixture.posts', identityVersion: 1, itemId: 'post', accountId: null }, sourceAccount: 'source', sourceCollectionId: 'saved' } } } };
  const nodes = new Map<string, LayoutNativeNode>([['bookmark', { id: 'bookmark', title: 'Original', parentId: 'folder', url: 'https://posts.test/', dateAdded: 10 }]]);
  const layout = createSourceLayout(db, { rules: async () => ({ revision: 1, items: [], contentVersions: {}, stopped: null, skippedSources: [], needsAttention: [] }),
    paused: async () => false, deviceId: async () => 'device', lookup: async id => nodes.get(id) ?? null, assertRoot: async () => {} });
  try {
    await db.transaction(['representations'], 'readwrite', async tx => { tx.objectStore('representations').put(representation, representationKey(representation)); });
    await layout.nativeChanged(['bookmark'], false);
    expect(await db.read('representations', representationKey(representation))).toMatchObject({ state: 'active', manualRevision: 0 });
    nodes.set('bookmark', { ...nodes.get('bookmark')!, title: 'My title' });
    await layout.nativeChanged(['bookmark'], false);
    expect(await db.read('representations', representationKey(representation))).toMatchObject({ state: 'active', localTitle: 'My title', manualRevision: 0 });
    nodes.set('bookmark', { ...nodes.get('bookmark')!, url: 'https://other.test/' });
    await layout.nativeChanged(['bookmark'], false);
    expect(await db.read('representations', representationKey(representation))).toMatchObject({ state: 'detached', manualRevision: 1 });
    await layout.nativeChanged(['bookmark'], true);
    expect(await db.read('representations', representationKey(representation))).toMatchObject({ state: 'suppressed', manualRevision: 2 });
    const changes = await db.transaction(['meta'], 'readonly', tx => new Promise<any[]>(resolve => { const r = tx.objectStore('meta').getAll(); r.onsuccess = () => resolve(r.result); }));
    expect(changes).toEqual([{ reference: representation.shared, state: 'suppressed' }]);
  } finally { await db.close(); }
});
test('a changed destination owner fences old work and populated mappings cannot be silently reassigned', async () => {
  const db = createSourceDatabase(new IDBFactory());
  const original = { serverOrigin: 'https://sync.test', accountId: 'owner-a', collectionId: 'library' };
  let destination = original;
  const layout = createSourceLayout(db, { rules: async () => ({ revision: 1, items: [], contentVersions: {}, stopped: null, skippedSources: [], needsAttention: [] }),
    paused: async () => false, deviceId: async () => 'device', lookup: async () => ({ id: 'root', title: 'Root', dateAdded: 10 }), assertRoot: async () => {}, destination: async () => destination });
  try {
    const mount = await layout.bindRoot('source', 'rule', 'root');
    destination = { ...original, accountId: 'owner-b' };
    await expect(layout.validateRoot('source', 'rule', 'root')).rejects.toThrow('sourceDestinationChanged');
    await db.transaction(['folderReservations'], 'readwrite', async tx => { tx.objectStore('folderReservations').put({ state: 'unknown' }, sourceKey(mount.id, 'saved')); });
    await expect(layout.bindRoot('source', 'rule', 'root', true)).rejects.toThrow('sourceDestinationMigrationRequired');
    destination = original; await layout.validateRoot('source', 'rule', 'root');
  } finally { await db.close(); }
});
