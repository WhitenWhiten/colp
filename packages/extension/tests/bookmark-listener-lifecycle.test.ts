import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { classifyBookmarkCaptureFailure, createBookmarkListenerLifecycle,
  type BookmarkEventsApi } from '../src/bookmark-listener-lifecycle.js';
import type { BookmarkEventNode } from '../src/bookmark-event-queue.js';
import { readServiceWorkerGraph } from './service-worker-graph.js';

function chromeEvents() {
  type Created = (id: string, node: BookmarkEventNode) => void;
  type Changed = BookmarkEventsApi['onChanged']['addListener'] extends (callback: infer T) => void ? T : never;
  type Moved = BookmarkEventsApi['onMoved']['addListener'] extends (callback: infer T) => void ? T : never;
  type Removed = BookmarkEventsApi['onRemoved']['addListener'] extends (callback: infer T) => void ? T : never;
  type Reordered = NonNullable<BookmarkEventsApi['onChildrenReordered']>['addListener'] extends (callback: infer T) => void ? T : never;
  const listeners = { created: new Set<Created>(), changed: new Set<Changed>(),
    moved: new Set<Moved>(), removed: new Set<Removed>(), reordered: new Set<Reordered>() };
  const api: BookmarkEventsApi = {
    onCreated: { addListener(listener) { listeners.created.add(listener); },
      hasListener(listener) { return listeners.created.has(listener); } },
    onChanged: { addListener(listener) { listeners.changed.add(listener); },
      hasListener(listener) { return listeners.changed.has(listener); } },
    onMoved: { addListener(listener) { listeners.moved.add(listener); },
      hasListener(listener) { return listeners.moved.has(listener); } },
    onRemoved: { addListener(listener) { listeners.removed.add(listener); },
      hasListener(listener) { return listeners.removed.has(listener); } },
    onChildrenReordered: { addListener(listener) { listeners.reordered.add(listener); },
      hasListener(listener) { return listeners.reordered.has(listener); } },
  };
  return { api, listeners };
}

describe('P3-38 production bookmark listener lifecycle', () => {
  test('retries listener installation after optional permission is granted late', () => {
    const events = chromeEvents(); let api: typeof events.api | undefined;
    const lifecycle = createBookmarkListenerLifecycle({ bookmarks: () => api, capture: async () => 'accepted' });
    assert.equal(lifecycle.install(), false);
    assert.equal(lifecycle.status().listenerInstalled, false);

    api = events.api;
    assert.equal(lifecycle.install(), true);
    assert.equal(lifecycle.status().listenerInstalled, true);
    assert.deepEqual(Object.values(events.listeners).map((listeners) => listeners.size), [1, 1, 1, 1, 1]);

    api = undefined;
    assert.equal(lifecycle.status().listenerInstalled, false);
    api = events.api;
    assert.equal(lifecycle.install(), true);
    assert.deepEqual(Object.values(events.listeners).map((listeners) => listeners.size), [1, 1, 1, 1, 1]);
  });

  test('a fresh service-worker instance installs listeners again without duplicating one instance', () => {
    const events = chromeEvents();
    const first = createBookmarkListenerLifecycle({ bookmarks: () => events.api, capture: async () => 'accepted' });
    assert.equal(first.install(), true); assert.equal(first.install(), true);
    assert.deepEqual(Object.values(events.listeners).map((listeners) => listeners.size), [1, 1, 1, 1, 1]);

    const restartedEvents = chromeEvents();
    const restarted = createBookmarkListenerLifecycle({ bookmarks: () => restartedEvents.api,
      capture: async () => 'accepted' });
    assert.equal(restarted.install(), true);
    assert.deepEqual(Object.values(restartedEvents.listeners).map((listeners) => listeners.size), [1, 1, 1, 1, 1]);
  });

  test('observes a real created callback and reports only bounded public counters', async () => {
    const events = chromeEvents();
    const lifecycle = createBookmarkListenerLifecycle({ bookmarks: () => events.api,
      capture: async (event) => event.kind === 'created' ? 'accepted' : 'filtered' });
    lifecycle.install();
    [...events.listeners.created][0]!('sensitive-native-id', {
      id: 'sensitive-native-id', parentId: 'sensitive-parent-id', title: 'sensitive title',
      url: 'https://secret.invalid/path',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(lifecycle.status(), { listenerInstalled: true, eventObserved: 1, eventAccepted: 1,
      eventRejected: 0 });
    assert.doesNotMatch(JSON.stringify(lifecycle.status()), /sensitive|secret\.invalid/u);
  });

  test('fails closed with a fixed rejection reason and accepts the next event when capture throws synchronously', async () => {
    const events = chromeEvents(); let attempts = 0;
    const lifecycle = createBookmarkListenerLifecycle({ bookmarks: () => events.api,
      capture: () => { attempts += 1; if (attempts === 1) throw new Error('sensitive failure');
        return Promise.resolve('accepted'); } });
    lifecycle.install(); [...events.listeners.created][0]!('native',
      { id: 'native', parentId: 'parent', title: 'title' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(lifecycle.status(), { listenerInstalled: true, eventObserved: 1, eventAccepted: 0,
      eventRejected: 1, eventRejectedReason: 'capture_failed', captureFailureCode: 'unknown_capture_failure' });
    [...events.listeners.created][0]!('native-2', { id: 'native-2', parentId: 'parent', title: 'title' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(lifecycle.status(), { listenerInstalled: true, eventObserved: 2, eventAccepted: 1,
      eventRejected: 1, eventRejectedReason: 'capture_failed', captureFailureCode: 'unknown_capture_failure' });
  });

  test('captures all five Chrome event shapes and continues after an asynchronous rejection', async () => {
    const events = chromeEvents(); const kinds: string[] = []; let rejectNext = true;
    const lifecycle = createBookmarkListenerLifecycle({ bookmarks: () => events.api,
      capture: async (event) => { kinds.push(event.kind); if (rejectNext) { rejectNext = false;
        throw new Error('sensitive async failure'); } return 'accepted'; } });
    lifecycle.install();
    [...events.listeners.created][0]!('created', { id: 'created', parentId: 'parent', title: 'Created' });
    [...events.listeners.changed][0]!('changed', { title: 'Changed' });
    [...events.listeners.moved][0]!('moved', { parentId: 'target', index: 0, oldParentId: 'source', oldIndex: 1 });
    [...events.listeners.removed][0]!('removed', { parentId: 'parent', index: 0,
      node: { id: 'removed', parentId: 'parent', title: 'Removed' } });
    [...events.listeners.reordered][0]!('parent', { childIds: ['a', 'b'] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(kinds, ['created', 'changed', 'moved', 'removed', 'children_reordered']);
    assert.deepEqual(lifecycle.status(), { listenerInstalled: true, eventObserved: 5, eventAccepted: 4,
      eventRejected: 1, eventRejectedReason: 'capture_failed', captureFailureCode: 'unknown_capture_failure' });
  });

  test('exposes only allowlisted low-sensitivity capture failure codes', () => {
    assert.equal(classifyBookmarkCaptureFailure(new Error('operation_schema_invalid')), 'operation_schema_invalid');
    assert.equal(classifyBookmarkCaptureFailure(new Error('native id 123 at https://secret.invalid')),
      'unknown_capture_failure');
    assert.equal(classifyBookmarkCaptureFailure({ code: 'exact_retry_pending' }), 'unknown_capture_failure');
  });

  test('keeps in-flight captures joinable instead of fire-and-forget', async () => {
    // MV3 gives no lifetime guarantee to a swallowed promise: shutdown paths
    // (logout, engine cleanup) must be able to await capture settlement.
    const events = chromeEvents();
    let settle!: (value: 'accepted') => void;
    const lifecycle = createBookmarkListenerLifecycle({ bookmarks: () => events.api,
      capture: () => new Promise((resolve) => { settle = resolve; }) });
    lifecycle.install();
    [...events.listeners.created][0]!('native', { id: 'native', parentId: 'parent', title: 'title' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(lifecycle.pending(), 1);
    let joined = false;
    const join = lifecycle.settled().then(() => { joined = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(joined, false, 'settled() must wait for the in-flight capture');
    settle('accepted');
    await join;
    assert.equal(lifecycle.pending(), 0);
    assert.equal(lifecycle.status().eventAccepted, 1);
  });

  test('schedules ingress recovery for capture failures and deferred frozen events', async () => {
    const events = chromeEvents();
    const recoveries: Array<{ reason: string; code?: string }> = [];
    const outcomes: Array<'throw' | 'queue_unavailable' | 'filtered' | 'not_connected' | 'permission_required'
      | 'recovery_frozen' | 'accepted'> = ['throw', 'queue_unavailable', 'recovery_frozen', 'filtered',
        'not_connected', 'permission_required', 'accepted'];
    let call = 0;
    const lifecycle = createBookmarkListenerLifecycle({ bookmarks: () => events.api,
      capture: async () => {
        const outcome = outcomes[call]!; call += 1;
        if (outcome === 'throw') throw new Error('children_lookup_failed');
        return outcome;
      },
      scheduleRecovery: (reason, code) => { recoveries.push({ reason, ...(code ? { code } : {}) }); } });
    lifecycle.install();
    for (let index = 0; index < outcomes.length; index += 1) {
      [...events.listeners.created][0]!(`native-${index}`, { id: `native-${index}`, parentId: 'parent', title: 't' });
    }
    await lifecycle.settled();
    // A real browser mutation that failed to stage durably is repairable by
    // reconcile; intentional drops (filtered/permission/not connected) are not.
    assert.deepEqual(recoveries, [
      { reason: 'capture_failed', code: 'children_lookup_failed' },
      { reason: 'queue_unavailable' },
      { reason: 'recovery_frozen' },
    ]);
  });

  test('service worker wires transient capture failures to a recovery alarm', async () => {
    const source = await readServiceWorkerGraph();
    assert.match(source, /scheduleRecovery/);
    assert.match(source, /known-bookmark-capture-recovery/);
    // The recovery alarm must run the same recover path used on startup.
    assert.match(source, /known-bookmark-capture-recovery[\s\S]*recoverBookmarkEvents|recoverBookmarkEvents[\s\S]*known-bookmark-capture-recovery/);
  });

  test('first-run confirm and unfrozen engine wake reinstall listeners; evidence drain flushes', async () => {
    const source = await readServiceWorkerGraph();
    assert.match(source, /if \(permissionGranted\) bookmarkListenerLifecycle\.install\(\)/);
    assert.match(source,
      /validFirstRunRequest\(message\)[\s\S]{0,560}bookmarkListenerLifecycle\.install\(\)[\s\S]{0,240}scheduleSyncEngineWake\('manual'\)/);
    assert.match(source, /if \(result && !result\.recoveryFrozen && result\.phase !== 'error'\)[\s\S]{0,240}bookmarkListenerLifecycle\.install\(\)/);
    assert.match(source, /drainBookmarkEventCaptureEvidence[\s\S]{0,400}\.flush\(\)/);
  });
});
