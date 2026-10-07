import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_NOTIFICATIONS_ENDPOINT,
  COMMUNITY_NOTIFICATION_CURSOR_KEY_ID,
  COMMUNITY_NOTIFICATION_CURSOR_TTL_MS,
  createCommunityNotificationCursorCodec,
  type CommunityNotificationCursorPayload,
} from '../../../src/modules/community/index.js';

const HMAC_KEY = Buffer.alloc(32, 9);
const NOW = new Date('2026-10-05T12:00:00.000Z');

function payload(overrides: Partial<CommunityNotificationCursorPayload> = {}): CommunityNotificationCursorPayload {
  return {
    v: 1,
    ep: COMMUNITY_NOTIFICATIONS_ENDPOINT,
    vw: 'a-viewer',
    ft: 'all',
    lm: 20,
    pos: { t: '2026-10-05T11:00:00.000Z', i: 'n-99' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + COMMUNITY_NOTIFICATION_CURSOR_TTL_MS).toISOString(),
    ...overrides,
  };
}

test('cursor codec round-trips an opaque keyId.body.signature token', () => {
  const codec = createCommunityNotificationCursorCodec(HMAC_KEY);
  const token = codec.sign(payload());
  const [keyId, body, sig] = token.split('.');
  assert.equal(keyId, COMMUNITY_NOTIFICATION_CURSOR_KEY_ID);
  assert.ok(body.length > 0 && sig.length === 43);
  assert.deepEqual(codec.verify(token, NOW), payload());
});

test('cursor verify rejects tampered bodies, forged signatures, and unknown keys', () => {
  const codec = createCommunityNotificationCursorCodec(HMAC_KEY);
  const token = codec.sign(payload());
  const [keyId, body, sig] = token.split('.');
  const forgedBody = `${keyId}.${Buffer.from('{"x":1}').toString('base64url')}.${sig}`;
  assert.throws(() => codec.verify(forgedBody, NOW), /cursor/u);
  assert.throws(() => codec.verify(`${keyId}.${body}.${sig}00`, NOW), /cursor/u);
  assert.throws(() => codec.verify(`cnk-v2.${body}.${sig}`, NOW), /cursor/u);
  assert.throws(() => codec.verify('not-a-token', NOW), /cursor/u);
});

test('cursor verify enforces the 900 second TTL', () => {
  const codec = createCommunityNotificationCursorCodec(HMAC_KEY);
  const token = codec.sign(payload());
  const atBoundary = new Date(NOW.getTime() + COMMUNITY_NOTIFICATION_CURSOR_TTL_MS);
  assert.throws(() => codec.verify(token, atBoundary), /cursor/u);
  const stillValid = new Date(NOW.getTime() + COMMUNITY_NOTIFICATION_CURSOR_TTL_MS - 1000);
  assert.doesNotThrow(() => codec.verify(token, stillValid));
});

test('cursor verify rejects tokens signed under a different hmac key', () => {
  const codec = createCommunityNotificationCursorCodec(HMAC_KEY);
  const token = codec.sign(payload());
  const wrongKey = createCommunityNotificationCursorCodec(Buffer.alloc(32, 3));
  assert.throws(() => wrongKey.verify(token, NOW), /cursor/u);
});

test('cursor payload validation rejects malformed shapes at sign time', () => {
  const codec = createCommunityNotificationCursorCodec(HMAC_KEY);
  for (const bad of [
    payload({ v: 2 as never }),
    payload({ ep: 'other.endpoint' as never }),
    payload({ vw: '' }),
    payload({ ft: 'read' as never }),
    payload({ lm: 0 }),
    payload({ lm: 101 }),
    payload({ pos: { t: 'not-a-date', i: 'n-1' } }),
    payload({ pos: { t: '2026-10-05T11:00:00.000Z', i: 'bad id!' } }),
  ]) {
    assert.throws(() => codec.sign(bad));
  }
});

test('cursor key id and ttl match the contract constants', () => {
  assert.equal(COMMUNITY_NOTIFICATION_CURSOR_KEY_ID, 'cnk-v1');
  assert.equal(COMMUNITY_NOTIFICATION_CURSOR_TTL_MS, 900_000);
});

test('cursor codec requires a configured hmac key', () => {
  assert.throws(() => createCommunityNotificationCursorCodec(Buffer.alloc(8)), TypeError);
  assert.throws(() => createCommunityNotificationCursorCodec('nope' as never), TypeError);
});
