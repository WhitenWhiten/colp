import { formatMoment, t, tn } from './i18n.js';
import { issueDirectionCopy, issueSummaryCopy, issueTitleCopy } from './sync-issue-copy.js';
import type { SyncIssueDiagnostic, SyncIssueLocalAction } from './types.js';

/** One item that could not sync, ready to paint: its name, why, and what can be done. */
export interface SyncIssueRow {
  readonly key: string;
  readonly issueId?: string;
  readonly title: string;
  readonly summary: string;
  readonly direction: SyncIssueDiagnostic['direction'];
  readonly directionLabel: string;
  readonly code: string;
  /** "Seen 3 times since 9:12 AM", when either is known. */
  readonly seen?: string;
  /** Sync handles it by itself; no decision is waiting. */
  readonly automatic: boolean;
  readonly actions: readonly SyncIssueLocalAction[];
}

/** A row list is a window: the Status page paints this many and says how many more there are. */
export const SYNC_ISSUE_ROW_LIMIT = 20;

/** Every open item that offers an action, window or not: the ones one press can act on at once. */
export interface SyncIssueBulk { readonly retry: readonly string[]; readonly dismiss: readonly string[] }

export function syncIssueBulk(issues: readonly SyncIssueDiagnostic[] | undefined): SyncIssueBulk {
  const ids = (action: SyncIssueLocalAction) => (issues ?? []).flatMap(issue =>
    issue.issueId && issue.localActions?.includes(action) ? [issue.issueId] : []);
  return { retry: ids('retry'), dismiss: ids('dismiss') };
}

/** An epoch or missing time means the browser never recorded when it first saw the item. */
function knownMoment(value: string | number | undefined): number | undefined {
  const time = typeof value === 'string' ? Date.parse(value) : value;
  return typeof time === 'number' && Number.isFinite(time) && time > 86_400_000 ? time : undefined;
}

function seenCopy(issue: SyncIssueDiagnostic): string | undefined {
  const since = knownMoment(issue.firstSeenAt);
  const count = Math.max(1, Math.trunc(issue.count ?? 1));
  if (since === undefined && count <= 1) return undefined;
  const times = tn('syncIssue_seenTimes', count, 'Seen $1 time', 'Seen $1 times');
  return since === undefined ? times : t('syncIssue_seenSince', '$1 since $2', times, formatMoment(since));
}

export function syncIssueRows(issues: readonly SyncIssueDiagnostic[] | undefined, limit = SYNC_ISSUE_ROW_LIMIT):
  { readonly rows: readonly SyncIssueRow[]; readonly more: number } {
  const all = issues ?? [];
  // Items that wait for a person come before the ones sync clears by itself.
  const ordered = [...all.keys()].sort((left, right) =>
    Number(all[left]!.recovery === 'automatic') - Number(all[right]!.recovery === 'automatic') || left - right);
  const rows = ordered.slice(0, limit).map((index): SyncIssueRow => {
    const issue = all[index]!;
    const seen = seenCopy(issue);
    return { key: issue.issueId ?? `${issue.direction}:${issue.code}:${index}`, ...(issue.issueId ? { issueId: issue.issueId } : {}),
      title: issueTitleCopy(issue), summary: issueSummaryCopy({ code: issue.code, direction: issue.direction,
        ...(issue.actions ? { actions: issue.actions } : {}), ...(issue.stage ? { stage: issue.stage } : {}),
        ...(issue.rootCause ? { rootCause: issue.rootCause } : {}) }),
      direction: issue.direction, directionLabel: issueDirectionCopy(issue.direction), code: issue.code,
      ...(seen ? { seen } : {}), automatic: issue.recovery === 'automatic', actions: issue.localActions ?? [] };
  });
  return { rows, more: Math.max(0, all.length - rows.length) };
}
