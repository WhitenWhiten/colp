import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test, vi } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createPullApplier } from '../src/pull-applier.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { installKns05IndexedDb, indexedDB, scope } from './kns-05-pull-harness.js';
import { setup as setupOwn, scope as ownScope } from './own-create-replay-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

test.each([false, true])('restart recovers an uncaptured same-parent order; prior callback captured=%s', async captured => {
  const f = await rejoinFixture(); let store = f.store;
  try {
    await f.api.move('native-child', { parentId: 'native-root', index: 0 });
    if (captured) await f.queue.moved('native-child', { parentId: 'native-root', index: 0,
      oldParentId: 'native-root', oldIndex: 1 });
    store.close(); store = createSyncStateStore({ indexedDB });
    const restarted = createBookmarkEventQueue({ store, scope, api: f.eventApi, autoFlush: false });
    await restarted.recover(); await restarted.recover();
    const outgoing = await store.listQueue(scope);
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0]?.payload.type, 'move_node');
    assert.deepEqual((await store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenOrder,
      ['native-child', 'native-node']);
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
  } finally { store.close(); }
});

test.each(['move', 'children_reordered'])('rejoin preserves and uploads a paused %s order once', async callback => {
  const f = await rejoinFixture();
  try {
    await detachScopeMount(f.store, scope, 'mount-bar');
    await f.api.move('native-child', { parentId: 'native-root', index: 0 });
    const result = callback === 'move'
      ? await f.queue.moved('native-child', { parentId: 'native-root', index: 0, oldParentId: 'native-root', oldIndex: 1 })
      : await f.queue.reordered('native-root', ['native-child', 'native-node']);
    assert.equal(result.outcome, 'filtered');
    assert.deepEqual((await f.store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenOrder,
      ['native-node', 'native-child']);
    const joined = await rejoinScopeMount(f.store, scope, 'mount-bar',
      new Set(['native-root', 'native-node', 'native-child']), [], f.native);
    assert.equal(joined.mount.status, 'active');
    assert.equal((await f.store.listQueue(scope)).filter(row => row.payload.type === 'move_node').length, 1);
    assert.deepEqual((await f.store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenOrder,
      ['native-child', 'native-node']);
    await f.queue.recover();
    assert.equal((await f.store.listQueue(scope)).length, 1);
  } finally { f.store.close(); }
});

test('a remote move updates the durable order even when its native callback is lost', async () => {
  const f = await rejoinFixture();
  try {
    const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 1, collectionId: scope.collectionId,
      targetId: 'node-child', parentId: 'root-colp' });
    assert.ok(event.kind === 'operation' && event.effect.kind === 'node_moved' && event.effect.node.kind === 'bookmark');
    const title = event.effect.node.title;
    await f.api.update('native-child', { title });
    const { scopeKey: _key, ...original } = (await f.store.getMappingByNativeId(scope, 'native-child'))!;
    await f.store.putMapping(scope, { ...original, projection: { ...original.projection,
      content: { ...original.projection.content, title } } });
    await f.applier.stage(f.page([event])); await f.applier.resume();
    assert.deepEqual((await f.api.getChildren('native-root')).map(node => node.id), ['native-child', 'native-node']);
    assert.deepEqual((await f.store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenOrder,
      ['native-child', 'native-node']);
    // Completed echo TTLs are not the durable ordering baseline.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
    try { await f.queue.recover(); } finally { clock.mockRestore(); }
    assert.equal((await f.store.listQueue(scope)).length, 0);
  } finally { f.store.close(); }
});

test('own-create replay repairs a missing same-parent move without recreating the native', async () => {
  const f = await setupOwn('completed');
  try {
    f.api.seed({ id: 'native-sibling', parentId: 'native-root', index: 0, title: 'Sibling', url: 'https://example.test/sibling' });
    await f.store.putMapping(ownScope, { nativeId: 'native-sibling', colpId: 'sibling-colp',
      rootNativeId: 'native-root', parentNativeId: 'native-root', nodeKind: 'bookmark',
      projection: { revision: 'sibling-r1', digest: 'sibling', content: { title: 'Sibling', url: 'https://example.test/sibling' } } });
    await f.api.move(f.node.id, { parentId: 'native-root', index: 1 });
    await f.store.putMapping(ownScope, { ...f.parent,
      projection: { ...f.parent.projection, childrenOrder: ['native-sibling', f.node.id] } });
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1,
      collectionId: ownScope.collectionId, parentId: 'root-colp', replicaId: ownScope.replicaId,
      opId: 'normal-create', afterId: 'sibling-colp' });
    const applier = createPullApplier(f.options);
    await applier.stage(pullFixtures.page({ events: [event], nextCursor: 'cursor-next', collectionRevision: 'revision-next' }));
    await f.api.move(f.node.id, { parentId: 'native-root', index: 0 });
    await applier.resume(); await f.queue.recover();
    assert.equal((await f.store.getCursor(ownScope))?.cursor, 'cursor-next');
    assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
    assert.equal((await f.store.listBookmarkEventsByStatus(ownScope, 'pending')).filter(row => row.kind === 'move').length, 1);
    const lease = await f.store.acquireLease(ownScope, 'receipt-worker', 1, 30_000);
    const create = (await f.store.claimNextQueue(ownScope, 'receipt-worker', lease.fence, 1))!;
    await f.store.settleClaimedPush(ownScope, create.sequence, 'receipt-worker', lease.fence, {
      outcome: 'terminal', receipt: { opId: create.opId, operationDigest: create.digest, kind: 'terminal',
        receiptId: 'create-receipt', resultDigest: 'sha256:receipt', result: { results: [{ opId: create.opId,
          sequence: create.sequence, status: 'applied', targetId: f.remote.id, revision: f.remote.revision }] } },
      authoritativeCreate: { nativeId: f.node.id, targetId: f.remote.id, revision: f.remote.revision },
    });
    await f.queue.flush();
    assert.equal((await f.store.listQueue(ownScope)).filter(row => row.payload.type === 'move_node').length, 1);
    assert.deepEqual((await f.store.getMappingByNativeId(ownScope, 'native-root'))?.projection.childrenOrder,
      [f.node.id, 'native-sibling']);
  } finally { f.store.close(); }
});

test('a remote same-parent move observed while paused is applied on rejoin without echo upload', async () => {
  const f = await rejoinFixture();
  try {
    await detachScopeMount(f.store, scope, 'mount-bar');
    const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
    await f.store.putRemoteObservation(scope, { colpId: 'node-child', remoteRevision: 'revision-remote',
      cursor: 'cursor-remote', kind: 'placement', payload: { parentId: 'root-colp', afterId: null, beforeId: 'node-1' },
      sourceDigest: 'sha256:move-remote', observedAt: 1,
      pauseGeneration: scope.generation, pauseBoundaryVersion: mount.pauseBaseline!.boundaryVersion,
      pauseCursor: mount.pauseBaseline!.lastAppliedCursor });
    const joined = await rejoinScopeMount(f.store, scope, 'mount-bar',
      new Set(['native-root', 'native-node', 'native-child']), [], { ...f.native,
        readRemoteSnapshot: async () => ({ snapshotId: 'order-snapshot', revision: 'remote', syncCursor: 'remote',
          pageCount: 1, identityDigest: 'order', remoteFacts: [
            { nodeId: 'root-colp', parentId: null, kind: 'folder', title: 'root-colp', revision: 'revision-old', childrenRevision: 'order-new' },
            { nodeId: 'node-child', parentId: 'root-colp', kind: 'bookmark', title: 'node-child', url: 'https://example.test/', revision: 'revision-remote', position: 'a' },
            { nodeId: 'node-1', parentId: 'root-colp', kind: 'bookmark', title: 'node-1', url: 'https://example.test/', revision: 'revision-old', position: 'b' },
          ] }) });
    assert.equal(joined.mount.status, 'active');
    assert.deepEqual((await f.api.getChildren('native-root')).map(node => node.id), ['native-child', 'native-node']);
    await f.queue.recover();
    assert.equal((await f.store.listQueue(scope)).length, 0);
    assert.equal((await f.store.listRemoteObservations(scope)).length, 0);
  } finally { f.store.close(); }
});
