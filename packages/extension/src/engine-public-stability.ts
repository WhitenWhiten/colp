import { isOpenQueueIssue } from './sync-state/open-issue-facts.js';
import { classifySyncFailure } from './sync-failure-class.js';
import type { QueueOperation } from './sync-state-store.js';
export function cooldownIsPending(input: {
  readonly now: number | undefined;
  readonly sessionNotBefore: number | undefined;
  readonly errorCode: string | undefined;
  readonly engineNotBefore: number | undefined;
}): boolean {
  if (!validEpochMilliseconds(input.now) || !validEpochMilliseconds(input.sessionNotBefore)
      || !validEpochMilliseconds(input.engineNotBefore)) return true;
  return input.sessionNotBefore > input.now
    || (input.errorCode !== undefined && input.engineNotBefore > input.now);
}

function validEpochMilliseconds(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** Work the push lane can still drain. Held (`set_aside`) rows wait for their problem to clear. */
export function hasRecoverableQueueWork(rows: readonly { readonly status?: string }[]): boolean {
  return rows.some((row) => row.status !== 'terminal' && row.status !== 'rejected' && row.status !== 'set_aside');
}

/**
 * A conflicted push waits for the server's resolution to arrive through Pull,
 * and later changes of the same bookmark are held with it (`conflict_hold`);
 * the rest of the lane keeps syncing. It needs no local recovery, but the UI
 * must be able to say "waiting on a conflict" instead of a vague pending state
 * that never seems to finish.
 */
export function hasConflictBarrier(rows: readonly { readonly status?: string;
  readonly recovery?: { readonly code?: string; readonly resultStatus?: string } }[]): boolean {
  return rows.some((row) => (row.status === 'blocked' && row.recovery?.code === 'conflict_pending')
    || (row.status === 'set_aside' && row.recovery?.code === 'conflict_hold'));
}

export function hasRejectedBarrier(rows: readonly { readonly status?: string; readonly recovery?: { readonly code?: string; readonly resultStatus?: string } }[]): boolean {
  return rows.some((row) => (row.status === 'rejected' || row.recovery?.resultStatus === 'rejected') && isOpenQueueIssue(row));
}

export function queueStatusProjection(rows: readonly { readonly status?: string;
  readonly recovery?: { readonly code?: string; readonly resultStatus?: string } }[]): 'idle' | 'syncing' | 'conflict' | 'rejected' {
  if (hasConflictBarrier(rows)) return 'conflict';
  if (hasRecoverableQueueWork(rows)) return 'syncing';
  if (hasRejectedBarrier(rows)) return 'rejected';
  return 'idle';
}

/** Tries a sent change may collect before the lane waiting behind it is reported. */
export const STALLED_UPLOAD_ATTEMPTS = 8;
/** The lane statuses a sent change can keep while the server has not settled it. */
const UNSETTLED_STATUSES: ReadonlySet<string> = new Set(['claimed', 'deferred', 'gap', 'unknown']);

/**
 * The head of the lane was sent, and the server's answer has kept it unsettled
 * for many tries: an answer that cannot be read, a result that cannot be
 * processed, a deferral or sequence gap that never ends. Every later upload
 * waits behind it, as the protocol requires for a change that may already own
 * its server sequence, but the wait must be visible. Lost connectivity, a
 * busy server and authority problems are about the browser, not the change,
 * and are not reported as a stalled upload.
 */
export function stalledUploadHead(rows: readonly QueueOperation[]): { readonly row: QueueOperation; readonly code: string } | undefined {
  const head = [...rows].filter((row) => UNSETTLED_STATUSES.has(row.status)).sort((left, right) => left.sequence - right.sequence)[0];
  if (!head || head.attempt === undefined || head.retry.attempt < STALLED_UPLOAD_ATTEMPTS) return undefined;
  const code = head.status === 'deferred' ? 'push_deferred' : head.recovery?.code;
  if (!code) return undefined;
  const policy = classifySyncFailure(code);
  if (policy?.class === 'transient' || policy?.class === 'authority') return undefined;
  return { row: head, code };
}
