import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import { createExtensionWorkCoordinator } from '../src/authority-fence.js';
import type { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { scope, setup } from './own-create-replay-harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../src/sw/runtime.js');
  vi.doUnmock('../src/sw/scope.js');
  vi.doUnmock('../src/sw/scope-rebuild.js');
  vi.doUnmock('../src/sw/bookmarks.js');
  vi.doUnmock('../src/manifest-client.js');
  vi.doUnmock('../src/durable-sync-engine.js');
  vi.resetModules();
});

test.each(['change', 'remove'] as const)(
  'worker replay repairs a lost %s callback through its production pull wiring', async kind => {
    vi.resetModules();
    const f = await setup('completed');
    try {
      if (kind === 'change') await f.api.update(f.node.id, { title: 'Edited while worker stopped' });
      else await f.api.remove(f.node.id);
      const credentials = createCredentialStore(new MemoryStorageArea());
      const coordinator = createExtensionWorkCoordinator(credentials.fence);
      const settled = vi.fn(async () => undefined);
      const reads: string[] = [];
      const errors: string[] = [];
      vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
      vi.stubGlobal('chrome', { bookmarks: { ...f.api, get: async (id: string) => {
        reads.push(id); return f.api.get(id);
      } }, alarms: { create: vi.fn() } });
      vi.doMock('../src/sw/runtime.js', () => ({ store: credentials, syncState: f.store,
        workCoordinator: coordinator, sw: { sessionRetryNotBefore: 0 },
        hasBookmarkPermission: async () => true, extensionOrigin: () => 'chrome-extension://test',
        safeError: (error: Error) => { errors.push(error.message); return error.message; },
      }));
      vi.doMock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope,
        restoredSyncScope: async () => scope, loadConfig: async () => ({}),
        pushSessionAuthority: async () => ({ credential: { accessToken: 'test-token' },
          session: { sessionId: 'session-pull', conversionPolicy: { separator: 'preserve_remote' } } }),
      }));
      vi.doMock('../src/sw/scope-rebuild.js', () => ({ replicaRebuilder: () => ({ resume: async () => undefined }) }));
      vi.doMock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn(), settled },
        currentBookmarkEventQueue: async () => f.queue }));
      vi.doMock('../src/manifest-client.js', () => ({ fetchSyncEndpoints: async () => ({
        syncEffectPages: f.options.effectPageTemplate, effectPageAuthority: f.options.effectPageAuthority,
      }) }));
      // Drive the real service-worker composition and real applier without a network scheduler.
      vi.doMock('../src/durable-sync-engine.js', () => ({
        createDurableSyncEngine: (options: Parameters<typeof createDurableSyncEngine>[0]) => ({
          refreshPlacement: async () => 'continue',
          wake: async () => {
            await options.sessions.get();
            await options.endpoints();
            await options.pullApplier.stage(f.page);
            await options.pullApplier.resume();
          },
        }),
      }));
      const worker = await import('../src/sw/engine.js');
      await worker.runSyncEngine('startup', false, await credentials.fence.capture());
      assert.deepEqual(errors, []);
      assert.ok(settled.mock.calls.length > 0, 'the worker waits for native callbacks before proving the echo');
      assert.ok(reads.includes(f.node.id), 'repair reads the original native through the permission guard');
      assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-next');
      assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
      assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
      const pending = await f.store.listBookmarkEventsByStatus(scope, 'pending');
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.kind, kind);
      assert.equal((await f.store.listQueue(scope)).length, 1, 'repair waits for its original create receipt');
    } finally { f.store.close(); }
  });
