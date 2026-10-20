import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createAuthorityFence, createExtensionWorkCoordinator } from '../src/authority-fence.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createSyncStateStore, type QueueOperation } from '../src/sync-state-store.js';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { handleSyncStateEvidence } from '../src/sw/evidence.js';
import { honestChrome, scope } from './kns-05-pull-harness.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';

const state = vi.hoisted(() => ({
  store: undefined as unknown as ReturnType<typeof createSyncStateStore>,
  coordinator: undefined as unknown as ReturnType<typeof createExtensionWorkCoordinator>,
  queue: undefined as unknown as ReturnType<typeof createBookmarkEventQueue>,
  settled: 0,
}));
vi.mock('../src/sw/runtime.js', () => ({
  syncState: new Proxy({}, { get: (_target, key) => (...args: unknown[]) =>
    (state.store[key as keyof typeof state.store] as (...values: unknown[]) => unknown)(...args) }),
  workCoordinator: { run: (lane: 'bookmark' | 'engine', work: () => Promise<unknown>) => state.coordinator.run(lane, work) },
  sw: {}, safeError: (error: Error) => error.message,
}));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
vi.mock('../src/sw/bookmarks.js', () => ({
  bookmarkListenerLifecycle: { settled: async () => { state.settled++; } },
  currentBookmarkEventQueue: async () => state.queue,
}));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));

let api: ReturnType<typeof honestChrome>;
beforeEach(async () => {
  state.store = createSyncStateStore({ indexedDB: new IDBFactory() });
  state.coordinator = createExtensionWorkCoordinator(createAuthorityFence(new MemoryStorageArea()));
  state.settled = 0;
  await state.store.registerScope({ ...scope, lifecycle: 'active', rootStatus: 'ready',
    lease: { leaseId: 'lease', expiresAt: Date.parse('2099-01-01') }, checkpoint: null, selectedRoots: [] });
  api = honestChrome();
  api.seed({ id: '0', title: '' });
  api.seed({ id: '1', title: 'Bookmarks bar', parentId: '0', folderType: 'bookmarks-bar' });
  const nativeTree = (id = '0'): ChromeBookmarkNode => {
    const node = api.getNode(id); assert.ok(node);
    return { ...node, id, title: String(node.title ?? ''),
      children: api.all().filter(child => child.parentId === id).map(child => nativeTree(String(child.id))) };
  };
  const bookmarks = { ...api, getTree: async () => [nativeTree()], getSubTree: async (id: string) => [nativeTree(id)],
    create: async (details: Record<string, unknown>) => {
      const node = await api.create(details); return { ...(await api.get(node.id))[0]!, title: String(details.title ?? '') };
    },
    get: async (id: string) => (await api.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
    getChildren: async (id: string) => (await api.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })),
  };
  vi.stubGlobal('chrome', { bookmarks });
  state.queue = createBookmarkEventQueue({ store: state.store, scope, api: bookmarks, autoFlush: false });
});
afterEach(() => { state.store.close(); vi.unstubAllGlobals(); });

async function seed(): Promise<QueueOperation> {
  const response = await handleSyncStateEvidence({ kind: 'known.sync-state.evidence', method: 'seedOutboundPushEvidence', args: [] });
  assert.equal(response.ok, true, JSON.stringify(response));
  return ('value' in response ? response.value : undefined) as QueueOperation;
}

test('outbound fault seeding uses a real native source and the production capture pipeline', async () => {
  const row = await seed();
  const mapping = await state.store.getMappingByColpId(scope, `pending-${row.opId}`); assert.ok(mapping);
  const native = (await api.get(mapping.nativeId))[0]; assert.ok(native);
  const root = await state.store.getMappingByColpId(scope, 'p3-27-root'); assert.ok(root);
  assert.equal(native.parentId, root.nativeId);
  assert.equal(native.title, 'P3-31 public');
  assert.equal(native.url, 'https://example.test/p3-31');
  assert.equal(state.settled, 1);
  assert.equal(row.sequence, 1);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt, undefined);
  assert.match(row.digest, /^sha256:[0-9a-f]{64}$/);
  const captures = await state.store.listBookmarkEventsByOperation(scope, row.opId);
  assert.equal(captures.length, 1); assert.equal(captures[0]?.nativeId, native.id);
  assert.equal(captures[0]?.status, 'processed');
  await assertQueuedUploadAllowed({ store: state.store, scope, queue: row,
    parentOf: async id => (await api.get(id))[0]?.parentId });
  assert.deepEqual((await state.store.exportScope(scope)).receipts, []);
  assert.equal((await seed()).opId, row.opId);
  assert.equal(api.calls.filter(call => call.kind === 'create').length, 2);
  await state.queue.created(native.id, { ...native, title: native.title ?? '' }); await state.queue.flush();
  assert.equal((await state.store.listQueue(scope)).length, 1, 'a later native callback cannot produce a second create');
});
