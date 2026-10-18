import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { scanBoundary } from '../src/bookmark-boundary.js';
import { localFactsFromRoots } from '../src/bootstrap/local-facts.js';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { assertBootstrapUploadAllowed } from '../src/bootstrap/upload-boundary.js';
import { handleAttentionDecide } from '../src/sw/first-run-attention.js';
import { confirmAddRange, previewAddRange } from '../src/scope-commands.js';
import { scope, endpoints } from './outbound-push-worker-harness.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import type { RemoteNodeFact } from '../src/bootstrap/matcher.js';

const leaf = (nativeId: string) => ({ nativeId, title: nativeId, kind: 'bookmark' as const, url: `https://example.test/${nativeId}`, managed: false, children: [] });
const folder = (nativeId: string, children: any[] = []) => ({ nativeId, title: nativeId, kind: 'folder' as const, managed: false, children });
const roots: NormalizedBookmarkRoot[] = [{ ...folder('bar', [folder('outer', [folder('first', [leaf('selected-leaf')]), leaf('unselected-sibling')]),
  folder('later', [leaf('later-leaf')]), folder('private', [leaf('private-leaf')])]), rootKind: 'bookmarks_bar' }];
const parents = new Map<string, string>();
function index(node: any, parent?: string) { if (parent) parents.set(node.nativeId, parent); for (const child of node.children) index(child, node.nativeId); }
roots.forEach(root => index(root));
async function fixture() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 999999 }, checkpoint: null, selectedRoots: [], rootStatus: 'ready' });
  await store.putMapping(scope, { nativeId: 'recovery:root', colpId: 'root', rootNativeId: 'recovery:root', nodeKind: 'folder',
    projection: { revision: 'r-root', childrenRevision: 'r-root', digest: 'sha256:root', content: { title: '', folderRole: 'root' } } });
  const remote: { -readonly [K in keyof RemoteNodeFact]: RemoteNodeFact[K] }[] = [{ nodeId: 'root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r-root', childrenRevision: 'r-root' }];
  const sessions: PushSessionController = { get: async () => ({ credential: { accessToken: 'test' }, session: {
    sessionId: 'topology', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
    credentialAuthorityDigest: 'a'.repeat(64), collection: { collectionId: scope.collectionId, serverRevision: 'r1', serverCursor: 'c0' },
    replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } }) };
  let expected = 1;
  const worker = createOutboundPushWorker({ scope, store, sessions, endpoints: async () => endpoints, now: () => 10000,
    ownerId: () => 'topology', assertUploadAllowed: queue => assertBootstrapUploadAllowed({ store, scope, queue, parentOf: async id => parents.get(id) }),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); const op = body.operations[0];
      expect(op.sequence).toBe(expected++);
      if (op.type === 'move_node') {
        const node = remote.find(row => row.nodeId === op.targetId)!;
        expect(op.baseRevision).toBe(node.revision);
        expect(op.payload.baseSourceParentRevision).toBe(remote.find(row => row.nodeId === node.parentId)?.childrenRevision);
        expect(op.payload.baseTargetParentRevision).toBe(remote.find(row => row.nodeId === op.payload.newParentId)?.childrenRevision);
        node.parentId = op.payload.newParentId; node.revision = `r-${op.sequence}`;
        return Response.json({ batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied', targetId: node.nodeId,
          revision: node.revision, cursor: `c-${op.sequence}`, warnings: [] }], serverCursor: `c-${op.sequence}` });
      }
      expect(op.type).toBe('create_node');
      expect(remote.some(row => row.nodeId === op.payload.parentId)).toBe(true);
      const node = op.payload.node; const targetId = `node-${node.folderRole ?? node.title}`;
      expect(remote.some(row => row.nodeId === targetId)).toBe(false);
      remote.push({ nodeId: targetId, parentId: op.payload.parentId, kind: node.kind, title: node.title,
        ...(node.url ? { url: node.url } : {}), ...(node.folderRole ? { folderRole: node.folderRole } : {}),
        revision: `r-${op.sequence}`, ...(node.kind === 'folder' ? { childrenRevision: `r-${op.sequence}` } : {}) });
      return Response.json({ batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied', targetId,
        revision: `r-${op.sequence}`, cursor: `c-${op.sequence}`, warnings: [] }], serverCursor: `c-${op.sequence}` });
    } });
  const coordinator = createBootstrapCoordinator({ store, scope });
  const input = (selected: string[], confirmationId: string) => {
    const scan = scanBoundary({ roots, selectedNativeIds: selected, privateNativeIds: ['private'] });
    return { confirmationId, confirmationVersion: '1', treeDigest: scan.treeDigest, rootNodeId: 'root',
      localFacts: localFactsFromRoots(roots, selected, [], ['private']), remoteFacts: remote,
      mounts: scan.mounts.map(mount => ({ ...mount, remoteMountNodeId: null })) };
  };
  const settle = async (runId: string, selected: string[], confirmationId: string, allowAttention = false) => {
    for (let i = 0; i < 12; i++) {
      await worker.drain(); store.close();
      const view = await coordinator.advance(runId, input(selected, confirmationId));
      if (view.run.phase === 'completed' || allowAttention && view.run.phase === 'needs_attention') return;
    }
    throw new Error(`topology_not_converged:${JSON.stringify(await store.listQueue(scope))}`);
  };
  return { store, remote, coordinator, input, settle, worker };
}
const topology = (rows: RemoteNodeFact[]) => rows.map(row => ({ title: row.title, kind: row.kind,
  parent: rows.find(parent => parent.nodeId === row.parentId)?.title ?? null })).sort((a, b) => a.title.localeCompare(b.title));

test('real partial first sync then confirmed full range preserves identity, ancestry and privacy', async () => {
  const partial = await fixture(); const full = await fixture();
  try {
    const first = await partial.coordinator.confirm(partial.input(['first'], 'partial'));
    await partial.settle(first.run.runId, ['first'], 'partial');
    expect(partial.remote.map(row => row.title)).not.toContain('unselected-sibling');
    expect(partial.remote.map(row => row.title)).not.toContain('later-leaf');
    expect(partial.remote.find(row => row.title === 'first')?.parentId).toBe('node-outer');
    expect(partial.remote.find(row => row.title === 'outer')?.parentId).toBe('node-bookmarks-bar');
    const identity = (await partial.store.getMappingByNativeId(scope, 'first'))!.colpId;
    const preview = await previewAddRange(partial.store, scope, { roots, selectedNativeIds: ['bar'], privateNativeIds: ['private'] });
    expect((await confirmAddRange(partial.store, scope, { ...partial.input(['bar'], 'full-range'), previewId: preview.previewId,
      treeDigest: preview.treeDigest })).ok).toBe(true);
    await partial.settle('full-range', ['bar'], 'full-range');
    expect((await partial.store.getMappingByNativeId(scope, 'first'))!.colpId).toBe(identity);
    const all = await full.coordinator.confirm(full.input(['bar'], 'all-at-once'));
    await full.settle(all.run.runId, ['bar'], 'all-at-once');
    expect(topology(partial.remote)).toEqual(topology(full.remote));
    expect(partial.remote.filter(row => row.folderRole === 'bookmarks-bar')).toHaveLength(1);
    expect(partial.remote.filter(row => row.title === 'first')).toHaveLength(1);
    expect(partial.remote.some(row => row.title === 'private-leaf')).toBe(false);
  } finally { partial.store.close(); full.store.close(); }
});

test('persisted flattened directories require an explicit reviewed move and recover without copying or deleting', async () => {
  const f = await fixture();
  try {
    f.remote.push({ nodeId: 'node-first', parentId: 'root', kind: 'folder', title: 'first', folderRole: 'custom', revision: 'legacy-r1', childrenRevision: 'legacy-r1' },
      { nodeId: 'node-selected-leaf', parentId: 'node-first', kind: 'bookmark', title: 'selected-leaf', url: 'https://example.test/selected-leaf', revision: 'legacy-leaf' });
    await f.store.putMountBinding(scope, { mountId: 'legacy-first', nativeRootId: 'first', remoteMountNodeId: 'node-first',
      customSourceKey: 'folder:first', status: 'active', materialized: false, boundaryVersion: '1' });
    for (const [nativeId, nodeId, parentId, parentNativeId] of [['first', 'node-first', 'root', 'outer'], ['selected-leaf', 'node-selected-leaf', 'node-first', 'first']]) {
      const node = f.remote.find(row => row.nodeId === nodeId)!;
      await f.store.putMapping(scope, { nativeId: nativeId!, colpId: nodeId!, rootNativeId: 'first', mountId: 'legacy-first',
        nodeKind: node.kind, parentNativeId: parentNativeId!, parentColpId: parentId!, projection: { revision: node.revision,
          digest: 'sha256:legacy', content: { title: node.title, ...(node.url ? { url: node.url } : {}) } } });
    }
    await f.store.setFirstRun(scope, 'completed'); f.store.close();
    const preview = await previewAddRange(f.store, scope, { roots, selectedNativeIds: ['bar'], privateNativeIds: ['private'] });
    expect((await confirmAddRange(f.store, scope, { ...f.input(['bar'], 'legacy-repair'), previewId: preview.previewId,
      treeDigest: preview.treeDigest })).ok).toBe(true);
    await f.settle('legacy-repair', ['bar'], 'legacy-repair', true);
    expect(f.remote.find(row => row.nodeId === 'node-first')?.parentId).toBe('root'); // no automatic online move
    const run = (await f.store.listBootstrapRuns(scope)).find(row => row.runId === 'legacy-repair')!;
    const item = run.attention!.items.find(item => item.nodeRefs?.includes('first'))!;
    expect(item.parentRefs).toEqual(['outer', 'root']);
    expect((await handleAttentionDecide(f.store, scope, run.runId, item.itemId, 'completed', { decision: 'keep_local',
      evidenceDigest: item.evidenceDigest, input: f.input(['bar'], 'legacy-repair') })).ok).toBe(true);
    f.store.close(); await f.worker.drain(); await f.settle(run.runId, ['bar'], 'legacy-repair');
    expect(f.remote.find(row => row.nodeId === 'node-first')?.parentId).toBe('node-outer');
    expect((await f.store.getMappingByNativeId(scope, 'first'))?.colpId).toBe('node-first');
    expect(f.remote.filter(row => row.title === 'first')).toHaveLength(1);
    expect((await f.store.listQueue(scope)).filter(row => row.payload.type === 'move_node')).toHaveLength(1);
    expect((await f.store.listQueue(scope)).some(row => String(row.payload.type).includes('delete'))).toBe(false);
  } finally { f.store.close(); }
});
