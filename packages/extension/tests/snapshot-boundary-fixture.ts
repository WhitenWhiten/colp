import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach } from 'vitest';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { fakeChrome } from './recovery-projection-chrome-fixture.js';

export const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://boundary.test',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
export const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

export async function setup(variant = 'current') {
  const indexedDB = new IDBFactory(), store = createSyncStateStore({ indexedDB }); stores.push(store);
  const chrome = fakeChrome([{ id: '1', title: 'Bar' }, { id: '10', parentId: '1', title: 'Selected' }]);
  await store.registerScope({ ...scope, lifecycle: variant === 'stopped' ? 'recovery_required' : 'active',
    lease: { leaseId: 'session-lease', generation: '1', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'initial', cursor: 'initial' },
    selectedRoots: ['chosen'], privateRoots: variant === 'private' ? ['bar'] : [], firstRun: 'completed',
    rootStatus: variant === 'permission' ? 'permission_required' : 'ready' });
  const row = (colpId: string, nativeId: string, parentColpId?: string, folder = false): MappingInput => ({
    colpId, nativeId, rootNativeId: variant !== 'legacy' && ['chosen', 'inside'].includes(colpId) ? '10' : '1',
    ...(parentColpId ? { parentColpId, parentNativeId: parentColpId === 'chosen' ? '10' : '1' } : {}),
    nodeKind: folder ? 'folder' : 'bookmark',
    projection: { revision: `revision-${colpId}`, digest: `digest-${colpId}`,
      content: { title: colpId === 'chosen' ? 'Selected' : colpId, ...(folder ? {} : { url: `https://${colpId}.example/` }) } },
  });
  const rows = [row('bar', '1', undefined, true), row('chosen', '10', 'bar', true),
    row('inside', 'recovery:inside', 'chosen'), row('outside', 'recovery:outside', 'bar')];
  rows[0] = { ...rows[0]!, rootRole: variant === 'managed' ? 'managed-bookmarks' : 'bookmarks-bar' };
  if (variant === 'missing-parent') rows[1] = { ...rows[1]!, parentColpId: 'missing' };
  if (variant === 'cycle') rows[0] = { ...rows[0]!, parentColpId: 'chosen' };
  for (const mapping of rows) await store.putMapping(scope, mapping);
  if (variant !== 'legacy') await store.putMountBinding(scope, { mountId: 'selected-mount', nativeRootId: '10', customSourceKey: 'selected-source',
    remoteMountNodeId: 'chosen', boundaryVersion: '1', status: variant === 'detached' ? 'detached' : variant === 'pending' ? 'pending' : 'active', materialized: false });
  return { indexedDB, store, chrome, rows };
}
