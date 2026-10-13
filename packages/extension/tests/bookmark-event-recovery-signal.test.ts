import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import type { BookmarkEventsApi } from '../src/bookmark-listener-lifecycle.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';

/**
 * F003: the recovery chain used to swallow every capture/recovery failure with
 * `.catch(() => undefined)`, so a poison inbox event left no observable signal.
 * The swallow must stay non-fatal but must record a bounded scope diagnostic.
 */
function eventPort<T>() {
  const listeners = new Set<T>();
  return { listeners, addListener: (listener: T) => { listeners.add(listener); },
    hasListener: (listener: T) => listeners.has(listener) };
}

async function setup(recover: () => Promise<void>) {
  vi.resetModules();
  const state = await fixture(new IDBFactory());
  const events = { ...state.api,
    onCreated: eventPort<Parameters<BookmarkEventsApi['onCreated']['addListener']>[0]>(),
    onChanged: eventPort<Parameters<BookmarkEventsApi['onChanged']['addListener']>[0]>(),
    onMoved: eventPort<Parameters<BookmarkEventsApi['onMoved']['addListener']>[0]>(),
    onRemoved: eventPort<Parameters<BookmarkEventsApi['onRemoved']['addListener']>[0]>(),
  };
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  vi.stubGlobal('chrome', { bookmarks: events, alarms: { create: vi.fn() } });
  vi.doMock('../src/bookmark-event-queue.js', () => ({
    createBookmarkEventQueue: () => ({ recover, flush: async () => undefined, correlationFor: async () => 'x',
      captureMissingRemovals: async () => undefined }),
  }));
  vi.doMock('../src/sw/runtime.js', () => ({
    BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery',
    hasBookmarkPermission: async () => true, rootScopeKey: () => 'scope',
    store: { fence: { read: async () => ({ revoked: false }) } },
    sw: {}, syncState: state.store,
    workCoordinator: { run: async <T>(_lane: string, work: () => Promise<T>) => work() },
  }));
  vi.doMock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
  vi.doMock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: async () => undefined }));
  const worker = await import('../src/sw/bookmarks.js');
  return { state, worker };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

test('a failed recovery chain records an observable scope signal instead of vanishing', async () => {
  const f = await setup(async () => { throw new Error('bookmark_event_stage_failed'); });
  await f.worker.recoverBookmarkEventsAfterEngineSettles('manual');
  const diagnostics = await f.state.store.exportDiagnostics();
  assert.ok(diagnostics.records.some((row) =>
    (row as { kind?: string }).kind === 'bookmark_event_recovery'
    && (row as { code?: string }).code === 'bookmark_event_stage_failed'),
  `expected a bookmark_event_recovery diagnostic, got ${JSON.stringify(diagnostics.records)}`);
});

test('a frozen scope still resolves without recording a failure signal', async () => {
  const f = await setup(async () => { throw new Error('queue_recovery_frozen'); });
  await f.worker.recoverBookmarkEventsAfterEngineSettles('manual');
  const diagnostics = await f.state.store.exportDiagnostics();
  assert.equal(diagnostics.records.some((row) =>
    (row as { kind?: string }).kind === 'bookmark_event_recovery'), false);
});
