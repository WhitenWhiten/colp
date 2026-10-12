import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { digestJson } from '../src/bookmark-event-codec.js';
import { installKns05IndexedDb, nativeOrUndefined, setup, scope } from './kns-05-pull-harness.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { observationPauseBinding } from '../src/sync-state/remote-observation.js';

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

async function putPausedObservation(
  f: Awaited<ReturnType<typeof fixture>>,
  row: Parameters<Awaited<ReturnType<typeof fixture>>['store']['putRemoteObservation']>[1],
) {
  const mount = await f.store.getMountBinding(scope, 'mount-bar');
  await f.store.putRemoteObservation(scope, { ...row, ...observationPauseBinding(mount?.pauseBaseline) });
}

test('IA-04: rejoin applies a remote deletion received while detached', async () => {
  const f = await fixture(); await detachScopeMount(f.store, scope, 'mount-bar');
  await f.applier.stage(f.page([f.mutationEvent('delete')])); await f.applier.resume();
  await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node']), [], {
    removeNative: async (id, tree) => tree ? f.api.removeTree(id) : f.api.remove(id),
    getNative: async id => nativeOrUndefined(f.api, id), updateNative: async (id, changes) => f.api.update(id, changes),
  });
  // A-11: the honest `get` rejects a removed id, so absence goes through the fixture view.
  assert.equal(f.api.getNode('native-node'), undefined);
});


test('rejoin merges separate title/URL changes and queues local fields at the observed revision once', async () => {
  const f = await fixture(); await detachScopeMount(f.store, scope, 'mount-bar');
  const original = (await f.api.get('native-node'))[0]!;
  await f.api.update('native-node', { url: 'https://local.test/' });
  await putPausedObservation(f, { colpId: 'node-1', remoteRevision: 'remote-r2', cursor: 'c2',
    kind: 'content', payload: { title: 'Remote title', url: original.url ?? '' }, sourceDigest: 'digest', observedAt: Date.now() });
  const chrome = { getNative: async (id: string) => nativeOrUndefined(f.api, id),
    updateNative: async (id: string, changes: { title?: string; url?: string }) => f.api.update(id, changes) };
  await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node']), [], chrome);
  assert.equal((await f.api.get('native-node'))[0]?.title, 'Remote title');
  assert.equal((await f.api.get('native-node'))[0]?.url, 'https://local.test/');
  const queued = await f.store.listQueue(scope);
  assert.equal(queued.length, 1); assert.equal(queued[0]?.baseRevision, 'remote-r2');
  const landed = { title: 'Remote title', url: 'https://local.test/' };
  const mapping = await f.store.getMappingByColpId(scope, 'node-1');
  assert.equal(mapping?.projection.content?.title, landed.title);
  assert.equal(mapping?.projection.content?.url, landed.url);
  assert.equal(mapping?.projection.digest, digestJson(landed));
  await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node']), [], chrome);
  assert.equal((await f.store.listQueue(scope)).length, 1);
});

test('a URL fork stays detached with the local value preserved', async () => {
  const f = await fixture(); await detachScopeMount(f.store, scope, 'mount-bar');
  await f.api.update('native-node', { url: 'https://local.test/' });
  await putPausedObservation(f, { colpId: 'node-1', remoteRevision: 'remote-r2', cursor: 'c2',
    kind: 'content', payload: { url: 'https://remote.test/' }, sourceDigest: 'digest', observedAt: Date.now() });
  const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node']), [], {
    getNative: async id => nativeOrUndefined(f.api, id), updateNative: async (id, changes) => f.api.update(id, changes),
  });
  assert.equal(result.mount.status, 'detached');
  assert.equal((await f.api.get('native-node'))[0]?.url, 'https://local.test/');
});

test('restart after rejoin Chrome update does not duplicate the call or enqueue a rollback', async () => {
  const f = await fixture(); await detachScopeMount(f.store, scope, 'mount-bar');
  await f.applier.stage(f.page([f.mutationEvent('update')])); await f.applier.resume();
  let calls = 0;
  const chrome = { getNative: async (id: string) => nativeOrUndefined(f.api, id),
    updateNative: async (id: string, changes: { title?: string; url?: string }) => {
      calls++; await f.api.update(id, changes); throw new Error('worker_crash');
    } };
  await assert.rejects(() => rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root','native-node']), [], chrome), /worker_crash/);
  assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
  await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root','native-node']), [], chrome);
  assert.equal(calls, 1); assert.equal((await f.store.listQueue(scope)).length, 0);
});

test('rejoin queues an offline local move at the baseline revision without moving it back', async () => {
  const f = await fixture();
  await f.store.putMapping(scope, { nativeId: 'dest', colpId: 'dest-colp', rootNativeId: 'native-root',
    parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder',
    projection: { revision: 'dest-r1', childrenRevision: 'dest-c1', digest: 'dest', content: { title: 'Dest' } } });
  f.api.seed({ id: 'dest', parentId: 'native-root', title: 'Dest' });
  await detachScopeMount(f.store, scope, 'mount-bar');
  await f.api.move('native-node', { parentId: 'dest', index: 0 });
  const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node', 'dest']), [], {
    getNative: async id => nativeOrUndefined(f.api, id), getChildren: id => f.api.getChildren(id),
    moveNative: (id, placement) => f.api.move(id, placement),
  });
  assert.equal(result.mount.status, 'active');
  const moves = (await f.store.listQueue(scope)).filter(row => row.payload.type === 'move_node');
  assert.equal(moves.length, 1); assert.equal(moves[0]?.baseRevision, 'revision-old');
  assert.equal((moves[0]?.payload.payload as { newParentId: string }).newParentId, 'dest-colp');
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'dest');
});

test('remote-only move uses dest sibling index instead of index 0', async () => {
  const f = await fixture();
  await f.store.putMapping(scope, { nativeId: 'dest', colpId: 'dest-colp', rootNativeId: 'native-root',
    parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder',
    projection: { revision: 'dest-r1', childrenRevision: 'dest-c1', digest: 'dest', content: { title: 'Dest' } } });
  await f.store.putMapping(scope, { nativeId: 'dest-sibling', colpId: 'dest-sibling-colp', rootNativeId: 'native-root',
    parentNativeId: 'dest', parentColpId: 'dest-colp', nodeKind: 'bookmark',
    projection: { revision: 'sib-r1', digest: 'sib', content: { title: 'Sibling', url: 'https://sibling.test/' } } });
  f.api.seed({ id: 'dest', parentId: 'native-root', title: 'Dest' });
  f.api.seed({ id: 'dest-sibling', parentId: 'dest', index: 0, title: 'Sibling', url: 'https://sibling.test/' });
  await detachScopeMount(f.store, scope, 'mount-bar');
  await putPausedObservation(f, { colpId: 'node-1', remoteRevision: 'remote-r2', cursor: 'c2',
    kind: 'placement', payload: { parentId: 'dest-colp', afterId: 'dest-sibling-colp' }, sourceDigest: 'digest',
    observedAt: Date.now() });
  const moves: Array<{ parentId: string; index: number }> = [];
  const result = await rejoinScopeMount(f.store, scope, 'mount-bar',
    new Set(['native-root', 'native-node', 'dest', 'dest-sibling']), [], {
      getNative: async id => nativeOrUndefined(f.api, id), getChildren: id => f.api.getChildren(id),
      moveNative: async (id, placement) => { moves.push(placement); await f.api.move(id, placement); },
    });
  assert.equal(result.mount.status, 'active');
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'dest');
  assert.equal(moves.length, 1);
  assert.notEqual(moves[0]?.index, 0);
  assert.equal(moves[0]?.index, 1);
  assert.equal(moves[0]?.parentId, 'dest');
});

test('queue_local_at_baseline_revision keeps the local title and mapping projection', async () => {
  const f = await fixture(); await detachScopeMount(f.store, scope, 'mount-bar');
  await f.api.update('native-node', { title: 'Local title' });
  const chrome = { getNative: async (id: string) => nativeOrUndefined(f.api, id),
    updateNative: async (id: string, changes: { title?: string; url?: string }) => f.api.update(id, changes) };
  await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node']), [], chrome);
  assert.equal((await f.api.get('native-node'))[0]?.title, 'Local title');
  const queued = await f.store.listQueue(scope);
  assert.equal(queued.length, 1); assert.equal(queued[0]?.payload.type, 'update_node_content');
  assert.equal(queued[0]?.baseRevision, 'revision-old');
  const mapping = await f.store.getMappingByColpId(scope, 'node-1');
  assert.equal(mapping?.projection.content?.title, 'Local title');
  assert.equal(mapping?.projection.digest, digestJson({ title: 'Local title', url: 'https://example.test/' }));
});

test('rejoin does not delete a folder containing a locally edited descendant', async () => {
  const f = await fixture();
  await f.store.putMapping(scope, { nativeId: 'native-node', colpId: 'node-1', rootNativeId: 'native-root',
    parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder',
    projection: { revision: 'r1', childrenRevision: 'c1', digest: 'folder', content: { title: 'Folder' } } });
  await f.store.putMapping(scope, { nativeId: 'child', colpId: 'child-colp', rootNativeId: 'native-root',
    parentNativeId: 'native-node', parentColpId: 'node-1', nodeKind: 'bookmark',
    projection: { revision: 'r1', digest: 'child', content: { title: 'Child', url: 'https://example.test/child' } } });
  f.api.seed({ id: 'native-node', parentId: 'native-root', title: 'Folder' });
  f.api.seed({ id: 'child', parentId: 'native-node', title: 'Child', url: 'https://example.test/child' });
  await detachScopeMount(f.store, scope, 'mount-bar');
  await f.api.update('child', { title: 'Local edit' });
  for (const colpId of ['node-1', 'child-colp']) await putPausedObservation(f, {
    colpId, remoteRevision: 'deleted-r2', cursor: 'c2', kind: 'tombstone', payload: { deleted: true },
    sourceDigest: 'deleted', observedAt: Date.now(),
  });
  const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node', 'child']), [], {
    getNative: async id => nativeOrUndefined(f.api, id), getChildren: id => f.api.getChildren(id),
    removeNative: (id, tree) => tree ? f.api.removeTree(id) : f.api.remove(id),
  });
  assert.equal(result.mount.status, 'detached');
  assert.equal((await f.api.get('child'))[0]?.title, 'Local edit');
  assert.equal((await f.api.get('native-node')).length, 1);
});

test('rejoin captures a new destination folder, then uploads its offline move once the parent is authoritative', async () => {
  const f = await fixture();
  await detachScopeMount(f.store, scope, 'mount-bar');
  f.api.seed({ id: 'new-parent', parentId: 'native-root', index: 0, title: 'New folder' });
  await f.api.move('native-node', { parentId: 'new-parent', index: 0 });
  const chrome = { getNative: async (id: string) => nativeOrUndefined(f.api, id),
    getChildren: (id: string) => f.api.getChildren(id), moveNative: (id: string, placement: { parentId: string; index: number }) => f.api.move(id, placement) };
  const present = new Set(['native-root', 'native-node', 'new-parent']);
  const first = await rejoinScopeMount(f.store, scope, 'mount-bar', present, [], chrome);
  assert.equal(first.mount.status, 'detached');
  const creates = (await f.store.listQueue(scope)).filter(row => row.payload.type === 'create_node');
  assert.equal(creates.length, 1);
  await rejoinScopeMount(f.store, scope, 'mount-bar', present, [], chrome);
  assert.equal((await f.store.listQueue(scope)).filter(row => row.payload.type === 'create_node').length, 1);
  const created = creates[0]!;
  const lease = await f.store.acquireLease(scope, 'rejoin-worker', 100, 1000);
  assert.equal(lease.outcome, 'acquired');
  await f.store.claimQueue(scope, 'rejoin-worker', lease.fence, 100, 1);
  await f.store.settleClaimedPush(scope, created.sequence, 'rejoin-worker', lease.fence, {
    outcome: 'terminal', authoritativeCreate: { nativeId: 'new-parent', targetId: 'new-parent-colp', revision: 'parent-r1' },
    receipt: { opId: created.opId, operationDigest: created.digest,
      kind: 'terminal', receiptId: 'new-parent-receipt', resultDigest: 'sha256:new-parent',
      result: { results: [{ opId: created.opId, sequence: created.sequence, status: 'applied', targetId: 'new-parent-colp', revision: 'parent-r1' }] } },
  });
  const provisional = (await f.store.getMappingByNativeId(scope, 'new-parent'))!;
  const { scopeKey: _key, ...mapping } = provisional;
  await f.store.putMapping(scope, { ...mapping, projection: { ...mapping.projection, childrenRevision: 'parent-c1' } });
  const completed = await rejoinScopeMount(f.store, scope, 'mount-bar', present, [], chrome);
  assert.equal(completed.mount.status, 'active');
  const moves = (await f.store.listQueue(scope)).filter(row => row.payload.type === 'move_node');
  assert.equal(moves.length, 1);
  assert.equal((moves[0]!.payload.payload as { newParentId: string }).newParentId, 'new-parent-colp');
  await rejoinScopeMount(f.store, scope, 'mount-bar', present, [], chrome);
  assert.equal((await f.store.listQueue(scope)).filter(row => row.payload.type === 'move_node').length, 1);
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'new-parent');
  f.store.close();
});
