import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { storageStopProjection } from '../src/sw/storage-attention.js';
import { handleSyncAttentionRequest, type SyncAttentionStore } from '../src/sw/sync-attention.js';
import { DATABASE_NAME, DATABASE_VERSION, createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { json } from './durable-sync-engine-harness.js';
import { failingFactory, seedDatabase, storageScope } from './sync-storage-fixtures.js';

/**
 * W2A-01: a sync database that cannot be used (written by a newer extension, missing a store, a failing
 * backing store) made every read throw, so Status said "state unavailable" and the popup, unable to tell that
 * from "nothing set up", showed "Sync is off" and the first-sync card. The state is now told apart by cause
 * and Status answers with it.
 */
const scope = storageScope;

describe('the sync database state is told apart by cause', () => {
  test('a database that works is ok', async () => {
    const store = createSyncStateStore({ indexedDB: new IDBFactory() });
    assert.deepEqual(await store.storageState(), { state: 'ok' });
    store.close();
  });

  test('a database written by a newer extension is newer_version (future_schema)', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1);
    const store = createSyncStateStore({ indexedDB: factory });
    assert.deepEqual(await store.storageState(), { state: 'newer_version', code: 'future_schema' });
  });

  test('a database of this version that lacks a store is read_only (diagnostic_read_only)', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION);
    const store = createSyncStateStore({ indexedDB: factory });
    assert.deepEqual(await store.storageState(), { state: 'read_only', code: 'diagnostic_read_only' });
    store.close();
  });

  test('an upgrade that aborted is upgrade_failed', async () => {
    const store = createSyncStateStore({ indexedDB: new IDBFactory(), injectUpgradeFailure: true });
    assert.deepEqual(await store.storageState(), { state: 'upgrade_failed', code: 'upgrade_failed' });
  });

  test('a failing backing store and a full disk are unavailable, each with its own code', async () => {
    assert.deepEqual(await createSyncStateStore({ indexedDB: failingFactory('UnknownError') }).storageState(),
      { state: 'unavailable', code: 'storage_unavailable' });
    assert.deepEqual(await createSyncStateStore({ indexedDB: failingFactory('QuotaExceededError') }).storageState(),
      { state: 'unavailable', code: 'quota_exceeded' });
  });

  test('forgetting the storage drops the sticky flags, so a recreated database is usable again', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION);
    const store = createSyncStateStore({ indexedDB: factory });
    assert.equal((await store.storageState()).state, 'read_only');
    await new Promise<void>((resolve, reject) => { const request = factory.deleteDatabase(DATABASE_NAME);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    store.forgetStorage();
    assert.deepEqual(await store.storageState(), { state: 'ok' });
    store.close();
  });
});

describe('Status answers with the readable state instead of "unavailable"', () => {
  test('a newer database is a terminal, readable state with the reset as its exit', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1);
    const store = createSyncStateStore({ indexedDB: factory });
    const response = await handleSyncAttentionRequest({ scope: async () => scope, store, readableFailure: true });
    assert.equal(response.ok, true); if (!response.ok) return;
    const attention = response.attention;
    assert.equal(attention.storageState, 'newer_version');
    assert.equal(attention.lastError, 'future_schema');
    assert.equal(attention.terminal, true);
    assert.equal(attention.retryAutomatic, false);
    assert.equal(attention.storageResetAvailable, true);
    assert.equal(attention.rebuildAvailable, false, 'the extension-side rebuild needs the very database that cannot be read');
    assert.equal(attention.issueCount, 1);
    assert.deepEqual(attention.issues, [{ direction: 'local', code: 'future_schema', rootCause: 'newer_version' }]);
  });

  test('the report to the Sync center does not opt in: it keeps its own wording for an unusable store', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1);
    const store = createSyncStateStore({ indexedDB: factory });
    assert.deepEqual(await handleSyncAttentionRequest({ scope: async () => scope, store }), { ok: false, error: 'state_unavailable' });
  });

  test('without a Session the scope itself cannot be read; that is the storage state too, not "not connected"', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1);
    const store = createSyncStateStore({ indexedDB: factory });
    const response = await handleSyncAttentionRequest({ scope: async () => { throw new Error('future_schema'); }, store, readableFailure: true });
    assert.equal(response.ok, true); if (!response.ok) return;
    assert.equal(response.attention.storageState, 'newer_version');
  });

  test('a signed-out browser is still just not connected', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1);
    const store = createSyncStateStore({ indexedDB: factory });
    assert.deepEqual(await handleSyncAttentionRequest({ scope: async () => { throw new Error('not_connected'); }, store, readableFailure: true }),
      { ok: false, error: 'not_connected' });
  });

  test('a storage hiccup retries by itself and is not terminal', async () => {
    const store = createSyncStateStore({ indexedDB: failingFactory('UnknownError') });
    const response = await handleSyncAttentionRequest({ scope: async () => scope, store, readableFailure: true });
    assert.equal(response.ok, true); if (!response.ok) return;
    assert.deepEqual([response.attention.storageState, response.attention.lastError, response.attention.terminal,
      response.attention.retryAutomatic, response.attention.retryAvailable, response.attention.storageResetAvailable],
    ['unavailable', 'storage_unavailable', false, true, true, true]);
  });

  test('a signed-in browser whose scope is not registered yet is setup, not damage: still "unavailable"', async () => {
    const store = createSyncStateStore({ indexedDB: new IDBFactory() });
    assert.deepEqual(await handleSyncAttentionRequest({ scope: async () => scope, store, readableFailure: true }),
      { ok: false, error: 'state_unavailable' });
    store.close();
  });

  test('a record that cannot be read (B-09) still shows the card and the Reset instead of "unavailable"', async () => {
    const broken = async () => { throw new Error('record_invalid'); };
    const store = { getScope: broken, getEngineState: broken, listQueue: broken, storageState: async () => ({ state: 'ok' as const }) };
    const response = await handleSyncAttentionRequest({ scope: async () => scope, store: store as unknown as SyncAttentionStore, readableFailure: true });
    assert.equal(response.ok, true); if (!response.ok) return;
    const attention = response.attention;
    assert.equal(attention.lastError, 'record_invalid');
    assert.equal(attention.rebuildAvailable, true);
    assert.equal(attention.rebuildMode, 'server_fenced');
    assert.deepEqual(attention.issues, [{ direction: 'local', code: 'record_invalid', rootCause: 'state_unreadable' }]);
    assert.equal(attention.storageState, undefined, 'the database itself works');
  });

  test('a read that failed once and works again is left as unavailable, not turned into a state', async () => {
    let calls = 0;
    const real = createSyncStateStore({ indexedDB: new IDBFactory() });
    await real.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
      checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [] });
    const store = { ...real, getScope: async (input: SyncScope) => { if (calls++ === 0) throw new Error('transaction_aborted'); return real.getScope(input); } };
    const response = await handleSyncAttentionRequest({ scope: async () => scope, store: store as unknown as SyncAttentionStore, readableFailure: true });
    // The first read fails once; the repair capability then reads fine, so nothing is claimed about the state.
    assert.deepEqual(response, { ok: false, error: 'state_unavailable' });
    real.close();
  });
});

describe('the Sync center is told why, and is not offered a Rebuild that cannot work', () => {
  test('storageStopProjection names the cause and offers nothing', async () => {
    assert.deepEqual(await storageStopProjection({ storageState: async () => ({ state: 'newer_version', code: 'future_schema' }) }),
      { state: 'stopped', code: 'future_schema', issues: { total: 0, items: [] }, actions: [] });
    assert.equal(await storageStopProjection({ storageState: async () => ({ state: 'ok' }) }), undefined);
    assert.equal(await storageStopProjection({}), undefined);
    assert.equal(await storageStopProjection({ storageState: async () => { throw new Error('x'); } }), undefined);
  });

  test('the report of a browser whose database is unusable says future_schema, not "diagnostics unavailable"', async () => {
    const factory = new IDBFactory(); await seedDatabase(factory, DATABASE_VERSION + 1);
    const store = createSyncStateStore({ indexedDB: factory });
    const reports: Array<Record<string, unknown>> = [];
    const outcome = await sendReplicaHealthReport({ scope, store: store as never, storage: new MemoryStorageArea(),
      origin: 'chrome-extension://known', mode: async () => 'enabled', extensionVersion: '0.2.0', now: () => 1_700_000_000_000,
      commands: { replica: async () => ({ outcome: 'failed' }), serverRebuild: async () => ({ outcome: 'failed' }),
        issue: async () => ({ outcome: 'failed' }) },
      credential: async () => ({ accessToken: 'token', serverOrigin: scope.serverOrigin, subject: scope.accountId }),
      fetch: async (_url, init) => { reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(200, { accepted: true, replicaId: scope.replicaId, revision: reports.at(-1)!.revision, commands: [] }); } });
    assert.equal(outcome, 'sent');
    assert.equal(reports[0]!.state, 'stopped');
    assert.equal(reports[0]!.code, 'future_schema');
    assert.deepEqual(reports[0]!.actions, [], 'Rebuild needs the same database');
  });
});
