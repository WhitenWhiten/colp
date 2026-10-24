import { LOCAL_FAILURE_HOLD_ATTEMPTS } from './push-local-failure.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

/**
 * A-F2: a proxy, firewall or DLP product can answer one request with an unnamed 401/403/410
 * (no Problem body) while the credential, the Session and the replica are fine. The answer is
 * about that change, not about the browser's authority; treating it as authority froze Pull and
 * Push for the whole replica, refreshed the Session, unfroze, re-sent the same bytes and froze
 * again for ever.
 *
 * The change is therefore tried a bounded number of times; the Session endpoint is asked for a
 * fresh credential (a different request that only a real authority problem can fail); and when
 * that works and the same bytes keep being refused, the one change leaves the lane as an item.
 * The bytes were refused, so the server did not execute them: dropping their bound attempt
 * (re-authoring) cannot hide a committed change.
 */
export const REQUEST_REFUSED = 'push_request_refused';
/** Unexplained refusals of one change, with a working credential, before it leaves the lane. */
export const REQUEST_REFUSED_ATTEMPTS = LOCAL_FAILURE_HOLD_ATTEMPTS;
/**
 * Items the network may refuse before it stops being "one bookmark's problem". Past this many
 * open items the refusals are treated as an authority problem (the old freeze) instead of
 * emptying the queue one change at a time.
 */
export const MAX_REFUSED_ITEMS = 5;
const ITEM_SCAN = 200;

/**
 * The reasons an unexplained 401/403/410 leaves on a row. An attempt that fails for another
 * reason in between is not a repeat of the refusal.
 */
export const DENIAL_REASONS: ReadonlySet<string> = new Set([
  'push_denial_unrecognized', 'push_authority_response_invalid', 'push_authority_denied',
  'push_authority_expired', 'push_denial_escalated',
]);

type ContainmentStore = Pick<ReturnType<typeof createSyncStateStore>,
  'rebaseClaimedPush' | 'setAsideClaimedPush' | 'listQueue'>;

/** The previous try of this row was also an unexplained refusal, so the refusal repeats. */
export function repeatsDenial(queue: QueueOperation): boolean {
  return queue.recovery !== undefined && DENIAL_REASONS.has(queue.recovery.code);
}

/**
 * Sets the claimed change aside as `push_request_refused`. Returns false (the caller then keeps
 * the authority path) when too many changes are already held for the same reason or when the
 * hold itself cannot be written; the row is then still replayable.
 */
export async function holdRefusedRequest(input: {
  readonly store: ContainmentStore; readonly scope: SyncScope; readonly ownerId: string;
}, queue: QueueOperation, fence: number): Promise<boolean> {
  try {
    const held = (await input.store.listQueue(input.scope, 'set_aside', 0, ITEM_SCAN))
      .filter((row) => row.recovery?.code === REQUEST_REFUSED);
    if (held.length >= MAX_REFUSED_ITEMS) return false;
    // Same bytes and key: only the bound attempt goes, which is what lets a row leave the lane.
    if (queue.attempt !== undefined) {
      await input.store.rebaseClaimedPush(input.scope, queue.sequence, input.ownerId, fence, {
        payload: queue.payload, digest: queue.digest, idempotencyKey: queue.idempotencyKey,
        baseRevision: queue.baseRevision });
    }
    await input.store.setAsideClaimedPush(input.scope, queue.sequence, input.ownerId, fence, REQUEST_REFUSED);
    return true;
  } catch { return false; /* the row keeps its retry and the next drain tries again */ }
}
