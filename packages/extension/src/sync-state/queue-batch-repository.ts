import type { SyncStoreRuntime } from './runtime.js';
import { SyncStateError, type LeaseRecord, type QueueOperation, type SyncScope } from './types.js';
import { clone, safeInteger } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { validateQueueRecord } from './queue-validate.js';
import { unavailableImportOpIds } from './import-settle.js';
import { conflictHolders, firstLaneQueueRow, heldBy } from './queue-conflict-hold.js';

export function createQueueBatchRepository(ctx: SyncStoreRuntime) {
  async function claimFollowingQueue(input: SyncScope, ownerId: string, fence: number, now: number,
    sequence: number, limit: number, eligible: (row: QueueOperation) => boolean): Promise<QueueOperation[]> {
    const key = scopeKey(validateScope(input)); safeInteger(limit, 'limit', 1);
    if (limit > 49) throw new SyncStateError('limit_exceeded');
    const db = await ctx.writableDatabase(); const claimed: QueueOperation[] = [];
    await runTransaction(db, [STORES.scopes, STORES.leases, STORES.queue, STORES.receipts, STORES.importPlans,
      STORES.importNodes], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key);
        const lease = await requestValue(tx.objectStore(STORES.leases).get(key)) as LeaseRecord | undefined;
        if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || lease.expiresAt <= now) {
          throw new SyncStateError('stale_fence');
        }
        const queue = tx.objectStore(STORES.queue);
        const head = await firstLaneQueueRow(queue, tx.objectStore(STORES.receipts), key, ctx.maxRecordBytes);
        if (!head || head.sequence !== sequence || head.status !== 'claimed'
            || head.retry.ownerId !== ownerId || head.retry.fence !== fence) throw new SyncStateError('stale_fence');
        const unavailable = await unavailableImportOpIds(tx, key);
        // A change waiting for a conflict is never batched; the next single claim holds it.
        const holders = await conflictHolders(queue, key, ctx.maxRecordBytes);
        const rows = await cursorPage<QueueOperation>(queue.index(INDEXES.queueBySequence),
          IDBKeyRange.bound([key, sequence + 1], [key, Number.MAX_SAFE_INTEGER]), limit);
        for (const raw of rows) {
          const row = validateQueueRecord(raw, ctx.maxRecordBytes);
          if (row.sequence !== sequence + claimed.length + 1 || row.status !== 'pending'
              || row.attempt || row.retry.attempt !== 0 || row.retry.notBefore > now
              || unavailable.has(row.opId) || heldBy(row, holders) || !eligible(row)) break;
          const updated = validateQueueRecord({ ...row, status: 'claimed', retry: { ...row.retry,
            ownerId, fence, claimExpiresAt: lease.expiresAt } }, ctx.maxRecordBytes);
          queue.put(updated); claimed.push(updated);
        }
      });
    return clone(claimed);
  }
  return { claimFollowingQueue };
}
