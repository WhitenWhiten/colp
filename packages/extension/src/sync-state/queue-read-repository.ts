import { boundedString, clone, safeInteger } from './codec.js';
import { requestValue, runTransaction, transactionDone } from './idb.js';
import { withReceiptOutcome } from './open-issue-facts.js';
import { readAllQueueRowsByTarget } from './queue-target.js';
import { validateQueueRecord, validateReceipt } from './queue-validate.js';
import type { SyncStoreRuntime } from './runtime.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type QueueOperation, type ReceiptRecord, type SyncScope } from './types.js';

export const MAX_QUEUE_READ_IDS = 200;
export interface QueueReadEntry {
  readonly queue: QueueOperation;
  readonly receipt: ReceiptRecord | null;
}

export function createQueueReadRepository(ctx: SyncStoreRuntime) {
  async function listQueue(input: SyncScope, status?: QueueOperation['status'], afterSequence = 0, limit = 100): Promise<QueueOperation[]> {
    const key = scopeKey(validateScope(input)); safeInteger(afterSequence, 'afterSequence'); safeInteger(limit, 'limit', 1);
    if (limit > 1_000) throw new SyncStateError('limit_exceeded');
    if (afterSequence === Number.MAX_SAFE_INTEGER) return [];
    const db = await ctx.open(); const tx = db.transaction([STORES.queue, STORES.receipts], 'readonly');
    const completion = transactionDone(tx); const store = tx.objectStore(STORES.queue);
    const source = status ? store.index(INDEXES.queueByStatusSequence) : store.index(INDEXES.queueBySequence);
    const range = status ? IDBKeyRange.bound([key, status, afterSequence + 1], [key, status, Number.MAX_SAFE_INTEGER])
      : IDBKeyRange.bound([key, afterSequence + 1], [key, Number.MAX_SAFE_INTEGER]);
    const values = await requestValue<QueueOperation[]>(source.getAll(range, limit));
    const projected = await Promise.all(values.map(async value => value.status !== 'terminal' ? value
      : withReceiptOutcome(value, await requestValue(tx.objectStore(STORES.receipts)
        .index(INDEXES.queueBySequence).get([key, value.sequence])))));
    await completion;
    return projected.map(value => clone(validateQueueRecord(value, ctx.maxRecordBytes)));
  }

  /** One target's complete paged history, preserving the target index contract. */
  async function listQueueByTarget(input: SyncScope, targetId: string): Promise<QueueOperation[]> {
    return clone(await readAllQueueRowsByTarget(await ctx.open(), input, targetId, ctx.maxRecordBytes));
  }

  async function getQueueByOpId(input: SyncScope, opId: string): Promise<QueueOperation | null> {
    const key = scopeKey(validateScope(input)); boundedString(opId, 'opId');
    const db = await ctx.open(); const tx = db.transaction([STORES.queue, STORES.receipts], 'readonly');
    const completion = transactionDone(tx);
    let value = await requestValue<QueueOperation | undefined>(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, opId]));
    if (value?.status === 'terminal') value = withReceiptOutcome(value,
      await requestValue(tx.objectStore(STORES.receipts).index(INDEXES.queueBySequence).get([key, value.sequence])));
    await completion; return value ? clone(validateQueueRecord(value, ctx.maxRecordBytes)) : null;
  }

  async function getQueueReceipt(input: SyncScope, sequence: number) {
    const key = scopeKey(validateScope(input)); safeInteger(sequence, 'sequence', 1);
    const db = await ctx.open(); const tx = db.transaction(STORES.receipts, 'readonly'); const completion = transactionDone(tx);
    const value = await requestValue(tx.objectStore(STORES.receipts).index(INDEXES.queueBySequence).get([key, sequence]));
    await completion; return value ? clone(validateReceipt(key, sequence, value, ctx.maxRecordBytes)) : null;
  }

  /**
   * A fresh, bounded workset for one caller. Queue identity/status and terminal
   * receipt are read in the same transaction; missing ids are omitted, and
   * unsettled rows never acquire evidence from another attempt or a later read.
   * Neither this repository nor its callers retain the workset across advances.
   */
  async function readQueueEntriesByOpIds(input: SyncScope, opIds: readonly string[]): Promise<QueueReadEntry[]> {
    const key = scopeKey(validateScope(input));
    if (opIds.length > MAX_QUEUE_READ_IDS) throw new SyncStateError('limit_exceeded');
    const ids = [...new Set(opIds.map(id => boundedString(id, 'opId')))];
    if (!ids.length) return [];
    const db = await ctx.open(); const entries: QueueReadEntry[] = [];
    await runTransaction(db, [STORES.queue, STORES.receipts], 'readonly', async tx => {
      const queue = tx.objectStore(STORES.queue).index(INDEXES.queueByOpId);
      const values = await Promise.all(ids.map(id => requestValue<QueueOperation | undefined>(queue.get([key, id]))));
      const rows = values.filter(value => value !== undefined);
      const receipts = tx.objectStore(STORES.receipts).index(INDEXES.queueBySequence);
      const results = await Promise.all(rows.map(row => row.status === 'terminal'
        ? requestValue<ReceiptRecord | undefined>(receipts.get([key, row.sequence])) : undefined));
      for (const [index, row] of rows.entries()) {
        const receipt = results[index];
        entries.push({ queue: clone(validateQueueRecord(withReceiptOutcome(row, receipt), ctx.maxRecordBytes)),
          receipt: receipt ? validateReceipt(key, row.sequence, receipt, ctx.maxRecordBytes) : null });
      }
    });
    return entries;
  }

  return { listQueue, listQueueByTarget, getQueueByOpId, getQueueReceipt, readQueueEntriesByOpIds };
}
