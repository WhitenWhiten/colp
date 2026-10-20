// @vitest-environment happy-dom
// Real worker views remain usable across tabs while actual topology changes invalidate them.
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
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
afterAll(() => syncState.close());

test('opening a second options page does not invalidate the first page while the tree is unchanged', async () => {
  const first = await loadRootView(scope);
  await loadRootView(scope);
  const result = await handleRangePreview({ kind: 'known.roots.preview', viewId: first.viewId,
    selectedRefs: [], privateRefs: [] });
  expect(result.ok).toBe(true);
});

test('an actual folder topology change invalidates both old selection and old refs', async () => {
  const first = await loadRootView(scope);
  tree = tree.map(root => ({ ...root, children: root.children?.map(folder => folder.id === '1'
    ? { ...folder, children: [...folder.children ?? [], { id: '20', parentId: '1', title: 'New child folder', children: [] }] }
    : folder) }));
  const current = await loadRootView(scope);
  expect(current.viewId).not.toBe(first.viewId);
  expect(await handleRangePreview({ kind: 'known.roots.preview', viewId: first.viewId,
    selectedRefs: [], privateRefs: [] })).toMatchObject({ ok: false });
  expect(await handleRangePreview({ kind: 'known.roots.preview', viewId: current.viewId,
    selectedRefs: [], privateRefs: [] })).toMatchObject({ ok: true });
});

test('two first-run pages can preview different selections without mutating the boundary version', async () => {
  await syncState.setFirstRun(scope, 'none');
  const first = await loadRootView(scope); const second = await loadRootView(scope);
  for (const [view, selectedRefs] of [[first, [first.roots[0]!.ref]], [second, []]] as const) {
    expect(await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: view.viewId, selectedRefs,
      excludedRefs: [] })).toMatchObject({ ok: true, boundaryVersion: '0' });
  }
  expect((await syncState.getScope(scope))?.boundaryVersion).toBe('0');
});
