import { readReplicaRepairCapability } from '../replica-repair-capability.js';
import { isSettledRejection } from '../sync-state/open-issue-facts.js';
import { snapshotSyncIssues, localIssueId } from '../sync-issue-snapshot.js';
import { readOpenSyncIssues, type OpenSyncIssues } from '../sync-issues.js';
/** Shared attention facts and action capabilities. Reading may restore derived issue
 * projections from historical receipts; it never wakes the engine or touches native data. */
import { hasConflictBarrier, hasRejectedBarrier, queueStatusProjection, stalledUploadHead } from '../engine-public-stability.js';
import type { NativeWaitStore } from '../native-wait.js';
import { syncAttentionTerminalCode } from '../sync-attention-ui.js';
import type { UnreadableQueueRow } from '../sync-state/queue-lenient.js';
import type { SyncAttentionResponse } from '../types.js';
import type { createSyncStateStore, QueueOperation, SyncScope } from '../sync-state-store.js';
import type { WakeFailure } from './wake-failure.js';
import { readVisibleWakeFailures, unreadableQueueDiagnostics, wakeFailureDiagnostics } from './engine-issues.js';

export type SyncAttentionStore = NativeWaitStore & Pick<ReturnType<typeof createSyncStateStore>,
  'getEngineState' | 'listQueue'> & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'listConsumedQueueIssues' | 'listBootstrapRuns' | 'listMappings' | 'listPullIssues' | 'listLocalIssues' | 'listOpenIngressIssues' | 'listPullPages' | 'listPullEventsByPage' | 'listUnreadableQueue'>>;

export interface SyncAttentionDeps {
  readonly scope: () => Promise<SyncScope>;
  readonly store: SyncAttentionStore;
  readonly openIssues?: OpenSyncIssues;
  readonly rebuildPending?: () => Promise<boolean>;
  /** Whether the pending reset can still be given up (nothing archived yet). */
  readonly rebuildCancelAvailable?: () => Promise<boolean>;
  /** The repeated failures of engine wake steps for this replica (default: the worker's own record). */
  readonly wakeFailures?: (replicaId: string | undefined) => Promise<readonly WakeFailure[]>;
}

/** Same status set `pendingDurableWorkFacts` live-scans (engine.ts), bounded to one page each. */
const LIVE_STATUSES = ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'rejected', 'set_aside'] as const;
const QUEUE_PAGE = 1_000;

export async function handleSyncAttentionRequest(deps: SyncAttentionDeps): Promise<SyncAttentionResponse> {
  if (await deps.rebuildPending?.()) {
    // A reset that keeps failing to finish says why (Rule E) and, while nothing is archived, can be given up (W2A-02).
    const failed = (await (deps.wakeFailures ?? readVisibleWakeFailures)(undefined).catch((): WakeFailure[] => []))
      .filter(failure => failure.stage === 'rebuild_resume');
    return { ok: true, attention: {
      recoveryFrozen: true, queueProjection: 'idle', conflictPending: false, rejectedPending: false,
      nativeWaitPending: false, waitCount: 0, terminal: true, terminalCode: 'replica_rebuild_pending', phase: 'recovery',
      lastError: 'replica_rebuild_pending', rebuildAvailable: true, rebuildMode: 'local',
      ...(failed.length > 0 ? { issueCount: failed.length, issues: wakeFailureDiagnostics(failed) } : {}),
      ...(await deps.rebuildCancelAvailable?.().catch(() => false) ? { rebuildCancelAvailable: true } : {}),
    } };
  }
  let scope: SyncScope;
  try { scope = await deps.scope(); } catch { return { ok: false, error: 'not_connected' }; }
  try {
    const [recorded, engine] = await Promise.all([
      deps.store.getScope(scope),
      deps.store.getEngineState(scope),
    ]);
    const recoveryCode = typeof recorded?.metadata?.recoveryCode === 'string'
      ? recorded.metadata.recoveryCode : undefined;
    const lastError = engine?.lastError;
    const terminalCode = syncAttentionTerminalCode(lastError, recoveryCode);
    const open = deps.openIssues ?? await readOpenSyncIssues(deps.store, scope);
    const capability = await readReplicaRepairCapability(deps.store, scope, open);
    const waits = open.waits;
    const { stalled, unreadable, ...queue } = await queueFacts(deps.store, scope, open);
    const issues = snapshotSyncIssues(open).map(issue => {
      const local = open.local.find(row => issue.direction === 'local' && row.code === issue.code
        && localIssueId(row) === issue.issueId);
      const operation = open.queue.find(row => row.opId === issue.opId);
      const merge = open.bootstrap.find(row => row.issueId === issue.issueId);
      return { ...issue, ...(operation?.recovery?.expectedSequence ? { dependencySequence: operation.recovery.expectedSequence } : {}), ...(merge ? { reportId: merge.reportId, itemId: merge.itemId, recovery: 'decision' as const } : {}), ...(local ? { eventId: local.eventId, dependencyOpId: local.dependencyOpId,
        dependencyEventId: local.dependencyEventId, rootCause: local.rootCause, attempts: local.attempts,
        recovery: local.recovery } : {}) };
    });
    if (stalled) issues.push({ direction: 'push', code: stalled.code } as typeof issues[number]);
    // Rule C / Rule E: a change that cannot be read keeps the push lane waiting (or is about to be held); say so.
    issues.push(...unreadableQueueDiagnostics(unreadable) as typeof issues);
    // Rule E: a step of the engine wake that keeps failing is a visible item, not a silent return.
    const failedSteps = await (deps.wakeFailures ?? readVisibleWakeFailures)(scope.replicaId).catch((): WakeFailure[] => []);
    issues.push(...wakeFailureDiagnostics(failedSteps) as typeof issues);
    return { ok: true, attention: {
      ...(engine?.phase ? { phase: engine.phase } : {}),
      recoveryFrozen: engine?.recoveryFrozen === true,
      retryAutomatic: engine?.phase !== 'error' && terminalCode === undefined,
      ...(engine?.notBefore ? { retryAt: engine.notBefore } : {}),
      ...queue,
      issueCount: open.total + (stalled ? 1 : 0) + unreadable.length + failedSteps.length, issues, rebuildAvailable: capability.rebuildAvailable,
      rebuildMode: capability.rebuildMode,
      ...(capability.rebuildBlockedReason ? { rebuildBlockedReason: capability.rebuildBlockedReason } : {}),
      ...(capability.reason ? { rebuildUnavailableReason: capability.reason } : {}),
      retryAvailable: Boolean(stalled) || failedSteps.length > 0
        || open.queue.some(row => row.recovery?.code === 'sequence_blocked' && row.attempt !== undefined),
      nativeWaitPending: waits.length > 0,
      waitCount: waits.length,
      ...(lastError ? { lastError } : {}),
      ...(recoveryCode ? { recoveryCode } : {}),
      terminal: terminalCode !== undefined,
      ...(terminalCode ? { terminalCode } : {}),
    } };
  } catch { return { ok: false, error: 'state_unavailable' }; }
}

/** Best-effort like `sw/remote-delete.ts#status`: a failed queue read still leaves the freeze visible. */
async function queueFacts(store: SyncAttentionStore, scope: SyncScope, open: OpenSyncIssues) {
  let live: QueueOperation[];
  const unreadable: UnreadableQueueRow[] = store.listUnreadableQueue
    ? await store.listUnreadableQueue(scope).catch((): UnreadableQueueRow[] => []) : [];
  try { live = await liveQueueRows(store, scope); }
  catch { return { queueProjection: 'idle' as const, conflictPending: false, rejectedPending: false, stalled: undefined, unreadable }; }
  const facts = [...live, ...open.queue];
  const projection = queueStatusProjection(facts);
  return { queueProjection: projection === 'idle' && unreadable.length > 0 ? 'syncing' as const : projection,
    conflictPending: hasConflictBarrier(facts), rejectedPending: hasRejectedBarrier(facts), stalled: stalledUploadHead(live), unreadable };
}

/** One page of each live status, the same scan `pendingDurableWorkFacts` makes. */
async function liveQueueRows(store: Pick<SyncAttentionStore, 'listQueue'>, scope: SyncScope): Promise<QueueOperation[]> {
  const live: QueueOperation[] = [];
  for (const status of LIVE_STATUSES) live.push(...(await store.listQueue(scope, status, 0, QUEUE_PAGE)).filter(row => !isSettledRejection(row)));
  return live;
}

/** The sent upload at the head of the lane that the server has kept unsettled for many tries, if any. */
export async function readStalledUpload(store: Pick<SyncAttentionStore, 'listQueue'>, scope: SyncScope) {
  try { return stalledUploadHead(await liveQueueRows(store, scope)); } catch { return undefined; }
}
