import { issueId, type ReplicaHealthIssue } from '../sync-issue-snapshot.js';
import type { UnreadableQueueRow } from '../sync-state/queue-lenient.js';
import type { SyncIssueDiagnostic } from '../types.js';
import { workerWakeFailureLog, type WakeFailure } from './wake-failure.js';

/**
 * Engine-level items that no queue row, Pull record or local issue carries: a step of the engine wake
 * that keeps failing (Rule E) and a saved upload that cannot be read (Rule C). Status lists them as
 * issues and the health report sends them, so the Sync center sees what the browser sees.
 */
export const WAKE_FAILURE_ISSUE_CODE = 'sync_step_failed';
export const UNREAD_QUEUE_CODE = { sent: 'queue_head_unreadable', unsent: 'queue_row_unreadable' } as const;

/** The failing steps of this replica that have repeated enough to report; empty outside a worker. */
export async function readVisibleWakeFailures(replicaId: string): Promise<WakeFailure[]> {
  return workerWakeFailureLog().visible(replicaId).catch(() => []);
}

export function wakeFailureDiagnostics(failures: readonly WakeFailure[]): SyncIssueDiagnostic[] {
  return failures.map((failure) => ({ direction: 'local' as const, code: WAKE_FAILURE_ISSUE_CODE, stage: failure.stage,
    rootCause: failure.code, count: failure.count, firstSeenAt: failure.firstAt, lastSeenAt: failure.lastAt }));
}

export function unreadableQueueDiagnostics(rows: readonly UnreadableQueueRow[]): SyncIssueDiagnostic[] {
  return rows.map((row) => ({ direction: 'push' as const, code: row.kind === 'sent' ? UNREAD_QUEUE_CODE.sent : UNREAD_QUEUE_CODE.unsent,
    ...(row.opId ? { opId: row.opId } : {}) }));
}

const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;
const time = (value: number) => new Date(Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : 0).toISOString();

export function replicaIssuesFromWakeFailures(failures: readonly WakeFailure[]): ReplicaHealthIssue[] {
  return failures.map((failure) => ({ issueId: issueId(['local', WAKE_FAILURE_ISSUE_CODE, failure.stage]),
    code: WAKE_FAILURE_ISSUE_CODE, direction: 'local' as const, count: failure.count,
    firstSeenAt: time(failure.firstAt), lastSeenAt: time(failure.lastAt), actions: [] }));
}

export function replicaIssuesFromUnreadable(rows: readonly UnreadableQueueRow[], now: number): ReplicaHealthIssue[] {
  return rows.map((row) => ({ issueId: issueId(['push', 'unreadable', String(row.sequence ?? 0), row.opId ?? '']),
    code: row.kind === 'sent' ? UNREAD_QUEUE_CODE.sent : UNREAD_QUEUE_CODE.unsent, direction: 'push' as const,
    ...(row.opId && OPAQUE.test(row.opId) ? { opId: row.opId } : {}), count: 1,
    firstSeenAt: time(now), lastSeenAt: time(now), actions: [] }));
}
