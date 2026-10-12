import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { buildAdvancedPlan } from '../src/bootstrap/advanced-plan.js';
import type { AdvancedStep } from '../src/bootstrap/advanced-plan-types.js';
import { executeAdvancedLocalStep, type AdvancedNativeApi, type AdvancedNativeNode } from '../src/bootstrap/advanced-local-executor.js';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';
import type { LocalNodeFact, MountFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';
import type { AdvancedStepRecord } from '../src/sync-state/advanced-repository.js';

const scope: SyncScope = {
  environment: 'production', serverId: 'server-ordering', serverOrigin: 'https://known.example',
  accountId: 'account-ordering', browserProfileId: 'profile-ordering', collectionId: 'collection-ordering',
  replicaId: 'replica-ordering', generation: 1,
};
const root: RemoteNodeFact = {
  nodeId: 'remote-root', parentId: null, kind: 'folder', title: 'Collection', folderRole: 'root',
  revision: 'root-revision', childrenRevision: 'root-children',
};
const mount: RemoteNodeFact = {
  nodeId: 'remote-bar', parentId: root.nodeId, kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
  revision: 'bar-revision', childrenRevision: 'bar-children', position: '0',
};
const mountFact: MountFact = { nativeRootId: 'native-bar', rootRole: 'bookmarks-bar', remoteMountNodeId: mount.nodeId };

describe('advanced local ordering', () => {
  it('plans moves for matched siblings whose observed order differs from remote positions', () => {
    const a = remoteBookmark('remote-a', 'a', 'A', mount.nodeId, 'https://native-a.example/');
    const b = remoteBookmark('remote-b', 'b', 'B', mount.nodeId, 'https://native-b.example/');
    const plan = makePlan({ remote: [root, mount, a, b], local: [
      localMount(), localBookmark('native-a', 1, 'A'), localBookmark('native-b', 0, 'B'),
    ], mappings: [{ nativeId: 'native-a', colpId: a.nodeId }, { nativeId: 'native-b', colpId: b.nodeId }] });
    const moves = localMoves(plan);
    expect(moves.map((step) => [step.target.nativeId, step.payload.index])).toEqual([
      ['native-a', 0], ['native-b', 1],
    ]);
    expect(moves.every((step) => step.after.index !== undefined)).toBe(true);
  });

  it('places a cloud-only child between retained siblings and compensates later deletion drift', () => {
    const a = remoteBookmark('remote-a', 'a', 'A');
    const inserted = remoteBookmark('remote-inserted', 'b', 'Inserted');
    const b = remoteBookmark('remote-b', 'c', 'B');
    const base = [localMount(), localBookmark('native-a', 0, 'A'), localBookmark('native-b', 1, 'B')];
    const mappings = [{ nativeId: 'native-a', colpId: a.nodeId }, { nativeId: 'native-b', colpId: b.nodeId }];
    const created = localCreates(makePlan({ remote: [root, mount, a, inserted, b], local: base, mappings }))
      .find((step) => step.source.nodeId === inserted.nodeId);
    expect(created?.payload.index).toBe(1);
    expect(created?.after.index).toBe(1);

    const stale = localBookmark('native-stale', 0, 'Stale');
    const withDelete = makePlan({ remote: [root, mount, a, inserted, b], local: [
      localMount(), stale, localBookmark('native-a', 1, 'A'), localBookmark('native-b', 2, 'B'),
    ], mappings });
    const shifted = localCreates(withDelete).find((step) => step.source.nodeId === inserted.nodeId);
    const remove = withDelete.steps.find((step) => step.side === 'local' && step.action === 'remove'
      && step.target.nativeId === stale.nativeId);
    const orderMove = localMoves(withDelete).find((step) => step.target.nativeId === 'native-a');
    expect(shifted?.payload.index).toBe(2);
    expect(shifted && remove && shifted.order).toBeLessThan(remove?.order ?? Number.POSITIVE_INFINITY);
    expect(remove && orderMove && remove.order).toBeLessThan(orderMove?.order ?? Number.POSITIVE_INFINITY);
  });

  it('keeps nested folder and bookmark creates parent-first with each remote sibling index', () => {
    const folder = remoteFolder('remote-folder', 'a', 'Nested');
    const first = remoteBookmark('remote-first', 'a', 'First', folder.nodeId);
    const second = remoteBookmark('remote-second', 'b', 'Second', folder.nodeId);
    const plan = makePlan({ remote: [root, mount, folder, first, second], local: [localMount()], mappings: [] });
    const creates = localCreates(plan);
    const folderCreate = creates.find((step) => step.source.nodeId === folder.nodeId)!;
    const firstCreate = creates.find((step) => step.source.nodeId === first.nodeId)!;
    const secondCreate = creates.find((step) => step.source.nodeId === second.nodeId)!;
    expect(firstCreate.dependsOn).toContain(folderCreate.stepId);
    expect(secondCreate.dependsOn).toContain(folderCreate.stepId);
    expect(firstCreate.payload.index).toBe(0);
    expect(secondCreate.payload.index).toBe(1);
    expect(folderCreate.order).toBeLessThan(firstCreate.order);
  });

  it('does not exchange duplicate URLs when mappings identify different native identities', () => {
    const a = remoteBookmark('remote-a', 'a', 'Same', mount.nodeId, 'https://duplicate.example/');
    const b = remoteBookmark('remote-b', 'b', 'Same', mount.nodeId, 'https://duplicate.example/');
    const plan = makePlan({ remote: [root, mount, a, b], local: [
      localMount(), localBookmark('native-a', 1, 'Same'), localBookmark('native-b', 0, 'Same'),
    ], mappings: [{ nativeId: 'native-a', colpId: a.nodeId }, { nativeId: 'native-b', colpId: b.nodeId }] });
    expect(plan.localOnly).toEqual([]);
    expect(plan.remoteOnly).toEqual([]);
    expect(localMoves(plan).map((step) => step.target.nativeId)).toEqual(['native-a', 'native-b']);
    expect(plan.matched).toEqual(expect.arrayContaining([
      { nativeId: 'native-a', nodeId: a.nodeId }, { nativeId: 'native-b', nodeId: b.nodeId },
    ]));
  });

  it('passes explicit indexes to create and move and converges after a move-side crash', async () => {
    const a = remoteBookmark('remote-a', 'a', 'A', mount.nodeId, 'https://native-a.example/');
    const b = remoteBookmark('remote-b', 'b', 'B', mount.nodeId, 'https://native-b.example/');
    const built = makePlan({ remote: [root, mount, a, b], local: [
      localMount(), localBookmark('native-a', 1, 'A'), localBookmark('native-b', 0, 'B'),
    ], mappings: [{ nativeId: 'native-a', colpId: a.nodeId }, { nativeId: 'native-b', colpId: b.nodeId }] });
    const move = localMoves(built).find((step) => step.target.nativeId === 'native-a')!;
    const memory = new MemoryNativeApi([
      { id: 'native-bar', parentId: 'native-root', title: 'Bar', index: 0 },
      { id: 'native-a', parentId: 'native-bar', title: 'A', url: 'https://native-a.example/', index: 1 },
      { id: 'native-b', parentId: 'native-bar', title: 'B', url: 'https://native-b.example/', index: 0 },
    ], { throwAfterMove: true });
    const store = await orderingStore();
    await putParentMapping(store);
    const completed = snapshotRecords([a, b]);
    const record = recordFor(move, 1, 'executing');
    await assert.rejects(() => executeAdvancedLocalStep({ store, scope, api: memory.api,
      record, step: move, completed }), /move_transport_failure/u);
    const afterCrash = await executeAdvancedLocalStep({ store, scope, api: memory.api,
      record, step: move, completed });
    expect(afterCrash.state).toBe('complete');
    expect(memory.moveCalls).toEqual([{ id: 'native-a', parentId: 'native-bar', index: 0 }]);
    expect(memory.children('native-bar').map((node) => node.id)).toEqual(['native-a', 'native-b']);
  });

  it('rejects a confirmed target renamed or moved by an external actor', async () => {
    const a = remoteBookmark('remote-a', 'a', 'A', mount.nodeId, 'https://native-a.example/');
    const b = remoteBookmark('remote-b', 'b', 'B', mount.nodeId, 'https://native-b.example/');
    const built = makePlan({ remote: [root, mount, a, b], local: [
      localMount(), localBookmark('native-a', 1, 'A'), localBookmark('native-b', 0, 'B'),
    ], mappings: [{ nativeId: 'native-a', colpId: a.nodeId }, { nativeId: 'native-b', colpId: b.nodeId }] });
    const move = localMoves(built).find((step) => step.target.nativeId === 'native-a')!;
    const store = await orderingStore(); await putParentMapping(store);
    const completed = snapshotRecords([a, b]);
    const renamed = new MemoryNativeApi([
      { id: 'native-a', parentId: 'native-bar', title: 'User rename', url: 'https://native-a.example/', index: 1 },
      { id: 'native-b', parentId: 'native-bar', title: 'B', url: 'https://native-b.example/', index: 0 },
    ]);
    const renamedResult = await executeAdvancedLocalStep({ store, scope, api: renamed.api,
      record: recordFor(move, 1, 'executing'), step: move, completed });
    expect(renamedResult).toEqual({ state: 'changed', code: 'advanced_step_changed' });

    const moved = new MemoryNativeApi([
      { id: 'native-a', parentId: 'native-other', title: 'A', url: 'https://native-a.example/', index: 0 },
      { id: 'native-b', parentId: 'native-bar', title: 'B', url: 'https://native-b.example/', index: 0 },
    ]);
    const movedResult = await executeAdvancedLocalStep({ store, scope, api: moved.api,
      record: recordFor(move, 1, 'executing'), step: move, completed });
    expect(movedResult).toEqual({ state: 'changed', code: 'advanced_step_changed' });
  });
});

function makePlan(overrides: {
  readonly remote: readonly RemoteNodeFact[]; readonly local: readonly LocalNodeFact[];
  readonly mappings: readonly { readonly nativeId: string; readonly colpId: string }[];
}): ReturnType<typeof buildAdvancedPlan> {
  return buildAdvancedPlan({ confirmationId: 'ordering-confirm', mode: 'download',
    remoteSnapshotId: 'ordering-snapshot', remoteRevision: 'ordering-revision', remoteCursor: 'ordering-cursor',
    scopeFingerprint: 'sha256:ordering-scope', treeDigest: 'sha256:ordering-tree', rootNodeId: root.nodeId,
    remote: overrides.remote, local: overrides.local, mappings: overrides.mappings, mounts: [mountFact] });
}

function localMount(): LocalNodeFact {
  return { nativeId: mountFact.nativeRootId, mountNativeRootId: mountFact.nativeRootId,
    parentNativeId: null, kind: 'folder', title: 'Bar', index: 0 };
}
function localBookmark(nativeId: string, index: number, title: string, parentNativeId = mountFact.nativeRootId,
  url = `https://${nativeId}.example/`): LocalNodeFact {
  return { nativeId, mountNativeRootId: mountFact.nativeRootId, parentNativeId, kind: 'bookmark', title, url, index };
}
function remoteFolder(nodeId: string, position: string, title: string, parentId = mount.nodeId): RemoteNodeFact {
  return { nodeId, parentId, kind: 'folder', title, revision: `${nodeId}-revision`,
    childrenRevision: `${nodeId}-children`, position };
}
function remoteBookmark(nodeId: string, position: string, title: string, parentId = mount.nodeId,
  url = `https://${nodeId}.example/`): RemoteNodeFact {
  return { nodeId, parentId, kind: 'bookmark', title, url, revision: `${nodeId}-revision`, position };
}
function localCreates(planValue: ReturnType<typeof buildAdvancedPlan>) {
  return planValue.steps.filter((step): step is Extract<AdvancedStep, { side: 'local'; action: 'create' }> =>
    step.side === 'local' && step.action === 'create');
}
function localMoves(planValue: ReturnType<typeof buildAdvancedPlan>) {
  return planValue.steps.filter((step): step is Extract<AdvancedStep, { side: 'local'; action: 'move' }> =>
    step.side === 'local' && step.action === 'move');
}

async function orderingStore() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'ordering-lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'ordering-revision', cursor: 'ordering-cursor' }, selectedRoots: [] });
  return store;
}
async function putParentMapping(store: ReturnType<typeof createSyncStateStore>) {
  await store.putMapping(scope, { nativeId: mountFact.nativeRootId, colpId: mount.nodeId,
    rootNativeId: mountFact.nativeRootId, mountId: `mount:${mountFact.nativeRootId}`, rootRole: mountFact.rootRole,
    nodeKind: 'folder', projection: { revision: mount.revision, digest: 'sha256:bar', content: { title: mount.title } } });
}
function snapshotRecords(facts: readonly RemoteNodeFact[]): AdvancedStepRecord[] {
  return facts.map((fact, index) => ({ scopeKey: 'scope', planId: 'ordering-plan', order: index,
    definition: { kind: 'snapshot-fact', fact, nativeId: fact.nodeId === mount.nodeId ? mountFact.nativeRootId : null } as unknown as JsonObject,
    digest: `sha256:snapshot-${index}`, state: 'terminal', evidence: { targetId: fact.nodeId, revision: fact.revision } }));
}
function recordFor(step: Extract<AdvancedStep, { side: 'local' }>, order: number,
  state: AdvancedStepRecord['state']): AdvancedStepRecord {
  return { scopeKey: 'scope', planId: 'ordering-plan', order,
    definition: step as unknown as JsonObject, digest: 'sha256:step', state };
}

class MemoryNativeApi {
  readonly nodes = new Map<string, AdvancedNativeNode>();
  readonly moveCalls: Array<{ readonly id: string; readonly parentId: string; readonly index: number }> = [];
  readonly createCalls: Array<{ readonly parentId: string; readonly title: string; readonly index: number }> = [];
  private sequence = 0;
  private throwAfterMove: boolean;
  readonly api: AdvancedNativeApi;

  constructor(seed: readonly AdvancedNativeNode[], options: { readonly throwAfterMove?: boolean } = {}) {
    for (const node of seed) this.nodes.set(node.id, { ...node });
    this.throwAfterMove = options.throwAfterMove === true;
    this.api = {
      get: async (id) => { const node = this.nodes.get(id); return node ? [node] : []; },
      getChildren: async (id) => this.children(id),
      create: async (input) => this.create(input),
      update: async (id, input) => this.update(id, input),
      move: async (id, input) => this.move(id, input),
      remove: async (id) => { this.nodes.delete(id); this.reindex(); },
    };
  }
  children(parentId: string): AdvancedNativeNode[] {
    return [...this.nodes.values()].filter((node) => node.parentId === parentId)
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  }
  private create(input: { readonly parentId: string; readonly title: string; readonly url?: string; readonly index: number }) {
    const id = `created-${++this.sequence}`;
    const node = { id, ...input };
    this.nodes.set(id, node); this.reindex(); this.createCalls.push({ parentId: input.parentId, title: input.title, index: input.index });
    return this.nodes.get(id)!;
  }
  private update(id: string, input: { readonly title?: string; readonly url?: string }) {
    const node = this.nodes.get(id)!; const updated = { ...node, ...input }; this.nodes.set(id, updated); return updated;
  }
  private move(id: string, input: { readonly parentId: string; readonly index: number }) {
    const current = this.nodes.get(id)!;
    const siblings = this.children(input.parentId).filter((node) => node.id !== id);
    siblings.splice(Math.min(input.index, siblings.length), 0, { ...current, parentId: input.parentId });
    this.nodes.set(id, { ...current, parentId: input.parentId }); this.reindexList(input.parentId, siblings);
    this.moveCalls.push({ id, parentId: input.parentId, index: input.index });
    const result = this.nodes.get(id)!;
    if (this.throwAfterMove) { this.throwAfterMove = false; throw new Error('move_transport_failure'); }
    return result;
  }
  private reindexList(parentId: string, siblings: readonly AdvancedNativeNode[]) {
    siblings.forEach((node, index) => this.nodes.set(node.id, { ...this.nodes.get(node.id)!, parentId, index }));
  }
  private reindex() {
    const parents = new Set([...this.nodes.values()].flatMap((node) => node.parentId ? [node.parentId] : []));
    for (const parent of parents) this.reindexList(parent, this.children(parent));
  }
}
