import { boundedString, safeInteger } from './codec.js';
import { cursorPage, iterateCursor, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { validateQueueRecord } from './queue-validate.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type JsonObject, type QueueOperation, type SyncScope } from './types.js';

/**
 * Rows that address one COLP target, read through `by_scope_target_revision`.
 *
 * The outbound queue is never pruned, so every bounded `listQueue` page stops
 * containing a target's rows as soon as a scope accumulates more rows than one
 * page. Callers that answer "did this specific target commit?" must therefore
 * ask by target, not by scanning a window — a batch undo that scanned the
 * oldest page concluded "no delete row" forever on long-lived scopes and
 * reported success for a restore it never performed.
 *
 * `limit` is optional and OMITTING IT MEANS EVERY ROW. The index orders a
 * target's rows by `operationRevision`, so any window is applied before the
 * caller's filters and a busy target silently loses rows it needs. A caller
 * that must see the whole range (the delete lookup) omits the limit rather
 * than guessing a ceiling the next busy target will exceed.
 */
export async function listQueueRowsByTarget(queue: IDBObjectStore, key: string, targetId: string,
  maxBytes: number, limit?: number): Promise<QueueOperation[]> {
  // `cursorPage` stops when it has `limit` rows; an infinite limit therefore
  // walks the range to exhaustion, which is what an omitted limit means here.
  const values = await cursorPage<QueueOperation>(queue.index(INDEXES.queueByTargetRevision),
    IDBKeyRange.bound([key, targetId], [key, targetId, []]), limit ?? Number.POSITIVE_INFINITY);
  return values.map((value) => validateQueueRecord(value, maxBytes));
}

/**
 * Open the queue read-only and read one target's rows. Lives here rather than in
 * the repository so the window semantics stay next to the index they depend on.
 */
export async function readQueueRowsByTarget(db: IDBDatabase, input: SyncScope, targetId: string,
  maxBytes: number, limit?: number): Promise<QueueOperation[]> {
  if (limit !== undefined) {
    safeInteger(limit, 'limit', 1);
    if (limit > 1_000) throw new SyncStateError('limit_exceeded');
  }
  const key = scopeKey(validateScope(input));
  boundedString(targetId, 'targetId');
  const tx = db.transaction(STORES.queue, 'readonly');
  const completion = transactionDone(tx);
  const values = await listQueueRowsByTarget(tx.objectStore(STORES.queue), key, targetId, maxBytes, limit);
  await completion;
  return values;
}

/** Validate, digest and sequence-stamp one locally staged COLP operation row. */
export function stampColpQueueRecord(input: SyncScope, key: string,
  operation: Omit<QueueOperation, 'sequence' | 'scopeKey'>, sequence: number, maxBytes: number,
  validateOperation: (operation: JsonObject) => boolean,
  digestOperation: (operation: JsonObject) => string): QueueOperation {
  const payload = { ...operation.payload, replicaId: input.replicaId, sequence, collectionId: input.collectionId };
  let schemaValid = false;
  try { schemaValid = validateOperation(payload); } catch { throw new SyncStateError('operation_schema_invalid'); }
  if (!schemaValid) throw new SyncStateError('operation_schema_invalid');
  const digest = boundedString(digestOperation(payload), 'operation digest');
  return validateQueueRecord({ ...operation, scopeKey: key, sequence, digest, payload }, maxBytes);
}

/**
 * Every row for one target, read in pages.
 *
 * Paging rather than one unbounded request: the queue is never pruned, so a busy
 * target's range can be large, and a single read of it holds every row in memory
 * at once (20_000 rows measured ~334s and +54MB in the host environment). Paging
 * keeps the working set to one page while still reaching the end, which is what
 * the delete lookup needs — a bound would truncate before its status filter and
 * lose the row it is looking for.
 *
 * Each page opens its own transaction and skips the keys already returned, so
 * cancellation between pages costs nothing and nothing is held across them.
 */
export const QUEUE_TARGET_PAGE_SIZE = 500;
export async function readAllQueueRowsByTarget(db: IDBDatabase, input: SyncScope, targetId: string,
  maxBytes: number): Promise<QueueOperation[]> {
  const key = scopeKey(validateScope(input));
  boundedString(targetId, 'targetId');
  const all: QueueOperation[] = [];
  let after: readonly [string, string, unknown] | null = null;
  for (;;) {
    const tx = db.transaction(STORES.queue, 'readonly');
    const completion = transactionDone(tx);
    const index = tx.objectStore(STORES.queue).index(INDEXES.queueByTargetRevision);
    const lower: readonly unknown[] = after === null ? [key, targetId] : [key, targetId, after[2]];
    const range = IDBKeyRange.bound(lower, [key, targetId, []]);
    const rows: QueueOperation[] = [];
    let lastKey: readonly [string, string, unknown] | null = null;
    await iterateCursor(index, range, (value, cursor) => {
      const cursorKey = cursor.key as unknown as readonly [string, string, unknown];
      // Resume strictly after the previous page's last key.
      if (after !== null && String(cursorKey[2]) === String(after[2])) return undefined;
      rows.push(validateQueueRecord(value, maxBytes));
      lastKey = cursorKey;
      if (rows.length >= QUEUE_TARGET_PAGE_SIZE) return false;
      return undefined;
    });
    await completion;
    all.push(...rows);
    if (rows.length < QUEUE_TARGET_PAGE_SIZE || lastKey === null) return all;
    after = lastKey;
  }
}
