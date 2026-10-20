import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createAuthorityFence } from '../src/authority-fence.js';
import { provisionDefaultSyncRoot, readRootFolders } from '../src/sw/roots.js';
import { sw, syncState } from '../src/sw/runtime.js';
import { recoveryRoot } from './kns-03-bootstrap-harness.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { SyncScope } from '../src/sync-state-store.js';

vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  return { syncState: { ...createSyncStateStore({ indexedDB: new IDBFactory() }) }, sw: { rootViewTokens: undefined },
    hasBookmarkPermission: async () => true, rootScopeKey: (value: unknown) => JSON.stringify(value), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/sw/library.js', () => ({ resolveLibraryRootId: async () => 'canonical-root' }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

let scope: SyncScope, tree: ChromeBookmarkNode[], storage: MemoryStorageArea, serial = 0;
let crashNativeReply = false;
const create = vi.fn(async (input: { parentId?: string; title?: string }) => {
  const parent = find(input.parentId!);
  const created = { id: `native-${100 + create.mock.calls.length}`, parentId: parent.id, title: input.title ?? '', children: [] };
  tree = tree.map(root => ({ ...root, children: root.children?.map(row => row.id === parent.id
    ? { ...row, children: [...row.children ?? [], created] } : row) }));
  if (crashNativeReply) { crashNativeReply = false; throw new Error('worker_crash'); }
  return structuredClone(created);
});
function find(id: string): ChromeBookmarkNode {
  const pending = [...tree];
  while (pending.length) { const row = pending.pop()!; if (row.id === id) return row; pending.push(...row.children ?? []); }
  throw new Error("Can't find bookmark for id.");
}
beforeEach(async () => {
  scope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test', accountId: `default-root-${++serial}`,
    browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
  storage = new MemoryStorageArea(); await createAuthorityFence(storage).activate();
  sw.rootViewTokens = undefined; crashNativeReply = false; create.mockClear();
  tree = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [] },
    { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] },
  ] }];
  vi.stubGlobal('chrome', { storage: { local: storage }, bookmarks: {
    getTree: async () => structuredClone(tree), get: async (id: string) => [structuredClone(find(id))],
    getChildren: async (id: string) => structuredClone(find(id).children ?? []),
    getSubTree: async (id: string) => [structuredClone(find(id))], create,
  } });
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], privateRoots: [], rootStatus: 'ready', firstRun: 'completed' });
  await syncState.stageRecoveryPage(scope, { snapshotId: 'snapshot', revision: 'r1', syncCursor: 'cursor-snapshot',
    identityDigest: 'identity', rootNodeId: 'canonical-root', page: 0, pageDigest: 'sha256:page',
    previousPageDigest: null, nextCursor: null, complete: true, nodes: [recoveryRoot('canonical-root')] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => syncState.close());
const provision = () => provisionDefaultSyncRoot(scope, { explicitCreateKnowNFolder: true });

test.each(['callback-lost', 'before-receipt'] as const)(
  'default folder creation interrupted at %s remains unknown after reopen and never adopts a matching title', async boundary => {
    const original = syncState.persistApplyIntentFacts.bind(syncState);
    let interrupted = false;
    const fault = vi.spyOn(syncState, 'persistApplyIntentFacts').mockImplementation(async (target, id, patch) => {
      if (boundary === 'before-receipt' && patch.apiResultEvidence && !interrupted) {
        interrupted = true; throw new Error('worker_crash');
      }
      return original(target, id, patch);
    });
    crashNativeReply = boundary === 'callback-lost';
    await expect(provision()).rejects.toThrow('worker_crash');
    expect(create).toHaveBeenCalledTimes(1);
    const created = find('1').children![0]!;
    expect(created.title).toBe('Know-N');
    const intents = await syncState.listApplyIntents(scope);
    expect(intents).toHaveLength(1); expect(intents[0]?.apiResultEvidence).toBeUndefined();
    fault.mockRestore(); syncState.close();
    expect(await provision()).toBeUndefined(); expect(await provision()).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect((await syncState.getApplyIntent(scope, intents[0]!.intentId))?.nativeResult).toBe('result_unknown');
    expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
    expect(await syncState.listQueue(scope)).toEqual([]);
    expect(await syncState.listMountBindings(scope)).toEqual([]);
    expect(find('1').children).toEqual([created]);
  });

test('a durable API native ID is reused after receipt persistence but before range admission', async () => {
  const original = syncState.persistApplyIntentFacts.bind(syncState);
  let interrupted = false;
  const fault = vi.spyOn(syncState, 'persistApplyIntentFacts').mockImplementation(async (target, id, patch) => {
    const value = await original(target, id, patch);
    if (patch.apiResultEvidence && !interrupted) { interrupted = true; throw new Error('worker_crash'); }
    return value;
  });
  await expect(provision()).rejects.toThrow('worker_crash');
  const intent = (await syncState.listApplyIntents(scope))[0]!;
  expect(intent.apiResultEvidence?.nativeId).toBe('native-101');
  fault.mockRestore(); syncState.close();
  expect(await provision()).toBe('native-101');
  expect(create).toHaveBeenCalledTimes(1);
  expect((await syncState.listMountBindings(scope)).map(row => row.nativeRootId)).toEqual(['native-101']);
  const queue = await syncState.listQueue(scope);
  expect(queue).toHaveLength(1); expect(queue[0]?.payload.type).toBe('create_node');
  syncState.close(); expect(await provision()).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(1); expect(await syncState.listQueue(scope)).toEqual(queue);
});

test('a newer confirmed selection wins over a default-folder call returning from Chrome', async () => {
  const original = syncState.persistApplyIntentFacts.bind(syncState);
  let changed = false;
  vi.spyOn(syncState, 'persistApplyIntentFacts').mockImplementation(async (target, id, patch) => {
    const value = await original(target, id, patch);
    if (patch.apiResultEvidence && !changed) {
      changed = true;
      await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
        selectedNativeIds: ['2'], privateNativeIds: [], status: 'ready' });
      await syncState.bumpBoundaryVersion(scope);
    }
    return value;
  });
  expect(await provision()).toBeUndefined();
  const authority = (await syncState.getScope(scope))!;
  expect(authority.boundaryVersion).toBe('1'); expect(authority.selectedRoots).toHaveLength(1);
  expect((await syncState.getMappingByColpId(scope, authority.selectedRoots[0]!))?.nativeId).toBe('2');
  syncState.close(); expect(await provision()).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(1); expect(await syncState.listQueue(scope)).toEqual([]);
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual(authority.selectedRoots);
});

test('account A to B to A invalidates the in-flight default-root attempt after Chrome returns', async () => {
  const original = syncState.persistApplyIntentFacts.bind(syncState), fence = createAuthorityFence(storage);
  let changed = false;
  vi.spyOn(syncState, 'persistApplyIntentFacts').mockImplementation(async (target, id, patch) => {
    const value = await original(target, id, patch);
    if (patch.apiResultEvidence && !changed) { changed = true; await fence.activate(); await fence.activate(); }
    return value;
  });
  await expect(provision()).rejects.toThrow('authority_fenced');
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
  expect(await syncState.listQueue(scope)).toEqual([]); expect(create).toHaveBeenCalledTimes(1);
  syncState.close();
  // A new explicit user action can use the durable native receipt, never a title match.
  expect(await provision()).toBe('native-101'); expect(create).toHaveBeenCalledTimes(1);
});
