import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  advanceFeedCursor,
  createFeedCursor,
  createFeedCursorCodec,
  createFeedCursorExpiredProblem,
  createFeedCursorHmacKey,
  createFeedFilterDigest,
  verifyFeedCursor,
  type FeedCursorContext,
} from '../../src/feed/cursor.js';
import { getProblemDefinition } from '../../src/shared/problems.js';

const evidence = 'feed.cursor';

function context(overrides: Partial<FeedCursorContext> = {}): FeedCursorContext {
  return {
    resourceId: 'mount-a/feed',
    principalId: 'principal-a',
    feedId: 'collection-1/feed',
    filterDigest: createFeedFilterDigest({}),
    protocolVersion: '0.1',
    ...overrides,
  };
}

function replaceCursorMac(cursor: string): string {
  const parts = cursor.split('.');
  const mac = parts[2] as string;
  parts[2] = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  return parts.join('.');
}

describe(`FEED-0002 feed cursor contracts [evidence:${evidence}]`, () => {
  it(`[success] round-trips an exclusive opaque cursor under matching scope [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const ctx = context();
    const cursor = createFeedCursor({ ...ctx, position: 'evt-100' }, key);
    expect(cursor.startsWith('fdc1.p')).toBe(true);
    expect(cursor.includes('evt-100')).toBe(false);
    const verified = verifyFeedCursor(cursor, ctx, key);
    expect(verified).toEqual({ valid: true, position: 'evt-100' });
    key.destroy();
  });

  it(`[success] empty-page advance yields a new exclusive checkpoint [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const ctx = context();
    // Client held evt-0; empty page still advances nextCursor to evt-0 (or a
    // server watermark). Re-encoding the same exclusive position is stable;
    // moving to a later watermark produces a distinct cursor.
    const atEvt0 = createFeedCursor({ ...ctx, position: 'evt-0' }, key);
    const emptyPageNext = advanceFeedCursor('evt-0', ctx, key);
    expect(emptyPageNext).toBe(atEvt0);
    expect(verifyFeedCursor(emptyPageNext, ctx, key)).toEqual({
      valid: true,
      position: 'evt-0',
    });
    const afterLaterWatermark = advanceFeedCursor('evt-empty-watermark-2', ctx, key);
    expect(afterLaterWatermark).not.toBe(emptyPageNext);
    expect(verifyFeedCursor(afterLaterWatermark, ctx, key)).toEqual({
      valid: true,
      position: 'evt-empty-watermark-2',
    });
    key.destroy();
  });

  it(`[negative] rejects cross-principal reuse [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const cursor = createFeedCursor({ ...context(), position: 'evt-9' }, key);
    const result = verifyFeedCursor(cursor, context({ principalId: 'principal-b' }), key);
    expect(result).toEqual({ valid: false, code: 'invalid_cursor_scope' });
    key.destroy();
  });

  it(`[negative] rejects cross-feed reuse [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const cursor = createFeedCursor({ ...context(), position: 'evt-9' }, key);
    const result = verifyFeedCursor(cursor, context({ feedId: 'other/feed' }), key);
    expect(result).toEqual({ valid: false, code: 'invalid_cursor_scope' });
    key.destroy();
  });

  it(`[negative] rejects cross-mount reuse when the feed id is repeated [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const cursor = createFeedCursor({ ...context(), position: 'evt-9' }, key);
    const result = verifyFeedCursor(cursor, context({ resourceId: 'mount-b/feed' }), key);
    expect(result).toEqual({ valid: false, code: 'invalid_cursor_scope' });
    key.destroy();
  });

  it(`[negative] rejects cross-filter reuse [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const cursor = createFeedCursor({ ...context(), position: 'evt-9' }, key);
    const result = verifyFeedCursor(
      cursor,
      context({ filterDigest: createFeedFilterDigest({ tag: 'design' }) }),
      key,
    );
    expect(result).toEqual({ valid: false, code: 'invalid_cursor_scope' });
    key.destroy();
  });

  it(`[negative] rejects cross-protocolVersion reuse [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const cursor = createFeedCursor({ ...context(), position: 'evt-9' }, key);
    const result = verifyFeedCursor(cursor, context({ protocolVersion: '0.2' }), key);
    expect(result).toEqual({ valid: false, code: 'invalid_cursor_scope' });
    key.destroy();
  });

  it(`[regression] rejects Sync and Publication cursor namespaces [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const ctx = context();
    expect(verifyFeedCursor('pdc1.pAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ctx, key)).toEqual({
      valid: false,
      code: 'invalid_cursor_scope',
    });
    expect(verifyFeedCursor('psc1.pAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ctx, key)).toEqual({
      valid: false,
      code: 'invalid_cursor_scope',
    });
    expect(verifyFeedCursor('sync_cursor_not_feed', ctx, key)).toEqual({
      valid: false,
      code: 'invalid_cursor_scope',
    });
    key.destroy();
  });

  it(`[negative] wrong key material fails closed [evidence:${evidence}]`, () => {
    const keyA = createFeedCursorHmacKey(randomBytes(32));
    const keyB = createFeedCursorHmacKey(randomBytes(32));
    const cursor = createFeedCursor({ ...context(), position: 'evt-1' }, keyA);
    expect(verifyFeedCursor(cursor, context(), keyB)).toEqual({
      valid: false,
      code: 'invalid_cursor_scope',
    });
    keyA.destroy();
    keyB.destroy();
  });

  it(`[negative] rejects independent MAC and position tampering [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const ctx = context();
    const cursor = createFeedCursor({ ...ctx, position: 'evt-100' }, key);
    const parts = cursor.split('.');
    parts[1] = `p${Buffer.from('evt-101', 'utf8').toString('base64url')}`;

    expect(verifyFeedCursor(parts.join('.'), ctx, key)).toEqual({
      valid: false,
      code: 'invalid_cursor_scope',
    });
    expect(verifyFeedCursor(replaceCursorMac(cursor), ctx, key)).toEqual({
      valid: false,
      code: 'invalid_cursor_scope',
    });
    key.destroy();
  });

  it(`[negative] rejects padded and non-canonical Base64URL positions [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const ctx = context();
    const cursor = createFeedCursor({ ...ctx, position: 'f' }, key);
    const parts = cursor.split('.');
    const canonicalPosition = parts[1] as string;

    parts[1] = `${canonicalPosition}=`;
    expect(verifyFeedCursor(parts.join('.'), ctx, key)).toEqual({
      valid: false,
      code: 'invalid_cursor_scope',
    });
    parts[1] = 'pZh'; // Decodes to "f", whose canonical Base64URL spelling is "Zg".
    expect(verifyFeedCursor(parts.join('.'), ctx, key)).toEqual({
      valid: false,
      code: 'invalid_cursor_scope',
    });
    key.destroy();
  });

  it(`[boundary] enforces cursor and key length bounds [evidence:${evidence}]`, () => {
    const minimumKey = createFeedCursorHmacKey(new Uint8Array(32));
    const maximumKey = createFeedCursorHmacKey(new Uint8Array(1024));
    const maximumCursor = createFeedCursor(
      { ...context(), position: 'x'.repeat(154) },
      minimumKey,
    );

    expect(maximumCursor).toHaveLength(256);
    expect(verifyFeedCursor(maximumCursor, context(), minimumKey)).toEqual({
      valid: true,
      position: 'x'.repeat(154),
    });
    expect(() => createFeedCursor({ ...context(), position: 'x'.repeat(155) }, minimumKey))
      .toThrow(RangeError);
    expect(verifyFeedCursor('', context(), minimumKey)).toEqual({
      valid: false,
      code: 'invalid_cursor_scope',
    });
    expect(verifyFeedCursor('x'.repeat(257), context(), minimumKey)).toEqual({
      valid: false,
      code: 'invalid_cursor_scope',
    });
    expect(() => createFeedCursorHmacKey(new Uint8Array(31))).toThrow(TypeError);
    expect(() => createFeedCursorHmacKey(new Uint8Array(1025))).toThrow(TypeError);
    minimumKey.destroy();
    maximumKey.destroy();
  });

  it(`[boundary] round-trips Unicode and rejects controls or malformed UTF-16 [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const unicodePosition = 'position-\u4f4d\u7f6e-\ud83d\ude00';
    const cursor = createFeedCursor({ ...context(), position: unicodePosition }, key);

    expect(verifyFeedCursor(cursor, context(), key)).toEqual({
      valid: true,
      position: unicodePosition,
    });
    expect(() => createFeedCursor({ ...context(), position: 'line\nbreak' }, key)).toThrow(TypeError);
    expect(() => createFeedCursor({ ...context({ feedId: 'feed\u0000id' }), position: 'x' }, key))
      .toThrow(TypeError);
    expect(() => createFeedCursor({ ...context(), position: '\ud800' }, key)).toThrow(TypeError);
    key.destroy();
  });

  it(`[boundary] expired cursor yields registered 410 feed_cursor_expired with Snapshot URL [evidence:${evidence}]`, () => {
    const problem = createFeedCursorExpiredProblem(
      'https://alice.example/collections/c/collection-1/snapshot',
    );
    const registered = getProblemDefinition('feed_cursor_expired');
    expect(problem.code).toBe('feed_cursor_expired');
    expect(problem.status).toBe(410);
    expect(problem.status).toBe(registered.status);
    expect(problem.retryable).toBe(false);
    expect(problem.snapshotUrl).toBe(
      'https://alice.example/collections/c/collection-1/snapshot',
    );
    expect(() => createFeedCursorExpiredProblem('https://user:pass@example.com/x')).toThrow();
    expect(() => createFeedCursorExpiredProblem('file:///tmp/x')).toThrow();
  });

  it(`[success] codec encode/decode matches free functions [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    const codec = createFeedCursorCodec(key);
    const ctx = context();
    const encoded = codec.encode('pos-7', ctx);
    expect(codec.decode(encoded, ctx)).toEqual({ valid: true, position: 'pos-7' });
    key.destroy();
  });

  it(`[boundary] destroyed keys and hostile inputs fail closed [evidence:${evidence}]`, () => {
    const key = createFeedCursorHmacKey(randomBytes(32));
    key.destroy();
    expect(() => createFeedCursor({ ...context(), position: 'x' }, key)).toThrow();
    expect(() => createFeedCursorHmacKey(new Uint8Array(8))).toThrow();
    expect(() => createFeedFilterDigest(null as never)).toThrow();
  });
});
