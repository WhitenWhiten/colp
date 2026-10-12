import { freezeScopeRecovery } from './pull-recovery-freeze.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Retain immutable evidence and enter the existing user-confirmed rebuild exit. */
export async function stopDeniedMetadataAttempt(input: { error: unknown; store: ReturnType<typeof createSyncStateStore>;
  scope: SyncScope; queue: QueueOperation; ownerId: string; fence: number; now: () => number }): Promise<boolean> {
  if (!(input.error instanceof Error) || input.error.message !== 'metadata_sync_disabled') return false;
  await input.store.settleClaimedPush(input.scope, input.queue.sequence, input.ownerId, input.fence,
    { outcome: 'blocked', retry: { attempt: input.queue.retry.attempt, notBefore: input.queue.retry.notBefore },
      recovery: { code: 'metadata_sync_disabled' } });
  await freezeScopeRecovery(input.store, input.scope, 'metadata_sync_disabled', input.now);
  return true;
}
