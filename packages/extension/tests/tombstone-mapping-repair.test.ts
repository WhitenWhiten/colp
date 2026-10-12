import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { repairTombstonedNativeMappings } from '../src/tombstone-mapping-repair.js';
import { scope } from './bookmark-event-queue-harness.js';

async function setup() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10000 },
    checkpoint: null, selectedRoots: [], rootStatus: 'ready' });
  await store.putMapping(scope, { nativeId: 'native', colpId: 'node', rootNativeId: 'root', nodeKind: 'folder',
    parentNativeId: 'root', parentColpId: 'remote-root', projection: { revision: 'r1', digest: 'd', content: { title: 'Folder' } } });
  await store.putRemoteObservation(scope, { colpId: 'node', remoteRevision: 'deleted', cursor: 'c1',
    kind: 'tombstone', payload: { deleted: true }, sourceDigest: 'd', observedAt: 1 });
  return store;
}
const exclusion = { nativeId: 'native', decisionId: 'keep', rootNativeId: 'root', generation: scope.generation,
  sourceKind: 'remote_delete' as const, priorColpId: 'node' };

test.each(['gone', 'keep_local', 'legacy_keep_local'])('tombstone repair completes and remains repeatable (%s)', async kind => {
  const store = await setup();
  if (kind === 'legacy_keep_local') await store.putLocalSyncExclusion(scope, exclusion);
  const api = { get: async () => {
    if (kind === 'gone') throw new Error("Can't find bookmark for id. native");
    return [{ id: 'native', title: 'Folder' }];
  }, getChildren: async () => [{ id: 'unmapped-child', parentId: 'native', title: 'Child' }] };
  await repairTombstonedNativeMappings(store, scope, api as never);
  assert.equal(await store.getMappingByNativeId(scope, 'native'), null);
  const mapping = await store.getMappingByColpId(scope, 'node');
  assert.equal(mapping?.nativeId, 'unmounted:node');
  assert.equal(mapping?.parentNativeId, 'unmounted:remote-root');
  assert.equal(Boolean(await store.getLocalSyncExclusion(scope, 'native')), kind !== 'gone');
  await repairTombstonedNativeMappings(store, scope, api as never);
  store.close();
});

test('a placeholder collision rolls back the mapping transition and exclusion together', async () => {
  const store = await setup();
  await store.putMapping(scope, { nativeId: 'unmounted:node', colpId: 'different-node', rootNativeId: 'root',
    projection: { revision: 'r1', digest: 'd' } });
  await assert.rejects(() => store.commitTombstoneMappingRepair(scope, { nativeId: 'native', colpId: 'node', exclusion }), /constraint/);
  assert.ok(await store.getMappingByNativeId(scope, 'native'));
  assert.equal(await store.getLocalSyncExclusion(scope, 'native'), null);
  store.close();
});

test('a replaced tombstone cannot unmount a live authoritative mapping', async () => {
  const store = await setup();
  await store.deleteRemoteObservations(scope, ['node']);
  assert.equal(await store.commitTombstoneMappingRepair(scope, { nativeId: 'native', colpId: 'node', exclusion }), false);
  assert.ok(await store.getMappingByNativeId(scope, 'native'));
  assert.equal(await store.getLocalSyncExclusion(scope, 'native'), null);
  store.close();
});
