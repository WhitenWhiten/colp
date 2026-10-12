import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

async function dualMounts(f: Awaited<ReturnType<typeof setup>>) {
  f.api.seed({ id: 'native-bar', title: 'Bar' });
  f.api.seed({ id: 'native-other', title: 'Other' });
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-bar',
    remoteMountNodeId: 'bar-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other',
    remoteMountNodeId: 'other-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-bar', colpId: 'bar-colp', rootNativeId: 'native-bar',
    nodeKind: 'folder', mountId: 'mount-bar', rootRole: 'bookmarks-bar',
    projection: { revision: 'r-bar', childrenRevision: 'c-bar', digest: 'd-bar',
      content: { title: 'Bar', folderRole: 'bookmarks-bar' } } });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
    nodeKind: 'folder', mountId: 'mount-other', rootRole: 'other-bookmarks',
    projection: { revision: 'r-other', childrenRevision: 'c-other', digest: 'd-other',
      content: { title: 'Other', folderRole: 'other-bookmarks' } } });
}

test('FRR-05-A: restores materialize Recovered under each original mount', async () => {
  const f = await setup(); await dualMounts(f);
  await f.applier.stage(f.page([
    pullFixtures.createEvent({ kind: 'Folder', sequence: 81, collectionId: scope.collectionId,
      parentId: 'bar-colp', folderRole: 'recovered' }),
    pullFixtures.restoreEvent({ sequence: 82, collectionId: scope.collectionId, targetId: 'orphan-bar',
      parentId: 'node-created-81', title: 'Bar orphan' }),
    pullFixtures.createEvent({ kind: 'Folder', sequence: 83, collectionId: scope.collectionId,
      parentId: 'other-colp', folderRole: 'recovered' }),
    pullFixtures.restoreEvent({ sequence: 84, collectionId: scope.collectionId, targetId: 'orphan-other',
      parentId: 'node-created-83', title: 'Other orphan' }),
  ]));
  await f.applier.resume();
  const barRecovered = (await f.api.getChildren('native-bar')).find((node) => node.title === 'Recovered');
  const otherRecovered = (await f.api.getChildren('native-other')).find((node) => node.title === 'Recovered');
  assert.ok(barRecovered);
  assert.ok(otherRecovered);
  assert.notEqual(barRecovered.id, otherRecovered.id);
  assert.equal((await f.store.getMappingByColpId(scope, 'orphan-bar'))?.parentNativeId, barRecovered.id);
  assert.equal((await f.store.getMappingByColpId(scope, 'orphan-other'))?.parentNativeId, otherRecovered.id);
  assert.equal((await f.api.getChildren('native-bar')).some((node) => node.title === 'Other orphan'), false);
  assert.equal((await f.store.exportScope(scope)).scope?.lifecycle, 'active');
});

test('FRR-05-B: does not guess bookmarks-bar when the owning mount is unconfirmed', async () => {
  const f = await setup(); await dualMounts(f);
  const restore = pullFixtures.restoreEvent({ sequence: 85, collectionId: scope.collectionId,
    targetId: 'unknown-orphan', parentId: 'unknown-parent', title: 'Unknown orphan' });
  await assert.rejects(() => f.applier.stage(f.page([restore])), /need_authority/);
  assert.equal((await f.api.getChildren('native-bar')).some((node) => node.title === 'Recovered'), false);
  assert.equal((await f.api.getChildren('native-other')).some((node) => node.title === 'Recovered'), false);
  assert.equal(await f.store.getMappingByColpId(scope, 'unknown-orphan'), null);
  assert.equal(f.api.calls.filter((call) => call.kind === 'create').length, 0);
});

test('FRR-05-B: a single local mount still skips Recovered when the owning mount is unconfirmed', async () => {
  const f = await setup();
  f.api.seed({ id: 'native-bar', title: 'Bar' });
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-bar',
    remoteMountNodeId: 'bar-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  await f.store.putMapping(scope, { nativeId: 'native-bar', colpId: 'bar-colp', rootNativeId: 'native-bar',
    nodeKind: 'folder', mountId: 'mount-bar', rootRole: 'bookmarks-bar',
    projection: { revision: 'r-bar', childrenRevision: 'c-bar', digest: 'd-bar',
      content: { title: 'Bar', folderRole: 'bookmarks-bar' } } });
  const restore = pullFixtures.restoreEvent({ sequence: 86, collectionId: scope.collectionId,
    targetId: 'bar-only-orphan', parentId: 'unknown-parent', title: 'Unknown orphan' });
  await assert.rejects(() => f.applier.stage(f.page([restore])), /need_authority/);
  assert.equal((await f.api.getChildren('native-bar')).some((node) => node.title === 'Recovered'), false);
  assert.equal((await f.api.getChildren('native-root')).some((node) => node.title === 'Recovered'), false);
  assert.equal(await f.store.getMappingByColpId(scope, 'bar-only-orphan'), null);
  assert.equal(f.api.calls.filter((call) => call.kind === 'create').length, 0);
});

test('FRR-05-B: recovered create under Collection root does not guess the only local mount', async () => {
  const f = await setup();
  f.api.seed({ id: 'native-bar', title: 'Bar' });
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-bar',
    remoteMountNodeId: 'bar-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  await f.store.putMapping(scope, { nativeId: 'native-bar', colpId: 'bar-colp', rootNativeId: 'native-bar',
    nodeKind: 'folder', mountId: 'mount-bar', rootRole: 'bookmarks-bar',
    projection: { revision: 'r-bar', childrenRevision: 'c-bar', digest: 'd-bar',
      content: { title: 'Bar', folderRole: 'bookmarks-bar' } } });
  await f.store.putMapping(scope, { nativeId: 'recovery:collection-root', colpId: 'collection-root',
    rootNativeId: 'native-bar', nodeKind: 'folder',
    projection: { revision: 'r-root', digest: 'd-root', content: { title: '', folderRole: 'root' } } });
  await f.applier.stage(f.page([pullFixtures.createEvent({ kind: 'Folder', sequence: 87,
    collectionId: scope.collectionId, parentId: 'collection-root', folderRole: 'recovered' })]));
  await f.applier.resume();
  assert.equal((await f.api.getChildren('native-bar')).some((node) => node.title === 'Recovered'), false);
  assert.equal((await f.store.getMappingByColpId(scope, 'node-created-87'))?.nativeId, 'unmounted:node-created-87');
  assert.equal(f.api.calls.filter((call) => call.kind === 'create').length, 0);
});

test('FRR-05-C: a custom mount gets its own Recovered folder', async () => {
  const f = await setup();
  f.api.seed({ id: 'native-custom', title: 'Custom' });
  await f.store.putMountBinding(scope, { mountId: 'mount-custom', nativeRootId: 'native-custom',
    remoteMountNodeId: 'custom-colp', boundaryVersion: '1', materialized: false, status: 'active',
    customSourceKey: 'folder:custom' });
  await f.store.putMapping(scope, { nativeId: 'native-custom', colpId: 'custom-colp', rootNativeId: 'native-custom',
    nodeKind: 'folder', mountId: 'mount-custom', rootRole: 'custom',
    projection: { revision: 'r-custom', digest: 'd-custom', content: { title: 'Custom', folderRole: 'custom' } } });
  await f.applier.stage(f.page([
    pullFixtures.createEvent({ kind: 'Folder', sequence: 88, collectionId: scope.collectionId,
      parentId: 'custom-colp', folderRole: 'recovered' }),
    pullFixtures.restoreEvent({ sequence: 89, collectionId: scope.collectionId,
      targetId: 'orphan-custom', parentId: 'node-created-88', title: 'Custom orphan' }),
  ]));
  await f.applier.resume();
  const recovered = (await f.api.getChildren('native-custom')).find((node) => node.title === 'Recovered');
  assert.ok(recovered);
  assert.equal((await f.store.getMappingByColpId(scope, 'orphan-custom'))?.parentNativeId, recovered.id);
  assert.equal((await f.api.getChildren('native-root')).some((node) => node.title === 'Recovered'), false);
});

test('FRR-05: restore for parent A does not rebind parent B recovered on the same mount', async () => {
  const f = await setup(); await dualMounts(f);
  // Native ids sort B before A so an unfiltered mount scan would steal B.
  f.api.seed({ id: 'b-rec', parentId: 'native-bar', title: 'Recovered' });
  f.api.seed({ id: 'z-rec', parentId: 'native-bar', title: 'Recovered' });
  await f.store.putMapping(scope, { nativeId: 'b-rec', colpId: 'rec-b', rootNativeId: 'native-bar',
    nodeKind: 'folder', parentNativeId: 'native-bar', parentColpId: 'parent-b', mountId: 'mount-bar',
    projection: { revision: 'r-rec-b', digest: 'd-rec-b', content: { title: 'Recovered', folderRole: 'recovered' } } });
  await f.store.putMapping(scope, { nativeId: 'z-rec', colpId: 'rec-a', rootNativeId: 'native-bar',
    nodeKind: 'folder', parentNativeId: 'native-bar', parentColpId: 'parent-a', mountId: 'mount-bar',
    projection: { revision: 'r-rec-a', digest: 'd-rec-a', content: { title: 'Recovered', folderRole: 'recovered' } } });
  await f.applier.stage(f.page([pullFixtures.restoreEvent({ sequence: 90, collectionId: scope.collectionId,
    targetId: 'orphan-a', parentId: 'rec-a', title: 'A orphan' })]));
  await f.applier.resume();
  assert.equal((await f.store.getMappingByColpId(scope, 'rec-b'))?.nativeId, 'b-rec');
  assert.equal((await f.store.getMappingByNativeId(scope, 'b-rec'))?.colpId, 'rec-b');
  assert.equal((await f.store.getMappingByNativeId(scope, 'b-rec'))?.parentColpId, 'parent-b');
  assert.equal((await f.store.getMappingByColpId(scope, 'rec-a'))?.nativeId, 'z-rec');
  assert.equal((await f.store.getMappingByColpId(scope, 'orphan-a'))?.parentNativeId, 'z-rec');
  assert.equal((await f.api.getChildren('z-rec')).some((node) => node.title === 'A orphan'), true);
  assert.equal((await f.api.getChildren('b-rec')).some((node) => node.title === 'A orphan'), false);
  assert.equal((await f.api.getChildren('native-bar')).filter((node) => node.title === 'Recovered').length, 2);
  assert.equal(f.api.calls.filter((call) => call.kind === 'create').length, 1);
});
