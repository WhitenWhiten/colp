import { boundedString, clone, safeInteger } from './codec.js';
import { requestValue, requireActiveScope, runTransaction } from './idb.js';
import { validateQueueRecord } from './queue-validate.js';
import type { SyncStoreRuntime } from './runtime.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type JsonObject, type QueueOperation, type SyncScope } from './types.js';

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
        const updated = validateQueueRecord({ ...row, status: 'set_aside', recovery: { code },
          retry: { attempt: row.retry.attempt, notBefore: 0 } }, ctx.maxRecordBytes);
        queue.put(updated); held.push(updated);
      }
    });
    return held.map((row) => clone(row));
  }

  /**
   * Returns held rows to the push lane at its tail, in their original order,
   * under fresh sequences. They were never sent, so new operation bytes and a
   * new idempotency identity are safe (the gap realign makes the same move);
   * the opId stays, so mappings and import plans still find them. The push
   * worker rebases placement at send time. A row already released is skipped.
   */
  async function releaseSetAsideQueue(input: SyncScope, sequences: readonly number[],
    digestOperation: (operation: JsonObject) => string): Promise<QueueOperation[]> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input));
    for (const sequence of sequences) safeInteger(sequence, 'sequence', 1);
    if (typeof digestOperation !== 'function') throw new SyncStateError('operation_validator_missing');
    const db = await ctx.writableDatabase(); const released: QueueOperation[] = [];
    await runTransaction(db, [STORES.scopes, STORES.queue, STORES.sequences], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const queue = tx.objectStore(STORES.queue); const counters = tx.objectStore(STORES.sequences);
      const counter = await requestValue(counters.get(key)) as { scopeKey: string; next: number } | undefined;
      if (!counter) throw new SyncStateError('sequence_missing');
      const rows: QueueOperation[] = [];
      for (const sequence of [...new Set(sequences)].sort((left, right) => left - right)) {
        const value = await requestValue(queue.index(INDEXES.queueBySequence).get([key, sequence]));
        const row = value ? validateQueueRecord(value, ctx.maxRecordBytes) : null;
        if (row?.status === 'set_aside') rows.push(row);
      }
      let next = counter.next;
      for (const row of rows) {
        if (next === Number.MAX_SAFE_INTEGER) throw new SyncStateError('sequence_exhausted');
        queue.delete([key, row.sequence]);
        const sequence = next; next += 1;
        const payload = { ...row.payload, sequence };
        const record = validateQueueRecord({ ...row, sequence, payload,
          digest: boundedString(digestOperation(payload), 'operation digest'),
          idempotencyKey: `${row.opId}.release.${sequence}`, status: 'pending', recovery: undefined, attempt: undefined,
          retry: { attempt: row.retry.attempt, notBefore: 0 } }, ctx.maxRecordBytes);
        queue.add({ ...record, scopeKey: key }); released.push(record);
      }
      if (next !== counter.next) counters.put({ scopeKey: key, next });
    });
    return released.map((row) => clone(row));
  }

  return { setAsideQueue, releaseSetAsideQueue };
}
