import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import type { BookmarkCaptureEvent, BookmarkEventsApi } from '../src/bookmark-listener-lifecycle.js';
import type { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import type { SyncScope } from '../src/sync-state-store.js';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';

type QueueOptions = Parameters<typeof createBookmarkEventQueue>[0];
const mocks = ['../src/sw/runtime.js', '../src/sw/scope.js', '../src/sw/engine.js', '../src/sw/batch.js',
  '../src/bookmark-event-queue.js', '../src/bookmark-subscriptions/events.js', '../src/sw/bookmark-annotations.js',
  '../src/sw/automation-observed.js', '../src/bootstrap/advanced-run.js', '../src/bootstrap/advanced-event-capture.js',
  '../src/native-repair.js', '../src/bookmark-listener-lifecycle.js'];
const cleanups: Array<() => Promise<void>> = [];
function eventPort<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return { addListener: (callback: T) => { listeners.add(callback); }, hasListener: (callback: T) => listeners.has(callback),
    emit: (...args: Parameters<T>) => { for (const callback of listeners) callback(...args); } };
}

/** Real listener, account fence, work lanes, placement storage and IDB; queue I/O is observed at its port.
 * Actual capture/restart durability is also exercised by bookmark-frozen-capture-recovery.test.ts. */
async function setup(mounted = true) {
  vi.resetModules();
  const state = await fixture(new IDBFactory());
  if (mounted) await state.store.putMountBinding(scope, { mountId: 'entry', nativeRootId: 'root-selected',
    remoteMountNodeId: 'remote-root', rootRole: 'bookmarks-bar', status: 'active', boundaryVersion: '1', materialized: true });
  const { MemoryStorageArea, createCredentialStore } = await import('../src/credential-store.js');
  const { createExtensionWorkCoordinator } = await import('../src/authority-fence.js');
  const local = new MemoryStorageArea(), session = new MemoryStorageArea();
  const credentials = createCredentialStore(local); const coordinator = createExtensionWorkCoordinator(credentials.fence);
  const order: string[] = []; const outcome = { value: 'staged' };
  const queue = { created: vi.fn(async (..._args: unknown[]) => ({ outcome: outcome.value })),
    changed: vi.fn(async (..._args: unknown[]) => ({ outcome: outcome.value })),
    moved: vi.fn(async (..._args: unknown[]) => ({ outcome: outcome.value })),
    reordered: vi.fn(async (..._args: unknown[]) => ({ outcome: outcome.value })),
    removed: vi.fn(async (..._args: unknown[]) => ({ outcome: outcome.value })),
    recover: vi.fn(async () => { order.push('recover'); }), flush: vi.fn(async () => undefined),
    captureMissingRemovals: vi.fn(async () => { order.push('missing-removals'); }) };
  const factory = vi.fn((_options: QueueOptions) => queue);
  const permission = vi.fn(async () => true); const scopeRead = vi.fn(async (_options?: { allowStopped?: boolean }): Promise<SyncScope> => scope);
  const engineRead = vi.fn(state.store.getEngineState); const runtimeStore = { ...state.store, getEngineState: engineRead };
  const wake = vi.fn(async (_reason: string) => undefined);
  const subscription = vi.fn(async (_event: BookmarkCaptureEvent) => false);
  const advanced = vi.fn(async (_input: unknown) => false); const advancedPlan = vi.fn(async () => undefined as unknown);
  const retain = vi.fn(async (_event: unknown) => undefined), restore = vi.fn(async (_node: unknown) => undefined);
  const observeCreate = vi.fn(async (..._args: unknown[]) => undefined), observeRemove = vi.fn(async (_event: unknown) => undefined);
  const garbage = vi.fn(async () => undefined), resume = vi.fn(async () => { order.push('batch'); });
  const repair = vi.fn(async (..._args: unknown[]) => { order.push('repair'); });
  const alarms = { get: vi.fn(async (_name: string) => undefined as { scheduledTime: number } | undefined),
    create: vi.fn((_name: string, _info: { when: number }) => undefined) };
  const events = { ...state.api,
    onCreated: eventPort<Parameters<BookmarkEventsApi['onCreated']['addListener']>[0]>(),
    onChanged: eventPort<Parameters<BookmarkEventsApi['onChanged']['addListener']>[0]>(),
    onMoved: eventPort<Parameters<BookmarkEventsApi['onMoved']['addListener']>[0]>(),
    onRemoved: eventPort<Parameters<BookmarkEventsApi['onRemoved']['addListener']>[0]>(),
    onChildrenReordered: eventPort<(id: string, value: { childIds: readonly string[] }) => void>(),
  };
  const sw = { bookmarkEventQueue: undefined as ReturnType<typeof createBookmarkEventQueue> | undefined,
    bookmarkEventScopeKey: undefined as string | undefined, eventEvidenceScope: undefined as SyncScope | undefined,
    eventEvidenceFault: undefined as QueueOptions['fault'] | 'before_stage' };
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  vi.stubGlobal('chrome', { bookmarks: events, alarms, storage: { local, session } });
  vi.doMock('../src/sw/runtime.js', async () => ({ BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery',
    hasBookmarkPermission: permission, rootScopeKey: (await import('../src/sync-state/scope-key.js')).scopeKey,
    store: credentials, syncState: runtimeStore, sw, workCoordinator: coordinator }));
  vi.doMock('../src/sw/scope.js', () => ({ currentSyncScope: scopeRead }));
  vi.doMock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: wake }));
  vi.doMock('../src/sw/batch.js', () => ({ resumeActiveBatchPlans: resume }));
  vi.doMock('../src/bookmark-event-queue.js', () => ({ createBookmarkEventQueue: factory }));
  vi.doMock('../src/bookmark-subscriptions/events.js', () => ({ subscriptionEvent: subscription }));
  vi.doMock('../src/sw/bookmark-annotations.js', () => ({ retainRemovedAnnotations: retain,
    restoreCreatedAnnotations: restore, collectAnnotationGarbage: garbage }));
  vi.doMock('../src/sw/automation-observed.js', () => ({ observeCreatedBookmark: observeCreate, observeRemovedBookmark: observeRemove }));
  vi.doMock('../src/bootstrap/advanced-run.js', () => ({ activeAdvancedPlan: advancedPlan }));
  vi.doMock('../src/bootstrap/advanced-event-capture.js', () => ({ captureWhileAdvanced: advanced }));
  vi.doMock('../src/native-repair.js', () => ({ recoverPendingNativeSideEffects: repair }));
  let capture!: (event: BookmarkCaptureEvent) => Promise<unknown>;
  vi.doMock('../src/bookmark-listener-lifecycle.js', async () => {
    const actual = await vi.importActual<typeof import('../src/bookmark-listener-lifecycle.js')>('../src/bookmark-listener-lifecycle.js');
    return { ...actual, createBookmarkListenerLifecycle: (options: Parameters<typeof actual.createBookmarkListenerLifecycle>[0]) => {
      capture = options.capture; return actual.createBookmarkListenerLifecycle(options);
    } };
  });
  const worker = await import('../src/sw/bookmarks.js'); worker.bookmarkListenerLifecycle.install();
  async function emit(event: BookmarkCaptureEvent) {
    if (event.kind === 'created') events.onCreated.emit(event.nativeId, event.node);
    else if (event.kind === 'changed') events.onChanged.emit(event.nativeId, event.changes);
    else if (event.kind === 'moved') events.onMoved.emit(event.nativeId, event.move);
    else if (event.kind === 'removed') events.onRemoved.emit(event.nativeId, event.removal);
    else if (event.kind === 'children_reordered') events.onChildrenReordered.emit(event.nativeId, { childIds: event.childIds });
    else return capture(event);
    await worker.bookmarkListenerLifecycle.settled(); await coordinator.drain();
    return worker.bookmarkListenerLifecycle.status();
  }
  async function transition(phase: 'sleeping' | 'applying' | 'pulling' | 'bootstrap' | 'recovery', frozen = false) {
    await state.store.transitionEngine(scope, { phase, recoveryFrozen: frozen, authorityRefreshRequired: false,
      updatedAt: Date.now(), notBefore: 0 });
  }
  const warn = vi.spyOn(console, 'warn'); const expectedWarnings: string[] = [];
  const f = { state, local, session, credentials, coordinator, queue, factory, outcome, permission, scopeRead, engineRead,
    runtimeStore, wake, subscription, advanced, advancedPlan, retain, restore, observeCreate, observeRemove,
    garbage, resume, repair, alarms, events, sw, worker, emit, transition, order, warn, expectedWarnings };
  cleanups.push(async () => {
    await coordinator.drain(); state.store.close();
    expect(warn.mock.calls.map(call => call[0])).toEqual(expectedWarnings);
  });
  return f;
}
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  for (const path of mocks) vi.doUnmock(path);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules();
  for (const result of results) if (result.status === 'rejected') throw result.reason;
});
const node = bookmark('created', 'root-selected', 0, 'Created', 'https://example.test/created');
const changed: BookmarkCaptureEvent = { kind: 'changed', nativeId: 'created', changes: { title: 'Edited' } };
async function alarmScheduled(f: Awaited<ReturnType<typeof setup>>) {
  await vi.waitFor(() => expect(f.alarms.create).toHaveBeenCalledWith('known-bookmark-capture-recovery',
    { when: expect.any(Number) }));
}

test('registered Chrome callbacks forward exact native facts and wake only accepted ordinary capture', async () => {
  const f = await setup();
  const move = { parentId: 'next', index: 2, oldParentId: 'root-selected', oldIndex: 0 };
  const removal = { parentId: 'next', index: 2, node };
  await f.emit({ kind: 'created', nativeId: node.id, node }); await f.emit(changed);
  await f.emit({ kind: 'moved', nativeId: node.id, move });
  await f.emit({ kind: 'children_reordered', nativeId: 'next', childIds: ['a', node.id] });
  expect(await f.emit({ kind: 'reordered', nativeId: 'next', childIds: [node.id, 'a'] })).toBe('accepted');
  await f.emit({ kind: 'removed', nativeId: node.id, removal });
  expect(f.queue.created).toHaveBeenCalledWith(node.id, node);
  expect(f.queue.changed).toHaveBeenCalledWith(node.id, { title: 'Edited' }, 'callback');
  expect(f.queue.moved).toHaveBeenCalledWith(node.id, move);
  expect(f.queue.reordered.mock.calls).toEqual([['next', ['a', node.id]], ['next', [node.id, 'a']]]);
  expect(f.queue.removed).toHaveBeenCalledWith(node.id, removal);
  expect(f.retain).toHaveBeenCalledWith({ kind: 'removed', nativeId: node.id, removal });
  expect(f.restore).toHaveBeenCalledWith(node); expect(f.observeCreate).toHaveBeenCalledWith(node.id, node);
  expect(f.observeRemove).toHaveBeenCalledWith(removal); expect(f.wake.mock.calls).toEqual(Array(6).fill(['manual']));
  expect(f.worker.bookmarkListenerLifecycle.status()).toMatchObject({ eventObserved: 5, eventAccepted: 5, eventRejected: 0 });
});

test('subscription-owned removal still retains local notes but never enters personal capture', async () => {
  const f = await setup(); f.subscription.mockResolvedValue(true);
  await f.emit({ kind: 'removed', nativeId: node.id, removal: { parentId: node.parentId, index: 0, node } });
  expect(f.retain).toHaveBeenCalledOnce(); expect(f.observeRemove).toHaveBeenCalledOnce();
  expect(f.advanced).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled();
  expect(f.worker.bookmarkListenerLifecycle.status().eventRejectedReason).toBe('filtered');
});

test('annotation and automation failures cannot silently discard a bookmark callback', async () => {
  const f = await setup(); f.retain.mockRejectedValue(new Error('notes')); f.restore.mockRejectedValue(new Error('notes'));
  f.observeCreate.mockRejectedValue(new Error('automation')); f.observeRemove.mockRejectedValue(new Error('automation'));
  await f.emit({ kind: 'created', nativeId: node.id, node });
  await f.emit({ kind: 'removed', nativeId: node.id, removal: { parentId: node.parentId, index: 0, node } });
  expect(f.worker.bookmarkListenerLifecycle.status().eventAccepted).toBe(2);
  expect(f.queue.created).toHaveBeenCalledOnce(); expect(f.queue.removed).toHaveBeenCalledOnce();
});

test('an advanced-plan capture owns the event and suppresses the ordinary queue', async () => {
  const f = await setup(); f.advanced.mockResolvedValue(true); await f.emit(changed);
  expect(f.advanced).toHaveBeenCalledWith({ store: f.runtimeStore, scope, api: f.events, event: changed });
  expect(f.factory).not.toHaveBeenCalled(); expect(f.wake).not.toHaveBeenCalled();
  expect(f.worker.bookmarkListenerLifecycle.status().eventRejectedReason).toBe('filtered');
});

test.each(['permission', 'disconnected', 'revoked'] as const)('%s authority prevents callback writes', async reason => {
  const f = await setup();
  if (reason === 'permission') f.permission.mockResolvedValue(false);
  if (reason === 'disconnected') f.scopeRead.mockRejectedValue(new Error('not_connected'));
  if (reason === 'revoked') await f.credentials.fence.revoke();
  await f.emit(changed);
  expect(f.factory).not.toHaveBeenCalled(); expect(f.wake).not.toHaveBeenCalled(); expect(f.alarms.create).not.toHaveBeenCalled();
  expect(f.worker.bookmarkListenerLifecycle.status().eventRejectedReason).toBe(reason === 'permission' ? 'permission_required' : 'not_connected');
});

test('advanced capture failure schedules recovery with an honest failure outcome', async () => {
  const f = await setup(); f.advanced.mockRejectedValue(new Error('advanced_plan_unavailable'));
  await f.emit(changed); await alarmScheduled(f);
  expect(f.queue.changed).not.toHaveBeenCalled();
  expect(f.worker.bookmarkListenerLifecycle.status()).toMatchObject({ eventRejectedReason: 'capture_failed', captureFailureCode: 'unknown_capture_failure' });
});

test('no active mount filters capture before a queue is constructed', async () => {
  const f = await setup(false); await f.emit(changed);
  expect(f.factory).not.toHaveBeenCalled(); expect(f.worker.bookmarkListenerLifecycle.status().eventRejectedReason).toBe('filtered');
});

test('frozen snapshot creates defer while changes stage without auto-flushing', async () => {
  const f = await setup(); await f.transition('recovery', true);
  await f.emit({ kind: 'created', nativeId: node.id, node });
  expect(f.factory).not.toHaveBeenCalled(); expect(f.worker.bookmarkListenerLifecycle.status().eventRejectedReason).toBe('recovery_frozen');
  await f.emit(changed); await alarmScheduled(f);
  expect(f.factory.mock.calls[0]![0]).toMatchObject({ scope, autoFlush: false });
  expect(f.queue.changed).toHaveBeenCalledOnce(); expect(f.wake).not.toHaveBeenCalled();
});

test('real paused policy retains ingress without starting Push or caching an auto-flush queue', async () => {
  const f = await setup(); const { createPersonalSyncPolicyStore } = await import('../src/personal-sync-policy.js');
  const { configurePersonalSyncTransport } = await import('../src/personal-sync-fetch.js');
  const policy = createPersonalSyncPolicyStore(f.local); configurePersonalSyncTransport(policy); await policy.write(scope, 'paused');
  await f.emit(changed); await f.worker.currentBookmarkEventQueue();
  expect(f.factory.mock.calls).toHaveLength(2);
  for (const [options] of f.factory.mock.calls) expect(options.autoFlush).toBe(false);
  expect(f.sw.bookmarkEventQueue).toBeUndefined(); expect(f.wake).not.toHaveBeenCalled();
});

test('ordinary queue cache is scoped and revoked authority clears both cache slots', async () => {
  const f = await setup(); await f.worker.currentBookmarkEventQueue(); await f.worker.currentBookmarkEventQueue();
  expect(f.factory).toHaveBeenCalledOnce(); expect(f.scopeRead).toHaveBeenCalledWith({ allowStopped: true });
  f.scopeRead.mockResolvedValue({ ...scope, generation: 2 }); await f.worker.currentBookmarkEventQueue();
  expect(f.factory).toHaveBeenCalledTimes(2);
  await f.credentials.fence.revoke(); expect(await f.worker.currentBookmarkEventQueue()).toBeUndefined();
  expect(f.sw.bookmarkEventQueue).toBeUndefined(); expect(f.sw.bookmarkEventScopeKey).toBeUndefined();
});

test('scope disappearance before queue construction leaves a recoverable capture failure', async () => {
  const f = await setup(); f.scopeRead.mockResolvedValueOnce(scope).mockResolvedValueOnce(scope)
    .mockRejectedValueOnce(new Error('scope_missing'));
  await f.emit(changed); await alarmScheduled(f);
  expect(f.worker.bookmarkListenerLifecycle.status().eventRejectedReason).toBe('queue_unavailable');
  expect(f.queue.changed).not.toHaveBeenCalled();
});

test.each(['identity_unproven', 'filtered'] as const)('queue outcome %s remains observable at ingress', async outcome => {
  const f = await setup(); f.outcome.value = outcome; await f.emit(changed);
  expect(f.worker.bookmarkListenerLifecycle.status().eventRejectedReason).toBe(outcome === 'filtered' ? 'filtered' : 'recovery_frozen');
  if (outcome === 'identity_unproven') { await alarmScheduled(f); expect(f.wake).not.toHaveBeenCalled(); }
  else expect(f.wake).toHaveBeenCalledWith('manual');
});

test('evidence stage faults are explicit and later queue faults retain their configured boundary', async () => {
  const f = await setup(); vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', true); f.sw.eventEvidenceScope = scope;
  f.sw.eventEvidenceFault = 'before_stage'; await f.emit({ kind: 'created', nativeId: node.id, node }); await alarmScheduled(f);
  expect(f.sw.eventEvidenceFault).toBeUndefined(); expect(f.sw.bookmarkEventQueue).toBeUndefined();
  expect(f.worker.bookmarkListenerLifecycle.status().eventRejectedReason).toBe('capture_failed');
  f.sw.eventEvidenceFault = 'after_queue'; await f.worker.currentBookmarkEventQueue();
  expect(f.factory.mock.calls[0]![0].fault).toBe('after_queue'); expect(f.scopeRead).not.toHaveBeenCalled();
});

test('queue placement hooks consume and complete the real per-intent storage reservation', async () => {
  const f = await setup(); await f.worker.currentBookmarkEventQueue(); const options = f.factory.mock.calls[0]![0];
  const { createBookmarkCreatePlacementStore } = await import('../src/bookmark-create-placement.js');
  const placements = createBookmarkCreatePlacementStore({ storage: f.local });
  const input = { mode: 'top' as const, targetParentNativeId: node.parentId, batchId: '11111111-1111-4111-8111-111111111111', batchOrder: 0,
    batchSize: 1, title: node.title, url: node.url, expectedIndex: node.index };
  const reserved = await placements.reserve(input);
  for (const invalid of [{ ...node, url: undefined }, { ...node, parentId: undefined }, { ...node, index: undefined }]) {
    expect(await options.resolveCreatePlacement!(node.id, invalid)).toBeUndefined();
  }
  expect(await options.resolveCreatePlacement!(node.id, node)).toMatchObject({ state: 'ready', intent: { intentId: reserved.intentId, nativeId: node.id } });
  await options.completeCreatePlacement!(reserved.intentId, node.id);
  expect(await placements.get(reserved.intentId)).toBeUndefined(); expect(await placements.getReceipt(reserved.intentId)).toMatchObject({ nativeId: node.id });
  const next = await placements.reserve(input); await options.markCreatePlacementAttention!(next.intentId);
  expect(await placements.get(next.intentId)).toMatchObject({ state: 'attention' });
});

test('delayed reorder commit wakes Push and failed flush retains a recovery alarm', async () => {
  const f = await setup(); await f.worker.currentBookmarkEventQueue(); const options = f.factory.mock.calls[0]![0];
  f.wake.mockRejectedValueOnce(new Error('offline')); options.onReorderQueued!(); options.onReorderFlushFailed!();
  await alarmScheduled(f); expect(f.wake).toHaveBeenCalledWith('manual');
});

test.each(['permission', 'missing-api', 'disconnected', 'advanced'] as const)('recovery refuses %s entry without running the queue', async reason => {
  const f = await setup();
  if (reason === 'permission') f.permission.mockResolvedValue(false);
  if (reason === 'missing-api') vi.stubGlobal('chrome', { ...chrome, bookmarks: undefined });
  if (reason === 'disconnected') f.scopeRead.mockRejectedValue(new Error('disconnected'));
  if (reason === 'advanced') f.advancedPlan.mockResolvedValue({ phase: 'running' });
  await f.worker.recoverBookmarkEvents();
  if (reason !== 'advanced') await f.worker.resumeBookmarkEvents();
  expect(f.queue.recover).not.toHaveBeenCalled(); expect(f.queue.flush).not.toHaveBeenCalled();
});

test('ordinary resume flushes and only the explicit recovery freeze is a benign recover refusal', async () => {
  const f = await setup(); await f.worker.resumeBookmarkEvents(); expect(f.queue.flush).toHaveBeenCalledOnce();
  f.queue.recover.mockRejectedValueOnce(new Error('queue_recovery_frozen')); await f.worker.recoverBookmarkEvents();
  f.queue.recover.mockRejectedValueOnce(new Error('bookmark_event_stage_failed'));
  await expect(f.worker.recoverBookmarkEvents()).rejects.toThrow('bookmark_event_stage_failed');
});

test('startup recovery orders repair, missing-removal capture, queue replay and batch resume before waking', async () => {
  const f = await setup(); await f.worker.recoverBookmarkEventsAfterEngineSettles('startup');
  expect(f.order).toEqual(['repair', 'missing-removals', 'recover', 'batch']);
  expect(f.repair).toHaveBeenCalledWith(f.runtimeStore, scope, f.events);
  expect(await f.session.get('known.bookmark.recovery-retry.v1')).toEqual({ 'known.bookmark.recovery-retry.v1': 0 });
  expect(f.garbage).toHaveBeenCalledOnce(); expect(f.wake).toHaveBeenCalledWith('startup');
});

test.each(['pulling', 'applying', 'bootstrap', 'recovery'] as const)('%s keeps a bounded recovery alarm without a premature tree replay', async phase => {
  const f = await setup(); await f.transition(phase); await f.worker.recoverBookmarkEventsAfterEngineSettles('alarm'); await alarmScheduled(f);
  expect(f.queue.captureMissingRemovals).toHaveBeenCalledOnce(); expect(f.queue.recover).not.toHaveBeenCalled();
  expect(f.resume).not.toHaveBeenCalled(); expect(f.wake).toHaveBeenCalledWith('alarm');
});

test.each([new Error('bookmark_event_stage_failed'), new Error('https://private.example/secret'), null])('recovery failure persists a bounded diagnostic: %s', async error => {
  const f = await setup(); f.queue.recover.mockRejectedValue(error);
  await f.worker.recoverBookmarkEventsAfterEngineSettles('online'); await alarmScheduled(f);
  const diagnostics = await f.state.store.exportDiagnostics();
  expect(diagnostics.records).toContainEqual(expect.objectContaining({ kind: 'bookmark_event_recovery',
    code: error instanceof Error && error.message === 'bookmark_event_stage_failed' ? error.message : 'indexeddb_failure' }));
  expect(JSON.stringify(diagnostics)).not.toContain('private.example'); expect(f.wake).toHaveBeenCalledWith('online');
});

test('revocation prevents recovery I/O and does not invent a durable error', async () => {
  const f = await setup(); await f.credentials.fence.revoke(); await f.worker.recoverBookmarkEventsAfterEngineSettles();
  expect(f.repair).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled();
  expect((await f.state.store.exportDiagnostics()).records).toHaveLength(0);
});

test('recovery alarm registry failure retains the fallback and reports unavailable persistence', async () => {
  const f = await setup(); f.alarms.get.mockRejectedValue(new Error('registry_unavailable'));
  f.queue.recover.mockRejectedValue(new Error('queue_failed')); f.expectedWarnings.push('bookmark_recovery_alarm_state_unavailable');
  await f.worker.recoverBookmarkEventsAfterEngineSettles(); await alarmScheduled(f);
});

test('failed retry reset remains observable without blocking completed recovery', async () => {
  const f = await setup(); vi.spyOn(f.session, 'set').mockRejectedValueOnce(new Error('storage_failed'));
  f.expectedWarnings.push('bookmark_recovery_retry_reset_failed');
  await f.worker.recoverBookmarkEventsAfterEngineSettles(); expect(f.queue.recover).toHaveBeenCalledOnce(); expect(f.wake).toHaveBeenCalledWith('manual');
});

test.each([false, true])('ingress wait is bounded and paced; unfreeze=%s', async unfreeze => {
  const f = await setup(); await f.transition('recovery', true);
  const frozen = (await f.state.store.getEngineState(scope))!; f.engineRead.mockResolvedValue(frozen);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(10_000);
  if (unfreeze) f.wake.mockImplementation(async () => { f.engineRead.mockResolvedValue({ ...frozen, recoveryFrozen: false }); });
  else f.wake.mockRejectedValue(new Error('offline'));
  const waiting = f.worker.waitUntilBookmarkIngressOpen(scope);
  await vi.advanceTimersByTimeAsync(3_000); await waiting;
  expect(f.wake).toHaveBeenCalledTimes(unfreeze ? 1 : 6);
  expect(f.engineRead.mock.calls.every(([actual]) => actual === scope)).toBe(true);
});
