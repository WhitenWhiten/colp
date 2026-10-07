import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const FEED_CURSOR_PURPOSE = 'social.feed.v1' as const;
export const FEED_CURSOR_COMPARATOR_VERSION = 1 as const;
export const FEED_CURSOR_TTL_MS = 15 * 60 * 1000;
const PREFIX = 'sfeed1';
const PAYLOAD_KEYS = ['after','comparatorVersion','expiresAt','filter','issuedAt','keyVersion','limit',
  'principalId','purpose','v'];
const AFTER_KEYS = ['feedItemId','publishedAt','sourceEventId'];

export class FeedCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'FeedCursorError'; }
}
export interface FeedCursorKey { readonly id: string; readonly secret: string; }
export interface RetainedFeedCursorKey extends FeedCursorKey {
  readonly lastIssuedAt: string; readonly retainUntil: string;
}
export interface FeedCursorAfter {
  readonly publishedAt: string; readonly sourceEventId: string; readonly feedItemId: string;
}
export interface FeedCursorPayload {
  readonly v: 1; readonly purpose: typeof FEED_CURSOR_PURPOSE; readonly principalId: string;
  readonly filter: string; readonly limit: number; readonly comparatorVersion: 1;
  readonly keyVersion: string; readonly after: FeedCursorAfter;
  readonly issuedAt: string; readonly expiresAt: string;
}
type UnsignedFeedCursorPayload = Omit<FeedCursorPayload, 'keyVersion'>;
export interface FeedCursorCodec {
  seal(payload: UnsignedFeedCursorPayload): string;
  verify(token: string, now: Date): FeedCursorPayload;
}
export interface FeedCursorKeyring { readonly feed: FeedCursorCodec; destroy(): void; }

export function createFeedCursorKeyring(config: {
  readonly active: FeedCursorKey; readonly retained: readonly RetainedFeedCursorKey[];
}): FeedCursorKeyring {
  const codec = createKeyedCursorCodec({
    mode: 'aes-256-gcm',
    purpose: FEED_CURSOR_PURPOSE,
    prefix: PREFIX,
    hkdfSalt: 'known/social/feed-cursor/v1',
    ttlMs: FEED_CURSOR_TTL_MS,
    keys: { current: config.active, previous: config.retained },
    invalid: () => new FeedCursorError(),
    validate,
    messages: {
      invalidKey: 'invalid Feed cursor key',
      canonicalSecret: 'Feed cursor key must be canonical base64 and at least 32 bytes',
      tooManyKeys: 'Feed cursor supports at most 8 retained keys',
      uniqueKeys: 'Feed cursor key ids and material must be unique',
      retention: 'Feed cursor retained key lifetime must cover cursor TTL',
    },
  });
  return Object.freeze({
    feed: Object.freeze({
      seal: (payload: UnsignedFeedCursorPayload) => codec.seal(payload),
      verify: (token: string, now: Date) => codec.verify(token, now),
    }),
    destroy: () => codec.destroy(),
  });
}

function validate(value: unknown): FeedCursorPayload {
  if (!recordWithExactKeys(value, PAYLOAD_KEYS) || !recordWithExactKeys(value.after, AFTER_KEYS)
    || value.v !== 1 || value.purpose !== FEED_CURSOR_PURPOSE
    || !identity(value.principalId) || !validFilter(value.filter)
    || !Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100
    || value.comparatorVersion !== 1 || typeof value.keyVersion !== 'string'
    || !identity(value.after.sourceEventId) || !identity(value.after.feedItemId)
    || typeof value.after.publishedAt !== 'string'
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  parseCursorTimestamp(value.after.publishedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.issuedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.expiresAt, 'rfc3339-millis');
  return value as unknown as FeedCursorPayload;
}
function identity(value: unknown): value is string { return typeof value === 'string' && value.length > 0
  && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value; }
function validFilter(value: unknown): value is string { return value === ''
  || value === 'collection_change' || value === 'follow_activity'; }
