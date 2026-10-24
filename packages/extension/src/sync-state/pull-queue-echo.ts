import { requestValue } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { tryValidateQueueRecord } from './queue-lenient.js';
import { validateQueueRecord } from './queue-validate.js';

/**
 * Record that this opId's authoritative Pull echo landed. Queue rows are never pruned.
 * A row that cannot be read (Rule C) is left as it is: the echo is applied either way, and one
 * unreadable upload must not abort the page that carries it.
 */
export async function markQueuePullEchoApplied(
  tx: IDBTransaction, key: string, operationId: unknown, maxBytes: number,
): Promise<void> {
  if (typeof operationId !== 'string' || operationId.length < 1) return;
  const queue = tx.objectStore(STORES.queue);
  const queued = await requestValue(queue.index(INDEXES.queueByOpId).get([key, operationId]));
  if (!queued) return;
  const record = tryValidateQueueRecord(queued, maxBytes);
  if (!record || record.echoApplied === true) return;
  queue.put(validateQueueRecord({ ...record, echoApplied: true }, maxBytes));
}
