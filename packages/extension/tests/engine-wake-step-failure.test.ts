import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, test, vi } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { WAKE_FAILURE_KEY, WAKE_FAILURE_VISIBLE_AFTER, createWakeFailureLog, guardWakeStep } from '../src/sw/wake-failure.js';
import { AuthorityFencedError } from '../src/authority-fence.js';

/**
 * Rule E: a step of the engine wake that throws leaves a durable record that Status reads; the
 * wake goes on past a step that is not a prerequisite. Before this, `replicaRebuilder().resume()`
 * failing returned silently and an unguarded scan rejected the whole wake without a trace.
 */
const scope: SyncScope = { environment: 'production', serverId: 'server-wake', serverOrigin: 'https://known.example',
  accountId: 'account-wake', browserProfileId: 'profile-wake', collectionId: 'collection-wake',
  replicaId: 'replica-wake', generation: 1 };

function memoryStorage() {
  const data = new Map<string, unknown>();
  return { data,
    get: async (key: string | string[] | null) => {
      if (key === null) return Object.fromEntries(data);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((name) => data.has(name)).map((name) => [name, structuredClone(data.get(name))]));
    },
    set: async (items: Record<string, unknown>) => { for (const [name, value] of Object.entries(items)) data.set(name, structuredClone(value)); },
    remove: async (key: string | string[]) => { for (const name of Array.isArray(key) ? key : [key]) data.delete(name); } };
}

describe('the wake failure log', () => {
  test('counts consecutive failures, shows them from the third, and a success clears them', async () => {
    const storage = memoryStorage(); let clock = 1_000; const log = createWakeFailureLog(storage, () => clock);
    for (let wake = 1; wake <= WAKE_FAILURE_VISIBLE_AFTER; wake += 1) {
      clock += 60_000;
      assert.deepEqual(await log.visible('replica-wake'), [], `wake ${wake - 1}`);
      await log.record('rebuild_resume', new Error('quota_exceeded'), 'replica-wake');
    }
    const [failure] = await log.visible('replica-wake');
    assert.deepEqual([failure?.stage, failure?.code, failure?.count, failure?.firstAt, failure?.lastAt],
      ['rebuild_resume', 'quota_exceeded', 3, 61_000, 181_000]);
    assert.deepEqual(await log.visible('another-replica'), [], 'a record belongs to its replica');
    await log.clear('rebuild_resume');
    assert.deepEqual(await log.visible('replica-wake'), []);
    assert.equal(storage.data.has(WAKE_FAILURE_KEY), false, 'nothing is left behind');
  });

  test('waits and fences are not failures; an unreadable store never throws', async () => {
    const storage = memoryStorage(); const log = createWakeFailureLog(storage);
    for (const code of ['not_connected', 'permission_required', 'offline', 'network_unavailable']) {
      assert.equal(await log.record('push_drain', new Error(code)), undefined, code);
    }
    assert.equal(await log.record('push_drain', new AuthorityFencedError()), undefined);
    assert.equal(storage.data.size, 0);
    const broken = createWakeFailureLog({ get: async () => { throw new Error('storage_gone'); },
      set: async () => { throw new Error('storage_gone'); }, remove: async () => { throw new Error('storage_gone'); } });
    assert.equal(await broken.record('push_drain', new Error('quota_exceeded')), undefined);
    assert.deepEqual(await broken.visible(), []);
    await broken.clear('push_drain');
  });

  test('guardWakeStep returns the failure, mirrors it, and lets a fence unwind', async () => {
    const storage = memoryStorage(); const log = createWakeFailureLog(storage); const mirrored: string[] = [];
    const failed = await guardWakeStep(log, 'missing_removals', async () => { throw new RangeError('Invalid array length'); },
      { diagnose: async (failure) => { mirrored.push(`${failure.stage}:${failure.code}`); } });
    assert.deepEqual(failed, { ok: false, code: 'operation_rangeerror' });
    assert.deepEqual(mirrored, ['missing_removals:operation_rangeerror']);
    assert.deepEqual(await guardWakeStep(log, 'missing_removals', async () => 7), { ok: true, value: 7 });
    assert.equal(storage.data.has(WAKE_FAILURE_KEY), false);
    await assert.rejects(() => guardWakeStep(log, 'x', async () => { throw new AuthorityFencedError(); }), AuthorityFencedError);
  });
});

describe('Status names a failing wake step', () => {
  test('after three failing wakes the attention snapshot lists it as an item with its stage and cause', async () => {
    const store = createSyncStateStore({ indexedDB: new IDBFactory() });
    await store.registerScope({ ...scope, lifecycle: 'active', rootStatus: 'ready',
      lease: { leaseId: 'lease-wake', expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null, selectedRoots: [] });
    const storage = memoryStorage(); const log = createWakeFailureLog(storage);
    const read = async () => {
      const response = await handleSyncAttentionRequest({ scope: async () => scope, store, wakeFailures: (id) => log.visible(id) });
      assert.equal(response.ok, true); if (!response.ok) throw new Error('attention');
      return response.attention;
    };
    for (let wake = 0; wake < WAKE_FAILURE_VISIBLE_AFTER - 1; wake += 1) await log.record('missing_removals', new Error('storage_unavailable'), scope.replicaId);
    assert.equal((await read()).issueCount, 0, 'two failing wakes are not news');
    await log.record('missing_removals', new Error('storage_unavailable'), scope.replicaId);
    const attention = await read();
    assert.equal(attention.issueCount, 1);
    const [issue] = attention.issues ?? [];
    assert.deepEqual([issue?.direction, issue?.code, issue?.stage, issue?.rootCause, issue?.count],
      ['local', 'sync_step_failed', 'missing_removals', 'storage_unavailable', 3]);
    assert.equal(attention.retryAvailable, true, 'Retry runs the wake again');
    await log.clear('missing_removals');
    assert.equal((await read()).issueCount, 0);
    store.close();
  });
});

describe('runSyncEngine records a failing step and goes on', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); for (const path of ['../src/sw/runtime.js', '../src/sw/scope.js',
    '../src/sw/scope-rebuild.js', '../src/sw/bookmarks.js', '../src/local-save-freeze-recovery.js', '../src/durable-sync-engine.js']) vi.doUnmock(path); });

  async function load(options: { resume: () => Promise<unknown>; permission?: boolean; frozen?: boolean;
    captureMissingRemovals?: () => Promise<void> }) {
    vi.resetModules();
    const base = createSyncStateStore({ indexedDB: new IDBFactory() });
    await base.registerScope({ ...scope, lifecycle: 'active', rootStatus: 'ready',
      lease: { leaseId: 'lease-wake', expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null, selectedRoots: [] });
    if (options.frozen) await base.transitionEngine(scope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
      authorityRefreshRequired: false, notBefore: 0 });
    const storage = memoryStorage(); const events: string[] = [];
    const syncState = { ...base, prunePullHistory: async (...args: Parameters<typeof base.prunePullHistory>) => {
      events.push('prune'); return base.prunePullHistory(...args); } } as typeof base;
    vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
    vi.stubGlobal('chrome', { permissions: { onRemoved: { addListener: () => undefined }, contains: async () => options.permission === true },
      bookmarks: { get: async () => [], getChildren: async () => [] }, alarms: { create: () => undefined, clear: async () => true },
      storage: { local: storage, session: { get: async () => ({}), set: async () => undefined, setAccessLevel: async () => undefined } },
      runtime: { id: 'wake-extension', getURL: (path: string) => `chrome-extension://wake-extension/${path}` } });
    vi.doMock('../src/sw/runtime.js', () => ({
      store: { assertWritable: async () => undefined, fence: { capture: async () => ({ generation: 1 }) } }, syncState,
      workCoordinator: { run: async (_lane: string, work: (context: unknown) => Promise<unknown>) =>
        work({ generation: 1, signal: new AbortController().signal }), hasInFlight: () => false },
      sw: { configPromise: undefined, sessionRetryNotBefore: 0, confirmedOnlineWakePending: false },
      hasBookmarkPermission: async () => options.permission === true,
      extensionOrigin: () => 'chrome-extension://wake-extension',
      safeError: (error: unknown) => error instanceof Error ? error.message : 'operation_failed',
      rootScopeKey: () => 'scope', BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery' }));
    vi.doMock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope, restoredSyncScope: async () => scope,
      loadConfig: async () => ({}), pushSessionAuthority: async () => { throw new Error('session_unavailable'); },
      currentSyncStatusAuthority: async () => undefined }));
    vi.doMock('../src/sw/scope-rebuild.js', () => ({ replicaRebuilder: () => ({ resume: async () => { events.push('resume'); return options.resume(); },
      hasPending: async () => false }) }));
    vi.doMock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: () => undefined, settled: async () => undefined,
      status: () => ({ listenerInstalled: false }) },
    currentBookmarkEventQueue: async () => ({ captureMissingRemovals: async () => { events.push('missing_removals'); await options.captureMissingRemovals?.(); },
      flush: async () => undefined, recover: async () => undefined }) }));
    vi.doMock('../src/local-save-freeze-recovery.js', () => ({ recoverMappedIdentityFreeze: async () => undefined,
      recoverLocalSaveFreeze: async () => undefined }));
    const engine = await import('../src/sw/engine.js');
    const context = { generation: 1, signal: new AbortController().signal };
    return { engine, context, syncState, storage, events, log: createWakeFailureLog(storage) };
  }

  test('a reset that cannot resume is recorded, and the wake still reaches the rest of its work', async () => {
    const loaded = await load({ resume: async () => { throw new Error('quota_exceeded'); } });
    for (let wake = 0; wake < WAKE_FAILURE_VISIBLE_AFTER; wake += 1) await loaded.engine.runSyncEngine('alarm', false, loaded.context);
    assert.deepEqual(loaded.events, ['resume', 'prune', 'resume', 'prune', 'resume', 'prune'], 'the wake went on past the failing step');
    const [failure] = await loaded.log.visible(scope.replicaId);
    assert.deepEqual([failure?.stage, failure?.code, failure?.count], ['rebuild_resume', 'quota_exceeded', 3]);
    const diagnostics = (await loaded.syncState.exportDiagnostics()).records as Array<Record<string, unknown>>;
    assert.ok(diagnostics.some((row) => row.kind === 'wake_failure' && row.code === 'rebuild_resume'
      && (row.details as Record<string, unknown>).code === 'quota_exceeded'), 'mirrored into the diagnostics export');
    loaded.syncState.close();
  });

  test('an unexpected engine failure retains an already scheduled earlier retry', async () => {
    vi.doMock('../src/durable-sync-engine.js', () => ({ createDurableSyncEngine: () => ({
      wake: async () => { throw new Error('storage_unavailable'); },
    }) }));
    const loaded = await load({ resume: async () => false, permission: true, frozen: true });
    const create = vi.fn(), get = vi.fn(async () => ({ scheduledTime: Date.now() + 1000 }));
    Object.assign(chrome.alarms, { get, create });
    try {
      await loaded.engine.runSyncEngine('alarm', false, loaded.context);
      const failures = loaded.storage.data.get(WAKE_FAILURE_KEY) as Record<string, { code: string }>;
      assert.equal(failures.engine_wake?.code, 'storage_unavailable');
      assert.equal(get.mock.calls.length, 1);
      assert.equal(create.mock.calls.length, 0);
    } finally { loaded.syncState.close(); }
  });

  test('a reset that resumes again clears its record', async () => {
    let fail = true;
    const loaded = await load({ resume: async () => { if (fail) throw new Error('quota_exceeded'); return false; } });
    await loaded.engine.runSyncEngine('alarm', false, loaded.context);
    assert.equal((await createWakeFailureLog(loaded.storage).visible()).length, 0, 'one failure is not shown');
    assert.ok(loaded.storage.data.has(WAKE_FAILURE_KEY));
    fail = false;
    await loaded.engine.runSyncEngine('alarm', false, loaded.context);
    assert.equal(loaded.storage.data.has(WAKE_FAILURE_KEY), false);
    loaded.syncState.close();
  });

  test('a sign-in that is missing is a wait, not a failure', async () => {
    const loaded = await load({ resume: async () => { throw new Error('not_connected'); } });
    await loaded.engine.runSyncEngine('alarm', false, loaded.context);
    assert.deepEqual(loaded.events, ['resume'], 'nothing to sync without a credential');
    assert.equal(loaded.storage.data.size, 0);
    loaded.syncState.close();
  });

  test('the unguarded missing-removal scan no longer rejects the wake', async () => {
    const loaded = await load({ resume: async () => false, permission: true, frozen: true,
      captureMissingRemovals: async () => { throw new Error('storage_unavailable'); } });
    await loaded.engine.runSyncEngine('manual', false, loaded.context);
    assert.ok(loaded.events.includes('missing_removals'));
    const stored = loaded.storage.data.get(WAKE_FAILURE_KEY) as Record<string, { code: string; count: number }>;
    assert.equal(stored.missing_removals?.code, 'storage_unavailable');
    assert.equal(stored.missing_removals?.count, 1);
    loaded.syncState.close();
  });
});
