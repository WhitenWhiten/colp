import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const NOTIFICATION_INBOX_CURSOR_PURPOSE = 'notifications.inbox.v1' as const;
export const NOTIFICATION_INBOX_CURSOR_COMPARATOR_VERSION = 1 as const;
export const NOTIFICATION_INBOX_CURSOR_TTL_MS = 15 * 60 * 1000;
const PREFIX = 'ninbox1';
const PAYLOAD_KEYS = ['after','comparatorVersion','expiresAt','filter','issuedAt','keyVersion','limit',
  'principalId','purpose','v'];
const AFTER_KEYS = ['notificationId','occurredAt'];

export class NotificationInboxCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'NotificationInboxCursorError'; }
}
export interface NotificationInboxCursorKey { readonly id: string; readonly secret: string; }
export interface RetainedNotificationInboxCursorKey extends NotificationInboxCursorKey {
  readonly lastIssuedAt: string; readonly retainUntil: string;
}
export interface NotificationInboxCursorAfter {
  readonly occurredAt: string; readonly notificationId: string;
}
export type NotificationInboxCursorFilter = '' | 'read' | 'unread';
export interface NotificationInboxCursorPayload {
  readonly v: 1; readonly purpose: typeof NOTIFICATION_INBOX_CURSOR_PURPOSE;
  readonly principalId: string; readonly filter: NotificationInboxCursorFilter;
  readonly limit: number; readonly comparatorVersion: 1; readonly keyVersion: string;
  readonly after: NotificationInboxCursorAfter; readonly issuedAt: string; readonly expiresAt: string;
}
export type UnsignedNotificationInboxCursorPayload = Omit<NotificationInboxCursorPayload, 'keyVersion'>;
export interface NotificationInboxCursorCodec {
  seal(payload: UnsignedNotificationInboxCursorPayload): string;
  verify(token: string, now: Date): NotificationInboxCursorPayload;
}
export interface NotificationInboxCursorKeyring {
  readonly inbox: NotificationInboxCursorCodec; destroy(): void;
}

export function createNotificationInboxCursorKeyring(config: {
  readonly active: NotificationInboxCursorKey;
  readonly retained: readonly RetainedNotificationInboxCursorKey[];
}): NotificationInboxCursorKeyring {
  const codec = createKeyedCursorCodec({
    mode: 'aes-256-gcm',
    purpose: NOTIFICATION_INBOX_CURSOR_PURPOSE,
    prefix: PREFIX,
    hkdfSalt: 'known/notifications/inbox-cursor/v1',
    ttlMs: NOTIFICATION_INBOX_CURSOR_TTL_MS,
    keys: { current: config.active, previous: config.retained },
    invalid: () => new NotificationInboxCursorError(),
    validate,
    messages: {
      invalidKey: 'invalid Notification inbox cursor key',
      canonicalSecret: 'Notification inbox cursor key must be canonical base64 and at least 32 bytes',
      tooManyKeys: 'Notification inbox cursor supports at most 8 retained keys',
      uniqueKeys: 'Notification inbox cursor key ids and material must be unique',
      retention: 'Notification inbox retained key lifetime must cover cursor TTL',
    },
  });
  return Object.freeze({
    inbox: Object.freeze({
      seal: (payload: UnsignedNotificationInboxCursorPayload) => codec.seal(payload),
      verify: (token: string, now: Date) => codec.verify(token, now),
    }),
    destroy: () => codec.destroy(),
  });
}

function validate(value: unknown): NotificationInboxCursorPayload {
  if (!recordWithExactKeys(value, PAYLOAD_KEYS) || !recordWithExactKeys(value.after, AFTER_KEYS)
    || value.v !== 1 || value.purpose !== NOTIFICATION_INBOX_CURSOR_PURPOSE
    || !identity(value.principalId) || !validFilter(value.filter)
    || !Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100
    || value.comparatorVersion !== 1 || typeof value.keyVersion !== 'string'
    || !identity(value.after.notificationId) || typeof value.after.occurredAt !== 'string'
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  parseCursorTimestamp(value.after.occurredAt, 'rfc3339-millis');
  parseCursorTimestamp(value.issuedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.expiresAt, 'rfc3339-millis');
  return value as unknown as NotificationInboxCursorPayload;
}
function identity(value: unknown): value is string { return typeof value === 'string'
  && value.length > 0 && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value; }
function validFilter(value: unknown): value is NotificationInboxCursorFilter {
  return value === '' || value === 'read' || value === 'unread';
}
