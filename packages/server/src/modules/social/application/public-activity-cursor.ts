import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const PUBLIC_ACTIVITY_CURSOR_PURPOSE = 'social.public-activity.v1' as const;
export const PUBLIC_ACTIVITY_CURSOR_COMPARATOR_VERSION = 1 as const;
export const PUBLIC_ACTIVITY_CURSOR_TTL_MS = 15 * 60 * 1000;
const PREFIX = 'spact1';
const PAYLOAD_KEYS = ['after','comparatorVersion','expiresAt','filter','issuedAt','keyVersion','limit',
  'principalId','purpose','v'];
const AFTER_KEYS = ['activityId','publishedAt','sourceEventId'];

export class PublicActivityCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'PublicActivityCursorError'; }
}
export interface PublicActivityCursorKey { readonly id: string; readonly secret: string; }
export interface RetainedPublicActivityCursorKey extends PublicActivityCursorKey {
  readonly lastIssuedAt: string; readonly retainUntil: string;
}
export interface PublicActivityCursorAfter {
  readonly publishedAt: string; readonly sourceEventId: string; readonly activityId: string;
}
export interface PublicActivityCursorPayload {
  readonly v: 1; readonly purpose: typeof PUBLIC_ACTIVITY_CURSOR_PURPOSE; readonly principalId: string;
  readonly filter: string; readonly limit: number; readonly comparatorVersion: 1;
  readonly keyVersion: string; readonly after: PublicActivityCursorAfter;
  readonly issuedAt: string; readonly expiresAt: string;
}
type UnsignedPublicActivityCursorPayload = Omit<PublicActivityCursorPayload, 'keyVersion'>;
export interface PublicActivityCursorCodec {
  seal(payload: UnsignedPublicActivityCursorPayload): string;
  verify(token: string, now: Date): PublicActivityCursorPayload;
}
export interface PublicActivityCursorKeyring {
  readonly activity: PublicActivityCursorCodec;
  destroy(): void;
}

export function createPublicActivityCursorKeyring(config: {
  readonly active: PublicActivityCursorKey; readonly retained: readonly RetainedPublicActivityCursorKey[];
}): PublicActivityCursorKeyring {
  const codec = createKeyedCursorCodec({
    mode: 'aes-256-gcm',
    purpose: PUBLIC_ACTIVITY_CURSOR_PURPOSE,
    prefix: PREFIX,
    hkdfSalt: 'known/social/public-activity-cursor/v1',
    ttlMs: PUBLIC_ACTIVITY_CURSOR_TTL_MS,
    keys: { current: config.active, previous: config.retained },
    invalid: () => new PublicActivityCursorError(),
    validate,
    messages: {
      invalidKey: 'invalid public Activity cursor key',
      canonicalSecret: 'public Activity cursor key must be canonical base64 and at least 32 bytes',
      tooManyKeys: 'public Activity cursor supports at most 8 retained keys',
      uniqueKeys: 'public Activity cursor key ids and material must be unique',
      retention: 'public Activity cursor retained key lifetime must cover cursor TTL',
    },
  });
  return Object.freeze({
    activity: Object.freeze({
      seal: (payload: UnsignedPublicActivityCursorPayload) => codec.seal(payload),
      verify: (token: string, now: Date) => codec.verify(token, now),
    }),
    destroy: () => codec.destroy(),
  });
}

function validate(value: unknown): PublicActivityCursorPayload {
  if (!recordWithExactKeys(value, PAYLOAD_KEYS) || !recordWithExactKeys(value.after, AFTER_KEYS)
    || value.v !== 1 || value.purpose !== PUBLIC_ACTIVITY_CURSOR_PURPOSE
    || !identity(value.principalId) || !validFilter(value.filter)
    || !Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100
    || value.comparatorVersion !== 1 || typeof value.keyVersion !== 'string'
    || !identity(value.after.sourceEventId) || !identity(value.after.activityId)
    || typeof value.after.publishedAt !== 'string'
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  parseCursorTimestamp(value.after.publishedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.issuedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.expiresAt, 'rfc3339-millis');
  return value as unknown as PublicActivityCursorPayload;
}
function identity(value: unknown): value is string { return typeof value === 'string' && value.length > 0
  && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value; }
function validFilter(value: unknown): value is string { return value === ''; }
