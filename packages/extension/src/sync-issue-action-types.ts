import type { SyncIssueLocalAction } from './sync-attention-types.js';

/** Items named by one press: a row's own id, or every row of a kind. */
export type SyncIssueActionRequest = { readonly kind: 'known.sync.issue.act'; readonly action: SyncIssueLocalAction;
  readonly issueIds: readonly string[] };

/**
 * `done` items were carried out, `skipped` were no longer open or no longer offer the action, `failed` were
 * tried and could not be (`code` is the first reason). `woke`: a sync pass was started for what was released.
 */
export type SyncIssueActionResponse = { readonly ok: true; readonly done: number; readonly skipped: number;
  readonly failed: number; readonly code?: string; readonly woke?: boolean }
  | { readonly ok: false; readonly error: string };
