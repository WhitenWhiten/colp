import { digestJson } from '../bookmark-event-codec.js';
import { runReplicaRebuildCommand } from '../replica-rebuild.js';
import { createQueueRecapture } from '../queue-recapture.js';
import { configuredPersonalSyncPolicy } from '../personal-sync-fetch.js';
import type { SyncScope } from '../sync-state-store.js';
import { runSyncEngine } from './engine.js';
import { queueRetryKind, retryQueueIssue } from './issue-retry.js';
import { requestExplicitSyncRetry } from './explicit-retry.js';
import type { AuthorityContext } from '../authority-fence.js';
import { REPLICA_HEALTH_ATTENTION_HEARTBEAT_MS, sendReplicaDisconnectReport, sendReplicaHealthReport,
  type ReplicaCommandRunner, type ReplicaHealthReporterDeps } from './replica-health-report.js';
import { extensionOrigin, hasBookmarkPermission, store, syncState, workCoordinator } from './runtime.js';
import { replicaRebuilder } from './scope-rebuild.js';
import { createRuntimeAuth, currentSyncScope, loadConfig, restoredSyncScope } from './scope.js';
import { syncWatchdog } from './sync-watchdog-runtime.js';
import { guardWakeStep, isWakeWait, workerWakeFailureLog } from './wake-failure.js';

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
  // A reset can publish its replacement identity and then lose connectivity
  // before registration. No scope exists for reporting yet; the independent
  // heartbeat must also resume that journal, not wait for an engine wake.
  if (await replicaRebuilder().hasPending()) {
    try { if (!await store.loadCredential()) await createRuntimeAuth(await loadConfig()).ensureFreshCredential(); }
    catch { return; }
    // A reset that cannot finish is recorded and reported; it must not silence the heartbeat (Rule E, W2A-02).
    const resumed = await workCoordinator.run('engine', () => guardWakeStep(workerWakeFailureLog(), 'rebuild_resume',
      () => replicaRebuilder().resume()));
    // Waiting for a connection or a sign-in is tried again on the next heartbeat; a failure is reported below.
    if (!resumed.ok && isWakeWait(resumed.code)) return;
  }
  let scope: Awaited<ReturnType<typeof restoredSyncScope>>;
  try { scope = await restoredSyncScope(); } catch { return; }
  const authority = await store.fence.capture();
  const assertCurrent = async () => {
    await store.fence.assertWritable(authority.generation);
    if (digestJson({ ...await currentSyncScope() }) !== digestJson({ ...scope })) throw new Error('stale_ref');
  };
  const policy = configuredPersonalSyncPolicy();
  // A remote item whose bookmark is here by now needs nothing: it must not be reported as a problem.
  await syncState.closeLandedPullIssues(scope).catch(() => 0);
  const report = (forced: boolean) => sendReplicaHealthReport({
    ...reporterDeps(scope),
    mode: async () => policy ? (await policy.read(scope)).mode : undefined,
    assertCommandCurrent: assertCurrent, commands: commandRunner(scope, assertCurrent), force: forced,
  });
  // Commands ran: report again so the Sync center sees their results and the state they left.
  if (await report(force) === 'ran') await report(true);
}

function reporterDeps(scope: SyncScope): Omit<ReplicaHealthReporterDeps, 'mode'> {
  return {
    scope, store: syncState,
    rebuildPending: () => replicaRebuilder().hasPending(), bookmarkPermission: hasBookmarkPermission, watchdog: syncWatchdog,
    // A credential refresh at most; never a Sync Session, which renews lease and cursors.
    credential: async () => createRuntimeAuth(await loadConfig()).ensureFreshCredential(),
    replicaProof: scope => store.loadReplicaReportProof(scope),
    fetch: (input, init) => fetch(input, init),
    storage: chrome.storage.local, origin: extensionOrigin(),
    extensionVersion: chrome.runtime.getManifest().version, now: Date.now,
  };
}

/**
 * Best effort and bounded: tell the Sync center this browser is leaving, while its replica still exists.
 * The disconnect never waits long for a server that does not answer.
 */
export async function reportReplicaDisconnected(scope: SyncScope): Promise<void> {
  try {
    await sendReplicaDisconnectReport({ ...reporterDeps(scope), mode: async () => 'disconnected', requestTimeoutMilliseconds: 4_000 });
  } catch { /* A report that cannot be sent never blocks the user's own choice. */ }
}

/**
 * What the Sync center may ask, carried out exactly as the extension's own
 * buttons do: Retry is the Status tab's manual wake, Rebuild its Reset, and an
 * item's Retry returns one held change to the push lane, where it goes through
 * every placement and identity check again.
 */
function commandRunner(scope: SyncScope, assertCurrent: () => Promise<void>): ReplicaCommandRunner {
  let execution: AuthorityContext | undefined;
  const retry = async () => {
    await assertCurrent(); if (!execution) throw new Error('command_context_missing');
    requestExplicitSyncRetry();
    await runSyncEngine('manual', false, execution);
  };
  return {
    run: work => workCoordinator.run('engine', async context => {
      await assertCurrent(); execution = context; try { return await work(); } finally { execution = undefined; }
    }),
    async replica(action) {
      if (action === 'retry') { await retry(); return { outcome: 'done', code: 'retry_completed' }; }
      return runReplicaRebuildCommand(async request => { await assertCurrent(); return replicaRebuilder().handle(request); }, scope);
    },
    async serverRebuild() {
      await assertCurrent();
      return replicaRebuilder().rebuildServerRetired(scope);
    },
    async issue(_action, issue) {
      const row = issue.opId ? await syncState.getQueueByOpId(scope, issue.opId) : null;
      if (!row || !queueRetryKind(row)) return { outcome: 'failed', code: 'issue_gone' };
      await assertCurrent();
      // The same thing the Status card's Try again does for the item.
      const code = await retryQueueIssue(syncState, scope, row,
        createQueueRecapture({ store: syncState, scope, api: chrome.bookmarks, permission: hasBookmarkPermission }));
      await retry(); return { outcome: 'done', code };
    },
  };
}
