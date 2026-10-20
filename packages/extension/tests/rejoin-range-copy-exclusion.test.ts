import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalAuthoritativeEffectDigest } from '@know-n/colp/sync';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { assertRejoinCanonicalBoundary } from '../src/scope-rejoin-boundary.js';
import { rejoinBoundaryDigest } from '../src/scope-rejoin-authority.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

test.each(['none', 'private_root', 'remote_delete', 'legacy'] as const)
('a prior range-exit copy stays private while a materialized identity follows its current %s restriction', async blocked => {
  const f = await rejoinFixture();
  try {
    f.api.seed({ id: 'native-other', title: 'Other' });
    await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
      nodeKind: 'folder', projection: { revision: 'other-r1', childrenRevision: 'other-c1', digest: 'other', content: { title: 'Other' } } });
    await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other', remoteMountNodeId: 'other-colp',
      boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'other-bookmarks' });
    await f.store.configureBrowserRoots(scope, { status: 'ready', selectedNativeIds: ['native-root', 'native-other'],
      privateNativeIds: [], discovered: [
        { nativeId: 'native-root', ancestorNativeIds: [] }, { nativeId: 'native-other', ancestorNativeIds: [] },
      ] });
    await detachScopeMount(f.store, scope, 'mount-other');
    const outbound = pullFixtures.mutationEvent({ kind: 'move', sequence: 801, collectionId: scope.collectionId,
      targetId: 'node-1', parentId: 'other-colp' });
    await f.applier.stage(f.page([outbound], 'after-range-exit')); await f.applier.resume();
    let retained = await f.store.getLocalSyncExclusion(scope, 'native-node');
    assert.equal(retained?.sourceKind, 'range_exit'); assert.equal(retained?.priorColpId, 'node-1');
    assert.equal(await f.store.getMappingByNativeId(scope, 'native-node'), null);
    const renamed = pullFixtures.mutationEvent({ kind: 'update', sequence: 802, collectionId: scope.collectionId,
      targetId: 'node-1', parentId: 'other-colp' });
    await f.applier.stage(f.page([renamed], 'after-remote-rename')); await f.applier.resume();
    assert.equal((await f.store.getRemoteObservation(scope, 'node-1'))?.payload.title, 'Remote update');
    assert.equal(f.api.getNode('native-node')?.title, 'node-1');
    const back = pullFixtures.mutationEvent({ kind: 'move', sequence: 803, collectionId: scope.collectionId,
      targetId: 'node-1', parentId: 'root-colp' });
    if (back.kind !== 'operation' || back.effect.kind !== 'node_moved') throw new Error('fixture_invalid');
    const effect = { ...back.effect, node: { ...back.effect.node, title: 'Remote update' } };
    effect.effectDigest = canonicalAuthoritativeEffectDigest(effect);
    await f.applier.stage(f.page([{ ...back, effect }], 'after-range-entry')); await f.applier.resume();
    const materialized = (await f.store.getMappingByColpId(scope, 'node-1'))!;
    assert.notEqual(materialized.nativeId, 'native-node');
    assert.equal(f.api.getNode(materialized.nativeId)?.title, 'Remote update');
    assert.equal((await rejoinScopeMount(f.store, scope, 'mount-other', new Set(), [], f.native)).mount.status, 'active');
    if (blocked === 'private_root') await f.store.configureBrowserRoots(scope, { status: 'ready',
      selectedNativeIds: ['native-root', 'native-other'], privateNativeIds: [materialized.nativeId], discovered: [
        { nativeId: 'native-root', ancestorNativeIds: [] }, { nativeId: 'native-other', ancestorNativeIds: [] },
        { nativeId: materialized.nativeId, ancestorNativeIds: ['native-root'] },
      ] });
    if (blocked === 'remote_delete' || blocked === 'legacy') {
      const { scopeKey: _key, sourceKind: _kind, ...value } = retained!;
      await f.store.putLocalSyncExclusion(scope, { ...value, ...(blocked === 'remote_delete' ? { sourceKind: 'remote_delete' } : {}) });
      retained = await f.store.getLocalSyncExclusion(scope, 'native-node');
    }
    const awaitedScope = await f.store.getScope(scope);
    const mappings = await f.store.listMappings(scope);
    const canonicalCheck = () => assertRejoinCanonicalBoundary({ ...f.native, store: f.store, scope },
      mappings, [materialized], rejoinBoundaryDigest(awaitedScope));
    if (blocked === 'none') await canonicalCheck();
    else await assert.rejects(canonicalCheck, /rejoin_boundary_changed/);
    await detachScopeMount(f.store, scope, 'mount-bar');
    const deletion = pullFixtures.mutationEvent({ kind: 'delete', sequence: 804, collectionId: scope.collectionId,
      targetId: 'node-1', parentId: 'root-colp' });
    await f.applier.stage(f.page([deletion], 'after-detached-delete')); await f.applier.resume();
    assert.ok(f.api.getNode(materialized.nativeId));
    assert.equal((await f.store.getRemoteObservation(scope, 'node-1'))?.kind, 'tombstone');
    const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], f.native);
    // Explicit privacy is already handled by Pull outside the paused native
    // comparison. It can leave the mount active while retaining this member;
    // a canonical exclusion still keeps its unresolved comparison pending.
    assert.equal(result.mount.status, blocked === 'none' || blocked === 'private_root' ? 'active' : 'detached');
    if (blocked === 'none') {
      assert.equal(f.api.getNode(materialized.nativeId), undefined);
      assert.equal(await f.store.getMappingByColpId(scope, 'node-1'), null);
    } else {
      assert.equal(f.api.getNode(materialized.nativeId)?.title, 'Remote update');
      assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.nativeId, materialized.nativeId);
    }
    assert.equal(f.api.getNode('native-node')?.title, 'node-1');
    assert.deepEqual(await f.store.getLocalSyncExclusion(scope, 'native-node'), retained);
    await f.api.update('native-node', { title: 'Still private' });
    assert.equal((await f.queue.changed('native-node', { title: 'Still private' })).outcome, 'filtered');
    await f.queue.flush(); assert.deepEqual(await f.store.listQueue(scope), []);
    assert.equal(f.api.getNode('native-node')?.title, 'Still private');
  } finally { f.store.close(); }
});
