import { mappingLooksAuthoritative, type SaveStatusFacts, type SaveStatusPaint } from './save-status.js';
import type { BookmarkEventRecord, QueueOperation, SyncScope } from './sync-state/types.js';

const LIVE_QUEUE = new Set(['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'set_aside']);

export interface SaveStatusStore {
  getScope(scope: SyncScope): Promise<{ readonly firstRun?: string } | null>;
  getMappingByNativeId(scope: SyncScope, nativeId: string): Promise<{
    readonly colpId: string; readonly projection: { readonly revision: string };
  } | null>;
  listBookmarkEvents(scope: SyncScope, afterOrdinal?: number, limit?: number): Promise<readonly BookmarkEventRecord[]>;
  listBookmarkEventsByNative?(scope: SyncScope, nativeId: string, afterOrdinal?: number, limit?: number): Promise<readonly BookmarkEventRecord[]>;
  getQueueByOpId(scope: SyncScope, opId: string): Promise<QueueOperation | null>;
  listProjectionIntents(scope: SyncScope): Promise<readonly {
    readonly nativeId?: string; readonly observedNativeId?: string; readonly state: string;
  }[]>;
  getEngineState(scope: SyncScope): Promise<{ readonly phase: string } | null>;
  listBootstrapRuns(scope: SyncScope): Promise<readonly { readonly phase: string; readonly updatedAt: number }[]>;
  listApplyIntents?(scope: SyncScope): Promise<readonly { readonly nativeResult?: string; readonly waitReason?: string;
    readonly nativeParentId?: string | null; readonly apiResultEvidence?: { readonly nativeId?: unknown } | null }[]>;
}

export async function collectSaveStatusFacts(input: {
  readonly store: SaveStatusStore; readonly scope: SyncScope; readonly nativeId: string;
  readonly inSyncRange: boolean; readonly paint: SaveStatusPaint; readonly localCreateSucceeded: boolean;
  readonly online: boolean; readonly enhancementFailed?: boolean;
}): Promise<SaveStatusFacts> {
  const recorded = await input.store.getScope(input.scope);
  const firstRun = recorded?.firstRun ?? 'none';
  const firstRunIncomplete = firstRun !== 'completed' && firstRun !== 'running';
  const mapping = await input.store.getMappingByNativeId(input.scope, input.nativeId);
  const events = await eventsForNative(input.store, input.scope, input.nativeId);
  const pendingInbox = events.some((event) => event.status === 'pending');
  const queueRows: QueueOperation[] = [];
  for (const event of events) {
    if (!event.opId) continue;
    const row = await input.store.getQueueByOpId(input.scope, event.opId);
    if (row) queueRows.push(row);
  }
  const relatedConflict = queueRows.some((row) => row.status === 'blocked' && row.recovery?.code === 'conflict_pending');
  const relatedRejected = queueRows.some((row) => row.status === 'rejected');
  const relatedHeld = queueRows.some((row) => row.status === 'set_aside');
  const relatedReuseUnknown = queueRows.some((row) => row.status === 'unknown'
    && (row.recovery?.code === 'sequence_reuse' || row.recovery?.code === 'op_id_reused'));
  const relatedLive = queueRows.some((row) => LIVE_QUEUE.has(row.status));
  const relatedTerminal = queueRows.some((row) => row.status === 'terminal');
  const intents = await input.store.listProjectionIntents(input.scope);
  const relatedIntents = intents.filter((intent) => intent.nativeId === input.nativeId
    || intent.observedNativeId === input.nativeId);
  const intentPending = relatedIntents.some((intent) => intent.state === 'pending' || intent.state === 'executing'
    || intent.state === 'recovery' || intent.state === 'ambiguous');
  const applyEvidence = relatedIntents.some((intent) => intent.state === 'terminal')
    || mappingLooksAuthoritative(mapping);
  const engine = await input.store.getEngineState(input.scope);
  const runs = await input.store.listBootstrapRuns(input.scope);
  const latestRun = [...runs].sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const mappingAuthoritative = mappingLooksAuthoritative(mapping);
  const awaitingIngress = input.localCreateSucceeded && input.inSyncRange && events.length === 0 && !mapping;
  const pendingWork = pendingInbox || relatedLive || intentPending || awaitingIngress || firstRun === 'running';
  const applyWaits = input.store.listApplyIntents
    ? (await input.store.listApplyIntents(input.scope)).filter((intent) =>
      intent.nativeResult === 'result_unknown' || intent.waitReason === 'native_result_unknown')
    : [];
  const nativeWait = applyWaits.some((intent) => intent.nativeParentId === input.nativeId
    || intent.apiResultEvidence?.nativeId === input.nativeId);
  const needsAttention = relatedConflict || relatedRejected || relatedHeld || relatedReuseUnknown
    || relatedIntents.some((intent) => intent.state === 'recovery' || intent.state === 'ambiguous')
    || latestRun?.phase === 'needs_attention'
    || engine?.phase === 'recovery' || engine?.phase === 'error' || nativeWait;
  return {
    paint: input.paint, localCreateSucceeded: input.localCreateSucceeded, inSyncRange: input.inSyncRange,
    firstRunIncomplete, online: input.online, pendingWork, needsAttention, hasConflict: relatedConflict,
    hasAuthoritativeReceipt: relatedTerminal && mappingAuthoritative,
    hasApplyEvidence: applyEvidence && mappingAuthoritative,
    ...(input.enhancementFailed ? { enhancementFailed: true } : {}),
  };
}

async function eventsForNative(store: SaveStatusStore, scope: SyncScope, nativeId: string): Promise<BookmarkEventRecord[]> {
  if (store.listBookmarkEventsByNative) {
    const matched: BookmarkEventRecord[] = [];
    let after = 0;
    for (;;) {
      const rows = await store.listBookmarkEventsByNative(scope, nativeId, after, 1_000);
      matched.push(...rows);
      if (rows.length < 1_000) return matched;
      after = rows.at(-1)!.ordinal;
    }
  }
  const matched: BookmarkEventRecord[] = [];
  let after = 0;
  for (;;) {
    const rows = await store.listBookmarkEvents(scope, after, 1_000);
    for (const event of rows) if (event.nativeId === nativeId) matched.push(event);
    if (rows.length < 1_000) break;
    after = rows.at(-1)!.ordinal;
  }
  return matched;
}
