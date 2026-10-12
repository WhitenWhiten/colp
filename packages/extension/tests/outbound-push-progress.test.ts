import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { createSyncStateStore } from '../src/sync-state-store.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { describeSyncProgress } from '../src/sync-progress-ui.js';
import { fixture, success } from './outbound-push-batch-harness.js';
import { installOutboundPushIndexedDb, scope } from './outbound-push-worker-harness.js';

const f = vi.hoisted(() => ({
  store: null as ReturnType<typeof createSyncStateStore> | null,
  tree: [] as ChromeBookmarkNode[],
}));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: async () => true,
  get syncState() { return f.store; },
}));
vi.mock('../src/bookmark-subscriptions/personal-boundary.js', () => ({
  personalTreeApi: () => ({ getTree: async () => f.tree, getChildren: async () => [], getSubTree: async () => [] }),
}));
const { handleSyncProgressRequest } = await import('../src/sw/sync-progress.js');

installOutboundPushIndexedDb();
afterEach(() => { f.store?.close(); f.store = null; });

async function setupProgress(count: number) {
  const value = await fixture(count); f.store = value.store;
  await value.store.setFirstRun(scope, 'running');
  await value.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'bar',
    remoteMountNodeId: 'root-push', boundaryVersion: '1', materialized: true,
    status: 'active', rootRole: 'bookmarks-bar' });
  await value.store.putMapping(scope, { nativeId: 'bar', colpId: 'root-push', rootNativeId: 'bar',
    nodeKind: 'folder', projection: { revision: 'root-r1', childrenRevision: 'children-r1', digest: 'sha256:root' } });
  f.tree = [{ id: '0', title: '', children: [{ id: 'bar', title: 'Bookmarks bar', folderType: 'bookmarks-bar',
    children: Array.from({ length: count }, (_, index) => ({ id: `native-${index + 1}`,
      title: `Bookmark ${index + 1}`, url: `https://example.test/${index + 1}` })) }] }];
  return value;
}

async function readProgress() {
  const response = await handleSyncProgressRequest();
  assert.ok(response.ok && response.progress); return response.progress;
}

test('the real progress handler advances on individual receipts across two 50-operation requests', async () => {
  const value = await setupProgress(100); const atDispatch: number[] = []; const atReceipt: number[] = [];
  const worker = createOutboundPushWorker({ ...value.options,
    fetch: async (_url, init) => {
      const progress = await readProgress();
      assert.equal(progress.stage, 'syncing'); assert.equal(progress.liveWork, true);
      atDispatch.push(progress.bookmarks.synced); return success(String(init?.body));
    },
    onTerminal: async () => { atReceipt.push((await readProgress()).bookmarks.synced); },
  });
  assert.equal((await readProgress()).bookmarks.synced, 0);
  assert.equal((await worker.drain()).outcome, 'terminal');
  assert.deepEqual(atDispatch, [0, 50]);
  assert.deepEqual(atReceipt, Array.from({ length: 100 }, (_, index) => index + 1));
  const complete = await readProgress();
  assert.deepEqual(complete.bookmarks, { synced: 100, total: 100 });
  assert.equal(complete.stage, 'done'); assert.equal(complete.liveWork, false);
  assert.equal(describeSyncProgress(complete, undefined, { showDone: true }).value, 1);
});

test.each(['lost_response', 'receipt_rollback'])('%s leaves progress incomplete until singleton recovery succeeds', async failure => {
  const value = await setupProgress(8);
  const failed = createOutboundPushWorker({ ...value.options,
    ...(failure === 'receipt_rollback' ? { settlementFault: 'after_receipt' as const } : {}),
    fetch: async (_url, init) => {
      if (failure === 'lost_response') throw new TypeError('response lost after server commit');
      return success(String(init?.body));
    },
  });
  assert.equal((await failed.drain()).outcome, 'unknown');
  const waiting = await readProgress();
  assert.deepEqual(waiting.bookmarks, { synced: 0, total: 8 });
  assert.equal(waiting.stage, 'syncing'); assert.equal(waiting.liveWork, true);
  value.clock.now += 60_000;
  const recovered: number[] = [];
  const worker = createOutboundPushWorker({ ...value.options,
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).operations.length, 1); return success(String(init?.body));
    },
    onTerminal: async () => { recovered.push((await readProgress()).bookmarks.synced); },
  });
  assert.equal((await worker.drain()).outcome, 'terminal');
  assert.deepEqual(recovered, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await readProgress()).stage, 'done');
});
