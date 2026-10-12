import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { activateAdvancedPlan, executeActiveAdvancedPlan } from '../src/bootstrap/advanced-run.js';
import { buildAdvancedPlan } from '../src/bootstrap/advanced-plan.js';
import type { AdvancedNativeApi } from '../src/bootstrap/advanced-local-executor.js';
import type { JsonObject, QueueOperation } from '../src/sync-state-store.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import type { LocalNodeFact, MountFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { active, scope } from './kns-03-bootstrap-harness.js';

const root: RemoteNodeFact = { nodeId: 'remote-root', parentId: null, kind: 'folder', title: '', folderRole: 'root',
  revision: 'root-revision', childrenRevision: 'root-children' };
const bar: RemoteNodeFact = { nodeId: 'remote-bar', parentId: root.nodeId, kind: 'folder', title: 'Bookmarks bar',
  folderRole: 'bookmarks-bar', revision: 'bar-revision', childrenRevision: 'bar-children' };
const bookmark: RemoteNodeFact = { nodeId: 'remote-bookmark', parentId: bar.nodeId, kind: 'bookmark', title: 'Old title',
  url: 'https://example.test/old', revision: 'bookmark-revision', position: '0' };
const localBar: LocalNodeFact = { nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: null,
  kind: 'folder', title: 'Bookmarks bar' };
const localBookmark: LocalNodeFact = { nativeId: 'local-bookmark', mountNativeRootId: 'bar', parentNativeId: 'bar',
  kind: 'bookmark', title: 'New title', url: 'https://example.test/new' };
const mount: MountFact = { nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: bar.nodeId };

test.each([
  ['missing targetId', { targetId: undefined }],
  ['wrong targetId', { targetId: 'remote-other' }],
  ['wrong result sequence', { sequence: 99 }],
  ['wrong result opId', { opId: 'other-operation' }],
] as const)('rejects a non-create receipt with %s', async (_label, override) => {
  const { store, plan } = await installUpdatePlan('receipt-binding');
  await executeActiveAdvancedPlan(store, scope, nativeApi());
  const queued = await pendingQueue(store);
  await settle(store, queued, { status: 'applied', targetId: bookmark.nodeId, revision: 'bookmark-after', ...override });
  await executeActiveAdvancedPlan(store, scope, nativeApi());
  const loaded = await store.readAdvancedPlan(scope, plan.planId);
  assert.equal(loaded?.plan.state, 'attention');
  assert.equal(loaded?.steps.at(-1)?.error, 'advanced_receipt_invalid');
});

test('accepts a noop without targetId only after a matching complete snapshot supplies revision', async () => {
  const { store, plan } = await installUpdatePlan('noop-without-target');
  const after: RemoteNodeFact = { ...bookmark, title: localBookmark.title, url: localBookmark.url,
    revision: 'bookmark-after' };
  await executeActiveAdvancedPlan(store, scope, nativeApi());
  const queued = await pendingQueue(store);
  await settle(store, queued, { status: 'noop', targetId: undefined });
  await executeActiveAdvancedPlan(store, scope, nativeApi(), async () => [root, bar, after]);
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'completed');
  assert.equal((await store.getMappingByNativeId(scope, localBookmark.nativeId))?.projection.revision, after.revision);
});

test('rejects a noop when the complete snapshot does not match the planned postcondition', async () => {
  const { store, plan } = await installUpdatePlan('noop-mismatch');
  await executeActiveAdvancedPlan(store, scope, nativeApi());
  const queued = await pendingQueue(store);
  await settle(store, queued, { status: 'noop', targetId: bookmark.nodeId });
  await executeActiveAdvancedPlan(store, scope, nativeApi(), async () => [root, bar, bookmark]);
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'attention');
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.steps.at(-1)?.error, 'advanced_receipt_invalid');
});

test('does not accept a noop delete while the target remains live', async () => {
  const { store, plan } = await installDeletePlan('delete-live-noop');
  await executeActiveAdvancedPlan(store, scope, nativeApi());
  const queued = await pendingQueue(store);
  await settle(store, queued, { status: 'noop', targetId: undefined });
  await executeActiveAdvancedPlan(store, scope, nativeApi(), async () => [root, bar, bookmark]);
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'attention');
});

test('accepts a noop delete only when a new complete snapshot proves the target is absent', async () => {
  const { store, plan } = await installDeletePlan('delete-absent-noop');
  await executeActiveAdvancedPlan(store, scope, nativeApi());
  const queued = await pendingQueue(store);
  await settle(store, queued, { status: 'noop', targetId: undefined });
  await executeActiveAdvancedPlan(store, scope, nativeApi(), async () => [root, bar]);
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'completed');
});

test('validates a rebased special mount against the scoped snapshot before replacing a placeholder collision', async () => {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); await active(store);
  const plan = buildAdvancedPlan({ scope, confirmationId: 'rebased-mount', mode: 'upload', boundaryVersion: '1',
    treeDigest: 'tree', remoteSnapshotId: 'snapshot', remoteRevision: 'revision', remoteCursor: 'cursor',
    local: [localBar], remote: [root], mappings: [], mounts: [{ ...mount, remoteMountNodeId: null }], rootNodeId: root.nodeId });
  const committed = await store.commitAdvancedPlan(scope, { planId: plan.planId,
    metadata: { mode: 'upload', mounts: JSON.parse(JSON.stringify([{ ...mount, remoteMountNodeId: null }])),
      confirmationId: 'rebased-mount', treeDigest: 'tree' },
    steps: [...[root].map((fact) => ({ kind: 'snapshot-fact', fact, nativeId: null })), ...plan.steps]
      .map((step) => JSON.parse(JSON.stringify(step)) as JsonObject), now: 10 });
  await activateAdvancedPlan(store, scope, committed);
  await store.putMapping(scope, { nativeId: 'unmounted:existing-bar', colpId: 'existing-bar', rootNativeId: 'unmounted:root',
    nodeKind: 'folder', projection: { revision: 'snapshot-existing', digest: 'sha256:existing',
      content: { title: 'Existing bar', folderRole: 'bookmarks-bar' } } });
  await executeActiveAdvancedPlan(store, scope, nativeApi());
  const queued = await pendingQueue(store);
  await settle(store, queued, { status: 'rebased', targetId: 'existing-bar', revision: 'existing-revision' });
  const existing: RemoteNodeFact = { nodeId: 'existing-bar', parentId: root.nodeId, kind: 'folder', title: 'Existing bar',
    folderRole: 'bookmarks-bar', revision: 'existing-revision', childrenRevision: 'existing-children' };
  await executeActiveAdvancedPlan(store, scope, nativeApi(), async () => [root, existing]);
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'completed');
  assert.equal((await store.getMappingByNativeId(scope, 'bar'))?.colpId, existing.nodeId);
  assert.equal(await store.getMappingByNativeId(scope, 'unmounted:existing-bar'), null);
  assert.equal((await store.listMountBindings(scope)).find((item) => item.nativeRootId === 'bar')?.remoteMountNodeId,
    existing.nodeId);
});

test('leaves a live mapping intact when a create receipt target collides with another native node', async () => {
  const { store, plan } = await installUpdatePlan('mapping-collision');
  await store.putMapping(scope, { nativeId: 'other-native', colpId: bookmark.nodeId, rootNativeId: 'bar', nodeKind: 'bookmark',
    projection: { revision: 'other-revision', digest: 'sha256:other', content: { title: bookmark.title, url: bookmark.url! } } });
  await executeActiveAdvancedPlan(store, scope, nativeApi());
  const queued = await pendingQueue(store);
  await settle(store, queued, { status: 'applied', targetId: bookmark.nodeId, revision: 'bookmark-after' });
  await executeActiveAdvancedPlan(store, scope, nativeApi());
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'attention');
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.steps.at(-1)?.error, 'advanced_mapping_collision');
  assert.equal((await store.getMappingByNativeId(scope, 'other-native'))?.projection.revision, 'other-revision');
});

async function installUpdatePlan(confirmationId: string) {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); await active(store);
  const plan = buildAdvancedPlan({ scope, confirmationId, mode: 'upload', boundaryVersion: '1', treeDigest: `tree-${confirmationId}`,
    remoteSnapshotId: `snapshot-${confirmationId}`, remoteRevision: `revision-${confirmationId}`,
    remoteCursor: `cursor-${confirmationId}`, local: [localBar, localBookmark], remote: [root, bar, bookmark],
    mappings: [{ nativeId: localBar.nativeId, colpId: bar.nodeId }, { nativeId: localBookmark.nativeId, colpId: bookmark.nodeId }],
    mounts: [mount], rootNodeId: root.nodeId });
  await install(store, plan, [root, bar, bookmark], [mount]);
  return { store, plan };
}

async function installDeletePlan(confirmationId: string) {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); await active(store);
  const plan = buildAdvancedPlan({ scope, confirmationId, mode: 'upload', boundaryVersion: '1', treeDigest: `tree-${confirmationId}`,
    remoteSnapshotId: `snapshot-${confirmationId}`, remoteRevision: `revision-${confirmationId}`,
    remoteCursor: `cursor-${confirmationId}`, local: [localBar], remote: [root, bar, bookmark],
    mappings: [{ nativeId: localBar.nativeId, colpId: bar.nodeId }], mounts: [mount], rootNodeId: root.nodeId });
  await install(store, plan, [root, bar, bookmark], [mount]);
  return { store, plan };
}

async function install(store: ReturnType<typeof createSyncStateStore>, plan: ReturnType<typeof buildAdvancedPlan>,
  remote: readonly RemoteNodeFact[], mounts: readonly MountFact[]): Promise<void> {
  const definitions = [...remote.map((fact) => ({ kind: 'snapshot-fact', fact,
    nativeId: fact.nodeId === root.nodeId ? null : fact.nodeId === bar.nodeId ? localBar.nativeId : null })), ...plan.steps];
  const committed = await store.commitAdvancedPlan(scope, { planId: plan.planId,
    metadata: { mode: plan.mode, mounts: JSON.parse(JSON.stringify(mounts)), confirmationId: plan.planId, treeDigest: plan.treeDigest },
    steps: definitions.map((step) => JSON.parse(JSON.stringify(step)) as JsonObject), now: 10 });
  await activateAdvancedPlan(store, scope, committed);
}

async function pendingQueue(store: ReturnType<typeof createSyncStateStore>): Promise<QueueOperation> {
  const rows = await store.listQueue(scope, 'pending', 0, 10); assert.equal(rows.length, 1); return rows[0]!;
}

async function settle(store: ReturnType<typeof createSyncStateStore>, queue: QueueOperation, result: {
  readonly status: 'applied' | 'rebased' | 'noop'; readonly targetId?: string; readonly revision?: string;
  readonly sequence?: number; readonly opId?: string;
}): Promise<void> {
  await store.completeQueueWithReceipt(scope, queue.sequence, {
    opId: queue.opId, operationDigest: queue.digest, kind: 'terminal', receiptId: `receipt-${queue.sequence}-${result.status}`,
    resultDigest: `sha256:receipt-${queue.sequence}-${result.status}`,
    result: { batchId: queue.batchId, serverCursor: `cursor-${queue.sequence}`, results: [{
      opId: result.opId ?? queue.opId, sequence: result.sequence ?? queue.sequence, status: result.status,
      ...(result.targetId === undefined ? {} : { targetId: result.targetId }),
      ...(result.revision === undefined ? {} : { revision: result.revision }), warnings: [],
    }] },
  });
}

function nativeApi(): AdvancedNativeApi {
  return {
    async get() { return []; }, async getChildren() { return []; },
    async create() { throw new Error('unexpected_create'); }, async update() { throw new Error('unexpected_update'); },
    async move() { throw new Error('unexpected_move'); }, async remove() { throw new Error('unexpected_remove'); },
  };
}
