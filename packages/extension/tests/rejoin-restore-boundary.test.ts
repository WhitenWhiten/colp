import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { deletionFixture } from './rejoin-decision-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();
async function boundary(f: Awaited<ReturnType<typeof deletionFixture>>, privateNativeIds: string[], selected = ['native-root']) {
  await f.getStore().configureBrowserRoots(scope, { status: 'ready',
    discovered: [ { nativeId: 'native-root', ancestorNativeIds: [] }, { nativeId: 'native-private', ancestorNativeIds: [] }, { nativeId: 'native-other', ancestorNativeIds: [] } ],
    selectedNativeIds: selected, privateNativeIds });
}

test.each(['after_rejoin_confirmation', 'after_rejoin_restore_preparation'])('privacy change after %s stops replay without native writes or reactivation', async crashAt => {
  const f = await deletionFixture();
  try {
    await f.compare();
    await assert.rejects(f.resolve('keep_remote', { crash: at => { if (at === crashAt) throw new Error('worker_crash'); } }), /worker_crash/);
    const choice = (await f.list())[0]!;
    await boundary(f, ['native-root']); f.reopen(); await f.refresh();
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
    assert.equal((await f.getStore().getScopeCommandPlan(scope, choice.commandId))?.phase, 'failed');
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'detached');
  } finally { f.getStore().close(); }
});

test('a selected native parent moved under an already private ancestor after create intent is rechecked before Chrome', async () => {
  const f = await deletionFixture();
  try {
    f.api.seed({ id: 'native-private', title: 'Private' });
    await f.getStore().putMapping(scope, { nativeId: 'native-private', colpId: 'private-colp', rootNativeId: 'native-private',
      nodeKind: 'folder', projection: { revision: 'private', childrenRevision: 'private', digest: 'private', content: { title: 'Private' } } });
    await boundary(f, ['native-private']);
    await f.compare();
    await f.resolve('keep_remote', { crash: at => {
      if (at === 'after_rejoin_create_intent') f.api.seed({ id: 'native-root', parentId: 'native-private', index: 0, title: 'root-colp' });
    } });
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
    assert.equal((await f.getStore().listScopeCommandPlans(scope)).find(row => row.retryReason === 'rejoin_boundary_changed')?.phase, 'failed');
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'detached');
  } finally { f.getStore().close(); }
});

test.each(['root', 'member'])('mapping loss of the %s after preparation cannot recreate a cleared identity', async lost => {
  const f = await deletionFixture();
  try {
    await f.compare();
    const choice = await f.resolve('keep_remote', { createNative: undefined });
    await f.getStore().deleteMapping(scope, lost === 'root' ? 'native-root' : `unmounted:${f.children[0]!.nodeId}`);
    f.reopen(); await f.refresh();
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
    assert.equal((await f.getStore().getScopeCommandPlan(scope, choice.commandId))?.phase, 'failed');
  } finally { f.getStore().close(); }
});

test('an old failed choice does not block a newly authorized range or accepted recovery after restart', async () => {
  const f = await deletionFixture();
  try {
    await f.compare();
    await assert.rejects(f.resolve('keep_remote', { crash: at => { if (at === 'after_rejoin_confirmation') throw new Error('worker_crash'); } }), /worker_crash/);
    const old = (await f.list())[0]!;
    await boundary(f, ['native-root']); await f.refresh();
    await boundary(f, []); await f.getStore().bumpBoundaryVersion(scope);
    const cloud = f.snapshot().remoteFacts.map(row => row.nodeId === 'restore-folder'
      ? { ...row, revision: 'cloud-newer', title: 'Newer cloud folder' } : row);
    f.setFacts(cloud); await f.compare();
    const current = (await f.list())[0]!;
    assert.notEqual(current.commandId, old.commandId);
    await assert.rejects(f.resolve('keep_remote', { crash: at => {
      if (at === 'after_rejoin_restore_preparation') throw new Error('worker_crash');
    } }), /worker_crash/);
    f.reopen(); await f.refresh();
    assert.equal((await f.getStore().getScopeCommandPlan(scope, old.commandId))?.phase, 'failed');
    assert.equal((await f.getStore().getScopeCommandPlan(scope, current.commandId))?.phase, 'active');
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'active');
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 3);
    const folder = (await f.getStore().getMappingByColpId(scope, 'restore-folder'))!;
    assert.equal((await f.api.get(folder.nativeId))[0]?.title, 'Newer cloud folder');
  } finally { f.getStore().close(); }
});

test.each(['active', 'missing_root', 'closed'] as const)('restore follows a cloud move through a new ancestor into a %s destination', async status => {
  const f = await deletionFixture();
  try {
    if (status !== 'missing_root') f.api.seed({ id: 'native-other', title: 'Other' });
    await f.getStore().putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
      mountId: 'mount-other', nodeKind: 'folder', projection: { revision: 'other-r1', childrenRevision: 'other-r1', digest: 'other', content: { title: 'Other' } } });
    await f.getStore().putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other', remoteMountNodeId: 'other-colp',
      boundaryVersion: '1', materialized: true, status: status === 'closed' ? 'detached' : 'active', rootRole: 'other-bookmarks' });
    await boundary(f, [], status === 'closed' ? ['native-root'] : ['native-root', 'native-other']);
    f.setFacts([...f.snapshot().remoteFacts.map(row => row.nodeId === 'restore-folder' ? { ...row, parentId: 'new-cloud-parent' } : row),
      { nodeId: 'other-colp', parentId: null, kind: 'folder', revision: 'other-r2', title: 'Other', childrenRevision: 'other-r2' },
      { nodeId: 'new-cloud-parent', parentId: 'other-colp', kind: 'folder', revision: 'new-r1', title: 'New cloud parent',
        childrenRevision: 'new-r1', position: 'a' }]);
    await f.compare(); const choice = await f.resolve('keep_remote');
    if (status === 'missing_root') {
      assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
      assert.equal((await f.getStore().getScopeCommandPlan(scope, choice.commandId))?.phase, 'applying');
      f.reopen(); f.api.seed({ id: 'native-other', title: 'Other' }); await f.refresh();
    }
    const folder = (await f.getStore().getMappingByColpId(scope, 'restore-folder'))!;
    assert.equal(folder.mountId, 'mount-other');
    if (status === 'closed') {
      assert.equal(folder.nativeId, 'unmounted:restore-folder');
      assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
      assert.equal((await f.getStore().getMountBinding(scope, 'mount-other'))?.status, 'detached');
    } else {
      const parent = (await f.getStore().getMappingByColpId(scope, 'new-cloud-parent'))!;
      assert.equal((await f.api.get(parent.nativeId))[0]?.parentId, 'native-other');
      assert.equal((await f.api.get(folder.nativeId))[0]?.parentId, parent.nativeId);
      assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 4);
    }
    assert.equal((await f.getStore().getScopeCommandPlan(scope, choice.commandId))?.phase, 'active');
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'active');
    f.reopen(); await f.refresh(); assert.equal((await f.getStore().listQueue(scope)).length, 0);
  } finally { f.getStore().close(); }
});
