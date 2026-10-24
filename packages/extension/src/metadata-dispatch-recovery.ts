import { freezeScopeRecovery } from './pull-recovery-freeze.js';
import { dropUnsentAttempt } from './push-local-failure.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

/**
 * The person withdrew consent to sync tags and descriptions after a change that carries them was
 * queued; the dispatch gate refuses it before any byte leaves.
 *
 * - A change whose attempt this drain bound itself (`unsent`) was never sent. It leaves the lane as
 *   one item (`metadata_sync_disabled`), changes to other bookmarks go on, and nothing freezes
 *   (A-F6). Its bytes are dropped, never rewritten: Retry captures it afresh under the policy in
 *   force.
 * - A change whose attempt may have been received keeps its immutable evidence: it is retained
 *   `blocked` and the replica enters the existing user-confirmed rebuild exit.
 */
export async function stopDeniedMetadataAttempt(input: { error: unknown; store: ReturnType<typeof createSyncStateStore>;
  scope: SyncScope; queue: QueueOperation; ownerId: string; fence: number; now: () => number;
  readonly unsent?: boolean }): Promise<'held' | 'recovery' | false> {
  if (!(input.error instanceof Error) || input.error.message !== 'metadata_sync_disabled') return false;
  if (input.unsent) {
    const row = await dropUnsentAttempt(input, input.queue, input.fence, 'metadata_sync_disabled');
    if (row) {
      try {
        await input.store.setAsideClaimedPush(input.scope, row.sequence, input.ownerId, input.fence, 'metadata_sync_disabled');
        return 'held';
      } catch { /* the change keeps its place and the next drain holds it again */ }
    }
  }
  await input.store.settleClaimedPush(input.scope, input.queue.sequence, input.ownerId, input.fence,
    { outcome: 'blocked', retry: { attempt: input.queue.retry.attempt, notBefore: input.queue.retry.notBefore },
      recovery: { code: 'metadata_sync_disabled' } });
  await freezeScopeRecovery(input.store, input.scope, 'metadata_sync_disabled', input.now);
  return 'recovery';
}
