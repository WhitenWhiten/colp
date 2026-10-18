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
export function isOpenQueueIssue(row: { readonly status?: string; readonly recovery?: { readonly code?: string } }): boolean {
  return (row.status === 'rejected' && row.recovery?.code !== 'recaptured') || row.status === 'set_aside'
    || (row.status === 'blocked' && row.recovery?.code === 'conflict_pending');
}

export function addQueueIssueRoots(roots: Set<string>, rows: readonly { readonly status?: string;
  readonly recovery?: { readonly code?: string }; readonly opId: string; readonly payload: { readonly targetId?: unknown; readonly type?: unknown } }[]): void {
  for (const row of rows.filter(isOpenQueueIssue)) {
    if (typeof row.payload.targetId === 'string') roots.add(row.payload.targetId);
    if (row.payload.type === 'create_node') roots.add(`pending-${row.opId}`);
  }
}
