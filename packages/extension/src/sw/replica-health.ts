import { configuredPersonalSyncPolicy } from '../personal-sync-fetch.js';
import type { SyncScope } from '../sync-state-store.js';
import { scheduleSyncEngineWake } from './engine.js';
import { REPLICA_HEALTH_ATTENTION_HEARTBEAT_MS, sendReplicaHealthReport,
  type ReplicaCommandRunner } from './replica-health-report.js';
import { extensionOrigin, syncState, workCoordinator } from './runtime.js';
import { replicaRebuilder } from './scope-rebuild.js';
import { createRuntimeAuth, loadConfig, restoredSyncScope } from './scope.js';

/** The heartbeat that still reports when no engine pass runs, e.g. after a terminal stop. */
export const REPLICA_HEALTH_ALARM = 'known-sync-health';
/** The shorter heartbeat; a report that changed nothing and is not due is skipped locally. */
export const REPLICA_HEALTH_PERIOD_MINUTES = REPLICA_HEALTH_ATTENTION_HEARTBEAT_MS / 60_000;

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
  const report = (forced: boolean) => sendReplicaHealthReport({
    scope, store: syncState,
    mode: async () => policy ? (await policy.read(scope)).mode : undefined,
    rebuildPending: () => replicaRebuilder().hasPending(),
    // A credential refresh at most; never a Sync Session, which renews lease and cursors.
    credential: async () => createRuntimeAuth(await loadConfig()).ensureFreshCredential(),
    fetch: (input, init) => fetch(input, init),
    storage: chrome.storage.local, origin: extensionOrigin(),
    extensionVersion: chrome.runtime.getManifest().version, now: Date.now,
    commands: commandRunner(scope), force: forced,
  });
  // Commands ran: report again so the Sync center sees their results and the state they left.
  if (await report(force) === 'ran') await report(true);
}

/**
 * What the Sync center may ask, carried out exactly as the extension's own
 * buttons do: Retry is the Status tab's manual wake, Rebuild its Reset, and an
 * item's Retry returns one held change to the push lane, where it goes through
 * every placement and identity check again.
 */
function commandRunner(scope: SyncScope): ReplicaCommandRunner {
  return {
    async replica(action) {
      if (action === 'retry') { await scheduleSyncEngineWake('manual'); return { outcome: 'done' }; }
      const preview = await workCoordinator.run('engine', () => replicaRebuilder().handle({ kind: 'known.scope.rebuild.preview' }));
      if (!preview.ok) return { outcome: 'failed', code: preview.code };
      if (!('preview' in preview)) return { outcome: 'failed', code: 'rebuild_failed' };
      // The owner confirmed in the Sync center; the browser keeps its bookmarks and asks for setup again.
      const result = await workCoordinator.run('engine', () => replicaRebuilder().handle({
        kind: 'known.scope.rebuild.confirm', userGesture: true, replicaId: preview.preview.replicaId,
        generation: preview.preview.generation, revision: preview.preview.revision }));
      return result.ok ? { outcome: 'done', replaced: true } : { outcome: 'failed', code: result.code };
    },
    async issue(_action, issue) {
      const row = issue.opId ? await syncState.getQueueByOpId(scope, issue.opId) : null;
      if (row?.status !== 'set_aside') return { outcome: 'failed', code: 'issue_gone' };
      await syncState.releaseSetAsideQueue(scope, [row.sequence]);
      await scheduleSyncEngineWake('manual');
      return { outcome: 'done' };
    },
  };
}
