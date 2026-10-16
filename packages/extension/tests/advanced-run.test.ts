import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { translateSyncBrowserDelete } from '@know-n/colp/sync';
import { buildAdvancedPlan } from '../src/bootstrap/advanced-plan.js';
import { activateAdvancedPlan, captureAdvancedCreate, executeActiveAdvancedPlan,
  projectAdvancedSnapshot } from '../src/bootstrap/advanced-run.js';
import { createSyncStateStore, type JsonObject, type MappingInput } from '../src/sync-state-store.js';
import type { AdvancedNativeApi, AdvancedNativeNode } from '../src/bootstrap/advanced-local-executor.js';
import type { LocalNodeFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { active, completeQueuedCreate, scope } from './kns-03-bootstrap-harness.js';

const mounts = [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar' as const, remoteMountNodeId: 'remote-bar' }];
const remote: RemoteNodeFact[] = [
  { nodeId: 'root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0', childrenRevision: 'c0' },
  { nodeId: 'remote-bar', parentId: 'root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar', revision: 'r1', childrenRevision: 'c1', position: 'a' },
  { nodeId: 'remote-bookmark', parentId: 'remote-bar', kind: 'bookmark', title: 'Cloud', url: 'https://cloud.example/', revision: 'r2', position: 'a' },
];
const local: LocalNodeFact[] = [
  { nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: '0', kind: 'folder', title: 'Bar' },
  { nativeId: 'local-bookmark', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark', title: 'Local', url: 'https://local.example/' },
];

async function setup(mode: 'upload' | 'download' = 'download', excludedNativeIds: string[] = []) {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); await active(store);
  const plan = buildAdvancedPlan({ scope, confirmationId: 'confirm', mode, boundaryVersion: '1',
    treeDigest: 'tree', remoteSnapshotId: 'snapshot', remoteRevision: 'revision', remoteCursor: 'cursor',
    local, remote, mappings: [], mounts, rootNodeId: 'root' });
  const definitions = [
    ...remote.map((fact) => ({ kind: 'snapshot-fact', fact,
      nativeId: plan.matched.find((pair) => pair.nodeId === fact.nodeId)?.nativeId ?? null })),
    ...plan.steps,
  ];
  const committed = await store.commitAdvancedPlan(scope, { planId: plan.planId,
    metadata: { mode, mounts: JSON.parse(JSON.stringify(mounts)), confirmationId: 'confirm', treeDigest: 'tree',
      selectedNativeIds: ['bar'], excludedNativeIds, discovered: [
        { nativeId: 'bar', ancestorNativeIds: [] }, { nativeId: 'private', ancestorNativeIds: ['bar'] }] },
    steps: JSON.parse(JSON.stringify(definitions)) as JsonObject[], now: 10 });
  await activateAdvancedPlan(store, scope, committed);
  const staged: MappingInput[] = remote.map((fact) => ({ colpId: fact.nodeId, nativeId: `snapshot:${fact.nodeId}`,
    rootNativeId: 'root', nodeKind: fact.kind,
    ...(fact.parentId ? { parentColpId: fact.parentId } : {}),
    projection: { revision: fact.revision, digest: 'digest',
      ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}),
      content: { title: fact.title, ...(fact.url ? { url: fact.url } : {}),
        ...(fact.folderRole ? { folderRole: fact.folderRole } : {}) } } }));
  const projection = await projectAdvancedSnapshot(store, scope, staged);
  for (const mapping of projection ?? []) await store.putMapping(scope, mapping);
  return { store, plan, projection };
}

test('cloud coverage uses the confirmed tree, retains mount roots and binds the original remote identity', async () => {
  const { store, plan, projection } = await setup(); const { api, nodes, mutations } = nativeApi();
  assert.equal(projection?.find((row) => row.colpId === 'remote-bar')?.nativeId, 'bar');
  assert.equal(projection?.find((row) => row.colpId === 'remote-bookmark')?.nativeId, 'unmounted:remote-bookmark');
  assert.equal(mutations.length, 0);
  await executeActiveAdvancedPlan(store, scope, api);
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'completed');
  assert.ok(nodes.has('bar')); assert.equal(nodes.has('local-bookmark'), false);
  const cloud = [...nodes.values()].find((node) => node.title === 'Cloud'); assert.ok(cloud);
  assert.equal((await store.getMappingByNativeId(scope, cloud.id))?.colpId, 'remote-bookmark');
  assert.equal(await captureAdvancedCreate(store, scope, cloud.id, cloud), true);
  assert.equal(await captureAdvancedCreate(store, scope, 'unrelated-new-id', cloud), false);
  assert.equal((await store.listQueue(scope)).length, 0);
  assert.deepEqual(mutations, ['create', 'remove']);
  await executeActiveAdvancedPlan(store, scope, api);
  assert.deepEqual(mutations, ['create', 'remove']);
});

test('advanced exclusions survive activation retries and remain private after completion', async () => {
  const { store, plan } = await setup('download', ['private']);
  const loaded = await store.readAdvancedPlan(scope, plan.planId);
  await activateAdvancedPlan(store, scope, loaded!.plan);
  const privateId = (await store.getMappingByNativeId(scope, 'private'))!.colpId;
  assert.deepEqual((await store.getScope(scope))!.privateRoots, [privateId]);
  await executeActiveAdvancedPlan(store, scope, nativeApi().api);
  assert.deepEqual((await store.getScope(scope))!.privateRoots, [privateId]);
  assert.deepEqual((await store.getScope(scope))!.selectedRoots, ['remote-bar']);
});

test('a create callback that arrives after its step settled, while the plan still runs, is an echo', async () => {
  const { store, plan } = await setup(); const { api, nodes } = nativeApi();
  // Chrome delivers onCreated on its own schedule; here the plan stops at the later remove step.
  api.remove = async () => { throw new Error('chrome_busy'); };
  await executeActiveAdvancedPlan(store, scope, api).catch(() => undefined);
  const loaded = await store.readAdvancedPlan(scope, plan.planId);
  assert.notEqual(loaded?.plan.state, 'completed');
  const cloud = [...nodes.values()].find((node) => node.title === 'Cloud'); assert.ok(cloud);
  assert.ok(loaded?.steps.some((step) => step.state === 'terminal' && step.evidence?.nativeId === cloud.id));
  assert.equal(await captureAdvancedCreate(store, scope, cloud.id, cloud), true);
  assert.equal(await captureAdvancedCreate(store, scope, 'unrelated-new-id', { ...cloud, parentId: 'elsewhere' }), false);
});

test('an edit after confirmation stops deletion and retains the user change', async () => {
  const { store, plan } = await setup(); const { api, nodes } = nativeApi();
  nodes.set('local-bookmark', { ...nodes.get('local-bookmark')!, title: 'Edited after confirmation' });
  await executeActiveAdvancedPlan(store, scope, api);
  assert.equal(nodes.get('local-bookmark')?.title, 'Edited after confirmation');
  assert.ok((await store.readAdvancedPlan(scope, plan.planId))?.steps.some((step) => step.state === 'attention'));
});

test('local coverage waits for original receipts and never re-enqueues a completed create', async () => {
  const { store, plan } = await setup('upload'); const { api, mutations } = nativeApi();
  await executeActiveAdvancedPlan(store, scope, api);
  const first = (await store.listQueue(scope))[0]!;
  assert.equal(first.payload.type, 'create_node');
  await executeActiveAdvancedPlan(store, scope, api);
  assert.equal((await store.listQueue(scope)).length, 1);
  await completeQueuedCreate(store, first, 'new-remote-node');
  await executeActiveAdvancedPlan(store, scope, api);
  const second = (await store.listQueue(scope))[1]!;
  assert.equal(second.payload.type, 'delete_node');
  assert.equal(second.payload.targetId, 'remote-bookmark');
  assert.equal(second.payload.baseRevision, 'r2');
  // F002 parity: a proven bookmark still goes out as delete_node.
  assert.equal(second.payload.type, translateSyncBrowserDelete({ nodeId: 'remote-bookmark', nodeKind: 'bookmark' }).type);
  await completeQueuedCreate(store, second, 'remote-bookmark');
  await executeActiveAdvancedPlan(store, scope, api);
  assert.equal((await store.readAdvancedPlan(scope, plan.planId))?.plan.state, 'completed');
  assert.equal((await store.getMappingByNativeId(scope, 'local-bookmark'))?.colpId, 'new-remote-node');
  assert.equal((await store.listQueue(scope)).length, 2);
  assert.deepEqual(mutations, []);
});

function nativeApi() {
  const nodes = new Map<string, AdvancedNativeNode>(local.map((fact) => [fact.nativeId,
    { id: fact.nativeId, parentId: fact.parentNativeId ?? undefined, title: fact.title, ...(fact.url ? { url: fact.url } : {}) }]));
  const mutations: string[] = []; let sequence = 0;
  const api: AdvancedNativeApi = {
    async get(id) { const node = nodes.get(id); return node ? [node] : []; },
    async getChildren(id) { return [...nodes.values()].filter((node) => node.parentId === id); },
    async create(input) { mutations.push('create'); const node = { id: `created-${++sequence}`, ...input }; nodes.set(node.id, node); return node; },
    async update(id, input) { mutations.push('update'); const node = { ...nodes.get(id)!, ...input }; nodes.set(id, node); return node; },
    async move(id, input) { mutations.push('move'); const node = { ...nodes.get(id)!, ...input }; nodes.set(id, node); return node; },
    async remove(id) { mutations.push('remove'); nodes.delete(id); },
  };
  return { api, nodes, mutations };
}
