import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { recoverPendingNativeSideEffects } from '../src/native-repair.js';
import { confirmRejoinScopeMount, previewRejoinScopeMount } from '../src/scope-rejoin-preview.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { repairUnmountedRangeMappings } from '../src/unmounted-range-repair.js';
import { exclusionSourceKind } from '../src/sync-state/scope-facts-repository.js';
import { UNMOUNTED_PREFIX } from '../src/pull-mount-apply.js';
import type { RejoinChrome } from '../src/scope-rejoin-mutation.js';
import {
  bookmarkMapping, destTree, folderMapping, reopenT06, setupT06, sourceCopies, t06Scope,
} from './srg-t06-range-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

function queueApi(api: Awaited<ReturnType<typeof setupT06>>['api']): BookmarkEventApi {
  return {
    get: async (id) => (await api.get(id)).map((node) => ({ ...node, title: node.title ?? '' })),
    getChildren: async (id) => (await api.getChildren(id)).map((node) => ({ ...node, title: node.title ?? '' })),
  };
}

function rejoinChrome(api: Awaited<ReturnType<typeof setupT06>>['api']): RejoinChrome {
  return {
    getNative: async (id) => {
      try { return (await api.get(id))[0]; } catch { return undefined; }
    },
    getChildren: (id) => api.getChildren(id),
    updateNative: async (id, changes) => { await api.update(id, changes); },
    createNative: (input) => api.create(input),
    removeNative: async (id, tree) => { if (tree) await api.removeTree(id); else await api.remove(id); },
    moveNative: (id, placement) => api.move(id, placement),
  };
}

async function scan(fixture: Awaited<ReturnType<typeof setupT06>>, n = 1) {
  const queue = createBookmarkEventQueue({
    scope: t06Scope, store: fixture.store, api: queueApi(fixture.api), autoFlush: false,
    uuid: (() => { let i = 0; return () => `t06-scan-${n}-${++i}`; })(),
  });
  for (let index = 0; index < n; index += 1) {
    await queue.recover();
    await queue.flush();
  }
  return queue;
}

describe('T-06 range move whole subtree and rejoin (SRG-05/06/07)', () => {
  test('M-01: folder+bookmark+folder three-level move-in materializes a complete dest tree', async () => {
    const fixture = await setupT06();
    await fixture.applier.stage(fixture.page([fixture.moveFolderEvent()]));
    await fixture.applier.resume();
    const dest = destTree(fixture.api);
    const source = sourceCopies(fixture.api);
    assert.ok(dest.folder && dest.mid && dest.leaf);
    assert.equal(dest.leaf?.url, 'https://example.test/leaf');
    assert.notEqual(dest.folder.id, 'native-folder');
    assert.notEqual(dest.mid.id, 'native-mid');
    assert.notEqual(dest.leaf.id, 'native-leaf');
    assert.equal(source.folder?.parentId, 'native-root');
    assert.equal(source.mid?.parentId, 'native-folder');
    assert.equal(source.leaf?.parentId, 'native-mid');
    assert.equal((await fixture.store.getMappingByColpId(t06Scope, 'node-folder'))?.nativeId, dest.folder.id);
    assert.equal((await fixture.store.getMappingByColpId(t06Scope, 'node-mid'))?.nativeId, dest.mid.id);
    assert.equal((await fixture.store.getMappingByColpId(t06Scope, 'node-leaf'))?.nativeId, dest.leaf.id);
    assert.equal((await fixture.store.getMappingByColpId(t06Scope, 'node-mid'))?.nativeId.startsWith(UNMOUNTED_PREFIX), false);
    assert.equal((await fixture.store.getMappingByColpId(t06Scope, 'node-leaf'))?.nativeId.startsWith(UNMOUNTED_PREFIX), false);
    assert.equal(await fixture.store.getMappingByNativeId(t06Scope, 'native-folder'), null);
    assert.equal(exclusionSourceKind((await fixture.store.getLocalSyncExclusion(t06Scope, 'native-leaf'))!), 'range_exit');
    const plan = (await fixture.store.exportScope(t06Scope)).scopeCommandPlans
      .find((row) => row.kind === 'rangeExit');
    assert.ok(plan);
    assert.deepEqual(plan.dependencies, ['node-folder', 'node-mid', 'node-leaf']);
    assert.equal((await fixture.store.exportScope(t06Scope)).cursor?.cursor, 'cursor-next');
  });

  test('M-02: restart at each parent-first create cut yields exactly one of each node', async () => {
    for (const cut of [0, 1, 2]) {
      const fixture = await setupT06();
      fixture.setCrash('after_evidence_before_mapping', cut);
      await fixture.applier.stage(fixture.page([fixture.moveFolderEvent()]));
      await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
      fixture.disableCrash();
      const resumed = await reopenT06(fixture);
      await resumed.applier.resume();
      const dest = destTree(resumed.api);
      assert.ok(dest.folder && dest.mid && dest.leaf, `cut ${cut}`);
      const destIds = [dest.folder.id, dest.mid.id, dest.leaf.id];
      assert.equal(new Set(destIds).size, 3, `cut ${cut}`);
      assert.ok(sourceCopies(resumed.api).folder && sourceCopies(resumed.api).mid && sourceCopies(resumed.api).leaf, `cut ${cut}`);
      assert.equal(resumed.api.all().filter((node) => node.title === 'Mid folder').length, 2, `cut ${cut}`);
      assert.equal(resumed.api.all().filter((node) => node.title === 'Leaf').length, 2, `cut ${cut}`);
      assert.equal((await resumed.store.getMappingByColpId(t06Scope, 'node-leaf'))?.nativeId, dest.leaf.id, `cut ${cut}`);
      assert.equal(resumed.api.calls.filter((call) => call.kind === 'create').length, 3, `cut ${cut}`);
    }
  });

  test('M-02: crash before evidence does not create a second dest copy', async () => {
    for (const cut of [0, 1, 2]) {
      const fixture = await setupT06();
      fixture.setCrash('after_create_before_evidence', cut);
      await fixture.applier.stage(fixture.page([fixture.moveFolderEvent()]));
      await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
      fixture.disableCrash();
      assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, cut + 1, `cut ${cut}`);
      const resumed = await reopenT06(fixture);
      await assert.rejects(() => resumed.applier.resume(), /native_result_unknown/);
      assert.equal(resumed.api.calls.filter((call) => call.kind === 'create').length, cut + 1, `cut ${cut}`);
      assert.equal(resumed.api.all().filter((node) => node.id.startsWith('created-')).length, cut + 1, `cut ${cut}`);
      assert.equal(resumed.api.all().filter((node) => node.parentId === 'native-other' && node.id.startsWith('created-')).length, 1, `cut ${cut}`);
      assert.ok(sourceCopies(resumed.api).folder && sourceCopies(resumed.api).mid && sourceCopies(resumed.api).leaf, `cut ${cut}`);
    }
  });

  test('M-03: source copies survive 10 scans and later edits without upload', async () => {
    const fixture = await setupT06();
    await fixture.applier.stage(fixture.page([fixture.moveFolderEvent()]));
    await fixture.applier.resume();
    const source = (await fixture.store.getMountBinding(t06Scope, 'mount-bar'))!;
    const { scopeKey: _key, ...binding } = source;
    await fixture.store.putMountBinding(t06Scope, { ...binding, status: 'active' });
    await scan(fixture, 10);
    assert.equal((await fixture.store.listQueue(t06Scope)).filter((row) => row.payload.type === 'create_node').length, 0);
    await fixture.api.update('native-leaf', { title: 'Source edit' });
    await scan(fixture, 1);
    assert.equal((await fixture.store.listQueue(t06Scope)).length, 0);
    assert.equal((await fixture.store.listBookmarkEvents(t06Scope)).filter((row) => row.nativeId === 'native-leaf').length, 0);
    assert.equal((await fixture.api.get('native-leaf'))[0]?.title, 'Source edit');
    assert.equal((await fixture.api.get('native-leaf'))[0]?.parentId, 'native-mid');
  });

  test('M-04: rejoin create, user same-content, revoke, expired preview, duplicate confirm', async () => {
    const created = await setupT06({ sourceStatus: 'detached', destStatus: 'active' });
    await created.store.deleteMapping(t06Scope, 'native-folder');
    await created.store.deleteMapping(t06Scope, 'native-mid');
    await created.store.deleteMapping(t06Scope, 'native-leaf');
    await created.api.removeTree('native-folder');
    await created.store.putMapping(t06Scope, bookmarkMapping(`${UNMOUNTED_PREFIX}node-created-91`, 'node-created-91', {
      parentNativeId: 'native-root', parentColpId: 'root-colp', title: 'Remote', url: 'https://example.test/',
    }));
    const preview = await previewRejoinScopeMount(created.store, t06Scope, 'mount-bar', rejoinChrome(created.api));
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    created.api.seed({
      id: 'user-twin', parentId: 'native-root', index: 0, title: 'Remote', url: 'https://example.test/',
    });
    const confirmed = await confirmRejoinScopeMount(created.store, t06Scope, {
      mountId: 'mount-bar', previewId: preview.previewId, treeDigest: preview.treeDigest,
    }, rejoinChrome(created.api), new Set(['native-root', 'user-twin', 'native-other']));
    assert.equal(confirmed.ok, true);
    const mapping = await created.store.getMappingByColpId(t06Scope, 'node-created-91');
    assert.ok(mapping && !mapping.nativeId.startsWith(UNMOUNTED_PREFIX));
    assert.notEqual(mapping.nativeId, 'user-twin');
    assert.equal((await created.store.getMappingByNativeId(t06Scope, 'user-twin')), null);
    assert.equal((await created.store.getMountBinding(t06Scope, 'mount-bar'))?.status, 'active');

    const revoked = await setupT06({ sourceStatus: 'detached' });
    await revoked.store.setBrowserRootStatus(t06Scope, 'permission_required');
    const revokedPreview = await previewRejoinScopeMount(revoked.store, t06Scope, 'mount-bar', rejoinChrome(revoked.api));
    assert.equal(revokedPreview.ok, true);
    if (!revokedPreview.ok) return;
    const revokedConfirm = await confirmRejoinScopeMount(revoked.store, t06Scope, {
      mountId: 'mount-bar', previewId: revokedPreview.previewId, treeDigest: revokedPreview.treeDigest,
    }, rejoinChrome(revoked.api), new Set(['native-root', 'native-folder', 'native-mid', 'native-leaf']));
    assert.equal(revokedConfirm.ok, false);
    assert.equal((await revoked.store.getMountBinding(t06Scope, 'mount-bar'))?.status, 'detached');
    assert.ok(await revoked.store.getScopeCommandPlan(t06Scope, 'rejoin:mount-bar'));

    const expired = await setupT06({ sourceStatus: 'detached' });
    const expiredPreview = await previewRejoinScopeMount(expired.store, t06Scope, 'mount-bar', rejoinChrome(expired.api), {
      now: () => 1, ttlMs: 1,
    });
    assert.equal(expiredPreview.ok, true);
    if (!expiredPreview.ok) return;
    const expiredConfirm = await confirmRejoinScopeMount(expired.store, t06Scope, {
      mountId: 'mount-bar', previewId: expiredPreview.previewId, treeDigest: expiredPreview.treeDigest, now: () => 10_000,
    }, rejoinChrome(expired.api), new Set(['native-root']));
    assert.equal(expiredConfirm.ok, false);
    if (!expiredConfirm.ok) assert.equal(expiredConfirm.error === 'request_invalid' || expiredConfirm.error === 'preview_stale', true);
    assert.notEqual((await expired.store.getMountBinding(t06Scope, 'mount-bar'))?.status, 'active');

    const duplicate = await setupT06({ sourceStatus: 'detached' });
    const firstPreview = await previewRejoinScopeMount(duplicate.store, t06Scope, 'mount-bar', rejoinChrome(duplicate.api));
    assert.equal(firstPreview.ok, true);
    if (!firstPreview.ok) return;
    const firstConfirm = await confirmRejoinScopeMount(duplicate.store, t06Scope, {
      mountId: 'mount-bar', previewId: firstPreview.previewId, treeDigest: firstPreview.treeDigest,
    }, rejoinChrome(duplicate.api), new Set(['native-root', 'native-folder', 'native-mid', 'native-leaf', 'native-other']));
    assert.equal(firstConfirm.ok, true);
    const second = await confirmRejoinScopeMount(duplicate.store, t06Scope, {
      mountId: 'mount-bar', previewId: firstPreview.previewId, treeDigest: firstPreview.treeDigest,
    }, rejoinChrome(duplicate.api), new Set(['native-root', 'native-folder', 'native-mid', 'native-leaf', 'native-other']));
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error, 'duplicate_confirm');
  });

  test('M-05: two mounts each have a unique Recovered dest copy', async () => {
    const fixture = await setupT06({ sourceStatus: 'detached', destStatus: 'detached' });
    fixture.api.seed({ id: 'native-third', title: 'Third' });
    await fixture.store.putMountBinding(t06Scope, {
      mountId: 'mount-third', nativeRootId: 'native-third', remoteMountNodeId: 'third-colp',
      boundaryVersion: '1', materialized: true, status: 'active', customSourceKey: 'folder:third',
    });
    await fixture.store.putMapping(t06Scope, folderMapping('native-third', 'third-colp', {
      rootNativeId: 'native-third', title: 'Third',
    }));
    for (const [seq, parent, mountId] of [
      [91, 'root-colp', 'mount-bar'],
      [92, 'other-colp', 'mount-other'],
    ] as const) {
      await fixture.store.putMapping(t06Scope, folderMapping(`${UNMOUNTED_PREFIX}node-created-${seq}`, `node-created-${seq}`, {
        parentColpId: parent, title: 'Recovered',
      }));
      const preview = await previewRejoinScopeMount(fixture.store, t06Scope, mountId, rejoinChrome(fixture.api));
      assert.equal(preview.ok, true);
      if (!preview.ok) return;
      const result = await confirmRejoinScopeMount(fixture.store, t06Scope, {
        mountId, previewId: preview.previewId, treeDigest: preview.treeDigest,
      }, rejoinChrome(fixture.api), new Set(fixture.api.all().map((node) => node.id)));
      assert.equal(result.ok, true, mountId);
    }
    const first = await fixture.store.getMappingByColpId(t06Scope, 'node-created-91');
    const second = await fixture.store.getMappingByColpId(t06Scope, 'node-created-92');
    assert.ok(first?.nativeId && second?.nativeId);
    assert.notEqual(first.nativeId, second.nativeId);
    assert.equal((await fixture.api.get(first.nativeId))[0]?.parentId, 'native-root');
    assert.equal((await fixture.api.get(second.nativeId))[0]?.parentId, 'native-other');
    assert.equal(fixture.api.all().filter((node) => node.title === 'Recovered').length, 2);
  });

  test('M-06: dest pending waits mixed bar updates and does not corrupt the other mount', async () => {
    const fixture = await setupT06({ sourceStatus: 'active', destStatus: 'pending' });
    const barBefore = await fixture.store.getMappingByColpId(t06Scope, 'node-folder');
    const event = fixture.moveFolderEvent();
    const barUpdate = pullFixtures.mutationEvent({
      kind: 'update', sequence: 99, collectionId: t06Scope.collectionId,
      targetId: 'node-folder', parentId: 'root-colp', targetKind: 'folder',
    });
    await assert.rejects(async () => {
      await fixture.applier.stage(fixture.page([barUpdate, event]));
      await fixture.applier.resume();
    }, /range_dependency_pending/);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create' || call.kind === 'move' || call.kind === 'update').length, 0);
    assert.equal((await fixture.api.get('native-folder'))[0]?.parentId, 'native-root');
    assert.equal((await fixture.api.getChildren('native-other')).length, 0);
    assert.equal((await fixture.store.getMappingByColpId(t06Scope, 'node-folder'))?.nativeId, barBefore?.nativeId);
    assert.notEqual((await fixture.store.exportScope(t06Scope)).cursor?.cursor, 'cursor-next');
    assert.equal((await fixture.store.getMountBinding(t06Scope, 'mount-other'))?.rootRole, 'other-bookmarks');
    assert.equal((await fixture.store.getMountBinding(t06Scope, 'mount-bar'))?.rootRole, 'bookmarks-bar');
  });

  test('M-07: old unmounted repair fills proven dest descendants and leaves cursor/source consistent', async () => {
    const fixture = await setupT06({ sourceStatus: 'detached', destStatus: 'active' });
    fixture.api.seed({ id: 'dest-empty', parentId: 'native-other', index: 0, title: 'Moved folder' });
    await fixture.store.deleteMapping(t06Scope, 'native-folder');
    await fixture.store.deleteMapping(t06Scope, 'native-mid');
    await fixture.store.deleteMapping(t06Scope, 'native-leaf');
    await fixture.store.putMapping(t06Scope, folderMapping('dest-empty', 'node-folder', {
      parentNativeId: 'native-other', parentColpId: 'other-colp', rootNativeId: 'native-other', title: 'Moved folder',
    }));
    await fixture.store.putMapping(t06Scope, folderMapping(`${UNMOUNTED_PREFIX}node-mid`, 'node-mid', {
      parentNativeId: `${UNMOUNTED_PREFIX}node-folder`, parentColpId: 'node-folder',
      rootNativeId: 'native-other', title: 'Mid folder',
    }));
    await fixture.store.putMapping(t06Scope, bookmarkMapping(`${UNMOUNTED_PREFIX}node-leaf`, 'node-leaf', {
      parentNativeId: `${UNMOUNTED_PREFIX}node-mid`, parentColpId: 'node-mid',
      rootNativeId: 'native-other', title: 'Leaf',
    }));
    await fixture.store.putLocalSyncExclusion(t06Scope, {
      nativeId: 'native-folder', decisionId: 'rx:legacy', rootNativeId: 'native-root',
      generation: 1, sourceKind: 'range_exit', priorColpId: 'node-folder',
    });
    await fixture.store.putLocalSyncExclusion(t06Scope, {
      nativeId: 'native-mid', decisionId: 'rx:legacy', rootNativeId: 'native-root',
      generation: 1, sourceKind: 'range_exit', priorColpId: 'node-mid',
    });
    await fixture.store.putLocalSyncExclusion(t06Scope, {
      nativeId: 'native-leaf', decisionId: 'rx:legacy', rootNativeId: 'native-root',
      generation: 1, sourceKind: 'range_exit', priorColpId: 'node-leaf',
    });
    fixture.api.seed({
      id: 'stray-unprovable', parentId: 'dest-empty', index: 0, title: 'Stray', url: 'https://example.test/stray',
    });
    await fixture.store.putRemoteObservation(t06Scope, {
      colpId: 'ghost-acked', remoteRevision: 'r-ghost', cursor: 'cursor-acked-out', kind: 'placement',
      payload: { parentId: 'missing-parent' }, sourceDigest: 'sha256:ghost', observedAt: Date.now(),
    });
    const beforeCursor = (await fixture.store.exportScope(t06Scope)).cursor?.cursor
      ?? (await fixture.store.getScope(t06Scope))?.checkpoint?.cursor;
    const repair = await repairUnmountedRangeMappings(fixture.store, t06Scope, fixture.api);
    assert.ok(repair.filled >= 2);
    assert.ok(repair.attention >= 1);
    const dest = destTree(fixture.api);
    assert.ok(dest.mid && dest.leaf);
    assert.equal((await fixture.store.getMappingByColpId(t06Scope, 'node-mid'))?.nativeId, dest.mid.id);
    assert.equal((await fixture.store.getMappingByColpId(t06Scope, 'node-leaf'))?.nativeId, dest.leaf.id);
    assert.equal((await fixture.api.get('stray-unprovable'))[0]?.title, 'Stray');
    assert.equal(sourceCopies(fixture.api).leaf?.parentId, 'native-mid');
    assert.equal((await fixture.store.getLocalSyncExclusion(t06Scope, 'native-leaf'))?.priorColpId, 'node-leaf');
    const afterCursor = (await fixture.store.exportScope(t06Scope)).cursor?.cursor
      ?? (await fixture.store.getScope(t06Scope))?.checkpoint?.cursor;
    assert.equal(afterCursor, beforeCursor);
    await recoverPendingNativeSideEffects(fixture.store, t06Scope, fixture.api);
    assert.equal((await fixture.store.getMappingByColpId(t06Scope, 'node-leaf'))?.nativeId, dest.leaf.id);
  });

  test('in-flight rejoin on a detached mount still captures local native events', async () => {
    const fixture = await setupT06({ sourceStatus: 'detached' });
    const detached = await scan(fixture, 1);
    fixture.api.seed({
      id: 'before-rejoin', parentId: 'native-root', index: 1, title: 'Before', url: 'https://example.test/before',
    });
    assert.equal((await detached.created('before-rejoin', {
      id: 'before-rejoin', parentId: 'native-root', index: 1, title: 'Before', url: 'https://example.test/before',
    })).outcome, 'filtered');
    await fixture.store.putScopeCommandPlan(t06Scope, {
      commandId: 'rejoin:mount-bar', kind: 'rejoin', confirmationVersion: '1',
      baselineDigest: 'cursor-old', phase: 'comparing', dependencies: [], updatedAt: Date.now(),
      mountId: 'mount-bar',
    });
    fixture.api.seed({
      id: 'during-rejoin', parentId: 'native-root', index: 2, title: 'During', url: 'https://example.test/during',
    });
    const live = await scan(fixture, 1);
    assert.equal((await live.created('during-rejoin', {
      id: 'during-rejoin', parentId: 'native-root', index: 2, title: 'During', url: 'https://example.test/during',
    })).outcome, 'staged');
  });

  test('incomplete rejoin does not return ok:true or mark the mount active', async () => {
    const fixture = await setupT06({ sourceStatus: 'detached' });
    await fixture.api.removeTree('native-root');
    const preview = await previewRejoinScopeMount(fixture.store, t06Scope, 'mount-bar', rejoinChrome(fixture.api));
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.equal(preview.warnings.some((row) => row.code === 'original_location_unavailable'), true);
    const confirmed = await confirmRejoinScopeMount(fixture.store, t06Scope, {
      mountId: 'mount-bar', previewId: preview.previewId, treeDigest: preview.treeDigest,
    }, rejoinChrome(fixture.api), new Set());
    assert.equal(confirmed.ok, false);
    assert.notEqual((await fixture.store.getMountBinding(t06Scope, 'mount-bar'))?.status, 'active');
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    const direct = await rejoinScopeMount(fixture.store, t06Scope, 'mount-bar', new Set(), [], rejoinChrome(fixture.api));
    assert.notEqual(direct.mount.status, 'active');
  });
});
