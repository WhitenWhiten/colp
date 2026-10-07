import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENTS_ENDPOINT,
  COMMUNITY_COMMENT_CURSOR_KEY_ID,
  COMMUNITY_COMMENT_CURSOR_TTL_MS,
  COMMUNITY_COMMENT_REPLIES_ENDPOINT,
  COMMUNITY_STATIC_GENERATION,
  CommunityCommentError,
  createCommunityCommentCursorCodec,
  type CommunityCommentCursorPayload,
} from '../../../src/modules/community/index.js';

function invalidCursor(error: unknown): boolean {
  return error instanceof CommunityCommentError && error.code === 'invalid_cursor';
}

const HMAC_KEY = Buffer.alloc(32, 17);
const NOW = new Date('2026-10-03T10:00:00.000Z');

function payload(overrides: Partial<CommunityCommentCursorPayload> = {}): CommunityCommentCursorPayload {
  return {
    v: 1,
    ep: COMMUNITY_COMMENTS_ENDPOINT,
    vw: 'anonymous',
    tg: { k: 'collection', i: 'col-1', c: null, s: null, g: COMMUNITY_STATIC_GENERATION },
    rt: null,
    lm: 20,
    pos: { t: '2026-10-03T09:59:00.000Z', i: 'comment-9' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + COMMUNITY_COMMENT_CURSOR_TTL_MS).toISOString(),
    ...overrides,
  };
}

test('comment cursor codec signs and verifies a bound payload', () => {
  const codec = createCommunityCommentCursorCodec(HMAC_KEY, COMMUNITY_COMMENTS_ENDPOINT);
  const token = codec.sign(payload());
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.ok(token.startsWith(`${COMMUNITY_COMMENT_CURSOR_KEY_ID}.`));
  const verified = codec.verify(token, new Date(NOW.getTime() + 1_000));
  assert.equal(verified.ep, COMMUNITY_COMMENTS_ENDPOINT);
  assert.equal(verified.vw, 'anonymous');
  assert.deepEqual(verified.tg, {
    k: 'collection', i: 'col-1', c: null, s: null, g: COMMUNITY_STATIC_GENERATION,
  });
  assert.equal(verified.rt, null);
  assert.equal(verified.lm, 20);
  assert.deepEqual(verified.pos, { t: '2026-10-03T09:59:00.000Z', i: 'comment-9' });
});

test('comment cursor rejects tampering, foreign endpoints and expiry as invalid_cursor', () => {
  const listCodec = createCommunityCommentCursorCodec(HMAC_KEY, COMMUNITY_COMMENTS_ENDPOINT);
  const repliesCodec = createCommunityCommentCursorCodec(HMAC_KEY, COMMUNITY_COMMENT_REPLIES_ENDPOINT);
  const token = listCodec.sign(payload());

  // Tampered signature segment.
  assert.throws(() => listCodec.verify(`${token.slice(0, -2)}zz`, NOW), invalidCursor);
  // A cursor minted for the replies endpoint never verifies against the
  // list codec — the endpoint is part of the derived key purpose.
  const foreign = repliesCodec.sign(payload({ ep: COMMUNITY_COMMENT_REPLIES_ENDPOINT, rt: 'comment-root' }));
  assert.throws(() => listCodec.verify(foreign, NOW), invalidCursor);
  // Expired payload (TTL 900s) is invalid.
  const expired = listCodec.sign(payload({
    issuedAt: new Date(NOW.getTime() - 901_000).toISOString(),
    expiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
  }));
  assert.throws(() => listCodec.verify(expired, NOW), invalidCursor);
  // A wrong key can never verify the token.
  const other = createCommunityCommentCursorCodec(Buffer.alloc(32, 3), COMMUNITY_COMMENTS_ENDPOINT);
  assert.throws(() => other.verify(token, NOW), invalidCursor);
});

test('comment cursor payload validation rejects malformed bound claims', () => {
  const codec = createCommunityCommentCursorCodec(HMAC_KEY, COMMUNITY_COMMENTS_ENDPOINT);
  const good = codec.sign(payload());
  assert.doesNotThrow(() => codec.verify(good, NOW));

  // Re-sign variants through the codec: validate() runs inside sign too,
  // so malformed claims can never be minted by this codec.
  for (const bad of [
    payload({ v: 2 as never }),
    payload({ ep: 'community.ranking' as never }),
    payload({ vw: '' }),
    payload({ lm: 0 }),
    payload({ lm: 101 }),
    payload({ rt: 'bad id!' }),
    payload({ tg: { k: 'account' as never, i: 'x', c: null, s: null, g: 'g' } }),
    payload({ tg: { k: 'collection', i: 'bad id!', c: null, s: null, g: 'g' } }),
    payload({ tg: { k: 'collection', i: 'x', c: null, s: null, g: '' } }),
    payload({ pos: { t: 'not-a-date', i: 'comment-1' } }),
    payload({ pos: { t: NOW.toISOString(), i: 'bad id!' } }),
    payload({ issuedAt: 'garbage', expiresAt: payload().expiresAt }),
    { ...payload(), extra: true } as CommunityCommentCursorPayload,
  ]) {
    assert.throws(() => codec.sign(bad), undefined, JSON.stringify(bad));
  }
});

test('comment cursor codec requires a configured key and a known endpoint', () => {
  assert.throws(
    () => createCommunityCommentCursorCodec(Buffer.alloc(8, 1), COMMUNITY_COMMENTS_ENDPOINT),
    TypeError);
  assert.throws(
    () => createCommunityCommentCursorCodec(HMAC_KEY, 'community.ranking' as never),
    TypeError);
});
