import type { SyncIssueLocalAction } from './sync-attention-types.js';

/** Items named by one press: a row's own id, or every row of a kind. */
export type SyncIssueActionRequest = { readonly kind: 'known.sync.issue.act'; readonly action: SyncIssueLocalAction;
  readonly issueIds: readonly string[] };

/**
 * `done` items were carried out, `skipped` were no longer open or no longer offer the action, `failed` were
 * tried and could not be (`code` is the first reason). `woke`: a sync pass was started for what was released.
 * For Try again on remote items: `remote` of the `done` items go back to the apply pass (they are applied by the
 * pass that was started, not yet), `superseded` were closed because the library's later state is already here
 * or the item no longer applies, and `unavailable` could not be tried again from here and stay as they were.
 */
export type SyncIssueActionResponse = { readonly ok: true; readonly done: number; readonly skipped: number;
  readonly failed: number; readonly code?: string; readonly woke?: boolean; readonly remote?: number;
  readonly superseded?: number; readonly unavailable?: number }
  | { readonly ok: false; readonly error: string };
