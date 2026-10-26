import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { createSourceOverview } from '../src/site-adapters/overview.js';
import type { Representation } from '../src/site-adapters/contracts.js';
import { representationKey } from '../src/site-adapters/reservations.js';

test('mapping results count confirmed source copies, preserve same-name collections and exclude drafts and other scopes', async () => {
  const db = createSourceDatabase(new IDBFactory()); let time = 1;
  const config = { connectionId: 'c', ruleId: 'r', root: { nativeId: 'root' }, collectionIds: ['a', 'b', 'missing'] };
  const binding = (id: string, kind: 'folder' | 'bookmark' = 'folder') => ({ nativeId: id, kind, dateAdded: 1, bindingId: id, deviceId: 'device', proof: { kind: 'writeReceipt' as const, id } });
  try {
    await db.transaction(['mounts', 'collections', 'folderReservations', 'representations', 'itemReservations'], 'readwrite', async tx => {
      tx.objectStore('mounts').put({ id: 'mount' }, sourceKey('c', 'r'));
      for (const id of config.collectionIds) {
        tx.objectStore('collections').put({ entity: { title: 'Same name' } }, sourceKey('c', id));
        tx.objectStore('folderReservations').put({ collectionId: id, state: 'confirmed', title: 'Same name', native: binding(id) }, sourceKey('mount', id));
      }
      const rep = (collectionId: string, itemId: string, nativeId: string, state: Representation['state'] = 'active'): Representation => ({ connectionId: 'c', itemId, purpose: 'sourceArchive', sourceCollectionId: collectionId,
        mountId: 'mount', native: { ...binding(nativeId, 'bookmark'), kind: 'bookmark' }, manualRevision: 0, state });
      for (const r of [rep('a', 'post:one', 'shared'), rep('b', 'post:one', 'shared'), rep('missing', 'post:two', 'missing-copy'),
        { ...rep('missing', 'post:existing', 'original-copy'), lastWritten: { parentId: 'original-parent', title: 'Original post', url: 'https://posts.test/one' } },
        rep('a', 'post:changed', 'changed', 'detached'), rep('a', 'post:deleted', 'deleted', 'suppressed'),
        { ...rep('a', 'post:other', 'other'), mountId: 'other-mount' }, { ...rep('a', 'post:semantic', 'semantic'), purpose: 'semantic' as const }])
        tx.objectStore('representations').put(r, representationKey(r));
      tx.objectStore('itemReservations').put({ state: 'reserved', representation: rep('a', 'post:draft', 'draft') }, 'draft');
    });
    const overview = createSourceOverview(db, async id => id === 'missing' ? null : ({ title: 'Local name', dateAdded: 1 }), () => time);
    const result = await overview(config);
    expect(result.saved).toBe(2);
    expect(result.collections).toMatchObject([
      { id: 'a', title: 'Same name', destinationTitle: 'Local name', saved: 1, changed: 1, keptDeleted: 1 },
      { id: 'b', title: 'Same name', saved: 1 }, { id: 'missing', folder: 'missing', saved: 1, changed: 1, destinationId: null,
        preservedLocation: { folders: 1, firstId: 'original-parent', firstTitle: 'Local name' } },
    ]);
    const pending = await overview(config, { id: 'new-task', saved: 2, finished: false });
    expect(pending.pendingWrites).toBe(true);
    const finished = await overview(config, { id: 'new-task', saved: 2, finished: true });
    expect(finished.pendingWrites).not.toBe(true);
    expect(finished.checkpoint?.saved).toBe(2);
    time += 3000;
    await db.transaction(['representations'], 'readwrite', async tx => { tx.objectStore('representations').clear(); });
    expect((await overview(config)).saved).toBe(0);
  } finally { await db.close(); }
});
