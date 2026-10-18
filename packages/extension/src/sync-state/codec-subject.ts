import type { SyncFailureSubject } from '../sync-failure-class.js';
import { SyncStateError } from './types.js';

export function withCodecSubject<T>(subject: SyncFailureSubject, write: () => T): T {
  try { return write(); }
  catch (error) {
    if (error instanceof SyncStateError) Object.assign(error, { subject });
    throw error;
  }
}

export function codecRecordSubject(input: unknown): SyncFailureSubject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const row = input as Record<string, unknown>;
  const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {};
  const subject: Record<string, string> = {};
  for (const [key, value] of Object.entries({ opId: row.opId, nativeId: row.nativeId, eventId: row.eventId, nodeId: payload.targetId })) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 1024) subject[key] = value;
  }
  return subject;
}
