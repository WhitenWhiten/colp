import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { extractOutstandingTarget } from '../src/recovery-overlay.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { installKns05IndexedDb, mountBar, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

function recThenRestore(input: {
  readonly recSequence: number; readonly mountParentId: string; readonly targetId: string; readonly title: string;
}) {
  const rec = pullFixtures.createEvent({
    kind: 'Folder', sequence: input.recSequence, collectionId: scope.collectionId,
    parentId: input.mountParentId, folderRole: 'recovered',
  });
  const restore = pullFixtures.restoreEvent({
    sequence: input.recSequence + 1, collectionId: scope.collectionId, targetId: input.targetId,
    parentId: `node-created-${input.recSequence}`, title: input.title,
  });
  return { rec, restore, recoveredId: `node-created-${input.recSequence}` };
}

describe('T-05 Recovered Pull authority (SRG-01)', () => {
  test('R-01: Pull consumer applies Rec then X without a ghost parent', async () => {
    const fixture = await setup();
    await mountBar(fixture, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
    const { rec, restore, recoveredId } = recThenRestore({
      recSequence: 40, mountParentId: 'root-colp', targetId: 'orphan-x', title: 'Restored X',
    });
    await fixture.applier.stage(fixture.page([rec, restore], 'cursor-restore'));
    await fixture.applier.resume();
    const recovered = (await fixture.api.getChildren('native-root')).find((node) => node.title === 'Recovered');
    const restored = await fixture.store.getMappingByColpId(scope, 'orphan-x');
    assert.ok(recovered);
    assert.equal((await fixture.store.getMappingByColpId(scope, recoveredId))?.nativeId, recovered.id);
    assert.equal(restored?.parentNativeId, recovered.id);
    assert.equal((await fixture.api.get(restored?.nativeId ?? ''))[0]?.parentId, recovered.id);
    assert.equal((await fixture.api.get(restored?.nativeId ?? ''))[0]?.title, 'Restored X');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 2);
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'active');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, undefined);
  });

  test('R-02: Rec then X on one page', async () => {
    const same = await setup();
    await mountBar(same, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
    const first = recThenRestore({
      recSequence: 50, mountParentId: 'root-colp', targetId: 'same-page-x', title: 'Same page X',
    });
    await same.applier.stage(same.page([first.rec, first.restore], 'cursor-same'));
    await same.applier.resume();
    assert.equal((await same.store.getMappingByColpId(scope, 'same-page-x'))?.parentNativeId,
      (await same.store.getMappingByColpId(scope, first.recoveredId))?.nativeId);
  });

  test('R-02: Rec then X with limit=1 paging', async () => {
    const paged = await setup();
    await mountBar(paged, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
    const second = recThenRestore({
      recSequence: 60, mountParentId: 'root-colp', targetId: 'paged-x', title: 'Paged X',
    });
    await paged.applier.stage(paged.page([second.rec], 'cursor-rec'));
    await paged.applier.resume();
    assert.ok((await paged.store.getMappingByColpId(scope, second.recoveredId))?.nativeId);
    await paged.applier.stage(paged.page([second.restore], 'cursor-restore'));
    await paged.applier.resume();
    const recovered = await paged.store.getMappingByColpId(scope, second.recoveredId);
    assert.equal((await paged.store.getMappingByColpId(scope, 'paged-x'))?.parentNativeId, recovered?.nativeId);
    assert.equal((await paged.store.exportScope(scope)).cursor?.cursor, 'cursor-restore');
  });

  test('R-06: custom mount materializes Rec', async () => {
    const custom = await setup();
    custom.api.seed({ id: 'native-custom', title: 'Custom' });
    await custom.store.putMountBinding(scope, {
      mountId: 'mount-custom', nativeRootId: 'native-custom', remoteMountNodeId: 'custom-colp',
      boundaryVersion: '1', materialized: false, status: 'active', customSourceKey: 'folder:custom',
    });
    await custom.store.putMapping(scope, {
      nativeId: 'native-custom', colpId: 'custom-colp', rootNativeId: 'native-custom', nodeKind: 'folder',
      mountId: 'mount-custom', rootRole: 'custom',
      projection: { revision: 'r-custom', digest: 'd-custom', content: { title: 'Custom', folderRole: 'custom' } },
    });
    const { rec, restore } = recThenRestore({
      recSequence: 70, mountParentId: 'custom-colp', targetId: 'custom-orphan', title: 'Custom orphan',
    });
    await custom.applier.stage(custom.page([rec, restore]));
    await custom.applier.resume();
    const recovered = (await custom.api.getChildren('native-custom')).find((node) => node.title === 'Recovered');
    assert.ok(recovered);
    assert.equal((await custom.store.getMappingByColpId(scope, 'custom-orphan'))?.parentNativeId, recovered.id);
    assert.equal((await custom.api.getChildren('native-root')).some((node) => node.title === 'Recovered'), false);
  });

  test('R-06: collection-root Rec does not guess bar', async () => {
    const barOnly = await setup();
    barOnly.api.seed({ id: 'native-bar', title: 'Bar' });
    await barOnly.store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'native-bar', remoteMountNodeId: 'bar-colp',
      boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    await barOnly.store.putMapping(scope, {
      nativeId: 'native-bar', colpId: 'bar-colp', rootNativeId: 'native-bar', nodeKind: 'folder',
      mountId: 'mount-bar', rootRole: 'bookmarks-bar',
      projection: { revision: 'r-bar', childrenRevision: 'c-bar', digest: 'd-bar',
        content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
    });
    await barOnly.store.putMapping(scope, {
      nativeId: 'recovery:collection-root', colpId: 'collection-root', rootNativeId: 'native-bar', nodeKind: 'folder',
      projection: { revision: 'r-root', digest: 'd-root', content: { title: '', folderRole: 'root' } },
    });
    await barOnly.applier.stage(barOnly.page([pullFixtures.createEvent({
      kind: 'Folder', sequence: 71, collectionId: scope.collectionId, parentId: 'collection-root', folderRole: 'recovered',
    })]));
    await barOnly.applier.resume();
    assert.equal((await barOnly.api.getChildren('native-bar')).some((node) => node.title === 'Recovered'), false);
    assert.equal((await barOnly.store.getMappingByColpId(scope, 'node-created-71'))?.nativeId, 'unmounted:node-created-71');
  });

  test('unknown parent waits for authority and does not Ack skip_unmounted or guess bar', async () => {
    const fixture = await setup();
    await mountBar(fixture, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
    const restore = pullFixtures.restoreEvent({
      sequence: 80, collectionId: scope.collectionId, targetId: 'ghost-node', parentId: 'missing-parent',
    });
    await assert.rejects(() => fixture.applier.stage(fixture.page([restore])), /need_authority/);
    assert.equal((await fixture.api.getChildren('native-root')).some((node) => node.title === 'Recovered'), false);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'ghost-node'), null);
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'recovery_required');
    assert.equal((await fixture.store.exportScope(scope)).pullPages.length, 0);
  });

  test('R-01 overlay protects pending restore_node.targetId', () => {
    const target = extractOutstandingTarget({
      opId: 'op-restore', status: 'pending',
      payload: { type: 'restore_node', targetId: 'node-keep' },
    });
    assert.deepEqual(target, { opId: 'op-restore', type: 'restore_node', colpIds: ['node-keep'] });
  });
});
