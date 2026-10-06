import { describe, expect, it } from 'vitest';

import { mapFeedToAtom } from '../../src/feed/atom.js';
import {
  assertFeedEventBookmarkUrls,
  projectFeedBookmarkUrl,
  projectFeedNodeBookmark,
} from '../../src/feed/bookmark-url.js';
import { mergeFeedSubscriptions, routeMergedFeedEvents } from '../../src/feed/client-merge.js';
import {
  computeFeedBackoffSeconds,
  createFeedPollController,
} from '../../src/feed/client-poll.js';
import {
  advanceFeedCursor,
  createFeedCursor,
  createFeedCursorCodec,
  createFeedCursorHmacKey,
  createFeedFilterDigest,
  verifyFeedCursor,
} from '../../src/feed/cursor.js';
import { discriminateFeedEvent } from '../../src/feed/event-contracts.js';
import { isFeedLike, mapFeedToJsonFeed } from '../../src/feed/json-feed.js';
import { projectFeedEvent, projectFeedEvents } from '../../src/feed/projection.js';
import { decodeFeedQuery } from '../../src/feed/query.js';
import {
  buildReleasePublishedFeedEvent,
  isImmutableReleaseSnapshotUrl,
  isReleaseSnapshotDigest,
} from '../../src/feed/release-event.js';
import { declareWebSubHubs, withWebSubHubs } from '../../src/feed/websub.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const validators = createValidatorRegistry();
// Structural-guard stub only — not a schema proof. Success / schema_invalid
// paths below use createValidatorRegistry().
const fakeValidators = { validate: () => ({ valid: true, errors: [] }) } as never;
const base = (type: string, data: Record<string, unknown>) => ({
  specversion: '1.0',
  id: 'event-1',
  source: 'https://example.com/collections',
  type,
  subject: 'collections/c/c1',
  time: '2026-07-16T06:30:00Z',
  datacontenttype: 'application/json',
  collectionprotocolversion: '0.1',
  data,
});

describe('Feed coverage boundary cases', () => {
  it('covers Atom malformed entries and optional fields', () => {
    const feed = {
      feedUrl: 'https://example.com/feed', collectionUrl: 'https://example.com/c', title: 'T',
    };
    expect(mapFeedToAtom(feed)).toMatchObject({ ok: false, code: 'malformed_feed' });
    expect(mapFeedToAtom({ ...feed, events: [null] })).toMatchObject({ ok: false });
    expect(mapFeedToAtom({ ...feed, events: [{ id: '', time: 'x', data: {} }] })).toMatchObject({ ok: false });
    expect(mapFeedToAtom({ ...feed, events: [{ id: 'e', time: 1, data: {} }] })).toMatchObject({ ok: false });
    const result = mapFeedToAtom({
      ...feed,
      events: [
        { id: 'e', type: '', time: '2026-01-01T00:00:00Z', data: {} },
        { id: 'b', type: 'x', time: '2026-01-02T00:00:00Z', data: { node: { kind: 'bookmark', redacted: true } } },
      ],
    });
    expect(result.ok).toBe(true);
    expect(mapFeedToAtom({ ...feed, events: 'bad' })).toMatchObject({ ok: false });
  });

  it('covers bookmark projection guards and assertion no-op paths', () => {
    expect(() => projectFeedNodeBookmark(null)).toThrow(TypeError);
    expect(() => projectFeedNodeBookmark({ id: 'x', kind: 'folder', ['x' as never]: 1 })).not.toThrow();
    expect(() => projectFeedNodeBookmark({ id: 'x', kind: 'bookmark', [Symbol('x')]: 1 })).toThrow(TypeError);
    expect(projectFeedNodeBookmark({ id: 'x', kind: 'bookmark', title: 'T' })).toEqual({ id: 'x', kind: 'bookmark', title: 'T' });
    expect(projectFeedNodeBookmark({ id: 'x', kind: 'bookmark', redacted: true, url: 'https://user:x@example.com' })).toEqual({ id: 'x', kind: 'bookmark', redacted: true });
    expect(projectFeedBookmarkUrl('https://example.com', { mode: 'omit' })).toEqual({ outcome: 'keep', url: 'https://example.com' });
    expect(() => assertFeedEventBookmarkUrls(null)).not.toThrow();
    expect(() => assertFeedEventBookmarkUrls({ node: null })).not.toThrow();
    expect(() => assertFeedEventBookmarkUrls({ node: { kind: 'folder', url: 'file:///x' } })).not.toThrow();
  });

  it('covers merge and routing malformed boundaries', () => {
    expect(() => mergeFeedSubscriptions(new Proxy([], {}))).toThrow(TypeError);
    expect(mergeFeedSubscriptions([null as never])).toMatchObject({ ok: false });
    expect(mergeFeedSubscriptions([{ id: 'x', collectionId: 1 as never }])).toMatchObject({ ok: false });
    expect(mergeFeedSubscriptions([{ id: 'x', collectionId: null }, { id: 'x', collectionId: '*' }])).toMatchObject({ ok: true });
    const instanceWide = { id: 'x', collectionId: null };
    const instanceMerge = mergeFeedSubscriptions([instanceWide]);
    if (!instanceMerge.ok) throw new Error('expected a valid instance-wide merge');
    expect(() => routeMergedFeedEvents(
      new Proxy([], {}),
      instanceWide,
      instanceMerge.requests[0]!,
    )).toThrow(TypeError);
    expect(() => routeMergedFeedEvents(
      [],
      null as never,
      instanceMerge.requests[0]!,
    )).toThrow(TypeError);
    const scoped = { id: 'x', collectionId: 'c' };
    const scopedMerge = mergeFeedSubscriptions([scoped]);
    if (!scopedMerge.ok) throw new Error('expected a valid scoped merge');
    expect(() => routeMergedFeedEvents(
      [null as never, { collectionId: 'c' } as never],
      scoped,
      scopedMerge.requests[0]!,
    )).toThrow(TypeError);
  });

  it('covers poll defaults, validation, hints and state paths', () => {
    expect(() => createFeedPollController(null as never)).toThrow(TypeError);
    expect(() => createFeedPollController({ minPollIntervalSeconds: 1 }, { random: 1 as never })).toThrow(TypeError);
    const c = createFeedPollController({ minPollIntervalSeconds: 1, baseBackoffSeconds: 2, serverMaxBackoffSeconds: 3 });
    expect(() => c.decide(Number.NaN)).toThrow(TypeError);
    expect(() => c.observe(null as never, 0)).toThrow(TypeError);
    expect(() => c.observe({ status: 99 }, 0)).toThrow(TypeError);
    expect(() => c.observe({ status: 200 }, Number.NaN)).toThrow(TypeError);
    c.observe({ status: 200, etag: null, recommendedAfterSeconds: 2, notBefore: '2026-01-01T00:00:00Z' }, 0);
    c.observe({ status: 204, etag: '""' }, 3000);
    expect(() => c.observe({ status: 200, notBefore: 'not-a-date' }, 4000)).toThrow(TypeError);
    expect(() => c.observe({ status: 429, retryAfterSeconds: -1 }, 0)).toThrow(TypeError);
    c.observe({ status: 500 }, 5000);
    expect(c.state().attempt).toBe(1);
    const badRandom = createFeedPollController({ minPollIntervalSeconds: 1 }, { random: () => 2 });
    expect(() => badRandom.observe({ status: 500 }, 0)).toThrow(/random/i);
    for (const value of [Number.NaN, Infinity, -1, 1.5]) {
      expect(() => computeFeedBackoffSeconds({ attempt: value })).toThrow(TypeError);
    }
    expect(() => computeFeedBackoffSeconds({ attempt: 0, random: () => -1 })).toThrow(TypeError);
    expect(computeFeedBackoffSeconds({ attempt: 0, baseSeconds: 2, serverMaxSeconds: 1, jitterSeconds: 0, random: () => 0 })).toBe(1);
  });

  it('covers cursor codec, filter and destroyed-key paths', () => {
    expect(() => createFeedFilterDigest(null as never)).toThrow(TypeError);
    expect(() => createFeedFilterDigest(new Proxy({}, {}))).toThrow(TypeError);
    expect(createFeedFilterDigest({ empty: undefined })).toBeTruthy();
    expect(() => createFeedCursorHmacKey(new Uint8Array(31))).toThrow(TypeError);
    const key = createFeedCursorHmacKey(new Uint8Array(32));
    const context = { principalId: 'p', feedId: 'f', filterDigest: 'd', protocolVersion: '0.1' };
    const cursor = createFeedCursor({ ...context, position: 'pos' }, key);
    expect(verifyFeedCursor(cursor, context, key).valid).toBe(true);
    expect(verifyFeedCursor('fdc1.pbad.bad', context, key).valid).toBe(false);
    const codec = createFeedCursorCodec(key);
    expect(codec.decode(codec.encode('next', context), context)).toEqual({ valid: true, position: 'next' });
    expect(advanceFeedCursor('later', context, key)).toContain('fdc1.p');
    key.destroy();
    expect(() => createFeedCursor({ ...context, position: 'x' }, key)).toThrow(TypeError);
    expect(() => verifyFeedCursor(cursor, context, key)).not.toThrow();
  });

  it('covers event contract runtime checks with a validating stub', () => {
    // Structural guards only; fakeValidators is not a schema proof.
    expect(discriminateFeedEvent({ type: '' }, fakeValidators)).toMatchObject({ valid: false });
    expect(discriminateFeedEvent({ type: 'https://vendor.example/e', data: { collectionId: 'c' } }, fakeValidators)).toMatchObject({ valid: false, code: 'missing_extensions' });
    expect(discriminateFeedEvent(base('https://vendor.example/e', { collectionId: 'c', extensions: {}, extra: 1 }), fakeValidators)).toMatchObject({ valid: false, code: 'excess_data_field' });
    expect(discriminateFeedEvent(base('org.collectionprotocol.node.created.v1', { node: 'bad' }), fakeValidators)).toMatchObject({ valid: false, code: 'malformed_event' });
    expect(discriminateFeedEvent(base('org.collectionprotocol.node.created.v1', { node: { kind: 'bookmark', url: 'file:///x' } }), fakeValidators)).toMatchObject({ valid: false, code: 'unsafe_bookmark_url' });
    expect(discriminateFeedEvent(base('org.collectionprotocol.access.publication_changed.v1', { visibility: 'public', nested: {} }), fakeValidators)).toMatchObject({ valid: false, code: 'excess_data_field' });
  });

  it('covers discriminateFeedEvent success and schema_invalid with the real registry', () => {
    const valid = base('org.collectionprotocol.collection.updated.v1', {
      collectionId: 'c',
      revision: 'r',
      summary: 'S',
    });
    expect(discriminateFeedEvent(valid, validators)).toMatchObject({ valid: true, kind: 'standard' });

    const invalid = base('org.collectionprotocol.collection.updated.v1', {
      collectionId: 'c',
      revision: 7,
      summary: 'S',
    });
    expect(discriminateFeedEvent(invalid, validators)).toMatchObject({ valid: false, code: 'schema_invalid' });
  });

  it('covers JSON Feed optional mapping and shape guards', () => {
    const feed = {
      protocolVersion: '0.1',
      feedUrl: 'https://example.com/feed',
      collectionUrl: 'https://example.com/c',
      title: 'T',
      events: [{
        specversion: '1.0',
        id: 'event-1',
        source: 'https://example.com/collections',
        type: 'org.collectionprotocol.collection.updated.v1',
        subject: 'https://other.example/e',
        time: '2026-07-16T06:30:00Z',
        datacontenttype: 'application/json',
        collectionprotocolversion: '0.1',
        data: { collectionId: 'c', revision: 'r', summary: 'S' },
      }],
      nextCursor: 'next',
      hasMore: false,
      poll: { notBefore: '2026-07-16T06:35:00Z', recommendedAfterSeconds: 300 },
      hubs: [],
    };
    const mapped = mapFeedToJsonFeed(feed, { titleOverride: 'O', tags: [] });
    expect(mapped.ok).toBe(true);
    expect(mapFeedToJsonFeed({ ...feed, events: [{ type: 'x' }] })).toMatchObject({ ok: false });
    expect(mapFeedToJsonFeed({ ...feed, events: [{ id: 'e', type: 1 }] })).toMatchObject({ ok: false });
    expect(isFeedLike(feed)).toBe(true);
    expect(isFeedLike(null)).toBe(false);
    expect(isFeedLike({ ...feed, events: 'x' })).toBe(false);
  });

  it('covers projection malformed and option branches', () => {
    expect(projectFeedEvent(null)).toMatchObject({ ok: false, code: 'malformed_input' });
    expect(projectFeedEvent(base('org.collectionprotocol.node.created.v1', { collectionId: 'c', revision: 'r', node: {} }), { bookmarkMode: 'redact' })).toMatchObject({ ok: false });
    expect(projectFeedEvents(new Proxy([], {}))).toMatchObject({ ok: false, code: 'malformed_input' });
    expect(projectFeedEvents([null])).toMatchObject({ ok: false, code: 'partial_projection' });
  });

  it('covers release guards and builder failures', () => {
    expect(isImmutableReleaseSnapshotUrl('not-url')).toBe(false);
    expect(isImmutableReleaseSnapshotUrl('https://example.com/c/c1/snapshot')).toBe(false);
    expect(isReleaseSnapshotDigest('')).toBe(false);
    const input = { id: 'e', source: 'https://example.com', subject: 'c', time: '2026-01-01T00:00:00Z', collectionId: 'c', revision: 'r', releaseId: 'r', snapshotUrl: 'not-url', snapshotDigest: 'x', changes: { created: 0, updated: 0, moved: 0, deleted: 0 } };
    expect(buildReleasePublishedFeedEvent(input, validators)).toMatchObject({ ok: false, code: 'invalid_digest' });
    expect(buildReleasePublishedFeedEvent({ ...input, snapshotDigest: `sha-256=:${'A'.repeat(43)}=:` }, validators)).toMatchObject({ ok: false });
  });

  it('covers query conversion and WebSub parser boundaries', () => {
    expect(() => decodeFeedQuery(null as never)).toThrow(TypeError);
    expect(decodeFeedQuery({ unknown: 'x' })).toMatchObject({ valid: false });
    expect(decodeFeedQuery({ cursor: undefined, from: ['now', 1 as never] })).toMatchObject({ valid: true });
    expect(() => declareWebSubHubs(new Proxy([], {}))).toThrow(TypeError);
    expect(declareWebSubHubs([1 as never])).toMatchObject({ ok: false, code: 'malformed_hub' });
    expect(declareWebSubHubs(['https://[bad'])).toMatchObject({ ok: false, code: 'unsafe_hub_url' });
    expect(withWebSubHubs({}, ['http://bad'])).toMatchObject({ ok: false, code: 'unsafe_hub_url' });
  });
});
