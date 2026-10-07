import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENTS_ENDPOINT,
  COMMUNITY_COMMENT_NOT_ROOT_MESSAGE,
  COMMUNITY_COMMENT_PAGE_BYTE_BUDGET,
  COMMUNITY_COMMENT_REPLIES_ENDPOINT,
  COMMUNITY_STATIC_GENERATION,
  CommunityCommentError,
  createCommunityCommentCursorCodec,
  getCommunityComment,
  listCommunityCommentReplies,
  listCommunityComments,
  parseCommunityCommentRepliesQuery,
  parseCommunityCommentsQuery,
  type CommunityComment,
  type CommunityCommentQueryPorts,
  type CommunityCommentRecord,
  type CommunityTarget,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';

const VIEWER = { accountId: 'account-reader', subjectId: 'subject-reader' };
const ANONYMOUS = { accountId: null, subjectId: null };
const OWNER_SUBJECT = 'subject-owner';
const COLLECTION = 'col-1';
const NODE = 'node-1';
const GENERATION = 'bm-gen-0123456789abcdef';
const HMAC_KEY = Buffer.alloc(32, 21);
const NOW = new Date('2026-10-03T10:00:00.000Z');

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
const BOOKMARK_TARGET: CommunityTarget = {
  kind: 'bookmark', id: NODE, collectionId: COLLECTION,
  seriesId: null, generation: GENERATION,
};

function errorCode(code: string, message?: string) {
  return (error: unknown) => error instanceof CommunityCommentError
    && error.code === code
    && (message === undefined || error.message === message);
}

function record(overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id: 'comment-1',
    target: { kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null },
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: 'comment-1',
    replyToId: null,
    depth: 0,
    authorAccountId: 'account-author',
    body: 'hello',
    state: 'visible',
    curationHidden: false,
    revision: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resolved(target: CommunityTarget): ResolvedCommunityTarget {
  return { target, ownerSubjectId: OWNER_SUBJECT, title: 'Target', href: '/t/1' };
}

interface QueryFixture {
  readonly ports: CommunityCommentQueryPorts;
  readonly resolvedCalls: number[];
  readonly rootScans: { after: unknown; limit: number }[];
  readonly descendantScans: { rootId: string; after: unknown; limit: number }[];
}

function queryPorts(options: {
  resolved?: ResolvedCommunityTarget | null;
  roots?: readonly CommunityCommentRecord[];
  descendants?: readonly CommunityCommentRecord[];
  byId?: CommunityCommentRecord | null;
  threadCounts?: ReadonlyMap<string, number>;
  directCounts?: ReadonlyMap<string, number>;
  authorsLive?: boolean;
} = {}): QueryFixture {
  const resolvedCalls: number[] = [];
  const rootScans: QueryFixture['rootScans'] = [];
  const descendantScans: QueryFixture['descendantScans'] = [];
  const roots = options.roots ?? [];
  const descendants = options.descendants ?? [];
  return {
    resolvedCalls, rootScans, descendantScans,
    ports: {
      targets: {
        async resolve(query) {
          resolvedCalls.push(1);
          if (options.resolved !== undefined) return options.resolved;
          return resolved({
            kind: query.kind, id: query.id,
            collectionId: query.collectionId ?? null,
            seriesId: query.seriesId ?? null,
            generation: query.kind === 'bookmark' ? GENERATION : COMMUNITY_STATIC_GENERATION,
          } as CommunityTarget);
        },
        async createdAt() { return NOW; },
      },
      curators: {
        // CS-04: only the resolved owner subject curates; readers do not.
        async canCurate(_identity, subjectId) { return subjectId === OWNER_SUBJECT; },
      },
      comments: {
        findById: async () => options.byId === undefined ? record() : options.byId,
        scanRoots: async (_identity, _generation, after, limit) => {
          rootScans.push({ after, limit });
          return roots
            .filter((row) => after === null
              || row.createdAt < (after as { createdAt: Date }).createdAt
              || (row.createdAt.getTime() === (after as { createdAt: Date }).createdAt.getTime()
                && row.id > (after as { id: string }).id))
            .slice(0, limit);
        },
        scanDescendants: async (rootId, after, limit) => {
          descendantScans.push({ rootId, after, limit });
          return descendants
            .filter((row) => row.rootId === rootId
              && (after === null
                || row.createdAt > (after as { createdAt: Date }).createdAt
                || (row.createdAt.getTime() === (after as { createdAt: Date }).createdAt.getTime()
                  && row.id > (after as { id: string }).id)))
            .slice(0, limit);
        },
        countVisibleThreadReplies: async (ids) => {
          const counts = new Map<string, number>();
          for (const id of ids) counts.set(id, options.threadCounts?.get(id) ?? 0);
          return counts;
        },
        countVisibleDirectReplies: async (ids) => {
          const counts = new Map<string, number>();
          for (const id of ids) counts.set(id, options.directCounts?.get(id) ?? 0);
          return counts;
        },
      },
      // CS-04: no curation overlay rows and no settings row in these tests.
      curations: { find: async () => null },
      settings: { find: async () => null },
      authors: {
        publicActors: async (ids) => {
          const map = new Map();
          if (options.authorsLive !== false) {
            for (const id of ids) {
              map.set(id, { handle: 'alice', displayName: 'Alice', avatarUrl: null });
            }
          }
          return map;
        },
      },
      clock: { now: async () => NOW },
    },
  };
}

const listQuery = (overrides: Record<string, unknown> = {}) => parseCommunityCommentsQuery({
  kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, ...overrides,
});

const listCodec = () => createCommunityCommentCursorCodec(HMAC_KEY, COMMUNITY_COMMENTS_ENDPOINT);
const repliesCodec = () => createCommunityCommentCursorCodec(HMAC_KEY, COMMUNITY_COMMENT_REPLIES_ENDPOINT);

/* ——— closed query parsing ——— */

test('parseCommunityCommentsQuery enforces the closed per-kind query schema', async () => {
  // Bookmark requires collectionId + an opaque generation.
  const bookmark = parseCommunityCommentsQuery({
    kind: 'bookmark', id: NODE, collectionId: COLLECTION, generation: GENERATION, limit: 5,
  });
  assert.equal(bookmark.limit, 5);
  assert.equal(bookmark.cursor, null);
  // digest_edition requires seriesId; collection/digest_series forbid parents.
  const edition = parseCommunityCommentsQuery({
    kind: 'digest_edition', id: 'ed-1', seriesId: 'series-1', generation: COMMUNITY_STATIC_GENERATION,
  });
  assert.equal(edition.seriesId, 'series-1');

  const bad: [string, Record<string, unknown>][] = [
    ['missing kind', { id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION }],
    ['missing id', { kind: 'collection', generation: COMMUNITY_STATIC_GENERATION }],
    ['missing generation', { kind: 'collection', id: COLLECTION }],
    ['bad kind', { kind: 'account', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION }],
    ['bad id', { kind: 'collection', id: 'bad id!', generation: COMMUNITY_STATIC_GENERATION }],
    ['non-static generation on collection',
      { kind: 'collection', id: COLLECTION, generation: GENERATION }],
    ['bookmark without collectionId', { kind: 'bookmark', id: NODE, generation: GENERATION }],
    ['bookmark with seriesId',
      { kind: 'bookmark', id: NODE, collectionId: COLLECTION, seriesId: 's', generation: GENERATION }],
    ['bookmark bad generation', { kind: 'bookmark', id: NODE, collectionId: COLLECTION, generation: 'bad gen!' }],
    ['collection with collectionId',
      { kind: 'collection', id: COLLECTION, collectionId: COLLECTION, generation: COMMUNITY_STATIC_GENERATION }],
    ['edition without seriesId',
      { kind: 'digest_edition', id: 'ed-1', generation: COMMUNITY_STATIC_GENERATION }],
    ['unknown key', { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, q: 'x' }],
    ['null is not missing', { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, limit: null }],
    ['limit 0', { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, limit: 0 }],
    ['limit 101', { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, limit: 101 }],
    ['limit decimal', { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, limit: 2.5 }],
    ['limit signed', { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, limit: '-1' }],
    ['limit exponent', { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, limit: '1e2' }],
  ];
  for (const [name, raw] of bad) {
    assert.throws(() => parseCommunityCommentsQuery(raw), errorCode('invalid_query'), name);
  }
  // A cursor outside the opaque charset is invalid_cursor, not invalid_query.
  for (const raw of [
    { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, cursor: 'bad cursor!' },
    { kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, cursor: 42 },
  ]) {
    assert.throws(() => parseCommunityCommentsQuery(raw), errorCode('invalid_cursor'), JSON.stringify(raw));
  }
});

test('parseCommunityCommentRepliesQuery accepts only limit+cursor', () => {
  assert.deepEqual(parseCommunityCommentRepliesQuery({}), { limit: 20, cursor: null });
  assert.deepEqual(parseCommunityCommentRepliesQuery({ limit: '7' }), { limit: 7, cursor: null });
  for (const raw of [
    { kind: 'collection' }, { limit: 0 }, { limit: 101 }, { limit: null }, { limit: 'x' },
  ]) {
    assert.throws(() => parseCommunityCommentRepliesQuery(raw), errorCode('invalid_query'),
      JSON.stringify(raw));
  }
  assert.throws(() => parseCommunityCommentRepliesQuery({ cursor: 'bad cursor!' }),
    errorCode('invalid_cursor'));
});

/* ——— listCommunityComments ——— */

test('listCommunityComments conceals unresolved targets and stale generations', async () => {
  const concealed = queryPorts({ resolved: null });
  await assert.rejects(
    () => listCommunityComments(concealed.ports, {
      viewer: ANONYMOUS, query: listQuery(), cursorCodec: listCodec(),
    }), errorCode('resource_not_found'));

  // A supplied generation that no longer matches the resolved authority is
  // concealed with the old thread — not a conflict response.
  const stale = queryPorts({ resolved: resolved({ ...COLLECTION_TARGET }) });
  await assert.rejects(
    () => listCommunityComments(stale.ports, {
      viewer: ANONYMOUS,
      query: listQuery({ kind: 'bookmark', id: NODE, collectionId: COLLECTION, generation: 'bm-gen-old' }),
      cursorCodec: listCodec(),
    }), errorCode('resource_not_found'));
  assert.equal(stale.rootScans.length, 0, 'no scan runs before generation proof');
});

test('listCommunityComments pages roots DESC with a bound cursor and closed page', async () => {
  const roots = [
    record({ id: 'comment-3', createdAt: new Date(NOW.getTime() - 1_000) }),
    record({ id: 'comment-2', createdAt: new Date(NOW.getTime() - 2_000) }),
    record({ id: 'comment-1', createdAt: new Date(NOW.getTime() - 3_000) }),
  ];
  const fixture = queryPorts({ roots, threadCounts: new Map([['comment-3', 4]]) });
  const first = await listCommunityComments(fixture.ports, {
    viewer: VIEWER, query: listQuery({ limit: 2 }), cursorCodec: listCodec(),
  });
  assert.equal(first.items.length, 2);
  assert.deepEqual(first.items.map((item) => item.id), ['comment-3', 'comment-2']);
  assert.equal(first.items[0]!.replyCount, 4);
  assert.ok(first.nextCursor !== null);
  // The scan asks for limit+1 rows in the contract keyset order.
  assert.deepEqual(fixture.rootScans, [{ after: null, limit: 3 }]);
  // Closed Comment objects only carry the contract keys.
  assert.deepEqual(Object.keys(first.items[0]!).sort(), [
    'author', 'body', 'canCurate', 'canDelete', 'canEdit', 'createdAt', 'depth',
    'id', 'replyCount', 'replyToId', 'revision', 'rootId', 'state', 'target', 'updatedAt',
  ]);

  const second = await listCommunityComments(fixture.ports, {
    viewer: VIEWER,
    query: listQuery({ limit: 2, cursor: first.nextCursor! }),
    cursorCodec: listCodec(),
  });
  assert.deepEqual(second.items.map((item) => item.id), ['comment-1']);
  assert.equal(second.nextCursor, null);

  // The cursor binds viewer/limit/target/endpoint: any drift is invalid_cursor.
  for (const wrong of [
    { viewer: ANONYMOUS, query: listQuery({ limit: 2, cursor: first.nextCursor! }) },
    { viewer: VIEWER, query: listQuery({ limit: 3, cursor: first.nextCursor! }) },
    { viewer: VIEWER, query: listQuery({
      limit: 2, id: 'col-other', cursor: first.nextCursor!,
    }) },
  ]) {
    await assert.rejects(() => listCommunityComments(fixture.ports, {
      viewer: wrong.viewer, query: wrong.query, cursorCodec: listCodec(),
    }), errorCode('invalid_cursor'));
  }
  // A replies-endpoint token never verifies on the root list.
  const foreignCursor = repliesCodec().sign({
    v: 1, ep: COMMUNITY_COMMENT_REPLIES_ENDPOINT, vw: VIEWER.accountId,
    tg: { k: 'collection', i: COLLECTION, c: null, s: null, g: COMMUNITY_STATIC_GENERATION },
    rt: 'comment-3', lm: 2,
    pos: { t: new Date(NOW.getTime() - 2_000).toISOString(), i: 'comment-2' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
  });
  await assert.rejects(() => listCommunityComments(fixture.ports, {
    viewer: VIEWER, query: listQuery({ limit: 2, cursor: foreignCursor }), cursorCodec: listCodec(),
  }), errorCode('invalid_cursor'));
});

test('listCommunityComments serves tombstones and viewer-scoped affordances', async () => {
  const roots = [
    record({ id: 'comment-1', state: 'deleted', body: null }),
    record({ id: 'comment-2', state: 'hidden' }),
    record({ id: 'comment-3', authorAccountId: VIEWER.accountId }),
  ];
  const fixture = queryPorts({ roots });
  const page = await listCommunityComments(fixture.ports, {
    viewer: VIEWER, query: listQuery(), cursorCodec: listCodec(),
  });
  assert.equal(page.items.length, 3);
  assert.equal(page.items[0]!.body, null);
  assert.equal(page.items[0]!.state, 'deleted');
  assert.equal(page.items[1]!.body, null);
  assert.equal(page.items[1]!.state, 'hidden');
  // The viewer authored comment-3: author hints on; owner hint off.
  assert.equal(page.items[2]!.canEdit, true);
  assert.equal(page.items[2]!.canCurate, false);
});

test('listCommunityComments byte budget emits a short page with a correct nextCursor', async () => {
  // Bodies near the 4000-code-point cap make each item ~4KB; at limit 20 the
  // 64KiB page budget cuts before the item limit. The bookmark target is at
  // its contract bounds (128-char id/collectionId/generation) so the signed
  // continuation cursor is a realistic >512-byte token — the reserve must
  // cover it, not an idealized small one.
  const fat = 'x'.repeat(4_000);
  const nodeId = 'n'.repeat(128);
  const collectionId = 'c'.repeat(128);
  const generation = `bm-gen-${'g'.repeat(120)}`;
  const roots = Array.from({ length: 20 }, (_, index) => record({
    id: `comment-${String(index).padStart(2, '0')}`,
    body: fat,
    createdAt: new Date(NOW.getTime() - index * 1_000),
  }));
  const fixture = queryPorts({
    roots,
    resolved: resolved({
      kind: 'bookmark', id: nodeId, collectionId,
      seriesId: null, generation,
    }),
  });
  const bookmarkListQuery = (overrides: Record<string, unknown> = {}) =>
    parseCommunityCommentsQuery({
      kind: 'bookmark', id: nodeId, collectionId, generation, ...overrides,
    });
  const page = await listCommunityComments(fixture.ports, {
    viewer: VIEWER, query: bookmarkListQuery({ limit: 20 }), cursorCodec: listCodec(),
  });
  const serialized = Buffer.byteLength(JSON.stringify(page), 'utf8');
  assert.ok(serialized <= COMMUNITY_COMMENT_PAGE_BYTE_BUDGET,
    `page ${serialized} exceeds ${COMMUNITY_COMMENT_PAGE_BYTE_BUDGET}`);
  assert.ok(page.items.length < 20, `byte budget should cut before the item limit, got ${page.items.length}`);
  assert.ok(page.items.length > 0);
  // The short page still carries a nextCursor positioned after the LAST
  // emitted item so the first unconsumed comment leads the next page. The
  // real cursor must exceed the old 512-byte reserve to prove the fix.
  assert.ok(page.nextCursor !== null);
  assert.ok(page.nextCursor.length > 512,
    `cursor ${page.nextCursor.length} chars should exceed the old 512 reserve`);
  const rest = await listCommunityComments(fixture.ports, {
    viewer: VIEWER, query: bookmarkListQuery({ limit: 20, cursor: page.nextCursor }), cursorCodec: listCodec(),
  });
  assert.equal(rest.items[0]!.id, `comment-${String(page.items.length).padStart(2, '0')}`);
  assert.equal(rest.items.length, 20 - page.items.length);
  assert.equal(rest.nextCursor, null);
  // The continuation page is byte-capped too.
  assert.ok(Buffer.byteLength(JSON.stringify(rest), 'utf8') <= COMMUNITY_COMMENT_PAGE_BYTE_BUDGET);
});

test('an oversized first comment is still emitted so the thread never truncates silently', async () => {
  // One comment whose serialized view alone exceeds the page byte budget
  // must be emitted anyway: an empty page has no `last` position, carries
  // no cursor, and would silently drop the remaining thread.
  const huge = 'x'.repeat(70_000);
  const roots = [
    record({ id: 'comment-big', body: huge, createdAt: new Date(NOW.getTime() - 1_000) }),
    record({ id: 'comment-small', createdAt: new Date(NOW.getTime() - 2_000) }),
  ];
  const fixture = queryPorts({ roots });
  const first = await listCommunityComments(fixture.ports, {
    viewer: VIEWER, query: listQuery({ limit: 10 }), cursorCodec: listCodec(),
  });
  assert.deepEqual(first.items.map((item) => item.id), ['comment-big']);
  assert.ok(first.nextCursor !== null,
    'the oversized first comment must still yield a resume cursor');
  const rest = await listCommunityComments(fixture.ports, {
    viewer: VIEWER, query: listQuery({ limit: 10, cursor: first.nextCursor }),
    cursorCodec: listCodec(),
  });
  assert.deepEqual(rest.items.map((item) => item.id), ['comment-small']);
  assert.equal(rest.nextCursor, null);
});

/* ——— getCommunityComment ——— */

test('getCommunityComment conceals missing rows, dead targets and superseded generations', async () => {
  const missing = queryPorts({ byId: null });
  await assert.rejects(
    () => getCommunityComment(missing.ports, { viewer: VIEWER, commentId: 'comment-x' }),
    errorCode('resource_not_found'));

  const deadTarget = queryPorts({ byId: record(), resolved: null });
  await assert.rejects(
    () => getCommunityComment(deadTarget.ports, { viewer: VIEWER, commentId: 'comment-1' }),
    errorCode('resource_not_found'));

  // The row's pinned generation no longer matches the resolved authority.
  const superseded = queryPorts({
    byId: record({
      target: { kind: 'bookmark', id: NODE, collectionId: COLLECTION, seriesId: null },
      targetGeneration: 'bm-gen-old',
    }),
    resolved: resolved(BOOKMARK_TARGET),
  });
  await assert.rejects(
    () => getCommunityComment(superseded.ports, { viewer: VIEWER, commentId: 'comment-1' }),
    errorCode('resource_not_found'));
});

test('getCommunityComment returns the closed Comment with per-depth replyCount', async () => {
  const fixture = queryPorts({ threadCounts: new Map([['comment-1', 7]]) });
  const comment = await getCommunityComment(fixture.ports, { viewer: VIEWER, commentId: 'comment-1' });
  assert.equal(comment.id, 'comment-1');
  assert.equal(comment.replyCount, 7);
  assert.equal(comment.author.displayName, 'Alice');

  // A depth-1 reply counts its own visible children, not the thread total.
  const reply = queryPorts({
    byId: record({ id: 'comment-2', depth: 1, replyToId: 'comment-1', rootId: 'comment-1' }),
    directCounts: new Map([['comment-2', 2]]),
    threadCounts: new Map([['comment-2', 9]]),
  });
  const replyView = await getCommunityComment(reply.ports, { viewer: VIEWER, commentId: 'comment-2' });
  assert.equal(replyView.replyCount, 2);
  assert.equal(replyView.replyToId, 'comment-1');
  assert.equal(replyView.rootId, 'comment-1');
});

/* ——— listCommunityCommentReplies ——— */

test('listCommunityCommentReplies requires the path id to be a live root', async () => {
  const missing = queryPorts({ byId: null });
  await assert.rejects(
    () => listCommunityCommentReplies(missing.ports, {
      viewer: VIEWER, commentId: 'comment-x', query: { limit: 20, cursor: null }, cursorCodec: repliesCodec(),
    }), errorCode('resource_not_found'));

  const deadTarget = queryPorts({ resolved: null });
  await assert.rejects(
    () => listCommunityCommentReplies(deadTarget.ports, {
      viewer: VIEWER, commentId: 'comment-1', query: { limit: 20, cursor: null }, cursorCodec: repliesCodec(),
    }), errorCode('resource_not_found'));

  // A non-root comment exists — it is simply not a thread root.
  const nonRoot = queryPorts({
    byId: record({ id: 'comment-2', depth: 1, replyToId: 'comment-1', rootId: 'comment-1' }),
  });
  await assert.rejects(
    () => listCommunityCommentReplies(nonRoot.ports, {
      viewer: VIEWER, commentId: 'comment-2', query: { limit: 20, cursor: null }, cursorCodec: repliesCodec(),
    }), errorCode('invalid_request', COMMUNITY_COMMENT_NOT_ROOT_MESSAGE));
  assert.equal(nonRoot.descendantScans.length, 0, 'no descendant scan for a non-root path');
});

test('listCommunityCommentReplies flattens descendants ASC with a bound cursor', async () => {
  const descendants = [
    record({ id: 'reply-1', depth: 1, rootId: 'comment-1', replyToId: 'comment-1',
      createdAt: new Date(NOW.getTime() + 1_000) }),
    record({ id: 'reply-2', depth: 2, rootId: 'comment-1', replyToId: 'reply-1',
      createdAt: new Date(NOW.getTime() + 2_000) }),
    record({ id: 'reply-3', depth: 1, rootId: 'comment-1', replyToId: 'comment-1',
      createdAt: new Date(NOW.getTime() + 3_000) }),
  ];
  const fixture = queryPorts({ descendants });
  const first = await listCommunityCommentReplies(fixture.ports, {
    viewer: VIEWER, commentId: 'comment-1', query: { limit: 2, cursor: null }, cursorCodec: repliesCodec(),
  });
  assert.deepEqual(first.items.map((item) => item.id), ['reply-1', 'reply-2']);
  assert.equal(first.items[1]!.replyToId, 'reply-1', 'nested replyToId is retained');
  assert.equal(first.items[1]!.rootId, 'comment-1');
  assert.ok(first.nextCursor !== null);
  assert.deepEqual(fixture.descendantScans, [{ rootId: 'comment-1', after: null, limit: 3 }]);

  const second = await listCommunityCommentReplies(fixture.ports, {
    viewer: VIEWER, commentId: 'comment-1',
    query: { limit: 2, cursor: first.nextCursor }, cursorCodec: repliesCodec(),
  });
  assert.deepEqual(second.items.map((item) => item.id), ['reply-3']);
  assert.equal(second.nextCursor, null);

  // The replies cursor binds the root id: a token from a sibling thread or a
  // different viewer/limit is invalid_cursor.
  const siblingCursor = repliesCodec().sign({
    v: 1, ep: COMMUNITY_COMMENT_REPLIES_ENDPOINT, vw: VIEWER.accountId,
    tg: { k: 'collection', i: COLLECTION, c: null, s: null, g: COMMUNITY_STATIC_GENERATION },
    rt: 'comment-other', lm: 2,
    pos: { t: new Date(NOW.getTime() + 2_000).toISOString(), i: 'reply-2' },
    issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
  });
  await assert.rejects(() => listCommunityCommentReplies(fixture.ports, {
    viewer: VIEWER, commentId: 'comment-1',
    query: { limit: 2, cursor: siblingCursor }, cursorCodec: repliesCodec(),
  }), errorCode('invalid_cursor'));
  await assert.rejects(() => listCommunityCommentReplies(fixture.ports, {
    viewer: ANONYMOUS, commentId: 'comment-1',
    query: { limit: 2, cursor: first.nextCursor }, cursorCodec: repliesCodec(),
  }), errorCode('invalid_cursor'));
});

test('comment views keep closed Comment shape on every operation', async () => {
  const fixture = queryPorts({});
  const comment: CommunityComment = await getCommunityComment(
    fixture.ports, { viewer: VIEWER, commentId: 'comment-1' });
  assert.deepEqual(Object.keys(comment).sort(), [
    'author', 'body', 'canCurate', 'canDelete', 'canEdit', 'createdAt', 'depth',
    'id', 'replyCount', 'replyToId', 'revision', 'rootId', 'state', 'target', 'updatedAt',
  ]);
  assert.deepEqual(Object.keys(comment.author).sort(),
    ['avatarUrl', 'displayName', 'handle', 'id']);
  assert.equal(comment.revision, '1');
});
