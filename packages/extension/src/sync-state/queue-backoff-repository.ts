import { safeInteger } from './codec.js';
import { cursorPage, requireActiveScope, runTransaction } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { validateQueueRecord } from './queue-validate.js';
import type { SyncStoreRuntime } from './runtime.js';
import type { SyncScope } from './types.js';

/** Rows a person's Retry may release at once; only the head of the lane can be waiting for anything else. */
const RELEASE_PAGE = 50;

export function createQueueBackoffRepository(ctx: SyncStoreRuntime) {
  /**
   * A person's Retry ends the waiting of the rows that are only waiting: an `unknown` or `deferred`
   * row is due now instead of after its backoff (up to five minutes), so Retry on a stuck upload
   * sends the next try at once instead of seeming to do nothing. Attempt counts, bound attempts,
   * sequences and every other status are untouched; an unreadable row is skipped.
   */
  async function releaseQueueBackoff(input: SyncScope, now: number): Promise<number> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(now, 'now');
    const db = await ctx.writableDatabase(); let released = 0;
    await runTransaction(db, [STORES.scopes, STORES.queue], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const queue = tx.objectStore(STORES.queue);
      for (const status of ['unknown', 'deferred'] as const) {
        const rows = await cursorPage<unknown>(queue.index(INDEXES.queueByStatusSequence),
          IDBKeyRange.bound([key, status, 1], [key, status, Number.MAX_SAFE_INTEGER]), RELEASE_PAGE);
        for (const value of rows) {
          try {
            const row = validateQueueRecord(value, ctx.maxRecordBytes);
            if (row.retry.notBefore <= now) continue;
            queue.put(validateQueueRecord({ ...row, retry: { attempt: row.retry.attempt, notBefore: now } }, ctx.maxRecordBytes));
            released += 1;
          } catch { /* an unreadable row is the quarantine's business, not Retry's */ }
        }
      }
    });
    return released;
  }
  return { releaseQueueBackoff };
}
