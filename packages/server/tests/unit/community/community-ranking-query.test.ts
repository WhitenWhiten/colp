import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_RANKING_DEFAULT_LIMIT,
  COMMUNITY_RANKING_ENDPOINT,
  COMMUNITY_RANKING_MAX_LIMIT,
  COMMUNITY_RANKING_PAGE_BYTE_BUDGET,
  CommunityRankingError,
  createCommunityRankingCursorCodec,
  listCommunityRanking,
  parseCommunityRankingQuery,
  type CommunityRankedEntry,
  type CommunityRankingQueryPorts,
  type CommunityRankingSnapshot,
} from '../../../src/modules/community/index.js';
import {
  COMMUNITY_STATIC_GENERATION,
  type CommunityTarget,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';

const NOW = new Date('2026-10-02T00:00:00.000Z');
const KEY = Buffer.alloc(32, 7);
const ANONYMOUS = { accountId: null, subjectId: null } as const;
const VIEWER = { accountId: 'account-1', subjectId: 'subject-1' } as const;

function target(kind: CommunityTarget['kind'], id: string, extra: Partial<CommunityTarget> = {}): CommunityTarget {
  return {
    kind, id,
    collectionId: extra.collectionId ?? null,
    seriesId: extra.seriesId ?? null,
    generation: extra.generation ?? COMMUNITY_STATIC_GENERATION,
  };
}

function entry(position: number, over: Partial<CommunityRankedEntry> = {}): CommunityRankedEntry {
  return {
    position,
    target: over.target ?? target('collection', `col-${position}`),
    title: over.title ?? `Entry ${position}`,
    href: over.href ?? `/c/entry-${position}`,
    tags: over.tags ?? ['design'],
    language: over.language ?? 'en',
    up: over.up ?? 10,
    down: over.down ?? 1,
    firstVoteAt: over.firstVoteAt === undefined ? new Date(NOW.getTime() - 3_600_000) : over.firstVoteAt,
    hot: over.hot ?? (100 - position),
  };
}

function snapshot(itemCount: number, over: Partial<CommunityRankingSnapshot> = {}): CommunityRankingSnapshot {
  return {
    snapshotId: over.snapshotId ?? '42',
    scoreVersion: over.scoreVersion ?? 'hot-v1',
    createdAt: over.createdAt ?? NOW,
    itemCount,
  };
}

function ports(input: {
  entries?: readonly CommunityRankedEntry[];
  snapshot?: CommunityRankingSnapshot | null;
  snapshotsById?: ReadonlyMap<string, CommunityRankingSnapshot | null>;
  resolve?: (query: {
    kind: string;
    id: string;
    collectionId?: string | null;
    seriesId?: string | null;
  }) => Promise<ResolvedCommunityTarget | null>;
  now?: Date;
}): CommunityRankingQueryPorts {
  const rows = input.entries ?? [];
  return {
    rankings: {
      latestSnapshot: async () => input.snapshot === undefined ? snapshot(rows.length) : input.snapshot,
      findSnapshot: async (id) => input.snapshotsById?.get(id) ?? null,
      scanEntries: async (_id, afterPosition, limit) =>
        rows.filter((row) => row.position > afterPosition).slice(0, limit),
    },
    targets: {
      resolve: input.resolve ?? (async (query) => ({
        target: target(query.kind as CommunityTarget['kind'], query.id,
          { collectionId: query.collectionId ?? null, seriesId: query.seriesId ?? null }),
        ownerSubjectId: 'subject-owner',
        title: `Resolved ${query.id}`,
        href: `/resolved/${query.id}`,
      })),
    },
    clock: { now: async () => input.now ?? NOW },
  };
}

function codec() {
  return createCommunityRankingCursorCodec(KEY);
}

/* ——— parseCommunityRankingQuery ——— */

test('parse applies defaults and normalizes text, tag and language', () => {
  const query = parseCommunityRankingQuery({});
  assert.deepEqual(query, {
    kind: null, collectionId: null, q: null, tag: null, language: null,
    limit: COMMUNITY_RANKING_DEFAULT_LIMIT, cursor: null,
  });
  const normalized = parseCommunityRankingQuery({
    kind: 'bookmark', collectionId: 'col-1', q: '  Naïve  ', tag: ' Design ',
    language: 'EN-us', limit: '5', cursor: 'abc.DEF-123_~',
  });
  assert.equal(normalized.kind, 'bookmark');
  assert.equal(normalized.collectionId, 'col-1');
  assert.equal(normalized.q, 'Naïve');
  assert.equal(normalized.tag, 'Design');
  assert.equal(normalized.language, 'en-US');
  assert.equal(normalized.limit, 5);
});

test('parse rejects unknown keys, bad kinds, malformed limits and query misuse', () => {
  for (const raw of [
    { sort: 'hot' },
    { kind: 'digest' },
    { collectionId: 'col-1' },
    { kind: 'collection', collectionId: 'col-1' },
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { limit: 'abc' },
    { limit: '-3' },
    { q: '   ' },
    { language: 'not a locale!!' },
  ]) {
    assert.throws(() => parseCommunityRankingQuery(raw), (error: unknown) =>
      error instanceof CommunityRankingError && error.code === 'invalid_query',
    JSON.stringify(raw));
  }
  assert.equal(COMMUNITY_RANKING_MAX_LIMIT, 100);
});

test('parse maps malformed cursor text to invalid_cursor, not invalid_query', () => {
  assert.throws(() => parseCommunityRankingQuery({ cursor: 'not a cursor!!' }),
    (error: unknown) => error instanceof CommunityRankingError && error.code === 'invalid_cursor');
  assert.throws(() => parseCommunityRankingQuery({ cursor: 42 as unknown as string }),
    (error: unknown) => error instanceof CommunityRankingError && error.code === 'invalid_cursor');
});

/* ——— listCommunityRanking ——— */

test('no snapshot returns an empty hot-v1 page with an explicit null cursor', async () => {
  const page = await listCommunityRanking(ports({ snapshot: null }), {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({}),
    cursorCodec: codec(),
  });
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
  assert.equal(page.scoreVersion, 'hot-v1');
  assert.equal(page.asOf, NOW.toISOString());
});

test('a foreign score-version snapshot is never served as hot-v1', async () => {
  const page = await listCommunityRanking(
    ports({ entries: [entry(1)], snapshot: snapshot(1, { scoreVersion: 'hot-v0' }) }),
    { viewer: ANONYMOUS, query: parseCommunityRankingQuery({}), cursorCodec: codec() },
  );
  assert.equal(page.items.length, 0);
  assert.equal(page.nextCursor, null);
  assert.equal(page.scoreVersion, 'hot-v1');
});

test('items arrive in snapshot order with resolved visibility and null firstVoteAt', async () => {
  const page = await listCommunityRanking(ports({
    entries: [
      entry(1, { up: 12, down: 2, hot: 9.5 }),
      entry(2, { up: 0, down: 0, hot: 0, firstVoteAt: null }),
    ],
  }), { viewer: VIEWER, query: parseCommunityRankingQuery({}), cursorCodec: codec() });
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0]!.title, 'Resolved col-1');
  assert.equal(page.items[0]!.href, '/resolved/col-1');
  assert.equal(page.items[0]!.up, 12);
  assert.equal(page.items[0]!.hot, 9.5);
  assert.equal(page.items[0]!.firstVoteAt, new Date(NOW.getTime() - 3_600_000).toISOString());
  assert.equal(page.items[1]!.firstVoteAt, null);
  assert.equal(page.nextCursor, null);
});

test('cursor round-trip resumes mid-batch and binds viewer, filters and limit', async () => {
  const store = ports({ entries: [entry(1), entry(2), entry(3), entry(4)] });
  const cursorCodec = codec();
  const first = await listCommunityRanking(store, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({ limit: '3' }),
    cursorCodec,
  });
  assert.equal(first.items.length, 3);
  assert.ok(first.nextCursor, 'a fourth entry must produce a next cursor');
  const second = await listCommunityRanking({
    ...store,
    rankings: { ...store.rankings, findSnapshot: async () => snapshot(4) },
  }, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({ limit: '3', cursor: first.nextCursor! }),
    cursorCodec,
  });
  assert.deepEqual(second.items.map((item) => item.target.id), ['col-4']);
  assert.equal(second.nextCursor, null);

  // Viewer binding: the same cursor under another account is invalid.
  await assert.rejects(() => listCommunityRanking(store, {
    viewer: { accountId: 'account-2', subjectId: 'subject-2' },
    query: parseCommunityRankingQuery({ limit: '3', cursor: first.nextCursor! }),
    cursorCodec,
  }), (error: unknown) => error instanceof CommunityRankingError && error.code === 'invalid_cursor');
  // Filter binding: a changed kind makes the cursor invalid.
  await assert.rejects(() => listCommunityRanking(store, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({ limit: '3', kind: 'bookmark', cursor: first.nextCursor! }),
    cursorCodec,
  }), (error: unknown) => error instanceof CommunityRankingError && error.code === 'invalid_cursor');
  // Limit binding: a changed page size makes the cursor invalid.
  await assert.rejects(() => listCommunityRanking(store, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({ limit: '4', cursor: first.nextCursor! }),
    cursorCodec,
  }), (error: unknown) => error instanceof CommunityRankingError && error.code === 'invalid_cursor');
});

test('a tampered cursor is invalid_cursor; a pruned snapshot is snapshot_expired', async () => {
  const store = ports({ entries: [entry(1), entry(2)] });
  const cursorCodec = codec();
  const first = await listCommunityRanking(store, {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({ limit: '1' }),
    cursorCodec,
  });
  assert.ok(first.nextCursor);

  const tampered = `${first.nextCursor!.slice(0, -2)}zz`;
  await assert.rejects(() => listCommunityRanking(store, {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({ limit: '1', cursor: tampered }),
    cursorCodec,
  }), (error: unknown) => error instanceof CommunityRankingError && error.code === 'invalid_cursor');

  const expired = ports({
    entries: [entry(1), entry(2)],
    snapshotsById: new Map([['42', null]]),
  });
  await assert.rejects(() => listCommunityRanking(expired, {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({ limit: '1', cursor: first.nextCursor! }),
    cursorCodec,
  }), (error: unknown) => error instanceof CommunityRankingError && error.code === 'snapshot_expired');
});

test('an expired cursor TTL is invalid_cursor', async () => {
  const store = ports({ entries: [entry(1), entry(2)] });
  const cursorCodec = codec();
  const first = await listCommunityRanking(store, {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({ limit: '1' }),
    cursorCodec,
  });
  await assert.rejects(() => listCommunityRanking(
    ports({ entries: [entry(1), entry(2)], now: new Date(NOW.getTime() + 901_000) }),
    {
      viewer: ANONYMOUS,
      query: parseCommunityRankingQuery({ limit: '1', cursor: first.nextCursor! }),
      cursorCodec,
    },
  ), (error: unknown) => error instanceof CommunityRankingError && error.code === 'invalid_cursor');
});

test('filters precede page selection and concealed targets never emit', async () => {
  const entries = [
    entry(1, { target: target('collection', 'a'), title: 'Alpha guide', tags: ['design'] }),
    entry(2, { target: target('collection', 'b'), title: 'Beta notes', tags: ['ml'] }),
    entry(3, { target: target('bookmark', 'c', { collectionId: 'a' }), title: 'Alpha bookmark', tags: [] }),
    entry(4, { target: target('digest_series', 'd'), title: 'Alpha digest', language: 'fr' }),
  ];
  const visible = ports({ entries });
  const cursorCodec = codec();

  const kindPage = await listCommunityRanking(visible, {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({ kind: 'collection' }),
    cursorCodec,
  });
  assert.deepEqual(kindPage.items.map((item) => item.target.kind), ['collection', 'collection']);

  const qPage = await listCommunityRanking(visible, {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({ q: 'alpha' }),
    cursorCodec,
  });
  assert.equal(qPage.items.length, 3);

  const tagPage = await listCommunityRanking(visible, {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({ tag: 'ml' }),
    cursorCodec,
  });
  assert.deepEqual(tagPage.items.map((item) => item.target.id), ['b']);

  const languagePage = await listCommunityRanking(visible, {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({ language: 'FR' }),
    cursorCodec,
  });
  assert.deepEqual(languagePage.items.map((item) => item.target.id), ['d']);

  const concealed = ports({
    entries,
    resolve: async (query) => query.id === 'a' ? null : ({
      target: target(query.kind as CommunityTarget['kind'], query.id,
        { collectionId: query.collectionId ?? null, seriesId: query.seriesId ?? null }),
      ownerSubjectId: 's', title: query.id, href: `/${query.id}`,
    }),
  });
  const page = await listCommunityRanking(concealed, {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({}),
    cursorCodec,
  });
  assert.deepEqual(page.items.map((item) => item.target.id), ['b', 'c', 'd']);
});

test('collectionId filter applies only to bookmark rows', async () => {
  const entries = [
    entry(1, { target: target('bookmark', 'n1', { collectionId: 'owner-col' }) }),
    entry(2, { target: target('bookmark', 'n2', { collectionId: 'other-col' }) }),
  ];
  const page = await listCommunityRanking(ports({ entries }), {
    viewer: ANONYMOUS,
    query: parseCommunityRankingQuery({ kind: 'bookmark', collectionId: 'owner-col' }),
    cursorCodec: codec(),
  });
  assert.deepEqual(page.items.map((item) => item.target.id), ['n1']);
});

test('the byte budget caps the serialized page including a real large cursor', async () => {
  // q at its 256-char parser bound makes the signed continuation cursor a
  // realistic >512-byte token; ~1.9KB resolved items push 50 entries past
  // the 64KiB page budget before the item limit. Two pages must cover the
  // snapshot — and both must stay under the cap.
  const q = 'q'.repeat(256);
  const fatTitle = `lead ${q} ${'T'.repeat(1_400)}`;
  const entries = Array.from({ length: 50 }, (_, index) =>
    entry(index + 1, { title: fatTitle }));
  const fixture = ports({
    entries,
    resolve: async (query) => ({
      target: target(query.kind as CommunityTarget['kind'], query.id,
        { collectionId: query.collectionId ?? null, seriesId: query.seriesId ?? null }),
      ownerSubjectId: 's', title: fatTitle, href: `/resolved/${query.id}`,
    }),
  });
  const cursorCodec = codec();
  const first = await listCommunityRanking(fixture, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({ limit: '100', q }),
    cursorCodec,
  });
  const serialized = Buffer.byteLength(JSON.stringify(first), 'utf8');
  assert.ok(serialized <= COMMUNITY_RANKING_PAGE_BYTE_BUDGET,
    `page ${serialized} exceeds ${COMMUNITY_RANKING_PAGE_BYTE_BUDGET}`);
  assert.ok(first.items.length > 0);
  assert.ok(first.items.length < 50,
    `byte budget should cut before the item limit, got ${first.items.length}`);
  assert.ok(first.nextCursor !== null);
  assert.ok(first.nextCursor.length > 512,
    `cursor ${first.nextCursor.length} chars should exceed the old 512 reserve`);
  // The truncated page resumes at the first unconsumed candidate.
  const rest = await listCommunityRanking({
    ...fixture,
    rankings: { ...fixture.rankings, findSnapshot: async () => snapshot(50) },
  }, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({ limit: '100', q, cursor: first.nextCursor }),
    cursorCodec,
  });
  assert.equal(rest.items[0]!.target.id, `col-${first.items.length + 1}`);
  assert.equal(rest.items.length, 50 - first.items.length);
  assert.equal(rest.nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify(rest), 'utf8') <= COMMUNITY_RANKING_PAGE_BYTE_BUDGET);
});

test('an oversized first item is still emitted so the stream cannot livelock', async () => {
  // A single resolved item larger than the whole page byte budget must be
  // emitted anyway: an empty page would resume at the same position and
  // hand the client an identical empty page forever.
  const fatTitle = `lead ${'T'.repeat(70_000)}`;
  const fixture = ports({
    entries: [entry(1), entry(2)],
    resolve: async (query) => ({
      target: target(query.kind as CommunityTarget['kind'], query.id,
        { collectionId: query.collectionId ?? null, seriesId: query.seriesId ?? null }),
      ownerSubjectId: 's',
      title: query.id === 'col-1' ? fatTitle : `Entry ${query.id}`,
      href: `/resolved/${query.id}`,
    }),
  });
  const cursorCodec = codec();
  const first = await listCommunityRanking(fixture, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({ limit: '10' }),
    cursorCodec,
  });
  assert.deepEqual(first.items.map((item) => item.target.id), ['col-1']);
  assert.ok(first.nextCursor !== null,
    'the oversized first item must still yield a resume cursor');
  const rest = await listCommunityRanking({
    ...fixture,
    rankings: { ...fixture.rankings, findSnapshot: async () => snapshot(2) },
  }, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({ limit: '10', cursor: first.nextCursor }),
    cursorCodec,
  });
  assert.deepEqual(rest.items.map((item) => item.target.id), ['col-2']);
  assert.equal(rest.nextCursor, null);
});

test('a concealed stretch stops at the scan budget and resumes without re-scanning it', async () => {
  // 600 concealed entries ahead of 10 live ones: the default page cannot
  // fill its limit, so the request must stop at the scan budget instead of
  // resolving the whole snapshot in one call.
  const dead = Array.from({ length: 600 }, (_, index) =>
    entry(index + 1, { target: target('collection', `dead-${index + 1}`) }));
  const live = Array.from({ length: 10 }, (_, index) =>
    entry(601 + index, { target: target('collection', `live-${index + 1}`) }));
  let resolveCalls = 0;
  const store = ports({
    entries: [...dead, ...live],
    resolve: async (query) => {
      resolveCalls += 1;
      if (query.id.startsWith('dead-')) return null;
      return {
        target: target(query.kind as CommunityTarget['kind'], query.id,
          { collectionId: query.collectionId ?? null, seriesId: query.seriesId ?? null }),
        ownerSubjectId: 's', title: query.id, href: `/${query.id}`,
      };
    },
  });
  const cursorCodec = codec();
  const first = await listCommunityRanking(store, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({}),
    cursorCodec,
  });
  assert.equal(first.items.length, 0);
  assert.ok(first.nextCursor, 'the concealed stretch must yield a resume cursor');
  assert.equal(resolveCalls, 512, 'page one stops at the scan budget');

  // The cursor resumes past the proven-dead stretch; the live tail arrives
  // on the second page and the stream ends at the snapshot tail.
  const second = await listCommunityRanking({
    ...store,
    rankings: { ...store.rankings, findSnapshot: async () => snapshot(610) },
  }, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({ cursor: first.nextCursor }),
    cursorCodec,
  });
  assert.deepEqual(second.items.map((item) => item.target.id),
    live.map((_, index) => `live-${index + 1}`));
  assert.equal(second.nextCursor, null);
});

test('the endpoint constant and page budget stay contract-frozen', () => {
  assert.equal(COMMUNITY_RANKING_ENDPOINT, 'community.ranking');
  assert.equal(COMMUNITY_RANKING_PAGE_BYTE_BUDGET, 65_536);
});

test('a host that offers batch resolution costs one call per scan batch', async () => {
  // The single-target port costs one round trip per candidate (see the 512
  // assertion above). With `resolveMany` the same page resolves each scan batch
  // at once, so the number of resolution calls tracks the number of batches.
  const dead = Array.from({ length: 600 }, (_, index) =>
    entry(index + 1, { target: target('collection', `dead-${index + 1}`) }));
  const live = Array.from({ length: 10 }, (_, index) =>
    entry(601 + index, { target: target('collection', `live-${index + 1}`) }));
  const batchCalls: number[] = [];
  let singleCalls = 0;
  const base = ports({ entries: [...dead, ...live] });
  const store: CommunityRankingQueryPorts = {
    ...base,
    targets: {
      async resolve(query) {
        singleCalls += 1;
        return {
          target: target(query.kind as CommunityTarget['kind'], query.id,
            { collectionId: query.collectionId ?? null, seriesId: query.seriesId ?? null }),
          ownerSubjectId: 's', title: query.id, href: `/${query.id}`,
        };
      },
      async resolveMany(queries) {
        batchCalls.push(queries.length);
        return queries.map((query) => (query.id.startsWith('dead-') ? null : {
          target: target(query.kind as CommunityTarget['kind'], query.id,
            { collectionId: query.collectionId ?? null, seriesId: query.seriesId ?? null }),
          ownerSubjectId: 's', title: query.id, href: `/${query.id}`,
        }));
      },
    },
  };
  const first = await listCommunityRanking(store, {
    viewer: VIEWER,
    query: parseCommunityRankingQuery({}),
    cursorCodec: codec(),
  });
  assert.equal(first.items.length, 0);
  assert.ok(first.nextCursor, 'the concealed stretch must still yield a resume cursor');
  assert.equal(singleCalls, 0, 'the batch path must be preferred when the host provides it');
  // 600 concealed entries over SCAN_BATCH-sized batches, then the live tail.
  assert.ok(batchCalls.length > 0);
  assert.ok(batchCalls.length <= 11, `expected one call per scan batch, got ${batchCalls.length}`);
  // The scan budget caps a page at MAX_SCAN_ENTRIES candidates, and the batch
  // path resolves exactly those — one call per batch instead of one per
  // candidate, which is the 512 the single-target test measures.
  assert.equal(batchCalls.reduce((sum, size) => sum + size, 0), 512,
    'every scanned candidate must be resolved exactly once');
});
