import { digestJson } from './bookmark-event-codec.js';
import { COLP_QUEUE_STAMP } from './colp-queue-stamp.js';
import type { JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;
export async function queueRejoinOperation(store: Store, scope: SyncScope, mapping: MappingInput, revision: string,
  type: 'update_node_content' | 'move_node', value: JsonObject) {
  const hex = digestJson({ scope: { ...scope }, targetId: mapping.colpId, revision, type, value }).slice(7);
  const opId = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
  if (await store.getQueueByOpId(scope, opId)) return;
  const payload = { type, opId, targetId: mapping.colpId, baseRevision: revision,
    occurredAt: new Date().toISOString(), dependencies: [], payload: value };
  await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId,
    digest: digestJson(payload), endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: revision,
    operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload }, COLP_QUEUE_STAMP);
}
