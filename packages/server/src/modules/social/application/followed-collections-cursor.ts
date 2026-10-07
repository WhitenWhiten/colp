import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const FOLLOWED_COLLECTIONS_CURSOR_PURPOSE = 'followed_collections_v1' as const;
export const FOLLOWED_COLLECTIONS_CURSOR_COMPARATOR_VERSION = 1 as const;
export const FOLLOWED_COLLECTIONS_CURSOR_TTL_MS = 15 * 60 * 1000;
const TOKEN_PREFIX = 'sfcc1';
const PAYLOAD_KEYS = ['after','comparatorVersion','expiresAt','issuedAt','keyVersion','limit',
  'principalId','purpose','v'];
const AFTER_KEYS = ['collectionId','followedAt'];

export class FollowedCollectionsCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'FollowedCollectionsCursorError'; }
}
export interface FollowedCollectionsCursorKey { readonly id: string; readonly secret: string; }
export interface RetainedFollowedCollectionsCursorKey extends FollowedCollectionsCursorKey {
  readonly lastIssuedAt: string; readonly retainUntil: string;
}
export interface FollowedCollectionsCursorAfter {
  readonly followedAt: string; readonly collectionId: string;
}
export interface FollowedCollectionsCursorPayload {
  readonly v: 1;
  readonly purpose: typeof FOLLOWED_COLLECTIONS_CURSOR_PURPOSE;
  readonly principalId: string;
  readonly limit: number;
  readonly comparatorVersion: 1;
  readonly keyVersion: string;
  readonly after: FollowedCollectionsCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type UnsignedFollowedCollectionsCursorPayload = Omit<FollowedCollectionsCursorPayload, 'keyVersion'>;
export interface FollowedCollectionsCursorCodec {
  seal(payload: UnsignedFollowedCollectionsCursorPayload): string;
  verify(token: string, now: Date): FollowedCollectionsCursorPayload;
}
export interface FollowedCollectionsCursorKeyring {
  readonly followedCollections: FollowedCollectionsCursorCodec;
  destroy(): void;
}

export function createFollowedCollectionsCursorKeyring(config: {
  readonly active: FollowedCollectionsCursorKey;
  readonly retained: readonly RetainedFollowedCollectionsCursorKey[];
}): FollowedCollectionsCursorKeyring {
  const codec = createKeyedCursorCodec({
    mode: 'aes-256-gcm',
    purpose: FOLLOWED_COLLECTIONS_CURSOR_PURPOSE,
    prefix: TOKEN_PREFIX,
    hkdfSalt: 'known/social/followed-collections-cursor/v1',
    ttlMs: FOLLOWED_COLLECTIONS_CURSOR_TTL_MS,
    keys: { current: config.active, previous: config.retained },
    invalid: () => new FollowedCollectionsCursorError(),
    validate,
    messages: {
      invalidKey: 'invalid Followed collections cursor key',
      canonicalSecret: 'Followed collections cursor key must be canonical base64 and at least 32 bytes',
      tooManyKeys: 'Followed collections cursor supports at most 8 retained keys',
      uniqueKeys: 'Followed collections cursor key ids and material must be unique',
      retention: 'Followed collections retained key lifetime must cover cursor TTL',
    },
  });
  return Object.freeze({
    followedCollections: Object.freeze({
      seal: (payload: UnsignedFollowedCollectionsCursorPayload) => codec.seal(payload),
      verify: (token: string, now: Date) => codec.verify(token, now),
    }),
    destroy: () => codec.destroy(),
  });
}

function validate(value: unknown): FollowedCollectionsCursorPayload {
  if (!recordWithExactKeys(value, PAYLOAD_KEYS) || !recordWithExactKeys(value.after, AFTER_KEYS)) throw new Error();
  if (value.v !== 1 || value.purpose !== FOLLOWED_COLLECTIONS_CURSOR_PURPOSE
    || typeof value.principalId !== 'string' || !value.principalId
    || value.principalId.length > SOCIAL_IDENTITY_MAX_LENGTH
    || value.principalId.trim() !== value.principalId
    || !Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 50
    || value.comparatorVersion !== 1 || typeof value.keyVersion !== 'string'
    || typeof value.after.followedAt !== 'string' || typeof value.after.collectionId !== 'string'
    || !value.after.collectionId
    || value.after.collectionId.length > SOCIAL_IDENTITY_MAX_LENGTH
    || value.after.collectionId.trim() !== value.after.collectionId
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  parseCursorTimestamp(value.after.followedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.issuedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.expiresAt, 'rfc3339-millis');
  return value as unknown as FollowedCollectionsCursorPayload;
}
