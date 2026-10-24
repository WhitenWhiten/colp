import { readReplicaRepairCapability } from '../replica-repair-capability.js';
import { isSettledRejection } from '../sync-state/open-issue-facts.js';
import { snapshotSyncIssues, localIssueId, pullIssueId } from '../sync-issue-snapshot.js';
import { issueCeilingWarning } from '../sync-issue-ceiling.js';
import { pullLocalActions, pushLocalActions } from '../sync-issue-local-actions.js';
import { withResolvedTitles } from '../sync-issue-titles.js';
import { readOpenSyncIssues, type OpenSyncIssues } from '../sync-issues.js';
/** Shared attention facts and action capabilities. Reading may restore derived issue
 * projections from historical receipts; it never wakes the engine or touches native data. */
import { hasConflictBarrier, hasRejectedBarrier, queueStatusProjection, stalledUploadHead } from '../engine-public-stability.js';
import type { NativeWaitStore } from '../native-wait.js';
import { syncAttentionTerminalCode } from '../sync-attention-ui.js';
import { circuitIsStopped } from '../sync-circuit-breaker.js';
import { refreshesReplicaIntegrity } from '../sync-failure-class.js';
import type { SyncWatchdog } from './sync-watchdog.js';
import type { SyncAttentionResponse } from '../types.js';
import type { createSyncStateStore, QueueOperation, SyncScope } from '../sync-state-store.js';

export type SyncAttentionStore = NativeWaitStore & Pick<ReturnType<typeof createSyncStateStore>,
  'getEngineState' | 'listQueue'> & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'listConsumedQueueIssues' | 'listBootstrapRuns' | 'listMappings' | 'getMappingByColpId' | 'listPullIssues' | 'listLocalIssues' | 'listOpenIngressIssues' | 'listPullPages' | 'listPullEventsByPage'>>;

export interface SyncAttentionDeps {
  readonly scope: () => Promise<SyncScope>;
  readonly store: SyncAttentionStore;
  readonly openIssues?: OpenSyncIssues;
  readonly rebuildPending?: () => Promise<boolean>;
  /** Whether the browser still lets this extension read and change bookmarks. Absent: not checked. */
  readonly bookmarkPermission?: () => Promise<boolean>;
  /** Why this browser's reports to the server keep failing, if they have for a while. Absent: not checked. */
  readonly healthDelivery?: (scope: SyncScope) => Promise<{ readonly code: string; readonly since: number } | undefined>;
  /** Notices a stall nothing else explains, and knows when a pass last ended cleanly. Absent: not checked. */
  readonly watchdog?: SyncWatchdog;
}

/** Open issues whose own sentence says the browser checks them automatically: they need nobody. */
const AUTOMATIC_ISSUE_CODES: ReadonlySet<string> = new Set(['waiting_dependency', 'dependency_pending', 'dependency_parked']);

/** Same status set `pendingDurableWorkFacts` live-scans (engine.ts), bounded to one page each. */
const LIVE_STATUSES = ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'rejected', 'set_aside'] as const;
const QUEUE_PAGE = 1_000;

export async function handleSyncAttentionRequest(deps: SyncAttentionDeps): Promise<SyncAttentionResponse> {
  if (await deps.rebuildPending?.()) return { ok: true, attention: {
    recoveryFrozen: true, queueProjection: 'idle', conflictPending: false, rejectedPending: false,
    nativeWaitPending: false, waitCount: 0, terminal: true, terminalCode: 'replica_rebuild_pending', phase: 'recovery',
    lastError: 'replica_rebuild_pending', rebuildAvailable: true,
  } };
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
    // Set up, then access removed: the engine returns before it does anything, so no error is ever recorded.
    const setUp = recorded?.firstRun === 'completed' || recorded?.firstRun === 'running';
    const permissionRequired = setUp && deps.bookmarkPermission !== undefined && !await deps.bookmarkPermission();
    // A breaker that tripped on something that ends by itself resumes at `notBefore`: a pause, not a stop.
    const coolingDown = terminalCode === undefined && circuitIsStopped(engine) && !refreshesReplicaIntegrity(lastError);
    const healthDelivery = await deps.healthDelivery?.(scope).catch(() => undefined);
    const open = deps.openIssues ?? await readOpenSyncIssues(deps.store, scope);
    const capability = await readReplicaRepairCapability(deps.store, scope, open);
    const waits = open.waits;
    const { stalled, ...queue } = await queueFacts(deps.store, scope, open);
    // Only a stall that nothing else names is the watchdog's to tell.
    const watch = await deps.watchdog?.sample({ scope, engine, explained: permissionRequired || terminalCode !== undefined
      || coolingDown || lastError !== undefined || queue.conflictPending || queue.rejectedPending
      || recorded?.firstRun === 'running' || ['offline', 'error', 'recovery', 'retired'].includes(engine?.phase ?? '') });
    // A move or delete names its target by id; the mapping still knows what it was called.
    const named = await withResolvedTitles(snapshotSyncIssues(open), scope, deps.store.getMappingByColpId?.bind(deps.store));
    const issues = named.map(issue => {
      const local = open.local.find(row => issue.direction === 'local' && row.code === issue.code
        && localIssueId(row) === issue.issueId);
      const operation = open.queue.find(row => row.opId === issue.opId);
      const merge = open.bootstrap.find(row => row.issueId === issue.issueId);
      const remote = issue.direction === 'pull' && issue.nodeId
        ? open.pull.find(row => row.nodeId === issue.nodeId && pullIssueId(row.nodeId) === issue.issueId) : undefined;
      // What this device can do about the item: the card shows exactly these buttons (K5).
      const localActions = operation ? pushLocalActions(operation) : remote ? pullLocalActions(remote) : [];
      return { ...issue, ...(localActions.length ? { localActions } : {}), ...(AUTOMATIC_ISSUE_CODES.has(issue.code) ? { recovery: 'automatic' as const } : {}),
        ...(operation?.recovery?.expectedSequence ? { dependencySequence: operation.recovery.expectedSequence } : {}), ...(merge ? { reportId: merge.reportId, itemId: merge.itemId, recovery: 'decision' as const } : {}), ...(local ? { eventId: local.eventId, dependencyOpId: local.dependencyOpId,
        dependencyEventId: local.dependencyEventId, rootCause: local.rootCause, attempts: local.attempts,
        recovery: local.recovery } : {}) };
    });
    if (stalled) issues.push({ direction: 'push', code: stalled.code } as typeof issues[number]);
    return { ok: true, attention: {
      ...(engine?.phase ? { phase: engine.phase } : {}),
      recoveryFrozen: engine?.recoveryFrozen === true,
      retryAutomatic: engine?.phase !== 'error' && terminalCode === undefined,
      ...(engine?.notBefore ? { retryAt: engine.notBefore } : {}),
      ...(coolingDown ? { coolingDown: true } : {}),
      ...(engine?.circuitBreaker?.trips ? { breakerTrips: engine.circuitBreaker.trips } : {}),
      ...(permissionRequired ? { permissionRequired: true } : {}),
      ...(healthDelivery ? { healthDelivery } : {}),
      ...(watch?.verdict ? { watchdog: watch.verdict } : {}),
      ...(watch?.lastSyncedAt ? { lastSyncedAt: watch.lastSyncedAt } : {}),
      ...queue,
      issueCount: open.total + (stalled ? 1 : 0), issues, rebuildAvailable: capability.rebuildAvailable,
      ...(issueCeilingWarning(open.operationalTotal) ? { issueCeiling: issueCeilingWarning(open.operationalTotal)! } : {}),
      ...(capability.reason ? { rebuildUnavailableReason: capability.reason } : {}),
      retryAvailable: Boolean(stalled) || open.queue.some(row => row.recovery?.code === 'sequence_blocked' && row.attempt !== undefined),
      // A wait for a parent folder ends when the parent arrives; only the others wait for a person.
      nativeWaitPending: waits.some(wait => wait.waitReason !== 'waiting_dependency'),
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
  try { live = await liveQueueRows(store, scope); }
  catch { return { queueProjection: 'idle' as const, conflictPending: false, rejectedPending: false, stalled: undefined }; }
  const facts = [...live, ...open.queue];
  return { queueProjection: queueStatusProjection(facts), conflictPending: hasConflictBarrier(facts),
    rejectedPending: hasRejectedBarrier(facts), stalled: stalledUploadHead(live) };
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
