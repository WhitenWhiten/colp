// @vitest-environment happy-dom
// Real service-worker handlers with a persistent IndexedDB replica and a controllable native tree.
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindFolders } from '../src/sync-folders.js';
import { bindRangeAdjustment } from '../src/range-ui.js';
import { handleRootRequest, loadRootView, readRootFolders } from '../src/sw/roots.js';
import { sw, syncState } from '../src/sw/runtime.js';
import { handleRangeConfirm, handleRangePreview } from '../src/sw/range.js';
import { handleSyncProgressRequest } from '../src/sw/sync-progress.js';
import { handleFirstRunRequest } from '../src/sw/first-run.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { RootRequest } from '../src/types.js';
import type { SyncScope } from '../src/sync-state-store.js';
import { digestJson } from '../src/bookmark-event-codec.js';

vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  return { syncState: createSyncStateStore({ indexedDB: new IDBFactory() }), sw: { rootViewTokens: undefined },
    hasBookmarkPermission: async () => true, rootScopeKey: (value: unknown) => JSON.stringify(value), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => { if (scopeFailure) throw scopeFailure; return scope; }, restoredSyncScope: async () => scope, retireLegacyScopeForRemount: async () => {} }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/sw/library.js', () => ({ resolveLibraryRootId: async () => 'canonical-root' }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

let scope: SyncScope, tree: ChromeBookmarkNode[], treeFailure = false, serial = 0;
let scopeFailure: Error | undefined;
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
beforeEach(async () => {
  scope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test', accountId: `audit-${++serial}`,
    browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
  treeFailure = false; scopeFailure = undefined; sw.rootViewTokens = undefined;
  tree = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
      { id: '10', parentId: '1', title: 'Local-only new bookmark', url: 'https://example.test/local-new' },
    ] }, { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] },
  ] }];
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { sendMessage: vi.fn((request: RootRequest) => handleRootRequest(request)) },
    bookmarks: { getTree: async () => { if (treeFailure) throw new Error('bookmark service temporarily unavailable'); return structuredClone(tree); },
      create: vi.fn(), update: vi.fn(), move: vi.fn(), remove: vi.fn(), removeTree: vi.fn() } });
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], privateRoots: [], rootStatus: 'ready', firstRun: 'completed' });
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
afterAll(() => syncState.close());

test('first-run confirmation recovers selected-root authority after the coordinator persists and the native read fails', async () => {
  // Existing durable role bindings are already known, while onboarding consent
  // and the new bootstrap run still belong to this confirmation.
  for (const [nativeId, role] of [['1', 'bookmarks-bar'], ['2', 'other-bookmarks']] as const) {
    await syncState.putMapping(scope, { nativeId, colpId: `remote-${nativeId}`, rootNativeId: nativeId,
      mountId: `mount-${nativeId}`, nodeKind: 'folder', rootRole: role,
      projection: { revision: `r-${nativeId}`, digest: `sha256:${nativeId}`, content: { folderRole: role } } });
    await syncState.putMountBinding(scope, { nativeRootId: nativeId, remoteMountNodeId: `remote-${nativeId}`,
      mountId: `mount-${nativeId}`, rootRole: role, status: 'active', materialized: true, boundaryVersion: '0' });
  }
  await syncState.setFirstRun(scope, 'none');
  const beforeNative = structuredClone(tree);
  const view = await loadRootView(scope);
  const preview = await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: view.viewId,
    selectedRefs: view.roots.filter(root => root.depth === 0).map(root => root.ref), excludedRefs: [] });
  if (!preview.ok || !('previewId' in preview)) throw new Error('missing preview');
  const request = { kind: 'known.firstRun.confirm' as const, previewId: preview.previewId,
    confirmationId: crypto.randomUUID(), libraryId: scope.collectionId };
  const read = vi.spyOn(chrome.bookmarks, 'getTree').mockImplementation(async () => {
    if ((await syncState.listBootstrapRuns(scope)).length) throw new Error('native_tree_temporarily_unavailable');
    return structuredClone(tree) as chrome.bookmarks.BookmarkTreeNode[];
  });
  expect(await handleFirstRunRequest(request)).toEqual({ ok: false, error: 'confirmation_pending' });
  expect(await syncState.listBootstrapRuns(scope)).toEqual([expect.objectContaining({ confirmationId: request.confirmationId })]);
  expect(await syncState.getScope(scope)).toMatchObject({ firstRun: 'running', selectedRoots: [], boundaryVersion: '0' });
  expect((await syncState.getBoundaryCommand(scope, request.confirmationId))?.state).toBe('failed');
  read.mockRestore(); syncState.close();

  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status', confirmationId: request.confirmationId }))
    .toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  const recorded = (await syncState.getScope(scope))!;
  expect([...recorded.selectedRoots].sort()).toEqual(['remote-1', 'remote-2']);
  const byColp = new Map((await syncState.listMappings(scope)).map(row => [row.colpId, row.nativeId]));
  expect(recorded.selectedRoots.map(id => byColp.get(id)).sort()).toEqual(['1', '2']);
  const receipt = (await syncState.getBoundaryCommand(scope, request.confirmationId))!;
  const queue = await syncState.listQueue(scope);
  expect(await handleFirstRunRequest(request)).toEqual(receipt.result);
  expect(await syncState.listBootstrapRuns(scope)).toHaveLength(1);
  expect(await syncState.listQueue(scope)).toEqual(queue);
  expect(await syncState.getScope(scope)).toEqual(recorded);
  expect(tree).toEqual(beforeNative);
  for (const method of ['create', 'update', 'move', 'remove', 'removeTree'] as const) expect(chrome.bookmarks[method]).not.toHaveBeenCalled();
});

test('an old first-run preview cannot restore a selection after a newer confirmed boundary cleared it', async () => {
  await syncState.setFirstRun(scope, 'none');
  const first = await loadRootView(scope);
  const preview = await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: first.viewId,
    selectedRefs: first.roots.filter(root => root.depth === 0).map(root => root.ref), excludedRefs: [] });
  if (!preview.ok || !('previewId' in preview)) throw new Error('preview not produced');
  // Another page's finished first sync selected only Bar. Supply its settled replica facts.
  await syncState.setFirstRun(scope, 'completed');
  await syncState.putMapping(scope, { nativeId: '1', colpId: 'remote-bar', rootNativeId: '1', mountId: 'mount-bar',
    nodeKind: 'folder', rootRole: 'bookmarks-bar', projection: { revision: 'r-bar', digest: 'sha256:bar', childrenRevision: 'c-bar',
      content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } } });
  await syncState.putMapping(scope, { nativeId: '10', colpId: 'remote-bookmark', rootNativeId: '1', mountId: 'mount-bar',
    nodeKind: 'bookmark', parentNativeId: '1', parentColpId: 'remote-bar', projection: { revision: 'r-bookmark', digest: 'sha256:bookmark',
      content: { title: 'Local-only new bookmark', url: 'https://example.test/local-new' } } });
  await syncState.putMountBinding(scope, { nativeRootId: '1', remoteMountNodeId: 'remote-bar', mountId: 'mount-bar',
    rootRole: 'bookmarks-bar', status: 'active', materialized: true, boundaryVersion: '1' });
  await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
    selectedNativeIds: ['1'], privateNativeIds: [], status: 'ready' });
  // Then perform the real newer range-confirm path to clear the selection.
  const currentView = await loadRootView(scope);
  const cleared = await handleRangePreview({ kind: 'known.roots.preview', viewId: currentView.viewId, selectedRefs: [], privateRefs: [] });
  if (!cleared.ok || !('preview' in cleared)) throw new Error('clear preview not produced');
  expect(await handleRangeConfirm({ kind: 'known.roots.confirm', previewId: cleared.preview.previewId,
    treeDigest: cleared.preview.treeDigest, confirmationId: crypto.randomUUID() })).toEqual({ ok: true });
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual([]);
  const baseline = (await syncState.getMountBinding(scope, 'mount-bar'))?.pauseBaseline;
  expect(baseline).toBeDefined();
  const result = await handleFirstRunRequest({ kind: 'known.firstRun.confirm', previewId: preview.previewId,
    confirmationId: crypto.randomUUID(), libraryId: scope.collectionId });
  const after = await syncState.getScope(scope);
  expect({ result, selectedRoots: after?.selectedRoots, mounts: (await syncState.listMountBindings(scope)).map(row => row.status),
    baseline: (await syncState.getMountBinding(scope, 'mount-bar'))?.pauseBaseline })
    .toMatchObject({ result: { ok: false }, selectedRoots: [], mounts: ['detached'], baseline });
});

test('committed first-run command replay cannot rewrite a later range choice', async () => {
  await syncState.setFirstRun(scope, 'none');
  const view = await loadRootView(scope);
  const preview = await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: view.viewId,
    selectedRefs: view.roots.filter(root => root.depth === 0).map(root => root.ref), excludedRefs: [] });
  if (!preview.ok || !('previewId' in preview)) throw new Error('missing preview');
  const request = { kind: 'known.firstRun.confirm' as const, previewId: preview.previewId,
    confirmationId: crypto.randomUUID(), libraryId: scope.collectionId };
  const accepted = await handleFirstRunRequest(request);
  expect(accepted.ok).toBe(true);
  expect((await syncState.getBoundaryCommand(scope, request.confirmationId))?.state).toBe('committed');
  await syncState.setFirstRun(scope, 'completed');
  await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
    selectedNativeIds: [], privateNativeIds: [], status: 'ready' });
  await syncState.bumpBoundaryVersion(scope);
  const before = await syncState.getScope(scope);
  expect(await handleFirstRunRequest(request)).toEqual(accepted);
  expect(await syncState.getScope(scope)).toEqual(before);
  expect(await handleFirstRunRequest({ ...request, confirmationId: crypto.randomUUID() })).toMatchObject({ ok: false });
});

test('status recovers an admitted command without changing library selection', async () => {
  await syncState.setFirstRun(scope, 'none');
  const view = await loadRootView(scope);
  const preview = await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: view.viewId,
    selectedRefs: [view.roots[0]!.ref], excludedRefs: [] });
  if (!preview.ok || !('previewId' in preview)) throw new Error('missing preview');
  const commandId = crypto.randomUUID();
  await syncState.admitBoundaryCommand(scope, { commandId, previewId: preview.previewId, kind: 'first-run',
    boundaryVersion: preview.boundaryVersion, treeDigest: preview.treeDigest,
    requestDigest: digestJson({ kind: 'known.firstRun.confirm', previewId: preview.previewId, libraryId: scope.collectionId }),
    payload: { libraryId: scope.collectionId, rootNodeId: 'canonical-root' } });
  expect(await syncState.listBootstrapRuns(scope)).toEqual([]);
  syncState.close();
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status' })).toMatchObject({ ok: true, firstRun: 'running' });
  expect((await syncState.getBoundaryCommand(scope, commandId))?.state).toBe('committed');
  expect(await syncState.listBootstrapRuns(scope)).toHaveLength(1);
  await handleFirstRunRequest({ kind: 'known.firstRun.status' });
  expect(await syncState.listBootstrapRuns(scope)).toHaveLength(1);
});


test('command status distinguishes the admitted selection from another options page command', async () => {
  await syncState.setFirstRun(scope, 'none');
  const view = await loadRootView(scope);
  const preview = await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: view.viewId,
    selectedRefs: [view.roots[0]!.ref], excludedRefs: [] });
  if (!preview.ok || !('previewId' in preview)) throw new Error('missing preview');
  const confirmationId = crypto.randomUUID();
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.confirm', confirmationId,
    previewId: preview.previewId, libraryId: scope.collectionId })).toMatchObject({ ok: true });
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status', confirmationId }))
    .toMatchObject({ ok: true, confirmation: { confirmationId, state: 'committed' } });
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.status', confirmationId: 'unadmitted-other-page' }))
    .toMatchObject({ ok: true, firstRun: 'running', confirmation: { confirmationId: 'unadmitted-other-page', state: 'missing' } });
});

test.each(['credential_read_failed', 'session_read_failed', 'collection_read_failed'])('Later does not misclassify %s as disconnected', async (message) => {
  scopeFailure = new Error(message);
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toEqual({ ok: false, error: 'defer_failed' });
  expect((await syncState.getScope(scope))?.firstRun).toBe('completed');
});

test('Later permits a local draft only when the scope is actually not connected', async () => {
  scopeFailure = new Error('not_connected');
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toEqual({ ok: true, phase: 'draft', firstRun: 'deferred' });
});

test('Later cannot overwrite first-run admission or completion from another page', async () => {
  await syncState.setFirstRun(scope, 'none');
  const view = await loadRootView(scope);
  const preview = await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: view.viewId,
    selectedRefs: [view.roots[0]!.ref], excludedRefs: [] });
  if (!preview.ok || !('previewId' in preview)) throw new Error('preview missing');
  const request = { kind: 'known.firstRun.confirm' as const, previewId: preview.previewId,
    confirmationId: crypto.randomUUID(), libraryId: scope.collectionId };
  const [accepted, deferred] = await Promise.all([handleFirstRunRequest(request),
    handleFirstRunRequest({ kind: 'known.firstRun.later' })]);
  expect(accepted.ok).toBe(true);
  expect(deferred.ok).toBe(true);
  expect((await syncState.getScope(scope))?.firstRun).toBe('running');
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toMatchObject({ ok: true, firstRun: 'running' });
  await syncState.setFirstRun(scope, 'completed');
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toMatchObject({ ok: true, firstRun: 'completed' });
});

test('Later reports an IndexedDB failure without claiming a saved draft', async () => {
  const db = await syncState.open();
  vi.spyOn(db, 'transaction').mockImplementationOnce(() => { throw new Error('database unavailable'); });
  expect(await handleFirstRunRequest({ kind: 'known.firstRun.later' })).toEqual({ ok: false, error: 'defer_failed' });
  expect((await syncState.getScope(scope))?.firstRun).toBe('completed');
});
