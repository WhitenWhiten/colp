import assert from 'node:assert/strict';
import { canonicalAuthoritativeEffectDigest } from '@know-n/colp/sync';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import { boundNativeId } from '../src/pull-mount-apply.js';
import { bootstrapOpId } from '../src/bootstrap/run-identity.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { recoverVerifiedOrFreeze, leftoverVirtualChildrenNeedReproject } from '../src/recovery-guard.js';
import { CHROME_BOOKMARK_NOT_FOUND } from '../src/bookmark-api-error.js';
import { createSyncStateStore, type JsonObject, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { endpoints, json, problem } from './outbound-push-worker-harness.js';

const scope: SyncScope = { environment: 'development', serverId: 'lifecycle-server', serverOrigin: 'https://known.example',
  accountId: 'account-lifecycle', browserProfileId: 'profile-lifecycle', collectionId: 'collection-lifecycle',
  replicaId: 'replica-lifecycle', generation: 1 };
const mountId = 'mount-colp';
const collectionRoot = 'root-colp';

test('an own ordinary selected-folder create binds its native root through an unselected ancestor', async () => {
  const f = await setup();
  try {
    await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: mountId,
      boundaryVersion: '1', materialized: false, status: 'detached', rootRole: 'bookmarks-bar' });
    await f.store.putMountBinding(scope, { mountId: 'selected', nativeRootId: '2', remoteMountNodeId: null,
      boundaryVersion: '1', materialized: false, status: 'pending', customSourceKey: 'folder:2' });
    f.nodes.set('2', { id: '2', parentId: '1', title: 'Selected' });
    const event = pullFixtures.createEvent({ kind: 'Folder', sequence: 1, collectionId: scope.collectionId,
      parentId: mountId, replicaId: scope.replicaId, title: 'Selected',
      opId: bootstrapOpId('confirm', 'mount', 'folder:2') });
    await f.apply([event]);
    assert.equal((await f.store.getMappingByColpId(scope, 'node-created-1'))?.nativeId, '2');
    assert.equal((await f.store.listMountBindings(scope)).find(row => row.mountId === 'selected')?.status, 'active');
    assert.deepEqual(f.calls, []);
  } finally { f.store.close(); }
});

test('an acknowledged create echo refreshes the source fence after its native anchor moved locally', async () => {
  const f = await setupMovedAnchor();
  try {
    const bodies: Array<{ batchId: string; operations: Array<{ opId: string; sequence: number; payload: {
      baseSourceParentRevision: string; baseTargetParentRevision: string } }> }> = [];
    const clock = { now: Date.now() };
    const sessions: PushSessionController = { async get() { return { credential: { accessToken: 'fixture-token' },
      session: { sessionId: 'session-lifecycle', credentialAuthorityDigest: 'a'.repeat(64), acceptedProtocolVersion: '0.2',
        expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
        collection: { collectionId: scope.collectionId, serverCursor: 'cursor-start', serverRevision: 'r1' },
        replicaLease: { leaseId: 'lease-lifecycle', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }; } };
    const worker = createOutboundPushWorker({ scope, store: f.store, sessions,
      endpoints: async () => ({ syncPush: 'https://known.example/push', syncPull: 'https://known.example/pull',
        syncAck: 'https://known.example/ack', syncSessions: 'https://known.example/sessions',
        syncSnapshot: 'https://known.example/snapshot', syncConflict: 'https://known.example/conflicts/{conflictId}',
        syncRetire: 'https://known.example/retire', syncEffectPages: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
        effectPageAuthority: 'https://known.example' }), now: () => clock.now,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as typeof bodies[number]; bodies.push(body);
        const op = body.operations[0]!;
        if (op.payload.baseSourceParentRevision !== 'children-1') return new Response(JSON.stringify({
          type: 'https://known.example/position_context_stale', title: 'Stale', code: 'position_context_stale',
          status: 409, retryable: true }), { status: 409, headers: { 'Content-Type': 'application/problem+json' } });
        assert.equal(op.payload.baseTargetParentRevision, 'children-dest');
        return new Response(JSON.stringify({ batchId: body.batchId, serverCursor: 'cursor-moved', results: [{
          opId: op.opId, sequence: op.sequence, status: 'applied', revision: 'revision-moved', cursor: 'cursor-moved', warnings: [],
        }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const nativeCalls = f.calls.length;
    await f.apply([f.createEcho]);
    assert.equal(f.calls.length, nativeCalls, 'an applied own create must not re-create or re-place Chrome nodes');
    assert.equal((await f.store.getMappingByColpId(scope, mountId))?.projection.childrenRevision, 'children-1');
    clock.now = Math.max(clock.now, (await f.store.getQueueByOpId(scope, f.move.opId))!.retry.notBefore);
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1]!.operations[0]!.opId, f.move.opId);
    assert.equal(bodies[1]!.operations[0]!.sequence, f.move.sequence);
    assert.equal(f.nodes.get('native-existing')?.parentId, 'native-dest');
    assert.equal((await f.store.getQueueByOpId(scope, f.move.opId))?.status, 'terminal');
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-page-1');
  } finally { f.store.close(); }
});

for (const proof of ['foreign replica', 'unacknowledged create', 'missing native', 'different native parent'] as const) {
  test(`moved anchors stay fail-closed for a create with ${proof}`, async () => {
    const f = await setupMovedAnchor(proof);
    try {
      const calls = f.calls.length;
      await assert.rejects(() => f.apply([f.createEcho]), /anchor_parent_mismatch|recovery_required/);
      assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, true);
      assert.equal((await f.store.getCursor(scope))?.cursor, undefined);
      assert.equal(f.calls.length, calls);
    } finally { f.store.close(); }
  });
}

async function setupMovedAnchor(proof?: 'foreign replica' | 'unacknowledged create' | 'missing native' | 'different native parent') {
  const f = await setup();
  await f.seed('node-existing');
  f.nodes.set('native-dest', { id: 'native-dest', parentId: '1', title: 'Existing', index: 1 });
  const dest = mapping('native-dest', 'folder-dest', mountId, 'folder');
  await f.store.putMapping(scope, { ...dest, projection: { ...dest.projection, childrenRevision: 'children-dest' } });
  const createEcho = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
    parentId: mountId, afterId: 'node-existing', replicaId: proof === 'foreign replica' ? 'replica-peer' : scope.replicaId });
  assert.ok(createEcho.kind === 'operation' && createEcho.effect.kind === 'node_created');
  const queued = await f.store.allocateSequenceAndEnqueue(scope, { opId: createEcho.operation.opId,
    batchId: 'batch-create', idempotencyKey: 'key-create', digest: 'sha256:create', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: 'revision-create', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: JSON.parse(JSON.stringify(createEcho.operation)) as JsonObject }, { allowUnstamped: true });
  if (proof !== 'unacknowledged create') await f.store.completeQueueWithReceipt(scope, queued.sequence, {
    opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-create',
    resultDigest: 'sha256:create-result' });
  const own = mapping('native-perm', createEcho.effect.node.id, mountId);
  await f.store.putMapping(scope, { ...own, projection: { ...own.projection,
    content: { title: 'Remote', url: 'https://example.test/' } } });
  if (proof !== 'missing native') f.nodes.set('native-perm', { id: 'native-perm',
    parentId: proof === 'different native parent' ? 'native-dest' : '1', title: 'Remote', url: 'https://example.test/', index: 2 });
  let ids = 0;
  const queue = createBookmarkEventQueue({ scope, store: f.store, autoFlush: false, uuid: () => `move-event-${++ids}`,
    api: { get: async (id) => (await f.api.get(id)).map((node) => ({ ...node, title: node.title ?? '' })),
      getChildren: async (id) => (await f.api.getChildren(id)).map((node) => ({ ...node, title: node.title ?? '' })) } });
  await f.api.move('native-existing', { parentId: 'native-dest', index: 0 });
  await queue.moved('native-existing', { parentId: 'native-dest', index: 0, oldParentId: '1', oldIndex: 0 });
  await queue.flush();
  const move = (await f.store.listQueue(scope)).find((row) => row.payload.type === 'move_node');
  assert.ok(move);
  return { ...f, move, createEcho, eventQueue: queue };
}

for (const change of ['pending', 'terminal', 'move then rename', 'pending next move', 'no captured move', 'wrong destination', 'wrong post-state', 'unbound receipt revision'] as const) {
  test(`a Node moved before its own create echo requires exact durable placement evidence (${change})`, async () => {
    const f = await setupMovedAnchor();
    try {
      await addFolder(f, 'native-second', 'folder-second');
      await f.api.move('native-perm', { parentId: 'native-second', index: 0 });
      if (change !== 'no captured move') {
        await f.eventQueue.moved('native-perm', { parentId: 'native-second', index: 0, oldParentId: '1', oldIndex: 2 });
        await f.eventQueue.flush();
      }
      if (change === 'move then rename' || change === 'no captured move') {
        await f.api.update('native-perm', { title: 'Renamed locally' });
        await f.eventQueue.changed('native-perm', { title: 'Renamed locally' });
        await f.eventQueue.flush();
      }
      if (change === 'terminal' || change === 'unbound receipt revision') await settleMoves(f.store);
      if (change === 'pending next move') {
        await f.api.move('native-perm', { parentId: 'native-dest', index: 1 });
        await f.eventQueue.moved('native-perm', { parentId: 'native-dest', index: 1, oldParentId: 'native-second', oldIndex: 0 });
        await f.eventQueue.flush();
      }
      if (change === 'wrong destination') {
        await f.api.move('native-perm', { parentId: 'native-dest', index: 1 });
        const { scopeKey: _key, ...row } = (await f.store.getMappingByNativeId(scope, 'native-perm'))!;
        await f.store.putMapping(scope, { ...row, parentNativeId: 'native-dest' });
      }
      if (change === 'wrong post-state') await f.api.update('native-perm', { title: 'Uncaptured title' });
      if (change === 'unbound receipt revision') {
        const { scopeKey: _key, ...row } = (await f.store.getMappingByNativeId(scope, 'native-perm'))!;
        await f.store.putMapping(scope, { ...row, projection: { ...row.projection,
          revision: 'server-unproven', resourceRevision: 'server-unproven' } });
      }
      const before = await f.store.getMappingByNativeId(scope, 'native-perm');
      const calls = f.calls.length;
      if (change === 'pending' || change === 'terminal' || change === 'move then rename' || change === 'pending next move') {
        await f.apply([f.createEcho]);
        assert.equal(f.nodes.get('native-perm')?.parentId, change === 'pending next move' ? 'native-dest' : 'native-second');
        assert.deepEqual(await f.store.getMappingByNativeId(scope, 'native-perm'), before);
        assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-page-1');
      } else {
        await assert.rejects(() => f.apply([f.createEcho]), /recovery_required/);
        assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, true);
        assert.equal((await f.store.getCursor(scope))?.cursor, undefined);
      }
      assert.equal(f.calls.length, calls);
    } finally { f.store.close(); }
  });
}

for (const refreshed of [undefined, 'folder-d', 'folder-b']) {
  test(`successive A→B→C moves distinguish optimistic C from refreshed authority (refresh=${refreshed})`, async () => {
    const f = await setup();
    try {
      await addFolder(f, 'native-b', 'folder-b'); await addFolder(f, 'native-c', 'folder-c');
      await addFolder(f, 'native-d', 'folder-d');
      f.nodes.set('native-existing', { id: 'native-existing', parentId: '1', index: 0, title: 'Remote', url: 'https://example.test/' });
      const item = mapping('native-existing', 'node-existing', mountId);
      await f.store.putMapping(scope, { ...item, projection: { ...item.projection, content: { title: 'Remote', url: 'https://example.test/' } } });
      let ids = 0;
      const queue = createBookmarkEventQueue({ scope, store: f.store, autoFlush: false, uuid: () => `rapid-${++ids}`,
        api: { get: async (id) => (await f.api.get(id)).map((row) => ({ ...row, title: row.title ?? '' })),
          getChildren: async (id) => (await f.api.getChildren(id)).map((row) => ({ ...row, title: row.title ?? '' })) } });
      for (const [oldParentId, parentId] of [['1', 'native-b'], ['native-b', 'native-c']] as const) {
        await f.api.move('native-existing', { parentId, index: 0 });
        await queue.moved('native-existing', { parentId, oldParentId, index: 0, oldIndex: 0 }); await queue.flush();
      }
      const queued = await f.store.listQueue(scope);
      assert.equal(queued.length, 1, 'the second move initially waits in the durable inbox');
      assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 1);
      const local = (await f.store.getMappingByColpId(scope, 'node-existing'))!;
      assert.equal(local.parentNativeId, 'native-b'); assert.equal(local.parentColpId, undefined);
      assert.equal(f.nodes.get('native-existing')?.parentId, 'native-c');
      assert.equal(local.projection.revision, queued[0]!.operationRevision);
      const clock = { now: Date.now() };
      let accept = false;
      const bodies: Array<{ operations: Array<{ opId: string; sequence: number; payload: {
        newParentId: string; baseSourceParentRevision: string; baseTargetParentRevision: string } }> }> = [];
      const worker = createOutboundPushWorker({ ...pushOptions(f.store, clock), fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as typeof bodies[number] & { batchId: string }; bodies.push(body);
        if (accept) { const op = body.operations[0]!;
          return json(200, { batchId: body.batchId, serverCursor: `cursor-${op.sequence}`, results: [{
            opId: op.opId, sequence: op.sequence, status: 'applied', revision: `server-rapid-${op.sequence}`,
            cursor: `cursor-${op.sequence}`, warnings: [],
          }] }); }
        return problem(409, 'position_context_stale', { retryable: true });
      } });
      assert.equal((await worker.drain()).outcome, 'unknown');
      assert.equal(bodies[0]!.operations[0]!.payload.newParentId, 'folder-b');
      assert.equal(bodies[0]!.operations[0]!.payload.baseSourceParentRevision, 'children-old');
      assert.equal(bodies[0]!.operations[0]!.payload.baseTargetParentRevision, 'children-folder-b');
      if (refreshed) {
        await f.apply([pullFixtures.mutationEvent({ kind: 'move', sequence: 40, collectionId: scope.collectionId,
          targetId: 'node-existing', parentId: refreshed })]);
        await queue.flush();
        assert.equal((await f.store.listQueue(scope)).length, 1, 'a Pull refresh must not release the later move before the first receipt');
        assert.equal((await f.store.getMappingByColpId(scope, 'node-existing'))?.parentColpId, refreshed);
        clock.now = Math.max(clock.now, (await f.store.getQueueByOpId(scope, queued[0]!.opId))!.retry.notBefore);
        await worker.drain();
        assert.equal(bodies[1]!.operations[0]!.payload.baseSourceParentRevision, 'children-40');
        assert.equal(bodies[1]!.operations[0]!.payload.newParentId, 'folder-b');
      }
      accept = true;
      clock.now = Math.max(clock.now, (await f.store.getQueueByOpId(scope, queued[0]!.opId))!.retry.notBefore);
      assert.equal((await worker.drain()).outcome, 'terminal');
      await f.apply([pullFixtures.mutationEvent({ kind: 'move', sequence: 41, collectionId: scope.collectionId,
        targetId: 'node-existing', parentId: 'folder-b' })]);
      await queue.flush();
      const tail = (await f.store.listQueue(scope))[1]!;
      assert.equal(tail.status, 'pending'); assert.equal(tail.attempt, undefined); assert.equal(tail.sequence, 2);
      assert.equal((await worker.drain()).outcome, 'terminal');
      assert.equal(bodies.at(-1)!.operations[0]!.opId, tail.opId);
      assert.equal(bodies.at(-1)!.operations[0]!.payload.baseSourceParentRevision, 'children-41');
      assert.equal(bodies.at(-1)!.operations[0]!.payload.newParentId, 'folder-c');
      await f.apply([pullFixtures.mutationEvent({ kind: 'move', sequence: 42, collectionId: scope.collectionId,
        targetId: 'node-existing', parentId: 'folder-c' })]);
      assert.equal(f.nodes.get('native-existing')?.parentId, 'native-c');
      assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
    } finally { f.store.close(); }
  });
}

async function addFolder(f: Awaited<ReturnType<typeof setup>>, nativeId: string, colpId: string) {
  f.nodes.set(nativeId, { id: nativeId, parentId: '1', title: 'Existing' });
  const row = mapping(nativeId, colpId, mountId, 'folder');
  await f.store.putMapping(scope, { ...row, projection: { ...row.projection, childrenRevision: `children-${colpId}` } });
}
function pushOptions(store: ReturnType<typeof createSyncStateStore>, clock: { now: number }) {
  const sessions: PushSessionController = { async get() { return { credential: { accessToken: 'fixture-token' },
    session: { sessionId: 'session-lifecycle', credentialAuthorityDigest: 'a'.repeat(64), acceptedProtocolVersion: '0.2',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-start', serverRevision: 'r1' },
      replicaLease: { leaseId: 'lease-lifecycle', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }; } };
  return { scope, store, sessions, endpoints: async () => endpoints, now: () => clock.now };
}
async function settleMoves(store: ReturnType<typeof createSyncStateStore>) {
  const clock = { now: Date.now() };
  const worker = createOutboundPushWorker({ ...pushOptions(store, clock), fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
    const op = body.operations[0]!;
    return json(200, { batchId: body.batchId, serverCursor: `cursor-${op.sequence}`, results: [{
      opId: op.opId, sequence: op.sequence, status: 'applied', revision: `server-move-${op.sequence}`,
      cursor: `cursor-${op.sequence}`, warnings: [],
    }] });
  } });
  assert.equal((await worker.drain()).outcome, 'terminal');
}

for (const preceding of ['create', 'update', 'move'] as const) {
  test(`one Pull page ${preceding} then delete cannot leave a ghost for the next recovery`, async () => {
    const f = await setup();
    try {
      const nodeId = preceding === 'create' ? 'node-created-1' : 'node-existing';
      if (preceding !== 'create') await f.seed(nodeId);
      const before = preceding === 'create' ? create(1) : mutation(preceding, 1, nodeId);
      await f.apply([before, mutation('delete', 2, nodeId)]);
      assert.equal([...f.nodes.values()].some((node) => node.url), false);
      // This is the late P3 trigger: a root-level remote bookmark remains
      // durable outside our mount and causes the old leftover scan to run.
      await f.apply([create(3, collectionRoot)]);
      const live = await f.store.listMappings(scope);
      await assert.doesNotReject(() => recoverVerifiedOrFreeze({ scope, store: f.store, api: f.api,
        staged: live.map(({ scopeKey: _key, ...mapping }) => ({ ...mapping, nativeId: `recovery:${mapping.colpId}` })),
        freezeUnprovenIdentity: true }));
      assert.equal(await f.store.getMappingByColpId(scope, nodeId), null);
      assert.equal(await leftoverVirtualChildrenNeedReproject(f.store, scope), false);
      assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-page-2');
      assert.ok((await f.store.listPullPages(scope)).every((page) => page.state === 'page_complete'));
    } finally { f.store.close(); }
  });
}

test('a terminal self-delete sees the earlier create in its current Pull page', async () => {
  const f = await setup();
  try {
    const deleted = pullFixtures.mutationEvent({ kind: 'delete', sequence: 2, collectionId: scope.collectionId,
      targetId: 'node-created-1', parentId: mountId, replicaId: scope.replicaId });
    assert.ok(deleted.operation);
    const queued = await f.store.allocateSequenceAndEnqueue(scope, { opId: deleted.operation.opId,
      batchId: 'batch-delete', idempotencyKey: 'key-delete', digest: 'sha256:delete', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: 'r1', operationRevision: 'delete-2', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { type: 'delete_node', targetId: 'node-created-1' } }, { allowUnstamped: true });
    await f.store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId, operationDigest: queued.digest,
      kind: 'terminal', receiptId: 'receipt-delete', resultDigest: 'sha256:delete-result' });
    await f.apply([create(1), deleted]);
    assert.equal([...f.nodes.values()].some((node) => node.url), false);
    assert.equal(await f.store.getMappingByColpId(scope, 'node-created-1'), null);
  } finally { f.store.close(); }
});

test('update, delete and restore of one Node in a page commit the restored identity only', async () => {
  const f = await setup();
  try {
    await f.seed('node-existing');
    await f.apply([mutation('update', 1, 'node-existing'), mutation('delete', 2, 'node-existing'),
      pullFixtures.restoreEvent({ sequence: 3, collectionId: scope.collectionId, targetId: 'node-existing',
        parentId: mountId, title: 'Restored' })]);
    const mapped = await f.store.getMappingByColpId(scope, 'node-existing');
    assert.ok(mapped);
    assert.notEqual(mapped.nativeId, 'native-existing');
    assert.equal(f.nodes.get(mapped.nativeId)?.title, 'Restored');
    assert.equal(await f.store.getMappingByNativeId(scope, 'native-existing'), null);
  } finally { f.store.close(); }
});

for (const prefix of ['sidecar:', 'unmounted:', 'recovery:']) {
  test(`a remote delete removes the ${prefix} mapping without a Chrome call`, async () => {
    const f = await setup();
    try {
      await f.store.putMapping(scope, mapping(`${prefix}node-existing`, 'node-existing', mountId,
        prefix === 'sidecar:' ? 'separator' : 'bookmark'));
      await f.apply([mutation('delete', 1, 'node-existing')]);
      assert.equal(f.calls.length, 0);
      assert.equal(await f.store.getMappingByColpId(scope, 'node-existing'), null);
    } finally { f.store.close(); }
  });
}

test('a genuine missing native becomes a local issue before Snapshot projection', async () => {
  const f = await setup();
  try {
    await f.store.putMapping(scope, mapping('native-unproven', 'node-unproven', mountId));
    const live = (await f.store.listMappings(scope)).map(({ scopeKey: _key, ...row }) => row);
    await recoverVerifiedOrFreeze({ scope, store: f.store, staged: live,
      api: f.api, freezeUnprovenIdentity: true });
    assert.deepEqual((await f.store.listLocalIssues(scope)).map(row => [row.nativeId, row.code]),
      [['native-unproven', 'recovery_identity_unproven']]);
    assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});

test('inherited mount membership and another replica custom key do not prove root identity', async () => {
  const f = await setup();
  try {
    const mounts = await f.store.listMountBindings(scope);
    const child = { ...mapping('recovery:child-folder', 'child-folder', mountId, 'folder'), mountId: 'mount-bar' };
    assert.equal(boundNativeId(child, mounts), child.nativeId);
    const foreign = { ...mapping('recovery:foreign-mount', 'foreign-mount', collectionRoot, 'folder'),
      rootRole: 'custom' as const, projection: { revision: 'r1', digest: 'sha256:custom',
        content: { title: 'Foreign', folderRole: 'custom', customSourceKey: 'folder:1' } } };
    const custom = { ...mounts[0]!, rootRole: undefined, customSourceKey: 'folder:1', remoteMountNodeId: 'own-custom-mount' };
    assert.equal(boundNativeId(foreign, [custom]), foreign.nativeId);
    await f.store.putMountBinding(scope, { mountId: custom.mountId, nativeRootId: custom.nativeRootId,
      remoteMountNodeId: custom.remoteMountNodeId, boundaryVersion: custom.boundaryVersion,
      materialized: false, status: 'active', customSourceKey: 'folder:1' });
    const staged = [{ ...mapping('recovery:root', collectionRoot, undefined, 'folder'), rootNativeId: 'recovery:root' }, foreign,
      mapping('recovery:foreign-child', 'foreign-child', foreign.colpId)];
    const result = await recoverVerifiedOrFreeze({ scope, store: f.store, staged, api: f.api, freezeUnprovenIdentity: true });
    assert.equal(result.find((row) => row.colpId === foreign.colpId)?.nativeId, foreign.nativeId);
    assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});

function create(sequence: number, parentId = mountId) {
  return pullFixtures.createEvent({ kind: 'Bookmark', sequence, collectionId: scope.collectionId, parentId });
}
function mutation(kind: 'update' | 'move' | 'delete', sequence: number, targetId: string) {
  const event = pullFixtures.mutationEvent({ kind, sequence, collectionId: scope.collectionId, targetId, parentId: mountId });
  if (event.kind === 'operation' && event.effect.kind === 'node_moved') {
    // Moving the seeded node does not rename it. Keep authoritative content
    // consistent with the known native projection in this placement fixture.
    const effect = { ...event.effect, node: { ...event.effect.node, title: 'Existing' } };
    return { ...event, effect: { ...effect, effectDigest: canonicalAuthoritativeEffectDigest(effect) } };
  }
  return event;
}
function mapping(nativeId: string, colpId: string, parentColpId?: string,
  nodeKind: MappingInput['nodeKind'] = 'bookmark'): MappingInput {
  return { nativeId, colpId, rootNativeId: '1', nodeKind,
    ...(parentColpId ? { parentNativeId: '1', parentColpId } : {}),
    projection: { revision: 'revision-old', childrenRevision: nodeKind === 'folder' ? 'children-old' : null,
      digest: `sha256:${colpId}`, content: { title: 'Existing',
        ...(nodeKind === 'bookmark' ? { url: 'https://example.test/' } : {}) } } };
}
async function setup() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-lifecycle', expiresAt: 9e15 },
    checkpoint: { serverRevision: 'r1', cursor: 'cursor-start' }, selectedRoots: [mountId], rootStatus: 'ready' });
  await store.putMapping(scope, { ...mapping(`recovery:${collectionRoot}`, collectionRoot, undefined, 'folder'),
    rootNativeId: `recovery:${collectionRoot}` });
  await store.putMapping(scope, { ...mapping('1', mountId, collectionRoot, 'folder'), rootRole: 'bookmarks-bar' });
  await store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: mountId,
    boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
  type Native = { id: string; parentId?: string; title?: string; url?: string; index?: number };
  const nodes = new Map<string, Native>([['1', { id: '1', title: 'Bookmarks bar' }]]);
  const calls: string[] = []; let nextId = 10;
  const existing = (id: string) => { const node = nodes.get(id); if (!node) throw new Error(CHROME_BOOKMARK_NOT_FOUND); return node; };
  // B3-1: honest reads. Real Chromium rejects an unknown id (`Can't find bookmark for id.`), so
  // "missing native" must be a rejection - an empty `get` answer is classified as `other_failure`
  // by `lookupBookmark` and can no longer stand in for absence.
  const api: PullBookmarkApi = {
    async get(id) { return [structuredClone(existing(id))]; },
    async getChildren(id) { existing(id); return [...nodes.values()].filter((node) => node.parentId === id)
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((node) => structuredClone(node)); },
    async create(input) { existing(input.parentId!); const id = String(++nextId); calls.push(`create:${id}`);
      nodes.set(id, { ...input, id }); return { id }; },
    async update(id, changes) { nodes.set(id, { ...existing(id), ...changes }); calls.push(`update:${id}`); },
    async move(id, destination) { nodes.set(id, { ...existing(id), ...destination }); calls.push(`move:${id}`); },
    async remove(id) { existing(id); nodes.delete(id); calls.push(`remove:${id}`); },
    async removeTree(id) { existing(id); for (const node of [...nodes.values()]) {
      if (node.parentId === id) await api.removeTree(node.id);
    } nodes.delete(id); calls.push(`remove:${id}`); },
  };
  const applier = createPullApplier({ scope, store, api, session: { acceptedProtocolVersion: '0.2',
    sessionId: 'session-lifecycle', collectionId: scope.collectionId, conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example' });
  let page = 0;
  return { store, nodes, api, calls,
    async seed(colpId: string) { nodes.set('native-existing', { id: 'native-existing', parentId: '1', index: 0,
      title: 'Existing', url: 'https://example.test/' }); await store.putMapping(scope, mapping('native-existing', colpId, mountId)); },
    async apply(events: readonly unknown[]) { page += 1;
      await applier.stage(pullFixtures.page({ events, nextCursor: `cursor-page-${page}`, collectionRevision: `revision-${page}` }));
      await applier.resume(); },
  };
}
