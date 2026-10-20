import { isOpenQueueIssue, isSettledRejection } from './sync-state/open-issue-facts.js';
import type { createSyncStateStore, QueueOperation, SyncScope } from './sync-state-store.js';

type QueueStatusStore = Pick<ReturnType<typeof createSyncStateStore>, 'listQueue'>
  & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'filterResolvedQueueIssues'>>;

type ConsumedIssueStore = Partial<QueueStatusStore & Pick<ReturnType<typeof createSyncStateStore>, 'listConsumedQueueIssues'>>;

/** A consumed transport sequence can still carry an unresolved business refusal.
 * Engine and attention projections use the same receipts and resolution sidecars;
 * these rows are attention facts, never retryable transport work. */
export async function readUnresolvedConsumedQueueIssues(store: ConsumedIssueStore, scope: SyncScope): Promise<QueueOperation[]> {
  const rows: QueueOperation[] = [];
  if (store.listConsumedQueueIssues) rows.push(...await store.listConsumedQueueIssues(scope));
  else if (store.listQueue) {
    let after = 0;
    for (;;) {
      const page = await store.listQueue(scope, 'terminal', after, 1_000);
      rows.push(...page.filter(isOpenQueueIssue));
      if (page.length < 1_000) break;
      const next = page.at(-1)!.sequence;
      if (!Number.isSafeInteger(next) || next <= after) throw new Error('queue_page_cursor_invalid');
      after = next;
    }
  }
  return store.filterResolvedQueueIssues ? store.filterResolvedQueueIssues(scope, rows) : rows;
}

/** Bound the public projection by live rows, not retained resolved history.
 * Always advance with the raw page: filtering is not evidence of exhaustion. */
export async function readUnresolvedQueuePage(store: QueueStatusStore, scope: SyncScope,
  status: QueueOperation['status'], limit = 1_000): Promise<QueueOperation[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('queue_page_limit_invalid');
  const live: QueueOperation[] = [];
  let after = 0;
  for (;;) {
    const page = await store.listQueue(scope, status, after, limit);
    const unresolved = store.filterResolvedQueueIssues ? await store.filterResolvedQueueIssues(scope, page) : page;
    live.push(...unresolved.filter(row => !isSettledRejection(row)).slice(0, limit - live.length));
    if (page.length < limit || live.length === limit) return live;
    const next = page.at(-1)!.sequence;
    if (!Number.isSafeInteger(next) || next <= after) throw new Error('queue_page_cursor_invalid');
    after = next;
  }
}
