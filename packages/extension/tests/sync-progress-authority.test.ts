// @vitest-environment happy-dom
// Historical preview and current boundary authority share the real persistent store.
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { handleRootRequest } from '../src/sw/roots.js';
import { sw, syncState } from '../src/sw/runtime.js';
import { handleSyncProgressRequest } from '../src/sw/sync-progress.js';
import { digestJson } from '../src/bookmark-event-codec.js';
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


async function oldPreview(excludedNativeIds: string[] = []) {
  await syncState.putScopePreview(scope, { previewId: 'old-preview', boundaryVersion: '0', treeDigest: 'sha256:old',
    bookmarkCount: 0, folderCount: 1, skippedCount: 0, warnings: [], expiresAt: Date.now() + 60_000,
    boundary: { selectedNativeIds: ['1'], excludedNativeIds, mounts: [] } });
}

test.each(['completed', 'syncing', 'scanning'] as const)('an older %s run cannot count new local bookmarks after Clear', async phase => {
  await oldPreview();
  await syncState.putBootstrapRun(scope, { runId: 'old-run', previewId: 'old-preview', confirmationId: 'old-command',
    confirmationVersion: '0', bootstrapMode: 'merge', phase, updatedAt: Date.now(), treeDigest: 'sha256:old' });
  await syncState.bumpBoundaryVersion(scope);
  const progress = await handleSyncProgressRequest();
  expect(progress).toMatchObject({ ok: true, progress: { stage: 'done', bookmarks: { total: 0 }, folders: { total: 0 } } });
});

test('completed preview exclusions do not hide folders reselected by the current authority', async () => {
  tree = [{ id: '0', title: '', children: [{ id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
    { id: '20', parentId: '1', title: 'Reselected folder', children: [
      { id: '21', parentId: '20', title: 'Reselected bookmark', url: 'https://example.test/reselected' },
    ] },
  ] }] }];
  await oldPreview(['20']);
  await syncState.putBootstrapRun(scope, { runId: 'old-run', previewId: 'old-preview', confirmationId: 'old-command',
    confirmationVersion: '0', bootstrapMode: 'merge', phase: 'completed', updatedAt: Date.now(), treeDigest: 'sha256:old' });
  await syncState.putMountBinding(scope, { nativeRootId: '1', remoteMountNodeId: 'remote-bar', mountId: 'current-mount',
    rootRole: 'bookmarks-bar', status: 'active', materialized: true, boundaryVersion: '1' });
  await syncState.bumpBoundaryVersion(scope);
  expect(await handleSyncProgressRequest()).toMatchObject({ ok: true, progress: { bookmarks: { total: 1 }, folders: { total: 2 } } });
});

test('an admitted current preview fills the totals before its mounts are established', async () => {
  await syncState.setFirstRun(scope, 'none'); await oldPreview();
  await syncState.admitBoundaryCommand(scope, { kind: 'first-run', commandId: 'current-command', previewId: 'old-preview',
    requestDigest: digestJson({ selection: 'reviewed' }), boundaryVersion: '0', treeDigest: 'sha256:old', payload: {} });
  await syncState.advanceBoundaryCommand(scope, 'current-command', { result: { ok: true } });
  await syncState.putBootstrapRun(scope, { runId: 'current-run', previewId: 'old-preview', confirmationId: 'current-command',
    confirmationVersion: '0', bootstrapMode: 'merge', phase: 'scanning', updatedAt: Date.now(), treeDigest: 'sha256:old' });
  expect(await syncState.listMountBindings(scope)).toEqual([]);
  expect(await handleSyncProgressRequest()).toMatchObject({ ok: true, progress: { stage: 'preparing', bookmarks: { total: 1 } } });
});
