import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import type { BookmarkEventsApi } from '../src/bookmark-listener-lifecycle.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { CHROME_BOOKMARK_NOT_FOUND } from '../src/bookmark-api-error.js';
import { bookmark, fixture, mapping, scope } from './bookmark-event-queue-harness.js';

function eventPort<T>() {
  const listeners = new Set<T>();
  return { listeners, addListener: (listener: T) => { listeners.add(listener); },
    hasListener: (listener: T) => listeners.has(listener) };
}

async function setup() {
  vi.resetModules();
  const state = await fixture(new IDBFactory(), { mappedNode: true });
  const root = await state.store.getMappingByNativeId(scope, 'root-selected');
  await state.store.putMountBinding(scope, { mountId: 'frozen-mount', nativeRootId: 'root-selected',
    remoteMountNodeId: root!.colpId, rootRole: 'bookmarks-bar', status: 'active',
    boundaryVersion: '1', materialized: true });
  state.api.put(bookmark('mapped', 'root-selected', 1, 'Server before', 'https://example.test/before'));
  const changed = eventPort<Parameters<BookmarkEventsApi['onChanged']['addListener']>[0]>();
  const missing = new Set<string>();
  const events = { ...state.api,
    get: async (id: string) => { if (missing.has(id)) throw new Error(CHROME_BOOKMARK_NOT_FOUND); return state.api.get(id); },
    getChildren: async (id: string) => (await state.api.getChildren(id)).filter(node => !missing.has(node.id)),
    onCreated: eventPort<Parameters<BookmarkEventsApi['onCreated']['addListener']>[0]>(),
    onChanged: changed,
    onMoved: eventPort<Parameters<BookmarkEventsApi['onMoved']['addListener']>[0]>(),
    onRemoved: eventPort<Parameters<BookmarkEventsApi['onRemoved']['addListener']>[0]>(),
  };
  const alarm = vi.fn(); const wake = vi.fn(async (_reason: string) => undefined);
  const failures: unknown[] = [];
  vi.doMock('../src/bookmark-listener-lifecycle.js', async () => {
    const actual = await vi.importActual<typeof import('../src/bookmark-listener-lifecycle.js')>('../src/bookmark-listener-lifecycle.js');
    return { ...actual, createBookmarkListenerLifecycle: (options: Parameters<typeof actual.createBookmarkListenerLifecycle>[0]) =>
      actual.createBookmarkListenerLifecycle({ ...options, capture: async event => {
        try { return await options.capture(event); } catch (error) { failures.push(error); throw error; }
      } }) };
  });
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  vi.stubGlobal('chrome', { bookmarks: events, alarms: { create: alarm },
    storage: { local: new MemoryStorageArea(), session: new MemoryStorageArea() } });
  vi.doMock('../src/sw/runtime.js', () => ({
    BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery',
    hasBookmarkPermission: async () => true, rootScopeKey: () => 'scope',
    store: { fence: { read: async () => ({ revoked: false }) } },
    sw: {}, syncState: state.store,
    workCoordinator: { run: async <T>(_lane: string, work: () => Promise<T>) => work() },
  }));
  vi.doMock('../src/sw/scope.js', async () => {
    const { configuredPersonalSyncPolicy } = await import('../src/personal-sync-fetch.js');
    return { currentSyncScope: async (options?: { allowStopped?: boolean }) => {
      if (!options?.allowStopped) await configuredPersonalSyncPolicy()?.capture(scope);
      return scope;
    } };
  });
  vi.doMock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: wake }));
  const worker = await import('../src/sw/bookmarks.js');
  worker.bookmarkListenerLifecycle.install();
  async function transition(phase: 'sleeping' | 'applying' | 'recovery', frozen: boolean) {
    await state.store.transitionEngine(scope, { phase, recoveryFrozen: frozen,
      authorityRefreshRequired: false, updatedAt: 1, notBefore: 0 });
  }
  async function change(title: string) {
    state.api.put(bookmark('mapped', 'root-selected', 1, title, 'https://example.test/before'));
    for (const listener of changed.listeners) listener('mapped', { title });
    await worker.bookmarkListenerLifecycle.settled();
  }
  return { ...state, worker, alarm, wake, transition, change, changed, events, missing, failures };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

test.each(['paused', 'frozen'] as const)('%s removal is durably captured before recovery can restore it', async mode => {
  const f = await setup();
  try {
    await f.transition('recovery', mode === 'frozen');
    if (mode === 'paused') {
      const { createPersonalSyncPolicyStore } = await import('../src/personal-sync-policy.js');
      const { configurePersonalSyncTransport } = await import('../src/personal-sync-fetch.js');
      const policy = createPersonalSyncPolicyStore(chrome.storage.local);
      configurePersonalSyncTransport(policy);
      await policy.write(scope, 'paused');
    }
    const node = f.api.node('mapped');
    f.missing.add('mapped');
    for (const listener of f.events.onRemoved.listeners) listener('mapped', { parentId: 'root-selected', index: 1, node });
    await f.worker.bookmarkListenerLifecycle.settled();
    f.store.close();
    const drafts = await f.store.listBookmarkEventsByStatus(scope, 'pending');
    assert.deepEqual(f.failures, []);
    assert.equal(drafts.length, 1, JSON.stringify(f.worker.bookmarkListenerLifecycle.status()));
    assert.equal(drafts[0]?.kind, 'remove');
    assert.match(JSON.stringify(drafts[0]?.details), /mapped-colp/);
    assert.equal((await f.store.listQueue(scope)).length, 0);
  } finally { f.store.close(); }
});

test('same-wake freeze defers a local edit and alarm repairs it once without a remote echo', async () => {
  const f = await setup();
  try {
    await f.transition('sleeping', false);
    await f.transition('applying', true);
    // A remote projection completes while ingress is frozen, followed by a
    // genuine local edit. Only the latter differs from durable authority.
    f.api.put(bookmark('remote', 'root-selected', 2, 'Remote', 'https://example.test/remote'));
    await mapping(f.store, 'remote', 'remote-colp', 'root-selected', 'r-remote',
      { title: 'Remote', url: 'https://example.test/remote' }, 'root-selected');
    await f.change('Local while frozen');
    assert.equal(f.worker.bookmarkListenerLifecycle.status().eventAccepted, 1);
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 1);
    assert.equal((await f.store.listQueue(scope, 'pending', 0, 10)).length, 0);
    assert.equal(f.alarm.mock.calls[0]?.[0], 'known-bookmark-capture-recovery');
    await f.transition('sleeping', false);
    // This is the real service-worker alarm handler, not a direct queue flush.
    await f.worker.recoverBookmarkEventsAfterEngineSettles('alarm');
    await f.worker.recoverBookmarkEventsAfterEngineSettles('alarm');
    const pending = await f.store.listQueue(scope, 'pending', 0, 10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.payload.type, 'update_node_content');
    assert.match(JSON.stringify(pending[0]!.payload), /Local while frozen/);
    assert.doesNotMatch(JSON.stringify(pending[0]!.payload), /remote-colp/);
    assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, false);
  } finally { f.store.close(); }
});

for (const [phase, frozen] of [['applying', true], ['applying', false], ['recovery', true]] as const) {
  test(`alarm re-arms while ${phase}/frozen=${frozen} and never consumes recovery authority`, async () => {
    const f = await setup();
    try {
      await f.transition(phase, frozen);
      f.api.put(bookmark('mapped', 'root-selected', 1, 'Uncommitted projection', 'https://example.test/before'));
      await f.worker.recoverBookmarkEventsAfterEngineSettles('alarm');
      assert.equal(f.alarm.mock.calls[0]?.[0], 'known-bookmark-capture-recovery');
      assert.equal((await f.store.listQueue(scope, 'pending', 0, 10)).length, 0);
      assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, frozen);
      assert.equal(f.wake.mock.calls[0]?.[0], 'alarm');
      await mapping(f.store, 'mapped', 'mapped-colp', 'root-selected', 'r-committed',
        { title: 'Uncommitted projection', url: 'https://example.test/before' }, 'root-selected');
      await f.transition('sleeping', false);
      await f.worker.recoverBookmarkEventsAfterEngineSettles('alarm');
      assert.equal((await f.store.listQueue(scope, 'pending', 0, 10)).length, 0);
    } finally { f.store.close(); }
  });
}


test('a frozen change callback survives overwrite before capture and store restart', async () => {
  const f = await setup();
  const savedUrl = 'https://saved-during-pull.example/';
  try {
    await f.transition('applying', true);
    f.api.put(bookmark('mapped', 'root-selected', 1, 'Local saved', savedUrl));
    for (const listener of f.changed.listeners) listener('mapped', { title: 'Local saved', url: savedUrl });
    // Pull changes Chrome before the asynchronous callback gets to read it.
    f.api.put(bookmark('mapped', 'root-selected', 1, 'Remote', 'https://remote.example/'));
    await f.worker.bookmarkListenerLifecycle.settled();
    assert.equal((await f.store.listQueue(scope)).length, 0, 'freeze still prevents processing');
    f.store.close();
    const drafts = await f.store.listBookmarkEventsByStatus(scope, 'pending');
    assert.equal(drafts.length, 1);
    assert.match(JSON.stringify(drafts[0]?.details), /saved-during-pull/);
    await f.transition('sleeping', false);
    await f.worker.recoverBookmarkEventsAfterEngineSettles('alarm');
    assert.ok((await f.store.listQueue(scope)).some(row => JSON.stringify(row.payload).includes(savedUrl)));
  } finally { f.store.close(); }
});
