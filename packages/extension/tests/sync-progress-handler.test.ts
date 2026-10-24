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
  extraMappings: [] as Array<{ nativeId: string; colpId: string; projection?: { revision: string } }>,
  captures: false, acknowledgement: false, frozen: false, aligned: true,
  lastError: undefined as string | undefined,
  phase: undefined as string | undefined, breakerRetryAt: undefined as number | undefined,
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
    listQueue: async (_scope: unknown, status: string) => (f.queue.includes(status) ? [{ status, sequence: 1,
      opId: `op-${status}`, payload: { type: 'update_node_content', targetId: 'colp-b' }, recovery: { code: 'resource_not_found' } }] : []),
    getEngineState: async () => ({ recoveryFrozen: f.frozen, lastError: f.lastError,
      lastPublishedCursor: 'cursor', lastAckedCursor: f.aligned ? 'cursor' : 'previous',
      ...(f.phase ? { phase: f.phase } : {}),
      ...(f.breakerRetryAt ? { circuitBreaker: { progress: 'p', failures: [], trips: 1, retryAt: f.breakerRetryAt } } : {}) }),
    listBookmarkEventsByStatus: async () => f.captures ? [{ status: 'pending' }] : [],
    listAckIntents: async () => f.acknowledgement ? [{ state: 'pending' }] : [],
  },
}));

const { handleSyncProgressRequest } = await import('../src/sw/sync-progress.js');

function bookmark(id: string): ChromeBookmarkNode { return { id, title: id, url: `https://${id}.example` }; }

beforeEach(() => {
  Object.assign(f, { permission: true, connected: true, firstRun: 'running', queue: ['pending'], extraMappings: [],
    captures: false, acknowledgement: false, frozen: false, aligned: true, lastError: undefined,
    phase: undefined, breakerRetryAt: undefined });
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
  test.each(['rejected', 'set_aside'])('isolated %s work needs attention without claiming an active upload', async status => {
    f.firstRun = 'completed'; f.queue = [status];
    const response = await handleSyncProgressRequest();
    assert.ok(response.ok && response.progress);
    assert.equal(response.progress.issueCount, 1);
    assert.equal(response.progress.liveWork, false);
    assert.equal(response.progress.retryAutomatic, undefined, 'the engine still syncs independent items');
    const { describeSyncProgress } = await import('../src/sync-progress-ui.js');
    const view = describeSyncProgress(response.progress);
    assert.equal(view.title, 'Action required');
    assert.deepEqual(view.guidance, []);
    assert.doesNotMatch(view.note!, /checks again on its own/);
    f.extraMappings = [{ nativeId: 'b', colpId: 'colp-b' }];
    const mapped = await handleSyncProgressRequest();
    assert.equal(mapped.ok && mapped.progress?.stage, 'syncing', 'mapped content failures still prevent completion');
  });
  test('the progress response itself carries the terminal stop even without the separate status request', async () => {
    f.frozen = true; f.lastError = 'recovery_identity_unproven'; f.firstRun = 'completed'; f.queue = [];
    const response = await handleSyncProgressRequest();
    assert.ok(response.ok && response.progress);
    assert.equal(response.progress.retryAutomatic, false);
    assert.equal(response.progress.stage, 'syncing');
  });
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

  test('a local root UUID is not a confirmed server mapping', async () => {
    f.extraMappings = [{ nativeId: 'b', colpId: 'reserved-local-uuid', projection: { revision: 'local-root' } }];
    const response = await handleSyncProgressRequest();
    assert.deepEqual(response.ok && response.progress?.bookmarks, { synced: 1, total: 2 });
  });

  test('answers null when sync is not set up or not connected', async () => {
    f.firstRun = 'deferred';
    assert.deepEqual(await handleSyncProgressRequest(), { ok: true, progress: null });
    f.firstRun = 'none'; f.permission = false;
    assert.deepEqual(await handleSyncProgressRequest(), { ok: true, progress: null }, 'never set up: no access is not news');
    f.firstRun = 'running'; f.permission = true; f.connected = false;
    assert.deepEqual(await handleSyncProgressRequest(), { ok: true, progress: null });
  });

  test('sync that is set up but lost bookmark access says so instead of vanishing (C-05)', async () => {
    for (const firstRun of ['running', 'completed']) {
      f.firstRun = firstRun; f.permission = false;
      assert.deepEqual(await handleSyncProgressRequest(), { ok: true, progress: null, permissionRequired: true }, firstRun);
    }
    const { describeMissingPermission } = await import('../src/sync-progress-ui.js');
    const view = describeMissingPermission();
    assert.equal(view.show, true);
    assert.equal(view.title, 'Bookmark access needed');
    assert.match(view.note ?? '', /Allow it in the Folders tab/u);
  });

  test('a breaker cooldown is a pause that ends by itself, not a stop (C-06)', async () => {
    f.firstRun = 'completed'; f.queue = []; f.phase = 'error'; f.breakerRetryAt = Date.now() + 600_000; f.lastError = 'stale_replica';
    const response = await handleSyncProgressRequest();
    assert.ok(response.ok && response.progress);
    assert.equal(response.progress.retryAutomatic, false);
    assert.equal(response.progress.coolingDown, true);
    const { describeSyncProgress } = await import('../src/sync-progress-ui.js');
    const view = describeSyncProgress(response.progress);
    assert.equal(view.title, 'Sync will retry');
    assert.match(view.note ?? '', /tries again on its own/u);
    assert.doesNotMatch(view.note ?? '', /has stopped/u);
    // A halt (no breaker deadline) is still a stop.
    f.breakerRetryAt = undefined; f.lastError = 'queue_state_invalid';
    const halted = await handleSyncProgressRequest();
    assert.ok(halted.ok && halted.progress);
    assert.equal(halted.progress.coolingDown, undefined);
    assert.equal(describeSyncProgress(halted.progress).title, 'Action required');
  });
});
