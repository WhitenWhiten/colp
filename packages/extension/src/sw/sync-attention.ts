import { readOpenSyncIssues, type OpenSyncIssues } from '../sync-issues.js';
/**
 * S7 / B2 (SR-09 · SR-11 · SR-13): the read-only service-worker side of the
 * popup/settings attention exits.
 *
 * Everything here is a read. The two facts the UI cannot get from an existing
 * channel are the scope's `metadata.recoveryCode` (the code the terminal freeze
 * actually recorded, see `freezeScopeRecovery`) and a queue projection computed
 * from live rows; both come from the same pure helpers the public engine state
 * uses (`queueStatusProjection`/`hasConflictBarrier`/`hasRejectedBarrier`), so
 * the aggregate can never disagree with `known.sync.engine.status` about what
 * the queue is doing. No engine wake, no write, no user gesture.
 */
import { hasConflictBarrier, hasRejectedBarrier, queueStatusProjection, stalledUploadHead } from '../engine-public-stability.js';
import type { NativeWaitStore } from '../native-wait.js';
import { syncAttentionTerminalCode } from '../sync-attention-ui.js';
import type { SyncAttentionResponse } from '../types.js';
import type { createSyncStateStore, QueueOperation, SyncScope } from '../sync-state-store.js';

export type SyncAttentionStore = NativeWaitStore & Pick<ReturnType<typeof createSyncStateStore>,
  'getEngineState' | 'listQueue'> & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'listPullIssues' | 'listLocalIssues' | 'listOpenIngressIssues' | 'listPullPages' | 'listPullEventsByPage'>>;

export interface SyncAttentionDeps {
  readonly scope: () => Promise<SyncScope>;
  readonly store: SyncAttentionStore;
  readonly openIssues?: OpenSyncIssues;
  readonly rebuildPending?: () => Promise<boolean>;
}

/** Same status set `pendingDurableWorkFacts` live-scans (engine.ts), bounded to one page each. */
const LIVE_STATUSES = ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'rejected', 'set_aside'] as const;
const QUEUE_PAGE = 1_000;

export async function handleSyncAttentionRequest(deps: SyncAttentionDeps): Promise<SyncAttentionResponse> {
  if (await deps.rebuildPending?.()) return { ok: true, attention: {
    recoveryFrozen: true, queueProjection: 'idle', conflictPending: false, rejectedPending: false,
    nativeWaitPending: false, waitCount: 0, terminal: true, terminalCode: 'replica_rebuild_pending', phase: 'recovery',
    lastError: 'replica_rebuild_pending',
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
    const open = deps.openIssues ?? await readOpenSyncIssues(deps.store, scope);
    const waits = open.waits;
    const { stalled, ...queue } = await queueFacts(deps.store, scope, open);
    const issues = [...open.pull.map(row => ({ direction: 'pull' as const, code: row.code,
      ...(row.title ? { title: row.title } : {}) })),
      // A sent upload the server keeps unsettled holds the lane; it is reported, not set aside.
      ...(stalled ? [{ direction: 'push' as const, code: stalled.code }] : []),
      ...open.deletes.map(row => ({ direction: 'pull' as const, code: 'remote_delete_confirmation_required', title: row.title })),
      ...open.local.map(row => ({ direction: 'local' as const, code: row.code, ...(row.title ? { title: row.title } : {}) })),
      ...open.replica.map(row => ({ direction: 'pull' as const, code: row.code })),
      ...open.queue.map(row => ({ direction: 'push' as const, code: row.recovery?.code ?? 'push_rejected' }))];
    return { ok: true, attention: {
      ...(engine?.phase ? { phase: engine.phase } : {}),
      recoveryFrozen: engine?.recoveryFrozen === true,
      retryAutomatic: engine?.phase !== 'error' && terminalCode === undefined,
      ...(engine?.notBefore ? { retryAt: engine.notBefore } : {}),
      ...queue,
      issueCount: open.total + (stalled ? 1 : 0), issues, rebuildAvailable: engine?.recoveryFrozen === true || open.total > 0,
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
  try { live = await liveQueueRows(store, scope); }
  catch { return { queueProjection: 'idle' as const, conflictPending: false, rejectedPending: false, stalled: undefined }; }
  const facts = [...live, ...open.queue];
  return { queueProjection: queueStatusProjection(facts), conflictPending: hasConflictBarrier(facts),
    rejectedPending: hasRejectedBarrier(facts), stalled: stalledUploadHead(live) };
}

/** One page of each live status, the same scan `pendingDurableWorkFacts` makes. */
async function liveQueueRows(store: Pick<SyncAttentionStore, 'listQueue'>, scope: SyncScope): Promise<QueueOperation[]> {
  const live: QueueOperation[] = [];
  for (const status of LIVE_STATUSES) live.push(...(await store.listQueue(scope, status, 0, QUEUE_PAGE)).filter(row => row.recovery?.code !== 'recaptured'));
  return live;
}

/** The sent upload at the head of the lane that the server has kept unsettled for many tries, if any. */
export async function readStalledUpload(store: Pick<SyncAttentionStore, 'listQueue'>, scope: SyncScope) {
  try { return stalledUploadHead(await liveQueueRows(store, scope)); } catch { return undefined; }
}
