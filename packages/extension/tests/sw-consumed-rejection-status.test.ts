import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
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

test('a consumed server rejection must remain visible in public engine state and the signed-in status chip', async () => {
  const f = await offlineWorker();
  try {
    await f.fixture.store.setFirstRun(scope, 'completed');
    const prior = (await f.fixture.store.getEngineState(scope))!;
    const { lastError: _lastError, localProjectionOwner: _owner, ...healthy } = prior;
    await f.fixture.store.transitionEngine(scope, { ...healthy, phase: 'sleeping', recoveryFrozen: false,
      lastPublishedCursor: 'cursor-done', lastAckedCursor: 'cursor-done', lastPushServerCursor: 'cursor-done', notBefore: 0 });
    const operation = await f.fixture.store.allocateSequenceAndEnqueue(scope, {
      opId: 'server-rejected-edit', batchId: 'server-rejected-edit', idempotencyKey: 'server-rejected-edit',
      digest: 'sha256:rejected', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'revision-old', operationRevision: 'revision-local', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: 'child-a',
        occurredAt: new Date().toISOString(), payload: { title: 'Local edit refused by server' } },
    }, { allowUnstamped: true });
    await f.fixture.store.completeQueueWithReceipt(scope, operation.sequence, {
      opId: operation.opId, operationDigest: operation.digest, kind: 'terminal', receiptId: 'rejected-receipt',
      resultDigest: 'sha256:result', result: { results: [{ opId: operation.opId,
        status: 'rejected', code: 'parent_deleted' }] },
    });
    const receipt = await f.fixture.store.getQueueReceipt(scope, operation.sequence);
    f.fixture.store.close();
    const { handleSyncAttentionRequest } = await import('../src/sw/sync-attention.js');
    const attention = await handleSyncAttentionRequest({ scope: async () => scope, store: f.fixture.store });
    const engine = await f.engine.publicSyncEngineState(scope, f.credential, f.session, f.config);
    const { handleFirstRunRequest } = await import('../src/sw/first-run.js');
    Object.assign(chrome.runtime, { sendMessage: async (request: { kind: string }) => {
      if (request.kind === 'known.personalSync.status') return { ok: true, policy: { mode: 'connected' } };
      if (request.kind === 'known.firstRun.status') return handleFirstRunRequest({ kind: 'known.firstRun.status' });
      if (request.kind === 'known.sync.engine.status') return { ok: true, engine };
      throw new Error('Unexpected request: ' + request.kind);
    } });
    const { signedInSyncStatus } = await import('../src/sync-label.js');
    const label = await signedInSyncStatus();
    expect(attention).toMatchObject({ ok: true, attention: { rejectedPending: true, issueCount: 1 } });
    expect(engine).toMatchObject({ rejectedPending: true, queueProjection: 'rejected',
      hasPendingWork: false, cursorsConverged: true });
    expect(label.kind).toBe('action-required');
    // Historical issues belong to the exact account, collection and generation.
    for (const other of [{ ...scope, accountId: 'another-account' }, { ...scope, collectionId: 'another-collection' },
      { ...scope, generation: scope.generation + 1 }]) {
      expect(await f.engine.publicSyncEngineState(other, f.credential, f.session, f.config))
        .toMatchObject({ rejectedPending: false, queueProjection: 'idle', hasPendingWork: false });
    }
    expect((await f.fixture.store.listQueue(scope)).find(row => row.opId === operation.opId)?.status).toBe('terminal');
    expect(await f.fixture.store.getQueueReceipt(scope, operation.sequence)).toEqual(receipt);
  } finally { f.fixture.store.close(); }
});
