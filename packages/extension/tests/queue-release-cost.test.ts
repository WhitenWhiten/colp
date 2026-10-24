import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBCursor, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { createQueueRecapture } from '../src/queue-recapture.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { installOutboundPushIndexedDb, setup, scope } from './outbound-push-worker-harness.js';

/**
 * W2A-07: releasing one held change (Retry) read every bookmark event to find the next ordinal, read the whole
 * queue to rebind dependants and rewrote every mapping of the library, in one transaction that also holds the
 * database from capture staging. The next ordinal now comes from the ordinal index, only unsent rows are
 * scanned, and only the mappings that name a replaced identity are written.
 */
installOutboundPushIndexedDb();
afterEach(() => { vi.restoreAllMocks(); });

async function fixture() {
  const f = await setup({ createPlacement: 'bottom' });
  const recorded = (await f.store.getScope(scope))!;
  await f.store.registerScope({ ...recorded, selectedRoots: ['root-push'], rootStatus: 'ready' });
  await f.store.putMountBinding(scope, { mountId: 'mount', nativeRootId: 'native-parent', remoteMountNodeId: 'root-push',
    boundaryVersion: '1', materialized: true, status: 'active', rootRole: 'bookmarks-bar' });
  const api = honestChrome();
  api.seed({ id: 'native-parent', title: 'Root' });
  api.seed({ id: 'native-create', parentId: 'native-parent', title: 'Current title', url: 'https://example.test/current' });
  const capture = createQueueRecapture({ store: f.store, scope, api, permission: async () => true, now: () => 20_000 });
  await f.store.setAsideQueue(scope, [f.queued.sequence], 'recovery_identity_unproven');
  return { ...f, api, capture };
}

test('the next event ordinal follows the highest one even when the counter lags, without reading every event', async () => {
  const f = await fixture();
  try {
    const database = await f.store.open(); const key = (await f.store.getScope(scope))!.scopeKey;
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('bookmark_events', 'readwrite');
      tx.objectStore('bookmark_events').add({ scopeKey: key, eventId: 'event-late', ordinal: 5_000, dedupeKey: 'dedupe-late',
        occurredAt: '2026-07-27T00:00:00Z', kind: 'change', nativeId: 'native-anchor-old', details: {}, status: 'processed', opId: 'op-late' });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    const [row] = await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture);
    const event = (await f.store.listBookmarkEvents(scope, 0, 100)).find(item => item.eventId === `recapture-${row!.opId}`);
    assert.equal(event?.ordinal, 5_001);
    // The counter moved on past it: the next staged event cannot reuse an ordinal.
    const meta = await new Promise<{ next: number }>((resolve, reject) => {
      const request = database.transaction('schema_metadata').objectStore('schema_metadata').get(`bookmark-event-ordinal:${key}`);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    assert.equal(meta.next, 5_002);
  } finally { f.store.close(); }
});

test('only the mapping that names the replaced identity is rewritten, however large the library is', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 120; index += 1) {
      await f.store.putMapping(scope, { nativeId: `bulk-${index}`, colpId: `bulk-node-${index}`, rootNativeId: 'root-native',
        parentNativeId: 'native-parent', parentColpId: 'root-push', nodeKind: 'bookmark',
        projection: { revision: `bulk-r${index}`, digest: `sha256:bulk-${index}`, content: { title: `Bulk ${index}` } } });
    }
    let mappingWrites = 0;
    const put = IDBObjectStore.prototype.put; const update = IDBCursor.prototype.update;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'native_mappings') mappingWrites += 1; return put.apply(this, args);
    });
    vi.spyOn(IDBCursor.prototype, 'update').mockImplementation(function (this: IDBCursor, ...args: Parameters<typeof update>) {
      mappingWrites += 1; return update.apply(this, args);
    });
    const [row] = await f.store.releaseSetAsideQueue(scope, [f.queued.sequence], f.capture);
    assert.equal(mappingWrites, 1, 'one mapping (the provisional one) is rebound, not the whole library');
    assert.equal((await f.store.getMappingByNativeId(scope, 'native-create'))?.colpId, `pending-${row!.opId}`);
    assert.equal((await f.store.getMappingByNativeId(scope, 'bulk-7'))?.colpId, 'bulk-node-7');
  } finally { f.store.close(); }
});
