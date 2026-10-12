import type { AckIntentRecord } from './types.js';

/** Session authority confirms only the exact durable cursor recorded as acknowledged. */
export function cursorIsConfirmed(cursor: { readonly cursor?: string; readonly evidence?: unknown },
  lastAckedCursor: string | undefined, acks: readonly AckIntentRecord[]): boolean {
  if (!cursor.cursor) return false;
  return acks.some(ack => ack.state === 'complete' && ack.cursor === cursor.cursor)
    || (cursor.evidence !== null && typeof cursor.evidence === 'object'
      && 'sessionAuthority' in cursor.evidence && cursor.evidence.sessionAuthority === true
      && lastAckedCursor === cursor.cursor);
}
