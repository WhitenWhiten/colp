import { IDBFactory } from 'fake-indexeddb';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';

export const t02Scope: SyncScope = {
  environment: 'production', serverId: 'server-t02', serverOrigin: 'https://known.example',
  accountId: 'account-t02', browserProfileId: 'profile-t02', collectionId: 'collection-t02',
  replicaId: 'replica-t02', generation: 1,
};

export type HonestChromeNode = {
  readonly id: string; parentId?: string; index?: number; title?: string; url?: string;
};

export type HonestChrome = PullBookmarkApi & {
  readonly calls: Array<{ kind: string; nativeId?: string }>;
  seed(node: HonestChromeNode): void;
  getNode(id: string): HonestChromeNode | undefined;
  all(): HonestChromeNode[];
  onCreated?: (node: HonestChromeNode) => Promise<void>;
};

const MISSING = "Can't find bookmark for id.";

export function honestChrome(): HonestChrome {
  const nodes = new Map<string, HonestChromeNode>();
  const calls: Array<{ kind: string; nativeId?: string }> = [];
  const api: HonestChrome = {
    calls,
    seed(node) { nodes.set(node.id, { ...node }); },
    getNode(id) { return nodes.get(id); },
    all() { return [...nodes.values()]; },
    async create(input) {
      const id = `created-${calls.length}`;
      const node: HonestChromeNode = {
        id, parentId: input.parentId, index: input.index, title: input.title, url: input.url,
      };
      nodes.set(id, node);
      calls.push({ kind: 'create', nativeId: id });
      if (api.onCreated) await api.onCreated(node);
      return { id };
    },
    async update(id, changes) {
      const current = nodes.get(id);
      if (!current) throw new Error(MISSING);
      nodes.set(id, { ...current, ...changes });
      calls.push({ kind: 'update', nativeId: id });
    },
    async move(id, destination) {
      const current = nodes.get(id);
      if (!current) throw new Error(MISSING);
      nodes.set(id, { ...current, ...destination });
      calls.push({ kind: 'move', nativeId: id });
    },
    async remove(id) {
      if (!nodes.has(id)) throw new Error(MISSING);
      nodes.delete(id);
      calls.push({ kind: 'delete', nativeId: id });
    },
    async removeTree(id) {
      if (!nodes.has(id)) throw new Error(MISSING);
      for (const child of [...nodes.values()].filter((node) => node.parentId === id)) nodes.delete(child.id);
      nodes.delete(id);
      calls.push({ kind: 'delete', nativeId: id });
    },
    async get(id) {
      const node = nodes.get(id);
      if (!node) throw new Error(MISSING);
      return [node];
    },
    async getChildren(id) {
      if (!nodes.has(id)) throw new Error(MISSING);
      return [...nodes.values()].filter((node) => node.parentId === id);
    },
  };
  return api;
}

export function mapping(nativeId: string, colpId: string, parentNativeId?: string) {
  return {
    nativeId, colpId, rootNativeId: 'native-root',
    nodeKind: (colpId === 'root-colp' ? 'folder' : 'bookmark') as 'folder' | 'bookmark',
    ...(parentNativeId ? { parentNativeId } : {}),
    projection: {
      revision: 'revision-old', resourceRevision: 'revision-old',
      childrenRevision: colpId === 'root-colp' ? 'children-old' : null,
      digest: `sha256:${colpId}`, content: { title: colpId, url: 'https://example.test/' },
    },
  };
}

export async function setupT02(crash?: string) {
  const indexedDB = new IDBFactory();
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...t02Scope, lifecycle: 'active',
    lease: { leaseId: 'lease-t02', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' },
    selectedRoots: ['root-colp'], rootStatus: 'ready', firstRun: 'completed',
  });
  await store.putMapping(t02Scope, mapping('native-root', 'root-colp'));
  await store.putMountBinding(t02Scope, {
    mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar',
  });
  const api = honestChrome();
  api.seed({ id: 'native-root', index: 0, title: 'root-colp' });
  let crashBoundary = crash;
  const options = {
    scope: t02Scope, store, api,
    session: {
      acceptedProtocolVersion: '0.2' as const, sessionId: 'session-t02',
      collectionId: t02Scope.collectionId, conversionPolicy: { separator: 'preserve_remote' as const },
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
    createEvent: (kind: 'Folder' | 'Bookmark' = 'Bookmark', sequence = ++ordinal) =>
      pullFixtures.createEvent({ kind, sequence, collectionId: t02Scope.collectionId, parentId: 'root-colp' }),
    page: (events: readonly unknown[], nextCursor = 'cursor-next') =>
      pullFixtures.page({ events, nextCursor, collectionRevision: 'revision-next' }),
    disableCrash: () => { crashBoundary = undefined; },
    setCrash: (at: string) => { crashBoundary = at; },
  };
}

export async function reopenT02(fixture: Awaited<ReturnType<typeof setupT02>>) {
  fixture.store.close();
  const store = createSyncStateStore({ indexedDB: fixture.indexedDB });
  const options = { ...fixture.options, store, crash: fixture.options.crash };
  return { ...fixture, store, options, applier: createPullApplier(options) };
}
