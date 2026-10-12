import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { activateAdvancedPlan, executeActiveAdvancedPlan } from '../src/bootstrap/advanced-run.js';
import { executeAdvancedRemoteStep } from '../src/bootstrap/advanced-remote-executor.js';
import { buildAdvancedPlan } from '../src/bootstrap/advanced-plan.js';
import type { AdvancedStep } from '../src/bootstrap/advanced-plan-types.js';
import type { AdvancedNativeApi, AdvancedNativeNode } from '../src/bootstrap/advanced-local-executor.js';
import type { JsonObject, QueueOperation } from '../src/sync-state-store.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import type { LocalNodeFact, MountFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { active, scope } from './kns-03-bootstrap-harness.js';

const uploadMount: MountFact = { nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: null };
const remoteRoot: RemoteNodeFact = {
  nodeId: 'remote-root', parentId: null, kind: 'folder', title: '', folderRole: 'root',
  revision: 'remote-root-revision', childrenRevision: 'remote-root-children',
};
const uploadLocal: LocalNodeFact[] = [
  { nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: null, kind: 'folder', title: 'Bookmarks bar' },
  { nativeId: 'local-bookmark', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
    title: 'Local bookmark', url: 'https://example.test/local' },
];

test('upload remote steps use opaque unique IDs and bind final native identity after receipts', async () => {
  const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); await active(store);
  const plan = buildAdvancedPlan({ scope, confirmationId: 'upload-confirm', mode: 'upload', boundaryVersion: '1',
    treeDigest: 'tree-upload', remoteSnapshotId: 'snapshot-upload', remoteRevision: 'revision-upload',
    remoteCursor: 'cursor-upload', local: uploadLocal, remote: [remoteRoot], mappings: [], mounts: [uploadMount],
    rootNodeId: remoteRoot.nodeId });
  const committed = await store.commitAdvancedPlan(scope, { planId: plan.planId,
    metadata: { mode: 'upload', mounts: JSON.parse(JSON.stringify([uploadMount])), confirmationId: 'upload-confirm', treeDigest: 'tree-upload' },
    steps: plan.steps.map((step) => JSON.parse(JSON.stringify(step)) as JsonObject), now: 10 });
  await activateAdvancedPlan(store, scope, committed);

  await executeActiveAdvancedPlan(store, scope, nativeApi());
  let queue = await pendingQueue(store);
  assert.match(queue.opId, /^[A-Za-z0-9._~-]+$/u);
  await settle(store, queue, 'remote-bar-created', 'revision-bar');

  await executeActiveAdvancedPlan(store, scope, nativeApi());
  queue = await pendingQueue(store);
  assert.match(queue.opId, /^[A-Za-z0-9._~-]+$/u);
  await settle(store, queue, 'remote-bookmark-created', 'revision-bookmark');

  await executeActiveAdvancedPlan(store, scope, nativeApi());
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'completed');
  const mountMapping = await store.getMappingByNativeId(scope, 'bar');
  assert.equal(mountMapping?.nativeId, 'bar');
  assert.equal(mountMapping?.colpId, 'remote-bar-created');
  const bookmark = await store.getMappingByNativeId(scope, 'local-bookmark');
  assert.equal(bookmark?.colpId, 'remote-bookmark-created');
  assert.equal(bookmark?.parentNativeId, 'bar');
  assert.equal(bookmark?.parentColpId, 'remote-bar-created');
  assert.equal(bookmark?.rootNativeId, 'bar');
  assert.equal(bookmark?.mountId, 'mount:bar');
});

test('a transient local get failure never completes a remove as if the node were absent', async () => {
  const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); await active(store);
  const local: LocalNodeFact[] = [
    { nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: null, kind: 'folder', title: 'Bookmarks bar' },
    { nativeId: 'local-only', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
      title: 'Local only', url: 'https://example.test/local-only' },
  ];
  const remoteBar: RemoteNodeFact = { ...remoteRoot, nodeId: 'remote-bar', parentId: remoteRoot.nodeId,
    title: 'Bookmarks bar', folderRole: 'bookmarks-bar', revision: 'revision-bar', childrenRevision: 'children-bar' };
  const plan = buildAdvancedPlan({ scope, confirmationId: 'download-confirm', mode: 'download', boundaryVersion: '1',
    treeDigest: 'tree-download', remoteSnapshotId: 'snapshot-download', remoteRevision: 'revision-download',
    remoteCursor: 'cursor-download', local, remote: [remoteRoot, remoteBar], mappings: [], mounts: [
      { ...uploadMount, remoteMountNodeId: 'remote-bar' },
    ], rootNodeId: remoteRoot.nodeId });
  const definitions = [
    ...[remoteRoot, remoteBar]
      .map((fact) => ({ kind: 'snapshot-fact', fact, nativeId: fact.nodeId === remoteRoot.nodeId ? null : 'bar' })),
    ...plan.steps,
  ];
  const committed = await store.commitAdvancedPlan(scope, { planId: plan.planId,
    metadata: { mode: 'download', mounts: JSON.parse(JSON.stringify([{ ...uploadMount, remoteMountNodeId: 'remote-bar' }])),
      confirmationId: 'download-confirm', treeDigest: 'tree-download' },
    steps: definitions.map((step) => JSON.parse(JSON.stringify(step)) as JsonObject), now: 10 });
  await activateAdvancedPlan(store, scope, committed);
  const api: AdvancedNativeApi = {
    async get(id) {
      if (id === 'local-only') throw new Error('chrome_temporarily_unavailable');
      return id === 'bar' ? [{ id: 'bar', parentId: undefined, title: 'Bookmarks bar' }] : [];
    },
    async getChildren() { return []; },
    async create() { throw new Error('unexpected_create'); },
    async update() { throw new Error('unexpected_update'); },
    async move() { throw new Error('unexpected_move'); },
    async remove() { throw new Error('unexpected_remove'); },
  };
  await executeActiveAdvancedPlan(store, scope, api).catch(() => undefined);
  const loaded = await store.readAdvancedPlan(scope, plan.planId);
  assert.notEqual(loaded?.plan.state, 'completed');
  assert.notEqual(loaded?.steps.find((step) => step.definition.action === 'remove')?.state, 'terminal');
});

test('a legal remote noop without a revision still completes an already-applied update', async () => {
  const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); await active(store);
  const remoteBar: RemoteNodeFact = { ...remoteRoot, nodeId: 'remote-bar', parentId: remoteRoot.nodeId,
    title: 'Bookmarks bar', folderRole: 'bookmarks-bar', revision: 'revision-bar', childrenRevision: 'children-bar' };
  const remoteBookmark: RemoteNodeFact = { nodeId: 'remote-bookmark', parentId: remoteBar.nodeId, kind: 'bookmark',
    title: 'Old title', url: 'https://example.test/old', revision: 'revision-bookmark', position: '0' };
  const refreshedBookmark: RemoteNodeFact = { ...remoteBookmark, title: 'New title',
    url: 'https://example.test/new', revision: 'revision-bookmark-after' };
  const local: LocalNodeFact[] = [
    { nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: null, kind: 'folder', title: 'Bookmarks bar' },
    { nativeId: 'local-bookmark', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
      title: 'New title', url: 'https://example.test/new' },
  ];
  const mappings = [{ nativeId: 'bar', colpId: remoteBar.nodeId },
    { nativeId: 'local-bookmark', colpId: remoteBookmark.nodeId }];
  const mount = { ...uploadMount, remoteMountNodeId: remoteBar.nodeId };
  const plan = buildAdvancedPlan({ scope, confirmationId: 'noop-confirm', mode: 'upload', boundaryVersion: '1',
    treeDigest: 'tree-noop', remoteSnapshotId: 'snapshot-noop', remoteRevision: 'revision-noop',
    remoteCursor: 'cursor-noop', local, remote: [remoteRoot, remoteBar, remoteBookmark], mappings,
    mounts: [mount], rootNodeId: remoteRoot.nodeId });
  const snapshotFacts = [remoteRoot, remoteBar, remoteBookmark].map((fact) => ({ kind: 'snapshot-fact', fact,
    nativeId: mappings.find((mapping) => mapping.colpId === fact.nodeId)?.nativeId ?? null }));
  const committed = await store.commitAdvancedPlan(scope, { planId: plan.planId,
    metadata: { mode: 'upload', mounts: JSON.parse(JSON.stringify([mount])), confirmationId: 'noop-confirm', treeDigest: 'tree-noop' },
    steps: [...snapshotFacts, ...plan.steps].map((step) => JSON.parse(JSON.stringify(step)) as JsonObject), now: 10 });
  await store.putMapping(scope, { nativeId: 'bar', colpId: remoteBar.nodeId, rootNativeId: 'bar', nodeKind: 'folder',
    mountId: 'mount:bar', rootRole: 'bookmarks-bar', projection: { revision: remoteBar.revision,
      childrenRevision: remoteBar.childrenRevision, digest: 'sha256:bar', content: { title: remoteBar.title } } });
  await store.putMapping(scope, { nativeId: 'local-bookmark', colpId: remoteBookmark.nodeId, rootNativeId: 'bar',
    nodeKind: 'bookmark', parentNativeId: 'bar', parentColpId: remoteBar.nodeId, mountId: 'mount:bar',
    rootRole: 'bookmarks-bar', projection: { revision: remoteBookmark.revision, digest: 'sha256:bookmark',
      content: { title: remoteBookmark.title, url: remoteBookmark.url! } } });
  await activateAdvancedPlan(store, scope, committed);

  await executeActiveAdvancedPlan(store, scope, nativeApi(), async () => [remoteRoot, remoteBar, refreshedBookmark]);
  const queue = await pendingQueue(store);
  await settleNoop(store, queue, remoteBookmark.nodeId);
  await executeActiveAdvancedPlan(store, scope, nativeApi(), async () => [remoteRoot, remoteBar, refreshedBookmark]);

  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'completed');
  const mapping = await store.getMappingByNativeId(scope, 'local-bookmark');
  assert.equal(mapping?.colpId, remoteBookmark.nodeId);
  assert.equal(mapping?.projection.revision, refreshedBookmark.revision);
  const beforeReplay = await store.listMappings(scope);
  const loaded = await store.readAdvancedPlan(scope, plan.planId);
  const remoteStep = loaded?.steps.find((record) => record.definition.side === 'remote'
    && record.definition.action === 'update');
  assert.ok(remoteStep);
  const replay = await executeAdvancedRemoteStep({ store, scope,
    step: remoteStep!.definition as unknown as Extract<AdvancedStep, { side: 'remote' }>, planId: plan.planId,
    completed: [], refreshRemoteFacts: async () => [remoteRoot, remoteBar, refreshedBookmark] });
  assert.equal(replay.state, 'complete');
  assert.deepEqual(await store.listMappings(scope), beforeReplay);
});

function nativeApi(): AdvancedNativeApi {
  const nodes = new Map<string, AdvancedNativeNode>([
    ['bar', { id: 'bar', title: 'Bookmarks bar' }],
  ]);
  return {
    async get(id) { const node = nodes.get(id); return node ? [node] : []; },
    async getChildren(id) { return [...nodes.values()].filter((node) => node.parentId === id); },
    async create(input) {
      const id = input.url ? 'local-created' : 'folder-created'; const node = { id, ...input }; nodes.set(id, node); return node;
    },
    async update(id, input) { const node = { ...nodes.get(id)!, ...input }; nodes.set(id, node); return node; },
    async move(id, input) { const node = { ...nodes.get(id)!, ...input }; nodes.set(id, node); return node; },
    async remove(id) { nodes.delete(id); },
  };
}

async function pendingQueue(store: ReturnType<typeof createSyncStateStore>): Promise<QueueOperation> {
  const rows = await store.listQueue(scope, 'pending', 0, 10);
  assert.equal(rows.length, 1);
  return rows[0]!;
}

async function settle(store: ReturnType<typeof createSyncStateStore>, queue: QueueOperation,
  targetId: string, revision: string): Promise<void> {
  await store.completeQueueWithReceipt(scope, queue.sequence, {
    opId: queue.opId, operationDigest: queue.digest, kind: 'terminal', receiptId: `receipt-${queue.sequence}`,
    resultDigest: `sha256:receipt-${queue.sequence}`,
    result: { batchId: queue.batchId, serverCursor: `cursor-${queue.sequence}`, results: [{
      opId: queue.opId, sequence: queue.sequence, status: 'applied', targetId, revision,
      cursor: `cursor-${queue.sequence}`, warnings: [],
    }] },
  });
}

async function settleNoop(store: ReturnType<typeof createSyncStateStore>, queue: QueueOperation,
  targetId: string): Promise<void> {
  await store.completeQueueWithReceipt(scope, queue.sequence, {
    opId: queue.opId, operationDigest: queue.digest, kind: 'terminal', receiptId: `receipt-noop-${queue.sequence}`,
    resultDigest: `sha256:receipt-noop-${queue.sequence}`,
    result: { batchId: queue.batchId, serverCursor: `cursor-noop-${queue.sequence}`, results: [{
      opId: queue.opId, sequence: queue.sequence, status: 'noop', targetId, warnings: [],
    }] },
  });
}
