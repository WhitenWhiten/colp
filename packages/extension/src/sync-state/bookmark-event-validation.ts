import { withCodecSubject, codecRecordSubject } from './codec-subject.js';
import { SyncStateError, type BookmarkEventInput, type BookmarkEventRecord } from './types.js';
import { boundedString, clone, safeInteger, strictObject, validateJson, validateRecord } from './codec.js';
import type { JsonObject } from './types.js';

export function validateBookmarkEventInput(input: unknown, maxBytes: number): BookmarkEventInput {
  return withCodecSubject(codecRecordSubject(input), () => validateBookmarkEventInputValue(input, maxBytes));
}
function validateBookmarkEventInputValue(input: unknown, maxBytes: number): BookmarkEventInput {
  const value = strictObject(clone(input), ['eventId', 'dedupeKey', 'occurredAt', 'kind', 'nativeId', 'details'],
    'bookmark event');
  if (!['create', 'change', 'move', 'remove'].includes(String(value.kind))) throw new SyncStateError('bookmark_event_kind_invalid');
  const record: BookmarkEventInput = { eventId: boundedString(value.eventId, 'eventId'),
    dedupeKey: boundedString(value.dedupeKey, 'dedupeKey'),
    occurredAt: boundedString(value.occurredAt, 'occurredAt'), kind: value.kind as BookmarkEventInput['kind'],
    nativeId: boundedString(value.nativeId, 'nativeId'), details: validateJson(value.details, 'event.details') as JsonObject };
  validateRecord(record, maxBytes); return record;
}
export function validateBookmarkEventRecord(input: unknown, maxBytes: number): BookmarkEventRecord {
  const value = strictObject(clone(input), ['scopeKey', 'ordinal', 'status', 'eventId', 'dedupeKey', 'opId',
    'occurredAt', 'kind', 'nativeId', 'details'], 'bookmark event record');
  if (!['pending', 'processed'].includes(String(value.status))) throw new SyncStateError('bookmark_event_status_invalid');
  const event = validateBookmarkEventInput(Object.fromEntries(['eventId', 'dedupeKey', 'occurredAt', 'kind',
    'nativeId', 'details'].map((field) => [field, value[field]])), maxBytes);
  const status = value.status as BookmarkEventRecord['status'];
  const opId = value.opId === null ? null : boundedString(value.opId, 'opId');
  if ((status === 'pending' && opId !== null) || (status === 'processed' && opId === null)) {
    throw new SyncStateError('bookmark_event_operation_state_invalid');
  }
  const record: BookmarkEventRecord = { ...event, scopeKey: boundedString(value.scopeKey, 'scopeKey', 16_384),
    ordinal: safeInteger(value.ordinal, 'bookmark event ordinal', 1), status, opId };
  validateRecord(record, maxBytes); return record;
}
