import { IDBFactory } from 'fake-indexeddb';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';

export const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://example.com',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
export const bar: MappingInput = { nativeId: '1', colpId: 'bar', rootNativeId: '1', nodeKind: 'folder',
  projection: { revision: 'r1', digest: 'root', childrenRevision: 'cr1', content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } } };
export async function setup() {
  const factory = new IDBFactory(); const store = createSyncStateStore({ indexedDB: factory });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.parse('2099-01-01') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [], rootStatus: 'ready' });
  return { ...store, factory };
}
export function child(title: string, url: string): MappingInput {
  return { nativeId: 'recovery:child', colpId: 'child', rootNativeId: '1', nodeKind: 'bookmark', parentColpId: 'bar',
    projection: { revision: 'r1', digest: 'child', content: { title, url } } };
}
