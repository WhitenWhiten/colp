import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { buildAdvancedPlan } from '../src/bootstrap/advanced-plan.js';
import type { AdvancedStep } from '../src/bootstrap/advanced-plan-types.js';
import { activateAdvancedPlan, executeActiveAdvancedPlan, projectAdvancedSnapshot } from '../src/bootstrap/advanced-run.js';
import { executeAdvancedLocalStep, type AdvancedNativeApi, type AdvancedNativeNode } from '../src/bootstrap/advanced-local-executor.js';
import type { LocalNodeFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import { createSyncStateStore, type JsonObject, type MappingInput } from '../src/sync-state-store.js';
import type { AdvancedStepRecord } from '../src/sync-state/advanced-repository.js';
import { active, scope } from './kns-03-bootstrap-harness.js';

const mounts = [{ nativeRootId: 'bar', rootRole: 'bookmarks-bar' as const, remoteMountNodeId: 'remote-bar' }];

test('advanced local create skips file and chrome urls without calling chrome', async () => {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await active(store);
  const completed = snapshotRecords([remoteBar()]);
  const writes: Write[] = [];
  const { api, nodes } = memoryApi([{ id: 'bar', title: 'Bar' }], writes);
  try {
    const file = await executeAdvancedLocalStep({ store, scope, api, completed,
      record: pendingRecord(bookmarkStep('file', 'Secret', 'file:///tmp/secret', 1), 2),
      step: bookmarkStep('file', 'Secret', 'file:///tmp/secret', 1) });
    const chrome = await executeAdvancedLocalStep({ store, scope, api, completed,
      record: pendingRecord(bookmarkStep('chrome', 'Settings', 'chrome://settings', 2), 3),
      step: bookmarkStep('chrome', 'Settings', 'chrome://settings', 2) });
    assert.equal(file.state, 'complete');
    assert.equal(file.state === 'complete' && file.evidence.code, 'unsupported_url_scheme');
    assert.equal(chrome.state, 'complete');
    assert.equal(chrome.state === 'complete' && chrome.evidence.code, 'unsupported_url_scheme');
    assert.deepEqual(writes, []);
    assert.equal([...nodes.values()].some((node) => String(node.url).startsWith('file:')
      || String(node.url).startsWith('chrome:')), false);
  } finally { store.close(); }
});

test('advanced local update does not pass file or chrome urls and still writes https', async () => {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await active(store);
  await store.putMapping(scope, { nativeId: 'bar', colpId: 'remote-bar', rootNativeId: 'bar',
    mountId: 'mount:bar', rootRole: 'bookmarks-bar', nodeKind: 'folder',
    projection: { revision: 'bar-r', digest: 'sha256:bar', content: { title: 'Bar' } } });
  const writes: Write[] = [];
  const { api, nodes } = memoryApi([
    { id: 'bar', title: 'Bar' },
    { id: 'native-file', parentId: 'bar', title: 'Old', url: 'https://example.test/keep' },
    { id: 'native-chrome', parentId: 'bar', title: 'Local', url: 'https://example.test/settings' },
    { id: 'native-https', parentId: 'bar', title: 'Before', url: 'https://example.test/before' },
  ], writes);
  const completed = snapshotRecords([
    remoteBar(),
    remoteBookmark('remote-file', 'Old', 'https://example.test/keep'),
    remoteBookmark('remote-chrome', 'Local', 'https://example.test/settings'),
    remoteBookmark('remote-https', 'Before', 'https://example.test/before'),
  ]);
  try {
    const file = await executeAdvancedLocalStep({ store, scope, api, completed,
      record: pendingRecord(updateStep('native-file', 'remote-file', 'Old', 'https://example.test/keep', 'New', 'file:///tmp/keep'), 1),
      step: updateStep('native-file', 'remote-file', 'Old', 'https://example.test/keep', 'New', 'file:///tmp/keep') });
    const chrome = await executeAdvancedLocalStep({ store, scope, api, completed,
      record: pendingRecord(updateStep('native-chrome', 'remote-chrome', 'Local', 'https://example.test/settings', 'Local2', 'chrome://extensions'), 2),
      step: updateStep('native-chrome', 'remote-chrome', 'Local', 'https://example.test/settings', 'Local2', 'chrome://extensions') });
    const https = await executeAdvancedLocalStep({ store, scope, api, completed,
      record: pendingRecord(updateStep('native-https', 'remote-https', 'Before', 'https://example.test/before', 'After', 'https://example.test/after'), 3),
      step: updateStep('native-https', 'remote-https', 'Before', 'https://example.test/before', 'After', 'https://example.test/after') });
    assert.equal(file.state, 'complete');
    assert.equal(chrome.state, 'complete');
    assert.equal(https.state, 'complete');
    assert.equal(writes.find((write) => write.title === 'New')?.url, undefined);
    assert.equal(writes.find((write) => write.title === 'Local2')?.url, undefined);
    assert.equal(writes.find((write) => write.title === 'After')?.url, 'https://example.test/after');
    assert.equal(nodes.get('native-file')?.url, 'https://example.test/keep');
    assert.equal(nodes.get('native-chrome')?.url, 'https://example.test/settings');
    assert.equal(nodes.get('native-https')?.url, 'https://example.test/after');
    assert.equal(JSON.stringify(writes).includes('file:'), false);
    assert.equal(JSON.stringify(writes).includes('chrome:'), false);
  } finally { store.close(); }
});

test('advanced download continues after file and chrome bookmarks and still writes https', async () => {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await active(store);
  const remote = downloadRemote();
  const local = downloadLocal();
  const plan = buildAdvancedPlan({ scope, confirmationId: 'confirm', mode: 'download', boundaryVersion: '1',
    treeDigest: 'tree', remoteSnapshotId: 'snapshot', remoteRevision: 'revision', remoteCursor: 'cursor',
    local, remote, mappings: [
      { nativeId: 'native-file', colpId: 'remote-file-update' },
      { nativeId: 'native-https', colpId: 'remote-https-update' },
    ], mounts, rootNodeId: 'root' });
  const definitions = [
    ...remote.map((fact) => ({ kind: 'snapshot-fact', fact,
      nativeId: plan.matched.find((pair) => pair.nodeId === fact.nodeId)?.nativeId ?? null })),
    ...plan.steps,
  ];
  const committed = await store.commitAdvancedPlan(scope, { planId: plan.planId,
    metadata: { mode: 'download', mounts: JSON.parse(JSON.stringify(mounts)), confirmationId: 'confirm',
      treeDigest: 'tree', selectedNativeIds: ['bar'], excludedNativeIds: [], discovered: [
        { nativeId: 'bar', ancestorNativeIds: [] }] },
    steps: JSON.parse(JSON.stringify(definitions)) as JsonObject[], now: 10 });
  await activateAdvancedPlan(store, scope, committed);
  const staged: MappingInput[] = remote.map((fact) => ({ colpId: fact.nodeId, nativeId: `snapshot:${fact.nodeId}`,
    rootNativeId: 'root', nodeKind: fact.kind, ...(fact.parentId ? { parentColpId: fact.parentId } : {}),
    projection: { revision: fact.revision, digest: 'digest',
      ...(fact.childrenRevision ? { childrenRevision: fact.childrenRevision } : {}),
      content: { title: fact.title, ...(fact.url ? { url: fact.url } : {}),
        ...(fact.folderRole ? { folderRole: fact.folderRole } : {}) } } }));
  for (const mapping of await projectAdvancedSnapshot(store, scope, staged) ?? []) await store.putMapping(scope, mapping);
  const writes: Write[] = [];
  const { api, nodes } = memoryApi(local.map((fact) => ({ id: fact.nativeId, parentId: fact.parentNativeId ?? undefined,
    title: fact.title, ...(fact.url ? { url: fact.url } : {}) })), writes);
  try {
    await executeActiveAdvancedPlan(store, scope, api);
    const loaded = await store.readAdvancedPlan(scope, plan.planId);
    assert.equal(loaded?.plan.state, 'completed', JSON.stringify(loaded?.steps.map((step) => ({
      state: step.state, error: step.error, action: step.definition.action, code: step.evidence?.code,
    }))));
    assert.equal(JSON.stringify(writes).includes('file:'), false);
    assert.equal(JSON.stringify(writes).includes('chrome:'), false);
    assert.equal(writes.some((write) => write.op === 'create' && write.url === 'https://example.test/kept'), true);
    assert.equal(writes.find((write) => write.title === 'Folder')?.url, undefined);
    assert.equal(writes.find((write) => write.title === 'After')?.url, 'https://example.test/after');
    assert.equal(nodes.get('native-file')?.title, 'New');
    assert.equal(nodes.get('native-file')?.url, 'https://example.test/keep');
    assert.equal([...nodes.values()].some((node) => String(node.url).startsWith('file:')
      || String(node.url).startsWith('chrome:')), false);
  } finally { store.close(); }
});

type Write = { op: 'create' | 'update'; title?: string; url?: string; index?: number };

function memoryApi(seed: readonly AdvancedNativeNode[], writes: Write[]) {
  const nodes = new Map(seed.map((node) => [node.id, { ...node }]));
  let sequence = 0;
  const api: AdvancedNativeApi = {
    async get(id) { const node = nodes.get(id); return node ? [{ ...node }] : []; },
    async getChildren(id) { return [...nodes.values()].filter((node) => node.parentId === id).map((node) => ({ ...node })); },
    async create(input) {
      writes.push({ op: 'create', title: input.title, ...(input.url === undefined ? {} : { url: input.url }), index: input.index });
      const node = { id: `created-${++sequence}`, ...input };
      nodes.set(node.id, node);
      return { ...node };
    },
    async update(id, input) {
      writes.push({ op: 'update', ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.url === undefined ? {} : { url: input.url }) });
      const node = { ...nodes.get(id)!, ...input };
      nodes.set(id, node);
      return { ...node };
    },
    async move(id, input) {
      const node = { ...nodes.get(id)!, ...input };
      nodes.set(id, node);
      return { ...node };
    },
    async remove(id) { nodes.delete(id); },
  };
  return { api, nodes };
}

function pendingRecord(step: Extract<AdvancedStep, { side: 'local' }>, order: number): AdvancedStepRecord {
  return { scopeKey: 'scope', planId: 'plan', order, definition: step as unknown as JsonObject,
    digest: `sha256:${order}`, state: 'pending' };
}

function bookmarkStep(id: string, title: string, url: string, index: number): Extract<AdvancedStep, { side: 'local'; action: 'create' }> {
  const parent = { kind: 'native-node' as const, id: 'bar' };
  const node = { kind: 'bookmark' as const, title, url };
  const fact = remoteBookmark(`remote-${id}`, title, url);
  return { side: 'local', action: 'create', operation: 'create', stepId: `create-${id}`, order: index + 1, dependsOn: [],
    source: { nodeId: fact.nodeId, fact }, parent,
    payload: { type: 'create', parent, index, node }, before: null,
    after: { nativeId: null, parent, node, index } };
}

function updateStep(nativeId: string, nodeId: string, beforeTitle: string, beforeUrl: string, title: string, url: string)
  : Extract<AdvancedStep, { side: 'local'; action: 'update' }> {
  const parent = { kind: 'native-node' as const, id: 'bar' };
  const beforeNode = { kind: 'bookmark' as const, title: beforeTitle, url: beforeUrl };
  const afterNode = { kind: 'bookmark' as const, title, url };
  const before = { nativeId, mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark' as const,
    title: beforeTitle, url: beforeUrl, index: 0 };
  return { side: 'local', action: 'update', operation: 'update', stepId: `update-${nativeId}`, order: 1, dependsOn: [],
    source: { nodeId, fact: remoteBookmark(nodeId, title, url) },
    target: { nativeId, nodeId },
    payload: { type: 'update', nativeId, before: beforeNode, after: afterNode },
    before, after: { nativeId, parent, node: afterNode, index: 0 } };
}

function remoteBar(): RemoteNodeFact {
  return { nodeId: 'remote-bar', parentId: 'root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
    revision: 'bar-r', childrenRevision: 'bar-c', position: 'a' };
}

function remoteFolder(): RemoteNodeFact {
  return { nodeId: 'remote-folder', parentId: 'remote-bar', kind: 'folder', title: 'Folder', revision: 'folder-r',
    childrenRevision: 'folder-c', position: 'a' };
}

function remoteBookmark(nodeId: string, title: string, url: string, position = 'b'): RemoteNodeFact {
  return { nodeId, parentId: 'remote-bar', kind: 'bookmark', title, url, revision: `${nodeId}-r`, position };
}

function snapshotRecords(facts: readonly RemoteNodeFact[]): AdvancedStepRecord[] {
  return facts.map((fact, index) => ({ scopeKey: 'scope', planId: 'plan', order: index,
    definition: { kind: 'snapshot-fact', fact, nativeId: fact.nodeId === 'remote-bar' ? 'bar' : null } as unknown as JsonObject,
    digest: `sha256:snapshot-${index}`, state: 'terminal' as const,
    evidence: { targetId: fact.nodeId, revision: fact.revision } }));
}

function downloadRemote(): RemoteNodeFact[] {
  return [
    { nodeId: 'root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0', childrenRevision: 'c0' },
    remoteBar(),
    remoteFolder(),
    remoteBookmark('remote-secret', 'Secret', 'file:///tmp/secret', 'b'),
    remoteBookmark('remote-kept', 'Kept', 'https://example.test/kept', 'c'),
    remoteBookmark('remote-settings', 'Settings', 'chrome://settings', 'd'),
    remoteBookmark('remote-file-update', 'New', 'file:///tmp/keep', 'e'),
    remoteBookmark('remote-https-update', 'After', 'https://example.test/after', 'f'),
  ];
}

function downloadLocal(): LocalNodeFact[] {
  return [
    { nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: '0', kind: 'folder', title: 'Bar' },
    { nativeId: 'native-file', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark', title: 'Old',
      url: 'https://example.test/keep' },
    { nativeId: 'native-https', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark', title: 'Before',
      url: 'https://example.test/before' },
  ];
}
