import type { CompactionWatermark } from '../sync-compaction.js';
import { compactNativeEventDetails } from '../compacted-native-facts.js';
import { requestValue, scopeRowsRange } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import type { AckIntentRecord, BookmarkEventRecord, DeletionJournalRecord, QueueOperation,
  ReceiptRecord, UnknownRecord } from './types.js';
import { removeRetentionMark, retainedLongEnough, retentionBatch } from './history-retention-io.js';
import { isSettledRejection, withReceiptOutcome } from './open-issue-facts.js';
import { RECEIPT_MAX_AGE_MS } from '../automation/receipt-limits.js';
import { CREATE_RECEIPT_SUMMARY, retainAutomationCreate, retainCreateSummary } from './automation-receipt-evidence.js';

/** Longer than both the ten-minute batch undo and five-minute native echo windows.
 * Legacy rows receive a full grace period on their first eligible observation. */
export const SYNC_HISTORY_RETENTION_MS = 24 * 60 * 60_000;
export interface HistoryRetentionState {
  readonly queueAfter?: IDBValidKey | null;
  readonly rejectedAfter?: IDBValidKey | null;
  readonly consumedThroughSequence?: number;
  readonly eventAfter?: IDBValidKey | null;
  readonly ackAfter?: IDBValidKey | null;
  readonly deletionAfter?: IDBValidKey | null;
  readonly summaryAfter?: IDBValidKey | null;
}
export interface HistoryRetentionReport {
  readonly queue: number; readonly events: number; readonly acks: number;
  readonly deletionJournal: number; readonly summaries: number;
  /** Rows this pass could not interpret and stepped over (W2A-12); they stay in place. */
  readonly damaged: number;
}
export const HISTORY_RETENTION_STORES = [STORES.engine, STORES.intents,
  STORES.pullPages, STORES.pullEvents, STORES.ackIntents, STORES.recovery,
  STORES.deletionJournal, STORES.mappings, STORES.advancedPlans, STORES.bootstrapRuns] as const;

export async function pruneSyncHistory(tx: IDBTransaction, key: string, now: number,
  batch: number): Promise<HistoryRetentionReport> {
  const watermarks = tx.objectStore(STORES.compactionWatermarks);
  const watermark = await requestValue(watermarks.get(key)) as CompactionWatermark;
  const prior = watermark.retention ?? {};
  const next: Record<string, IDBValidKey | null> = {};
  const removed = { queue: 0, events: 0, acks: 0, deletionJournal: 0, summaries: 0 };
  const damaged = { count: 0 };
  const queue = tx.objectStore(STORES.queue), events = tx.objectStore(STORES.bookmarkEvents);
  const receipts = tx.objectStore(STORES.receipts), acks = tx.objectStore(STORES.ackIntents);
  const cursor = await requestValue(tx.objectStore(STORES.cursors).get(key)) as UnknownRecord | undefined;
  const evidence = cursor?.evidence as UnknownRecord | undefined;
  // W2A-04: a change set aside for a person's decision is one item's problem. It pins the deletion journal
  // (a stale create could resurrect a removed native) but not the reclamation of everything settled around it.
  const strictQuiet = await historyHasNoLiveWork(tx, key, true);
  const quiet = strictQuiet || await historyHasNoLiveWork(tx, key, false);
  const consumedThrough = Math.max(prior.consumedThroughSequence ?? 0, await highestConsumedSequence(receipts, key));
  next.consumedThroughSequence = consumedThrough;
  const latest = { ...watermark.latestCompleteAck };
  let bootstrapReferences: Promise<ReadonlySet<string> | null> | undefined;
  // The latest completed Ack of each kind remains a durable activation proof.
  next.ackAfter = await retentionBatch<AckIntentRecord>(acks, resume(key, prior.ackAfter), batch, async row => {
    if (row.state !== 'complete') return;
    if (!latest[row.kind]) { latest[row.kind] = row.intentId; return; }
    if (latest[row.kind] === row.intentId || row.cursor === cursor?.cursor) return;
    if (row.kind === 'bootstrap') {
      const references = await (bootstrapReferences ??= referencedBootstrapCursors(tx, key));
      if (!references || references.has(row.cursor)) return;
    }
    if (!await aged('ack', row.intentId)) return;
    acks.delete([key, row.intentId]); forget('ack', row.intentId); removed.acks += 1;
  }, damaged);

  next.eventAfter = await retentionBatch<BookmarkEventRecord>(events.index(INDEXES.eventByStatusOrdinal),
    statusRange(key, 'processed', prior.eventAfter), batch, async row => {
      if (row.opId === null) return;
      const queued = await requestValue(queue.index(INDEXES.queueByOpId)
        .get([key, row.opId])) as QueueOperation | undefined;
      const summaries = tx.objectStore(STORES.compactSummaries);
      // Reclaim events before their queue row. Missing or mismatched authority
      // stays available for repair rather than being inferred from a summary.
      if (!quiet || !queued) return;
      const receipt = await terminalReceipt(tx, key, queued);
      if (!closedRejection(queued) && !receipt) return;
      summaries.put({ scopeKey: key, kind: 'event', id: row.eventId,
        digest: row.dedupeKey, opId: row.opId, ordinal: row.ordinal });
      if (row.details.compacted !== true) events.put({ ...row, details: compactNativeEventDetails(row) });
      if (!await operationAged('event', row.eventId, queued)) return;
      await retainAutomationCreate(tx, key, queued, receipt, row.nativeId);
      events.delete([key, row.eventId]); forget('event', row.eventId);
      tx.objectStore(STORES.compactSummaries).delete([key, 'event', row.eventId]); removed.events += 1;
    }, damaged);

  next.queueAfter = await retentionBatch<QueueOperation>(queue.index(INDEXES.queueByStatusSequence),
    statusRange(key, 'terminal', prior.queueAfter), batch, async row => {
      if (!quiet) return;
      const receipt = await terminalReceipt(tx, key, row);
      if (!receipt || receipt.receiptId === evidence?.receiptId) return;
      if (!await operationAged('queue', row.opId, row)) return;
      if (await requestValue(events.index(INDEXES.eventByOperationOrdinal)
        .count(IDBKeyRange.bound([key, row.opId], [key, row.opId, []])))) return;
      await retainAutomationCreate(tx, key, row, receipt);
      queue.delete([key, row.sequence]); receipts.delete([key, receipt.receiptId]); forget('queue', row.opId);
      tx.objectStore(STORES.compactSummaries).delete([key, 'queue', row.opId]); removed.queue += 1;
    }, damaged);
  next.rejectedAfter = await retentionBatch<QueueOperation>(queue.index(INDEXES.queueByStatusSequence),
    statusRange(key, 'rejected', prior.rejectedAfter), batch, async row => {
      if (!quiet || !closedRejection(row) || removed.queue >= batch || !await aged('queue', row.opId)) return;
      const receipt = await requestValue(receipts.index(INDEXES.queueBySequence).get([key, row.sequence])) as ReceiptRecord | undefined;
      if (receipt?.receiptId === evidence?.receiptId) return;
      if (await requestValue(events.index(INDEXES.eventByOperationOrdinal)
        .count(IDBKeyRange.bound([key, row.opId], [key, row.opId, []])))) return;
      queue.delete([key, row.sequence]); forget('queue', row.opId);
      // A settled, locally superseded row need not have a receipt of its own;
      // the higher consumed sequence proves the server lane passed its slot.
      if (receipt) receipts.delete([key, receipt.receiptId]);
      tx.objectStore(STORES.compactSummaries).delete([key, 'queue', row.opId]); removed.queue += 1;
    }, damaged);

  // Journal entries prevent stale bootstrap creates from resurrecting locally
  // removed natives. Only a settled, acknowledged scope with no unresolved
  // terminal echoes may release them. Keep mappings of restored natives intact.
  const terminal = await requestValue<QueueOperation[]>(queue.index(INDEXES.queueByStatusSequence)
    .getAll(statusRange(key, 'terminal'), 2));
  const terminalSettled = terminal.length === 0 || terminal.length === 1 && Boolean(await terminalReceipt(tx, key, terminal[0]!));
  const journalSettled = strictQuiet && terminalSettled
    && !await requestValue(queue.index(INDEXES.queueByStatusSequence).count(statusRange(key, 'rejected')))
    && await cursorHasCompleteAck(acks, key, cursor?.cursor, latest);
  next.deletionAfter = await retentionBatch<DeletionJournalRecord>(tx.objectStore(STORES.deletionJournal),
    resume(key, prior.deletionAfter), batch, async row => {
      if (!journalSettled) return;
      if (await requestValue(tx.objectStore(STORES.mappings).get([key, row.nativeId]))) return;
      const id = JSON.stringify([row.nativeId, row.ordinal]);
      if (!await aged('deletion', id)) return;
      tx.objectStore(STORES.deletionJournal).delete([key, row.nativeId, row.ordinal]);
      forget('deletion', id); removed.deletionJournal += 1;
    }, damaged);

  // Older releases left summaries behind permanently, including after reset or
  // history pruning. Remove orphan summaries and bookkeeping in bounded passes.
  next.summaryAfter = await retentionBatch<UnknownRecord>(tx.objectStore(STORES.compactSummaries),
    resume(key, prior.summaryAfter), batch, async row => {
      const exists = row.kind === CREATE_RECEIPT_SUMMARY ? await retainCreateSummary(tx, key, row, now)
        : await summarySourceExists(tx, key, row);
      if (exists) return;
      tx.objectStore(STORES.compactSummaries).delete([key, String(row.kind), String(row.id)]);
      removed.summaries += 1;
    }, damaged);
  watermarks.put({ ...watermark, latestCompleteAck: latest, retention: next });
  return { ...removed, damaged: damaged.count };

  function aged(kind: string, id: string) { return retainedLongEnough(tx, key, kind, id, now, SYNC_HISTORY_RETENTION_MS); }
  function operationAged(kind: string, id: string, row: QueueOperation) {
    const retention = row.payload.type === 'move_node' ? Math.max(SYNC_HISTORY_RETENTION_MS, RECEIPT_MAX_AGE_MS + 1)
      : SYNC_HISTORY_RETENTION_MS;
    return retainedLongEnough(tx, key, kind, id, now, retention);
  }
  function forget(kind: string, id: string) { removeRetentionMark(tx, key, kind, id); }
  function closedRejection(row: QueueOperation) { return isSettledRejection(row) && row.sequence < consumedThrough; }
}

function resume(key: string, after?: IDBValidKey | null): IDBKeyRange {
  return after ? IDBKeyRange.bound(after, [key, []], true) : scopeRowsRange(key);
}
function statusRange(key: string, status: string, after?: IDBValidKey | null): IDBKeyRange {
  return IDBKeyRange.bound(after ?? [key, status, 0], [key, status, Number.MAX_SAFE_INTEGER], Boolean(after));
}

/** `heldItemsPin`: whether a change set aside for a decision counts as live work. */
async function historyHasNoLiveWork(tx: IDBTransaction, key: string, heldItemsPin: boolean): Promise<boolean> {
  const engine = await requestValue(tx.objectStore(STORES.engine).get(key)) as UnknownRecord | undefined;
  if (engine?.recoveryFrozen || engine?.authorityRefreshRequired
      || await requestValue(tx.objectStore(STORES.recovery).count(scopeRowsRange(key)))) return false;
  const acks = await requestValue<AckIntentRecord[]>(tx.objectStore(STORES.ackIntents).getAll(scopeRowsRange(key), 201));
  if (acks.length > 200 || acks.some(row => row.state === 'pending')) return false;
  const plans = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.advancedPlans).getAll(scopeRowsRange(key), 201));
  if (plans.length > 200 || plans.some(row => row.state !== 'completed')) return false;
  const runs = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.bootstrapRuns).getAll(scopeRowsRange(key), 201));
  if (runs.length > 200 || runs.some(row => !row.previewOnly && row.phase !== 'completed' && row.phase !== 'draft')) return false;
  const scope = await requestValue(tx.objectStore(STORES.scopes).get(key)) as UnknownRecord;
  if (scope.firstRun === 'running') return false;
  for (const status of heldItemsPin ? ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'set_aside']
    : ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown']) {
    if (await requestValue(tx.objectStore(STORES.queue).index(INDEXES.queueByStatusSequence).count(statusRange(key, status)))) return false;
  }
  if (await requestValue(tx.objectStore(STORES.bookmarkEvents).index(INDEXES.eventByStatusOrdinal)
    .count(statusRange(key, 'pending')))) return false;
  for (const state of ['staged', 'blocked']) if (await requestValue(tx.objectStore(STORES.pullPages)
    .index(INDEXES.pullPageByState).count(IDBKeyRange.bound([key, state], [key, state, []])))) return false;
  for (const state of ['staged', 'intent_prepared', 'browser_call_started', 'native_event_observed',
    'awaiting_confirmation', 'authority_committed', 'blocked']) if (await requestValue(tx.objectStore(STORES.pullEvents)
    .index(INDEXES.pullEventByState).count(IDBKeyRange.bound([key, state], [key, state, []])))) return false;
  for (const state of ['result_unknown', 'waiting_dependency']) if (await requestValue(tx.objectStore(STORES.intents)
    .index(INDEXES.intentByNativeResult).count(IDBKeyRange.bound([key, state], [key, state, []])))) return false;
  if (await requestValue(tx.objectStore(STORES.intents).index(INDEXES.intentByRepairJob).count(scopeRowsRange(key)))) return false;
  if (await requestValue(tx.objectStore(STORES.intents).index(INDEXES.intentByWaitReason).count(scopeRowsRange(key)))) return false;
  return true;
}

async function terminalReceipt(tx: IDBTransaction, key: string, row: QueueOperation): Promise<ReceiptRecord | null> {
  if (row.status !== 'terminal' || row.echoApplied !== true || row.recovery?.resultStatus === 'rejected') return null;
  const receipt = await requestValue(tx.objectStore(STORES.receipts).index(INDEXES.queueBySequence)
    .get([key, row.sequence])) as ReceiptRecord | undefined;
  if (!receipt || receipt.kind !== 'terminal' || receipt.opId !== row.opId || receipt.operationDigest !== row.digest
      || withReceiptOutcome(row, receipt).recovery?.resultStatus === 'rejected') return null;
  return receipt;
}

async function highestConsumedSequence(receipts: IDBObjectStore, key: string): Promise<number> {
  const index = receipts.index(INDEXES.queueBySequence);
  let through = Number.MAX_SAFE_INTEGER;
  for (let examined = 0; examined < 200 && through > 0; examined += 1) {
    const cursor = await requestValue(index.openCursor(IDBKeyRange.bound([key, 1], [key, through]), 'prev'));
    if (!cursor) return 0;
    const receipt = cursor.value as ReceiptRecord;
    if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) return 0;
    if (receipt.kind === 'terminal') return receipt.sequence;
    through = receipt.sequence - 1;
  }
  return 0;
}

async function cursorHasCompleteAck(acks: IDBObjectStore, key: string, cursor: unknown,
  latest: Partial<Record<'pull' | 'bootstrap', string>>): Promise<boolean> {
  for (const id of Object.values(latest)) {
    const ack = await requestValue(acks.get([key, id])) as AckIntentRecord | undefined;
    if (ack?.state === 'complete' && ack.cursor === cursor) return true;
  }
  return false;
}

async function referencedBootstrapCursors(tx: IDBTransaction, key: string): Promise<ReadonlySet<string> | null> {
  const cursors = new Set<string>();
  for (const name of [STORES.advancedPlans, STORES.bootstrapRuns]) {
    const rows = await requestValue<UnknownRecord[]>(tx.objectStore(name).getAll(scopeRowsRange(key), 201));
    if (rows.length > 200) return null;
    for (const row of rows) {
      for (const cursor of [row.snapshotCursor, (row.metadata as UnknownRecord | undefined)?.remoteCursor]) {
        if (typeof cursor === 'string') cursors.add(cursor);
      }
    }
  }
  return cursors;
}

async function summarySourceExists(tx: IDBTransaction, key: string, row: UnknownRecord): Promise<boolean> {
  let kind = row.kind, id = row.id;
  if (kind === 'retention') {
    try { [kind, id] = JSON.parse(String(id)) as string[]; } catch { return true; }
  }
  if (kind === 'queue') return Boolean(await requestValue(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).getKey([key, String(id)])));
  if (kind === 'event') return Boolean(await requestValue(tx.objectStore(STORES.bookmarkEvents).getKey([key, String(id)])));
  if (kind === 'ack') return Boolean(await requestValue(tx.objectStore(STORES.ackIntents).getKey([key, String(id)])));
  if (kind === CREATE_RECEIPT_SUMMARY) return Boolean(await requestValue(tx.objectStore(STORES.compactSummaries)
    .getKey([key, CREATE_RECEIPT_SUMMARY, String(id)])));
  if (kind === 'deletion') {
    try { const [nativeId, ordinal] = JSON.parse(String(id)) as [string, number];
      return Boolean(await requestValue(tx.objectStore(STORES.deletionJournal).getKey([key, nativeId, ordinal])));
    } catch { return true; }
  }
  return true;
}
