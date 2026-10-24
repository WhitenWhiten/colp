import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { collectSyncDiagnostics } from '../src/sync-diagnostics.js';
import { HEALTH_STORAGE_KEY } from '../src/sw/replica-health-delivery.js';
import { createSyncWatchdog, readWatchdogFacts } from '../src/sw/sync-watchdog.js';

/**
 * C-18: Copy details (the Help diagnostic) says what the Status card says. It used
 * to leave out the breaker, the reports the server never got, and when sync last
 * worked, so the two surfaces told different stories about the same browser.
 * Times and codes only: never an operation id, a title or an address.
 */
const holder = vi.hoisted(() => ({ store: undefined as unknown, scope: undefined as unknown }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: new Proxy({}, { get: (_target, key) => (holder.store as Record<PropertyKey, unknown>)[key] }) }));
vi.mock('../src/sw/scope.js', () => ({
  currentSyncScope: async () => { if (!holder.scope) throw new Error('not_connected'); return holder.scope; },
}));
vi.mock('../src/sw/sync-progress.js', () => ({ handleSyncProgressRequest: async () => ({ ok: false, error: 'not_connected' }) }));
vi.mock('../src/sw/capture-control.js', () => ({ captureRuntimeView: async () => ({ state: 'ready' }) }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => ({ accountId: 'account' }), assertCaptureOwner: async () => undefined }));
vi.mock('../src/sw/capture.js', () => ({ captureStore: { listForOwner: async () => [] } }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({
  handleBookmarkPreferencesRequest: async () => ({ ok: true, preferences: {}, pending: 0, conflict: false }),
}));
vi.mock('../src/capture/control.js', () => ({ readCaptureControl: async () => ({ paused: false }) }));

const MIN = 60_000;
const T0 = Date.parse('2026-10-24T09:00:00.000Z');
const scope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example', accountId: 'account',
  browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica-1', generation: 1 } as never;
const identity = JSON.stringify(['https://known.example', 'server', 'account', 'profile', 'collection', 'replica-1', 1]);

function fakeStore(engine: Record<string, unknown> | undefined) {
  return { getEngineState: async () => engine, getScope: async () => ({ firstRun: 'completed' }), listBootstrapRuns: async () => [],
    getRecoveryHeader: async () => null, listAckIntents: async () => [], listProjectionIntents: async () => [], listQueue: async () => [] } as never;
}
const stopped = { phase: 'error', updatedAt: T0, recoveryFrozen: false, authorityRefreshRequired: false, notBefore: T0 + 20 * MIN,
  lastError: 'bookmark_api_error', circuitBreaker: { progress: 'p', failures: [], trips: 3, retryAt: T0 + 20 * MIN } };

describe('the diagnostic carries the circuit breaker', () => {
  test('trips and the time it tries again, as Status says them', async () => {
    const diagnostic = await collectSyncDiagnostics(fakeStore(stopped), scope);
    assert.deepEqual(diagnostic.breaker, { trips: 3, deadline: T0 + 20 * MIN });
    assert.equal(diagnostic.engine.errorCode, 'bookmark_api_error');
  });

  test('a calm engine reports no trips and no deadline', async () => {
    const diagnostic = await collectSyncDiagnostics(fakeStore({ phase: 'sleeping', updatedAt: T0, recoveryFrozen: false,
      authorityRefreshRequired: false, notBefore: 0 }), scope);
    assert.deepEqual(diagnostic.breaker, { trips: 0, deadline: null });
  });
});

describe('the watchdog facts for a diagnostic', () => {
  test('times and a kind, never the operation at the head or its title', async () => {
    const local = new MemoryStorageArea();
    await local.set({ 'known.sync.watchdog.v1': { replicaId: 'replica-1', marker: { version: 1, lastPassAt: T0 - 5 * MIN,
      head: { opId: 'PRIVATE-OP-ID', since: T0 - 30 * MIN }, suspect: { kind: 'stuck', since: T0 - 12 * MIN } } } });
    const facts = await readWatchdogFacts(local, scope);
    assert.deepEqual(facts, { lastSyncedAt: T0 - 5 * MIN, oldestUploadUnmovedSince: T0 - 30 * MIN, suspect: { kind: 'stuck', since: T0 - 12 * MIN } });
    assert.doesNotMatch(JSON.stringify(facts), /PRIVATE/u);
  });

  test('nothing for another replica, an unreadable marker or no marker', async () => {
    const local = new MemoryStorageArea();
    assert.equal(await readWatchdogFacts(local, scope), undefined);
    await local.set({ 'known.sync.watchdog.v1': { replicaId: 'someone-else', marker: { version: 1 } } });
    assert.equal(await readWatchdogFacts(local, scope), undefined);
    assert.equal(await readWatchdogFacts({ get: async () => { throw new Error('storage_unavailable'); } }, scope), undefined);
  });

  test('is what the watchdog wrote, so Status and Copy details read one record', async () => {
    const local = new MemoryStorageArea(); let clock = T0;
    const watchdog = createSyncWatchdog({ local, session: new MemoryStorageArea(), now: () => clock,
      head: async () => ({ opId: 'PRIVATE-OP-ID', payload: { type: 'create_node', targetId: 'x', occurredAt: '2026-10-24T08:00:00.000Z',
        payload: { node: { kind: 'bookmark', title: 'PRIVATE TITLE' } } } }) as never });
    await watchdog.sample({ scope, engine: { phase: 'sleeping', updatedAt: T0 - MIN } as never, explained: false });
    clock += 2 * MIN;
    const result = await watchdog.sample({ scope, engine: { phase: 'sleeping', updatedAt: T0 - MIN } as never, explained: false });
    const facts = await readWatchdogFacts(local, scope);
    assert.equal(facts?.lastSyncedAt, result?.lastSyncedAt);
    assert.equal(facts?.oldestUploadUnmovedSince, T0);
    assert.doesNotMatch(JSON.stringify(facts), /PRIVATE/u);
  });
});

describe('Copy details as a whole', () => {
  let storage = new MemoryStorageArea();
  beforeEach(() => {
    storage = new MemoryStorageArea();
    holder.scope = scope;
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('chrome', { permissions: { contains: async () => true }, storage: { local: storage } });
  });
  afterEach(() => { vi.unstubAllGlobals(); holder.store = undefined; holder.scope = undefined; });

  async function diagnostic() {
    const { captureDiagnostics } = await import('../src/sw/capture-diagnostics.js');
    return (await captureDiagnostics()).diagnostic as unknown as Record<string, any>;
  }

  test('names the breaker, the reports the server never got and when sync last worked', async () => {
    holder.store = fakeStore(stopped);
    const failed = { code: 'health_http_503', since: Date.now() - 30 * MIN, at: Date.now() - MIN };
    await storage.set({ [HEALTH_STORAGE_KEY]: { version: 2, records: { [identity]: { scope, value: { failed }, updatedAt: Date.now() } } } });
    await storage.set({ 'known.sync.watchdog.v1': { replicaId: 'replica-1', marker: { version: 1, lastPassAt: T0 - 5 * MIN } } });
    const copied = await diagnostic();
    assert.deepEqual(copied.sync.breaker, { trips: 3, deadline: T0 + 20 * MIN });
    assert.deepEqual(copied.syncHealth.reportsFailing, { code: 'health_http_503', since: failed.since });
    assert.equal(copied.syncHealth.lastSyncedAt, T0 - 5 * MIN);
    assert.doesNotMatch(JSON.stringify(copied), /serverOrigin|accessToken|known\.example/u);
  });

  test('says nothing about reports or the watchdog when there is nothing to say, and still answers', async () => {
    holder.store = fakeStore({ phase: 'sleeping', updatedAt: T0, recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0 });
    const copied = await diagnostic();
    assert.deepEqual(copied.syncHealth, { reportsFailing: null });
    assert.equal(copied.sync.engine.phase, 'sleeping');
  });

  test('still answers when the sync store cannot be read', async () => {
    holder.scope = undefined;
    holder.store = fakeStore(undefined);
    const copied = await diagnostic();
    assert.equal(copied.sync, null);
    assert.equal(copied.syncHealth.reportsFailing, null);
  });
});
