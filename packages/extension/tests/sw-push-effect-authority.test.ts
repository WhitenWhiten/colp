import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, vi } from 'vitest';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import { createExtensionWorkCoordinator } from '../src/authority-fence.js';

/**
 * EXT-01 residual: the outbound Push dispatch must ride the same live-authority
 * capability as ordinary Pull. Before this wiring the engine never handed
 * `effects.fetch` to `createOutboundPushWorker`, so a drain racing a login or
 * logout could POST the queue under the retired identity.
 */
const root = '../src';
const scope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', replicaId: 'replica', generation: 1, collectionId: 'collection-a' };

test('worker binds outbound push dispatch to the live authority capability', async () => {
  vi.resetModules();
  const syncState = createSyncStateStore({ indexedDB: new IDBFactory() });
  const credentials = createCredentialStore(new MemoryStorageArea());
  const coordinator = createExtensionWorkCoordinator(credentials.fence);
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [], getChildren: async () => [] },
    alarms: { create: () => undefined }, storage: { local: new MemoryStorageArea(), session: new MemoryStorageArea() } });
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  let networkCalls = 0;
  vi.stubGlobal('fetch', async () => { networkCalls += 1; return new Response('{}', { status: 200 }); });
  await syncState.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-1', cursor: 'cursor-1' }, selectedRoots: [], rootStatus: 'ready' } as any);
  await syncState.putMountBinding(scope as any, { mountId: 'collection-a-mount', nativeRootId: '1',
    remoteMountNodeId: 'a-bar', boundaryVersion: '1', materialized: true, status: 'active', rootRole: 'bookmarks-bar' });

  let push: { readonly fetch?: typeof fetch } | undefined;
  let fenced: unknown;
  let fencedNetworkCalls = -1;
  vi.doMock(root + '/sw/runtime.js', () => ({ store: credentials, syncState, workCoordinator: coordinator,
    sw: { configPromise: Promise.resolve({}), sessionRetryNotBefore: 0 }, extensionOrigin: () => 'chrome-extension://test',
    rootScopeKey: () => JSON.stringify(scope), hasBookmarkPermission: async () => true,
    BOOKMARK_RECOVERY_ALARM: 'recovery', COLLECTION_BINDING: 'collection',
    faviconSidecar: { list: async () => [], prune: async () => 0 }, safeError: (error: Error) => error.message }));
  vi.doMock(root + '/sw/scope.js', () => ({ currentSyncScope: async () => scope, loadConfig: async () => ({}),
    pushSessionAuthority: async () => undefined, currentSyncStatusAuthority: async () => undefined }));
  vi.doMock(root + '/sw/scope-rebuild.js', () => ({ replicaRebuilder: () => ({ resume: async () => undefined }) }));
  vi.doMock(root + '/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: () => undefined },
    currentBookmarkEventQueue: async () => undefined }));
  vi.doMock(root + '/outbound-push-worker.js', () => ({ createOutboundPushWorker: (options: any) => {
    push = options; return { drain: async () => undefined };
  } }));
  vi.doMock(root + '/durable-sync-engine.js', () => ({ createDurableSyncEngine: () => ({
    refreshPlacement: async () => undefined,
    wake: async () => {
      assert.ok(push?.fetch, 'the engine must hand the push worker an authority-bound fetch');
      await push.fetch('https://known.example/api/v1/sync/push', { method: 'POST' });
      const before = networkCalls;
      await credentials.fence.activate();
      try { await push.fetch('https://known.example/api/v1/sync/push', { method: 'POST' }); }
      catch (error) { fenced = error; }
      fencedNetworkCalls = networkCalls - before;
    },
  }) }));

  const worker = await import('../src/sw/engine.js');
  await worker.runSyncEngine('manual', false, await credentials.fence.capture());
  assert.equal((fenced as Error)?.message, 'authority_fenced');
  assert.equal(networkCalls, 1, 'the pre-fence dispatch went out and the fenced one did not');
  assert.equal(fencedNetworkCalls, 0);
  syncState.close(); vi.unstubAllGlobals();
});
