import { isOpenQueueIssue } from './open-issue-facts.js';
import { dependsOnIssue, issueAncestry } from '../sync-issues.js';
import { transactionIssueDependencies } from './issue-dependencies.js';
import { conflictResolutionBindings } from './conflict-resolution-bindings.js';
import { cursorPage, iterateCursor, requestValue } from './idb.js';
import { enqueueParentIds, firstLiveQueueRow } from './queue-live-work.js';
import { validateQueueRecord, validateReceipt } from './queue-validate.js';
import { INDEXES, STORES } from './schema.js';
import { SyncStateError, type QueueOperation, type UnknownRecord } from './types.js';

/** Why a change waits out of the lane: an earlier change to the same bookmark is in conflict. */
export const CONFLICT_HOLD = 'conflict_hold';
/** Why a change waits out of the lane: an earlier change to the same bookmark is set aside. */
export const DEPENDENCY_HOLD = 'dependency_hold';
/** Holds that end on their own when what they wait for is settled; any other hold waits for a decision. */
export const DEPENDENT_HOLDS: ReadonlySet<string> = new Set([CONFLICT_HOLD, DEPENDENCY_HOLD]);

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

/** Rows later changes of their bookmark wait for: open conflicts, rejections and held rows, in sequence order. */
export async function laneHolders(queue: IDBObjectStore, key: string, maxRecordBytes: number): Promise<QueueOperation[]> {
  const rows: unknown[] = [];
  for (const status of ['blocked', 'rejected', 'set_aside'] as const) {
    await iterateCursor(queue.index(INDEXES.queueByStatusSequence),
      IDBKeyRange.bound([key, status, 1], [key, status, Number.MAX_SAFE_INTEGER]), (value) => {
        if (isOpenQueueIssue(value as QueueOperation)) rows.push(value);
      });
  }
  return rows.map((value) => validateQueueRecord(value, maxRecordBytes)).sort((left, right) => left.sequence - right.sequence);
}

/**
 * The holder a later change waits for: one that rewrites the same bookmark,
 * or a create the change places work inside. Existing descendants and destination parents share the closure. Siblings
 * and unrelated bookmarks keep syncing.
 */
export function heldBy(row: QueueOperation, holders: readonly QueueOperation[], graph?: Awaited<ReturnType<typeof transactionIssueDependencies>>): QueueOperation | undefined {
  const target = row.payload.targetId; const parents = enqueueParentIds(row.payload);
  const direct = holders.find((holder) => holder.opId !== row.opId
    && ((typeof target === 'string' && (target === holder.payload.targetId || target === `pending-${holder.opId}`))
      || parents.includes(`pending-${holder.opId}`)));
  if (direct || !graph) return direct;
  const targets = [...(typeof target === 'string' ? [target] : []), ...parents, ...(graph.operationParents.get(row.opId) ?? [])];
  const parentMap = new Map([...graph.parents, ...issueAncestry([], holders)]);
  const deleting = row.payload.type === 'delete_node' || row.payload.type === 'delete_subtree';
  const affected = (roots: ReadonlySet<string>) => dependsOnIssue(targets, roots, parentMap)
    || (deleting && typeof target === 'string' && dependsOnIssue([...roots], new Set([target]), parentMap));
  const holder = holders.find(holder => holder.opId !== row.opId && affected(
    new Set([String(holder.payload.targetId ?? `pending-${holder.opId}`)])));
  if (holder) return holder;
  const roots = new Set(graph.independentRoots);
  for (const decision of graph.decisions) if (decision.restoreOpId !== row.opId
      && ['pending', 'applying', 'restoring', 'rejected'].includes(String(decision.state))) roots.add(String(decision.targetId));
  return affected(roots)
    ? { ...row, opId: `external-issue:${row.opId}`, status: 'set_aside' } : undefined;
}

/** Only a change that was never sent can leave the lane. */
export function holdable(row: QueueOperation): boolean {
  return row.status === 'pending' && row.attempt === undefined;
}

export function asHeld(row: QueueOperation, code: string, maxRecordBytes: number): QueueOperation {
  return validateQueueRecord({ ...row, status: 'set_aside', recovery: { code },
    retry: { attempt: row.retry.attempt, notBefore: 0 } }, maxRecordBytes);
}

/** A change waits as long as its holder: behind a conflict, or behind an item that is set aside. */
function dependentHold(holder: QueueOperation): string {
  return holder.status === 'blocked' || holder.recovery?.code === CONFLICT_HOLD ? CONFLICT_HOLD : DEPENDENCY_HOLD;
}

/**
 * Validates a change about to be queued. One the browser already knows it
 * cannot sync is held as that item (`hold`); one for a bookmark that is in
 * conflict or held waits with it instead of joining the lane.
 */
export async function holdIfWaiting(queue: IDBObjectStore, key: string, input: unknown, maxRecordBytes: number,
  hold?: unknown, resolvingEventId?: string): Promise<QueueOperation> {
  const row = validateQueueRecord(input, maxRecordBytes);
  if (!holdable(row)) return row;
  const code = hold && typeof hold === 'object' ? (hold as { readonly code?: unknown }).code : undefined;
  if (typeof code === 'string' && code.length > 0) return asHeld(row, code, maxRecordBytes);
  const holder = heldBy(row, await laneHolders(queue, key, maxRecordBytes), await transactionIssueDependencies(queue, key, resolvingEventId));
  return holder ? asHeld(row, dependentHold(holder), maxRecordBytes) : row;
}

/**
 * Holds every never-sent change after `afterSequence` that waits for a holder,
 * in sequence order, so the held changes of one bookmark keep their order and
 * no pending change can overtake one that is held.
 */
export async function holdWaitingRows(queue: IDBObjectStore, key: string, maxRecordBytes: number,
  afterSequence: number): Promise<number> {
  const holders = await laneHolders(queue, key, maxRecordBytes);
  const graph = await transactionIssueDependencies(queue, key);
  if (holders.length === 0 && graph.roots.size === 0) return 0;
  const pending = await cursorPage<unknown>(queue.index(INDEXES.queueByStatusSequence),
    IDBKeyRange.bound([key, 'pending', afterSequence + 1], [key, 'pending', Number.MAX_SAFE_INTEGER]), Number.MAX_SAFE_INTEGER);
  let held = 0;
  for (const value of pending) {
    const row = validateQueueRecord(value, maxRecordBytes);
    const holder = holdable(row) ? heldBy(row, holders, graph) : undefined;
    if (!holder) continue;
    const updated = asHeld(row, dependentHold(holder), maxRecordBytes);
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
