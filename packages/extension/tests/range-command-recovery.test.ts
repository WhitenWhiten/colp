import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { handleRootRequest, loadRootView, readRootFolders } from '../src/sw/roots.js';
import { sw, syncState } from '../src/sw/runtime.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { RootRequest } from '../src/types.js';
import type { SyncScope } from '../src/sync-state-store.js';
import { recoveryNode, recoveryRoot } from './kns-03-bootstrap-harness.js';

// Browser and wake scheduling are external ports. Admission, phase execution,
// bootstrap, immutable queue entries and IndexedDB reopen are the shipped code.
vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  return { syncState: { ...createSyncStateStore({ indexedDB: new IDBFactory() }) }, sw: { rootViewTokens: undefined },
    hasBookmarkPermission: async () => true, rootScopeKey: (value: unknown) => JSON.stringify(value), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
vi.mock('../src/sw/library.js', () => ({ resolveLibraryRootId: async () => 'canonical-root' }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));
let scope: SyncScope, raw: ChromeBookmarkNode[], serial = 0;
beforeEach(async () => {
  scope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test', accountId: `journal-${++serial}`,
    browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
  sw.rootViewTokens = undefined;
  raw = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bar', folderType: 'bookmarks-bar', children: [
      { id: '10', parentId: '1', title: 'Old folder', children: [
        { id: '11', parentId: '10', title: 'Old bookmark', url: 'https://example.test/old' },
      ] },
    ] },
    { id: '2', parentId: '0', title: 'Other', folderType: 'other', children: [
      { id: '20', parentId: '2', title: 'New folder', children: [
        { id: '21', parentId: '20', title: 'New bookmark', url: 'https://example.test/new' },
      ] },
    ] },
  ] }];
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => {} } },
    bookmarks: { getTree: async () => structuredClone(raw), create: vi.fn(), update: vi.fn(), move: vi.fn(), remove: vi.fn(), removeTree: vi.fn() } });
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], privateRoots: [], rootStatus: 'ready', firstRun: 'completed' });
  for (const [id, parent, title, url] of [['1', '', 'Bar'], ['10', '1', 'Old folder'], ['11', '10', 'Old bookmark', 'https://example.test/old']]) {
    await syncState.putMapping(scope, { nativeId: id!, colpId: `remote-${id}`, rootNativeId: '1', mountId: 'mount-1',
      nodeKind: url ? 'bookmark' : 'folder', ...(parent ? { parentNativeId: parent, parentColpId: `remote-${parent}` } : { rootRole: 'bookmarks-bar' }),
      projection: { revision: `r-${id}`, digest: `sha256:${id}`, ...(url ? {} : { childrenRevision: `c-${id}` }),
        content: { title: title!, ...(url ? { url } : {}), ...(id === '1' ? { folderRole: 'bookmarks-bar' } : {}) } } });
  }
  await syncState.putMountBinding(scope, { mountId: 'mount-1', nativeRootId: '1', remoteMountNodeId: 'remote-1',
    rootRole: 'bookmarks-bar', status: 'active', materialized: true, boundaryVersion: '0' });
  await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
    selectedNativeIds: ['1'], privateNativeIds: [], status: 'ready' });
  await syncState.stageRecoveryPage(scope, { snapshotId: 'snapshot', revision: 'r1', syncCursor: 'cursor-snapshot',
    identityDigest: 'identity', rootNodeId: 'canonical-root', page: 0, pageDigest: 'sha256:page',
    previousPageDigest: null, nextCursor: null, complete: true, nodes: [recoveryRoot('canonical-root'),
      recoveryNode('remote-1', 'canonical-root', 'Folder', { title: 'Bar', folderRole: 'bookmarks-bar' }, 'bookmarks-bar'),
      { ...recoveryNode('remote-2', 'canonical-root', 'Folder', { title: 'Other', folderRole: 'other-bookmarks' }),
        mapping: { ...recoveryNode('remote-2', 'canonical-root', 'Folder', { title: 'Other', folderRole: 'other-bookmarks' }).mapping,
          rootRole: 'other-bookmarks' } },
      recoveryNode('remote-10', 'remote-1', 'Folder', { title: 'Old folder' }),
      recoveryNode('remote-11', 'remote-10', 'Bookmark', { title: 'Old bookmark', url: 'https://example.test/old' }),
    ] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => syncState.close());

async function review(): Promise<Extract<RootRequest, { kind: 'known.roots.confirm' }>> {
  const view = await loadRootView(scope);
  const result = await handleRootRequest({ kind: 'known.roots.preview', viewId: view.viewId,
    selectedRefs: [view.roots.find(row => row.kind === 'other')!.ref], privateRefs: [] });
  if (!result.ok || !('preview' in result)) throw new Error('preview_missing');
  return { kind: 'known.roots.confirm', previewId: result.preview.previewId, treeDigest: result.preview.treeDigest,
    confirmationId: crypto.randomUUID(), remoteDeleteRefs: result.preview.removals.map(row => row.ref) };
}

test.each(['mounts', 'bootstrap', 'private-mappings', 'subtree-mappings', 'root-authority', 'remote-delete:1'])(
  'reopen after %s side effects resumes one command, preserves native bookmarks and enqueues cloud trash once', async phase => {
    const request = await review(), original = syncState.advanceBoundaryCommand.bind(syncState);
    const beforeNative = structuredClone(raw);
    let failed = false;
    const crash = vi.spyOn(syncState, 'advanceBoundaryCommand').mockImplementation(async (target, id, patch) => {
      if (!failed && patch.step === phase) { failed = true; throw new Error('worker_crash'); }
      return original(target, id, patch);
    });
    expect(await handleRootRequest(request)).toMatchObject({ ok: false, error: 'confirmation_pending',
      confirmation: { confirmationId: request.confirmationId, state: 'failed' } });
    expect(failed).toBe(true);
    const pending = (await syncState.getBoundaryCommand(scope, request.confirmationId))!;
    expect(pending.completedSteps).not.toContain(phase);
    expect((await syncState.getScope(scope))?.boundaryVersion ?? '0').toBe('0');
    crash.mockRestore(); syncState.close();
    expect(await handleRootRequest({ kind: 'known.roots.get' })).toMatchObject({ ok: true, view: { status: 'ready' } });
    expect(await syncState.getBoundaryCommand(scope, request.confirmationId)).toMatchObject({ state: 'committed' });
    expect((await syncState.getScope(scope))?.boundaryVersion).toBe('1');
    expect((await syncState.getScope(scope))?.selectedRoots).toEqual(['remote-2']);
    const queue = await syncState.listQueue(scope);
    expect(queue.filter(row => row.payload.type === 'delete_subtree').map(row => row.payload.targetId)).toEqual(['remote-10']);
    expect(queue.filter(row => row.payload.type === 'create_node' && row.opId.endsWith('.create.20'))).toHaveLength(1);
    expect(await syncState.listBootstrapRuns(scope)).toHaveLength(1);
    expect(raw).toEqual(beforeNative);
    for (const method of ['create', 'update', 'move', 'remove', 'removeTree'] as const) expect(chrome.bookmarks[method]).not.toHaveBeenCalled();
    expect(await handleRootRequest(request)).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
    expect(await syncState.listQueue(scope)).toEqual(queue);
    expect((await syncState.getScope(scope))?.boundaryVersion).toBe('1');
  });

test('legacy direct range writes cannot bypass the preview and admission boundary', async () => {
  const view = await loadRootView(scope), before = await syncState.exportScope(scope);
  expect(await handleRootRequest({ kind: 'known.roots.update', viewId: view.viewId, selectedRefs: [], privateRefs: [] }))
    .toEqual({ ok: false, error: 'preview_required' });
  expect(await syncState.exportScope(scope)).toEqual(before);
});
