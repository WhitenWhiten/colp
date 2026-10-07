/**
 * CS-03 community comments and replies: the three read operations.
 *
 * Every page re-proves the CURRENT target through the shared CS-01 resolve
 * port before any row or cursor result is served: a missing, private,
 * unlisted, withdrawn, deleted, or otherwise concealed target — or a
 * supplied generation that no longer matches the resolved authority —
 * returns the same concealed resource_not_found. Stored rows written
 * against a superseded bookmark generation are concealed with the content
 * they described.
 *
 * Ordering is contract-fixed: the root list pages `createdAt DESC, id ASC`;
 * the replies endpoint flattens all descendants of the named ROOT comment
 * `createdAt ASC, id ASC` (a non-root commentId is invalid_request).
 * Tombstoned (deleted/hidden) comments keep their positions and serve
 * `body: null`.
 *
 * Cursors are opaque `keyId.body.signature` tokens signed with a
 * purpose-derived HMAC key (`COMMUNITY_CURSOR_HMAC_KEY` → the endpoint
 * name). They bind the endpoint, viewer, full target identity + generation,
 * the replies root, and the page limit; TTL is 900 seconds. Tamper,
 * mismatch, or expiry all map to `invalid_cursor`. Each page is bounded by
 * both the item limit and the 65,536-byte serialized-page budget; a
 * byte-limited short page still returns a nextCursor positioned so the
 * first unconsumed item leads the next page.
 */
import {
  COMMUNITY_COMMENTS_ENDPOINT,
  COMMUNITY_COMMENT_CURSOR_TTL_MS,
  COMMUNITY_COMMENT_REPLIES_ENDPOINT,
  communityCommentInvalidCursor,
  type CommunityCommentCursorCodec,
  type CommunityCommentCursorPayload,
  type CommunityCommentCursorTarget,
} from './community-comment-cursor.js';
import {
  type CommunityTargetIdentity,
  type CommunityTargetQuery,
} from './community-target.js';
import type {
  CommunityTargetViewer,
  ResolvedCommunityTarget,
} from './community-target-query.js';
import {
  COMMUNITY_COMMENT_CONCEALED_MESSAGE,
  CommunityCommentError,
  communityCommentAuthorView,
  communityCommentView,
  type CommunityComment,
  type CommunityCommentAuthor,
  type CommunityCommentCurationRecord,
  type CommunityCommentRecord,
  type CommunityCommentSettingsRecord,
} from './community-comment.js';
import {
  COMMUNITY_COMMENT_DEFAULT_LIMIT,
  parseCommunityCommentRepliesQuery,
  parseCommunityCommentsQuery,
  type CommunityCommentRepliesQuery,
  type CommunityCommentsQuery,
} from './community-comment-query-parse.js';

export {
  COMMUNITY_COMMENT_DEFAULT_LIMIT,
  parseCommunityCommentRepliesQuery,
  parseCommunityCommentsQuery,
  type CommunityCommentRepliesQuery,
  type CommunityCommentsQuery,
};

export const COMMUNITY_COMMENT_PAGE_BYTE_BUDGET = 65_536;
/**
 * Serialized-page cursor accounting is EXACT, not reserved: for every
 * candidate item the fill loop measures the real `nextCursor` token via
 * `cursorCodec.encodedLength` on the very payload `sign` would emit (same
 * endpoint, viewer, target, limit, and `pos` bound to that item). The
 * `null` placeholder serialized by `pageBytes` (4 bytes) is replaced by
 * `"<token>"` (token + 2 quote bytes), so a candidate fits iff
 * `pageBytes + tokenBytes - 2 <= COMMUNITY_COMMENT_PAGE_BYTE_BUDGET`.
 */

export const COMMUNITY_COMMENT_NOT_ROOT_MESSAGE =
  'The replies endpoint requires the root comment id.';

/** Exact closed page object shared by the list and replies operations. */
export interface CommunityCommentPageView {
  readonly items: readonly CommunityComment[];
  readonly nextCursor: string | null;
}

/** Keyset position after a row in the endpoint's fixed ordering. */
export interface CommunityCommentKeysetPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Live public-author facts keyed by account id; a missing entry maps to the
 * former-member tombstone via `communityCommentAuthorView`.
 */
export interface CommunityCommentLiveAuthor {
  readonly handle: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface CommunityCommentQueryPorts {
  readonly targets: {
    resolve(query: CommunityTargetQuery): Promise<ResolvedCommunityTarget | null>;
    /**
     * CS-04: stable creation stamp of the target authority row — the
     * `updatedAt` of the virtual (never-written) comment settings
     * representation. Null when the row does not exist.
     */
    createdAt(identity: CommunityTargetIdentity): Promise<Date | null>;
  };
  /** CS-04: target owner/editor predicate behind the `canCurate` hint. */
  readonly curators: {
    canCurate(identity: CommunityTargetIdentity, subjectId: string): Promise<boolean>;
  };
  readonly comments: {
    findById(commentId: string): Promise<CommunityCommentRecord | null>;
    /**
     * Root rows of one target generation after `after`, ordered
     * `createdAt DESC, id ASC`.
     */
    scanRoots(
      identity: CommunityTargetIdentity,
      generation: string,
      after: CommunityCommentKeysetPosition | null,
      limit: number,
    ): Promise<readonly CommunityCommentRecord[]>;
    /**
     * All descendants (depth > 0) of one root after `after`, ordered
     * `createdAt ASC, id ASC`.
     */
    scanDescendants(
      rootId: string,
      after: CommunityCommentKeysetPosition | null,
      limit: number,
    ): Promise<readonly CommunityCommentRecord[]>;
    /** Per root id: count of visible rows with `root_id = id AND depth > 0`. */
    countVisibleThreadReplies(rootIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
    /** Per comment id: count of visible rows with `reply_to_id = id`. */
    countVisibleDirectReplies(commentIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  };
  /** CS-04: curation overlay rows (one per comment, absent until first write). */
  readonly curations: {
    find(commentId: string): Promise<CommunityCommentCurationRecord | null>;
  };
  /** CS-04: per-target comment-area settings (generation-independent). */
  readonly settings: {
    find(identity: CommunityTargetIdentity): Promise<CommunityCommentSettingsRecord | null>;
  };
  readonly authors: {
    publicActors(accountIds: readonly string[]): Promise<ReadonlyMap<string, CommunityCommentLiveAuthor>>;
  };
  readonly clock: { now(): Promise<Date> };
}

function invalidCursor(): CommunityCommentError {
  return communityCommentInvalidCursor();
}
function concealed(): CommunityCommentError {
  return new CommunityCommentError('resource_not_found', COMMUNITY_COMMENT_CONCEALED_MESSAGE);
}

function commentsTargetQuery(query: CommunityCommentsQuery): CommunityTargetQuery {
  return {
    kind: query.kind,
    id: query.id,
    ...(query.collectionId !== null ? { collectionId: query.collectionId } : {}),
    ...(query.seriesId !== null ? { seriesId: query.seriesId } : {}),
  };
}

function recordTargetQuery(record: CommunityCommentRecord): CommunityTargetQuery {
  const identity = record.target;
  return {
    kind: identity.kind,
    id: identity.id,
    ...(identity.collectionId !== null ? { collectionId: identity.collectionId } : {}),
    ...(identity.seriesId !== null ? { seriesId: identity.seriesId } : {}),
  };
}

function viewerKey(viewer: CommunityTargetViewer): string {
  return viewer.accountId ?? 'anonymous';
}

function cursorTarget(
  identity: CommunityTargetIdentity,
  generation: string,
): CommunityCommentCursorTarget {
  return {
    k: identity.kind,
    i: identity.id,
    c: identity.collectionId,
    s: identity.seriesId,
    g: generation,
  };
}

function boundCursorTarget(target: CommunityCommentCursorTarget, resolved: ResolvedCommunityTarget): boolean {
  const t = resolved.target;
  return target.k === t.kind
    && target.i === t.id
    && target.c === t.collectionId
    && target.s === t.seriesId
    && target.g === t.generation;
}

function boundListCursor(
  payload: CommunityCommentCursorPayload,
  query: CommunityCommentsQuery,
  resolved: ResolvedCommunityTarget,
  viewer: CommunityTargetViewer,
): boolean {
  return payload.ep === COMMUNITY_COMMENTS_ENDPOINT
    && payload.vw === viewerKey(viewer)
    && payload.rt === null
    && payload.lm === query.limit
    && boundCursorTarget(payload.tg, resolved);
}

function boundRepliesCursor(
  payload: CommunityCommentCursorPayload,
  root: CommunityCommentRecord,
  resolved: ResolvedCommunityTarget,
  viewer: CommunityTargetViewer,
  limit: number,
): boolean {
  return payload.ep === COMMUNITY_COMMENT_REPLIES_ENDPOINT
    && payload.vw === viewerKey(viewer)
    && payload.rt === root.id
    && payload.lm === limit
    && boundCursorTarget(payload.tg, resolved);
}

function authorOrTombstone(
  authors: ReadonlyMap<string, CommunityCommentLiveAuthor>,
  accountId: string,
): CommunityCommentAuthor {
  return communityCommentAuthorView(accountId, authors.get(accountId) ?? null);
}

function replyCountOf(
  record: CommunityCommentRecord,
  counts: ReadonlyMap<string, number>,
): number {
  return counts.get(record.id) ?? 0;
}

function pageBytes(items: readonly CommunityComment[]): number {
  // Envelope with a null cursor; the exact encoded cursor allowance for
  // the candidate's own `pos` is added per item by `fillPage`.
  return Buffer.byteLength(JSON.stringify({ items, nextCursor: null }), 'utf8');
}

/**
 * Exact UTF-8 size of the page if `cursorTokenBytes` replaces the `null`
 * placeholder: `null` is 4 bytes, `"<token>"` is token + 2 bytes.
 */
function pageBytesWithCursor(items: readonly CommunityComment[], cursorTokenBytes: number): number {
  return pageBytes(items) + cursorTokenBytes - 2;
}

interface PageFill {
  readonly items: readonly CommunityComment[];
  readonly more: boolean;
  readonly last: CommunityCommentRecord | null;
}

/** CS-04: whether the viewer is a curator of the target (false anonymously). */
async function viewerCuratesTarget(
  ports: Pick<CommunityCommentQueryPorts, 'curators'>,
  viewer: CommunityTargetViewer,
  identity: CommunityTargetIdentity,
): Promise<boolean> {
  if (viewer.accountId === null || viewer.subjectId === null) return false;
  return ports.curators.canCurate(identity, viewer.subjectId);
}

async function fillPage(
  ports: CommunityCommentQueryPorts,
  input: {
    readonly viewer: CommunityTargetViewer;
    readonly resolved: ResolvedCommunityTarget;
    readonly batch: readonly CommunityCommentRecord[];
    readonly limit: number;
    readonly threadCounts: boolean;
    readonly viewerCurates: boolean;
    /**
     * Exact encoded length of the `nextCursor` token that would be
     * emitted if `record` were the last item of this page — the codec
     * measures the real payload, so the byte budget is never guessed.
     */
    readonly cursorBytes: (record: CommunityCommentRecord) => number;
  },
): Promise<PageFill> {
  const candidates = input.batch.slice(0, input.limit);
  const authorIds = [...new Set(candidates.map((record) => record.authorAccountId))];
  const authors = authorIds.length === 0
    ? new Map<string, CommunityCommentLiveAuthor>()
    : await ports.authors.publicActors(authorIds);
  const counts = candidates.length === 0
    ? new Map<string, number>()
    : input.threadCounts
      ? await ports.comments.countVisibleThreadReplies(candidates.map((record) => record.id))
      : await ports.comments.countVisibleDirectReplies(candidates.map((record) => record.id));
  const items: CommunityComment[] = [];
  let last: CommunityCommentRecord | null = null;
  for (const record of candidates) {
    const view = communityCommentView(record, {
      viewer: input.viewer,
      author: authorOrTombstone(authors, record.authorAccountId),
      replyCount: replyCountOf(record, counts),
      viewerCurates: input.viewerCurates,
    });
    // The page must fit WITH the cursor it would carry if this item were
    // the last emitted one — so the appended check measures the token for
    // this record's own keyset position, exactly as `sign` would emit it.
    // The FIRST candidate is admitted unconditionally: an empty page has
    // `last` null, carries no cursor, and would silently truncate the
    // thread, so the budget bounds only candidates after the first.
    if (items.length > 0 && pageBytesWithCursor([...items, view], input.cursorBytes(record))
      > COMMUNITY_COMMENT_PAGE_BYTE_BUDGET) {
      break;
    }
    items.push(view);
    last = record;
  }
  return Object.freeze<PageFill>({
    items: Object.freeze(items),
    more: input.batch.length > items.length,
    last,
  });
}

/**
 * Page the root comments of one target generation. The current target must
 * resolve AND the supplied generation must equal the resolved generation —
 * a stale generation conceals the old thread, it is not a conflict.
 */
export async function listCommunityComments(
  ports: CommunityCommentQueryPorts,
  input: {
    readonly viewer: CommunityTargetViewer;
    readonly query: CommunityCommentsQuery;
    readonly cursorCodec: CommunityCommentCursorCodec;
  },
): Promise<CommunityCommentPageView> {
  const { query } = input;
  const resolved = await ports.targets.resolve(commentsTargetQuery(query));
  if (resolved === null || query.generation !== resolved.target.generation) {
    throw concealed();
  }
  const now = await ports.clock.now();
  let after: CommunityCommentKeysetPosition | null = null;
  if (query.cursor !== null) {
    let payload: CommunityCommentCursorPayload;
    try {
      payload = input.cursorCodec.verify(query.cursor, now);
    } catch {
      throw invalidCursor();
    }
    if (!boundListCursor(payload, query, resolved, input.viewer)) throw invalidCursor();
    after = { createdAt: new Date(payload.pos.t), id: payload.pos.i };
  }
  const identity: CommunityTargetIdentity = {
    kind: query.kind,
    id: query.id,
    collectionId: query.collectionId,
    seriesId: query.seriesId,
  };
  const batch = await ports.comments.scanRoots(
    identity, resolved.target.generation, after, query.limit + 1,
  );
  const viewerCurates = await viewerCuratesTarget(ports, input.viewer, identity);
  // One payload builder feeds both the exact byte measurement and `sign`,
  // so the budget check can never drift from the emitted token.
  const cursorPayload = (record: CommunityCommentRecord): CommunityCommentCursorPayload => ({
    v: 1,
    ep: COMMUNITY_COMMENTS_ENDPOINT,
    vw: viewerKey(input.viewer),
    tg: cursorTarget(identity, resolved.target.generation),
    rt: null,
    lm: query.limit,
    pos: { t: record.createdAt.toISOString(), i: record.id },
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + COMMUNITY_COMMENT_CURSOR_TTL_MS).toISOString(),
  });
  const page = await fillPage(ports, {
    viewer: input.viewer,
    resolved,
    batch,
    limit: query.limit,
    threadCounts: true,
    viewerCurates,
    cursorBytes: (record) => input.cursorCodec.encodedLength(cursorPayload(record)),
  });
  const nextCursor = !page.more || page.last === null
    ? null
    : input.cursorCodec.sign(cursorPayload(page.last));
  return Object.freeze<CommunityCommentPageView>({
    items: page.items,
    nextCursor,
  });
}

/**
 * Fetch one comment by id. The row must exist, its target must still resolve
 * for the viewer, and the generation it was written against must still be
 * the target's current generation — every other outcome is the same
 * concealed resource_not_found.
 */
export async function getCommunityComment(
  ports: CommunityCommentQueryPorts,
  input: {
    readonly viewer: CommunityTargetViewer;
    readonly commentId: string;
  },
): Promise<CommunityComment> {
  const record = await ports.comments.findById(input.commentId);
  if (record === null) throw concealed();
  const resolved = await ports.targets.resolve(recordTargetQuery(record));
  if (resolved === null || record.targetGeneration !== resolved.target.generation) {
    throw concealed();
  }
  const authors = await ports.authors.publicActors([record.authorAccountId]);
  const replyCount = record.depth === 0
    ? (await ports.comments.countVisibleThreadReplies([record.id])).get(record.id) ?? 0
    : record.depth === 1
      ? (await ports.comments.countVisibleDirectReplies([record.id])).get(record.id) ?? 0
      : 0;
  const viewerCurates = await viewerCuratesTarget(ports, input.viewer, record.target);
  return communityCommentView(record, {
    viewer: input.viewer,
    author: authorOrTombstone(authors, record.authorAccountId),
    replyCount,
    viewerCurates,
  });
}

/**
 * Page the flattened descendants of one ROOT comment `createdAt ASC,
 * id ASC`. The path commentId must resolve to a live root on a currently
 * resolvable target generation; a non-root comment is invalid_request
 * (the comment exists — it is simply not a thread root).
 */
export async function listCommunityCommentReplies(
  ports: CommunityCommentQueryPorts,
  input: {
    readonly viewer: CommunityTargetViewer;
    readonly commentId: string;
    readonly query: CommunityCommentRepliesQuery;
    readonly cursorCodec: CommunityCommentCursorCodec;
  },
): Promise<CommunityCommentPageView> {
  const root = await ports.comments.findById(input.commentId);
  if (root === null) throw concealed();
  const resolved = await ports.targets.resolve(recordTargetQuery(root));
  if (resolved === null || root.targetGeneration !== resolved.target.generation) {
    throw concealed();
  }
  if (root.depth !== 0) {
    throw new CommunityCommentError('invalid_request', COMMUNITY_COMMENT_NOT_ROOT_MESSAGE);
  }
  const now = await ports.clock.now();
  const { query } = input;
  let after: CommunityCommentKeysetPosition | null = null;
  if (query.cursor !== null) {
    let payload: CommunityCommentCursorPayload;
    try {
      payload = input.cursorCodec.verify(query.cursor, now);
    } catch {
      throw invalidCursor();
    }
    if (!boundRepliesCursor(payload, root, resolved, input.viewer, query.limit)) {
      throw invalidCursor();
    }
    after = { createdAt: new Date(payload.pos.t), id: payload.pos.i };
  }
  const batch = await ports.comments.scanDescendants(root.id, after, query.limit + 1);
  const viewerCurates = await viewerCuratesTarget(ports, input.viewer, root.target);
  const cursorPayload = (record: CommunityCommentRecord): CommunityCommentCursorPayload => ({
    v: 1,
    ep: COMMUNITY_COMMENT_REPLIES_ENDPOINT,
    vw: viewerKey(input.viewer),
    tg: cursorTarget(root.target, resolved.target.generation),
    rt: root.id,
    lm: query.limit,
    pos: { t: record.createdAt.toISOString(), i: record.id },
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + COMMUNITY_COMMENT_CURSOR_TTL_MS).toISOString(),
  });
  const page = await fillPage(ports, {
    viewer: input.viewer,
    resolved,
    batch,
    limit: query.limit,
    threadCounts: false,
    viewerCurates,
    cursorBytes: (record) => input.cursorCodec.encodedLength(cursorPayload(record)),
  });
  const nextCursor = !page.more || page.last === null
    ? null
    : input.cursorCodec.sign(cursorPayload(page.last));
  return Object.freeze<CommunityCommentPageView>({
    items: page.items,
    nextCursor,
  });
}
