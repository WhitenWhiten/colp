import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { task } from './fixtures/capture.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createBookmarkCreatePlacementStore } from '../src/bookmark-create-placement.js';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';
import type { FolderTreeNode } from '../src/save-folder.js';
const f = vi.hoisted(() => ({ accountId: 'a' as string | null, matches: [] as chrome.bookmarks.BookmarkTreeNode[], remember: vi.fn() }));
vi.mock('../src/capture/browser-history-store.js', () => ({ browserHistoryStore: { remember: f.remember } }));
vi.mock('../src/sw/save-status.js', () => ({ handleSaveStatus: async () => ({ ok: true, localOnly: true }) }));
vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: async () => true,
  store: { loadCredential: async () => f.accountId ? { serverOrigin: 'https://known.test', subject: f.accountId } : null,
    fence: { read: async () => ({ generation: 1 }) } },
  syncState: { getMappingByNativeId: async () => null },
}));
vi.mock('../src/sw/scope.js', () => ({ loadConfig: async () => ({ serverOrigin: 'https://known.test' }),
  boundCollectionId: async () => 'c', currentSyncScope: async () => ({ accountId: f.accountId, collectionId: 'c' }) }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ isSubscriptionExcluded: async () => false }));
import { captureExistence, recoverNativeCapture } from '../src/sw/capture-native.js';

beforeEach(() => {
  f.accountId = 'a'; f.matches = []; f.remember.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('chrome', { storage: { local: new MemoryStorageArea() }, bookmarks: {
    search: async () => f.matches,
    get: async (id: string) => f.matches.filter(node => node.id === id),
  } });
});
test.each([
  { taskTime: undefined, nativeTime: 200, expected: 200 },
  { taskTime: 150, nativeTime: 200, expected: 150 },
  { taskTime: undefined, nativeTime: undefined, expected: 100 },
])('native receipt recovery preserves immutable save time: %j', async ({ taskTime, nativeTime, expected }) => {
  const placements = createBookmarkCreatePlacementStore({ now: () => 100 });
  const intent = await placements.reserve({ mode: 'bottom', targetParentNativeId: 'folder',
    batchId: crypto.randomUUID(), batchOrder: 0, batchSize: 1, title: task.title, url: task.url, expectedIndex: 0 });
  await placements.bind(intent.intentId, 'saved');
  f.matches = [{ id: 'saved', title: task.title, url: task.url, dateAdded: nativeTime }];
  const pending = { ...task, save: 'unknown' as const, nativeIntentId: intent.intentId, savedAt: taskTime };
  expect(await recoverNativeCapture(pending)).toMatchObject({ nativeId: 'saved', savedAt: expected });
  expect(f.remember).toHaveBeenCalledWith(expect.objectContaining({ savedAt: expected }), 'saved');
  expect(fetch).not.toHaveBeenCalled();
});
afterEach(() => vi.unstubAllGlobals());

test.each(['a', null])('browser existence reads never contact a stalled server for account %s', async accountId => {
  f.accountId = accountId;
  const scope = { ...task.scope, accountId, collectionId: accountId ? 'c' : null };
  const result = await captureExistence({ scope, url: task.url });
  expect(result).toMatchObject({ kind: 'not-found', coverage: { local: 'complete', cloud: 'not-checked' } });
  f.matches = [{ id: 'saved', title: 'Page', url: task.url }];
  expect(await captureExistence({ scope, url: task.url })).toMatchObject({ kind: 'local', exact: [{ nativeId: 'saved' }] });
  expect(fetch).not.toHaveBeenCalled();
});

test('already-saved hints exclude matches inside browser workspaces', async () => {
  const nodes = new Map<string, FolderTreeNode>();
  const visit = (tree: readonly FolderTreeNode[]) => { for (const node of tree) { nodes.set(node.id, node); visit(node.children ?? []); } };
  visit(workspaceFolderTree());
  const match = { id: 'saved', parentId: 'workspace-folder', title: 'Page', url: task.url };
  nodes.set(match.id, match); f.matches = [match];
  chrome.bookmarks.get = async id => {
    const node = nodes.get(id as string); return node ? [{ ...node, children: undefined }] : [];
  };
  const result = await captureExistence({ scope: { ...task.scope, accountId: 'a', collectionId: 'c' }, url: task.url });
  expect(result).toMatchObject({ kind: 'not-found', coverage: { local: 'complete' } });
  expect(fetch).not.toHaveBeenCalled();
});
