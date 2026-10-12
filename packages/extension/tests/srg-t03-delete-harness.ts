import { IDBFactory } from 'fake-indexeddb';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { CHROME_BOOKMARK_NOT_FOUND } from '../src/bookmark-api-error.js';
import { pullFixtures } from './pull-effect-fixtures.js';

export const t03Scope: SyncScope = {
  environment: 'production', serverId: 'server-t03', serverOrigin: 'https://known.example',
  accountId: 'account-t03', browserProfileId: 'profile-t03', collectionId: 'collection-t03',
  replicaId: 'replica-t03', generation: 1,
};

export type HonestChromeNode = {
  readonly id: string; parentId?: string; index?: number; title?: string; url?: string;
  unmodifiable?: string;
};

export type HonestChrome = PullBookmarkApi & {
  readonly calls: Array<{ kind: string; nativeId?: string }>;
  seed(node: HonestChromeNode): void;
  getNode(id: string): HonestChromeNode | undefined;
  all(): HonestChromeNode[];
  denyPermission(nativeId: string): void;
};

export function honestChrome(): HonestChrome {
  const nodes = new Map<string, HonestChromeNode>();
  const denied = new Set<string>();
  const calls: Array<{ kind: string; nativeId?: string }> = [];
  const requireNode = (id: string): HonestChromeNode => {
    const node = nodes.get(id);
    if (!node) throw new Error(CHROME_BOOKMARK_NOT_FOUND);
    if (denied.has(id)) throw new Error('User denied permission to modify bookmarks.');
    return node;
  };
  const childrenOf = (parentId: string): HonestChromeNode[] =>
    [...nodes.values()].filter((node) => node.parentId === parentId)
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const reindex = (parentId: string | undefined): void => {
    if (!parentId) return;
    childrenOf(parentId).forEach((child, index) => { nodes.set(child.id, { ...child, index }); });
  };
  const deleteRecursive = (id: string): void => {
    for (const child of childrenOf(id)) deleteRecursive(child.id);
    nodes.delete(id);
  };
  const api: HonestChrome = {
    calls,
    seed(node) { nodes.set(node.id, { ...node }); reindex(node.parentId); },
    getNode(id) { return nodes.get(id); },
    all() { return [...nodes.values()]; },
    denyPermission(nativeId) { denied.add(nativeId); },
    async create(input) {
      const parentId = input.parentId;
      if (parentId) requireNode(parentId);
      if (parentId && denied.has(parentId)) throw new Error('User denied permission to modify bookmarks.');
      const siblings = parentId ? childrenOf(parentId) : [];
      const index = input.index ?? siblings.length;
      for (const sibling of siblings) {
        if ((sibling.index ?? 0) >= index) {
          nodes.set(sibling.id, { ...sibling, index: (sibling.index ?? 0) + 1 });
        }
      }
      const id = `created-${calls.length}`;
      const node: HonestChromeNode = {
        id, parentId, index, title: input.title, url: input.url,
      };
      nodes.set(id, node);
      calls.push({ kind: 'create', nativeId: id });
      return { id };
    },
    async update(id, changes) {
      const current = requireNode(id);
      nodes.set(id, { ...current, ...changes });
      calls.push({ kind: 'update', nativeId: id });
    },
    async move(id, destination) {
      const current = requireNode(id);
      const oldParent = current.parentId;
      nodes.delete(id);
      reindex(oldParent);
      const parentId = destination.parentId ?? oldParent;
      if (parentId) requireNode(parentId);
      const siblings = parentId ? childrenOf(parentId) : [];
      const index = destination.index ?? siblings.length;
      for (const sibling of siblings) {
        if ((sibling.index ?? 0) >= index) {
          nodes.set(sibling.id, { ...sibling, index: (sibling.index ?? 0) + 1 });
        }
      }
      nodes.set(id, { ...current, parentId, index });
      calls.push({ kind: 'move', nativeId: id });
    },
    async remove(id) {
      const current = requireNode(id);
      if (childrenOf(id).length) throw new Error("Can't remove non-empty folder (use removeTree).");
      nodes.delete(id);
      reindex(current.parentId);
      calls.push({ kind: 'delete', nativeId: id });
    },
    async removeTree(id) {
      const current = requireNode(id);
      const parentId = current.parentId;
      deleteRecursive(id);
      reindex(parentId);
      calls.push({ kind: 'delete', nativeId: id });
    },
    async get(id) { return [requireNode(id)]; },
    async getChildren(id) {
      requireNode(id);
      return childrenOf(id);
    },
  };
  return api;
}

export function mapping(nativeId: string, colpId: string, input: {
  readonly parentNativeId?: string; readonly nodeKind?: MappingInput['nodeKind'];
  readonly parentColpId?: string; readonly rootNativeId?: string;
} = {}): MappingInput {
  const nodeKind = input.nodeKind ?? (colpId === 'root-colp' ? 'folder' : 'bookmark');
  return {
    nativeId, colpId, rootNativeId: input.rootNativeId ?? 'native-root', nodeKind,
    ...(input.parentNativeId ? { parentNativeId: input.parentNativeId } : {}),
    ...(input.parentColpId ? { parentColpId: input.parentColpId } : {}),
    projection: {
      revision: 'revision-old', resourceRevision: 'revision-old',
      childrenRevision: nodeKind === 'folder' ? 'children-old' : null,
      digest: `sha256:${colpId}`, content: { title: colpId, url: 'https://example.test/' },
    },
  };
}

export async function setupT03(crash?: string) {
  const indexedDB = new IDBFactory();
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...t03Scope, lifecycle: 'active',
    lease: { leaseId: 'lease-t03', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' },
    selectedRoots: ['root-colp'], rootStatus: 'ready', firstRun: 'completed',
  });
  await store.putMapping(t03Scope, mapping('native-root', 'root-colp', { nodeKind: 'folder' }));
  await store.putMountBinding(t03Scope, {
    mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar',
  });
  const api = honestChrome();
  api.seed({ id: 'native-root', index: 0, title: 'root-colp' });
  let crashBoundary = crash;
  const options = {
    scope: t03Scope, store, api,
    session: {
      acceptedProtocolVersion: '0.2' as const, sessionId: 'session-t03',
      collectionId: t03Scope.collectionId, conversionPolicy: { separator: 'preserve_remote' as const },
    },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    effectPageAuthority: 'https://known.example',
    crash: (at: string) => {
      if (crashBoundary === at) { crashBoundary = undefined; throw new Error('worker_crash'); }
    },
  };
  const applier = createPullApplier(options);
  let ordinal = 0;
  return {
    indexedDB, store, api, options, applier,
    mutationEvent: (kind: 'update' | 'move' | 'delete', targetId = 'node-1', targetKind: 'bookmark' | 'folder' = 'bookmark') =>
      pullFixtures.mutationEvent({
        kind, sequence: ++ordinal, collectionId: t03Scope.collectionId, targetId,
        parentId: 'root-colp', targetKind,
      }),
    subtreeEvent: (members: string[], targetId = 'node-1') =>
      pullFixtures.subtreeEvent({
        sequence: ++ordinal, collectionId: t03Scope.collectionId, targetId, members, paged: false,
      }),
    page: (events: readonly unknown[], nextCursor = 'cursor-next') =>
      pullFixtures.page({ events, nextCursor, collectionRevision: 'revision-next' }),
    disableCrash: () => { crashBoundary = undefined; },
    setCrash: (at: string) => { crashBoundary = at; },
  };
}

export async function reopenT03(fixture: Awaited<ReturnType<typeof setupT03>>) {
  fixture.store.close();
  const store = createSyncStateStore({ indexedDB: fixture.indexedDB });
  const options = { ...fixture.options, store, crash: fixture.options.crash };
  return { ...fixture, store, options, applier: createPullApplier(options) };
}

export async function seedMappedNode(fixture: Awaited<ReturnType<typeof setupT03>>, input: {
  readonly nativeId: string; readonly colpId: string; readonly parentNativeId: string;
  readonly parentColpId: string; readonly nodeKind: 'folder' | 'bookmark';
  readonly title?: string; readonly url?: string; readonly index?: number;
}) {
  const seeded = mapping(input.nativeId, input.colpId, {
    parentNativeId: input.parentNativeId, parentColpId: input.parentColpId, nodeKind: input.nodeKind,
  });
  await fixture.store.putMapping(t03Scope, { ...seeded, projection: { ...seeded.projection,
    content: { title: input.colpId, ...(input.url === undefined ? {} : { url: input.url }) },
  } });
  fixture.api.seed({
    id: input.nativeId, parentId: input.parentNativeId, index: input.index ?? 0,
    title: input.title ?? input.colpId, url: input.url,
  });
}
