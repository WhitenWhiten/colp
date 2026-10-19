import { SUBTREE_OBSERVATION_EXTENSION } from '@know-n/colp/sync/canonical';
import { findProcessedBookmarkEvent } from './bookmark-event-pages.js';
import type { ParsedColpProblem } from './sync-push-wire.js';
import type { JsonObject, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

/**
 * A `delete_subtree` the server refused because the folder's members changed
 * on another device: nodes this browser never saw would go with it. Held for a
 * decision; Retry sends the deletion with the current members (03 §13.1).
 */
export const DELETE_SUBTREE_CHANGED = 'delete_subtree_changed';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'rebaseClaimedPush' | 'setAsideClaimedPush' | 'listBookmarkEvents'>;

export function isDeleteOperation(type: unknown): type is 'delete_node' | 'delete_subtree' {
  return type === 'delete_node' || type === 'delete_subtree';
}

/**
 * Settles a `revision_conflict` on a claimed delete whose sequence the server
 * did not consume. Deletion dominates a concurrent update or move, so a stale
 * single delete is rebased on the revision the Problem names and sent again;
 * a subtree delete is rebased the same way when `currentSubtree` proves the
 * members are the nodes this browser observed. Otherwise the row leaves the
 * lane as one item, already carrying the current facts for a "delete anyway"
 * Retry. Returns null when the Problem carries nothing to rebase on.
 */
export async function rebaseStaleDelete(input: {
  readonly store: Store; readonly scope: SyncScope; readonly ownerId: string; readonly fence: number;
  readonly queue: QueueOperation; readonly problem: ParsedColpProblem;
  readonly digest: (payload: JsonObject) => string;
}): Promise<'rebased' | 'held' | null> {
  const { queue, problem } = input;
  const type = queue.payload.type;
  if (!isDeleteOperation(type) || problem.code !== 'revision_conflict' || problem.conflictId
      || problem.currentRevision === undefined) return null;
  const idempotencyKey = `${queue.opId}.rebase.${queue.retry.attempt}`;
  const rebase = async (payload: JsonObject) => input.store.rebaseClaimedPush(input.scope, queue.sequence, input.ownerId,
    input.fence, { payload, digest: input.digest(payload), idempotencyKey, baseRevision: problem.currentRevision! });
  if (type === 'delete_node') {
    await rebase({ ...queue.payload, baseRevision: problem.currentRevision });
    return 'rebased';
  }
  const current = problem.currentSubtree;
  const source = asObject(queue.payload.source);
  // The rebased row carries the facts the server named, so a later Retry sends
  // them; rebasing also releases the sent attempt the refusal did not consume.
  await rebase({ ...queue.payload, baseRevision: problem.currentRevision, ...(current === undefined ? {} : {
    source: { ...source, extensions: { ...asObject(source.extensions),
      [SUBTREE_OBSERVATION_EXTENSION]: { version: 1, count: current.count, digest: current.digest } } } }) });
  // Without the server's current members nothing proves the folder still holds only what was deleted.
  const observed = current === undefined ? undefined : await observedMemberIdsDigest(input.store, input.scope, queue.opId);
  if (observed !== undefined && observed === current!.memberIdsDigest) return 'rebased';
  await input.store.setAsideClaimedPush(input.scope, queue.sequence, input.ownerId, input.fence, DELETE_SUBTREE_CHANGED);
  return 'held';
}

/** The member-ID digest the removal recorded at capture; absent for a recaptured or pending-member delete. */
async function observedMemberIdsDigest(store: Store, scope: SyncScope, opId: string): Promise<string | undefined> {
  const event = await findProcessedBookmarkEvent(
    (afterOrdinal, limit) => store.listBookmarkEvents(scope, afterOrdinal, limit), opId, 'remove');
  const digest = event?.details.subtreeMemberIdsDigest;
  return typeof digest === 'string' ? digest : undefined;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
