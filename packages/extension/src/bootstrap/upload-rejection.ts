import { BootstrapUploadExcludedError } from './upload-boundary.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from '../sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'settleClaimedPush' | 'putIngressDiagnostic'>;

export async function rejectExcludedBootstrapUpload(store: Store, scope: SyncScope, queue: QueueOperation,
  ownerId: string, fence: number, error: unknown): Promise<'rejected'> {
  await store.settleClaimedPush(scope, queue.sequence, ownerId, fence,
    { outcome: 'rejected', recovery: { code: 'bootstrap_upload_excluded' } });
  const code = error instanceof BootstrapUploadExcludedError ? error.reason : 'unselected_range';
  await store.putIngressDiagnostic(scope, { code }, { sourceId: `queued:${queue.opId}` });
  return 'rejected';
}
