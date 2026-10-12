import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { mergeRemoteObservation, observationPauseBinding } from '../src/sync-state/remote-observation.js';
import type { RemoteObservationRecord } from '../src/sync-state-store.js';

installKns05IndexedDb();

function observation(kind: RemoteObservationRecord['kind'], payload: RemoteObservationRecord['payload'],
  extra: Partial<RemoteObservationRecord> = {}): RemoteObservationRecord {
  return { scopeKey: 's', colpId: 'node-1', remoteRevision: 'r2', cursor: 'c2', kind, payload,
    sourceDigest: 'digest', observedAt: 1, ...extra };
}

async function detachedFixture() {
  const f = await setup();
  await f.store.setFirstRun(scope, 'completed');
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other', remoteMountNodeId: 'other-colp',
    boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other', nodeKind: 'folder',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other', content: { title: 'Other' } } });
  f.api.seed({ id: 'native-other', title: 'Other' });
  await f.store.deleteMapping(scope, 'native-child'); await f.api.remove('native-child'); f.api.calls.length = 0;
  await detachScopeMount(f.store, scope, 'mount-bar');
  return f;
}

function rejoinChrome(f: Awaited<ReturnType<typeof setup>>, removed: string[] = []) {
  return {
    getNative: async (id: string) => (await f.api.get(id))[0],
    getChildren: (id: string) => f.api.getChildren(id),
    updateNative: async (id: string, changes: { title?: string; url?: string }) => f.api.update(id, changes),
    removeNative: async (id: string, tree: boolean) => {
      removed.push(id);
      return tree ? f.api.removeTree(id) : f.api.remove(id);
    },
  };
}

test('mergeRemoteObservation drops a superseded tombstone deleted flag on live kinds', () => {
  const tombstone = observation('tombstone', { deleted: true, parentId: 'root-colp' });
  const content = mergeRemoteObservation(tombstone, observation('content', { title: 'Restored', url: 'https://example.test/' }));
  assert.equal(content.kind, 'content');
  assert.equal(content.payload.deleted, undefined);
  assert.equal(content.payload.title, 'Restored');
  assert.equal(content.payload.parentId, 'root-colp');
  const placement = mergeRemoteObservation(tombstone, observation('placement', { parentId: 'dest-colp' }));
  assert.equal(placement.kind, 'placement');
  assert.equal(placement.payload.deleted, undefined);
  assert.equal(placement.payload.parentId, 'dest-colp');
  const again = mergeRemoteObservation(content, observation('tombstone', { deleted: true }, { remoteRevision: 'r3' }));
  assert.equal(again.kind, 'tombstone');
  assert.equal(again.payload.deleted, true);
  assert.equal(again.payload.title, 'Restored');
});

test('detached tombstone then node_restored stores a live observation for that colpId', async () => {
  const f = await detachedFixture();
  await f.applier.stage(f.page([f.mutationEvent('delete')])); await f.applier.resume();
  assert.equal((await f.store.getRemoteObservation(scope, 'node-1'))?.kind, 'tombstone');
  assert.equal((await f.store.getRemoteObservation(scope, 'node-1'))?.payload.deleted, true);
  const restore = pullFixtures.restoreEvent({ sequence: 40, collectionId: scope.collectionId, targetId: 'node-1',
    parentId: 'root-colp' });
  await f.applier.stage(f.page([restore], 'cursor-restore')); await f.applier.resume();
  const stored = await f.store.getRemoteObservation(scope, 'node-1');
  assert.notEqual(stored?.kind, 'tombstone');
  assert.equal(stored?.payload.deleted === true, false);
  assert.equal(stored?.colpId, 'node-1');
});

test('rejoin sync policy does not removeNative for a restored node after a stale tombstone', async () => {
  const f = await detachedFixture();
  await f.applier.stage(f.page([f.mutationEvent('delete')])); await f.applier.resume();
  const restore = pullFixtures.restoreEvent({ sequence: 41, collectionId: scope.collectionId, targetId: 'node-1',
    parentId: 'root-colp' });
  await f.applier.stage(f.page([restore], 'cursor-restore')); await f.applier.resume();
  const mapping = await f.store.getMappingByColpId(scope, 'node-1');
  assert.ok(mapping?.nativeId);
  const removed: string[] = [];
  await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', mapping.nativeId]), [], rejoinChrome(f, removed));
  assert.equal(removed.includes(mapping.nativeId), false);
  assert.equal((await f.api.get(mapping.nativeId)).length, 1);
});

test('rejoin sync policy still removes a copy whose current observation is a tombstone', async () => {
  const f = await detachedFixture();
  await f.applier.stage(f.page([f.mutationEvent('delete')])); await f.applier.resume();
  const removed: string[] = [];
  await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node']), [], rejoinChrome(f, removed));
  assert.equal(removed.includes('native-node'), true);
  // A-11: the honest `get` rejects the removed id; absence is read from the fixture view.
  assert.equal(f.api.getNode('native-node'), undefined);
});

test('rejoin does not delete a tombstoned folder with a protected local-edit descendant', async () => {
  const f = await detachedFixture();
  await f.store.putMapping(scope, { nativeId: 'native-node', colpId: 'node-1', rootNativeId: 'native-root',
    parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder',
    projection: { revision: 'r1', childrenRevision: 'c1', digest: 'folder', content: { title: 'Folder' } } });
  await f.store.putMapping(scope, { nativeId: 'child', colpId: 'child-colp', rootNativeId: 'native-root',
    parentNativeId: 'native-node', parentColpId: 'node-1', nodeKind: 'bookmark',
    projection: { revision: 'r1', digest: 'child', content: { title: 'Child', url: 'https://example.test/child' } } });
  f.api.seed({ id: 'native-node', parentId: 'native-root', title: 'Folder' });
  f.api.seed({ id: 'child', parentId: 'native-node', title: 'Child', url: 'https://example.test/child' });
  await f.api.update('child', { title: 'Local edit' });
  const pause = observationPauseBinding((await f.store.getMountBinding(scope, 'mount-bar'))?.pauseBaseline);
  for (const colpId of ['node-1', 'child-colp']) await f.store.putRemoteObservation(scope, {
    colpId, remoteRevision: 'deleted-r2', cursor: 'c2', kind: 'tombstone', payload: { deleted: true },
    sourceDigest: 'deleted', observedAt: Date.now(), ...pause,
  });
  const removed: string[] = [];
  const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node', 'child']), [],
    rejoinChrome(f, removed));
  assert.equal(removed.length, 0);
  assert.equal(result.mount.status, 'detached');
  assert.equal((await f.api.get('native-node')).length, 1);
  assert.equal((await f.api.get('child'))[0]?.title, 'Local edit');
});

test.each(['keep_local', 'confirm', 'localEdited'] as const)(
  'rejoin %s does not force-delete a tombstoned copy',
  async (mode) => {
    const f = await detachedFixture();
    await f.applier.stage(f.page([f.mutationEvent('delete')])); await f.applier.resume();
    assert.equal((await f.store.getRemoteObservation(scope, 'node-1'))?.kind, 'tombstone');
    if (mode === 'keep_local' || mode === 'confirm') {
      await f.store.setRemoteDeletePolicy(scope, { policy: mode, expectedCasVersion: 0, now: 1 });
    } else {
      await f.api.update('native-node', { title: 'Local edit' });
    }
    const removed: string[] = [];
    const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node']), [],
      rejoinChrome(f, removed));
    assert.equal(removed.includes('native-node'), false);
    assert.equal((await f.api.get('native-node')).length, 1);
    if (mode === 'keep_local') {
      assert.ok(await f.store.getLocalSyncExclusion(scope, 'native-node'));
    } else {
      assert.equal(result.mount.status, 'detached');
    }
  },
);
