import { conflictResolutionBindings } from './conflict-resolution-bindings.js';
import { cursorPage, iterateCursor, requestValue } from './idb.js';
import { enqueueParentIds, firstLiveQueueRow } from './queue-live-work.js';
import { validateQueueRecord, validateReceipt } from './queue-validate.js';
import { INDEXES, STORES } from './schema.js';
import { SyncStateError, type QueueOperation, type UnknownRecord } from './types.js';

/** Why a change waits out of the lane: an earlier change to the same bookmark is in conflict. */
export const CONFLICT_HOLD = 'conflict_hold';

/**
 * 03-sync §6: a `conflicted` result is terminal and consumes its sequence, so
 * the server lane has already moved past it. The row only waits for the
 * resolution to arrive through Pull. A `revision_conflict` Problem consumed
 * nothing and stays a lane barrier.
 */
export async function consumedConflict(receipts: IDBObjectStore, key: string, row: QueueOperation): Promise<boolean> {
  if (row.status !== 'blocked' || row.recovery?.code !== 'conflict_pending') return false;
  const receipt = await requestValue(receipts.index(INDEXES.queueBySequence).get([key, row.sequence])) as
    { readonly opId?: string; readonly kind?: string } | undefined;
  return receipt?.kind === 'terminal' && receipt.opId === row.opId;
}

/** The row the push lane sends next: the earliest live row that still owns its server sequence. */
export async function firstLaneQueueRow(queue: IDBObjectStore, receipts: IDBObjectStore, key: string,
  maxRecordBytes: number): Promise<QueueOperation | null> {
  let row = await firstLiveQueueRow(queue, key, maxRecordBytes);
  while (row && await consumedConflict(receipts, key, row)) {
    row = await firstLiveQueueRow(queue, key, maxRecordBytes, row.sequence);
  }
  return row;
}

/** Open conflicts and the changes already held for them, in sequence order. */
export async function conflictHolders(queue: IDBObjectStore, key: string, maxRecordBytes: number): Promise<QueueOperation[]> {
  const rows: unknown[] = [];
  for (const [status, code] of [['blocked', 'conflict_pending'], ['set_aside', CONFLICT_HOLD]] as const) {
    await iterateCursor(queue.index(INDEXES.queueByStatusSequence),
      IDBKeyRange.bound([key, status, 1], [key, status, Number.MAX_SAFE_INTEGER]), (value) => {
        if ((value as QueueOperation).recovery?.code === code) rows.push(value);
      });
  }
  return rows.map((value) => validateQueueRecord(value, maxRecordBytes)).sort((left, right) => left.sequence - right.sequence);
}

/**
 * A later change waits for a holder when it rewrites the same bookmark, or
 * places work inside a create the holder still owns. Siblings, children of an
 * existing folder and unrelated bookmarks keep syncing.
 */
export function heldBy(row: QueueOperation, holders: readonly QueueOperation[]): boolean {
  const target = row.payload.targetId; const parents = enqueueParentIds(row.payload);
  return holders.some((holder) => holder.opId !== row.opId
    && ((typeof target === 'string' && (target === holder.payload.targetId || target === `pending-${holder.opId}`))
      || parents.includes(`pending-${holder.opId}`)));
}

/** Only a change that was never sent can leave the lane. */
export function holdable(row: QueueOperation): boolean {
  return row.status === 'pending' && row.attempt === undefined;
}

export function asConflictHold(row: QueueOperation, maxRecordBytes: number): QueueOperation {
  return validateQueueRecord({ ...row, status: 'set_aside', recovery: { code: CONFLICT_HOLD },
    retry: { attempt: row.retry.attempt, notBefore: 0 } }, maxRecordBytes);
}

/** Validates a change about to be queued; one for a bookmark in conflict waits with it instead of joining the lane. */
export async function holdIfWaiting(queue: IDBObjectStore, key: string, input: unknown,
  maxRecordBytes: number): Promise<QueueOperation> {
  const row = validateQueueRecord(input, maxRecordBytes);
  return holdable(row) && heldBy(row, await conflictHolders(queue, key, maxRecordBytes))
    ? asConflictHold(row, maxRecordBytes) : row;
}

/**
 * Holds every never-sent change after `afterSequence` that waits for a holder,
 * in sequence order, so the held changes of one bookmark keep their order and
 * no pending change can overtake one that is held.
 */
export async function holdWaitingRows(queue: IDBObjectStore, key: string, maxRecordBytes: number,
  afterSequence: number): Promise<number> {
  const holders = await conflictHolders(queue, key, maxRecordBytes);
  if (holders.length === 0) return 0;
  const pending = await cursorPage<unknown>(queue.index(INDEXES.queueByStatusSequence),
    IDBKeyRange.bound([key, 'pending', afterSequence + 1], [key, 'pending', Number.MAX_SAFE_INTEGER]), Number.MAX_SAFE_INTEGER);
  let held = 0;
  for (const value of pending) {
    const row = validateQueueRecord(value, maxRecordBytes);
    if (!holdable(row) || !heldBy(row, holders)) continue;
    const updated = asConflictHold(row, maxRecordBytes);
    queue.put(updated); holders.push(updated); held += 1;
  }
  return held;
}

export async function settleResolvedConflictQueue(tx: IDBTransaction, key: string, event: UnknownRecord, maxBytes: number) {
  const bindings = conflictResolutionBindings(event);
  const queueStore = tx.objectStore(STORES.queue);
  for (const binding of bindings) {
    const raw = await requestValue(queueStore.index(INDEXES.queueByOpId).get([key, binding.opId]));
    if (!raw) continue;
    const queued = validateQueueRecord(raw, maxBytes);
    if (queued.status === 'terminal' && queued.echoApplied === true) continue;
    if (queued.status !== 'terminal' && (queued.status !== 'blocked' || queued.recovery?.code !== 'conflict_pending')) {
      throw new SyncStateError('conflict_resolution_binding_invalid');
    }
    const receiptRaw = await requestValue(tx.objectStore(STORES.receipts).index('by_scope_sequence')
      .get([key, queued.sequence]));
    const receipt = receiptRaw ? validateReceipt(key, queued.sequence, receiptRaw, maxBytes) : null;
    const results = Array.isArray(receipt?.result?.results) ? receipt.result.results : [];
    const matched = results.some((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && (candidate as UnknownRecord).opId === binding.opId
      && (binding.conflictId === undefined || (candidate as UnknownRecord).conflictId === binding.conflictId)
      && ['conflicted', 'conflict'].includes(String((candidate as UnknownRecord).status)));
    if (!matched) throw new SyncStateError('conflict_resolution_binding_invalid');
    queueStore.put(validateQueueRecord({ ...queued, status: 'terminal', echoApplied: true, recovery: undefined }, maxBytes));
  }
}
