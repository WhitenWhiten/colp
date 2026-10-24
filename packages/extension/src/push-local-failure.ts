import { classifySyncFailure } from './sync-failure-class.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Identical local failures a never-sent change may collect before it leaves the lane as one item. */
export const LOCAL_FAILURE_HOLD_ATTEMPTS = 5;

/**
 * A change that fails in this browser before it is ever sent (its native parent
 * cannot be read, its bytes cannot be bound) owns no server sequence, so
 * retrying it at the head of the lane only holds every later upload, and
 * nothing reported it. After the same failure five times it is set aside as
 * one item: it shows up in Status and the Sync center, Retry captures it
 * afresh, and the rest of the lane keeps going.
 *
 * A pause or an authority problem is about the browser, not the change, and
 * stays a retry. A change that was sent keeps its attempt and sequence until
 * the server settles it, as the protocol requires.
 */
export async function holdRepeatedLocalFailure(input: {
  readonly store: Pick<ReturnType<typeof createSyncStateStore>, 'setAsideClaimedPush'>;
  readonly scope: SyncScope; readonly ownerId: string;
}, queue: QueueOperation, fence: number, reason: string): Promise<boolean> {
  const policy = classifySyncFailure(reason);
  if (queue.attempt !== undefined || queue.recovery?.code !== reason
      || queue.retry.attempt + 1 < LOCAL_FAILURE_HOLD_ATTEMPTS
      || policy?.class === 'transient' || policy?.class === 'authority') return false;
  try { await input.store.setAsideClaimedPush(input.scope, queue.sequence, input.ownerId, fence, reason); return true; }
  catch { return false; /* the row keeps its retry and the next drain tries the hold again */ }
}

/**
 * A-F7: an upload policy (a subscribed folder, the bootstrap boundary) that refuses a change
 * after this drain bound its attempt but before any byte left. The attempt owns no server
 * sequence, so its bound bytes are dropped (same payload, digest and key) and the failure is
 * counted like any other never-sent one: kept as a retry, then held as one item after
 * LOCAL_FAILURE_HOLD_ATTEMPTS identical refusals. The caller only offers rows whose attempt it
 * bound itself in this drain; an attempt from an earlier drain may have been received and is never
 * dropped. Returns the attempt-less row, or undefined when the failure is a pause or an authority
 * problem (those stay retries) or the attempt could not be dropped.
 */
export async function dropUnsentAttempt(input: {
  readonly store: Pick<ReturnType<typeof createSyncStateStore>, 'rebaseClaimedPush'>;
  readonly scope: SyncScope; readonly ownerId: string;
}, queue: QueueOperation, fence: number, reason: string): Promise<QueueOperation | undefined> {
  const policy = classifySyncFailure(reason);
  if (queue.attempt === undefined || policy?.class === 'transient' || policy?.class === 'authority') return undefined;
  try {
    return await input.store.rebaseClaimedPush(input.scope, queue.sequence, input.ownerId, fence, {
      payload: queue.payload, digest: queue.digest, idempotencyKey: queue.idempotencyKey,
      baseRevision: queue.baseRevision });
  } catch { return undefined; /* the attempt stays bound and the failure stays a plain retry */ }
}
