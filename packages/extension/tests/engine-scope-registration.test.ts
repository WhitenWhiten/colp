import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, test, vi } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { WAKE_FAILURE_KEY, createWakeFailureLog } from '../src/sw/wake-failure.js';

/**
 * W2A-06: the sync database was lost while the binding and the Session survived. The scope record is only
 * written when a Session is minted or renewed, so every wake found nothing and ended without a word until the
 * Session next renewed. A wake that finds a live Session and no scope record now writes it again.
 */
const scope: SyncScope = { environment: 'production', serverId: 'server-reg', serverOrigin: 'https://known.example',
  accountId: 'account-reg', browserProfileId: 'profile-reg', collectionId: 'collection-reg',
  replicaId: 'replica-reg', generation: 1 };

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

describe('a wake whose scope record is gone', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); for (const path of ['../src/sw/runtime.js', '../src/sw/scope.js',
    '../src/sw/scope-rebuild.js', '../src/sw/bookmarks.js', '../src/local-save-freeze-recovery.js']) vi.doUnmock(path); });

  async function load(options: { registered: boolean; session?: boolean; credential?: boolean; register?: () => Promise<void> }) {
    vi.resetModules();
    const base = createSyncStateStore({ indexedDB: new IDBFactory() });
    const record = { ...scope, lifecycle: 'active' as const, rootStatus: 'ready' as const,
      lease: { leaseId: 'lease-reg', expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: null, selectedRoots: [] };
    if (options.registered) await base.registerScope(record);
    const storage = memoryStorage(); const events: string[] = []; const registrations: unknown[][] = [];
    const syncState = { ...base, prunePullHistory: async () => { events.push('prune'); return base.prunePullHistory(scope); } } as typeof base;
    vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
    vi.stubGlobal('chrome', { permissions: { onRemoved: { addListener: () => undefined }, contains: async () => false },
      bookmarks: { get: async () => [], getChildren: async () => [] }, alarms: { create: () => undefined, clear: async () => true },
      storage: { local: storage, session: { get: async () => ({}), set: async () => undefined, setAccessLevel: async () => undefined } },
      runtime: { id: 'reg-extension', getURL: (path: string) => `chrome-extension://reg-extension/${path}` } });
    vi.doMock('../src/sw/runtime.js', () => ({
      store: { assertWritable: async () => undefined, fence: { capture: async () => ({ generation: 1 }) },
        loadCredential: async () => options.credential === false ? undefined : { subject: scope.accountId, serverOrigin: scope.serverOrigin },
        loadSession: async () => options.session === false ? undefined : { sessionId: 'session-reg' } },
      syncState,
      workCoordinator: { run: async (_lane: string, work: (context: unknown) => Promise<unknown>) =>
        work({ generation: 1, signal: new AbortController().signal }), hasInFlight: () => false },
      sw: { configPromise: undefined, sessionRetryNotBefore: 0, confirmedOnlineWakePending: false },
      hasBookmarkPermission: async () => false, extensionOrigin: () => 'chrome-extension://reg-extension',
      safeError: (error: unknown) => error instanceof Error ? error.message : 'operation_failed',
      rootScopeKey: () => 'scope', BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery' }));
    vi.doMock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope, restoredSyncScope: async () => scope,
      loadConfig: async () => ({ environment: 'production' }), pushSessionAuthority: async () => { throw new Error('session_unavailable'); },
      currentSyncStatusAuthority: async () => undefined,
      ensureSyncScope: async (...args: unknown[]) => { registrations.push(args); await (options.register ?? (() => base.registerScope(record).then(() => undefined)))(); } }));
    vi.doMock('../src/sw/scope-rebuild.js', () => ({ replicaRebuilder: () => ({ resume: async () => false, hasPending: async () => false }) }));
    vi.doMock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: () => undefined, settled: async () => undefined,
      status: () => ({ listenerInstalled: false }) },
    currentBookmarkEventQueue: async () => ({ captureMissingRemovals: async () => undefined, flush: async () => undefined, recover: async () => undefined }) }));
    vi.doMock('../src/local-save-freeze-recovery.js', () => ({ recoverMappedIdentityFreeze: async () => undefined,
      recoverLocalSaveFreeze: async () => undefined }));
    const engine = await import('../src/sw/engine.js');
    return { engine, context: { generation: 1, signal: new AbortController().signal }, syncState, storage, events, registrations,
      log: createWakeFailureLog(storage) };
  }

  test('is registered again from the live Session, the wake goes on, and a diagnostic says so', async () => {
    const loaded = await load({ registered: false });
    await loaded.engine.runSyncEngine('alarm', false, loaded.context);
    assert.equal(loaded.registrations.length, 1);
    const [config, credential, session, generation] = loaded.registrations[0]!;
    assert.deepEqual([config, credential, session, generation], [{ environment: 'production' },
      { subject: scope.accountId, serverOrigin: scope.serverOrigin }, { sessionId: 'session-reg' }, 1]);
    assert.ok(await loaded.syncState.getScope(scope));
    assert.deepEqual(loaded.events, ['prune'], 'the rest of the wake ran against the new record');
    const diagnostics = (await loaded.syncState.exportDiagnostics()).records as Array<Record<string, unknown>>;
    assert.ok(diagnostics.some(row => row.kind === 'scope_reregistered' && row.code === 'scope_not_registered'));
    assert.equal(loaded.storage.data.has(WAKE_FAILURE_KEY), false, 'a healed wake is not a failure');
    loaded.syncState.close();
  });

  test('a scope that is there is left alone', async () => {
    const loaded = await load({ registered: true });
    await loaded.engine.runSyncEngine('alarm', false, loaded.context);
    assert.equal(loaded.registrations.length, 0);
    assert.deepEqual(loaded.events, ['prune']);
    loaded.syncState.close();
  });

  test('without a Session there is nothing to register with: the wake ends quietly, the Session lane registers later', async () => {
    const loaded = await load({ registered: false, session: false });
    await loaded.engine.runSyncEngine('alarm', false, loaded.context);
    assert.equal(loaded.registrations.length, 0);
    assert.deepEqual(loaded.events, []);
    assert.equal(loaded.storage.data.size, 0);
    loaded.syncState.close();
  });

  test('a registration that is refused is recorded as the failing step and ends the wake', async () => {
    const loaded = await load({ registered: false, register: async () => { throw new Error('scope_retired'); } });
    await loaded.engine.runSyncEngine('alarm', false, loaded.context);
    await loaded.engine.runSyncEngine('alarm', false, loaded.context);
    await loaded.engine.runSyncEngine('alarm', false, loaded.context);
    assert.deepEqual(loaded.events, [], 'nothing runs against a scope that does not exist');
    const [failure] = await loaded.log.visible(scope.replicaId);
    assert.deepEqual([failure?.stage, failure?.code, failure?.count], ['scope_registration', 'scope_retired', 3]);
    loaded.syncState.close();
  });
});
