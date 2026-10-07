import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_NOTIFICATIONS_ENDPOINT,
  COMMUNITY_NOTIFICATION_CURSOR_TTL_MS,
  COMMUNITY_NOTIFICATION_PAGE_BYTE_BUDGET,
  CommunityNotificationError,
  countServableUnread,
  createCommunityNotificationCursorCodec,
  getCommunityNotificationPreference,
  listCommunityNotifications,
  COMMUNITY_STATIC_GENERATION,
  type CommunityCommentRecord,
  type CommunityNotificationQueryPorts,
  type CommunityNotificationRow,
  type CommunityNotificationsQuery,
  type CommunityNotificationUnreadGroup,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';

const HMAC_KEY = Buffer.alloc(32, 9);
const NOW = new Date('2026-10-05T12:00:00.000Z');
const VIEWER = { accountId: 'a-viewer', subjectId: 's-viewer' };

const TARGET_IDENTITY = {
  kind: 'collection' as const, id: 'col-1', collectionId: null, seriesId: null,
};

function row(id: string, overrides: Partial<CommunityNotificationRow> = {}): CommunityNotificationRow {
  return {
    notificationId: id,
    actorProfileId: 'a-actor',
    subjectId: `comment-${id}`,
    state: 'unread',
    readAt: null,
    occurredAt: new Date(NOW.getTime() - Number(id.replace(/\D/gu, '') || '1') * 60_000),
    ...overrides,
  };
}

function comment(id: string, overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id,
    target: TARGET_IDENTITY,
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: 'comment-root',
    replyToId: 'comment-root',
    depth: 1,
    authorAccountId: 'a-actor',
    body: `body-${id}`,
    state: 'visible',
    curationHidden: false,
    revision: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resolved(generation = COMMUNITY_STATIC_GENERATION): ResolvedCommunityTarget {
  return {
    target: { ...TARGET_IDENTITY, generation },
    ownerSubjectId: 's-owner',
    title: 'Collection',
    href: 'https://known.example/c/col-1',
  };
}

interface Harness {
  readonly ports: CommunityNotificationQueryPorts;
  readonly rows: CommunityNotificationRow[];
  readonly groups: CommunityNotificationUnreadGroup[];
  preference: { enabled: boolean; revision: bigint; updatedAt: Date } | null;
  readonly comments: Map<string, CommunityCommentRecord>;
  resolveResult: ResolvedCommunityTarget | null;
  account: { accountId: string; subjectId: string; createdAt: Date } | null;
  /** Single-target resolutions performed so far; one round trip each. */
  resolveCalls: number;
  /** Batch resolutions performed so far, with the size of each. */
  resolveManyCalls: number;
  readonly resolveManySizes: number[];
}

function harness(setup: {
  rows?: CommunityNotificationRow[];
  groups?: CommunityNotificationUnreadGroup[];
  comments?: Map<string, CommunityCommentRecord>;
  preference?: Harness['preference'];
  resolve?: ResolvedCommunityTarget | null;
  account?: Harness['account'];
  /** Set false to exercise the per-target fallback a host without batching uses. */
  batchResolve?: boolean;
} = {}): Harness {
  const h: Harness = {
    resolveCalls: 0,
    resolveManyCalls: 0,
    resolveManySizes: [],
    rows: setup.rows ?? [],
    groups: setup.groups ?? [],
    comments: setup.comments ?? new Map(),
    preference: setup.preference ?? null,
    resolveResult: setup.resolve === undefined ? resolved() : setup.resolve,
    account: setup.account === undefined
      ? { accountId: VIEWER.accountId, subjectId: VIEWER.subjectId, createdAt: NOW }
      : setup.account,
    ports: undefined as never,
  };
  const ports: CommunityNotificationQueryPorts = {
    account: { findActive: async () => h.account },
    preferences: { findCommunity: async () => h.preference },
    notifications: {
      page: async (_recipient, state, after, limit) => {
        let rows = h.rows;
        if (state === 'unread') rows = rows.filter((r) => r.state === 'unread');
        if (after !== null) {
          rows = rows.filter((r) =>
            r.occurredAt < after.occurredAt
            || (r.occurredAt.getTime() === after.occurredAt.getTime()
              && r.notificationId < after.notificationId));
        }
        return rows.slice(0, limit);
      },
      unreadGroups: async () => h.groups,
    },
    comments: {
      findMany: async (ids) => {
        const out = new Map<string, CommunityCommentRecord>();
        for (const id of ids) {
          const record = h.comments.get(id);
          if (record !== undefined) out.set(id, record);
        }
        return out;
      },
    },
    // Counted so a change in how many targets the inbox resolves is visible:
    // `resolve` is one database round trip per unread group, and the group list
    // has no LIMIT.
    targets: {
      async resolve() { h.resolveCalls += 1; return h.resolveResult },
      // The production port also offers the batch form; the harness mirrors it
      // so tests can pin both costs.
      ...(setup.batchResolve === false ? {} : {
        async resolveMany(queries: readonly { readonly id: string }[]) {
          h.resolveManyCalls += 1;
          h.resolveManySizes.push(queries.length);
          return queries.map(() => h.resolveResult);
        },
      }),
    },
    authors: {
      publicActors: async (ids) => new Map(ids.map((id) => [id, {
        accountId: id, subjectId: `s-${id}`, handle: `h-${id}`,
        displayName: `User ${id}`, avatarUrl: null,
      }])),
    },
    clock: { now: async () => NOW },
  };
  (h as { ports: CommunityNotificationQueryPorts }).ports = ports;
  return h;
}

function list(h: Harness, query: Partial<CommunityNotificationsQuery> = {}) {
  return listCommunityNotifications(h.ports, {
    viewer: VIEWER,
    query: { read: 'all', limit: 20, cursor: null, ...query },
    cursorCodec: createCommunityNotificationCursorCodec(HMAC_KEY),
  });
}

test('inbox serves reply notifications with actor, preview, href, and read state', async () => {
  const h = harness({
    rows: [row('n-1')],
    comments: new Map([['comment-n-1', comment('comment-n-1')]]),
    groups: [{ target: TARGET_IDENTITY, targetGeneration: COMMUNITY_STATIC_GENERATION, count: 1 }],
  });
  const inbox = await list(h);
  assert.equal(inbox.items.length, 1);
  const item = inbox.items[0]!;
  assert.equal(item.id, 'n-1');
  assert.equal(item.kind, 'comment_reply');
  assert.equal(item.preview, 'body-comment-n-1');
  assert.equal(item.read, false);
  assert.equal(inbox.unreadCount, 1);
  assert.equal(inbox.nextCursor, null);
});

test('inbox conceals the whole inbox when the account is gone or mismatched', async () => {
  for (const account of [null, { accountId: VIEWER.accountId, subjectId: 's-other', createdAt: NOW }]) {
    const h = harness({ account });
    await assert.rejects(() => list(h), (error: unknown) => {
      assert.ok(error instanceof CommunityNotificationError);
      assert.equal((error as CommunityNotificationError).code, 'resource_not_found');
      return true;
    });
  }
});

test('disabled community preference serves an empty inbox and zero unread', async () => {
  const h = harness({
    rows: [row('n-1')],
    comments: new Map([['comment-n-1', comment('comment-n-1')]]),
    preference: { enabled: false, revision: 2n, updatedAt: NOW },
  });
  const inbox = await list(h);
  assert.deepEqual(inbox, { items: [], nextCursor: null, unreadCount: 0 });
});

test('rows whose comment, target, or generation no longer resolves are concealed', async () => {
  const comments = new Map([
    ['comment-ok', comment('comment-ok')],
    ['comment-tomb', comment('comment-tomb', { state: 'deleted', body: null })],
    // 'comment-gone' intentionally absent → concealed.
    // 'comment-stale' pins a generation the target no longer reports.
    ['comment-stale', comment('comment-stale', { targetGeneration: 'gen-old' })],
  ]);
  const h = harness({
    rows: [
      row('n-ok', { subjectId: 'comment-ok', occurredAt: new Date(NOW.getTime() - 60_000) }),
      row('n-tomb', { subjectId: 'comment-tomb', occurredAt: new Date(NOW.getTime() - 120_000) }),
      row('n-gone', { subjectId: 'comment-gone', occurredAt: new Date(NOW.getTime() - 180_000) }),
      row('n-stale', { subjectId: 'comment-stale', occurredAt: new Date(NOW.getTime() - 240_000) }),
    ],
    comments,
    resolve: resolved('gen-2'), // everything is stale except...
  });
  // With a rotated generation every row conceals.
  const empty = await list(h);
  assert.equal(empty.items.length, 0);

  // Current generation: tombstone served with preview null; missing comment concealed.
  h.resolveResult = resolved(COMMUNITY_STATIC_GENERATION);
  const inbox = await list(h);
  assert.deepEqual(inbox.items.map((item) => item.id), ['n-ok', 'n-tomb']);
  const tomb = inbox.items.find((item) => item.id === 'n-tomb')!;
  assert.equal(tomb.preview, null);
});

test('unreadCount counts only servable rows across concealed groups', async () => {
  const comments = new Map([['comment-n-1', comment('comment-n-1')]]);
  const otherTarget = { kind: 'document' as const, id: 'doc-9', collectionId: null, seriesId: null };
  const h = harness({
    rows: [row('n-1')],
    comments,
    groups: [
      { target: TARGET_IDENTITY, targetGeneration: COMMUNITY_STATIC_GENERATION, count: 3 },
      { target: otherTarget, targetGeneration: COMMUNITY_STATIC_GENERATION, count: 7 },
    ],
    resolve: resolved(COMMUNITY_STATIC_GENERATION),
  });
  // The resolver returns the collection resolution for every target here;
  // generation for the other group still matches, so both count.
  const inbox = await list(h);
  assert.equal(inbox.unreadCount, 10);
});

test('countServableUnread drops groups with unresolved targets or stale generations', async () => {
  const groups: CommunityNotificationUnreadGroup[] = [
    { target: TARGET_IDENTITY, targetGeneration: 'gen-old', count: 5 },
    { target: { ...TARGET_IDENTITY, id: 'col-2' }, targetGeneration: COMMUNITY_STATIC_GENERATION, count: 4 },
  ];
  const ports = {
    notifications: { unreadGroups: async () => groups },
    targets: {
      resolve: async (query: { id: string }) =>
        query.id === 'col-2' ? null : resolved('gen-new'),
    },
  };
  assert.equal(await countServableUnread(ports as never, 'a-viewer'), 0);
});

test('cursor pagination binds viewer, filter, and limit', async () => {
  const comments = new Map(
    Array.from({ length: 5 }, (_, i) =>
      [`comment-n-${i}`, comment(`comment-n-${i}`)] as const),
  );
  const rows = Array.from({ length: 5 }, (_, i) => row(`n-${i}`, {
    subjectId: `comment-n-${i}`,
    occurredAt: new Date(NOW.getTime() - (i + 1) * 60_000),
  }));
  const h = harness({ rows, comments });
  const page1 = await list(h, { limit: 2 });
  assert.deepEqual(page1.items.map((item) => item.id), ['n-0', 'n-1']);
  assert.ok(page1.nextCursor !== null);

  const page2 = await list(h, { limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map((item) => item.id), ['n-2', 'n-3']);

  // A cursor minted for limit 2 must not verify under limit 5.
  await assert.rejects(
    () => list(h, { limit: 5, cursor: page1.nextCursor }),
    (error: unknown) => (error as CommunityNotificationError).code === 'invalid_cursor',
  );
  // …nor under the unread filter.
  await assert.rejects(
    () => list(h, { limit: 2, read: 'unread', cursor: page1.nextCursor }),
    (error: unknown) => (error as CommunityNotificationError).code === 'invalid_cursor',
  );
  // …nor under another viewer (different account minted for same viewer id
  // is rejected earlier by subject binding; test a foreign-viewer token).
  const foreignCodec = createCommunityNotificationCursorCodec(HMAC_KEY);
  const foreign = foreignCodec.sign({
    v: 1, ep: COMMUNITY_NOTIFICATIONS_ENDPOINT, vw: 'a-other', ft: 'all', lm: 2,
    pos: { t: page1.items[1]!.createdAt, i: 'n-1' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + COMMUNITY_NOTIFICATION_CURSOR_TTL_MS).toISOString(),
  });
  await assert.rejects(
    () => list(h, { limit: 2, cursor: foreign }),
    (error: unknown) => (error as CommunityNotificationError).code === 'invalid_cursor',
  );
});

test('read=unread filters served rows to unread only', async () => {
  const h = harness({
    rows: [
      row('n-1', { state: 'unread' }),
      row('n-2', { state: 'read', readAt: NOW, subjectId: 'comment-n-2' }),
    ],
    comments: new Map([
      ['comment-n-1', comment('comment-n-1')],
      ['comment-n-2', comment('comment-n-2')],
    ]),
  });
  const inbox = await list(h, { read: 'unread' });
  assert.deepEqual(inbox.items.map((item) => item.id), ['n-1']);
});

test('the serialized page byte budget cuts items and the cursor resumes at the first unconsumed row', async () => {
  // Inflate each item via the resolved target href so a page of six rows
  // (all under the item limit) overflows COMMUNITY_NOTIFICATION_PAGE_BYTE_BUDGET.
  const bigHref = `https://known.example/c/${'x'.repeat(20_000)}`;
  const comments = new Map(
    Array.from({ length: 6 }, (_, i) =>
      [`comment-n-${i}`, comment(`comment-n-${i}`)] as const),
  );
  const rows = Array.from({ length: 6 }, (_, i) => row(`n-${i}`, {
    subjectId: `comment-n-${i}`,
    occurredAt: new Date(NOW.getTime() - (i + 1) * 60_000),
  }));
  const h = harness({
    rows,
    comments,
    resolve: { ...resolved(), href: bigHref },
  });
  const page1 = await list(h, { limit: 6 });
  // The byte budget shortens the page below the requested item limit and
  // the full serialized page — including nextCursor and unreadCount —
  // never exceeds the budget.
  assert.ok(page1.items.length >= 1 && page1.items.length < 6);
  assert.ok(page1.nextCursor !== null);
  assert.ok(
    Buffer.byteLength(JSON.stringify(page1), 'utf8')
      <= COMMUNITY_NOTIFICATION_PAGE_BYTE_BUDGET,
  );

  const page2 = await list(h, { limit: 6, cursor: page1.nextCursor });
  // Continuation resumes exactly at the first unconsumed eligible row:
  // no item repeats and none is dropped.
  assert.deepEqual(
    [...page1.items, ...page2.items].map((item) => item.id),
    rows.map((entry) => entry.notificationId),
  );
  assert.equal(page2.nextCursor, null);
});

test('an oversized first item is still served so the inbox never truncates silently', async () => {
  // One servable row whose serialized view alone exceeds the byte budget
  // must be emitted anyway: an empty page carries no cursor (`resume`
  // would be null) and the remaining servable rows would silently vanish
  // behind nextCursor:null while unreadCount stayed positive.
  const hugeHref = `https://known.example/c/${'x'.repeat(70_000)}`;
  const comments = new Map([
    ['comment-n-1', comment('comment-n-1')],
    ['comment-n-2', comment('comment-n-2')],
  ]);
  const h = harness({
    rows: [
      row('n-1', { occurredAt: new Date(NOW.getTime() - 60_000) }),
      row('n-2', { subjectId: 'comment-n-2', occurredAt: new Date(NOW.getTime() - 120_000) }),
    ],
    comments,
    resolve: { ...resolved(), href: hugeHref },
  });
  const page1 = await list(h, { limit: 5 });
  assert.deepEqual(page1.items.map((item) => item.id), ['n-1']);
  assert.ok(page1.nextCursor !== null,
    'the oversized first item must still yield a resume cursor');
  const page2 = await list(h, { limit: 5, cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map((item) => item.id), ['n-2']);
  assert.equal(page2.nextCursor, null);
});

test('a concealed stretch stops at the scan budget and resumes without re-scanning it', async () => {
  // 900 dead rows (comments gone) ahead of 10 live ones: the default page
  // cannot fill its limit, so the request must stop at the scan budget
  // instead of walking the recipient's whole history in one call.
  const dead = Array.from({ length: 900 }, (_, index) => row(`n-${index + 1}`));
  const live = Array.from({ length: 10 }, (_, index) => row(`n-${901 + index}`));
  const comments = new Map(live.map((r) => [r.subjectId, comment(r.subjectId)] as const));
  const h = harness({ rows: [...dead, ...live], comments });
  let fetched = 0;
  const inner = h.ports.notifications.page;
  (h.ports.notifications as { page: typeof inner }).page = async (recipient, state, after, limit) => {
    const batch = await inner(recipient, state, after, limit);
    fetched += batch.length;
    return batch;
  };
  const first = await list(h);
  assert.equal(first.items.length, 0);
  assert.ok(first.nextCursor, 'the concealed stretch must yield a resume cursor');
  assert.ok(fetched <= 819,
    `page one must stop near the 800-row budget, fetched ${fetched}`);

  // The cursor resumes past the proven-dead stretch; the live tail arrives
  // on the second page and the stream ends at the history tail.
  const second = await list(h, { cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.id),
    live.map((r) => r.notificationId));
  assert.equal(second.nextCursor, null);
});

test('preference read serves the virtual default then the stored row', async () => {
  const h = harness();
  const virtual = await getCommunityNotificationPreference(h.ports, { viewer: VIEWER });
  assert.deepEqual(virtual, { enabled: true, revision: '1', updatedAt: NOW.toISOString() });
  h.preference = { enabled: false, revision: 3n, updatedAt: new Date('2026-10-06T00:00:00.000Z') };
  const stored = await getCommunityNotificationPreference(h.ports, { viewer: VIEWER });
  assert.deepEqual(stored, { enabled: false, revision: '3', updatedAt: '2026-10-06T00:00:00.000Z' });
});

test('the unread backlog resolves its targets in one batch, not one call per group', async () => {
  // `unreadGroups` has no LIMIT, so a reader with a large unread backlog hands
  // the page many groups. Resolving each one separately made the page's cost
  // proportional to the backlog; the batch form ties it to the number of target
  // kinds instead.
  const groups = Array.from({ length: 40 }, (_, index) => ({
    target: { kind: 'collection' as const, id: `group-${index}`, collectionId: null, seriesId: null },
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    count: 1,
  }));
  const batched = harness({
    groups,
    rows: groups.map((_group, index) => row(`n-${index}`, {
      occurredAt: new Date(NOW.getTime() - index * 1_000),
    })),
  });
  await list(batched);
  assert.equal(batched.resolveCalls, 0, 'the batch form must be preferred when the host offers it');
  assert.equal(batched.resolveManyCalls, 1, 'one batch for the whole page');
  assert.deepEqual(batched.resolveManySizes, [groups.length],
    'every distinct group target must be in that batch');
});

test('a host without the batch form still resolves every group target', async () => {
  // The fallback has to stay correct, not fast: one call per distinct target.
  const groups = Array.from({ length: 5 }, (_, index) => ({
    target: { kind: 'collection' as const, id: `group-${index}`, collectionId: null, seriesId: null },
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    count: 1,
  }));
  const perTarget = harness({
    groups,
    batchResolve: false,
    rows: groups.map((_group, index) => row(`n-${index}`, {
      occurredAt: new Date(NOW.getTime() - index * 1_000),
    })),
  });
  await list(perTarget);
  assert.equal(perTarget.resolveCalls, groups.length,
    'the fallback resolves each distinct target exactly once');
  assert.equal(perTarget.resolveManyCalls, 0);
});

test('a repeated group target is resolved once', async () => {
  const shared = { kind: 'collection' as const, id: 'group-shared', collectionId: null, seriesId: null };
  const groups = [
    { target: shared, targetGeneration: COMMUNITY_STATIC_GENERATION, count: 2 },
    { target: { ...shared }, targetGeneration: COMMUNITY_STATIC_GENERATION, count: 3 },
  ];
  const h = harness({ groups, rows: [row('n-1')] });
  await list(h);
  assert.deepEqual(h.resolveManySizes, [1], 'a repeated target must not inflate the batch');
});
