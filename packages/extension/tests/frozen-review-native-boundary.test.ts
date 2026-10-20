import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { nativeChromeFacts } from '../src/sw/native-chrome.js';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each(['content', 'exclusion'] as const)(
  'a newer %s during the production native wrapper must stop the stale rejoin update', async changed => {
    const f = await rejoinFixture();
    try {
      await detachScopeMount(f.store, scope, 'mount-bar');
      const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
      await f.store.putRemoteObservation(scope, { colpId: 'node-1', remoteRevision: 'cloud-title', kind: 'content',
        cursor: 'cloud-title', payload: { title: 'Cloud title', url: 'https://example.test/' }, observedAt: 1,
        sourceDigest: 'sha256:cloud-title', pauseGeneration: scope.generation,
        pauseBoundaryVersion: mount.pauseBaseline!.boundaryVersion,
        pauseCursor: mount.pauseBaseline!.lastAppliedCursor });
      let automaticWrites = 0, injected = false, inMutation = false;
      vi.stubGlobal('chrome', { bookmarks: { ...f.api, update: async (id: string, changes: { title?: string; url?: string }) => {
        automaticWrites++; return f.api.update(id, changes);
      } } });
      const pendingOperations = subscriptionStore.pendingOperations;
      vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
        const result = await pendingOperations();
        // This schedules another context during an actual IDB await inside
        // personalBookmarks.update. The production checks and result stay real.
        if (inMutation && !injected) {
          injected = true;
          if (changed === 'content') await f.api.update('native-node', { title: 'Newest local title' });
          else await f.store.putLocalSyncExclusion(scope, { nativeId: 'native-node', rootNativeId: 'native-root',
            priorColpId: 'node-1', generation: scope.generation, decisionId: 'new-private-choice' });
        }
        return result;
      });
      const productionNative = nativeChromeFacts();
      await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], { ...f.native,
        updateNative: async (id, changes) => {
          inMutation = true;
          try { return await productionNative.updateNative(id, changes); }
          finally { inMutation = false; }
        },
      }).catch(error => expect(String(error)).toMatch(/rejoin_boundary_changed/));
      expect(injected).toBe(true);
      expect.soft(automaticWrites, 'authorization was withdrawn before the actual chrome.bookmarks.update').toBe(0);
      expect.soft(f.api.getNode('native-node')?.title).toBe(changed === 'content' ? 'Newest local title' : 'node-1');
      expect.soft((await f.store.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
    } finally { f.store.close(); }
  });
