import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';

vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  return {
    syncState: createSyncStateStore({ indexedDB: new IDBFactory() }),
    sw: { rootViewTokens: undefined }, hasBookmarkPermission: async () => true,
    rootScopeKey: (scope: unknown) => JSON.stringify(scope), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N',
  };
});
vi.mock('../src/sw/bookmarks.js', () => ({
  bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn(),
}));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [],
} }));

import { loadRootView, readRootFolders } from '../src/sw/roots.js';
import { handleRangePreview } from '../src/sw/range.js';
import { sw, syncState } from '../src/sw/runtime.js';
import type { SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = {
  environment: 'development', serverId: 'server', serverOrigin: 'https://known.test',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1,
};
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));

beforeEach(async () => {
  sw.rootViewTokens = undefined;
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, bookmarks: {
    getTree: async () => workspaceFolderTree(),
  } });
  await syncState.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 }, checkpoint: null,
    selectedRoots: [], privateRoots: [], rootStatus: 'ready', firstRun: 'completed',
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => syncState.close());

test('sync range exposes only supported folders and excludes workspaces from its persisted preview', async () => {
  const { discovered } = await readRootFolders();
  expect(discovered.map(node => node.nativeId)).toEqual(['1', 'a', 'user-workspace', '2', 'b']);
  const view = await loadRootView(scope, 'project');
  expect(view.status).toBe('ready');
  expect(view.roots.map(node => node.title)).toEqual(['Bookmarks bar', 'Research', 'Workspaces', 'Other bookmarks', 'Recipes']);
  expect(view.roots.some(node => node.preselected)).toBe(false);
  expect([...sw.rootViewTokens!.entries.values()].map(node => node.nativeId))
    .toEqual(['1', 'a', 'user-workspace', '2', 'b']);

  const selectedRefs = view.roots.filter(node => node.depth === 0).map(node => node.ref);
  const result = await handleRangePreview({ kind: 'known.roots.preview', viewId: view.viewId, selectedRefs, privateRefs: [] });
  expect(result.ok).toBe(true);
  if (!result.ok || !('preview' in result)) throw new Error('range_preview_missing');
  expect(result.preview.bookmarkCount).toBe(0);
  const preview = await syncState.getScopePreview(scope, result.preview.previewId);
  expect(preview?.boundary.selectedNativeIds).toEqual(['1', '2']);
  expect(preview?.boundary.mounts.map(mount => mount.nativeRootId)).toEqual(['1', '2']);
  expect(JSON.stringify(preview)).not.toMatch(/workspace-bookmark|workspace-folder|workspace\.example|"project"/u);
});
