/**
 * performance-08: the worker pass reconciles tags, notes, pins and folder
 * descriptions (a whole native tree plus every mapping) only when an edit, a
 * start-up, a reconnect or a new acknowledged cursor can have changed them.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import { createExtensionWorkCoordinator } from '../src/authority-fence.js';

const scope = { environment: 'production', serverId: 'server-quiet', serverOrigin: 'https://known.example',
  accountId: 'account-quiet', browserProfileId: 'profile-quiet', collectionId: 'collection-quiet',
  replicaId: 'replica-quiet', generation: 1 };

let engine: { lastAckedCursor: string; recoveryFrozen: boolean };
let metadataResult: { staged: number; needsSnapshot: boolean };
const syncBrowserMetadata = vi.fn(async () => metadataResult);

beforeEach(() => {
  vi.resetModules();
  engine = { lastAckedCursor: 'cursor-1', recoveryFrozen: false };
  metadataResult = { staged: 0, needsSnapshot: false };
  syncBrowserMetadata.mockClear();
  const session = new Map<string, unknown>();
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  vi.stubGlobal('chrome', { alarms: { create: vi.fn(), get: async () => undefined },
    storage: { session: {
      get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
      set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) session.set(key, value); },
    } } });
  const credentials = createCredentialStore(new MemoryStorageArea());
  const syncState = {
    prunePullHistory: async () => 0, listAdvancedPlans: async () => [], getScope: async () => ({ rootStatus: 'ready' }), hasActiveMounts: async () => true,
    getEngineState: async () => ({ phase: 'sleeping', recoveryFrozen: engine.recoveryFrozen, lastAckedCursor: engine.lastAckedCursor }),
    hasRecoveryStaging: async () => false, getPendingAckIntent: async () => null, listQueue: async () => [],
    putScopeDiagnostic: async () => undefined, listImportPlans: async () => [], firstLaneQueue: async () => null,
  };
  vi.doMock('../src/sw/runtime.js', () => ({ store: credentials, syncState,
    workCoordinator: createExtensionWorkCoordinator(credentials.fence), sw: { sessionRetryNotBefore: 0 },
    hasBookmarkPermission: async () => true, extensionOrigin: () => 'chrome-extension://test',
    safeError: (error: Error) => error.message }));
  vi.doMock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope, restoredSyncScope: async () => scope,
    loadConfig: async () => ({}), pushSessionAuthority: async () => undefined, currentSyncStatusAuthority: async () => undefined }));
  vi.doMock('../src/sw/scope-rebuild.js', () => ({ replicaRebuilder: () => ({ resume: async () => undefined }) }));
  vi.doMock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn(), settled: async () => undefined },
    currentBookmarkEventQueue: async () => ({ flush: async () => undefined, recover: async () => undefined,
      captureMissingRemovals: async () => undefined }) }));
  vi.doMock('../src/durable-sync-engine.js', () => ({ createDurableSyncEngine: () => ({
    refreshPlacement: async () => 'continue',
    wake: async () => ({ phase: 'sleeping', recoveryFrozen: false }) }) }));
  vi.doMock('../src/sw/first-run.js', () => ({ resumeRunningBootstrap: async () => false }));
  vi.doMock('../src/sw/favicon.js', () => ({ drainFaviconSidecarsForCurrentScope: async () => undefined }));
  vi.doMock('../src/sw/bookmark-metadata.js', () => ({ syncBrowserMetadata }));
  vi.doMock('../src/sw/classification-local-projection.js', () => ({ refreshLocalClassificationProjection: async () => undefined }));
  vi.doMock('../src/sw/replica-health.js', () => ({ reportReplicaHealth: async () => undefined }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of ['runtime', 'scope', 'scope-rebuild', 'bookmarks', 'first-run', 'favicon', 'bookmark-metadata',
    'classification-local-projection', 'replica-health']) vi.doUnmock(`../src/sw/${path}.js`);
  vi.doUnmock('../src/durable-sync-engine.js');
  vi.resetModules();
});

async function pass(reason: 'alarm' | 'manual' | 'startup' | 'online') {
  const { runSyncEngine } = await import('../src/sw/engine.js');
  const { store } = await import('../src/sw/runtime.js');
  await runSyncEngine(reason, false, await store.fence.capture());
}

test('a quiet alarm pass skips the whole-tree metadata reconcile after a clean one', async () => {
  await pass('alarm');
  await pass('alarm');
  await pass('alarm');
  assert.equal(syncBrowserMetadata.mock.calls.length, 1, 'the first pass reconciles, later quiet alarms skip');
  await pass('manual');
  assert.equal(syncBrowserMetadata.mock.calls.length, 2, 'a local edit wakes a manual pass that always reconciles');
  engine.lastAckedCursor = 'cursor-2';
  await pass('alarm');
  assert.equal(syncBrowserMetadata.mock.calls.length, 3, 'a new acknowledged cursor can carry remote metadata');
  await pass('alarm');
  assert.equal(syncBrowserMetadata.mock.calls.length, 3);
});

test('a pass that staged metadata or failed keeps the next alarm reconciling', async () => {
  metadataResult = { staged: 2, needsSnapshot: false };
  await pass('alarm');
  await pass('alarm');
  assert.equal(syncBrowserMetadata.mock.calls.length, 2);
  syncBrowserMetadata.mockRejectedValueOnce(new Error('metadata_target_changed'));
  metadataResult = { staged: 0, needsSnapshot: false };
  await pass('alarm');
  await pass('alarm');
  await pass('alarm');
  assert.equal(syncBrowserMetadata.mock.calls.length, 4, 'only the clean fourth pass lets the fifth skip');
});

test('a pass that lifted a recovery freeze reconciles even at the same cursor', async () => {
  await pass('alarm');
  engine.recoveryFrozen = true;
  await pass('alarm');
  assert.equal(syncBrowserMetadata.mock.calls.length, 2);
});
