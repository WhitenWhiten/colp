import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { LIBRARY_STATE } from '../src/library.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { SyncScope } from '../src/sync-state-store.js';
import { store, sw, syncState } from '../src/sw/runtime.js';
import { installRejoinHttp, REJOIN_TOKEN, rejoinSession } from './rejoin-http-fixture.js';

// Replace browser/account/HTTP ports and scheduling only. The handlers, authority
// fence, credentials, scanners, coordinators, journal and IndexedDB are real.
vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  const { createCredentialStore } = await import('../src/credential-store.js');
  const { createExtensionWorkCoordinator } = await import('../src/authority-fence.js');
  const store = createCredentialStore({ get: keys => storage.get(keys),
    set: values => storage.set(values), remove: keys => storage.remove(keys) });
  return { store, workCoordinator: createExtensionWorkCoordinator(store.fence),
    syncState: createSyncStateStore({ indexedDB: new IDBFactory() }), sw: { rootViewTokens: undefined },
    hasBookmarkPermission: async () => ports.permission,
    extensionOrigin: () => 'chrome-extension://authority-entry',
    rootScopeKey: (value: unknown) => JSON.stringify(value), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({
  currentSyncScope: async () => { if (ports.scopeError) throw ports.scopeError; return scope; },
  restoredSyncScope: async () => { if (ports.scopeError) throw ports.scopeError; return scope; },
  requireSyncScope: async () => { ports.joined++; if (ports.joinError) throw ports.joinError; return scope; },
  loadConfig: async () => ({ serverOrigin: scope.serverOrigin, manifestUrl: `${scope.serverOrigin}/manifest.json` }),
  boundCollectionId: async () => scope.collectionId,
}));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

export let scope: SyncScope, tree: ChromeBookmarkNode[], storage: MemoryStorageArea;
export let httpRequests: ReturnType<typeof installRejoinHttp>;
export const ports = { permission: true, scopeError: undefined as Error | undefined,
  joinError: undefined as Error | undefined, treeError: undefined as Error | undefined, joined: 0 };
let serial = 0;
const flatten = (rows: readonly ChromeBookmarkNode[]): ChromeBookmarkNode[] => rows.flatMap(row => [row, ...flatten(row.children ?? [])]);
export function node(id: string) {
  const found = flatten(tree).find(row => row.id === id);
  if (!found) throw new Error(`Can't find bookmark for id. ${id}`);
  return found;
}
export function replaceTree(value: ChromeBookmarkNode[]) { tree = value; }

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(ports, { permission: true, scopeError: undefined, joinError: undefined, treeError: undefined, joined: 0 });
  scope = { environment: 'production', serverId: 'server', serverOrigin: 'https://authority.test',
    accountId: `authority-entry-${++serial}`, browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
  tree = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bar', folderType: 'bookmarks-bar', children: [
      { id: '10', parentId: '1', title: 'Selected folder', children: [
        { id: '11', parentId: '10', title: 'Selected bookmark', url: 'https://example.test/selected' },
      ] }, { id: '20', parentId: '1', title: 'Private folder', children: [
        { id: '21', parentId: '20', title: 'Private bookmark', url: 'https://example.test/private' },
      ] },
    ] }, { id: '2', parentId: '0', title: 'Other', folderType: 'other', children: [] },
  ] }];
  storage = new MemoryStorageArea();
  vi.stubGlobal('chrome', { storage: { local: storage }, bookmarks: {
    getTree: vi.fn(async () => { if (ports.treeError) throw ports.treeError; return structuredClone(tree); }),
    get: vi.fn(async (id: string) => [structuredClone(node(id))]),
    getChildren: vi.fn(async (id: string) => structuredClone(node(id).children ?? [])),
    create: vi.fn(async () => { throw new Error('unexpected native create'); }),
    update: vi.fn(async () => { throw new Error('unexpected native update'); }),
    move: vi.fn(async () => { throw new Error('unexpected native move'); }),
    remove: vi.fn(async () => { throw new Error('unexpected native remove'); }),
    removeTree: vi.fn(async () => { throw new Error('unexpected native removeTree'); }),
  } });
  await store.fence.activate();
  await store.saveCredential({ accessToken: REJOIN_TOKEN, tokenType: 'Bearer', subject: scope.accountId,
    accountLabel: 'Entry fixture', expiresAt: Date.now() + 3_600_000, scope: ['known.sync'], serverOrigin: scope.serverOrigin,
    issuer: `${scope.serverOrigin}/`, audience: 'known-sync-api', clientId: 'known-chromium-extension' });
  await store.saveSession(await rejoinSession(scope));
  await storage.set({ [LIBRARY_STATE]: { accountId: scope.accountId, serverOrigin: scope.serverOrigin, status: 'ready',
    library: { id: scope.collectionId, title: 'Library', rootNodeId: 'library-root', library: true,
      bookmarksBarId: 'remote-1', otherBookmarksId: 'remote-2' } } });
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { serverRevision: 'cloud-revision', cursor: 'cloud-cursor' },
    selectedRoots: [], privateRoots: [], firstRun: 'none', rootStatus: 'ready' });
  sw.rootViewTokens = undefined;
  httpRequests = installRejoinHttp(() => scope, () => []);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => syncState.close());

export async function seedSelected() {
  const { readRootFolders } = await import('../src/sw/roots.js');
  for (const id of ['1', '10', '11', '20', '21']) {
    const value = node(id);
    await syncState.putMapping(scope, { nativeId: id, colpId: `remote-${id}`, rootNativeId: '1', mountId: 'mount-bar',
      nodeKind: value.url ? 'bookmark' : 'folder', ...(id === '1' ? { rootRole: 'bookmarks-bar' as const }
        : { parentNativeId: value.parentId, parentColpId: `remote-${value.parentId}` }),
      projection: { revision: `r-${id}`, digest: `sha256:${id}`, content: { title: value.title, ...(value.url ? { url: value.url } : {}) } } });
  }
  await syncState.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'remote-1',
    rootRole: 'bookmarks-bar', boundaryVersion: '0', status: 'active', materialized: false });
  await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
    selectedNativeIds: ['1'], privateNativeIds: ['20'], status: 'ready' });
}

export async function expectNoWork() {
  expect(await syncState.listQueue(scope)).toEqual([]);
  expect(await syncState.listPendingBoundaryCommands(scope)).toEqual([]);
  for (const name of ['create', 'update', 'move', 'remove', 'removeTree'] as const) expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
}
