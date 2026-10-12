import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { exclusionSourceKind } from '../src/sync-state/scope-facts-repository.js';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

async function mount(f: Awaited<ReturnType<typeof setup>>, status: 'active' | 'detached' = 'active') {
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status,
    rootRole: 'bookmarks-bar' });
  await f.store.setFirstRun(scope, 'completed');
}

test('FRR-01-A: active→detached Move keeps the local copy and does not write the dest mount', async () => {
  const f = await setup(); await mount(f);
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other',
    remoteMountNodeId: 'other-colp', boundaryVersion: '1', materialized: false, status: 'detached',
    rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
    nodeKind: 'folder', projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other' } });
  f.api.seed({ id: 'native-other', title: 'Other' });
  await f.store.deleteMapping(scope, 'native-child');
  await f.api.remove('native-child');
  const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 71, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await f.applier.stage(f.page([event])); await f.applier.resume();
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
  assert.equal(f.api.calls.filter((call) => call.kind === 'move').length, 0);
  assert.equal((await f.store.getMountBinding(scope, 'mount-other'))?.status, 'detached');
  assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.nativeId, 'unmounted:node-1');
  const exclusion = await f.store.getLocalSyncExclusion(scope, 'native-node');
  assert.equal(exclusionSourceKind(exclusion!), 'range_exit');
  assert.equal((await f.store.getRemoteObservation(scope, 'node-1'))?.kind, 'placement');
  const queue = createBookmarkEventQueue({ scope, store: f.store, api: f.api as unknown as BookmarkEventApi,
    autoFlush: false, uuid: (() => { let n = 0; return () => `frr-${++n}`; })() });
  await queue.recover(); await queue.flush();
  assert.equal((await f.store.listQueue(scope)).length, 0);
});

test('FRR-01-B: active→active Move still converges', async () => {
  const f = await setup(); await mount(f);
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other',
    remoteMountNodeId: 'other-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
    nodeKind: 'folder', projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other' } });
  f.api.seed({ id: 'native-other', title: 'Other' });
  const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 72, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await f.applier.stage(f.page([event])); await f.applier.resume();
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-other');
  assert.equal(f.api.calls.filter((call) => call.kind === 'move').length, 1);
  assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.parentNativeId, 'native-other');
});

test.each(['before_intent', 'before_event', 'after_browser_call', 'after_api_evidence'] as const)(
  'FRR-01-C: replay after %s does not write a detached dest',
  async (boundary) => {
    const f = await setup(boundary); await mount(f);
    await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other',
      remoteMountNodeId: 'other-colp', boundaryVersion: '1', materialized: false, status: 'detached',
      rootRole: 'other-bookmarks' });
    await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
      nodeKind: 'folder', projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other' } });
    f.api.seed({ id: 'native-other', title: 'Other' });
    const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 73, collectionId: scope.collectionId,
      targetId: 'node-1', parentId: 'other-colp' });
    await f.applier.stage(f.page([event]));
    await assert.rejects(() => f.applier.resume(), /worker_crash/);
    f.disableCrash();
    await f.applier.resume();
    assert.equal(f.api.calls.filter((call) => call.kind === 'move' || call.kind === 'create').length, 0);
    assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
    assert.equal((await f.api.getChildren('native-other')).length, 0);
    const exclusion = await f.store.getLocalSyncExclusion(scope, 'native-node');
    assert.equal(exclusionSourceKind(exclusion!), 'range_exit');
  },
);

test('folder range-exit keeps the verified subtree local-only', async () => {
  const f = await setup(); await mount(f);
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other',
    remoteMountNodeId: 'other-colp', boundaryVersion: '1', materialized: false, status: 'detached',
    rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
    nodeKind: 'folder', projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other' } });
  f.api.seed({ id: 'native-other', title: 'Other' });
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
  const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 74, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp', targetKind: 'folder' });
  await f.applier.stage(f.page([event])); await f.applier.resume();
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
  assert.equal((await f.api.get('native-child'))[0]?.parentId, 'native-node');
  assert.equal((await f.api.get('native-grand'))[0]?.parentId, 'native-child');
  assert.equal((await f.api.getChildren('native-other')).length, 0);
  assert.equal(f.api.calls.filter((call) => call.kind === 'move' || call.kind === 'create'
    || call.kind === 'delete').length, 0);
  assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.nativeId, 'unmounted:node-1');
  assert.equal((await f.store.getMappingByColpId(scope, 'node-child'))?.nativeId, 'unmounted:node-child');
  assert.equal((await f.store.getMappingByColpId(scope, 'node-grand'))?.nativeId, 'unmounted:node-grand');
  for (const nativeId of ['native-node', 'native-child', 'native-grand']) {
    assert.equal(await f.store.getMappingByNativeId(scope, nativeId), null);
    const exclusion = await f.store.getLocalSyncExclusion(scope, nativeId);
    assert.equal(exclusionSourceKind(exclusion!), 'range_exit');
    assert.equal(exclusion?.decisionId.startsWith('rdd:'), false);
  }
  const queue = createBookmarkEventQueue({ scope, store: f.store, api: f.api as unknown as BookmarkEventApi,
    autoFlush: false, uuid: (() => { let n = 0; return () => `frr-folder-${++n}`; })() });
  await queue.recover(); await queue.flush();
  assert.equal((await f.store.listQueue(scope)).length, 0);
  assert.equal((await f.store.listBookmarkEvents(scope)).filter((row) => row.kind === 'create').length, 0);
  assert.equal(await f.store.getMappingByNativeId(scope, 'native-grand'), null);
});

test('detached→active materialize keeps the old copy excluded', async () => {
  const f = await setup(); await mount(f, 'detached');
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other',
    remoteMountNodeId: 'other-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
    nodeKind: 'folder', projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other' } });
  f.api.seed({ id: 'native-other', title: 'Other' });
  await f.store.deleteMapping(scope, 'native-child');
  await f.api.remove('native-child');
  f.api.calls.length = 0;
  const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 75, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await f.applier.stage(f.page([event])); await f.applier.resume();
  const dest = (await f.api.getChildren('native-other'))[0];
  assert.ok(dest);
  assert.notEqual(dest.id, 'native-node');
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
  assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.nativeId, dest.id);
  assert.equal(await f.store.getMappingByNativeId(scope, 'native-node'), null);
  const exclusion = await f.store.getLocalSyncExclusion(scope, 'native-node');
  assert.equal(exclusionSourceKind(exclusion!), 'range_exit');
  assert.equal(exclusion?.decisionId.startsWith('rdd:'), false);
  assert.equal(f.api.calls.filter((call) => call.kind === 'delete').length, 0);
  const source = (await f.store.getMountBinding(scope, 'mount-bar'))!;
  const { scopeKey: _key, ...binding } = source;
  await f.store.putMountBinding(scope, { ...binding, status: 'active' });
  const queue = createBookmarkEventQueue({ scope, store: f.store, api: f.api as unknown as BookmarkEventApi,
    autoFlush: false, uuid: (() => { let n = 0; return () => `frr-mat-${++n}`; })() });
  await queue.recover(); await queue.flush();
  assert.equal((await f.store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length, 0);
  assert.equal((await f.store.listBookmarkEvents(scope)).filter((row) => row.kind === 'create'
    && row.nativeId === 'native-node').length, 0);
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
});

test('folder materialize maps dest folder and dest child', async () => {
  const f = await setup(); await mount(f, 'detached'); await dest(f, 'active');
  await f.store.putMapping(scope, { nativeId: 'native-node', colpId: 'node-1', rootNativeId: 'native-root',
    nodeKind: 'folder', parentNativeId: 'native-root', parentColpId: 'root-colp',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'sha256:node-1',
      content: { title: 'node-1' } } });
  await f.store.putMapping(scope, { nativeId: 'native-child', colpId: 'node-child', rootNativeId: 'native-root',
    nodeKind: 'bookmark', parentNativeId: 'native-node', parentColpId: 'node-1',
    projection: { revision: 'revision-old', digest: 'sha256:node-child',
      content: { title: 'node-child', url: 'https://example.test/' } } });
  f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1' });
  f.api.seed({ id: 'native-child', parentId: 'native-node', index: 0, title: 'node-child',
    url: 'https://example.test/' });
  f.api.calls.length = 0;
  const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 79, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp', targetKind: 'folder' });
  await f.applier.stage(f.page([event])); await f.applier.resume();
  const destNode = (await f.api.getChildren('native-other'))[0];
  assert.ok(destNode);
  assert.notEqual(destNode.id, 'native-node');
  assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.nativeId, destNode.id);
  const destChild = (await f.api.getChildren(destNode.id))[0];
  assert.ok(destChild);
  assert.notEqual(destChild.id, 'native-child');
  assert.equal((await f.store.getMappingByColpId(scope, 'node-child'))?.nativeId, destChild.id);
  assert.equal(await f.store.getMappingByNativeId(scope, 'native-child'), null);
  assert.equal((await f.api.get('native-child'))[0]?.parentId, 'native-node');
  assert.equal(exclusionSourceKind((await f.store.getLocalSyncExclusion(scope, 'native-child'))!), 'range_exit');
  assert.equal(f.api.calls.filter((call) => call.kind === 'create').length, 2);
  assert.equal(f.api.calls.filter((call) => call.kind === 'delete').length, 0);
});

async function dest(f: Awaited<ReturnType<typeof setup>>, status: 'active' | 'detached') {
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other',
    remoteMountNodeId: 'other-colp', boundaryVersion: '1', materialized: false, status,
    rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
    nodeKind: 'folder', projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other' } });
  f.api.seed({ id: 'native-other', title: 'Other' });
}

test('persisted retain_local_copy is not upgraded when dest later becomes active', async () => {
  const f = await setup('after_intent'); await mount(f); await dest(f, 'detached');
  await f.store.deleteMapping(scope, 'native-child'); await f.api.remove('native-child');
  const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 76, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await f.applier.stage(f.page([event]));
  await assert.rejects(() => f.applier.resume(), /worker_crash/);
  const rows = await f.store.listPullEvents(scope);
  const intent = await f.store.getApplyIntent(scope, `intent:${rows[0]!.eventId}`);
  assert.equal(intent?.anchors?.rangeAction, 'retain_local_copy');
  assert.equal(intent?.anchors?.chromeMutation, false);
  const other = (await f.store.getMountBinding(scope, 'mount-other'))!;
  const { scopeKey: _key, ...binding } = other;
  await f.store.putMountBinding(scope, { ...binding, status: 'active' });
  f.disableCrash(); await f.applier.resume();
  assert.equal(f.api.calls.filter((call) => call.kind === 'move' || call.kind === 'create').length, 0);
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
  assert.equal((await f.api.getChildren('native-other')).length, 0);
  assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.nativeId, 'unmounted:node-1');
});

test('persisted native_move is discarded when dest detaches before Chrome', async () => {
  const f = await setup('after_intent'); await mount(f); await dest(f, 'active');
  const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 77, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await f.applier.stage(f.page([event]));
  await assert.rejects(() => f.applier.resume(), /worker_crash/);
  const rows = await f.store.listPullEvents(scope);
  const intent = await f.store.getApplyIntent(scope, `intent:${rows[0]!.eventId}`);
  assert.equal(intent?.anchors?.rangeAction, 'native_move');
  const other = (await f.store.getMountBinding(scope, 'mount-other'))!;
  const { scopeKey: _key, ...binding } = other;
  await f.store.putMountBinding(scope, { ...binding, status: 'detached' });
  f.disableCrash(); await f.applier.resume();
  assert.equal(f.api.calls.filter((call) => call.kind === 'move' || call.kind === 'create').length, 0);
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
  assert.equal((await f.api.getChildren('native-other')).length, 0);
});

test.each([
  ['permission_required', async (f: Awaited<ReturnType<typeof setup>>) => {
    await f.store.setBrowserRootStatus(scope, 'permission_required');
  }],
  ['unknown dest identity', async (f: Awaited<ReturnType<typeof setup>>) => {
    await f.store.deleteMapping(scope, 'native-other');
    await f.store.putMapping(scope, { nativeId: 'unmounted:other-colp', colpId: 'other-colp',
      rootNativeId: 'native-other', nodeKind: 'folder',
      projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other' } });
  }],
] as const)('%s awaits Move and does not Chrome-move', async (_name, arrange) => {
  const f = await setup(); await mount(f); await dest(f, 'active');
  await arrange(f);
  const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 78, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await assert.rejects(async () => {
    await f.applier.stage(f.page([event]));
    await f.applier.resume();
  }, /range_dependency_pending/);
  assert.equal(f.api.calls.filter((call) => call.kind === 'move' || call.kind === 'create').length, 0);
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
  assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-next');
});
