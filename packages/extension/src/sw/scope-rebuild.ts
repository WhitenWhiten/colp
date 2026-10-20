import { createReplicaRebuilder } from '../replica-rebuild.js';
import { createReplicaRetirementTransport } from '../replica-retirement.js';
import { fetchSyncEndpoints } from '../manifest-client.js';
import { extensionOrigin, store, sw, syncState } from './runtime.js';
import { createRuntimeAuth, currentSyncScope, ensureSyncScope, loadConfig, pushSessionAuthority, requireSyncScope } from './scope.js';

export function replicaRebuilder() {
  const currentScope = () => currentSyncScope({ allowArchived: true, allowStopped: true });
  return createReplicaRebuilder({ store: syncState, credentials: store, journal: chrome.storage.local,
    serverRetirement: createReplicaRetirementTransport({ credentials: store, currentScope,
      authority: pushSessionAuthority, origin: extensionOrigin,
      proof: scope => store.loadReplicaReportProof(scope),
      credential: async () => createRuntimeAuth(await loadConfig()).ensureFreshCredential(),
      endpoint: async () => {
        const endpoints = await fetchSyncEndpoints(await loadConfig());
        return { href: endpoints.syncRetire, reauthorization: endpoints.syncRetireReauthorization };
      } }),
    currentScope: () => currentSyncScope({ allowArchived: true, allowStopped: true, allowUnregistered: true }),
    ensureScope: async () => {
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
