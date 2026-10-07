/**
 * CS-03 community comments cursor codec: the opaque `keyId.body.signature`
 * token shared by the root list and replies endpoints.
 *
 * Tokens are signed with a purpose-derived HMAC key
 * (`COMMUNITY_CURSOR_HMAC_KEY` → the endpoint name), so a token minted for
 * the root list can never verify against the replies endpoint. The payload
 * binds the endpoint, viewer, full target identity + generation, the
 * replies root, and the page limit; TTL is 900 seconds. Tamper, mismatch,
 * or expiry all map to `invalid_cursor`.
 */
import {
  createKeyedCursorCodec,
  type KeyedCursorCodec,
} from '../../commands/index.js';
import {
  COMMUNITY_TARGET_KINDS,
  type CommunityTargetKind,
} from './community-target.js';
import { CommunityCommentError } from './community-comment.js';

export const COMMUNITY_COMMENTS_ENDPOINT = 'community.comments' as const;
export const COMMUNITY_COMMENT_REPLIES_ENDPOINT = 'community.comment.replies' as const;
export type CommunityCommentCursorEndpoint =
  | typeof COMMUNITY_COMMENTS_ENDPOINT
  | typeof COMMUNITY_COMMENT_REPLIES_ENDPOINT;
export const COMMUNITY_COMMENT_CURSOR_KEY_ID = 'cck-v1' as const;
export const COMMUNITY_COMMENT_CURSOR_TTL_MS = 900_000;
/**
 * Shared bound for the wire `limit` query parameter and the cursor payload
 * `lm` claim: a cursor minted for one limit never verifies for another.
 */
export const COMMUNITY_COMMENT_MAX_LIMIT = 100;

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Cursor-bound target identity: the closed kind/parent ids + generation. */
export interface CommunityCommentCursorTarget {
  readonly k: CommunityTargetKind;
  readonly i: string;
  readonly c: string | null;
  readonly s: string | null;
  readonly g: string;
}

/** Closed signed payload; every field is validated on verify. */
export interface CommunityCommentCursorPayload {
  readonly v: 1;
  readonly ep: CommunityCommentCursorEndpoint;
  readonly vw: string;
  readonly tg: CommunityCommentCursorTarget;
  readonly rt: string | null;
  readonly lm: number;
  readonly pos: { readonly t: string; readonly i: string };
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type CommunityCommentCursorCodec = KeyedCursorCodec<CommunityCommentCursorPayload>;

/** Uniform cursor rejection — tamper, binding mismatch, and expiry agree. */
export function communityCommentInvalidCursor(): CommunityCommentError {
  return new CommunityCommentError('invalid_cursor', 'The community comment cursor is invalid.');
}

/**
 * Purpose-derived HMAC cursor codec bound to one endpoint; single active
 * `cck-v1` key. The endpoint is part of the key purpose, so a token minted
 * for the root list can never verify against the replies endpoint.
 */
export function createCommunityCommentCursorCodec(
  cursorHmacKey: Buffer,
  endpoint: CommunityCommentCursorEndpoint,
): CommunityCommentCursorCodec {
  if (!(cursorHmacKey instanceof Buffer) || cursorHmacKey.length < 16) {
    throw new TypeError('community comment cursor requires a configured HMAC key');
  }
  if (endpoint !== COMMUNITY_COMMENTS_ENDPOINT && endpoint !== COMMUNITY_COMMENT_REPLIES_ENDPOINT) {
    throw new TypeError('community comment cursor endpoint is invalid');
  }
  return createKeyedCursorCodec<CommunityCommentCursorPayload>({
    mode: 'hmac-sha256',
    hmac: { variant: 'derived', purpose: endpoint },
    ttlMs: COMMUNITY_COMMENT_CURSOR_TTL_MS,
    keys: { current: { id: COMMUNITY_COMMENT_CURSOR_KEY_ID, key: cursorHmacKey.toString('base64') } },
    invalid: communityCommentInvalidCursor,
    validate: validateCursorPayload,
    messages: {
      invalidCurrent: 'community comment cursor key is invalid',
      uniqueIds: 'community comment cursor key ids must be unique',
      invalidRetainUntil: 'community comment cursor retainUntil is invalid',
    },
  });
}

const PAYLOAD_KEYS = ['ep', 'expiresAt', 'issuedAt', 'lm', 'pos', 'rt', 'tg', 'v', 'vw'] as const;
const TARGET_KEYS = ['c', 'g', 'i', 'k', 's'] as const;
const POSITION_KEYS = ['i', 't'] as const;

function validateCursorPayload(value: unknown): CommunityCommentCursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== PAYLOAD_KEYS.length
      || !PAYLOAD_KEYS.every((key, index) => keys[index] === key)) throw new Error();
  if (record.v !== 1
      || (record.ep !== COMMUNITY_COMMENTS_ENDPOINT
        && record.ep !== COMMUNITY_COMMENT_REPLIES_ENDPOINT)) throw new Error();
  if (typeof record.vw !== 'string' || record.vw.length < 1 || record.vw.length > 128) throw new Error();
  if (!Number.isInteger(record.lm) || (record.lm as number) < 1
      || (record.lm as number) > COMMUNITY_COMMENT_MAX_LIMIT) throw new Error();
  if (record.rt !== null && (typeof record.rt !== 'string' || !OPAQUE_ID.test(record.rt as string))) {
    throw new Error();
  }
  for (const name of ['issuedAt', 'expiresAt'] as const) {
    const stamp = record[name];
    if (typeof stamp !== 'string' || !RFC3339_MILLIS.test(stamp)
        || !Number.isFinite(Date.parse(stamp))) throw new Error();
  }
  const target = record.tg;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) throw new Error();
  const tkeys = Object.keys(target).sort();
  if (tkeys.length !== TARGET_KEYS.length
      || !TARGET_KEYS.every((key, index) => tkeys[index] === key)) throw new Error();
  const tg = target as Record<string, unknown>;
  if (typeof tg.k !== 'string'
      || !(COMMUNITY_TARGET_KINDS as readonly string[]).includes(tg.k)) throw new Error();
  if (typeof tg.i !== 'string' || !OPAQUE_ID.test(tg.i)) throw new Error();
  if (typeof tg.g !== 'string' || !OPAQUE_ID.test(tg.g)) throw new Error();
  for (const name of ['c', 's'] as const) {
    if (tg[name] !== null && (typeof tg[name] !== 'string' || !OPAQUE_ID.test(tg[name] as string))) {
      throw new Error();
    }
  }
  const position = record.pos;
  if (typeof position !== 'object' || position === null || Array.isArray(position)) throw new Error();
  const pkeys = Object.keys(position).sort();
  if (pkeys.length !== POSITION_KEYS.length
      || !POSITION_KEYS.every((key, index) => pkeys[index] === key)) throw new Error();
  const pos = position as Record<string, unknown>;
  if (typeof pos.t !== 'string' || !RFC3339_MILLIS.test(pos.t) || !Number.isFinite(Date.parse(pos.t))) {
    throw new Error();
  }
  if (typeof pos.i !== 'string' || !OPAQUE_ID.test(pos.i)) throw new Error();
  return value as CommunityCommentCursorPayload;
}
