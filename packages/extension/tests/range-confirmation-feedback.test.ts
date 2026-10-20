// @vitest-environment happy-dom
// Native failures exercise real range handlers, IndexedDB and the options controller.
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindFolders } from '../src/sync-folders.js';
import { bindRangeAdjustment } from '../src/range-ui.js';
import { handleRootRequest, loadRootView } from '../src/sw/roots.js';
import { sw, syncState } from '../src/sw/runtime.js';
import { recoverBookmarkEvents } from '../src/sw/bookmarks.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { RootRequest } from '../src/types.js';
import type { SyncScope } from '../src/sync-state-store.js';

vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  return { syncState: createSyncStateStore({ indexedDB: new IDBFactory() }), sw: { rootViewTokens: undefined },
    hasBookmarkPermission: async () => true, rootScopeKey: (value: unknown) => JSON.stringify(value), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/sw/library.js', () => ({ resolveLibraryRootId: async () => 'canonical-root' }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

let scope: SyncScope, tree: ChromeBookmarkNode[], treeFailure = false, serial = 0;
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
beforeEach(async () => {
  scope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test', accountId: `audit-${++serial}`,
    browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
  treeFailure = false; sw.rootViewTokens = undefined;
  tree = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
      { id: '10', parentId: '1', title: 'Local-only new bookmark', url: 'https://example.test/local-new' },
    ] }, { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] },
  ] }];
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { sendMessage: vi.fn((request: RootRequest) => handleRootRequest(request)) },
    bookmarks: { getTree: async () => { if (treeFailure) throw new Error('bookmark service temporarily unavailable'); return structuredClone(tree); } } });
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], privateRoots: [], rootStatus: 'ready', firstRun: 'completed' });
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
afterAll(() => syncState.close());

test('a bookmark-read failure during range confirmation must not be reported as settings saved', async () => {
  const folders = bindFolders({ isConnected: () => true, firstRun: () => ({ isRangeActive: () => false, onRootsRendered: () => {} }) });
  folders.render(await loadRootView(scope));
  const range = bindRangeAdjustment({ saveRoots: byId('save-roots'), rootTree: byId('root-tree'), rootFeedback: byId('root-feedback'),
    getView: folders.view, setView: folders.render, reloadBoundaries: () => {}, onConfirmed: () => {}, isConnected: () => true,
    renderFailure: folders.renderFailure });
  await range.save();
  expect(byId('range-preview').hidden).toBe(false);
  treeFailure = true;
  byId('range-confirm').click();
  await vi.waitFor(async () => expect((await syncState.getScope(scope))?.rootStatus).toBe('tree_unavailable'));
  await vi.waitFor(() => expect(byId('range-confirm').hasAttribute('aria-busy')).toBe(false));
  expect(byId('root-feedback').textContent).not.toBe('Folder settings saved');
});


async function review() {
  const view = await loadRootView(scope);
  const response = await handleRootRequest({ kind: 'known.roots.preview', viewId: view.viewId,
    selectedRefs: [], privateRefs: [] });
  if (!response.ok || !('preview' in response)) throw new Error('missing preview');
  return { kind: 'known.roots.confirm' as const, confirmationId: crypto.randomUUID(),
    previewId: response.preview.previewId, treeDigest: response.preview.treeDigest };
}

test('a failed read rejects a mutation while read-only root queries can display an unavailable tree', async () => {
  const request = await review(); treeFailure = true;
  expect(await handleRootRequest(request)).toEqual({ ok: false, error: 'tree_unavailable' });
  expect((await syncState.getScope(scope))?.boundaryVersion ?? '0').toBe('0');
  expect((await syncState.getScopePreview(scope, request.previewId))?.consumedAt).toBeUndefined();
  expect(await handleRootRequest({ kind: 'known.roots.get' })).toMatchObject({ ok: true, view: { status: 'tree_unavailable' } });
});

test('a post-commit refresh failure still returns the committed command receipt', async () => {
  const request = await review();
  vi.mocked(recoverBookmarkEvents).mockImplementationOnce(async () => { treeFailure = true; });
  expect(await handleRootRequest(request)).toMatchObject({ ok: true,
    view: { status: 'tree_unavailable' }, confirmation: { confirmationId: request.confirmationId, state: 'committed' } });
  expect((await syncState.getScopePreview(scope, request.previewId))?.consumedAt).toBeTypeOf('number');
  expect((await syncState.getScope(scope))?.boundaryVersion).toBe('1');
});

test('the options page requires its committed receipt before announcing saved', async () => {
  const folders = bindFolders({ isConnected: () => true, firstRun: () => ({ isRangeActive: () => false, onRootsRendered: () => {} }) });
  const view = await loadRootView(scope); folders.render(view);
  const onConfirmed = vi.fn(), renderFailure = vi.fn();
  const range = bindRangeAdjustment({ saveRoots: byId('save-roots'), rootTree: byId('root-tree'), rootFeedback: byId('root-feedback'),
    getView: folders.view, setView: folders.render, reloadBoundaries: () => {}, onConfirmed, isConnected: () => true, renderFailure });
  await range.save();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ ok: true, view });
  byId('range-confirm').click();
  await vi.waitFor(() => expect(renderFailure).toHaveBeenCalledWith('request_invalid'));
  expect(byId('root-feedback').textContent).not.toBe('Folder settings saved');
  expect(onConfirmed).not.toHaveBeenCalled();
});
