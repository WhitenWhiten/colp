import { boundedString } from './codec.js';
import { iterateCursor, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { tryValidateQueueRecord } from './queue-lenient.js';
import { validateQueueRecord } from './queue-validate.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type JsonObject, type QueueOperation, type SyncScope } from './types.js';

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
    let lastKey: readonly [string, string, unknown] | null = null; let scanned = 0;
    await iterateCursor(index, range, (value, cursor) => {
      const cursorKey = cursor.key as unknown as readonly [string, string, unknown];
      // Resume strictly after the previous page's last key.
      if (after !== null && String(cursorKey[2]) === String(after[2])) return undefined;
      // An unreadable row is the claim's to quarantine (Rule C), not a reason to fail this read.
      const row = tryValidateQueueRecord(value, maxBytes);
      if (row) rows.push(row);
      lastKey = cursorKey; scanned += 1;
      if (scanned >= QUEUE_TARGET_PAGE_SIZE) return false;
      return undefined;
    });
    await completion;
    all.push(...rows);
    if (scanned < QUEUE_TARGET_PAGE_SIZE || lastKey === null) return all;
    after = lastKey;
  }
}
