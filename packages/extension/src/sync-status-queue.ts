import { isSettledRejection } from './sync-state/open-issue-facts.js';
import type { createSyncStateStore, QueueOperation, SyncScope } from './sync-state-store.js';

type QueueStatusStore = Pick<ReturnType<typeof createSyncStateStore>, 'listQueue'>
  & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'filterResolvedQueueIssues'>>;

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
