import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { handleRootRequest, loadRootView, readRootFolders } from '../src/sw/roots.js';
import { store, sw, syncState } from '../src/sw/runtime.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { RootRequest } from '../src/types.js';
import type { SyncScope } from '../src/sync-state-store.js';
import { recoveryNode, recoveryRoot } from './kns-03-bootstrap-harness.js';
import { REJOIN_TOKEN, rejoinSession } from './rejoin-http-fixture.js';
import { recordMoveOutOfBoundaryShift } from '../src/scope-range-shift.js';
import type { PreparedRangeCommand } from '../src/sw/range-command.js';

// Browser and wake scheduling are external ports. Admission, phase execution,
// bootstrap, immutable queue entries and IndexedDB reopen are the shipped code.
vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  const { createCredentialStore } = await import('../src/credential-store.js');
  const { createExtensionWorkCoordinator } = await import('../src/authority-fence.js');
  const store = createCredentialStore({ get: keys => storage.get(keys),
    set: values => storage.set(values), remove: keys => storage.remove(keys) });
  return { store, workCoordinator: createExtensionWorkCoordinator(store.fence),
    syncState: { ...createSyncStateStore({ indexedDB: new IDBFactory() }) }, sw: { rootViewTokens: undefined },
    hasBookmarkPermission: async () => true, rootScopeKey: (value: unknown) => JSON.stringify(value), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
vi.mock('../src/sw/library.js', () => ({ resolveLibraryRootId: async () => 'canonical-root' }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));
let scope: SyncScope, raw: ChromeBookmarkNode[], storage: MemoryStorageArea, serial = 0;
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
  storage = new MemoryStorageArea();
  vi.stubGlobal('chrome', { storage: { local: storage },
    bookmarks: { getTree: async () => structuredClone(raw), create: vi.fn(), update: vi.fn(), move: vi.fn(), remove: vi.fn(), removeTree: vi.fn() } });
  await store.fence.activate();
  await store.saveCredential({ accessToken: REJOIN_TOKEN, tokenType: 'Bearer', subject: scope.accountId,
    expiresAt: Date.now() + 3_600_000, scope: ['known.sync'], serverOrigin: scope.serverOrigin,
    issuer: `${scope.serverOrigin}/`, audience: 'known-sync-api', clientId: 'known-chromium-extension' });
  const session = await rejoinSession(scope); await store.saveSession(session);
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: {
    leaseId: session.replicaLease.leaseId, generation: session.replicaLease.generation,
    expiresAt: Date.parse(session.replicaLease.expiresAt) },
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

test.each(['live', 'restarted'] as const)('durable reviewed range confirmation survives a %s worker before admission', async worker => {
  const request = await review();
  expect(request.remoteDeleteRefs?.length).toBeGreaterThan(0);
  const previewBefore = await syncState.getScopePreview(scope, request.previewId);
  const nativeBefore = structuredClone(raw);
  if (worker === 'restarted') { syncState.close(); sw.rootViewTokens = undefined; }
  const result = await handleRootRequest(request);
  expect(result).toMatchObject({ ok: true, confirmation: { state: 'committed', confirmationId: request.confirmationId } });
  expect(raw).toEqual(nativeBefore);
  const queue = await syncState.listQueue(scope);
  expect(queue.filter(row => row.payload.type === 'delete_subtree').map(row => row.payload.targetId)).toEqual(['remote-10']);
  expect((await syncState.getScopePreview(scope, request.previewId))?.treeDigest).toBe(previewBefore?.treeDigest);
  const command = (await syncState.getBoundaryCommand(scope, request.confirmationId))!;
  expect((command.payload as unknown as PreparedRangeCommand).preview.removals.map(row => row.ref))
    .toEqual(request.remoteDeleteRefs);
  syncState.close(); sw.rootViewTokens = undefined;
  expect(await handleRootRequest(request)).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  expect(await syncState.listQueue(scope)).toEqual(queue);
  expect((await syncState.exportScope(scope)).receipts).toEqual([]);
  expect(raw).toEqual(nativeBefore);
});

async function reviewShift(choice: 'keep' | 'unmount') {
  const root = raw[0]!, bar = root.children![0]!, other = root.children![1]!;
  const moved = { ...bar.children![0]!, parentId: other.id };
  raw = [{ ...root, children: [{ ...bar, children: bar.children!.slice(1) },
    { ...other, children: [...other.children!, moved] }] }];
  await recordMoveOutOfBoundaryShift(syncState, scope, { nativeId: moved.id, colpId: 'remote-10',
    fromParentNativeId: bar.id, toParentNativeId: other.id, boundaryVersion: '0' });
  const view = await loadRootView(scope);
  const result = await handleRootRequest({ kind: 'known.roots.preview', viewId: view.viewId,
    selectedRefs: [view.roots.find(row => row.kind === 'bookmarks_bar')!.ref], privateRefs: [] });
  if (!result.ok || !('preview' in result)) throw new Error('shift_preview_missing');
  expect(result.preview.shifts).toHaveLength(1);
  const ref = result.preview.shifts[0]!.ref;
  return { kind: 'known.roots.confirm' as const, previewId: result.preview.previewId,
    treeDigest: result.preview.treeDigest, confirmationId: crypto.randomUUID(),
    shiftActions: [{ ref, action: choice }], ...(choice === 'unmount' ? { remoteDeleteRefs: [ref] } : {}) };
}

test.each(['keep', 'unmount'] as const)('reviewed %s shift survives full IDB reopen and commits only its frozen action', async choice => {
  const request = await reviewShift(choice), nativeBefore = structuredClone(raw);
  const previewBefore = await syncState.getScopePreview(scope, request.previewId);
  expect(previewBefore?.shiftNativeIds).toEqual(['10']);
  syncState.close(); sw.rootViewTokens = undefined;
  expect(await handleRootRequest(request)).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  const mounts = await syncState.listMountBindings(scope);
  expect(mounts.find(row => row.nativeRootId === '10')).toMatchObject({ status: choice === 'keep' ? 'active' : 'detached',
    remoteMountNodeId: 'remote-10' });
  expect(mounts.find(row => row.nativeRootId === '10')?.pendingShift).toBeUndefined();
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual(choice === 'keep' ? ['remote-1', 'remote-10'] : ['remote-1']);
  const queue = await syncState.listQueue(scope);
  expect(queue.filter(row => row.payload.type === 'delete_subtree').map(row => row.payload.targetId))
    .toEqual(choice === 'unmount' ? ['remote-10'] : []);
  expect((await syncState.getMappingByNativeId(scope, '10'))?.colpId).toBe('remote-10');
  const command = (await syncState.getBoundaryCommand(scope, request.confirmationId))!;
  const payload = command.payload as unknown as PreparedRangeCommand;
  expect(payload.preview.shifts.map(row => row.ref)).toEqual(request.shiftActions.map(row => row.ref));
  expect(payload.keepNativeIds).toEqual(choice === 'keep' ? ['10'] : []);
  expect(payload.unmountNativeIds).toEqual(choice === 'unmount' ? ['10'] : []);
  syncState.close(); sw.rootViewTokens = undefined;
  expect(await handleRootRequest(request)).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  expect(await syncState.listQueue(scope)).toEqual(queue);
  expect((await syncState.exportScope(scope)).receipts).toEqual([]);
  expect(raw).toEqual(nativeBefore);
  for (const name of ['create', 'update', 'move', 'remove', 'removeTree'] as const)
    expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
});

test.each(['foreign-ref', 'outside-preview', 'expired', 'changed-tree', 'changed-boundary'] as const)
('reopened deletion review rejects %s without admission or native/queue effects', async cause => {
  let request = await review();
  if (cause === 'foreign-ref') {
    const foreign = { ...scope, browserProfileId: 'foreign-profile', replicaId: 'foreign-replica' };
    const current = (await syncState.getScope(scope))!;
    await syncState.registerScope({ ...foreign, lifecycle: 'active', lease: current.lease, checkpoint: current.checkpoint,
      selectedRoots: [], privateRoots: [], firstRun: 'completed' });
    const view = await loadRootView(foreign);
    request = { ...request, remoteDeleteRefs: [view.roots.find(row => row.kind === 'bookmarks_bar')!.ref] };
  }
  if (cause === 'outside-preview') {
    const view = await loadRootView(scope);
    request = { ...request, remoteDeleteRefs: [view.roots.find(row => row.kind === 'other')!.ref] };
  }
  if (cause === 'expired') {
    const preview = (await syncState.getScopePreview(scope, request.previewId))!;
    vi.spyOn(Date, 'now').mockReturnValue(preview.expiresAt + 1);
  }
  if (cause === 'changed-tree') raw = raw.map(root => ({ ...root, children: root.children?.map(parent => ({
    ...parent, children: parent.children?.map(node => node.id === '10' ? { ...node, title: 'Changed after review' } : node),
  })) }));
  if (cause === 'changed-boundary') await syncState.bumpBoundaryVersion(scope);
  syncState.close(); sw.rootViewTokens = undefined;
  const before = await syncState.exportScope(scope), nativeBefore = structuredClone(raw);
  const error = cause === 'foreign-ref' || cause === 'outside-preview' ? 'request_invalid' : 'preview_stale';
  expect(await handleRootRequest(request)).toEqual({ ok: false, error });
  expect(await syncState.exportScope(scope)).toEqual(before);
  expect(await syncState.getBoundaryCommand(scope, request.confirmationId)).toBeNull();
  expect(raw).toEqual(nativeBefore);
  for (const name of ['create', 'update', 'move', 'remove', 'removeTree'] as const)
    expect(chrome.bookmarks[name]).not.toHaveBeenCalled();
});

test.each(['duplicate-shift', 'kept-cloud-delete'] as const)('reopened shift consent cannot authorize %s', async cause => {
  let request = await reviewShift('keep');
  request = cause === 'duplicate-shift' ? { ...request, shiftActions: [...request.shiftActions, ...request.shiftActions] }
    : { ...request, remoteDeleteRefs: request.shiftActions.map(row => row.ref) };
  syncState.close(); sw.rootViewTokens = undefined;
  const before = await syncState.exportScope(scope), nativeBefore = structuredClone(raw);
  expect(await handleRootRequest(request)).toEqual({ ok: false, error: 'request_invalid' });
  expect(await syncState.exportScope(scope)).toEqual(before);
  expect(await syncState.getBoundaryCommand(scope, request.confirmationId)).toBeNull();
  expect(raw).toEqual(nativeBefore);
});
