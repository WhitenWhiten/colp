import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, mountBar, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

function trapRemoveTree(api: Awaited<ReturnType<typeof setup>>['api']) {
  const ids: string[] = [];
  const inner = api.removeTree.bind(api);
  api.removeTree = async (id: string) => { ids.push(id); await inner(id); };
  return ids;
}

test('node_deleted of a still-mapped ancestor does not Chrome-delete a range-exit keep-local child', async () => {
  const f = await setup();
  await mountBar(f, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
  await f.store.putMapping(scope, {
    nativeId: 'native-parent', colpId: 'parent-colp', rootNativeId: 'native-root', nodeKind: 'folder',
    parentNativeId: 'native-root', parentColpId: 'root-colp',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'sha256:parent-colp',
      content: { title: 'parent-colp' } },
  });
  await f.store.putMapping(scope, {
    nativeId: 'native-keep', colpId: 'keep-colp', rootNativeId: 'native-root', nodeKind: 'bookmark',
    parentNativeId: 'native-parent', parentColpId: 'parent-colp',
    projection: { revision: 'revision-old', digest: 'sha256:keep-colp',
      content: { title: 'keep-colp', url: 'https://example.test/keep' } },
  });
  await f.store.putLocalSyncExclusion(scope, {
    nativeId: 'native-keep', decisionId: 'rx:keep', rootNativeId: 'native-root',
    generation: 1, sourceKind: 'range_exit', priorColpId: 'keep-colp',
  });
  f.api.seed({ id: 'native-parent', parentId: 'native-root', index: 1, title: 'parent-colp' });
  f.api.seed({ id: 'native-keep', parentId: 'native-parent', index: 0, title: 'keep-colp',
    url: 'https://example.test/keep' });
  const treeIds = trapRemoveTree(f.api);
  const event = pullFixtures.mutationEvent({ kind: 'delete', sequence: 80, collectionId: scope.collectionId,
    targetId: 'parent-colp', parentId: 'root-colp', targetKind: 'folder' });
  await f.applier.stage(f.page([event]));
  await f.applier.resume();
  assert.equal((await f.api.get('native-keep')).length, 1);
  assert.equal((await f.api.get('native-parent')).length, 1);
  assert.equal(treeIds.includes('native-parent'), false);
  assert.equal(f.api.calls.some((call) => call.kind === 'delete' && call.nativeId === 'native-keep'), false);
  assert.equal(await f.store.getMappingByNativeId(scope, 'native-keep') !== null, true);
  assert.equal((await f.store.exportScope(scope)).scope?.lifecycle, 'active');
  assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, undefined);
});

test('subtree_deleted removes remote members but keeps an excluded extra', async () => {
  const f = await setup();
  await mountBar(f, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
  await f.store.putMapping(scope, {
    nativeId: 'native-node', colpId: 'node-1', rootNativeId: 'native-root', nodeKind: 'folder',
    parentNativeId: 'native-root', parentColpId: 'root-colp',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'sha256:node-1',
      content: { title: 'node-1' } },
  });
  await f.store.putLocalSyncExclusion(scope, {
    nativeId: 'native-extra', decisionId: 'rx:extra', rootNativeId: 'native-root',
    generation: 1, sourceKind: 'range_exit',
  });
  f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1' });
  f.api.seed({ id: 'native-extra', parentId: 'native-node', index: 1, title: 'extra',
    url: 'https://example.test/extra' });
  const treeIds = trapRemoveTree(f.api);
  const event = pullFixtures.subtreeEvent({
    sequence: 81, collectionId: scope.collectionId, targetId: 'node-1',
    members: ['node-1', 'node-child'], paged: false,
  });
  await f.applier.stage(f.page([event]));
  await f.applier.resume();
  // A-11: absence is asserted through the fixture view; the honest `get` rejects a removed id.
  assert.equal((await f.api.get('native-extra')).length, 1);
  assert.equal(f.api.getNode('native-child'), undefined);
  assert.equal((await f.api.get('native-node')).length, 1);
  assert.equal(treeIds.includes('native-node'), false);
  assert.equal(f.api.calls.some((call) => call.kind === 'delete' && call.nativeId === 'native-extra'), false);
  assert.equal(f.api.calls.some((call) => call.kind === 'delete' && call.nativeId === 'native-child'), true);
  assert.equal(await f.store.getMappingByNativeId(scope, 'native-child'), null);
  assert.equal((await f.store.exportScope(scope)).scope?.lifecycle, 'active');
  assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, undefined);
});

test('ordinary folder delete with no extras still Chrome-removes the folder', async () => {
  const f = await setup();
  await f.store.putMapping(scope, {
    nativeId: 'native-empty', colpId: 'empty-colp', rootNativeId: 'native-root', nodeKind: 'folder',
    parentNativeId: 'native-root', parentColpId: 'root-colp',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'sha256:empty',
      content: { title: 'empty' } },
  });
  f.api.seed({ id: 'native-empty', parentId: 'native-root', index: 1, title: 'empty' });
  const treeIds = trapRemoveTree(f.api);
  const event = pullFixtures.mutationEvent({ kind: 'delete', sequence: 82, collectionId: scope.collectionId,
    targetId: 'empty-colp', parentId: 'root-colp', targetKind: 'folder' });
  await f.applier.stage(f.page([event]));
  await f.applier.resume();
  // A-11: as above - the removed folder is read back as absent, not as an empty `get`.
  assert.equal(f.api.getNode('native-empty'), undefined);
  assert.equal(treeIds.includes('native-empty'), false);
  assert.equal(f.api.calls.some(call => call.kind === 'delete' && call.nativeId === 'native-empty'), true);
  assert.equal(await f.store.getMappingByNativeId(scope, 'native-empty'), null);
  assert.equal((await f.store.exportScope(scope)).scope?.lifecycle, 'active');
});
