import { leftoverVirtualChildrenNeedReproject } from '../src/recovery-guard.js';
import { projectVirtualSnapshotChildren } from '../src/recovery-projection-executor.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

// Independent acceptance: assertions describe required behavior, not the observed defects.
installKns05IndexedDb();

async function fixture(crash?: string, source: 'active' | 'detached' = 'active', dest: 'active' | 'detached' | 'pending' = 'active') {
  const f = await setup(crash);
  await f.store.setFirstRun(scope, 'completed');
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: false, status: source, rootRole: 'bookmarks-bar' });
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other', remoteMountNodeId: 'other-colp',
    boundaryVersion: '1', materialized: false, status: dest, rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other', nodeKind: 'folder',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other', content: { title: 'Other' } } });
  f.api.seed({ id: 'native-other', title: 'Other' });
  await f.store.deleteMapping(scope, 'native-child'); await f.api.remove('native-child'); f.api.calls.length = 0;
  return f;
}

test('IA-01: content events after range exit remain processable', async () => {
  const f = await fixture(undefined, 'active', 'detached');
  const move = pullFixtures.mutationEvent({ kind: 'move', sequence: 71, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await f.applier.stage(f.page([move], 'cursor-move')); await f.applier.resume();
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
  const update = pullFixtures.mutationEvent({ kind: 'update', sequence: 72, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await f.applier.stage(f.page([update], 'cursor-update')); await f.applier.resume();
  assert.equal((await f.store.getRemoteObservation(scope, 'node-1'))?.payload.title, 'Remote update');
  assert.equal((await f.api.get('native-node'))[0]?.title, 'node-1');
});

test('descendant content events after folder range-exit remain processable', async () => {
  const f = await fixture(undefined, 'active', 'detached');
  await f.store.putMapping(scope, { nativeId: 'native-node', colpId: 'node-1', rootNativeId: 'native-root',
    nodeKind: 'folder', parentNativeId: 'native-root', parentColpId: 'root-colp',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'sha256:node-1',
      content: { title: 'node-1' } } });
  await f.store.putMapping(scope, { nativeId: 'native-child', colpId: 'node-child', rootNativeId: 'native-root',
    nodeKind: 'folder', parentNativeId: 'native-node', parentColpId: 'node-1',
    projection: { revision: 'revision-old', digest: 'sha256:node-child', content: { title: 'node-child' } } });
  await f.store.putMapping(scope, { nativeId: 'native-grand', colpId: 'node-grand', rootNativeId: 'native-root',
    nodeKind: 'bookmark', parentNativeId: 'native-child', parentColpId: 'node-child',
    projection: { revision: 'revision-old', digest: 'sha256:node-grand',
      content: { title: 'grand', url: 'https://example.test/grand' } } });
  f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1' });
  f.api.seed({ id: 'native-child', parentId: 'native-node', index: 0, title: 'node-child' });
  f.api.seed({ id: 'native-grand', parentId: 'native-child', index: 0, title: 'grand',
    url: 'https://example.test/grand' });
  const move = pullFixtures.mutationEvent({ kind: 'move', sequence: 82, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp', targetKind: 'folder' });
  await f.applier.stage(f.page([move], 'cursor-move')); await f.applier.resume();
  const update = pullFixtures.mutationEvent({ kind: 'update', sequence: 83, collectionId: scope.collectionId,
    targetId: 'node-child', parentId: 'node-1', targetKind: 'folder' });
  await f.applier.stage(f.page([update], 'cursor-update')); await f.applier.resume();
  assert.notEqual((await f.store.getScope(scope))?.lifecycle, 'recovery_required');
  assert.equal((await f.api.get('native-child'))[0]?.title, 'node-child');
  assert.equal((await f.store.getRemoteObservation(scope, 'node-child'))?.payload.title, 'Remote update');
});

test('IA-02: a node previously unmounted materializes when moved into an active mount', async () => {
  const f = await fixture();
  await f.store.putMapping(scope, { nativeId: 'unmounted:foreign-node', colpId: 'foreign-node', rootNativeId: 'unmounted:foreign-parent',
    nodeKind: 'bookmark', parentColpId: 'foreign-parent',
    projection: { revision: 'revision-old', digest: 'd-foreign', content: { title: 'Remote', url: 'https://example.test/' } } });
  const move = pullFixtures.mutationEvent({ kind: 'move', sequence: 73, collectionId: scope.collectionId,
    targetId: 'foreign-node', parentId: 'other-colp' });
  await f.applier.stage(f.page([move])); await f.applier.resume();
  const mapping = await f.store.getMappingByColpId(scope, 'foreign-node');
  assert.equal((await f.api.getChildren('native-other')).filter(n => n.url === 'https://example.test/').length, 1);
  assert.ok(mapping?.nativeId);
});

test('IA-03: awaiting a pending destination cannot commit the Move cursor', async () => {
  const f = await fixture(undefined, 'active', 'pending');
  const move = pullFixtures.mutationEvent({ kind: 'move', sequence: 74, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await assert.rejects(async () => {
    await f.applier.stage(f.page([move]));
    await f.applier.resume();
  }, /range_dependency_pending/);
  assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-next');
  const mount = (await f.store.getMountBinding(scope, 'mount-other'))!;
  const { scopeKey: _key, ...binding } = mount;
  await f.store.putMountBinding(scope, { ...binding, status: 'active' });
  await f.applier.stage(f.page([move]));
  await f.applier.resume();
  assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-next');
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-other');
});


test('range-exit sidecars never become background native projection work', async () => {
  const f = await fixture(undefined, 'active', 'detached');
  const move = pullFixtures.mutationEvent({ kind: 'move', sequence: 81, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await f.applier.stage(f.page([move])); await f.applier.resume();
  assert.equal(await leftoverVirtualChildrenNeedReproject(f.store, scope), false);
  await projectVirtualSnapshotChildren({ store: f.store, scope, api: f.api, bound: await f.store.listMappings(scope) });
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
  assert.equal((await f.api.getChildren('native-other')).length, 0);
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
});
