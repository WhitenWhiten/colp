import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const FOLLOWERS_CURSOR_PURPOSE = 'social.followers.v1' as const;
export const FOLLOWING_CURSOR_PURPOSE = 'social.following.v1' as const;
export const FOLLOW_CURSOR_COMPARATOR_VERSION = 1 as const;
export const FOLLOW_CURSOR_TTL_MS = 15 * 60 * 1000;
const TOKEN_PREFIX = 'sfc1';
const PAYLOAD_KEYS = ['after','actorProfileId','comparatorVersion','direction','expiresAt','filter','issuedAt',
  'keyVersion','limit','principalId','purpose','targetProfileId','v'];
const AFTER_KEYS = ['followedAt','profileId'];

export class FollowCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'FollowCursorError'; }
}
export interface FollowCursorKey { readonly id: string; readonly secret: string; }
export interface RetainedFollowCursorKey extends FollowCursorKey {
  readonly lastIssuedAt: string; readonly retainUntil: string;
}
export interface FollowCursorAfter { readonly followedAt: string; readonly profileId: string; }
export interface FollowCursorPayload {
  readonly v: 1;
  readonly purpose: typeof FOLLOWERS_CURSOR_PURPOSE | typeof FOLLOWING_CURSOR_PURPOSE;
  readonly direction: 'followers' | 'following';
  readonly principalId: string;
  readonly targetProfileId: string | null;
  readonly actorProfileId: string | null;
  readonly filter: string;
  readonly limit: number;
  readonly comparatorVersion: 1;
  readonly keyVersion: string;
  readonly after: FollowCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type UnsignedFollowCursorPayload = Omit<FollowCursorPayload, 'keyVersion'>;
export interface FollowCursorCodec {
  seal(payload: UnsignedFollowCursorPayload): string;
  verify(token: string, now: Date): FollowCursorPayload;
}
export interface FollowCursorKeyring {
  readonly followers: FollowCursorCodec;
  readonly following: FollowCursorCodec;
  destroy(): void;
}

export function createFollowCursorKeyring(config: {
  readonly active: FollowCursorKey; readonly retained: readonly RetainedFollowCursorKey[];
}): FollowCursorKeyring {
  const make = (purpose: FollowCursorPayload['purpose']): ReturnType<typeof createKeyedCursorCodec<FollowCursorPayload>> =>
    createKeyedCursorCodec({
      mode: 'aes-256-gcm',
      purpose,
      prefix: TOKEN_PREFIX,
      hkdfSalt: 'known/social/follow-cursor/v1',
      ttlMs: FOLLOW_CURSOR_TTL_MS,
      keys: { current: config.active, previous: config.retained },
      invalid: () => new FollowCursorError(),
      validate: (value) => validate(value, purpose),
      messages: {
        invalidKey: 'invalid Follow cursor key',
        canonicalSecret: 'Follow cursor key must be canonical base64 and at least 32 bytes',
        tooManyKeys: 'Follow cursor supports at most 8 retained keys',
        uniqueKeys: 'Follow cursor key ids and material must be unique',
        retention: 'Follow cursor retained key lifetime must cover cursor TTL',
      },
    });
  const followers = make(FOLLOWERS_CURSOR_PURPOSE);
  const following = make(FOLLOWING_CURSOR_PURPOSE);
  return Object.freeze({
    followers: Object.freeze({
      seal: (payload: UnsignedFollowCursorPayload) => followers.seal(payload),
      verify: (token: string, now: Date) => followers.verify(token, now),
    }),
    following: Object.freeze({
      seal: (payload: UnsignedFollowCursorPayload) => following.seal(payload),
      verify: (token: string, now: Date) => following.verify(token, now),
    }),
    destroy() {
      followers.destroy();
      following.destroy();
    },
  });
}

function validate(value: unknown, purpose: FollowCursorPayload['purpose']): FollowCursorPayload {
  if (!recordWithExactKeys(value, PAYLOAD_KEYS) || !recordWithExactKeys(value.after, AFTER_KEYS)) throw new Error();
  const expectedDirection = purpose === FOLLOWERS_CURSOR_PURPOSE ? 'followers' : 'following';
  if (value.v !== 1 || value.purpose !== purpose || value.direction !== expectedDirection
    || typeof value.principalId !== 'string' || !value.principalId
    || value.principalId.length > SOCIAL_IDENTITY_MAX_LENGTH
    || value.principalId.trim() !== value.principalId
    || typeof value.filter !== 'string' || value.filter.length > 128
    || !Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100
    || value.comparatorVersion !== 1 || typeof value.keyVersion !== 'string'
    || typeof value.after.followedAt !== 'string' || typeof value.after.profileId !== 'string' || !value.after.profileId
    || value.after.profileId.length > SOCIAL_IDENTITY_MAX_LENGTH
    || value.after.profileId.trim() !== value.after.profileId
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  const targetProfileId = value.targetProfileId; const actorProfileId = value.actorProfileId;
  if (expectedDirection === 'followers' ? (typeof targetProfileId !== 'string' || !targetProfileId
      || targetProfileId.length > SOCIAL_IDENTITY_MAX_LENGTH
      || targetProfileId.trim() !== targetProfileId || actorProfileId !== null)
    : (typeof actorProfileId !== 'string' || !actorProfileId
      || actorProfileId.length > SOCIAL_IDENTITY_MAX_LENGTH
      || actorProfileId.trim() !== actorProfileId
      || targetProfileId !== null)) throw new Error();
  parseCursorTimestamp(value.after.followedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.issuedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.expiresAt, 'rfc3339-millis');
  return value as unknown as FollowCursorPayload;
}
