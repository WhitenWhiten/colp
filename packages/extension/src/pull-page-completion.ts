import { enforceSyncIssueCeiling } from './sync-issue-ceiling.js';
import { remoteDeleteDeferral } from './remote-delete-pending-facts.js';
import { supersededPullPage, type PullApplyAuthority } from './pull-authority-apply.js';
import type { PullApplierOptions } from './pull-applier-types.js';

/** Native application and accounted-for deferrals publish through the same page transaction. */
export async function finishReadyPullPages(options: PullApplierOptions, authority: PullApplyAuthority, now: number): Promise<void> {
  const committed = (await options.store.listPullEvents(options.scope, ['authority_committed'])).filter(remoteDeleteDeferral);
  if (committed.length) {
    const completed = new Set((await options.store.listPullPages(options.scope, ['page_complete'])).map(page => page.pageId));
    for (const event of committed) if (completed.has(event.pageId)) {
      await options.store.completeDetachedPullEvent(options.scope, String(event.pageId), String(event.eventId));
    }
  }
  for (const page of await options.store.listPullPages(options.scope, ['staged'])) {
    if (supersededPullPage(authority, page)) continue;
    const events = await options.store.listPullEventsByPage(options.scope, String(page.pageId));
    if (events.length === Number(page.eventCount) && events.every(event => event.state === 'authority_committed'
        || event.state === 'awaiting_confirmation' && remoteDeleteDeferral(event))) {
      await options.assertCurrent?.(); await options.store.completePullPage(options.scope, String(page.pageId));
    }
  }
  await enforceSyncIssueCeiling(options.store, options.scope, now);
}
