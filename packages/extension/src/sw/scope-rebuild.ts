import { fetchSyncEndpoints } from '../manifest-client.js';
import { createReplicaRebuilder } from '../replica-rebuild.js';
import { fenceReplicaOnServer } from './replica-fence.js';
import { extensionOrigin, store, sw, syncState } from './runtime.js';
import { currentSyncScope, ensureSyncScope, loadConfig, pushSessionAuthority, requireSyncScope } from './scope.js';

/** K3: retires this browser's replica on the server while its Session is still valid. */
export const fenceCurrentReplica = () => fenceReplicaOnServer({ authority: pushSessionAuthority,
  fetch: (input, init) => fetch(input, init),
  endpoint: async () => (await fetchSyncEndpoints(await loadConfig())).syncRetire, origin: extensionOrigin() });

/** The worker's caches of the replica identity that was just replaced. */
export function resetReplicaRuntime() {
  sw.bindingPromise = undefined; sw.bookmarkEventQueue = undefined;
  sw.bookmarkEventScopeKey = undefined; sw.rootViewTokens = undefined;
  sw.sessionRetryNotBefore = 0;
}

/** Makes sure the replaced identity has its scope in the (possibly fresh) database. */
export async function ensureReplacedScope() {
  const scope = await requireSyncScope();
  // Session storage and IDB are separate commits. A restart after saving the
  // new Session must still materialize its scope before setup can proceed.
  if (!await syncState.getScope(scope)) {
    const credential = await store.loadCredential(); const session = await store.loadSession();
    if (!credential || !session) throw new Error('not_connected');
    await ensureSyncScope(await loadConfig(), credential, session, (await store.fence.capture()).generation);
  }
  return scope;
}

export function replicaRebuilder() {
  return createReplicaRebuilder({ store: syncState, credentials: store, journal: chrome.storage.local,
    // K3: the old replica leaves the server before it is archived, so an unsettled upload cannot land later.
    fence: () => fenceCurrentReplica(),
    currentScope: () => currentSyncScope({ allowUnregistered: true }), ensureScope: ensureReplacedScope,
    resetRuntime: resetReplicaRuntime });
}
