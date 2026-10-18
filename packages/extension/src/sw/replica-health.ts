import { configuredPersonalSyncPolicy } from '../personal-sync-fetch.js';
import { REPLICA_HEALTH_HEARTBEAT_MS, sendReplicaHealthReport } from './replica-health-report.js';
import { extensionOrigin, syncState } from './runtime.js';
import { replicaRebuilder } from './scope-rebuild.js';
import { createRuntimeAuth, loadConfig, restoredSyncScope } from './scope.js';

/** The heartbeat that still reports when no engine pass runs, e.g. after a terminal stop. */
export const REPLICA_HEALTH_ALARM = 'known-sync-health';
export const REPLICA_HEALTH_PERIOD_MINUTES = REPLICA_HEALTH_HEARTBEAT_MS / 60_000;

let inFlight: Promise<unknown> | undefined;

/** Best effort and coalesced: a report never blocks or fails a sync pass. */
export function reportReplicaHealth(force = false): Promise<void> {
  inFlight ??= send(force).finally(() => { inFlight = undefined; });
  return inFlight.then(() => undefined, () => undefined);
}

async function send(force: boolean) {
  let scope: Awaited<ReturnType<typeof restoredSyncScope>>;
  try { scope = await restoredSyncScope(); } catch { return; }
  const policy = configuredPersonalSyncPolicy();
  await sendReplicaHealthReport({
    scope, store: syncState,
    mode: async () => policy ? (await policy.read(scope)).mode : undefined,
    rebuildPending: () => replicaRebuilder().hasPending(),
    // A credential refresh at most; never a Sync Session, which renews lease and cursors.
    credential: async () => createRuntimeAuth(await loadConfig()).ensureFreshCredential(),
    fetch: (input, init) => fetch(input, init),
    storage: chrome.storage.local, origin: extensionOrigin(),
    extensionVersion: chrome.runtime.getManifest().version, now: Date.now, force,
  });
}
