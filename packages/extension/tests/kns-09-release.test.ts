/**
 * Owner: KNS-09 (Release). Fixture: tests/fixtures/kns-09-rollback-drill.json.
 * Run: npx vitest run tests/kns-09-release.test.ts
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { confirmAddRange, executeRemoteDelete, mintRemoteDeleteConfirmation } from '../src/scope-commands.js';
import {
  DATABASE_NAME, DATABASE_VERSION, createSyncStateStore, type SyncScope,
} from '../src/sync-state-store.js';
import {
  KNS09_DEFAULT_MUTATIONS, KNS09_METRICS, KNS09_SCHEMA_VERSION, KNS09_STOP_METRICS,
  diagnoseKns09Fault, kns09Locator, kns09Paused, loadKns09MutationSwitches, locatorHash,
  observeKns09EngineWake, observeKns09PushReceipt, recordKns09FirstRun, recordKns09MergeAttention,
  recordKns09PermissionRevoked, recordKns09Stop, resetKns09MetricsForTests,
  resumeKns09Mutations, setKns09MutationSwitchesForTests, snapshotKns09Metrics, type Kns09FaultFixture,
} from '../src/kns-09-release.js';
import { KNS09_METRICS_STORAGE_KEY, persistKns09Metrics } from '../src/kns-09-metrics.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-kns09', serverOrigin: 'https://known.example',
  accountId: 'account-kns09', browserProfileId: 'profile-kns09', collectionId: 'collection-kns09',
  replicaId: 'replica-kns09', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => {
  indexedDB = new IDBFactory();
  resetKns09MetricsForTests();
  setKns09MutationSwitchesForTests();
});
afterEach(() => { setKns09MutationSwitchesForTests(); resetKns09MetricsForTests(); });

describe('KNS-09 metrics and rollback', () => {
  test('hashes locators and never stores URL, title, or raw ids', () => {
    const locator = kns09Locator(scope);
    assert.match(locator.collectionHash, /^[0-9a-f]{16}$/u);
    assert.match(locator.replicaHash, /^[0-9a-f]{16}$/u);
    assert.notEqual(locator.collectionHash, scope.collectionId);
    assert.notEqual(locator.replicaHash, scope.replicaId);
    recordKns09FirstRun('completed', scope);
    recordKns09MergeAttention(scope, 2, 1);
    recordKns09PermissionRevoked(scope);
    recordKns09Stop('duplicateNode', scope);
    observeKns09EngineWake({
      scope, frozenBefore: true, frozenAfter: false, pendingCount: 1, backlogAgeMs: 40, lastError: undefined,
    });
    observeKns09PushReceipt(scope, { retry: { attempt: 0, notBefore: Date.now() - 12 } });
    const snap = snapshotKns09Metrics();
    const text = JSON.stringify(snap);
    assert.doesNotMatch(text, /https?:\/\//u);
    assert.doesNotMatch(text, /collection-kns09|replica-kns09|account-kns09/u);
    assert.doesNotMatch(text, /Bookmarks bar|secret-title/u);
    assert.equal(snap.counters[`${KNS09_METRICS.firstRun}.completed`], 1);
    assert.equal(snap.counters[KNS09_METRICS.duplicateCandidate], 2);
    assert.equal(snap.counters[KNS09_METRICS.conflict], 1);
    assert.equal(snap.counters[KNS09_METRICS.pullRecovery], 1);
    assert.equal(snap.locators[0]?.collectionHash, locator.collectionHash);
    assert.equal(locatorHash('https://example.test/secret-title'), locatorHash('https://example.test/secret-title'));
  });

  test('mutation switches default on and pause coordinator plus UI writes', async () => {
    assert.deepEqual(await loadKns09MutationSwitches(), KNS09_DEFAULT_MUTATIONS);
    const store = await activeStore();
    await seedMount(store);
    setKns09MutationSwitchesForTests({ coordinator: false, ui: false });
    await store.putScopePreview(scope, {
      previewId: 'preview-paused', boundaryVersion: '1', treeDigest: 'sha256:tree',
      bookmarkCount: 1, folderCount: 1, skippedCount: 0, expiresAt: Date.now() + 60_000, warnings: [],
      boundary: { selectedNativeIds: ['bar'], excludedNativeIds: [], mounts: [] },
    });
    const queuedBefore = await enqueuePending(store);
    const confirm = await confirmAddRange(store, scope, {
      previewId: 'preview-paused', confirmationId: 'confirm-paused', treeDigest: 'sha256:tree',
      localFacts: [{ nativeId: 'bm-new', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
        title: 'Paused', url: 'https://example.test/paused' }],
    });
    assert.equal(confirm.ok, false);
    if (!confirm.ok) assert.equal(confirm.error, 'sync_paused');
    const token = mintRemoteDeleteConfirmation({ mountId: 'mount-bar', affectedCount: 1, boundaryVersion: '1' });
    const deleted = await executeRemoteDelete(store, scope, {
      mountId: 'mount-bar', confirmationToken: token, affectedCount: 1,
    });
    assert.equal(deleted.ok, false);
    if (!deleted.ok) assert.equal(deleted.error, 'sync_paused');
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.opId, queuedBefore.opId);
    assert.equal(queued.some((row) => row.payload.type === 'delete_node'), false);
    recordKns09FirstRun('paused', scope);
    assert.equal(snapshotKns09Metrics().counters[`${KNS09_METRICS.firstRun}.paused`], 1);
  });

  test('resume durably clears the out-of-scope stop gate even before metrics hydration', async () => {
    const saved: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { local: {
      get: async (key: string) => ({ [key]: structuredClone(saved[key]) }),
      set: async (items: Record<string, unknown>) => { Object.assign(saved, structuredClone(items)); },
    } } });
    const persistedCounters = () => (saved[KNS09_METRICS_STORAGE_KEY] as
      { counters: Record<string, number> }).counters;
    try {
      recordKns09Stop('outOfScopeUpload', scope);
      await persistKns09Metrics();
      assert.equal(persistedCounters()[KNS09_STOP_METRICS.outOfScopeUpload], 1);
      // A restarted worker has the stop counter on disk but has not hydrated
      // durable metrics yet; resuming before any kns09Paused call must not
      // resurrect the persisted counter through the restore-merge.
      resetKns09MetricsForTests();
      assert.equal(await kns09Paused('ingress'), true);
      resetKns09MetricsForTests();
      await resumeKns09Mutations();
      assert.equal(await kns09Paused('ingress'), false);
      assert.equal(persistedCounters()[KNS09_STOP_METRICS.outOfScopeUpload], undefined);
    } finally { vi.unstubAllGlobals(); }
  });

  test('offline claimed row reclaims on a new fence and refuses a v9 open', async () => {
    const store = await activeStore();
    const item = await enqueuePending(store);
    const first = await store.acquireLease(scope, 'worker-hang', 1, 30_000);
    const claimed = await store.claimNextQueue(scope, 'worker-hang', first.fence, 1);
    assert.equal(claimed?.opId, item.opId);
    const replacement = await store.acquireLease(scope, 'worker-hang', 2, 30_000);
    const reclaimed = await store.claimNextQueue(scope, 'worker-hang', replacement.fence, 2);
    assert.equal(reclaimed?.opId, item.opId);
    assert.equal(reclaimed?.retry.fence, replacement.fence);
    const exported = await store.exportScope(scope);
    assert.equal(exported.queue.length, 1);
    assert.equal(exported.queue[0]?.status, 'claimed');
    assert.equal(exported.receipts.length, 0);
    assert.equal(exported.queue.filter((row) => row.payload.type === 'delete_node').length, 0);
    assert.equal(DATABASE_VERSION, KNS09_SCHEMA_VERSION);
    const downgrade = indexedDB.open(DATABASE_NAME, 9);
    await assert.rejects(() => requestValue(downgrade), (error: unknown) => {
      assert.equal((error as Error).name, 'VersionError');
      return true;
    });
  });

  test('fault fixture diagnosis matches the runbook conclusion', async () => {
    const raw = JSON.parse(await readFile(join(packageRoot, 'tests/fixtures/kns-09-rollback-drill.json'), 'utf8')) as
      Kns09FaultFixture;
    const diagnosis = diagnoseKns09Fault(raw);
    assert.equal(diagnosis.readableSchema, true);
    assert.equal(diagnosis.rollbackBinary, 'keep-v23');
    assert.equal(diagnosis.drainSafe, true);
    assert.equal(diagnosis.silentDelete, false);
    assert.equal(diagnosis.duplicatePushRisk, false);
    assert.equal(diagnosis.stopExpansion, false);
    assert.equal(diagnosis.conclusion, 'pause_mutations_and_drain');
    const priorSchema = diagnoseKns09Fault({ ...raw, databaseVersion: KNS09_SCHEMA_VERSION - 1 });
    assert.equal(priorSchema.readableSchema, false);
    assert.equal(priorSchema.rollbackBinary, 'do-not-install-older');
    const v9 = diagnoseKns09Fault({ ...raw, databaseVersion: 9 });
    assert.equal(v9.readableSchema, false);
    assert.equal(v9.rollbackBinary, 'do-not-install-older');
    assert.equal(v9.conclusion, 'refuse_v9_binary');
  });
});

async function activeStore() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-kns09', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], rootStatus: 'ready',
  });
  return store;
}

async function seedMount(store: ReturnType<typeof createSyncStateStore>) {
  await store.putMountBinding(scope, {
    mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: 'remote-bar', boundaryVersion: '1',
    materialized: false, status: 'active', rootRole: 'bookmarks-bar',
  });
  await store.putMapping(scope, {
    nativeId: 'bar', colpId: 'remote-bar', rootNativeId: 'bar', mountId: 'mount-bar', nodeKind: 'folder',
    projection: { revision: 'r-bar', digest: 'sha256:bar', content: { title: 'Bar' } },
  });
  await store.putMapping(scope, {
    nativeId: 'bm-1', colpId: 'colp-bm-1', rootNativeId: 'bar', mountId: 'mount-bar', parentNativeId: 'bar',
    nodeKind: 'bookmark', projection: { revision: 'r-bm', digest: 'sha256:bm',
      content: { title: 'One', url: 'https://example.com/one' } },
  });
}

async function enqueuePending(store: ReturnType<typeof createSyncStateStore>) {
  return store.allocateSequenceAndEnqueue(scope, {
    opId: 'op-kns09-pending', batchId: 'batch-kns09-pending', idempotencyKey: 'key-kns09-pending',
    digest: 'sha256:op-kns09-pending', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: null, operationRevision: 'local-op-kns09-pending', status: 'pending',
    retry: { attempt: 0, notBefore: 0 },
    payload: {
      opId: 'op-kns09-pending', replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
      type: 'create_node',
    },
  }, { allowUnstamped: true });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
