import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS,
  COMMUNITY_COMMENT_FORMER_MEMBER_DISPLAY_NAME,
  COMMUNITY_COMMENT_MEMBER_DISPLAY_NAME,
  COMMUNITY_STATIC_GENERATION,
  CommunityCommentError,
  communityCommentAuthorView,
  communityCommentEtag,
  communityCommentMatchesGeneration,
  communityCommentTarget,
  communityCommentView,
  isCommunityOpaqueId,
  normalizeCommunityCommentBody,
  parseCommunityCommentCreateBody,
  parseCommunityCommentId,
  type CommunityCommentRecord,
  type CommunityTarget,
} from '../../../src/modules/community/index.js';

const ACCOUNT = 'account-author';
const SUBJECT = 'subject-author';
const OWNER_SUBJECT = 'subject-owner';
const COLLECTION = 'collection-target';
const NODE = 'node-bookmark';
const SERIES = 'series-digest';
const EDITION = 'edition-digest';
const GENERATION = 'bm-gen-0123456789abcdef';
const HMAC_KEY = Buffer.alloc(32, 5);
const NOW = new Date('2026-10-03T10:00:00.000Z');

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
const BOOKMARK_TARGET: CommunityTarget = {
  kind: 'bookmark', id: NODE, collectionId: COLLECTION,
  seriesId: null, generation: GENERATION,
};

function record(overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id: 'comment-1',
    target: { kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null },
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: 'comment-1',
    replyToId: null,
    depth: 0,
    authorAccountId: ACCOUNT,
    body: 'hello',
    state: 'visible',
    curationHidden: false,
    revision: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/* ——— body normalization ——— */

test('normalizeCommunityCommentBody trims and NFC-normalizes', () => {
  assert.equal(normalizeCommunityCommentBody('  hello  '), 'hello');
  // Decomposed e + combining acute composes to a single code point.
  assert.equal(normalizeCommunityCommentBody('café'), 'café');
  assert.equal([...normalizeCommunityCommentBody('é')].length, 1);
});

test('normalizeCommunityCommentBody measures Unicode code points, not UTF-16 units', () => {
  const max = 'a'.repeat(COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS);
  assert.equal(normalizeCommunityCommentBody(max), max);
  // 4000 astral characters = 4000 code points = 8000 UTF-16 units: accepted.
  const astral = '😀'.repeat(COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS);
  assert.equal(normalizeCommunityCommentBody(astral).length, 8000);
  assert.throws(
    () => normalizeCommunityCommentBody('a'.repeat(COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS + 1)),
    (error: unknown) => error instanceof CommunityCommentError && error.code === 'invalid_request');
  assert.throws(
    () => normalizeCommunityCommentBody('😀'.repeat(COMMUNITY_COMMENT_BODY_MAX_CODE_POINTS + 1)),
    (error: unknown) => error instanceof CommunityCommentError && error.code === 'invalid_request');
});

test('normalizeCommunityCommentBody rejects whitespace-only and non-strings', () => {
  for (const value of ['', '   ', '\n\t ', 5, null, undefined, {}, ['x']]) {
    assert.throws(() => normalizeCommunityCommentBody(value),
      (error: unknown) => error instanceof CommunityCommentError && error.code === 'invalid_request',
      JSON.stringify(value));
  }
});

/* ——— closed create body ——— */

test('parseCommunityCommentCreateBody accepts roots and replies, rejects everything else', () => {
  assert.deepEqual(parseCommunityCommentCreateBody({
    target: { ...COLLECTION_TARGET }, body: ' hi ', replyToId: null,
  }), { target: COLLECTION_TARGET, body: 'hi', replyToId: null });
  assert.deepEqual(parseCommunityCommentCreateBody({
    target: { ...BOOKMARK_TARGET }, body: 'reply', replyToId: 'comment-1',
  }), { target: BOOKMARK_TARGET, body: 'reply', replyToId: 'comment-1' });

  const bad: unknown[] = [
    null, 'x', [],
    { target: { ...COLLECTION_TARGET }, body: 'hi' }, // missing replyToId
    { target: { ...COLLECTION_TARGET }, body: 'hi', replyToId: undefined },
    { target: { ...COLLECTION_TARGET }, body: 'hi', replyToId: null, extra: 1 },
    { target: { ...COLLECTION_TARGET }, body: 'hi', replyToId: 'bad id!' },
    { target: { ...COLLECTION_TARGET }, body: 'hi', replyToId: 5 },
    { target: 'collection', body: 'hi', replyToId: null },
    { target: { ...COLLECTION_TARGET, generation: 'wrong' }, body: 'hi', replyToId: null },
    { target: { ...COLLECTION_TARGET }, body: 42, replyToId: null },
    { target: { ...COLLECTION_TARGET }, body: '  ', replyToId: null },
  ];
  for (const value of bad) {
    assert.throws(() => parseCommunityCommentCreateBody(value),
      (error: unknown) => error instanceof CommunityCommentError && error.code === 'invalid_request',
      JSON.stringify(value));
  }
});

test('parseCommunityCommentId and isCommunityOpaqueId accept only opaque ids', () => {
  assert.equal(parseCommunityCommentId('comment-1_2.3~x'), 'comment-1_2.3~x');
  for (const value of ['', 'bad id', 'id/slash', 'x'.repeat(129), 7, null, undefined]) {
    assert.throws(() => parseCommunityCommentId(value),
      (error: unknown) => error instanceof CommunityCommentError && error.code === 'invalid_request',
      JSON.stringify(value));
    assert.equal(isCommunityOpaqueId(value), false, JSON.stringify(value));
  }
});

/* ——— author projection ——— */

test('communityCommentAuthorView serves live identity, fallbacks and the former-member tombstone', () => {
  assert.deepEqual(communityCommentAuthorView(ACCOUNT, {
    handle: 'alice', displayName: 'Alice A', avatarUrl: 'https://cdn.example/a.png',
  }), { id: ACCOUNT, handle: 'alice', displayName: 'Alice A', avatarUrl: 'https://cdn.example/a.png' });
  // Blank display name falls back to the handle, then to "Member".
  assert.equal(communityCommentAuthorView(ACCOUNT, {
    handle: 'alice', displayName: '   ', avatarUrl: null,
  }).displayName, 'alice');
  assert.equal(communityCommentAuthorView(ACCOUNT, {
    handle: null, displayName: ' ', avatarUrl: null,
  }).displayName, COMMUNITY_COMMENT_MEMBER_DISPLAY_NAME);
  // Unavailable account: stable tombstone, no handle, no avatar.
  assert.deepEqual(communityCommentAuthorView(ACCOUNT, null), {
    id: ACCOUNT, handle: null,
    displayName: COMMUNITY_COMMENT_FORMER_MEMBER_DISPLAY_NAME, avatarUrl: null,
  });
});

/* ——— target reconstruction + generation matching ——— */

test('communityCommentTarget rebuilds the closed Target for every kind', () => {
  assert.deepEqual(communityCommentTarget(record()), COLLECTION_TARGET);
  assert.deepEqual(communityCommentTarget(record({
    target: { kind: 'bookmark', id: NODE, collectionId: COLLECTION, seriesId: null },
    targetGeneration: GENERATION,
  })), BOOKMARK_TARGET);
  assert.deepEqual(communityCommentTarget(record({
    target: { kind: 'digest_series', id: SERIES, collectionId: null, seriesId: null },
  })), {
    kind: 'digest_series', id: SERIES, collectionId: null, seriesId: null,
    generation: COMMUNITY_STATIC_GENERATION,
  });
  assert.deepEqual(communityCommentTarget(record({
    target: { kind: 'digest_edition', id: EDITION, collectionId: null, seriesId: SERIES },
  })), {
    kind: 'digest_edition', id: EDITION, collectionId: null, seriesId: SERIES,
    generation: COMMUNITY_STATIC_GENERATION,
  });
});

test('communityCommentTarget throws on a generation inconsistent with the kind', () => {
  // A collection row pinned to a bookmark generation is corrupt data, not a
  // client error: throw a hard error rather than serving a wrong Target.
  assert.throws(() => communityCommentTarget(record({ targetGeneration: GENERATION })));
  assert.throws(() => communityCommentTarget(record({
    target: { kind: 'bookmark', id: NODE, collectionId: COLLECTION, seriesId: null },
    targetGeneration: COMMUNITY_STATIC_GENERATION,
  })));
});

test('communityCommentMatchesGeneration binds rows to the resolved generation', () => {
  assert.equal(communityCommentMatchesGeneration({ targetGeneration: GENERATION }, GENERATION), true);
  assert.equal(communityCommentMatchesGeneration({ targetGeneration: 'bm-gen-old' }, GENERATION), false);
});

/* ——— Comment view projection ——— */

const LIVE_AUTHOR = { handle: 'alice', displayName: 'Alice A', avatarUrl: null };

test('communityCommentView projects visible bodies and per-viewer affordances', () => {
  const author = communityCommentAuthorView(ACCOUNT, LIVE_AUTHOR);
  const selfView = communityCommentView(record(), {
    viewer: { accountId: ACCOUNT, subjectId: SUBJECT },
    author, replyCount: 3, viewerCurates: false,
  });
  assert.equal(selfView.body, 'hello');
  assert.equal(selfView.canEdit, true);
  assert.equal(selfView.canDelete, true);
  assert.equal(selfView.canCurate, false);
  assert.equal(selfView.revision, '1');
  assert.equal(selfView.createdAt, NOW.toISOString());
  assert.equal(selfView.replyCount, 3);
  assert.deepEqual(selfView.target, COLLECTION_TARGET);

  const ownerView = communityCommentView(record(), {
    viewer: { accountId: 'account-owner', subjectId: OWNER_SUBJECT },
    author, replyCount: 0, viewerCurates: true,
  });
  assert.equal(ownerView.canEdit, false);
  assert.equal(ownerView.canCurate, true);

  const anonymousView = communityCommentView(record(), {
    viewer: { accountId: null, subjectId: null },
    author, replyCount: 0, viewerCurates: false,
  });
  assert.equal(anonymousView.canEdit, false);
  assert.equal(anonymousView.canDelete, false);
  assert.equal(anonymousView.canCurate, false);
});

test('communityCommentView tombstones deleted/hidden bodies and disables edit affordances', () => {
  const author = communityCommentAuthorView(ACCOUNT, LIVE_AUTHOR);
  for (const state of ['deleted', 'hidden'] as const) {
    const view = communityCommentView(record({ state, body: state === 'hidden' ? 'kept' : null }), {
      viewer: { accountId: ACCOUNT, subjectId: SUBJECT },
      author, replyCount: 0, viewerCurates: false,
    });
    assert.equal(view.state, state);
    assert.equal(view.body, null, state);
    assert.equal(view.canEdit, false, state);
    // CS-04: a hidden comment is not editable but remains author-deletable;
    // only the deleted tombstone removes the author's delete affordance.
    assert.equal(view.canDelete, state === 'hidden', state);
  }
});

/* ——— Comment ETag ——— */

test('communityCommentEtag is deterministic, key-bound and revision-bound', () => {
  const comment = { id: 'comment-1', revision: '3' };
  const tag = communityCommentEtag(comment, HMAC_KEY);
  assert.match(tag, /^"community-comment:[A-Za-z0-9_-]{32}"$/u);
  assert.equal(tag, communityCommentEtag(comment, HMAC_KEY));
  assert.notEqual(tag, communityCommentEtag(comment, Buffer.alloc(32, 9)));
  assert.notEqual(tag, communityCommentEtag({ id: 'comment-2', revision: '3' }, HMAC_KEY));
  assert.notEqual(tag, communityCommentEtag({ id: 'comment-1', revision: '4' }, HMAC_KEY));
  assert.throws(() => communityCommentEtag(comment, Buffer.alloc(8, 1)), TypeError);
});
