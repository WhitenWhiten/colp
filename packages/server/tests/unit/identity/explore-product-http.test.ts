/**
 * Explore product HTTP characterization (ORG-P0-a / EX-01).
 *
 * Pins the transport contract: cursor/limit/filter/sort, injected Explore page
 * port (limit+1), creator DTO, and no readDb dependency.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import type { ExploreCreatorsQueryPort } from '../../../src/modules/identity/index.js';
import type {
  ExplorePageReadPort,
  ExplorePageReadRequest,
  ExplorePageRecord,
  ExplorePageSort,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example',
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});

type ExploreAppDeps = Parameters<typeof buildApiApp>[0];
type ExploreDepsIncludeReadDb = 'readDb' extends keyof ExploreAppDeps ? true : false;
const exploreDepsIncludeReadDb: ExploreDepsIncludeReadDb = false;
assert.equal(exploreDepsIncludeReadDb, false);

function exploreRow(
  id: string,
  ownerSubjectId = `owner-${id}`,
  extras: Partial<ExplorePageRecord> = {},
): ExplorePageRecord {
  return Object.freeze({
    id,
    ownerSubjectId,
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    kind: 'bookmarks',
    visibility: 'public',
    publicationSlug: id,
    tags: Object.freeze(['tag']),
    nodeCount: extras.nodeCount ?? 3,
    orderingNodeCount: extras.orderingNodeCount ?? extras.nodeCount ?? 3,
    viewCount: extras.viewCount ?? 0,
    updatedAt: extras.updatedAt ?? '2026-07-24T00:00:00.000Z',
    orderingUpdatedAtMicros: extras.orderingUpdatedAtMicros
      ?? (id === 'public-one' ? '1784851200000001' : '1784851200000000'),
  });
}

function compareExplore(left: ExplorePageRecord, right: ExplorePageRecord, sort: ExplorePageSort): number {
  if (sort === 'popular' && left.viewCount !== right.viewCount) return right.viewCount - left.viewCount;
  if (sort === 'links' && left.orderingNodeCount !== right.orderingNodeCount) {
    return right.orderingNodeCount - left.orderingNodeCount;
  }
  if (left.orderingUpdatedAtMicros !== right.orderingUpdatedAtMicros) {
    return left.orderingUpdatedAtMicros < right.orderingUpdatedAtMicros ? 1 : -1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function afterIndex(rows: readonly ExplorePageRecord[], request: ExplorePageReadRequest): number {
  if (!request.after) return 0;
  const index = rows.findIndex((row) => {
    if (row.id !== request.after?.id || row.orderingUpdatedAtMicros !== request.after.micros) return false;
    if (request.sort === 'popular') return row.viewCount === request.after.viewCount;
    if (request.sort === 'links') return row.orderingNodeCount === request.after.nodeCount;
    return true;
  });
  return index >= 0 ? index + 1 : rows.length;
}

function explorePage(
  rows: readonly ExplorePageRecord[],
  capture: { last?: ExplorePageReadRequest } = {},
): ExplorePageReadPort {
  return {
    async loadPage(request) {
      capture.last = request;
      const sorted = [...rows].sort((left, right) => compareExplore(left, right, request.sort));
      const start = afterIndex(sorted, request);
      return Object.freeze(sorted.slice(start, start + request.limit + 1));
    },
  };
}

function emptyCreators(): ExploreCreatorsQueryPort {
  return {
    async findByOwnerSubjectIds() {
      return new Map();
    },
  };
}

function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function memoryExploreLimiter() {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000,
    accountMaxRequests: 10_000,
    windowMs: 60_000,
  });
}

function buildExploreApp(deps: {
  readonly explorePageQuery: ExplorePageReadPort;
  readonly exploreCreatorsQuery?: ExploreCreatorsQueryPort;
  readonly explorePublicMarks?: {
    findPublicMarksForCollections(
      collectionIds: readonly string[],
    ): Promise<ReadonlyMap<string, string>>;
  };
}) {
  const app = buildApiApp({
    config,
    exploreDirectoryRateLimiter: memoryExploreLimiter(),
    ...deps,
  });
  apps.push(app);
  return app;
}

test('Explore with an empty creator port maps each item to a subject-fallback creator', async () => {
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one', 'subject-owner')]),
    exploreCreatorsQuery: emptyCreators(),
  });
  const response = await app.inject({ method: 'GET', url: '/api/v1/explore/collections' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'public, max-age=60');
  const body = response.json() as {
    items: Array<{
      id: string;
      title: string;
      publicationSlug: string;
      viewCount: number;
      creators: Array<{ id: string; name: string; handle: string | null; avatar: string | null }>;
    }>;
    nextCursor: string | null;
  };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]?.id, 'public-one');
  assert.equal(body.items[0]?.title, 'Title public-one');
  assert.equal(body.items[0]?.publicationSlug, 'public-one');
  assert.equal(body.items[0]?.viewCount, 0);
  assert.equal('viewCount' in (body.items[0] ?? {}), true);
  assert.equal('followers' in (body.items[0] ?? {}), false);
  assert.deepEqual(body.items[0]?.creators, [{
    id: 'subject:subject-owner',
    name: 'Unknown',
    handle: null,
    avatar: null,
  }]);
  assert.equal(body.nextCursor, null);
});

test('Explore maps injected creator facts onto ExploreCollectionItem.creators', async () => {
  const captured: { subjects?: readonly string[] } = {};
  const creators: ExploreCreatorsQueryPort = {
    async findByOwnerSubjectIds(ownerSubjectIds) {
      captured.subjects = ownerSubjectIds;
      return new Map([['subject-owner', {
        ownerSubjectId: 'subject-owner',
        accountId: 'acct-owner',
        displayName: 'Ada',
        handle: 'ada',
        avatarUrl: 'https://cdn.example.test/ada.png',
      }]]);
    },
  };
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one', 'subject-owner')]),
    exploreCreatorsQuery: creators,
  });
  const response = await app.inject({ method: 'GET', url: '/api/v1/explore/collections' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(captured.subjects, ['subject-owner']);
  const body = response.json() as {
    items: Array<{ creators: Array<{ id: string; name: string; handle: string | null; avatar: string | null }> }>;
  };
  assert.deepEqual(body.items[0]?.creators, [{
    id: 'account:acct-owner',
    name: 'Ada',
    handle: 'ada',
    avatar: 'https://cdn.example.test/ada.png',
  }]);
});

test('Explore attaches the public collection tldr as curatorNote and defaults unmatched rows to null', async () => {
  const captured: { collectionIds?: readonly string[] } = {};
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one'), exploreRow('public-two')]),
    exploreCreatorsQuery: emptyCreators(),
    explorePublicMarks: {
      async findPublicMarksForCollections(collectionIds) {
        captured.collectionIds = collectionIds;
        // Port contract: only visibility=public collection tldr rows surface;
        // private/protected/unlisted marks never reach the route.
        return new Map([['public-one', 'Curated pick of the week']]);
      },
    },
  });
  const response = await app.inject({ method: 'GET', url: '/api/v1/explore/collections' });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    items: Array<{ id: string; curatorNote: string | null }>;
  };
  assert.deepEqual(captured.collectionIds, ['public-one', 'public-two']);
  assert.deepEqual(body.items.map((item) => item.curatorNote), ['Curated pick of the week', null]);
});

test('Explore curatorNote defaults to null without a publicMarks port', async () => {
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one')]),
    exploreCreatorsQuery: emptyCreators(),
  });
  const response = await app.inject({ method: 'GET', url: '/api/v1/explore/collections' });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    items: Array<{ id: string; curatorNote: string | null }>;
  };
  assert.equal(body.items[0]?.curatorNote, null);
});

test('Explore rejects a malformed cursor with invalid_cursor', async () => {
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one')]),
    exploreCreatorsQuery: emptyCreators(),
  });
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/explore/collections?cursor=not-a-cursor',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_cursor');
});

test('Explore rejects a non-integer or out-of-range limit with invalid_query', async () => {
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one')]),
    exploreCreatorsQuery: emptyCreators(),
  });
  for (const limit of ['0', '101', '1.5', 'abc']) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/explore/collections?limit=${limit}`,
    });
    assert.equal(response.statusCode, 400, limit);
    assert.equal(response.json().error.code, 'invalid_query', limit);
  }
});

test('Explore rejects an unknown sort with invalid_query', async () => {
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one')]),
    exploreCreatorsQuery: emptyCreators(),
  });
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/explore/collections?sort=followers',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_query');
});

test('Explore forwards q and tag filters, default sort updated, and default limit 24', async () => {
  const capture: { last?: ExplorePageReadRequest } = {};
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one')], capture),
    exploreCreatorsQuery: emptyCreators(),
  });
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/explore/collections?q=rust&tag=systems',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(capture.last?.limit, 24);
  assert.equal(capture.last?.sort, 'updated');
  assert.equal(capture.last?.filter.q, 'rust');
  assert.equal(capture.last?.filter.tag, 'systems');
  assert.equal(capture.last?.after, undefined);
});

test('Explore emits nextCursor on a full page and continues from it', async () => {
  const rows = [exploreRow('public-one'), exploreRow('public-two')];
  const capture: { last?: ExplorePageReadRequest } = {};
  const app = buildExploreApp({
    explorePageQuery: explorePage(rows, capture),
    exploreCreatorsQuery: emptyCreators(),
  });
  const first = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=1' });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as { items: Array<{ id: string }>; nextCursor: string | null };
  assert.equal(firstBody.items[0]?.id, 'public-one');
  assert.equal(typeof firstBody.nextCursor, 'string');
  assert.ok(firstBody.nextCursor && firstBody.nextCursor.length > 0);
  const firstCursor = decodeCursor(firstBody.nextCursor);
  assert.equal(firstCursor.sort, 'updated');
  assert.equal(firstCursor.id, 'public-one');

  const second = await app.inject({
    method: 'GET',
    url: `/api/v1/explore/collections?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as { items: Array<{ id: string }>; nextCursor: string | null };
  assert.equal(secondBody.items[0]?.id, 'public-two');
  assert.equal(capture.last?.after?.id, 'public-one');
  assert.equal(capture.last?.after?.micros, '1784851200000001');
  assert.equal(capture.last?.sort, 'updated');
});

test('Explore sort=popular paginates two pages and forwards viewCount from the first cursor', async () => {
  const rows = [
    exploreRow('alpha', 'owner-a', { viewCount: 4, orderingUpdatedAtMicros: '100', nodeCount: 1 }),
    exploreRow('beta', 'owner-b', { viewCount: 9, orderingUpdatedAtMicros: '200', nodeCount: 2 }),
    exploreRow('gamma', 'owner-c', { viewCount: 1, orderingUpdatedAtMicros: '300', nodeCount: 3 }),
  ];
  const capture: { last?: ExplorePageReadRequest } = {};
  const app = buildExploreApp({
    explorePageQuery: explorePage(rows, capture),
    exploreCreatorsQuery: emptyCreators(),
  });
  const first = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=1&sort=popular' });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as {
    items: Array<{ id: string; viewCount: number }>;
    nextCursor: string | null;
  };
  assert.equal(firstBody.items.length, 1);
  assert.equal(firstBody.items[0]?.id, 'beta');
  assert.equal(firstBody.items[0]?.viewCount, 9);
  assert.ok(firstBody.nextCursor);
  const firstCursor = decodeCursor(firstBody.nextCursor);
  assert.equal(firstCursor.sort, 'popular');
  assert.equal(firstCursor.viewCount, 9);
  assert.equal(firstCursor.id, 'beta');

  const second = await app.inject({
    method: 'GET',
    url: `/api/v1/explore/collections?limit=1&sort=popular&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as {
    items: Array<{ id: string; viewCount: number }>;
    nextCursor: string | null;
  };
  assert.equal(secondBody.items[0]?.id, 'alpha');
  assert.equal(secondBody.items[0]?.viewCount, 4);
  assert.equal(capture.last?.sort, 'popular');
  assert.equal(capture.last?.after?.viewCount, 9);
  assert.equal(capture.last?.after?.id, 'beta');
  assert.ok(secondBody.nextCursor);
});

test('Explore links cursor uses orderingNodeCount and does not page by the displayed count', async () => {
  const rows = [
    exploreRow('many', 'owner-a', { orderingNodeCount: 5, nodeCount: 1, orderingUpdatedAtMicros: '100' }),
    exploreRow('few', 'owner-b', { orderingNodeCount: 4, nodeCount: 9, orderingUpdatedAtMicros: '200' }),
  ];
  const capture: { last?: ExplorePageReadRequest } = {};
  const app = buildExploreApp({
    explorePageQuery: explorePage(rows, capture),
    exploreCreatorsQuery: emptyCreators(),
  });
  const first = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=1&sort=links' });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as {
    items: Array<{ id: string; nodeCount: number }>;
    nextCursor: string | null;
  };
  assert.equal(firstBody.items[0]?.id, 'many');
  assert.equal(firstBody.items[0]?.nodeCount, 1);
  const cursor = decodeCursor(firstBody.nextCursor ?? '');
  assert.equal(cursor.nodeCount, 5);
  const second = await app.inject({
    method: 'GET',
    url: `/api/v1/explore/collections?limit=1&sort=links&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
  });
  assert.equal(second.statusCode, 200);
  assert.equal((second.json() as { items: Array<{ id: string }> }).items[0]?.id, 'few');
  assert.equal(capture.last?.after?.nodeCount, 5);
});

test('Explore rejects an old micros/id cursor with sort=popular as invalid_cursor', async () => {
  const oldCursor = Buffer.from(JSON.stringify({
    micros: '1784851200000000',
    id: 'public-one',
  }), 'utf8').toString('base64url');
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one')]),
    exploreCreatorsQuery: emptyCreators(),
  });
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/explore/collections?sort=popular&cursor=${encodeURIComponent(oldCursor)}`,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_cursor');
});

test('Explore rejects a sort/cursor mismatch and missing sort keys as invalid_cursor', async () => {
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one')]),
    exploreCreatorsQuery: emptyCreators(),
  });
  const cases = [
    { sort: 'updated', payload: { sort: 'popular', viewCount: 3, micros: '1', id: 'public-one' } },
    { sort: 'popular', payload: { sort: 'popular', micros: '1', id: 'public-one' } },
    { sort: 'links', payload: { sort: 'links', micros: '1', id: 'public-one' } },
    { sort: 'links', payload: { micros: '1', id: 'public-one' } },
  ];
  for (const example of cases) {
    const cursor = Buffer.from(JSON.stringify(example.payload), 'utf8').toString('base64url');
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/explore/collections?sort=${example.sort}&cursor=${encodeURIComponent(cursor)}`,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(example));
    assert.equal(response.json().error.code, 'invalid_cursor', JSON.stringify(example));
  }
});

test('HEAD Explore is registered and succeeds without a session', async () => {
  const app = buildExploreApp({
    explorePageQuery: explorePage([exploreRow('public-one')]),
    exploreCreatorsQuery: emptyCreators(),
  });
  const response = await app.inject({ method: 'HEAD', url: '/api/v1/explore/collections?sort=popular' });
  assert.equal(response.statusCode, 200);
});
