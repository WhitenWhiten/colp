import { createSyncStorageReset } from '../sync-storage-reset.js';
import { store, syncState } from './runtime.js';
import { ensureReplacedScope, fenceCurrentReplica, resetReplicaRuntime } from './scope-rebuild.js';

/**
 * W2A-01: the production wiring of "Reset local sync data". Runs on the engine lane (service-worker.ts), so
 * no wake, push or pull is in flight while the database is deleted.
 */
export function syncStorageReset() {
  return createSyncStorageReset({
    probe: () => syncState.storageState(), indexedDB: globalThis.indexedDB, archive: chrome.storage.local, now: Date.now,
    currentReplicaId: async () => (await store.loadBinding())?.replicaId,
    fence: fenceCurrentReplica,
    // A new replica identity, as in the K3 Reset: the new database must not continue the old replica's
    // sequence numbers on the server. Nothing to rotate when signed out.
    rotateBinding: async () => {
      const binding = await store.loadBinding();
      if (!binding) return;
      const authority = await store.fence.capture();
      await store.replaceBindingForRebuild(authority.generation, binding.replicaId,
        { ...binding, replicaId: `replica-${crypto.randomUUID()}`, generation: '1' });
    },
    forget: () => syncState.forgetStorage(), resetRuntime: resetReplicaRuntime, ensureScope: ensureReplacedScope,
  });
}
