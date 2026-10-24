import { validateQueueRecord } from './queue-validate.js';
import type { QueueOperation } from './types.js';

/**
 * Rule C: one queue row that cannot be read must not stop the engine. The lane scans validate
 * the rows they look at; these helpers let a scan step over a row that fails validation, and
 * describe what such a row was so the one place that may change it (the claim, see
 * queue-quarantine.ts) can tell a change that was never sent from one the server may own.
 */
export function tryValidateQueueRecord(value: unknown, maxBytes: number): QueueOperation | undefined {
  try { return validateQueueRecord(value, maxBytes); } catch { return undefined; }
}

/** The rows that pass validation, in order; an unreadable row is left for the claim to quarantine. */
export function readableQueueRows(values: readonly unknown[], maxBytes: number): QueueOperation[] {
  const rows: QueueOperation[] = [];
  for (const value of values) {
    const row = tryValidateQueueRecord(value, maxBytes);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * - unsent: never given to the server (no bound attempt, status pending/unknown/claimed/set_aside).
 *   It owns no server sequence and can be held out of the lane.
 * - sent: a bound attempt or a status that follows a server answer. The server may own its
 *   sequence slot, so the row cannot be dropped, rewritten or skipped: the push lane waits.
 * - settled: terminal or rejected history. Nothing waits for it.
 */
export interface UnreadableQueueRow {
  readonly kind: 'unsent' | 'sent' | 'settled';
  readonly sequence?: number;
  readonly opId?: string;
  readonly status?: string;
}

const UNSENT_STATUSES: ReadonlySet<string> = new Set(['pending', 'unknown', 'claimed', 'set_aside']);
const SETTLED_STATUSES: ReadonlySet<string> = new Set(['terminal', 'rejected']);

export function describeUnreadable(raw: unknown): UnreadableQueueRow {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const status = typeof record.status === 'string' ? record.status : undefined;
  const sequence = typeof record.sequence === 'number' && Number.isSafeInteger(record.sequence) && record.sequence >= 1
    ? record.sequence : undefined;
  const opId = typeof record.opId === 'string' && record.opId.length > 0 && record.opId.length <= 512 ? record.opId : undefined;
  const kind = status !== undefined && SETTLED_STATUSES.has(status) ? 'settled'
    : status !== undefined && UNSENT_STATUSES.has(status) && record.attempt === undefined ? 'unsent' : 'sent';
  return { kind, ...(sequence === undefined ? {} : { sequence }), ...(opId === undefined ? {} : { opId }),
    ...(status === undefined ? {} : { status }) };
}

/** What a scan does with the unreadable row it just met (see queue-quarantine.ts). */
export type UnreadableVerdict = 'repaired' | 'blocking' | 'skipped';
export type UnreadableHandler = (raw: unknown) => UnreadableVerdict;
