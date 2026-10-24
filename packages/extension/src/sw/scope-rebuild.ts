import { createReplicaRebuilder } from '../replica-rebuild.js';
import { store, sw, syncState } from './runtime.js';
import { currentSyncScope, ensureSyncScope, loadConfig, requireSyncScope } from './scope.js';

export function replicaRebuilder() {
  return createReplicaRebuilder({ store: syncState, credentials: store, journal: chrome.storage.local,
    currentScope: () => currentSyncScope({ allowUnregistered: true }), ensureScope: async () => {
      const scope = await requireSyncScope();
      // Session storage and IDB are separate commits. A restart after saving the
      // new Session must still materialize its scope before setup can proceed.
      if (!await syncState.getScope(scope)) {
        const credential = await store.loadCredential(); const session = await store.loadSession();
        if (!credential || !session) throw new Error('not_connected');
        await ensureSyncScope(await loadConfig(), credential, session, (await store.fence.capture()).generation);
      }
      return scope;
    },
    resetRuntime() {
      sw.bindingPromise = undefined; sw.bookmarkEventQueue = undefined;
      sw.bookmarkEventScopeKey = undefined; sw.rootViewTokens = undefined;
      sw.sessionRetryNotBefore = 0;
    } });
}
