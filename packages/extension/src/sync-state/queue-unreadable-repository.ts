import { cursorPage, transactionDone } from './idb.js';
import { describeUnreadable, tryValidateQueueRecord, type UnreadableQueueRow } from './queue-lenient.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import type { SyncStoreRuntime } from './runtime.js';
import type { SyncScope } from './types.js';

/** The statuses the lane and the Status page scan; a row outside them is not part of any lane read. */
const LIVE = ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'set_aside'] as const;
const PAGE = 1_000;

export function createQueueUnreadableRepository(ctx: SyncStoreRuntime) {
  /**
   * Rule C / Rule E: queue rows that cannot be read, described without trusting them. A change that
   * was never sent is quarantined by the next claim; one the server may own keeps the push lane
   * waiting, and Status must be able to say so. Read-only; one bounded page per status.
   */
  async function listUnreadableQueue(input: SyncScope): Promise<UnreadableQueueRow[]> {
    const key = scopeKey(validateScope(input)); const db = await ctx.open();
    const tx = db.transaction(STORES.queue, 'readonly'); const completion = transactionDone(tx);
    const index = tx.objectStore(STORES.queue).index(INDEXES.queueByStatusSequence); const found: UnreadableQueueRow[] = [];
    for (const status of LIVE) {
      const values = await cursorPage<unknown>(index, IDBKeyRange.bound([key, status, 1], [key, status, Number.MAX_SAFE_INTEGER]), PAGE);
      for (const value of values) if (!tryValidateQueueRecord(value, ctx.maxRecordBytes)) found.push(describeUnreadable(value));
    }
    await completion;
    return found.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  }
  return { listUnreadableQueue };
}
