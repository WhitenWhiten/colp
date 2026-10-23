/**
 * performance-10: a recycled MV3 worker must not walk the whole native tree.
 *
 * Chrome wakes the worker for every bookmark event while the extension runs,
 * staged events wait in the durable inbox, and a failed capture schedules the
 * recovery alarm. So only the first worker boot of an extension session (an
 * empty `storage.session`: browser restart, enable, update or reload) walks the
 * tree for changes made while the extension was not running. Later boots flush
 * the inbox; the reconcile, recovery and start-up paths still walk.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { fixture, scope } from './bookmark-event-queue-harness.js';

async function setup(options: { recover?: () => Promise<void> } = {}) {
  vi.resetModules();
  const state = await fixture(new IDBFactory());
  const seen = { recovers: 0, flushes: 0, wakes: [] as string[], wholeLibrary: [] as Array<boolean | undefined> };
  const session = new Map<string, unknown>();
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  vi.stubGlobal('chrome', { bookmarks: { ...state.api,
    onCreated: { addListener: () => undefined, hasListener: () => true },
    onChanged: { addListener: () => undefined, hasListener: () => true },
    onMoved: { addListener: () => undefined, hasListener: () => true },
    onRemoved: { addListener: () => undefined, hasListener: () => true } },
  alarms: { create: vi.fn(), get: async () => undefined },
  storage: { session: {
    get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
    set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) session.set(key, value); },
  } } });
  vi.doMock('../src/bookmark-event-queue.js', () => ({
    createBookmarkEventQueue: () => ({
      recover: options.recover ?? (async () => { seen.recovers += 1; }),
      flush: async () => { seen.flushes += 1; }, correlationFor: async () => 'x',
      captureMissingRemovals: async () => undefined }),
  }));
  vi.doMock('../src/native-repair.js', () => ({
    recoverPendingNativeSideEffects: async (_store: unknown, _scope: unknown, _api: unknown,
      repair: { wholeLibrary?: boolean } = {}) => { seen.wholeLibrary.push(repair.wholeLibrary); } }));
  vi.doMock('../src/sw/batch.js', () => ({ resumeActiveBatchPlans: async () => undefined }));
  vi.doMock('../src/sw/runtime.js', () => ({
    BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery',
    hasBookmarkPermission: async () => true, rootScopeKey: () => 'scope',
    store: { fence: { read: async () => ({ revoked: false }) } },
    sw: {}, syncState: state.store,
    workCoordinator: { run: async <T>(_lane: string, work: () => Promise<T>) => work() },
  }));
  vi.doMock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
  vi.doMock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: async (reason: string) => { seen.wakes.push(reason); } }));
  const worker = await import('../src/sw/bookmarks.js');
  return { state, seen, session, worker };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of ['../src/bookmark-event-queue.js', '../src/native-repair.js', '../src/sw/batch.js',
    '../src/sw/runtime.js', '../src/sw/scope.js', '../src/sw/engine.js']) vi.doUnmock(path);
  vi.resetModules();
});

test('only the first worker boot of an extension session walks the native tree', async () => {
  const f = await setup();
  await f.worker.recoverBookmarkEventsAfterEngineSettles('manual', { workerBoot: true });
  assert.equal(f.seen.recovers, 1, 'the first boot walks the tree');
  assert.deepEqual(f.seen.wholeLibrary, [true]);
  assert.deepEqual(f.seen.wakes, ['manual']);

  for (let boot = 0; boot < 3; boot += 1) {
    await f.worker.recoverBookmarkEventsAfterEngineSettles('manual', { workerBoot: true });
  }
  assert.equal(f.seen.recovers, 1, 'a recycled worker never walks the tree again');
  assert.equal(f.seen.flushes, 3, 'it still flushes events a stopped worker left in the inbox');
  assert.deepEqual(f.seen.wholeLibrary, [true, false, false, false], 'apply-intent repair runs; whole-library repairs wait');
  assert.deepEqual(f.seen.wakes, ['manual', 'alarm', 'alarm', 'alarm'],
    'a quiet boot leaves Pull to its own deadline instead of forcing a full pass');
});

test('a recycled worker that flushed fresh local work wakes Push at once', async () => {
  const f = await setup();
  f.session.set('known.bookmarks.tree-reconciled.v1', true);
  await f.state.store.allocateSequenceAndEnqueue(scope, {
    opId: 'op-fresh', batchId: 'batch-fresh', idempotencyKey: 'key-fresh', digest: 'sha256:fresh',
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: 'local-fresh',
    status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { opId: 'op-fresh', replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
      type: 'create_node', baseRevision: null, occurredAt: '2026-07-28T00:00:00Z', dependencies: [], payload: {} },
  }, { allowUnstamped: true });
  await f.worker.recoverBookmarkEventsAfterEngineSettles('manual', { workerBoot: true });
  assert.equal(f.seen.recovers, 0);
  assert.deepEqual(f.seen.wakes, ['manual']);
});

test('reconcile, recovery and start-up paths still walk after the session was reconciled', async () => {
  const f = await setup();
  f.session.set('known.bookmarks.tree-reconciled.v1', true);
  await f.worker.recoverBookmarkEventsAfterEngineSettles('alarm');
  await f.worker.recoverBookmarkEventsAfterEngineSettles('startup');
  assert.equal(f.seen.recovers, 2);
  assert.deepEqual(f.seen.wholeLibrary, [true, true]);
  assert.deepEqual(f.seen.wakes, ['alarm', 'startup']);
});

test('a first boot that could not walk the tree leaves the next boot to walk it', async () => {
  let frozen = true;
  const f = await setup({ recover: async () => {
    if (frozen) throw new Error('queue_recovery_frozen');
    f.seen.recovers += 1;
  } });
  await f.worker.recoverBookmarkEventsAfterEngineSettles('manual', { workerBoot: true });
  assert.equal(f.session.has('known.bookmarks.tree-reconciled.v1'), false);
  frozen = false;
  await f.worker.recoverBookmarkEventsAfterEngineSettles('manual', { workerBoot: true });
  assert.equal(f.seen.recovers, 1, 'the second boot walks because the first one did not finish');
  assert.equal(f.session.get('known.bookmarks.tree-reconciled.v1'), true);
});
