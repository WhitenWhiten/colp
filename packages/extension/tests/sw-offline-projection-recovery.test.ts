import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test, vi } from 'vitest';
import { createExtensionWorkCoordinator } from '../src/authority-fence.js';
import { parseBuildConfig } from '../src/config.js';
import { createCredentialStore, MemoryStorageArea } from '../src/credential-store.js';
import { credentialAuthorityDigest } from '../src/session-client.js';
import type { StoredSession } from '../src/types.js';
import { ack, json, nonemptyMountSnapshot, emptyPullPage, scope, setup } from './durable-sync-engine-harness.js';

function eventPort<T>() {
  const listeners = new Set<T>();
  return { listeners, addListener: (listener: T) => { listeners.add(listener); },
    hasListener: (listener: T) => listeners.has(listener) };
}

async function offlineWorker() {
  vi.resetModules();
  const fixture = await setup({ snapshotRequired: true, emptyCollection: true,
    useVerifiedProjector: true, seedMount: false });
  const snapshot = nonemptyMountSnapshot(true);
  Object.assign(snapshot.nodes[2]!, { extensions: { 'https://example.test/annotation': { label: 'retained metadata' } } });
  fixture.snapshotResponses.push(json(200, snapshot));
  fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
  fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
  await fixture.engine.wake('startup');
  fixture.clock.now += 2_000;
  fixture.pullResponses.push(json(200, emptyPullPage('cursor-ordinary')));
  fixture.ackResponses.push(json(200, ack('cursor-ordinary')));
  await fixture.engine.wake('manual');
  await fixture.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: '1',
    remoteMountNodeId: 'mount-bar', boundaryVersion: '1', materialized: false,
    status: 'active', rootRole: 'bookmarks-bar' });
  fixture.crashAt = 'after_local_projection';
  await assert.rejects(() => fixture.engine.wake('manual'), /worker_crash/);
  const record = (await fixture.store.getScope(scope))!;
  await fixture.store.registerScope({ ...record, firstRun: 'completed' });

  const storage = new MemoryStorageArea(); const credentials = createCredentialStore(storage);
  const context = await credentials.fence.capture();
  const workCoordinator = createExtensionWorkCoordinator(credentials.fence);
  const config = parseBuildConfig(JSON.parse(await readFile('config/e2e-fixture.json', 'utf8')));
  const credential = { accessToken: 'offline-test-credential', tokenType: 'Bearer' as const,
    expiresAt: Date.now() + 3_600_000, scope: config.scopes, issuer: config.issuer,
    audience: config.audience, clientId: config.clientId, serverOrigin: config.serverOrigin,
    subject: scope.accountId, accountLabel: 'Offline test' };
  const session: StoredSession = { credentialAuthorityDigest: await credentialAuthorityDigest(credential.accessToken),
    sessionId: fixture.sessionId, expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
    acceptedProtocolVersion: '0.2', snapshotRequired: false,
    collection: { collectionId: scope.collectionId, serverCursor: 'cursor-ordinary', serverRevision: 'r1' },
    replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
    conversionPolicy: { separator: 'preserve_remote' } };
  await credentials.saveCredential(credential); await credentials.saveSession(session);
  const changed = eventPort<(id: string, changes: { title: string }) => void>();
  const bookmarks = {
    onCreated: eventPort<unknown>(), onChanged: changed, onMoved: eventPort<unknown>(), onRemoved: eventPort<unknown>(),
    get: async (id: string) => { const node = fixture.chromeNodes.get(id); return node ? [{ ...node }] : []; },
    getChildren: async (id: string) => [...fixture.chromeNodes.values()].filter((node) => node.parentId === id)
      .map((node) => ({ ...node })),
  };
  const alarms = vi.fn();
  const errors: unknown[] = [];
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  vi.stubGlobal('chrome', { bookmarks, alarms: { create: alarms }, storage: { local: storage },
    runtime: { id: config.extensionId }, tabs: { create: vi.fn() } });
  const fetcher = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
  const permission = { allowed: true };
  vi.stubGlobal('fetch', fetcher);
  vi.doMock('../src/sw/runtime.js', () => ({
    store: credentials, syncState: fixture.store, workCoordinator,
    sw: { configPromise: Promise.resolve(config), sessionRetryNotBefore: 0 },
    extensionOrigin: () => `chrome-extension://${config.extensionId}`,
    rootScopeKey: () => JSON.stringify(scope), hasBookmarkPermission: async () => permission.allowed,
    BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery', COLLECTION_BINDING: 'known.sync.collection.v1',
    faviconSidecar: { list: async () => [], prune: async () => 0 }, safeError: (error: unknown) => { errors.push(error); return 'network_unavailable'; },
  }));
  vi.doMock('../src/sw/scope.js', async () => ({
    ...await vi.importActual<typeof import('../src/sw/scope.js')>('../src/sw/scope.js'),
    currentSyncScope: async () => scope,
    restoredSyncScope: async () => scope,
  }));
  const worker = await import('../src/sw/bookmarks.js');
  const engine = await import('../src/sw/engine.js');
  const authority = await import('../src/sw/scope.js');
  worker.bookmarkListenerLifecycle.install();
  return { fixture, credentials, credential, session, config, permission, workCoordinator, context, worker, engine, authority,
    changed, fetcher, alarms, errors };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

test('valid cached Session authority needs no manifest request while offline', async () => {
  const f = await offlineWorker();
  try {
    const actual = await f.authority.pushSessionAuthority();
    assert.equal(actual.session.sessionId, f.session.sessionId);
    assert.equal(f.fetcher.mock.calls.length, 0);
  } finally { f.fixture.store.close(); }
});

test('offline status exposes a terminal recovery reason without refreshing the network', async () => {
  const f = await offlineWorker();
  try {
    const state = (await f.fixture.store.getEngineState(scope))!;
    await f.fixture.store.transitionEngine(scope, { ...state, lastError: 'legacy_resolution_sequence_collision',
      recoveryFrozen: true, phase: 'recovery', updatedAt: Date.now() });
    const response = await f.engine.publicSyncEngineState(scope, f.credential, f.session, f.config);
    assert.equal(response.recoveryFrozen, true);
    assert.equal(response.errorCode, 'legacy_resolution_sequence_collision');
    const { lastError: _error, localProjectionOwner: _owner, ...healthy } = state;
    await f.fixture.store.transitionEngine(scope, { ...healthy, phase: 'sleeping', recoveryFrozen: false,
      lastPublishedCursor: 'cursor-done', lastAckedCursor: 'cursor-done', lastPushServerCursor: 'sync-update-3', notBefore: 0 });
    const status = () => f.engine.publicSyncEngineState(scope, f.credential, f.session, f.config);
    const ready = await status();
    assert.equal(ready.cursorsConverged, true);
    assert.equal(ready.hasPushServerCursor, true);
    assert.equal(ready.sessionReady, true);
    const sessionless = await f.engine.publicSyncEngineState(scope, f.credential, null, f.config);
    assert.equal(sessionless.sessionReady, false);
    assert.equal(sessionless.scopeKey, ready.scopeKey);
    assert.equal(sessionless.credentialReady, true);
    await f.workCoordinator.run('engine', async () => { assert.equal((await status()).engineWakeInFlight, true); });
    f.permission.allowed = false;
    assert.equal((await status()).listenerInstalled, false);
    for (const credential of [{ ...f.credential, subject: 'other-account' }, { ...f.credential, scope: [] },
      { ...f.credential, expiresAt: 0 }]) {
      const invalid = await f.engine.publicSyncEngineState(scope, credential, f.session, f.config);
      assert.equal(invalid.credentialReady, false); assert.equal(invalid.sessionReady, false);
    }
    for (const session of [{ ...f.session, expiresAt: '2020-01-01T00:00:00Z' },
      { ...f.session, acceptedProtocolVersion: undefined },
      { ...f.session, collection: { ...f.session.collection, collectionId: 'other-collection' } }]) {
      assert.equal((await f.engine.publicSyncEngineState(scope, f.credential, session, f.config)).sessionReady, false);
    }
    assert.equal((await f.engine.publicSyncEngineState({ ...scope, generation: 2 }, f.credential, f.session, f.config)).phase, 'idle');
    assert.equal(f.fetcher.mock.calls.length, 0);
    await f.credentials.clearCredential();
    assert.deepEqual(await f.engine.handleSyncEngineRequest(), { ok: false, error: 'not_connected' });
  } finally { f.fixture.store.close(); }
});

test('real worker unfreezes its completed local projection and captures one offline edit without a wake loop', async () => {
  const f = await offlineWorker();
  try {
    const mapping = (await f.fixture.store.getMappingByColpId(scope, 'child-a'))!;
    const native = f.fixture.chromeNodes.get(mapping.nativeId)!;
    f.fixture.chromeNodes.set(mapping.nativeId, { ...native, title: 'Local edit during freeze' });
    for (const listener of f.changed.listeners) listener(mapping.nativeId, { title: 'Local edit during freeze' });
    await f.worker.bookmarkListenerLifecycle.settled();
    // Capture may admit the event or defer it while frozen. The invariant below
    // is one durable edit after recovery, independent of that transient route.
    await f.engine.scheduleSyncEngineWake('alarm');
    await f.workCoordinator.drain();
    const state = (await f.fixture.store.getEngineState(scope))!;
    assert.equal(state.recoveryFrozen, false);
    assert.equal(state.localProjectionOwner, undefined);
    assert.equal(state.phase, 'offline');
    assert.deepEqual(f.errors, []);
    const pending = await f.fixture.store.listQueue(scope, 'pending', 0, 10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.payload.type, 'update_node_content');
    assert.match(JSON.stringify(pending[0]!.payload), /Local edit during freeze/);
    assert.match(JSON.stringify(await f.fixture.store.getMappingByColpId(scope, 'child-a')), /retained metadata/);
    assert.equal(f.fetcher.mock.calls.length, 1);
    assert.equal(f.workCoordinator.hasInFlight(), false);
  } finally { f.fixture.store.close(); }
});

for (const invalid of ['expired Session', 'different credential', 'expired lease'] as const) {
  test(`offline local recovery preserves its freeze with ${invalid}`, async () => {
    const f = await offlineWorker();
    try {
      const session = { ...f.session, ...(invalid === 'expired Session' ? { expiresAt: '2000-01-01T00:00:00Z' }
        : invalid === 'different credential' ? { credentialAuthorityDigest: 'a'.repeat(64) }
          : { replicaLease: { ...f.session.replicaLease, expiresAt: '2000-01-01T00:00:00Z' } }) };
      await f.credentials.saveSession(session);
      await f.engine.scheduleSyncEngineWake('alarm');
      assert.equal((await f.fixture.store.getEngineState(scope))?.recoveryFrozen, true);
      assert.equal((await f.fixture.store.listQueue(scope, 'pending', 0, 10)).length, 0);
    } finally { f.fixture.store.close(); }
  });
}
