import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { rejoinPlacement } from '../src/scope-rejoin-placement.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

async function fixture(preceding = false, otherMount = false) {
  const f = await rejoinFixture();
  f.api.seed({ id: 'destination', title: 'Destination', parentId: 'native-root', index: 2 });
  await f.store.putMapping(scope, { nativeId: 'destination', colpId: 'remote-destination',
    rootNativeId: otherMount ? 'destination' : 'native-root', parentNativeId: 'native-root', parentColpId: 'root-colp',
    nodeKind: 'folder', projection: { revision: 'destination-r1', childrenRevision: 'destination-c1',
      digest: 'destination', content: { title: 'Destination' }, childrenOrder: preceding ? ['native-child'] : [] } });
  if (preceding) {
    await f.api.move('native-child', { parentId: 'destination', index: 0 });
    const { scopeKey: _key, ...child } = (await f.store.getMappingByNativeId(scope, 'native-child'))!;
    await f.store.putMapping(scope, { ...child, parentNativeId: 'destination', parentColpId: 'remote-destination' });
  }
  const { scopeKey: _key, ...root } = (await f.store.getMappingByNativeId(scope, 'native-root'))!;
  await f.store.putMapping(scope, { ...root, projection: { ...root.projection,
    childrenOrder: preceding ? ['native-node', 'destination'] : ['native-node', 'native-child', 'destination'] } });
  if (otherMount) await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'destination',
    remoteMountNodeId: 'remote-destination', boundaryVersion: '1', materialized: false, status: 'active',
    customSourceKey: 'folder:destination' });
  await detachScopeMount(f.store, scope, 'mount-bar');
  await f.api.move('native-node', { parentId: 'destination', index: preceding ? 1 : 0 });
  f.api.calls.length = 0;
  return { ...f, input: { ...f.native, store: f.store, scope,
    mount: (await f.store.getMountBinding(scope, 'mount-bar'))! } };
}

test.each([false, true])('an offline move uses the actual mapped predecessor=%s and both parent revisions', async preceding => {
  const f = await fixture(preceding);
  try {
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], f.native);
    const moves = (await f.store.listQueue(scope)).filter(row => row.payload.type === 'move_node');
    assert.equal(moves.length, 1);
    assert.equal(moves[0]!.payload.targetId, 'node-1');
    assert.deepEqual(moves[0]!.payload.payload, { newParentId: 'remote-destination',
      afterId: preceding ? 'node-child' : null, beforeId: null,
      baseSourceParentRevision: 'children-old', baseTargetParentRevision: 'destination-c1' });
    assert.equal(moves[0]!.status, 'pending');
    assert.equal(await f.store.getQueueReceipt(scope, moves[0]!.sequence), null);
    assert.equal(f.api.getNode('native-node')?.parentId, 'destination');
    assert.deepEqual(f.api.calls, []);
  } finally { f.store.close(); }
});

test.each(['active', 'detached'] as const)('an offline destination in another %s mount has current placement authority', async status => {
  const f = await fixture(false, true);
  try {
    if (status === 'detached') await f.store.detachMount(scope, 'mount-other');
    const mapping = (await f.store.getMappingByNativeId(scope, 'native-node'))!;
    const result = await rejoinPlacement(f.input, mapping, (await f.native.getNative('native-node'))!, await f.store.listMappings(scope));
    assert.equal(result?.newParentId, status === 'active' ? 'remote-destination' : undefined);
    assert.deepEqual(await f.store.listQueue(scope), []); assert.deepEqual(f.api.calls, []);
  } finally { f.store.close(); }
});

test.each(['missing_target', 'missing_source', 'target_revision', 'source_revision', 'children_unavailable',
  'unmapped_predecessor', 'disappeared_member'] as const)('a %s cannot supply guessed move placement', async missing => {
  const f = await fixture(missing === 'unmapped_predecessor');
  try {
    const mapping = (await f.store.getMappingByNativeId(scope, 'native-node'))!;
    const native = (await f.native.getNative('native-node'))!;
    if (missing === 'missing_target' || missing === 'missing_source') {
      await f.store.deleteMapping(scope, missing === 'missing_target' ? 'destination' : 'native-root');
    } else if (missing === 'target_revision' || missing === 'source_revision') {
      const id = missing === 'target_revision' ? 'destination' : 'native-root';
      const { scopeKey: _key, ...parent } = (await f.store.getMappingByNativeId(scope, id))!;
      await f.store.putMapping(scope, { ...parent, projection: { ...parent.projection, childrenRevision: null } });
    } else if (missing === 'unmapped_predecessor') await f.store.deleteMapping(scope, 'native-child');
    else if (missing === 'disappeared_member') await f.api.remove('native-node');
    const calls = [...f.api.calls], mappings = await f.store.listMappings(scope);
    assert.equal(await rejoinPlacement({ ...f.input,
      ...(missing === 'children_unavailable' ? { getChildren: undefined } : {}) }, mapping, native, mappings), undefined);
    assert.deepEqual(await f.store.listMappings(scope), mappings);
    assert.deepEqual(await f.store.listQueue(scope), []); assert.deepEqual(f.api.calls, calls);
  } finally { f.store.close(); }
});
