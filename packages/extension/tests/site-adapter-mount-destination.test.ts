import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase, sourceKey, type SourceStore } from '../src/site-adapters/source-db.js';
import { createSourceLayout, type LayoutPorts } from '../src/site-adapters/layout.js';
import { initializeMountDestination } from '../src/site-adapters/mount-destination.js';

const destination = { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' };
test.each(['folderReservations', 'representations', 'itemReservations', 'savePlans', 'meta', 'outbox'] as const)(
  'an ownerless mapping with retained %s needs explicit confirmation', async store => {
    const db = createSourceDatabase(new IDBFactory());
    const ports: LayoutPorts = { rules: async () => ({ revision: 1, items: [], contentVersions: {}, stopped: null, skippedSources: [], needsAttention: [] }),
      paused: async () => false, deviceId: async () => 'device', lookup: async () => ({ id: 'root', title: 'Root', dateAdded: 10 }), assertRoot: async () => {} };
    const layout = createSourceLayout(db, ports);
    try {
      const mount = await layout.bindRoot('connection', 'rule', 'root');
      const representation = { connectionId: 'connection', itemId: 'video', mountId: mount.id };
      const fixtures: Record<SourceStore, unknown> = {} as Record<SourceStore, unknown>;
      fixtures.folderReservations = { mountId: mount.id, state: 'reserved' };
      fixtures.representations = representation;
      fixtures.itemReservations = { representation };
      fixtures.savePlans = { state: 'draft', plan: { mount: { id: mount.id } } };
      fixtures.meta = { state: 'active', representation };
      fixtures.outbox = { command: { bookmark: { representation } } };
      const key = store === 'folderReservations' ? sourceKey(mount.id, 'saved') : store === 'meta' ? sourceKey('sourcePlanIntent', 'plan') : sourceKey('connection', 'video');
      await db.transaction([store], 'readwrite', async tx => { tx.objectStore(store).put(fixtures[store], key); });
      ports.destination = async () => destination;
      await expect(layout.bindRoot('connection', 'rule', 'root')).rejects.toThrow('sourceDestinationNeedsReview');
      expect((await db.read<any>('mounts', sourceKey('connection', 'rule')))?.destination).toBeUndefined();
    } finally { await db.close(); }
  });
test.each(['detached', 'suppressed'] as const)('initializing owner metadata never reactivates a %s mapping', async state => {
  const db = createSourceDatabase(new IDBFactory());
  const mount = { id: 'mount', connectionId: 'connection', rootRuleId: 'rule', state, revision: 1, aiDestination: 'excluded' as const,
    root: { bindingId: 'root', nativeId: 'root', kind: 'folder' as const, deviceId: 'device', dateAdded: 10, proof: { kind: 'explicitAdoption' as const, id: 'proof' } } };
  try {
    await db.transaction(['mounts'], 'readwrite', async tx => { tx.objectStore('mounts').put(mount, sourceKey('connection', 'rule')); });
    expect(await initializeMountDestination(db, mount, destination)).toEqual(mount);
    expect(await db.read('mounts', sourceKey('connection', 'rule'))).toEqual(mount);
  } finally { await db.close(); }
});
