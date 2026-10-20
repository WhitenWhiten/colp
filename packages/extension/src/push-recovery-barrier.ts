import type { QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getEngineState' | 'settleClaimedPush'>;

export async function pushRecoveryBarrierActive(
  store: Store,
  scope: SyncScope,
  allow?: () => boolean | Promise<boolean>,
): Promise<boolean> {
  // Advanced bootstrap may bypass snapshot recovery, never a withdrawn consent.
  if (['metadata_sync_disabled', 'upload_boundary_changed'].includes((await store.getEngineState(scope))?.lastError ?? '')) return true;
  if (await allow?.()) return false;
  return (await store.getEngineState(scope))?.recoveryFrozen === true;
}

export async function releaseClaimForRecovery(input: {
  readonly store: Store;
  readonly scope: SyncScope;
  readonly queue: QueueOperation;
  readonly ownerId: string;
  readonly fence: number;
  readonly now: number;
}): Promise<void> {
  const reason = (await input.store.getEngineState(input.scope))?.lastError;
  await input.store.settleClaimedPush(input.scope, input.queue.sequence, input.ownerId, input.fence, {
    outcome: 'unknown', retry: { attempt: input.queue.retry.attempt, notBefore: input.now },
    recovery: { code: reason === 'create_placement_parent_deleted' || reason === 'create_placement_unproven'
      ? reason : 'queue_recovery_frozen' },
    // Recovery is not a server rejection: an existing attempt may already
    // have committed before its response was lost. Retain its exact bytes.
  });
}
