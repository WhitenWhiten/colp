import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = { environment: 'production', serverId: 'server-permission',
  serverOrigin: 'https://known.example', accountId: 'account-permission', browserProfileId: 'profile-permission',
  collectionId: 'collection-permission', replicaId: 'replica-permission', generation: 1 };

const removedListeners: Array<(change: { permissions?: string[] }) => void> = [];
const calls = { get: 0, getChildren: 0, create: 0 };
let permissionAllowed = false;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../src/sw/runtime.js');
  vi.doUnmock('../src/sw/scope.js');
  removedListeners.length = 0;
  calls.get = 0; calls.getChildren = 0; calls.create = 0;
  permissionAllowed = false;
});

test('bookmark permission removal pauses the scope and keeps the queue', async () => {
  const syncState = createSyncStateStore({ indexedDB: new IDBFactory() });
  try {
    await syncState.registerScope({ ...scope, lifecycle: 'active', rootStatus: 'ready',
      lease: { leaseId: 'lease-permission', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
      checkpoint: null, selectedRoots: [] });
    const payload: JsonObject = { opId: 'op-permission', replicaId: scope.replicaId, sequence: 1,
      collectionId: scope.collectionId, type: 'create_node', baseRevision: null,
      occurredAt: '2026-10-03T00:00:00.000Z', dependencies: [], payload: { parentId: 'parent' } };
    await syncState.allocateSequenceAndEnqueue(scope, { opId: 'op-permission', batchId: 'batch-permission',
      idempotencyKey: 'idempotency-permission', digest: 'sha256:permission', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: 'local-permission',
      status: 'pending', retry: { attempt: 1, notBefore: 0 }, payload }, { allowUnstamped: true });
    const before = await syncState.listQueue(scope);
    const engine = await loadEngine(() => permissionAllowed, syncState);
    assert.equal(removedListeners.length, 1);
    for (const listener of removedListeners) listener({ permissions: ['storage'] });
    await Promise.resolve();
    assert.equal((await syncState.getScope(scope))?.rootStatus, 'ready');
    for (const listener of removedListeners) listener({ permissions: ['bookmarks'] });
    await vi.waitFor(async () => {
      assert.equal((await syncState.getScope(scope))?.rootStatus, 'permission_required');
    });
    assert.equal((await syncState.getScope(scope))?.lifecycle, 'active');
    assert.notEqual((await syncState.getEngineState(scope))?.recoveryFrozen, true);
    assert.deepEqual(await syncState.listQueue(scope), before);
    assert.equal(calls.get + calls.getChildren + calls.create, 0);
    permissionAllowed = true;
    for (const listener of removedListeners) listener({ permissions: ['bookmarks'] });
    await Promise.resolve();
    assert.equal((await syncState.getScope(scope))?.rootStatus, 'permission_required');
    assert.equal(typeof engine.installBookmarkPermissionRemovedListener, 'function');
  } finally { syncState.close(); }
});

test('native reads classify permission, a revoke in the gap, absence, and unknown results', async () => {
  const engine = await loadEngine();
  await assert.rejects(() => engine.readPermittedBookmarkApi(() => chrome.bookmarks.getChildren('parent')),
    (error: unknown) => bookmarkFailure(error, 'permission_denied', 'permission_required'));
  assert.equal(calls.getChildren, 0);
  assert.equal(calls.create, 0);

  permissionAllowed = true;
  let checks = 0;
  const flip = await loadEngine(() => { checks += 1; return checks === 1; });
  await assert.rejects(() => flip.readPermittedBookmarkApi(() => chrome.bookmarks.get('gone')),
    (error: unknown) => bookmarkFailure(error, 'permission_denied', 'permission_required'));
  assert.equal(calls.get, 1);
  assert.equal(calls.create, 0);

  permissionAllowed = true;
  const present = await loadEngine();
  await assert.rejects(() => present.readPermittedBookmarkApi(() => chrome.bookmarks.getChildren('missing')),
    (error: unknown) => bookmarkFailure(error, 'not_found'));
  assert.equal(calls.create, 0);

  const unknown = await loadEngine();
  await assert.rejects(() => unknown.readPermittedBookmarkApi(() => chrome.bookmarks.get('broken')),
    (error: unknown) => bookmarkFailure(error, 'other_failure', 'native_result_unknown'));
  assert.equal(calls.create, 0);

  const nodes = await unknown.readPermittedBookmarkApi(() => chrome.bookmarks.getChildren('parent'));
  assert.deepEqual(nodes.map((node) => node.id), ['child']);
});

test('the engine does not call revokeBookmarkSync for a temporary permission loss', async () => {
  const engine = await readFile(new URL('../src/sw/engine.ts', import.meta.url), 'utf8');
  const rebase = await readFile(new URL('../src/create-placement-rebase.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /revokeBookmarkSync/);
  assert.doesNotMatch(rebase, /revokeBookmarkSync/);
  assert.match(engine, /permissions\?\.onRemoved/);
  assert.match(engine, /get: \(id\) => readPermittedBookmarkApi\(\(\) => chromeApi\.get\(id\)\)/);
  assert.match(engine, /getChildren: \(id\) => readPermittedBookmarkApi\(\(\) => chromeApi\.getChildren\(id\)\)/);
  assert.match(engine, /readChildrenOrder: async \(parentId\) => \(await readPermittedBookmarkApi\(/);
});

function bookmarkFailure(error: unknown, failureClass: string, message?: string): boolean {
  const value = error as { message?: string; failureClass?: string };
  return value.failureClass === failureClass && (message === undefined || value.message === message);
}

async function loadEngine(permission: () => boolean = () => permissionAllowed,
  syncState = createSyncStateStore({ indexedDB: new IDBFactory() })) {
  vi.resetModules();
  removedListeners.length = 0;
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  vi.stubGlobal('chrome', {
    permissions: { onRemoved: { addListener: (listener: (change: { permissions?: string[] }) => void) => {
      removedListeners.push(listener);
    } }, contains: async () => permission() },
    bookmarks: {
      get: async (id: string) => {
        calls.get += 1;
        if (id === 'gone') throw new Error('revoked_between_check_and_call');
        if (id === 'broken') throw new Error('native_result_unknown');
        if (id === 'missing') throw new Error("Can't find bookmark for id.");
        return [{ id, title: 'Node' }];
      },
      getChildren: async (id: string) => {
        calls.getChildren += 1;
        if (id === 'missing') throw new Error("Can't find bookmark for id.");
        return [{ id: 'child', title: 'Child', parentId: id }];
      },
      create: async () => { calls.create += 1; return { id: 'created', title: 'Created' }; },
    },
    alarms: { create: () => undefined },
    storage: { local: { get: async () => ({}), set: async () => undefined },
      session: { get: async () => ({}), set: async () => undefined, setAccessLevel: async () => undefined } },
    runtime: { id: 'permission-extension', getURL: (path: string) => `chrome-extension://permission-extension/${path}` },
  });
  vi.doMock('../src/sw/runtime.js', () => ({
    store: { assertWritable: async () => undefined, fence: { capture: async () => ({ generation: 1, signal: new AbortController().signal }) } },
    syncState,
    workCoordinator: { run: async (_lane: string, work: () => Promise<unknown>) => work(), hasInFlight: () => false },
    sw: { configPromise: undefined, sessionRetryNotBefore: 0, confirmedOnlineWakePending: false },
    hasBookmarkPermission: async () => permission(),
    extensionOrigin: () => 'chrome-extension://permission-extension',
    safeError: (error: unknown) => error instanceof Error ? error.message : 'operation_failed',
    rootScopeKey: () => 'scope',
    BOOKMARK_RECOVERY_ALARM: 'known-bookmark-capture-recovery',
  }));
  vi.doMock('../src/sw/scope.js', () => ({
    currentSyncScope: async () => scope,
    loadConfig: async () => ({}),
    pushSessionAuthority: async () => undefined,
    currentSyncStatusAuthority: async () => undefined,
  }));
  return import('../src/sw/engine.js');
}
