import { boundedString, clone, safeInteger } from './codec.js';
import { requestValue, requireActiveScope, runTransaction, transactionDone } from './idb.js';
import { asHeld, DEPENDENT_HOLDS, firstLaneQueueRow, heldBy, holdWaitingRows, laneHolders } from './queue-hold.js';
import { validateQueueRecord } from './queue-validate.js';
import type { SyncStoreRuntime } from './runtime.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type LeaseRecord, type QueueOperation, type SyncScope } from './types.js';

/** Rows that own no server sequence: refused history and held work. A gap realign parks them after live work. */
export function parkedOutOfLane(row: QueueOperation): boolean {
  return row.status === 'rejected' || row.status === 'set_aside';
}

/** Rows held out of the push lane for one item's problem, so the rest keeps syncing. */
export function createQueueSetAsideRepository(ctx: SyncStoreRuntime) {
  /**
   * Holds rows out of the push lane (`set_aside`) because of one item's
   * problem. Only a pending row without an attempt qualifies: a row that was
   * sent, claimed or awaits a receipt may already own its server sequence. A
   * held row keeps its slot until the next gap realign parks it after the
   * surviving work, exactly as for rejected rows, so it never stalls them.
   * Later changes of the same bookmark are held with it.
   */
  async function setAsideQueue(input: SyncScope, sequences: readonly number[], code: string): Promise<QueueOperation[]> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input)); boundedString(code, 'recovery code');
    for (const sequence of sequences) safeInteger(sequence, 'sequence', 1);
    const db = await ctx.writableDatabase(); const held: QueueOperation[] = [];
    await runTransaction(db, [STORES.scopes, STORES.queue], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const queue = tx.objectStore(STORES.queue);
      for (const sequence of [...new Set(sequences)].sort((left, right) => left - right)) {
        const value = await requestValue(queue.index(INDEXES.queueBySequence).get([key, sequence]));
        if (!value) throw new SyncStateError('queue_not_found');
        const row = validateQueueRecord(value, ctx.maxRecordBytes);
        if (row.status === 'set_aside') { held.push(row); continue; }
        if (row.status !== 'pending' || row.attempt !== undefined) throw new SyncStateError('set_aside_refused');
        const updated = asHeld(row, code, ctx.maxRecordBytes);
        queue.put(updated); held.push(updated);
      }
      if (held.length > 0) await holdWaitingRows(queue, key, ctx.maxRecordBytes, held[0]!.sequence);
    });
    return held.map((row) => clone(row));
  }

  /**
   * Returns held rows to the push lane in their own slots. A held row was never
   * sent and every gap realign parks it after the surviving work, so its slot
   * is still ahead of the server lane: releasing it in place leaves no hole to
   * heal and keeps its order with the rest of its bookmark's changes. A row
   * already released is skipped.
   */
  function releaseSetAsideQueue(input: SyncScope, sequences: readonly number[]): Promise<QueueOperation[]> {
    for (const sequence of sequences) safeInteger(sequence, 'sequence', 1);
    return releaseInPlace(input, async (queue, key) => {
      const rows: QueueOperation[] = [];
      for (const sequence of [...new Set(sequences)].sort((left, right) => left - right)) {
        const value = await requestValue(queue.index(INDEXES.queueBySequence).get([key, sequence]));
        const row = value ? validateQueueRecord(value, ctx.maxRecordBytes) : null;
        if (row?.status === 'set_aside') rows.push(row);
      }
      return rows;
    });
  }

  /**
   * Releases the changes held only for something that is now settled: the
   * conflict's resolution arrived through Pull, or the held item was released.
   * A change still waiting for an open conflict, a held item, or an earlier
   * change that stays held keeps waiting.
   */
  function releaseSettledHolds(input: SyncScope): Promise<QueueOperation[]> {
    return releaseInPlace(input, async (queue, key) => {
      const holders = await laneHolders(queue, key, ctx.maxRecordBytes);
      const dependent = (row: QueueOperation) => row.status === 'set_aside' && DEPENDENT_HOLDS.has(row.recovery?.code ?? '');
      const kept = holders.filter((row) => !dependent(row)); const released: QueueOperation[] = [];
      for (const row of holders) {
        if (!dependent(row)) continue;
        if (heldBy(row, kept)) kept.push(row); else released.push(row);
      }
      return released;
    });
  }

  /**
   * Sets aside a claimed change the push worker cannot send as it is, because
   * its placement or identity cannot be proven. It has no attempt, so it owns
   * no server sequence; the changes waiting for it are held with it, and the
   * rest of the lane keeps going.
   */
  async function setAsideClaimedPush(input: SyncScope, sequence: number, ownerId: string, fence: number,
    code: string): Promise<void> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input)); safeInteger(sequence, 'sequence', 1);
    boundedString(ownerId, 'ownerId'); safeInteger(fence, 'fence', 1); boundedString(code, 'recovery code');
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.leases, STORES.queue], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const lease = await requestValue(tx.objectStore(STORES.leases).get(key)) as LeaseRecord | undefined;
      const queue = tx.objectStore(STORES.queue);
      const value = await requestValue(queue.index(INDEXES.queueBySequence).get([key, sequence]));
      const row = value ? validateQueueRecord(value, ctx.maxRecordBytes) : null;
      if (!lease || lease.ownerId !== ownerId || lease.fence !== fence || !row || row.status !== 'claimed'
          || row.retry.ownerId !== ownerId || row.retry.fence !== fence) throw new SyncStateError('stale_fence');
      if (row.attempt !== undefined) throw new SyncStateError('set_aside_refused');
      queue.put(asHeld(row, code, ctx.maxRecordBytes));
      await holdWaitingRows(queue, key, ctx.maxRecordBytes, sequence);
    });
  }

  async function releaseInPlace(input: SyncScope,
    pick: (queue: IDBObjectStore, key: string) => Promise<QueueOperation[]>): Promise<QueueOperation[]> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    const db = await ctx.writableDatabase(); const released: QueueOperation[] = [];
    await runTransaction(db, [STORES.scopes, STORES.queue], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const queue = tx.objectStore(STORES.queue);
      for (const row of await pick(queue, key)) {
        const record = validateQueueRecord({ ...row, status: 'pending', recovery: undefined,
          retry: { attempt: row.retry.attempt, notBefore: 0 } }, ctx.maxRecordBytes);
        queue.put(record); released.push(record);
      }
    });
    return released.map((row) => clone(row));
  }

  /** The row the push lane sends next, past conflicts the server already consumed; null when none. */
  async function firstLaneQueue(input: SyncScope): Promise<QueueOperation | null> {
    const key = scopeKey(validateScope(input)); const db = await ctx.open();
    const tx = db.transaction([STORES.queue, STORES.receipts], 'readonly'); const completion = transactionDone(tx);
    const row = await firstLaneQueueRow(tx.objectStore(STORES.queue), tx.objectStore(STORES.receipts), key,
      ctx.maxRecordBytes);
    await completion; return row ? clone(row) : null;
  }

  return { setAsideQueue, releaseSetAsideQueue, releaseSettledHolds, setAsideClaimedPush, firstLaneQueue };
}
