import { bootstrapOpId, bootstrapRunInFlight } from '../bootstrap/run-identity.js';
import { cursorPage, requestValue, scopeRowsRange } from './idb.js';
import { validateQueueRecord } from './queue-validate.js';
import { INDEXES, STORES } from './schema.js';
import type { BookmarkEventRecord, BootstrapRunRecord, JsonObject, MappingInput, QueueOperation, ReceiptRecord, RemoteObservationRecord } from './types.js';

/** Both producers claim the same operation inside the queue's write transaction. */
export async function bootstrapCreateIdentity(tx: IDBTransaction, key: string,
  event: BookmarkEventRecord, operation: JsonObject, maxBytes: number) {
  if (event.kind !== 'create' || operation.type !== 'create_node') return null;
  const runs = await cursorPage<BootstrapRunRecord>(tx.objectStore(STORES.bootstrapRuns),
    scopeRowsRange(key), Number.POSITIVE_INFINITY);
  const ordered = runs.filter(run => !run.previewOnly).sort((left, right) => right.updatedAt - left.updatedAt);
  const mapping = await requestValue(tx.objectStore(STORES.mappings).get([key, event.nativeId])) as MappingInput | undefined;
  // Completion does not end ownership. A callback may reach the inbox after the
  // scanner's receipt, or while a later range bootstrap is already running.
  if (mapping) for (const run of ordered) {
    const opId = bootstrapOpId(run.confirmationId, 'create', event.nativeId);
    const prior = await requestValue(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, opId]));
    if (!prior) continue;
    const queued = validateQueueRecord(prior, maxBytes);
    if (queued.status === 'rejected' || queued.payload.type !== 'create_node') continue;
    if (await createOwnsMapping(tx, key, queued, mapping)) {
      tx.objectStore(STORES.bookmarkEvents).put({ ...event, status: 'processed', opId });
      return { opId, queued };
    }
  }
  const run = ordered.find(row => bootstrapRunInFlight(row.phase));
  if (!run) return null;
  const opId = bootstrapOpId(run.confirmationId, 'create', event.nativeId);
  const prior = await requestValue(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, opId]));
  const queued = prior ? validateQueueRecord(prior, maxBytes) : null;
  if (queued) tx.objectStore(STORES.bookmarkEvents).put({ ...event, status: 'processed', opId });
  return { opId, queued };
}

async function createOwnsMapping(tx: IDBTransaction, key: string, queued: QueueOperation, mapping: MappingInput) {
  if (mapping.colpId === `pending-${queued.opId}`) return true;
  if (queued.status !== 'terminal') return false;
  const receipt = await requestValue(tx.objectStore(STORES.receipts).index(INDEXES.queueBySequence)
    .get([key, queued.sequence])) as ReceiptRecord | undefined;
  const results = receipt?.result?.results;
  const result = Array.isArray(results) && results.length === 1 ? results[0] : undefined;
  const observation = await requestValue(tx.objectStore(STORES.remoteObservations)
    .get([key, mapping.colpId])) as RemoteObservationRecord | undefined;
  return observation?.kind !== 'tombstone' && receipt?.kind === 'terminal'
    && receipt.opId === queued.opId && receipt.operationDigest === queued.digest
    && !!result && typeof result === 'object' && !Array.isArray(result)
    && result.opId === queued.opId && result.sequence === queued.sequence && result.targetId === mapping.colpId
    && (result.status === 'applied' || result.status === 'rebased');
}
