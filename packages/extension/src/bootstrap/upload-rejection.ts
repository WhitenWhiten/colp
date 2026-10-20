import { BootstrapUploadExcludedError } from './upload-boundary.js';
import { QueuedUploadExcludedError } from '../queued-upload-boundary.js';
import { freezeScopeRecovery } from '../pull-recovery-freeze.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from '../sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'settleClaimedPush' | 'putIngressDiagnostic'>;

export async function rejectExcludedBootstrapUpload(store: Store, scope: SyncScope, queue: QueueOperation,
  ownerId: string, fence: number, error: unknown): Promise<'rejected'> {
  await store.settleClaimedPush(scope, queue.sequence, ownerId, fence,
    { outcome: 'rejected', recovery: { code: error instanceof QueuedUploadExcludedError ? error.code : 'bootstrap_upload_excluded' } });
  const code = error instanceof BootstrapUploadExcludedError || error instanceof QueuedUploadExcludedError ? error.reason : 'unselected_range';
  await store.putIngressDiagnostic(scope, { code }, { sourceId: `queued:${queue.opId}` });
  return 'rejected';
}

export async function settleExcludedQueuedUpload(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  queue: QueueOperation, ownerId: string, fence: number, error: unknown, neverSent: boolean, now: () => number) {
  if (!neverSent) {
    // A lost response is not proof of cancellation. Withdrawn consent stops
    // replaying content while preserving immutable evidence for local reset.
    await store.settleClaimedPush(scope, queue.sequence, ownerId, fence,
      { outcome: 'blocked', retry: { attempt: queue.retry.attempt, notBefore: queue.retry.notBefore },
        recovery: { code: 'upload_boundary_changed' } });
    await freezeScopeRecovery(store, scope, 'upload_boundary_changed', now);
    return 'recovery' as const;
  }
  const outcome = await rejectExcludedBootstrapUpload(store, scope, queue, ownerId, fence, error);
  // A never-published ordinary create has no canonical identity to retain.
  // Leaving its pending mapping behind would prevent a later authorized scan
  // from capturing it again after the user rejoins the range.
  if (queue.payload.type === 'create_node' && !queue.opId.startsWith('b3.')) {
    const mapping = await store.getMappingByColpId(scope, `pending-${queue.opId}`);
    if (mapping) await store.deleteMapping(scope, mapping.nativeId);
  }
  return outcome;
}
