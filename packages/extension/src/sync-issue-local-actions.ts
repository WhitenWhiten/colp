import { DISMISSIBLE_OPERATION_TYPES } from './sync-state/open-issue-facts.js';
import { DEPENDENT_HOLDS } from './sync-state/queue-hold.js';
import { queueIssueCode, queueIssueRetryable } from './sync-issue-snapshot.js';
import type { PullIssueRecord, QueueOperation } from './sync-state-store.js';
import type { SyncIssueLocalAction } from './types.js';

/** One press names at most this many items, so it never holds the worker for long; a longer list takes another press. */
export const SYNC_ISSUE_ACTION_MAX = 250;

type PushIssueRow = Pick<QueueOperation, 'status' | 'opId' | 'attempt' | 'recovery'> & { readonly payload: { readonly type?: unknown } };

/**
 * What this browser can do about one upload that did not go through.
 *
 *  - Try again: exactly when the Sync center offers it (`queueIssueRetryable`), plus a held create, which is
 *    cured by fixing the bookmark in the browser and capturing it again.
 *  - Dismiss (keep this browser's version): a refused or held content change or move. Nothing is deleted and
 *    nothing is lost; the change is simply not uploaded. A create or a delete is never dismissed: a create
 *    leaves an identity behind that only a fresh capture retires, and a delete would drop the user's intent.
 *  - Nothing: a conflict (settled in the Sync center) and a change that waits for another one (it follows
 *    the change it waits for).
 */
export function pushLocalActions(row: PushIssueRow): readonly SyncIssueLocalAction[] {
  const code = queueIssueCode(row);
  if (queueIssueRetryable(row, code)) return ['retry'];
  if (row.status === 'blocked') return [];
  if (row.status === 'set_aside' && DEPENDENT_HOLDS.has(code)) return [];
  if (row.payload.type === 'create_node') return row.status === 'set_aside' ? ['retry'] : [];
  return DISMISSIBLE_OPERATION_TYPES.has(String(row.payload.type)) ? ['dismiss'] : [];
}

/**
 * A remote item this browser set aside can be dismissed: the issue closes, later changes to it apply again, and
 * this browser keeps the version it has. A hold that a conflict decision settles is not dismissed from here.
 * Taking the library's version instead is not offered per item (see `known.sync.issue.act`).
 */
export function pullLocalActions(row: Pick<PullIssueRecord, 'conflictOpIds'>): readonly SyncIssueLocalAction[] {
  return row.conflictOpIds?.length ? [] : ['dismiss'];
}
