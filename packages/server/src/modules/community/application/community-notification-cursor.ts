/**
 * CS-05 community notifications inbox cursor: the opaque
 * `keyId.body.signature` token bound to the community inbox endpoint.
 *
 * Tokens are signed with a purpose-derived HMAC key
 * (`COMMUNITY_CURSOR_HMAC_KEY` → `community.notifications`), so a token
 * minted for the comment list or replies endpoint can never verify here.
 * The payload binds the endpoint, recipient account, the `read` filter,
 * the page limit, and the keyset position; TTL is 900 seconds. Tamper,
 * binding mismatch, or expiry all map to `invalid_cursor`.
 */
import {
  createKeyedCursorCodec,
  type KeyedCursorCodec,
} from '../../commands/index.js';
import { CommunityNotificationError } from './community-notification.js';

export const COMMUNITY_NOTIFICATIONS_ENDPOINT = 'community.notifications' as const;
export const COMMUNITY_NOTIFICATION_CURSOR_KEY_ID = 'cnk-v1' as const;
export const COMMUNITY_NOTIFICATION_CURSOR_TTL_MS = 900_000;
export const COMMUNITY_NOTIFICATION_READ_FILTERS = Object.freeze(['all', 'unread'] as const);
export type CommunityNotificationReadFilter = (typeof COMMUNITY_NOTIFICATION_READ_FILTERS)[number];

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_LIMIT = 100;

/** Closed signed payload; every field is validated on verify. */
export interface CommunityNotificationCursorPayload {
  readonly v: 1;
  readonly ep: typeof COMMUNITY_NOTIFICATIONS_ENDPOINT;
  readonly vw: string;
  readonly ft: CommunityNotificationReadFilter;
  readonly lm: number;
  readonly pos: { readonly t: string; readonly i: string };
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type CommunityNotificationCursorCodec =
  KeyedCursorCodec<CommunityNotificationCursorPayload>;

/** Uniform cursor rejection — tamper, binding mismatch, and expiry agree. */
export function communityNotificationInvalidCursor(): CommunityNotificationError {
  return new CommunityNotificationError('invalid_cursor', 'The community notification cursor is invalid.');
}

/**
 * Purpose-derived HMAC cursor codec bound to the community inbox endpoint;
 * single active `cnk-v1` key.
 */
export function createCommunityNotificationCursorCodec(
  cursorHmacKey: Buffer,
): CommunityNotificationCursorCodec {
  if (!(cursorHmacKey instanceof Buffer) || cursorHmacKey.length < 16) {
    throw new TypeError('community notification cursor requires a configured HMAC key');
  }
  return createKeyedCursorCodec<CommunityNotificationCursorPayload>({
    mode: 'hmac-sha256',
    hmac: { variant: 'derived', purpose: COMMUNITY_NOTIFICATIONS_ENDPOINT },
    ttlMs: COMMUNITY_NOTIFICATION_CURSOR_TTL_MS,
    keys: { current: { id: COMMUNITY_NOTIFICATION_CURSOR_KEY_ID, key: cursorHmacKey.toString('base64') } },
    invalid: communityNotificationInvalidCursor,
    validate: validateCursorPayload,
    messages: {
      invalidCurrent: 'community notification cursor key is invalid',
      uniqueIds: 'community notification cursor key ids must be unique',
      invalidRetainUntil: 'community notification cursor retainUntil is invalid',
    },
  });
}

const PAYLOAD_KEYS = ['ep', 'expiresAt', 'ft', 'issuedAt', 'lm', 'pos', 'v', 'vw'] as const;
const POSITION_KEYS = ['i', 't'] as const;

function validateCursorPayload(value: unknown): CommunityNotificationCursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== PAYLOAD_KEYS.length
      || !PAYLOAD_KEYS.every((key, index) => keys[index] === key)) throw new Error();
  if (record.v !== 1 || record.ep !== COMMUNITY_NOTIFICATIONS_ENDPOINT) throw new Error();
  if (typeof record.vw !== 'string' || record.vw.length < 1 || record.vw.length > 128) {
    throw new Error();
  }
  if (typeof record.ft !== 'string'
      || !(COMMUNITY_NOTIFICATION_READ_FILTERS as readonly string[]).includes(record.ft)) {
    throw new Error();
  }
  if (!Number.isInteger(record.lm) || (record.lm as number) < 1
      || (record.lm as number) > MAX_LIMIT) throw new Error();
  for (const name of ['issuedAt', 'expiresAt'] as const) {
    const stamp = record[name];
    if (typeof stamp !== 'string' || !RFC3339_MILLIS.test(stamp)
        || !Number.isFinite(Date.parse(stamp))) throw new Error();
  }
  const position = record.pos;
  if (typeof position !== 'object' || position === null || Array.isArray(position)) {
    throw new Error();
  }
  const pkeys = Object.keys(position).sort();
  if (pkeys.length !== POSITION_KEYS.length
      || !POSITION_KEYS.every((key, index) => pkeys[index] === key)) throw new Error();
  const pos = position as Record<string, unknown>;
  if (typeof pos.t !== 'string' || !RFC3339_MILLIS.test(pos.t) || !Number.isFinite(Date.parse(pos.t))) {
    throw new Error();
  }
  if (typeof pos.i !== 'string' || !OPAQUE_ID.test(pos.i)) throw new Error();
  return value as CommunityNotificationCursorPayload;
}
