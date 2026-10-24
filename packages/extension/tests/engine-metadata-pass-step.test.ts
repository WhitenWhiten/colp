import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, test, vi } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { WAKE_FAILURE_KEY, WAKE_FAILURE_VISIBLE_AFTER, createWakeFailureLog } from '../src/sw/wake-failure.js';

/**
 * W2A-11: the whole-tree metadata pass of a wake used to end in `.catch(() => undefined)`: a pass that failed
 * every time left no trace, no issue and no diagnostic, and ran again on every alarm. It is a guarded wake
 * step now: the failure is recorded (and shown from the third wake), and the rest of the wake is not cut short.
 */
const scope: SyncScope = { environment: 'production', serverId: 'server-meta', serverOrigin: 'https://known.example',
  accountId: 'account-meta', browserProfileId: 'profile-meta', collectionId: 'collection-meta',
  replicaId: 'replica-meta', generation: 1 };

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

describe('the metadata pass of a wake', () => {
  const mocked = ['../src/sw/runtime.js', '../src/sw/scope.js', '../src/sw/scope-rebuild.js', '../src/sw/bookmarks.js',
    '../src/local-save-freeze-recovery.js', '../src/durable-sync-engine.js', '../src/sw/bookmark-metadata.js',
    '../src/sw/classification-local-projection.js', '../src/sw/favicon.js', '../src/sw/first-run.js', '../src/push-work-budget.js'];
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); for (const path of mocked) vi.doUnmock(path); });

  async function load(pass: { fail: boolean }) {
    vi.resetModules();
    const syncState = createSyncStateStore({ indexedDB: new IDBFactory() });
    await syncState.registerScope({ ...scope, lifecycle: 'active', rootStatus: 'ready',
      lease: { leaseId: 'lease-meta', expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null, selectedRoots: [] });
    // A frozen engine makes the wake reconcile the tree after it, which is where the metadata pass runs.
    await syncState.transitionEngine(scope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
      authorityRefreshRequired: false, notBefore: 0 });
    const storage = memoryStorage(); const events: string[] = [];
    vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
    vi.stubGlobal('chrome', { permissions: { onRemoved: { addListener: () => undefined }, contains: async () => true },
      bookmarks: { get: async () => [], getChildren: async () => [] }, alarms: { create: () => undefined, clear: async () => true },
      storage: { local: storage, session: { get: async () => ({}), set: async () => undefined, setAccessLevel: async () => undefined } },
      runtime: { id: 'meta-extension', getURL: (path: string) => `chrome-extension://meta-extension/${path}` } });
    vi.doMock('../src/sw/runtime.js', () => ({
      store: { assertWritable: async () => undefined, fence: { capture: async () => ({ generation: 1 }) } }, syncState,
      workCoordinator: { run: async (_lane: string, work: (context: unknown) => Promise<unknown>) =>
        work({ generation: 1, signal: new AbortController().signal }), hasInFlight: () => false },
      sw: { configPromise: undefined, sessionRetryNotBefore: 0, confirmedOnlineWakePending: false },
      hasBookmarkPermission: async () => true, extensionOrigin: () => 'chrome-extension://meta-extension',
      safeError: (error: unknown) => error instanceof Error ? error.message : 'operation_failed',
      rootScopeKey: () => 'scope', BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery' }));
    vi.doMock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope, restoredSyncScope: async () => scope,
      loadConfig: async () => ({}), pushSessionAuthority: async () => { throw new Error('session_unavailable'); },
      currentSyncStatusAuthority: async () => undefined }));
    vi.doMock('../src/sw/scope-rebuild.js', () => ({ replicaRebuilder: () => ({ resume: async () => false, hasPending: async () => false }) }));
    vi.doMock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: () => undefined, settled: async () => undefined,
      status: () => ({ listenerInstalled: false }) },
    currentBookmarkEventQueue: async () => ({ captureMissingRemovals: async () => undefined, flush: async () => undefined,
      recover: async () => { events.push('recover'); } }) }));
    vi.doMock('../src/local-save-freeze-recovery.js', () => ({ recoverMappedIdentityFreeze: async () => undefined,
      recoverLocalSaveFreeze: async () => undefined }));
    vi.doMock('../src/durable-sync-engine.js', () => ({ createDurableSyncEngine: () => ({
      wake: async () => ({ phase: 'sleeping', recoveryFrozen: false, lastError: undefined }), refreshPlacement: async () => 'continue' }) }));
    vi.doMock('../src/sw/bookmark-metadata.js', () => ({ syncBrowserMetadata: async () => {
      events.push('metadata'); if (pass.fail) throw new Error('quota_exceeded'); return { staged: 0, needsSnapshot: false }; } }));
    vi.doMock('../src/sw/classification-local-projection.js', () => ({ refreshLocalClassificationProjection: async () => { events.push('classification'); } }));
    vi.doMock('../src/sw/favicon.js', () => ({ drainFaviconSidecarsForCurrentScope: async () => undefined }));
    vi.doMock('../src/sw/first-run.js', () => ({ resumeRunningBootstrap: async () => false,
      matchBootstrapBeforeSnapshotProjection: async () => undefined }));
    vi.doMock('../src/push-work-budget.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/push-work-budget.js')>(), hasFreshPushQueueHead: async () => false }));
    const engine = await import('../src/sw/engine.js');
    return { engine, context: { generation: 1, signal: new AbortController().signal }, syncState, storage, events,
      log: createWakeFailureLog(storage) };
  }

  test('a pass that keeps failing is recorded as its own step, shown from the third wake, and does not cut the wake short', async () => {
    const loaded = await load({ fail: true });
    for (let wake = 0; wake < WAKE_FAILURE_VISIBLE_AFTER; wake += 1) await loaded.engine.runSyncEngine('manual', false, loaded.context);
    assert.deepEqual(loaded.events.filter(name => name !== 'recover'),
      Array.from({ length: WAKE_FAILURE_VISIBLE_AFTER }, () => ['metadata', 'classification']).flat(), 'the rest of the wake ran after each failure');
    const [failure] = await loaded.log.visible(scope.replicaId);
    assert.deepEqual([failure?.stage, failure?.code, failure?.count], ['metadata_pass', 'quota_exceeded', WAKE_FAILURE_VISIBLE_AFTER]);
    const diagnostics = (await loaded.syncState.exportDiagnostics()).records as Array<Record<string, unknown>>;
    assert.ok(diagnostics.some(row => row.kind === 'wake_failure' && row.code === 'metadata_pass'), 'mirrored into the diagnostics export');
    loaded.syncState.close();
  });

  test('a pass that works again clears the record', async () => {
    const pass = { fail: true };
    const loaded = await load(pass);
    await loaded.engine.runSyncEngine('manual', false, loaded.context);
    assert.ok(loaded.storage.data.has(WAKE_FAILURE_KEY));
    pass.fail = false;
    await loaded.engine.runSyncEngine('manual', false, loaded.context);
    assert.equal(loaded.storage.data.has(WAKE_FAILURE_KEY), false);
    loaded.syncState.close();
  });
});
