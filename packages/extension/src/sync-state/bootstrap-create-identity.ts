import { bootstrapOpId, bootstrapRunInFlight } from '../bootstrap/run-identity.js';
import { cursorPage, requestValue, scopeRowsRange } from './idb.js';
import { validateQueueRecord } from './queue-validate.js';
import { INDEXES, STORES } from './schema.js';
import type { BookmarkEventRecord, BootstrapRunRecord, JsonObject } from './types.js';

/** Both producers claim the same operation inside the queue's write transaction. */
export async function bootstrapCreateIdentity(tx: IDBTransaction, key: string,
  event: BookmarkEventRecord, operation: JsonObject, maxBytes: number) {
  if (event.kind !== 'create' || operation.type !== 'create_node') return null;
  const runs = await cursorPage<BootstrapRunRecord>(tx.objectStore(STORES.bootstrapRuns),
    scopeRowsRange(key), Number.POSITIVE_INFINITY);
  const run = runs.filter(row => bootstrapRunInFlight(row.phase))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (!run) return null;
  const opId = bootstrapOpId(run.confirmationId, 'create', event.nativeId);
  const prior = await requestValue(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, opId]));
  const queued = prior ? validateQueueRecord(prior, maxBytes) : null;
  // The scan already owns this native. Keep its original bytes, receipt and mapping;
  // the callback records the same ownership without allocating another sequence.
  if (queued) tx.objectStore(STORES.bookmarkEvents).put({ ...event, status: 'processed', opId });
  return { opId, queued };
}
