/**
 * `known.sync.progress.get` wiring: the boundary comes from active mount
 * bindings plus the first-sync preview (with its exclusions and private
 * roots), the tree is the personal tree, and queued work marks liveWork.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test, vi } from 'vitest';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';

const f = vi.hoisted(() => ({
  permission: true,
  connected: true,
  firstRun: 'running' as string,
  queue: [] as string[],
  tree: [] as unknown[],
  extraMappings: [] as Array<{ nativeId: string; colpId: string }>,
  captures: false, acknowledgement: false, frozen: false, aligned: true,
}));

vi.mock('../src/sw/scope.js', () => ({
  currentSyncScope: async () => { if (!f.connected) throw new Error('not_connected'); return { collectionId: 'col' }; },
}));
vi.mock('../src/bookmark-subscriptions/personal-boundary.js', () => ({
  personalTreeApi: () => ({ getTree: async () => f.tree, getChildren: async () => [], getSubTree: async () => [] }),
}));
vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: async () => f.permission,
  syncState: {
    getScope: async () => ({ firstRun: f.firstRun, selectedRoots: [], privateRoots: ['colp-private'] }),
    listBootstrapRuns: async () => [
      { runId: 'old', phase: 'completed', updatedAt: 1, previewId: 'p-old' },
      { runId: 'new', phase: f.firstRun === 'completed' ? 'completed' : 'syncing', updatedAt: 2, previewId: 'p-new' },
    ],
    getScopePreview: async (_scope: unknown, previewId: string) => previewId === 'p-new'
      ? { boundary: { selectedNativeIds: ['bar'], excludedNativeIds: ['skip'], mounts: [] } } : null,
    listMountBindings: async () => [{ nativeRootId: 'bar', status: 'active' }, { nativeRootId: 'other', status: 'detached' }],
    listMappings: async () => [
      ...f.extraMappings, { nativeId: 'bar', colpId: 'colp-bar' }, { nativeId: 'a', colpId: 'colp-a' }, { nativeId: 'private', colpId: 'colp-private' },
    ],
    listQueue: async (_scope: unknown, status: string) => (f.queue.includes(status) ? [{ status }] : []),
    getEngineState: async () => ({ recoveryFrozen: f.frozen, lastPublishedCursor: 'cursor', lastAckedCursor: f.aligned ? 'cursor' : 'previous' }),
    listBookmarkEventsByStatus: async () => f.captures ? [{ status: 'pending' }] : [],
    listAckIntents: async () => f.acknowledgement ? [{ state: 'pending' }] : [],
  },
}));

const { handleSyncProgressRequest } = await import('../src/sw/sync-progress.js');

function bookmark(id: string): ChromeBookmarkNode { return { id, title: id, url: `https://${id}.example` }; }

beforeEach(() => {
  Object.assign(f, { permission: true, connected: true, firstRun: 'running', queue: ['pending'], extraMappings: [],
    captures: false, acknowledgement: false, frozen: false, aligned: true });
  f.tree = [{ id: '0', title: '', children: [
    { id: 'bar', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
      bookmark('a'), bookmark('b'),
      { id: 'skip', title: 'Skipped', children: [bookmark('s1')] },
      { id: 'private', title: 'Private', children: [bookmark('p1')] },
    ] },
    { id: 'other', title: 'Other bookmarks', folderType: 'other', children: [bookmark('o1')] },
  ] }];
});

describe('handleSyncProgressRequest', () => {
  test('counts the selected boundary minus exclusions and private roots', async () => {
    const response = await handleSyncProgressRequest();
    assert.deepEqual(response, { ok: true, progress: {
      stage: 'syncing', firstSync: true, liveWork: true,
      bookmarks: { synced: 1, total: 2 }, folders: { synced: 1, total: 1 },
    } });
  });

  test.each(['pending-create-b', 'local-b', 'mount:b'])('does not count provisional identity %s as uploaded', async colpId => {
    f.extraMappings = [{ nativeId: 'b', colpId }]; f.queue = ['claimed'];
    const response = await handleSyncProgressRequest();
    assert.ok(response.ok && response.progress);
    assert.deepEqual(response.progress.bookmarks, { synced: 1, total: 2 });
    assert.equal(response.progress.stage, 'syncing'); assert.equal(response.progress.liveWork, true);
    f.extraMappings = [{ nativeId: 'b', colpId: 'colp-b' }]; f.queue = []; f.firstRun = 'completed';
    const uploaded = await handleSyncProgressRequest();
    assert.ok(uploaded.ok && uploaded.progress);
    assert.deepEqual(uploaded.progress.bookmarks, { synced: 2, total: 2 });
    assert.equal(uploaded.progress.stage, 'done');
  });

  test.each(['captures', 'acknowledgement', 'frozen'] as const)('waits for %s after the last upload', async key => {
    f.extraMappings = [{ nativeId: 'b', colpId: 'colp-b' }]; f.queue = []; f.firstRun = 'completed'; f[key] = true;
    const response = await handleSyncProgressRequest();
    assert.equal(response.ok && response.progress?.stage, 'syncing');
  });

  test('reports liveWork only while changes are queued', async () => {
    f.queue = ['rejected'];
    const response = await handleSyncProgressRequest();
    assert.equal(response.ok && response.progress?.liveWork, false);
  });

  test('answers null when sync is not set up, not connected, or bookmarks are off', async () => {
    f.firstRun = 'deferred';
    assert.deepEqual(await handleSyncProgressRequest(), { ok: true, progress: null });
    f.firstRun = 'running'; f.permission = false;
    assert.deepEqual(await handleSyncProgressRequest(), { ok: true, progress: null });
    f.permission = true; f.connected = false;
    assert.deepEqual(await handleSyncProgressRequest(), { ok: true, progress: null });
  });
});
