import type { BookmarkEventRecord, UnknownRecord } from './types.js';
import type { LocalIssueRecord } from './pull-issue-repository.js';

/** A historical diagnostic is not an open issue once its source event completed or reopened. */
export function openIngressIssue(diagnostic: UnknownRecord, event: BookmarkEventRecord | undefined): LocalIssueRecord | undefined {
  const park = diagnostic.park as UnknownRecord | undefined;
  if (diagnostic.kind !== 'ingress' || park?.state !== 'parked' || !event || event.status !== 'pending') return undefined;
  const time = typeof park.at === 'string' ? Date.parse(park.at) : Number(park.at);
  const at = Number.isFinite(time) ? time : 0;
  const context: Partial<LocalIssueRecord> = Object.fromEntries(
    ['dependencyOpId', 'dependencyEventId', 'dependencyNativeId'].flatMap(key =>
      typeof park[key] === 'string' ? [[key, park[key]]] : []));
  const title = typeof event.details.title === 'string' ? event.details.title.slice(0, 200) : undefined;
  return { ...context, nativeId: event.nativeId, eventId: event.eventId,
    code: typeof park.code === 'string' ? park.code : 'ingress_parked',
    ...(title ? { title } : {}), attempts: Number.isSafeInteger(park.attempts) ? Number(park.attempts) : 1,
    ...(typeof park.reason === 'string' ? { rootCause: park.reason } : {}),
    recovery: ['dependency_pending', 'dependency_parked'].includes(String(park.code)) ? 'automatic' : 'decision',
    count: 1, firstSeenAt: at, lastSeenAt: at };
}

/** One local issue per code/native subject; repeated parked events are evidence counts. */
export function mergeLocalIssues(rows: readonly LocalIssueRecord[]): LocalIssueRecord[] {
  const merged = new Map<string, LocalIssueRecord>();
  for (const row of rows) {
    const id = JSON.stringify([row.code, row.nativeId, row.eventId]); const previous = merged.get(id);
    merged.set(id, previous ? { ...previous, count: previous.count + row.count,
      firstSeenAt: Math.min(previous.firstSeenAt, row.firstSeenAt), lastSeenAt: Math.max(previous.lastSeenAt, row.lastSeenAt) } : row);
  }
  return [...merged.values()];
}

export interface BlockedPullIssue {
  readonly pageId: string; readonly code: string; readonly at: number; readonly nodeIds: readonly string[];
}
export function blockedPullIssue(page: UnknownRecord, events: readonly UnknownRecord[]): BlockedPullIssue | undefined {
  if (page.state !== 'blocked') return undefined;
  const nodeIds = new Set<string>();
  for (const event of events) {
    const effect = (event.payload as UnknownRecord | undefined)?.effect as UnknownRecord | undefined;
    for (const value of [(effect?.node as UnknownRecord | undefined)?.id,
      (effect?.tombstone as UnknownRecord | undefined)?.targetId,
      (effect?.rootTombstone as UnknownRecord | undefined)?.targetId]) if (typeof value === 'string') nodeIds.add(value);
    for (const mapping of (event.pendingMappings ?? []) as UnknownRecord[]) if (typeof mapping.colpId === 'string') nodeIds.add(mapping.colpId);
  }
  return { pageId: String(page.pageId), code: String(page.recoveryCode ?? 'pull_page_invalid'),
    at: Number(page.blockedAt ?? 0), nodeIds: [...nodeIds] };
}

/** Recaptured bytes are audit history; server rejections, held work and conflicts remain open. */
export function isOpenQueueIssue(row: { readonly status?: string; readonly recovery?: { readonly code?: string; readonly resultStatus?: string } }): boolean {
  return (row.status === 'terminal' && row.recovery?.resultStatus === 'rejected') || (row.status === 'rejected' && row.recovery?.code !== 'recaptured') || row.status === 'set_aside'
    || (row.status === 'blocked' && row.recovery?.code === 'conflict_pending');
}

export function addQueueIssueRoots(roots: Set<string>, rows: readonly { readonly status?: string;
  readonly recovery?: { readonly code?: string; readonly resultStatus?: string }; readonly opId: string; readonly payload: { readonly targetId?: unknown; readonly type?: unknown } }[]): void {
  for (const row of rows.filter(isOpenQueueIssue)) {
    if (typeof row.payload.targetId === 'string') roots.add(row.payload.targetId);
    if (row.payload.type === 'create_node') roots.add(`pending-${row.opId}`);
  }
}

/** Directed waits protect their prerequisite through its own facts, never through the dependent. */
export function ingressProtectsNode(issue: LocalIssueRecord): boolean {
  return !issue.dependencyOpId && !issue.dependencyEventId;
}

/** A consumed sequence is independent of business success. Old receipts project identically. */
export function withReceiptOutcome<T extends { readonly status: string; readonly opId: string; readonly recovery?: unknown }>(row: T,
  receipt: { readonly kind?: string; readonly opId?: string; readonly result?: { readonly results?: unknown } } | undefined): T {
  if (row.status !== 'terminal' || receipt?.kind !== 'terminal' || receipt.opId !== row.opId) return row;
  const results = receipt.result?.results;
  const result = Array.isArray(results) ? results.find(item => item?.opId === row.opId && item.status === 'rejected') : undefined;
  if (!result) return row;
  const code = typeof result.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(result.code) ? result.code : 'push_rejected';
  return { ...row, recovery: { code, resultStatus: 'rejected' } };
}
