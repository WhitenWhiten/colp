/**
 * MV3 service-worker entry wiring, executed instead of grepped.
 *
 * The former `*.contract.test.ts` text nails asserted that `src/service-worker.ts`
 * contains `bookmarkListenerLifecycle.install()`, `scheduleSyncEngineWake('online', 0, true)`,
 * `recoverBookmarkEventsAfterEngineSettles('startup')`, ... — a regex cannot tell a
 * live registration from a commented-out one. Here the real entry is imported once
 * with a chrome stub, the module seams it depends on are mocked (the seam is the
 * injection point), and every registration is driven through its real listener.
 *
 * Modules kept real: `src/service-worker.ts`, `src/sw/messages.ts` (routing
 * validators), `src/sw/bookmarks.ts` (recovery chain), `src/bookmark-listener-lifecycle.ts`,
 * `src/authority-fence.ts` (lane coordinator), `src/sync-state-store.ts`,
 * `src/credential-store.ts`.
 */
import assert from 'node:assert/strict';
import { MemoryStorageArea } from '../src/credential-store.js';
import { LOCAL_CLASSIFICATION_KEY, LOCAL_CLASSIFICATION_PROJECTION } from '../src/classification-local-session.js';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

const observed = vi.hoisted(() => ({
  scope: { environment: 'production' as const, serverId: 'server-entry', serverOrigin: 'https://known.example',
    accountId: 'account-entry', browserProfileId: 'profile-entry', collectionId: 'collection-entry',
    replicaId: 'replica-entry', generation: 1 },
  wakes: [] as Array<{ reason: string; delay: number; connectivity: boolean }>,
  recoveries: [] as string[],
  lanes: [] as string[],
  queueRecovers: 0,
  resumes: 0,
  firstRunRequests: [] as string[],
  engineRequests: 0,
  clears: [] as string[],
  /** Repeating-alarm intervals, keyed by alarm name. */
  alarmPeriods: {} as Record<string, number>,
}));

vi.mock('../src/sw/runtime.js', async () => {
  const { createExtensionWorkCoordinator } = await import('../src/authority-fence.js');
  const { MemoryStorageArea, createCredentialStore } = await import('../src/credential-store.js');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  const store = createCredentialStore(new MemoryStorageArea());
  const coordinator = createExtensionWorkCoordinator(store.fence);
  const syncState = createSyncStateStore({ indexedDB: new IDBFactory() });
  return {
    COLLECTION_BINDING: 'known.sync.collection.v1',
    WELCOME_FLAG: 'known.onboarding.installed.v1',
    BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery',
    BOOKMARK_RECONCILE_ALARM: 'known-bookmark-reconcile',
    BOOKMARK_RECONCILE_PERIOD_MINUTES: 180,
    DEFAULT_SYNC_FOLDER_TITLE: 'Know-N',
    store,
    syncState,
    workCoordinator: { ...coordinator,
      run: <T,>(lane: Parameters<typeof coordinator.run>[0], work: () => Promise<T>) => {
        observed.lanes.push(lane); return coordinator.run(lane, work); } },
    sw: { configPromise: undefined, bindingPromise: undefined, importPreviews: new Map(),
      bookmarkEventQueue: undefined, bookmarkEventScopeKey: undefined },
    hasBookmarkPermission: async () => true,
    rootScopeKey: (scope: { replicaId: string }) => scope.replicaId,
    extensionOrigin: () => 'chrome-extension://probe-extension',
    safeError: (error: unknown) => error instanceof Error ? error.message : 'operation_failed',
  };
});

vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => observed.scope,
  loadConfig: async () => ({ manifestUrl: 'https://known.example/manifest.json', clientId: 'client' }),
  pushSessionAuthority: async () => undefined, currentSyncStatusAuthority: async () => undefined,
  stateAfterFailure: async () => undefined, requireSyncScope: async () => observed.scope,
  ensureSyncScope: async () => observed.scope, enforceManagedPolicy: async () => undefined,
  hasBoundCollection: async () => true, retire: async () => undefined, scheduleSessionFreshen: () => undefined,
  sessionRequest: async () => undefined }));

vi.mock('../src/sw/engine.js', () => ({
  scheduleSyncEngineWake: (reason: string, delay = 0, connectivity = false) => {
    observed.wakes.push({ reason, delay, connectivity }); return Promise.resolve(); },
  handleSyncEngineRequest: async () => { observed.engineRequests += 1; return { ok: true, phase: 'idle' }; },
}));

vi.mock('../src/sw/bookmarks.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/sw/bookmarks.js')>();
  return { ...real,
    recoverBookmarkEventsAfterEngineSettles: async (reason = 'manual') => {
      observed.recoveries.push(reason); return real.recoverBookmarkEventsAfterEngineSettles(reason as 'manual'); } };
});

vi.mock('../src/bookmark-event-queue.js', () => ({
  createBookmarkEventQueue: () => ({ recover: async () => { observed.queueRecovers += 1; },
    flush: async () => undefined, correlationFor: async () => 'correlation' }),
}));

vi.mock('../src/sw/roots.js', () => ({ handleRootRequest: async () => ({ ok: true }),
  resumeBookmarksAfterPermissionGrant: async () => { observed.resumes += 1; } }));

vi.mock('../src/sw/first-run.js', () => ({
  handleFirstRunRequest: async (message: { kind: string }) => { observed.firstRunRequests.push(message.kind);
    return { ok: true, state: {} }; },
  handleScopeCommand: async () => ({ ok: true }), resumeRunningBootstrap: async () => undefined }));

vi.mock('../src/sw/batch.js', () => ({ resumeActiveBatchPlans: async () => undefined }));
vi.mock('../src/native-repair.js', () => ({ recoverPendingNativeSideEffects: async () => undefined }));
vi.mock('../src/bootstrap/advanced-run.js', () => ({ activeAdvancedPlan: async () => undefined,
  activateAdvancedPlan: async () => undefined, executeActiveAdvancedPlan: async () => undefined,
  projectAdvancedSnapshot: async () => undefined }));
vi.mock('../src/bootstrap/advanced-event-capture.js', () => ({ captureWhileAdvanced: async () => false }));
vi.mock('../src/sw/evidence.js', () => ({ handleSyncStateEvidence: async () => ({ ok: true }) }));
vi.mock('../src/sw/auth.js', () => ({ handle: async () => ({ ok: true }), onExtensionInstalled: async () => undefined }));
vi.mock('../src/sw/import.js', () => ({ handleImportRequest: async () => ({ ok: true }) }));
vi.mock('../src/sw/collections.js', () => ({ handleCollectionCreate: async () => ({ ok: true }),
  handleCollectionList: async () => ({ ok: true }) }));
vi.mock('../src/sw/remote-delete.js', () => ({ handleRemoteDeleteRequest: async () => ({ ok: true }) }));
vi.mock('../src/sw/native-wait.js', () => ({ handleNativeWaitRequest: async () => ({ ok: true }) }));
vi.mock('../src/sw/save-status.js', () => ({ handleSaveStatus: async () => ({ ok: true }) }));
vi.mock('../src/sw/save-entry.js', () => ({ installNativeSaveEntries: () => undefined,
  saveThroughNativeEntry: async () => ({ ok: true }) }));
vi.mock('../src/sw/favicon.js', () => ({ drainFaviconSidecarsForCurrentScope: async () => undefined,
  resolveFaviconSaveContext: async () => ({ ok: true }),
  clearFaviconForCurrentScope: async (nativeId: string) => {
    observed.clears.push(nativeId); return { ok: true, outcome: 'cleared' as const };
  } }));
vi.mock('../src/auth-snapshot.js', () => ({ writeAuthSnapshot: async () => undefined }));

type ChromeListeners = {
  onAdded: Array<(permissions: { permissions?: string[] }) => void>;
  onStorageChanged: Array<(changes: Record<string, {oldValue?: unknown; newValue?: unknown}>, area: string) => void>;
  onStartup: Array<() => void>;
  onInstalled: Array<(details: unknown) => void>;
  onAlarm: Array<(alarm: { name: string }) => void>;
  onMessage: Array<(message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean>;
  onMessageExternal: Array<(message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean>;
  online: Array<(event: { isTrusted: boolean }) => void>;
  alarmNames: string[];
  bookmarkListeners: number[];
};

const chromeListeners: ChromeListeners = { onStorageChanged: [], onAdded: [], onStartup: [], onInstalled: [], onAlarm: [],
  onMessage: [], onMessageExternal: [], online: [], alarmNames: [], bookmarkListeners: [] };

/** Boot-time observations, captured during `beforeAll` before any `afterEach` reset. */
const boot = { recoveries: [] as string[], lanes: [] as string[], wakes: [] as Array<Record<string, unknown>> };

const sender = { id: 'probe-extension', url: 'chrome-extension://probe-extension/popup.html' };

function installChromeStub(): void {
  (globalThis as Record<string, unknown>).__KNOWN_EXTENSION_EVIDENCE__ = false;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  (globalThis as Record<string, unknown>).self = {
    addEventListener: (event: string, listener: (value: { isTrusted: boolean }) => void) => {
      if (event === 'online') chromeListeners.online.push(listener); } };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: 'probe-extension',
      getURL: (path: string) => `chrome-extension://probe-extension/${path}`,
      onStartup: { addListener: (listener: () => void) => chromeListeners.onStartup.push(listener) },
      onInstalled: { addListener: (listener: (details: unknown) => void) => chromeListeners.onInstalled.push(listener) },
      onMessage: { addListener: (listener: ChromeListeners['onMessage'][number]) =>
        chromeListeners.onMessage.push(listener) },
      // The bookmark-subscriptions website bridge (externally_connectable).
      onMessageExternal: { addListener: (listener: ChromeListeners['onMessageExternal'][number]) =>
        chromeListeners.onMessageExternal.push(listener) } },
    permissions: { onAdded: { addListener: (listener: (permissions: { permissions?: string[] }) => void) =>
      chromeListeners.onAdded.push(listener) }, contains: async () => true },
    alarms: { create: (name: string, info?: { when?: number; periodInMinutes?: number }) => {
        chromeListeners.alarmNames.push(name);
        if (info?.periodInMinutes !== undefined) observed.alarmPeriods[name] = info.periodInMinutes;
      },
      // Models the platform's registry: `get` reports what `create` registered,
      // so a second boot can see the alarm already exists.
      get: async (name: string) => (chromeListeners.alarmNames.includes(name)
        ? { name, scheduledTime: Date.now() + 1_000, periodInMinutes: observed.alarmPeriods[name] }
        : undefined),
      clear: async (name: string) => {
        const index = chromeListeners.alarmNames.indexOf(name);
        if (index >= 0) chromeListeners.alarmNames.splice(index, 1);
        return index >= 0;
      },
      onAlarm: { addListener: (listener: (alarm: { name: string }) => void) =>
        chromeListeners.onAlarm.push(listener) } },
    bookmarks: { onCreated: { addListener: () => undefined, hasListener: () => false },
      onChanged: { addListener: () => undefined, hasListener: () => false },
      onMoved: { addListener: () => undefined, hasListener: () => false },
      onRemoved: { addListener: () => undefined, hasListener: () => false },
      onChildrenReordered: { addListener: () => undefined, hasListener: () => false },
      get: async () => [], getChildren: async () => [] },
    storage: { local: new MemoryStorageArea(), session: new MemoryStorageArea(),
      onChanged: { addListener: (listener: ChromeListeners['onStorageChanged'][number]) =>
        chromeListeners.onStorageChanged.push(listener) } },
  };
}

/**
 * A chrome.bookmarks stub that keeps the real `addListener`/`hasListener` contract:
 * Chrome de-duplicates the same callback, so a redundant `install()` must not
 * register a second listener. No tree is needed — the event queue is mocked.
 */
function countedBookmarks() {
  const ports = ['onCreated', 'onChanged', 'onMoved', 'onRemoved', 'onChildrenReordered']
    .map(() => ({ registered: new Set<unknown>(),
      addListener(listener: unknown) { this.registered.add(listener); },
      hasListener(listener: unknown) { return this.registered.has(listener); } }));
  return {
    api: { onCreated: ports[0], onChanged: ports[1], onMoved: ports[2], onRemoved: ports[3],
      onChildrenReordered: ports[4], get: async () => [], getChildren: async () => [] },
    sizes: () => ports.map((port) => port.registered.size),
    /** Simulate a detached registration (fresh extension context) without a new module graph. */
    detach: () => { for (const port of ports) port.registered.clear(); },
  };
}

function respondWith(): { promise: Promise<unknown>; respond: (value: unknown) => void } {
  let settle!: (value: unknown) => void;
  const promise = new Promise<unknown>((resolve) => { settle = resolve; });
  return { promise, respond: settle };
}

async function settle(): Promise<void> { for (let tick = 0; tick < 8; tick += 1) await Promise.resolve(); }

type BookmarkStub = ReturnType<typeof countedBookmarks>;
let bookmarks: BookmarkStub;

describe('MV3 service worker entry wiring is exercised, not grepped', () => {
  beforeAll(async () => {
    installChromeStub();
    bookmarks = countedBookmarks();
    (globalThis as { chrome: { bookmarks: unknown } }).chrome.bookmarks = bookmarks.api;
    const { syncState } = await import('../src/sw/runtime.js');
    await syncState.registerScope({ ...observed.scope, lifecycle: 'active',
      lease: { leaseId: 'lease-entry', expiresAt: 99_999 }, checkpoint: null, selectedRoots: [] });
    await import('../src/service-worker.js');
    await vi.waitFor(() => {
      assert.equal(observed.recoveries.includes('manual'), true, 'boot recovery');
      assert.equal(observed.wakes.some((wake) => wake.reason === 'manual'), true, 'boot wake');
    });
    await settle();
    boot.recoveries.push(...observed.recoveries);
    boot.lanes.push(...observed.lanes);
    boot.wakes.push(...observed.wakes);
  });

  afterEach(() => { observed.wakes.length = 0; observed.recoveries.length = 0; observed.lanes.length = 0;
    observed.firstRunRequests.length = 0; observed.resumes = 0; observed.clears.length = 0; });

  test('collection binding changes keep the local key and drop cached collection context', async () => {
    await chrome.storage.session.set({ [LOCAL_CLASSIFICATION_KEY]: { value: 'local-test' }, [LOCAL_CLASSIFICATION_PROJECTION]: { value: 'projection' } });
    // Policy, folder preferences, classification authority and UI language each
    // have a separate storage listener. Only classification reacts to this key.
    assert.equal(chromeListeners.onStorageChanged.length, 4);
    for (const listener of chromeListeners.onStorageChanged) {
      listener({ 'known.sync.collection.v1': { oldValue: 'collection-entry', newValue: 'other' } }, 'local');
    }
    await vi.waitFor(async () => {
      // Local-first: the provider key belongs to the browser session, not the collection.
      assert.deepEqual(await chrome.storage.session.get(LOCAL_CLASSIFICATION_KEY), { [LOCAL_CLASSIFICATION_KEY]: { value: 'local-test' } });
      assert.deepEqual(await chrome.storage.session.get(LOCAL_CLASSIFICATION_PROJECTION), {});
    });
  });

  test('an update clears tag confirmation records and the retry alarm that older builds left', async () => {
    const { syncState } = await import('../src/sw/runtime.js');
    const db = await syncState.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('classification_confirmation_intents', 'readwrite');
      tx.objectStore('classification_confirmation_intents').put({ scopeKey: 'old-scope', intentId: 'old-intent', status: 'awaiting_node' });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    chromeListeners.alarmNames.push('known-classification-confirmation');
    for (const listener of chromeListeners.onInstalled) listener({ reason: 'update' });
    await vi.waitFor(async () => {
      assert.equal(chromeListeners.alarmNames.includes('known-classification-confirmation'), false);
      const count = await new Promise<number>((resolve, reject) => {
        const request = db.transaction('classification_confirmation_intents').objectStore('classification_confirmation_intents').count();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      assert.equal(count, 0);
    });
  });

  test('boot installs each bookmark consumer once and repeated installation adds no duplicates', async () => {
    // `install()` runs at the entry top level and again from the boot recovery
    // chain; Chrome de-duplicates the identical callback, so both must leave
    // one sync listener per event, plus folder ordering on create/move/reorder.
    const expected = [2, 1, 2, 1, 2];
    assert.deepEqual(bookmarks.sizes(), expected);
    const { bookmarkListenerLifecycle } = await import('../src/sw/bookmarks.js');
    const { installNativeFoldersFirst } = await import('../src/sw/bookmark-folders-first.js');
    bookmarkListenerLifecycle.install(); installNativeFoldersFirst();
    assert.deepEqual(bookmarks.sizes(), expected);
  });

  test('boot recovery wakes the engine exactly once, and never with a bare startup wake', () => {
    // Regression anchor for the retired `scheduleSyncEngineWake('startup')` top-level
    // call: boot must go through the recovery chain, not add a second unconditional wake.
    assert.deepEqual(boot.wakes, [{ reason: 'manual', delay: 0, connectivity: false }]);
  });

  test('boot and the recovery alarm both run the durable recovery chain in the engine lane', async () => {
    // The top-level boot recovery ran during import, before any test reset.
    assert.equal(boot.recoveries.includes('manual'), true, 'boot recovery');
    assert.equal(boot.lanes.includes('engine'), true, 'recovery took the engine lane');
    assert.equal(boot.wakes.some((wake) => wake.reason === 'manual'), true, 'boot wake');
    assert.equal(observed.queueRecovers > 0, true, 'the durable queue recovery ran');

    for (const listener of chromeListeners.onAlarm) listener({ name: 'known-bookmark-capture-recovery' });
    await vi.waitFor(() => {
      assert.equal(observed.recoveries.includes('alarm'), true, 'the alarm ran the recover path');
      assert.equal(observed.wakes.some((wake) => wake.reason === 'alarm'), true, 'the alarm woke the engine');
    });
    assert.equal(observed.lanes.includes('engine'), true,
      'the recovery alarm must run the same engine-lane recover path as startup');
  });

  test('a repeating reconciliation alarm guarantees the recovery runs eventually', async () => {
    // Every other recovery path is opportunistic: startup, a failed capture, or
    // the one-shot alarm a failure schedules. If the worker is evicted with a
    // capture in flight and nothing later schedules anything, the capture would
    // stay missing until the user restarts the browser. The repeating alarm is
    // what makes the reconciliation guaranteed rather than contingent.
    assert.equal(chromeListeners.alarmNames.includes('known-bookmark-reconcile'), true,
      'the worker must register the reconciliation alarm on boot');
    assert.equal(observed.alarmPeriods['known-bookmark-reconcile'], 180,
      'the interval must be a repeating period, not a one-shot delay');

    observed.recoveries.length = 0;
    observed.wakes.length = 0;
    for (const listener of chromeListeners.onAlarm) listener({ name: 'known-bookmark-reconcile' });
    await vi.waitFor(() => {
      assert.equal(observed.recoveries.includes('alarm'), true,
        'the reconciliation alarm must run the same recover path');
      assert.equal(observed.wakes.some((wake) => wake.reason === 'alarm'), true,
        'the reconciliation alarm must wake the engine');
    });
  });

  test('runtime.onStartup and the engine alarm request a durable engine wake', async () => {
    for (const listener of chromeListeners.onStartup) listener();
    await vi.waitFor(() => {
      assert.equal(observed.recoveries.includes('startup'), true, 'startup re-ran the recovery chain');
      assert.equal(observed.wakes.some((wake) => wake.reason === 'startup'), true, 'startup woke the engine');
    });

    for (const listener of chromeListeners.onAlarm) listener({ name: 'known-sync-engine' });
    await vi.waitFor(() => {
      assert.equal(observed.wakes.some((wake) => wake.reason === 'alarm'), true); });
  });

  test('only a trusted online event with live connectivity requests a connectivity wake', async () => {
    assert.equal(chromeListeners.online.length, 1);
    for (const listener of chromeListeners.online) listener({ isTrusted: false });
    await settle();
    assert.deepEqual(observed.wakes, []);

    for (const listener of chromeListeners.online) listener({ isTrusted: true });
    await vi.waitFor(() => {
      assert.deepEqual(observed.wakes, [{ reason: 'online', delay: 0, connectivity: true }]); });
  });

  test('the website subscription bridge registers exactly one external message listener', () => {
    assert.equal(chromeListeners.onMessageExternal.length, 1);
  });

  test('the connectivity message path responds and wakes with connectivity restored', async () => {
    assert.equal(chromeListeners.onMessage.length, 1);
    const response = respondWith();
    const handled = chromeListeners.onMessage[0]!({ kind: 'known.connectivity.online' }, sender, response.respond);
    assert.equal(handled, true);
    assert.deepEqual(await response.promise, { ok: true });
    assert.deepEqual(observed.wakes, [{ reason: 'online', delay: 0, connectivity: true }]);
  });

  test('routing rejects a foreign sender before any wake', async () => {
    const response = respondWith();
    const handled = chromeListeners.onMessage[0]!({ kind: 'known.connectivity.online' },
      { ...sender, url: 'https://evil.example/popup.html' }, response.respond);
    assert.equal(handled, false);
    await settle();
    assert.deepEqual(observed.wakes, []);
  });

  test('the engine status message is routed to the real request validator and answered', async () => {
    const response = respondWith();
    const handled = chromeListeners.onMessage[0]!({ kind: 'known.sync.engine.status' }, sender, response.respond);
    assert.equal(handled, true);
    assert.deepEqual(await response.promise, { ok: true, phase: 'idle' });
    assert.equal(observed.engineRequests, 1);
  });

  test('first-run confirm/status reinstalls listeners and wakes the engine manually', async () => {
    const { bookmarkListenerLifecycle } = await import('../src/sw/bookmarks.js');
    bookmarks.detach();
    assert.equal(bookmarkListenerLifecycle.status().listenerInstalled, false, 'listeners start detached');

    const response = respondWith();
    const handled = chromeListeners.onMessage[0]!({ kind: 'known.firstRun.status' }, sender, response.respond);
    assert.equal(handled, true);
    await response.promise;
    await settle();
    assert.deepEqual(observed.firstRunRequests, ['known.firstRun.status']);
    assert.equal(bookmarkListenerLifecycle.status().listenerInstalled, true,
      'the post-first-run path must reinstall bookmark listeners');
    assert.equal(observed.wakes.some((wake) => wake.reason === 'manual'), true);
  });

  test('a granted bookmark permission resumes bookmark events', async () => {
    assert.equal(chromeListeners.onAdded.length, 1);
    for (const listener of chromeListeners.onAdded) listener({ permissions: ['storage'] });
    await settle();
    assert.equal(observed.resumes, 0);
    for (const listener of chromeListeners.onAdded) listener({ permissions: ['bookmarks'] });
    await vi.waitFor(() => { assert.equal(observed.resumes, 1); });
  });

  test('the entry never revives the retired outbound-push alarm owner', () => {
    expect(chromeListeners.alarmNames).not.toContain('known-outbound-push');
  });

  test('the favicon clear message is validated and routed to the clear consumer', async () => {
    const response = respondWith();
    const handled = chromeListeners.onMessage[0]!(
      { kind: 'known.favicon.clear', nativeId: 'bookmark-1' }, sender, response.respond);
    assert.equal(handled, true);
    assert.deepEqual(await response.promise, { ok: true, outcome: 'cleared' });
    assert.deepEqual(observed.clears, ['bookmark-1']);
  });

  test('a favicon clear message without a native id is rejected by the validator', async () => {
    const response = respondWith();
    const handled = chromeListeners.onMessage[0]!({ kind: 'known.favicon.clear' }, sender, response.respond);
    assert.equal(handled, false);
    await settle();
    assert.deepEqual(observed.clears, []);
  });
});
