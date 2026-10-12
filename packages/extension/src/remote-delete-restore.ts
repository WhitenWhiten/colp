import { digestJson, validateOperation } from './bookmark-event-codec.js';
import type { RemoteDeleteDecisionRecord } from './sync-state/remote-delete-repository.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

export async function enqueueRemoteDeleteRestore(store: Store, scope: SyncScope,
  decision: RemoteDeleteDecisionRecord, now: number) {
  const opId = decision.restoreOpId;
  if (!opId) throw new Error('remote_delete_restore_op_missing');
  const existing = await store.getQueueByOpId(scope, opId);
  if (existing) return existing;
  return store.allocateSequenceAndEnqueue(scope, {
    opId, batchId: opId, idempotencyKey: opId, digest: 'sha256:pending', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: decision.deleteRevision,
    operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: {
      type: 'restore_node', opId, targetId: decision.targetId, baseRevision: decision.deleteRevision,
      occurredAt: new Date(now).toISOString(), dependencies: [],
      payload: { reason: 'remote_delete_restore' },
    },
  }, { validateOperation, digestOperation: digestJson });
}
