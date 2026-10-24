/**
 * Rule B, pull side (B-03): a refusal by the browser stays with the node it was about.
 *
 * Chrome refuses a bookmark write for reasons that belong to one bookmark: an index that raced a local edit, a
 * parent removed between prepare and call, a folder moved into its own descendant, a read-only parent. Before
 * this module such a refusal was rethrown, so the page never completed, the cursor never moved and every later,
 * unrelated event waited behind it.
 *
 * The rule is wording independent (the browser's messages differ by version and vendor): any refused call
 * about the event's one node, other than a permission loss or a quota, is retried on a few wakes and then
 * the node is set aside under `apply_failed:bookmark_api_error` with the refusal kept as evidence. The page goes on.
 */
import { BookmarkApiError } from './bookmark-api-error.js';
import { rangeActionOf } from './pull-range-move.js';
import { APPLY_FAILED_PREFIX } from './sync-state/pull-issue-repository.js';
import { SyncStateError } from './sync-state/types.js';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { PullApplierOptions } from './pull-applier-types.js';

type OpEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;

/** Wakes on which the browser may refuse the same call about a node before the node is set aside. */
export const PULL_APPLY_FAILURE_LIMIT = 3;
/** The underlying code of `apply_failed:<code>` for a refused browser call. */
export const NATIVE_REFUSAL_CODE = 'bookmark_api_error';
/** States in which a refused call has not changed anything for the event (the call itself was the refusal). */
const REFUSABLE_STATES = ['staged', 'intent_prepared', 'browser_call_started'];

/**
 * Chrome refused a call and the refusal is about the bookmark: not a lost permission (that stops the replica)
 * and not a quota (that waits, whatever the bookmark is).
 */
export function refusalAboutOneNode(error: unknown): error is BookmarkApiError {
  return error instanceof BookmarkApiError && error.failureClass !== 'permission_denied' && error.code === undefined;
}

/** The one node a single-step event changes in the browser; undefined for multi-step effects (restore, subtree delete). */
function singleNodeOf(event: OpEvent): { readonly nodeId: string; readonly title?: string } | undefined {
  const effect = event.effect;
  if (effect.kind === 'node_deleted') return { nodeId: effect.tombstone.targetId };
  if (effect.kind === 'node_created' || effect.kind === 'node_moved' || effect.kind === 'node_content_updated') {
    const title = (effect.node as { readonly title?: unknown }).title;
    return { nodeId: effect.node.id, ...(typeof title === 'string' && title ? { title } : {}) };
  }
  return undefined;
}

/**
 * Called when applying `event` threw. Returns true when the event was set aside (the caller carries on with the
 * page) and false when the error must keep its course: not a refusal about one node, a multi-step change whose
 * first steps may have landed, or fewer than `PULL_APPLY_FAILURE_LIMIT` wakes of the same refusal so far.
 */
export async function setAsideRefusedPullEvent(options: PullApplierOptions,
  entered: { readonly eventId?: unknown }, event: OpEvent, error: unknown, now: number): Promise<boolean> {
  if (!refusalAboutOneNode(error)) return false;
  const target = singleNodeOf(event);
  if (!target) return false;
  const eventId = String(entered.eventId);
  const current = await options.store.getPullEvent(options.scope, eventId);
  if (!current || !REFUSABLE_STATES.includes(String(current.state))) return false;
  if (event.effect.kind === 'node_moved') {
    // Only a plain Chrome move is one step; a move out of a mounted range creates and removes copies.
    const intent = await options.store.getApplyIntent(options.scope, `intent:${eventId}`);
    if (rangeActionOf(intent?.anchors) !== 'native_move') return false;
  }
  const failure = await options.store.recordApplyFailure(options.scope, { subject: `pull:${eventId}`,
    code: NATIVE_REFUSAL_CODE, detail: `${error.failureClass}: ${error.message}`, now });
  if (failure.count < PULL_APPLY_FAILURE_LIMIT) return false;
  try {
    await options.store.setAsidePullEvent(options.scope, eventId, { code: `${APPLY_FAILED_PREFIX}${NATIVE_REFUSAL_CODE}`,
      nodeId: target.nodeId, now, nativeRejection: 'native_call_rejected', ...(target.title ? { title: target.title } : {}) });
  } catch (setAsideError) {
    // The store saw evidence that a call may have landed: never hide that; the original error keeps its course.
    if (setAsideError instanceof SyncStateError && setAsideError.code === 'pull_event_state_invalid') return false;
    throw setAsideError;
  }
  return true;
}
