import { requestValue } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { validateQueueRecord } from './queue-validate.js';

/** Record that this opId's authoritative Pull echo landed. Queue rows are never pruned. */
export async function markQueuePullEchoApplied(
  tx: IDBTransaction, key: string, operationId: unknown, maxBytes: number,
): Promise<void> {
  if (typeof operationId !== 'string' || operationId.length < 1) return;
  const queue = tx.objectStore(STORES.queue);
  const queued = await requestValue(queue.index(INDEXES.queueByOpId).get([key, operationId]));
  if (!queued) return;
  const record = validateQueueRecord(queued, maxBytes);
  if (record.echoApplied === true) return;
  queue.put(validateQueueRecord({ ...record, echoApplied: true }, maxBytes));
}
