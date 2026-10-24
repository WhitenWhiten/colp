/**
 * B-04, W2C-11: one bookmark that cannot be projected into Chrome stays one bookmark.
 *
 * `executeProjectionIntents` used to stop at the first intent that failed for any reason other than a
 * precondition check: it parked that intent in `recovery` and rethrew, so every later intent (and, through
 * `reprojectLeftover`, every upload and download of the wake) waited behind it. The same happened for a create
 * whose result could not be proven (`snapshot_native_projection_ambiguous`), which was also not a code the
 * engine knew, so it looped through the unknown-code breaker.
 *
 * Now the refusal is about the intent's node: it is counted like a Pull refusal (a few wakes, then a local issue
 * names the node), a dependent of an unresolved parent waits quietly for it, and an unprovable create is shown
 * for that one bookmark. The rest of the library keeps projecting.
 */
import { SyncFailureError } from './sync-failure-class.js';
import { refusalAboutOneNode, NATIVE_REFUSAL_CODE, PULL_APPLY_FAILURE_LIMIT } from './pull-apply-containment.js';
import { APPLY_FAILED_PREFIX } from './sync-state/pull-issue-repository.js';
import type { ProjectionIntentRecord } from './recovery-overlay.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

type ContainmentStore = Pick<ReturnType<typeof createSyncStateStore>,
  'recordApplyFailure' | 'recordLocalIssue' | 'settleProjectionIntent'>;

/** The local-issue code of a create whose result nothing proves (an equal bookmark may be this extension's own). */
export const PROJECTION_AMBIGUOUS_CODE = 'snapshot_native_projection_ambiguous';

interface Contained {
  readonly store: ContainmentStore; readonly scope: SyncScope; readonly intent: ProjectionIntentRecord;
  /** The browser id the issue is shown for: the node's own, or its `recovery:` placeholder before it exists. */
  readonly nativeId: string; readonly now: number;
}

async function issue(input: Contained, code: string): Promise<void> {
  await input.store.recordLocalIssue(input.scope, { code, nativeId: input.nativeId, now: input.now,
    ...(input.intent.title ? { title: input.intent.title } : {}) });
}

/**
 * True when `error` is about this intent's node and has been dealt with (the intent is back to `pending`, or an
 * issue names it); the caller restores the node's prior mapping and moves on to the next intent.
 */
export async function containProjectionFailure(input: Contained, error: unknown): Promise<boolean> {
  if (error instanceof SyncFailureError) {
    // The parent has no browser identity yet. Its own refusal or issue is what the user sees; this one waits for it.
    if (error.code === 'snapshot_parent_mapping_missing') {
      await input.store.settleProjectionIntent(input.scope, input.intent.intentId, { state: 'pending' });
      return true;
    }
    // The bookmark this change was for is gone from Chrome: a decision about that bookmark, certain at once.
    if (error.code === 'snapshot_content_target_missing') {
      await issue(input, error.code);
      await input.store.settleProjectionIntent(input.scope, input.intent.intentId, { state: 'pending' });
      return true;
    }
    return false;
  }
  if (!refusalAboutOneNode(error) || input.intent.kind === 'delete') return false;
  const failure = await input.store.recordApplyFailure(input.scope, { subject: `projection:${input.intent.intentId}`,
    code: NATIVE_REFUSAL_CODE, detail: `${error.failureClass}: ${error.message}`, now: input.now });
  await input.store.settleProjectionIntent(input.scope, input.intent.intentId, { state: 'pending' });
  if (failure.count >= PULL_APPLY_FAILURE_LIMIT) await issue(input, `${APPLY_FAILED_PREFIX}${NATIVE_REFUSAL_CODE}`);
  return true;
}

/** A create nothing proves: keep the intent `ambiguous` (it re-checks on every pass) and show it for this bookmark. */
export async function containAmbiguousProjection(input: Contained): Promise<void> {
  await input.store.settleProjectionIntent(input.scope, input.intent.intentId, { state: 'ambiguous' });
  await issue(input, PROJECTION_AMBIGUOUS_CODE);
}
