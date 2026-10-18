import { isOpenQueueIssue } from './sync-state/open-issue-facts.js';
import { DEPENDENT_HOLDS } from './sync-state/queue-hold.js';
import { digestJson } from './bookmark-event-codec.js';
import { classifySyncFailure } from './sync-failure-class.js';
import { REPLICA_HEALTH_TITLE_MAX } from './generated/replica-health-limits.js';
import type { NativeWaitProjection } from './native-create-executor.js';
import type { LocalIssueRecord, PullIssueRecord, QueueOperation } from './sync-state-store.js';
import type { OpenSyncIssues } from './sync-issues.js';
const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const PROVISIONAL = /^(?:pending-|local-|mount:)/u;
export interface ReplicaHealthIssue {
  readonly issueId: string;
  readonly code: string;
  readonly direction: 'push' | 'pull' | 'local';
  readonly nodeId?: string;
  readonly opId?: string;
  readonly title?: string;
  readonly count: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly actions: readonly 'retry'[];
}
/** Uploads the server refused, held for a conflict, or set aside for another problem, one issue each. */
export function replicaIssuesFromQueue(rows: readonly QueueOperation[]): ReplicaHealthIssue[] {
  return rows.flatMap((row) => {
    if (!isOpenQueueIssue(row)) return [];
    const conflict = row.status === 'blocked' && row.recovery?.code === 'conflict_pending';
    const fallback = row.status === 'set_aside' ? 'set_aside' : 'push_rejected';
    const code = conflict ? 'conflict_pending' : CODE.test(row.recovery?.code ?? '') ? row.recovery!.code : fallback;
    const at = instant(row.payload.occurredAt);
    const nodeId = serverNodeId(row.payload.targetId);
    const title = titleOf(row.payload);
    // A change held for a decision about its own placement or identity, or for a local failure
    // the classifier has no entry for, goes through the same checks again from a fresh capture.
    // A change waiting on another one is released by that one, and a record that cannot be
    // stored or a rebuild-class problem is not cured by capturing it again.
    const policy = classifySyncFailure(code);
    const retry = row.status === 'blocked' && code === 'sequence_blocked' && row.attempt !== undefined || row.status === 'set_aside' && OPAQUE.test(row.opId)
      && (policy?.exit === 'decide' || policy === undefined && !DEPENDENT_HOLDS.has(code));
    return [{ issueId: issueId(['push', code, row.opId]), code, direction: 'push' as const,
      ...(nodeId ? { nodeId } : {}), ...(OPAQUE.test(row.opId) ? { opId: row.opId } : {}),
      ...(title ? { title } : {}), count: Math.max(1, row.retry.attempt), firstSeenAt: at, lastSeenAt: row.attempt?.startedAt ? safeTime(row.attempt.startedAt) : at, actions: retry ? ['retry' as const] : [] }];
  });
}

/** Remote nodes this browser set aside while taking in changes, one issue each. */
export function replicaIssuesFromPull(rows: readonly PullIssueRecord[]): ReplicaHealthIssue[] {
  return rows.flatMap((row) => {
    const nodeId = serverNodeId(row.nodeId);
    if (!nodeId || !CODE.test(row.code)) return [];
    const title = typeof row.title === 'string' ? bounded(row.title) : undefined;
    return [{ issueId: issueId(['pull', 'node', nodeId]), code: row.code, direction: 'pull' as const, nodeId,
      ...(title ? { title } : {}), count: Math.max(1, row.count), firstSeenAt: safeTime(row.firstSeenAt),
      lastSeenAt: safeTime(row.lastSeenAt), actions: [] }];
  });
}

/** Browser changes that could not be tied to the library. Browser ids never leave the browser. */
export function replicaIssuesFromLocal(rows: readonly LocalIssueRecord[]): ReplicaHealthIssue[] {
  return rows.flatMap((row) => {
    if (!CODE.test(row.code)) return [];
    const title = typeof row.title === 'string' ? bounded(row.title) : undefined;
    return [{ issueId: localIssueId(row), code: row.code, direction: 'local' as const,
      ...(title ? { title } : {}), count: Math.max(1, row.count), firstSeenAt: safeTime(row.firstSeenAt),
      lastSeenAt: safeTime(row.lastSeenAt), actions: [] }];
  });
}

/** Cloud changes waiting for the user's decision about the browser's result. */
export function replicaIssuesFromWaits(waits: readonly NativeWaitProjection[]): ReplicaHealthIssue[] {
  return waits.map((wait) => {
    const nodeId = serverNodeId(wait.colpId);
    const title = typeof wait.title === 'string' ? bounded(wait.title) : undefined;
    const at = new Date(0).toISOString();
    return { issueId: issueId(['pull', wait.waitReason, wait.intentId]), code: wait.waitReason, direction: 'pull' as const,
      ...(nodeId ? { nodeId } : {}), ...(title ? { title } : {}), count: 1, firstSeenAt: at, lastSeenAt: at, actions: [] };
  });
}

export function issueId(parts: readonly string[]): string { return digestJson([...parts]).slice('sha256:'.length, 'sha256:'.length + 32); }
export function serverNodeId(value: unknown): string | undefined {
  return typeof value === 'string' && OPAQUE.test(value) && !PROVISIONAL.test(value) ? value : undefined;
}
export function instant(value: unknown): string {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return new Date(Number.isNaN(time) ? 0 : time).toISOString();
}
function bounded(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.length > REPLICA_HEALTH_TITLE_MAX ? `${trimmed.slice(0, REPLICA_HEALTH_TITLE_MAX - 1)}…` : trimmed;
}
/** The title a create or edit carried, when the operation has one. */
export function titleOf(operation: QueueOperation['payload']): string | undefined {
  const payload = operation.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  for (const candidate of [record.node, record.value, record]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const title = (candidate as Record<string, unknown>).title;
      if (typeof title === 'string') return bounded(title);
    }
  }
  return undefined;
}


/** Shared display facts; this projection grants no protection or execution capability. */
export function snapshotSyncIssues(open: OpenSyncIssues): ReplicaHealthIssue[] {
  return [...replicaIssuesFromQueue(open.queue), ...replicaIssuesFromPull(open.pull),
    ...replicaIssuesFromLocal(open.local), ...replicaIssuesFromWaits(open.waits),
    ...open.bootstrap.map(row => ({ issueId: row.issueId, direction: 'local' as const, code: row.code,
      ...(row.nodeId && serverNodeId(row.nodeId) ? { nodeId: row.nodeId } : {}), ...(row.title ? { title: row.title } : {}),
      count: 1, firstSeenAt: safeTime(row.at), lastSeenAt: safeTime(row.at), actions: [] })),
    ...open.deletes.map(row => ({ issueId: issueId(['delete', row.decisionId]), direction: 'pull' as const,
      code: 'remote_delete_confirmation_required', nodeId: row.targetId, title: bounded(row.title), count: 1,
      firstSeenAt: new Date(row.updatedAt).toISOString(), lastSeenAt: new Date(row.updatedAt).toISOString(), actions: [] })),
    ...open.replica.map(row => ({ issueId: issueId(['replica', row.pageId]), direction: 'pull' as const,
      code: row.code, count: 1, firstSeenAt: new Date(row.at).toISOString(), lastSeenAt: new Date(row.at).toISOString(), actions: [] }))];
}

function safeTime(value: number): string { return new Date(Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : 0).toISOString(); }

export function localIssueId(row: LocalIssueRecord): string {
  return issueId(['local', row.code, row.nativeId, ...(row.eventId ? [row.eventId] : [])]);
}
