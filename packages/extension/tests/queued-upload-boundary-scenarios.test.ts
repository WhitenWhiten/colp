import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import type { SyncPush } from '@know-n/colp/types';
import type { BookmarkEventNode } from '../src/bookmark-event-codec.js';
import { buildAdvancedPlan } from '../src/bootstrap/advanced-plan.js';
import { activateAdvancedPlan, executeActiveAdvancedPlan } from '../src/bootstrap/advanced-run.js';
import type { AdvancedNativeApi } from '../src/bootstrap/advanced-local-executor.js';
import type { LocalNodeFact, MountFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { bookmark, fixture, folder, scope } from './bookmark-event-queue-harness.js';
import { endpoints, json } from './outbound-push-worker-harness.js';

// The only simulated boundaries are Chrome's native tree and the server's
// response. Plans, inbox capture, deletion journals, queue claims, attempt
// persistence, upload authorization and receipt settlement are production code.
async function scenario(options: { mappedNode?: boolean; mappedSubtree?: boolean } = {}) {
  const f = await fixture(new IDBFactory(), { ...options, autoFlush: true });
  const missing = new Set<string>();
  const get = f.api.get.bind(f.api), getChildren = f.api.getChildren.bind(f.api);
  f.api.get = async id => {
    if (missing.has(id)) throw new Error(`Can't find bookmark for id. ${id}`);
    return get(id);
  };
  f.api.getChildren = async id => {
    if (missing.has(id)) throw new Error(`Can't find bookmark for id. ${id}`);
    return (await getChildren(id)).filter(node => !missing.has(node.id));
  };
  const unexpected = async (): Promise<never> => { throw new Error('upload plan must not mutate Chrome'); };
  const advancedApi: AdvancedNativeApi = { get: f.api.get, getChildren: f.api.getChildren,
    create: unexpected, update: unexpected, move: unexpected, remove: unexpected };
  const requests: SyncPush[] = [];
  const bodies: string[] = [];
  const clock = { now: 1_000 };
  const sessions: PushSessionController = { async get() { return {
    credential: { accessToken: 'scenario-token' }, session: { sessionId: 'scenario-session',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
      credentialAuthorityDigest: 'a'.repeat(64), collection: { collectionId: scope.collectionId,
        serverCursor: 'cursor-before', serverRevision: 'revision-before' },
      replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } },
  }; } };
  const workerOptions: Parameters<typeof createOutboundPushWorker>[0] = {
    scope, store: f.store, sessions, endpoints: async () => endpoints,
    now: () => clock.now, ownerId: () => 'boundary-scenario-worker', random: () => 0,
    schedule: () => undefined,
    assertUploadAllowed: queue => assertQueuedUploadAllowed({ store: f.store, scope, queue,
      parentOf: async id => (await f.api.get(id))[0]?.parentId }),
    fetch: async (_url, init) => {
      const body = String(init?.body); bodies.push(body);
      const request = JSON.parse(body) as SyncPush; requests.push(request);
      return json(200, { batchId: request.batchId, serverCursor: 'cursor-after',
        results: request.operations.map(operation => ({ opId: operation.opId, sequence: operation.sequence,
          status: 'applied', targetId: operation.targetId ?? 'server-created-node', revision: 'revision-after',
          cursor: 'cursor-after', warnings: [] })) });
    },
  };
  return { ...f, advancedApi, missing, requests, bodies, clock, workerOptions };
}

async function queueAdvancedCreate(f: Awaited<ReturnType<typeof scenario>>, native: BookmarkEventNode) {
  f.api.put(native);
  const selected = await f.store.getMappingByNativeId(scope, 'root-selected'); assert.ok(selected);
  const mounts: MountFact[] = [{ nativeRootId: 'root-selected', rootRole: 'bookmarks-bar',
    remoteMountNodeId: selected.colpId }];
  const remote: RemoteNodeFact[] = [
    { nodeId: 'remote-root', parentId: null, kind: 'folder', title: 'Library', folderRole: 'root',
      revision: 'root-r1', childrenRevision: 'root-children-r1' },
    { nodeId: selected.colpId, parentId: 'remote-root', kind: 'folder', title: 'Selected root',
      folderRole: 'bookmarks-bar', revision: 'server-root-r1', childrenRevision: 'children-server-root-r1' },
    { nodeId: 'folder-colp', parentId: selected.colpId, kind: 'folder', title: 'Parent',
      revision: 'folder-revision-2', childrenRevision: 'children-folder-revision-2' },
  ];
  const local: LocalNodeFact[] = [
    { nativeId: 'root-selected', mountNativeRootId: 'root-selected', parentNativeId: '0', kind: 'folder', title: 'Selected root' },
    { nativeId: 'folder-parent', mountNativeRootId: 'root-selected', parentNativeId: 'root-selected', kind: 'folder', title: 'Parent' },
    { nativeId: native.id, mountNativeRootId: 'root-selected', parentNativeId: 'folder-parent',
      kind: 'bookmark', title: native.title, url: native.url },
  ];
  const boundaryVersion = (await f.store.getScope(scope))?.boundaryVersion ?? '0';
  const plan = buildAdvancedPlan({ scope, confirmationId: 'confirmed-upload', mode: 'upload', boundaryVersion,
    treeDigest: 'confirmed-native-tree', remoteSnapshotId: 'snapshot-before', remoteRevision: 'revision-before',
    remoteCursor: 'cursor-before', rootNodeId: 'remote-root', local, remote, mounts,
    mappings: [{ nativeId: 'root-selected', colpId: selected.colpId }, { nativeId: 'folder-parent', colpId: 'folder-colp' }] });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.action, 'create');
  const definitions = [...remote.map(fact => ({ kind: 'snapshot-fact', fact,
    nativeId: plan.matched.find(pair => pair.nodeId === fact.nodeId)?.nativeId ?? null })), ...plan.steps];
  const committed = await f.store.commitAdvancedPlan(scope, { planId: plan.planId,
    metadata: { mode: 'upload', boundaryVersion, confirmationId: 'confirmed-upload', treeDigest: plan.treeDigest,
      mounts: JSON.parse(JSON.stringify(mounts)) },
    steps: definitions.map(definition => JSON.parse(JSON.stringify(definition)) as JsonObject), now: 1_000 });
  await activateAdvancedPlan(f.store, scope, committed);
  assert.equal(await executeActiveAdvancedPlan(f.store, scope, f.advancedApi), true);
  const rows = await f.store.listQueue(scope); assert.equal(rows.length, 1);
  const queued = rows[0]!;
  assert.match(queued.opId, /^ab\./);
  assert.equal(queued.status, 'pending');
  assert.equal(queued.attempt, undefined);
  assert.equal((await f.store.listBookmarkEventsByOperation(scope, queued.opId)).length, 0,
    'advanced provenance must come from the durable plan, not an ordinary event row');
  return { plan, queued };
}

test.each(['before_admission', 'after_attempt_persist'] as const)(
  'a confirmed advanced upload stops when its native source leaves the range %s', async when => {
    const f = await scenario();
    try {
      const native = bookmark('advanced-source', 'folder-parent', 0, 'Newly private research', 'https://example.test/private-research');
      const { plan, queued } = await queueAdvancedCreate(f, native);
      let checkedPersistedAttempt = false;
      const withdraw = () => f.api.put({ ...native, parentId: 'root-unselected' });
      if (when === 'before_admission') { withdraw(); f.store.close(); }
      await createOutboundPushWorker({ ...f.workerOptions,
        ...(when === 'after_attempt_persist' ? { beforeDispatch: async row => {
          assert.ok((await f.store.getQueueByOpId(scope, row.opId))?.attempt);
          checkedPersistedAttempt = true; withdraw();
        } } : {}),
      }).drain();
      assert.equal(f.bodies.length, 0, 'no private bookmark body may reach fetch');
      assert.equal(checkedPersistedAttempt, when === 'after_attempt_persist');
      const retained = await f.store.getQueueByOpId(scope, queued.opId);
      assert.equal(retained?.status, 'rejected');
      assert.deepEqual(retained?.payload, queued.payload);
      assert.equal(retained?.sequence, queued.sequence);
      assert.equal(retained?.digest, queued.digest);
      assert.equal((await f.api.get(native.id))[0]?.parentId, 'root-unselected');
      assert.equal((await f.api.get(native.id))[0]?.title, native.title);
      await executeActiveAdvancedPlan(f.store, scope, f.advancedApi);
      assert.equal((await f.store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'attention');
      assert.equal(f.requests.length, 0);
    } finally { f.store.close(); }
  });

test.each(['bookmark', 'folder'] as const)(
  'a captured local %s deletion still dispatches after Chrome removes the native node', async kind => {
    const f = await scenario(kind === 'bookmark' ? { mappedNode: true } : { mappedSubtree: true });
    try {
      const child = bookmark('mapped', 'folder-parent', 0, 'Server before', 'https://example.test/before');
      f.api.put(child);
      const removed = kind === 'bookmark' ? child : folder('folder-parent', 'root-selected', 0, 'Parent', [child]);
      const parentId = removed.parentId;
      f.missing.add(removed.id);
      if (kind === 'folder') f.missing.add(child.id);
      assert.equal((await f.queue.removed(removed.id, { parentId, index: 0, node: removed })).outcome, 'staged');
      const queued = (await f.store.listQueue(scope))[0]; assert.ok(queued);
      assert.equal(queued.payload.type, kind === 'bookmark' ? 'delete_node' : 'delete_subtree');
      assert.ok((await f.store.listDeletionJournal(scope, removed.id)).some(entry => entry.parentNativeId === parentId));
      assert.equal(await f.store.getMappingByNativeId(scope, removed.id), null);
      await assert.rejects(f.api.get(removed.id), /Can't find bookmark/);
      f.store.close();
      const worker = createOutboundPushWorker(f.workerOptions);
      assert.equal((await worker.drain()).outcome, 'terminal');
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0]?.operations[0]?.type, queued.payload.type);
      assert.equal(f.requests[0]?.operations[0]?.targetId, queued.payload.targetId);
      assert.equal((await f.store.getQueueByOpId(scope, queued.opId))?.status, 'terminal');
      assert.equal((await f.store.getQueueReceipt(scope, queued.sequence))?.opId, queued.opId);
      assert.equal((await worker.drain()).outcome, 'idle');
      assert.equal(f.requests.length, 1, 'receipt settlement prevents a duplicate deletion');
    } finally { f.store.close(); }
  });

test('a missing native without a captured removal keeps its edit retryable without dispatching it', async () => {
  const f = await scenario({ mappedNode: true });
  try {
    const native = bookmark('mapped', 'folder-parent', 0, 'Offline edit', 'https://example.test/before');
    f.api.put(native);
    await f.queue.changed(native.id, { title: native.title });
    const queued = (await f.store.listQueue(scope))[0]; assert.ok(queued);
    f.missing.add(native.id);
    assert.deepEqual(await f.store.listDeletionJournal(scope, native.id), []);
    assert.equal((await createOutboundPushWorker(f.workerOptions).drain()).outcome, 'unknown');
    const held = await f.store.getQueueByOpId(scope, queued.opId); assert.ok(held);
    assert.equal(held.attempt, undefined);
    assert.deepEqual(held.payload, queued.payload);
    assert.equal(held.sequence, queued.sequence);
    assert.equal(held.digest, queued.digest);
    assert.equal(await f.store.getQueueReceipt(scope, held.sequence), null);
    assert.ok(await f.store.getMappingByNativeId(scope, native.id));
    f.clock.now = held.retry.notBefore;
    f.store.close();
    assert.equal((await createOutboundPushWorker(f.workerOptions).drain()).outcome, 'unknown');
    assert.equal(f.bodies.length, 0);
    assert.equal((await f.store.listQueue(scope)).length, 1, 'missing native proof must not fabricate a delete');
  } finally { f.store.close(); }
});

test('temporary bookmark-tree unavailability holds uploads until root authority is restored', async () => {
  const f = await scenario({ mappedNode: true });
  try {
    const native = bookmark('mapped', 'folder-parent', 0, 'Waiting for Chrome', 'https://example.test/before');
    f.api.put(native); await f.queue.changed(native.id, { title: native.title });
    const queued = (await f.store.listQueue(scope))[0]; assert.ok(queued);
    await f.store.setBrowserRootStatus(scope, 'tree_unavailable');
    assert.equal((await createOutboundPushWorker(f.workerOptions).drain()).outcome, 'unknown');
    assert.equal(f.requests.length, 0);
    const waiting = await f.store.getQueueByOpId(scope, queued.opId); assert.ok(waiting);
    await f.store.reconcileBrowserRoots(scope, [
      { nativeId: 'root-selected', ancestorNativeIds: [] }, { nativeId: 'root-private', ancestorNativeIds: [] },
    ]);
    f.clock.now = waiting.retry.notBefore;
    assert.equal((await createOutboundPushWorker(f.workerOptions).drain()).outcome, 'terminal');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]?.operations[0]?.opId, queued.opId);
    assert.equal(f.requests[0]?.operations[0]?.sequence, queued.sequence);
    assert.equal((await f.api.get(native.id))[0]?.title, native.title);
  } finally { f.store.close(); }
});
