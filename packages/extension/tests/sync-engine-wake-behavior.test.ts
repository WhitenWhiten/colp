/**
 * Durable engine wake behaviour of the extracted service-worker engine module.
 *
 * The contract test used to grep `known-sync-engine` / `known-outbound-push` out of
 * the worker source text. This drives the real `scheduleSyncEngineWake` instead, so
 * the MV3 ~30s alarm floor (SR-15), the single alarm owner, the engine-lane
 * admission and the confirmed-online coalescing are observed rather than matched.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test, vi } from 'vitest';

const observed = vi.hoisted(() => ({
  scope: { environment: 'production', serverId: 'server-wake', serverOrigin: 'https://known.example',
    accountId: 'account-wake', browserProfileId: 'profile-wake', collectionId: 'collection-wake',
    replicaId: 'replica-wake', generation: 1 },
  lanes: [] as string[],
  alarmNames: [] as string[],
  alarms: [] as Array<{ name: string; when: number }>,
  scopeReads: 0,
  fetches: 0,
  credentialRestored: true,
  restores: 0,
}));

vi.mock('../src/sw/runtime.js', async () => {
  const { createExtensionWorkCoordinator } = await import('../src/authority-fence.js');
  const { MemoryStorageArea, createCredentialStore } = await import('../src/credential-store.js');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  const store = createCredentialStore(new MemoryStorageArea());
  const coordinator = createExtensionWorkCoordinator(store.fence);
  return {
    store,
    syncState: createSyncStateStore({ indexedDB: new IDBFactory() }),
    workCoordinator: { ...coordinator,
      run: <T,>(lane: Parameters<typeof coordinator.run>[0], work: () => Promise<T>) => {
        observed.lanes.push(lane); return coordinator.run(lane, work); } },
    sw: { configPromise: undefined, confirmedOnlineWakePending: false, coalescedOnlineWake: undefined },
    hasBookmarkPermission: async () => true,
    extensionOrigin: () => 'chrome-extension://probe-extension',
    safeError: (error: unknown) => error instanceof Error ? error.message : 'operation_failed',
    BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery',
    rootScopeKey: () => 'scope',
  };
});

vi.mock('../src/sw/scope.js', () => ({
  requireSyncScope: async () => observed.scope,
  currentSyncScope: async () => { observed.scopeReads += 1; return observed.scope; },
  // The real helper restores a missing cookie credential through the Session lane.
  restoredSyncScope: async () => {
    if (!observed.credentialRestored) { observed.restores += 1; observed.credentialRestored = true; }
    observed.scopeReads += 1; return observed.scope;
  },
  loadConfig: async () => ({ manifestUrl: 'https://known.example/manifest.json' }),
  pushSessionAuthority: async () => undefined, currentSyncStatusAuthority: async () => undefined,
  stateAfterFailure: async () => undefined, ensureSyncScope: async () => observed.scope,
  enforceManagedPolicy: async () => undefined, hasBoundCollection: async () => true,
  retire: async () => undefined, scheduleSessionFreshen: () => undefined, sessionRequest: async () => undefined,
}));

describe('durable engine wake uses one bounded MV3 alarm and one engine lane', () => {
  beforeEach(() => {
    observed.lanes.length = 0; observed.alarmNames.length = 0; observed.alarms.length = 0;
    observed.scopeReads = 0; observed.fetches = 0; observed.credentialRestored = true; observed.restores = 0;
    // The wake must stay hermetic: an unregistered scope has no durable work, so
    // runSyncEngine returns before it can discover endpoints.
    vi.stubGlobal('fetch', async () => { observed.fetches += 1; throw new Error('network_disabled'); });
    (globalThis as Record<string, unknown>).chrome = {
      storage: { local: { get: async () => ({}) } },
      alarms: {
        get: async (name: string) => {
          const alarm = observed.alarms.findLast((entry) => entry.name === name);
          return alarm ? { scheduledTime: alarm.when } : undefined;
        },
        create: (name: string, options: { when?: number } = {}) => {
          observed.alarmNames.push(name); observed.alarms.push({ name, when: options.when ?? 0 }); } },
    };
  });

  test('a delayed wake creates the durable known-sync-engine alarm at the MV3 floor', async () => {
    const { scheduleSyncEngineWake } = await import('../src/sw/engine.js');
    const now = Date.now();
    await scheduleSyncEngineWake('manual', 45_000);
    assert.deepEqual(observed.alarmNames, ['known-sync-engine']);
    assert.equal(observed.alarms[0]!.when >= now + 45_000, true);

    // The floor is measured from before the call: reading the clock afterwards fails whenever a millisecond passes.
    const before = Date.now();
    await scheduleSyncEngineWake('alarm', 1_000);
    assert.equal(observed.alarms[1]!.when >= before + 30_000, true,
      'sub-minute retries must not pretend to run sooner than the MV3 floor allows');
    assert.equal(observed.alarms[1]!.when <= Date.now() + 31_000, true);
  });

  test('an immediate wake takes the engine lane without creating a second alarm owner', async () => {
    const { scheduleSyncEngineWake } = await import('../src/sw/engine.js');
    await scheduleSyncEngineWake('startup');
    assert.equal(observed.lanes.filter((lane) => lane === 'engine').length, 1);
    assert.deepEqual(observed.alarmNames, []);
    assert.equal(observed.scopeReads > 0, true, 'the wake reached the durable engine run');
    assert.equal(observed.fetches, 0, 'an idle scope must not open a network round trip');
  });

  test('a start-up wake before any page asked for auth status restores the credential and still runs', async () => {
    const { scheduleSyncEngineWake } = await import('../src/sw/engine.js');
    observed.credentialRestored = false;
    await scheduleSyncEngineWake('startup');
    assert.equal(observed.restores, 1, 'the wake restored the cookie credential instead of giving up');
    assert.equal(observed.scopeReads > 0, true, 'the wake reached the durable engine run');
  });

  test('concurrent confirmed-online wakes coalesce into one engine-lane operation', async () => {
    const { scheduleSyncEngineWake } = await import('../src/sw/engine.js');
    const first = scheduleSyncEngineWake('online', 0, true);
    const second = scheduleSyncEngineWake('online', 0, true);
    assert.equal(first === second, true);
    await first;
    const third = scheduleSyncEngineWake('online', 0, true);
    assert.equal(third === first, false, 'a settled wake must not be reused');
    await third;
    assert.deepEqual(observed.lanes, ['engine', 'engine']);
  });
});
