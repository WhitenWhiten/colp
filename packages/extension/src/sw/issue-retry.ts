import type { RecaptureQueueRow } from '../queue-recapture.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from '../sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'retrySequenceBlocked' | 'releaseSetAsideQueue'>;

/** How an upload that did not go through is tried again: the same bytes once more, or captured afresh. */
export type QueueRetryKind = 'exact' | 'recapture';

export function queueRetryKind(row: Pick<QueueOperation, 'status' | 'recovery'> | null | undefined): QueueRetryKind | undefined {
  if (row?.status === 'blocked' && row.recovery?.code === 'sequence_blocked') return 'exact';
  return row?.status === 'set_aside' ? 'recapture' : undefined;
}

/**
 * Puts one upload through its checks again: the Status card's Try again and the Sync center's Retry for the
 * item do exactly this. A held change returns to the push lane from a fresh capture, where every placement and
 * identity check runs again; an upload the server keeps blocking is sent again with its bytes unchanged.
 * Throws when it cannot (the caller reports the code); the caller wakes the engine afterwards.
 */
export async function retryQueueIssue(store: Store, scope: SyncScope, row: QueueOperation,
  recapture: RecaptureQueueRow): Promise<'exact_retry_requested' | 'recapture_completed'> {
  if (queueRetryKind(row) === 'exact') {
    await store.retrySequenceBlocked(scope, row.opId);
    return 'exact_retry_requested';
  }
  await store.releaseSetAsideQueue(scope, [row.sequence], recapture);
  return 'recapture_completed';
}
