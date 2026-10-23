import { BADGE_ACCENT, BADGE_MUTED } from '../badge-colors.js';
import { formatMoment, t, tn } from '../i18n.js';
import type { AutomationServerView } from './messages.js';

/** The server’s owner-facing unread count, with the digest projection for older servers. */
export interface DigestIndicator {
  readonly count: number;
  readonly activity?: boolean;
  /** Every unread run is a batch run, so the results are digests. */
  readonly digests: boolean;
  /** Where "Read" goes: the one run, or the web's Digests page for several. */
  readonly url: string;
  /** The rule behind a single new result. */
  readonly ruleName: string | null;
  readonly fetchedAt: number;
  /** The server couldn't be read since `fetchedAt`. */
  readonly stale: boolean;
}

export interface ToolbarBadge { readonly text: string; readonly color: string; readonly title: string }

export function digestIndicator(server: AutomationServerView | null, webUrl: string | null): DigestIndicator | null {
  if (server?.activity) {
    const activity = server.activity;
    if (!activity.unreadCount || !webUrl) return null;
    const latest = activity.latest;
    return { count: activity.unreadCount, activity: true, digests: false, url: new URL('/activity', webUrl).href,
      ruleName: activity.unreadCount === 1 ? latest?.run?.ruleName ?? latest?.agent?.name ?? null : null,
      fetchedAt: activity.fetchedAt, stale: Boolean(server.activityProblem) };
  }
  if (!server?.fetchedAt) return null;
  const unread = server.runs.filter((run) => run.unread && run.outputCount > 0);
  const newest = unread[0];
  if (!newest) return null;
  const single = unread.length === 1;
  return { count: unread.length, digests: unread.every((run) => run.kind === 'batch'),
    url: single || !webUrl ? newest.url : `${webUrl.replace(/\/$/u, '')}/digests`, ruleName: single ? newest.ruleName : null,
    fetchedAt: server.fetchedAt, stale: server.problem !== null };
}

/** "1 new digest", or "2 new results from your automations" when not all are digests. */
export function digestLabel(indicator: Pick<DigestIndicator, 'count' | 'digests' | 'activity'>): string {
  if (indicator.activity) return tn('automation_newActivity', indicator.count, '$1 new from your agents', '$1 new from your agents');
  return indicator.digests
    ? tn('automation_newDigests', indicator.count, '$1 new digest', '$1 new digests')
    : tn('automation_newResults', indicator.count, '$1 new result from your automations', '$1 new results from your automations');
}

/** The count on the toolbar icon. Muted while the server can't be read, with the time of the last answer in its tooltip. */
export function toolbarBadge(indicator: DigestIndicator): ToolbarBadge {
  const label = digestLabel(indicator);
  return { text: indicator.count > 99 ? '99+' : String(indicator.count), color: indicator.stale ? BADGE_MUTED : BADGE_ACCENT,
    title: indicator.stale
      ? t('automation_badgeStale', '$1 as of $2. Your server couldn’t be reached since.', label, formatMoment(indicator.fetchedAt))
      : t('automation_badgeFresh', '$1.', label) };
}
