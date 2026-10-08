import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createPublicationCursorKeyring,
  PUBLICATION_RELATION_COMPARATOR_VERSION,
  type PublicationCollectionRecord,
  type PublicationDirectoryQueryPorts,
  type PublicationNodeRecord,
  type ProductPublicCollectionQueryPorts,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';

const instant = '2026-07-24T00:00:00.000Z';
let visibility: PublicationCollectionRecord['visibility'] = 'public';
let contentRevision = 'c1';
let memberSubject: string | null = null;
let ownerDiscoverable = true;
let viewCount = 0;
let viewCountLoads = 0;
const records = [node('a'), node('b')];
const slugLookups: string[] = [];
const collectionFactLoads: string[] = [];
let pageLoads = 0;
const PRODUCT_ORIGIN = 'https://known.example';
const ICON_OBJECT_A = '01234567-89ab-4cde-8f01-23456789abcd';
const iconObjectIds = new Map<string, string>();
let iconLookupCalls = 0;
const publicMarksByNode = new Map<string, { tldr: string | null; note: string | null }>();
let publicMarksCalls = 0;
const collectionMarks = new Map<string, string>();
let collectionMarksCalls = 0;
const cursors = createPublicationCursorKeyring({
  active: { id: 'product-http-v1', secret: Buffer.alloc(32, 43).toString('base64') }, retained: [],
});
const query: ProductPublicCollectionQueryPorts = {
  cursors,
  owners: {
    async findByOwnerSubjectId(subjectId) {
      assert.equal(subjectId, 'owner');
      return ownerDiscoverable ? Object.freeze({
        profileId: 'IiIiIiIiIiIiIiIiIiIiIg', handle: 'owner', displayName: 'Owner',
        avatarUrl: null, ownerSubjectId: 'owner',
      }) : null;
    },
  },
  locators: {
    async findCollectionIdBySlug(slug) {
      slugLookups.push(slug);
      return slug === 'published' ? 'collection' : null;
    },
  },
  viewCounts: {
    async sumCollectionViews(collectionId) {
      viewCountLoads += 1;
      assert.equal(collectionId, 'collection');
      return viewCount;
    },
  },
  productOrigin: PRODUCT_ORIGIN,
  bookmarkIcons: {
    async findObjectIdsByNodeIds(nodeIds) {
      iconLookupCalls += 1;
      const result = new Map<string, string>();
      if (nodeIds.length === 0) return result;
      for (const id of nodeIds) {
        const objectId = iconObjectIds.get(id);
        if (objectId) result.set(id, objectId);
      }
      return result;
    },
  },
  publicMarks: {
    async findPublicMarksByNodeIds(collectionId, nodeIds) {
      publicMarksCalls += 1;
      assert.equal(collectionId, 'collection');
      const result = new Map<string, { tldr: string | null; note: string | null }>();
      if (nodeIds.length === 0) return result;
      for (const id of nodeIds) {
        const marks = publicMarksByNode.get(id);
        if (marks) result.set(id, { tldr: marks.tldr, note: marks.note });
      }
      return result;
    },
    async findPublicMarksForCollections(collectionIds) {
      collectionMarksCalls += 1;
      const result = new Map<string, string>();
      for (const id of collectionIds) {
        const note = collectionMarks.get(id);
        if (note !== undefined) result.set(id, note);
      }
      return result;
    },
  },
  snapshot: {
    relations: { async loadPage() { return { isolation: 'repeatable read', comparatorVersion: PUBLICATION_RELATION_COMPARATOR_VERSION, contentRevision, policyRevision: 'p1', candidates: [] }; } },
    cursors,
    origin: 'https://known.example',
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
    accessPolicy: {
      async loadCollectionFacts(request) {
        collectionFactLoads.push(request.collectionId);
        return {
          collectionId: 'collection', ownerSubjectId: 'owner', visibility, policyRevision: 'p1',
          membershipRole: request.actorSubjectId === memberSubject ? 'viewer' : null, deleted: false,
        };
      },
    },
    reads: {
      async loadPage(request) {
        pageLoads += 1;
        const start = request.afterLocator
          ? records.findIndex((item) => locator(item.id) === request.afterLocator) + 1
          : 0;
        return {
          isolation: 'repeatable read', comparatorVersion: 'parent-position-id-v1',
          collection: collection(), root, candidates: records.slice(start, start + request.limit + 1),
        };
      },
    },
  },
};
const directoryQuery: PublicationDirectoryQueryPorts = {
  cursors,
  origin: PRODUCT_ORIGIN,
  maxPageSize: 50,
  reads: {
    async loadPage() {
      return [Object.freeze({
        id: 'collection', ownerSubjectId: 'owner', title: 'Published', summary: null,
        kind: 'bookmarks' as const, visibility: 'public' as const, publicationSlug: 'published',
        tags: Object.freeze([]), language: null, nodeCount: 1, updatedAt: instant,
        protectedAuthorized: false, orderingUpdatedAtMicros: '0',
      })];
    },
  },
};
const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(instant));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example', LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});
const app = buildApiApp({
  config, identityUnitOfWork, browserSessionAuthority: factory.authority,
  productPublicCollectionQuery: query,
  publicationDirectoryQuery: directoryQuery,
  exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  }),
});

afterAll(async () => {
  cursors.destroy();
  await app.close();
});

afterEach(() => {
  visibility = 'public';
  memberSubject = null;
  ownerDiscoverable = true;
  viewCount = 0;
  viewCountLoads = 0;
  iconObjectIds.clear();
  iconLookupCalls = 0;
  publicMarksByNode.clear();
  publicMarksCalls = 0;
  collectionMarks.clear();
  collectionMarksCalls = 0;
});

test('serves anonymous public and unlisted pages from a Cookie-varying shared cache', async () => {
  for (const value of ['public', 'unlisted'] as const) {
    visibility = value;
    const response = await app.inject({
      method: 'GET', url: '/api/v1/collections/published?limit=2',
      headers: { origin: 'https://known.example' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300');
    assertVary(response.headers.vary, ['Origin', 'Cookie']);
    assert.equal(response.headers['access-control-allow-origin'], 'https://known.example');
    assert.equal(response.json().collection.access, 'public');
    assert.equal(response.json().collection.viewCount, 0);
    assert.equal('viewCount' in response.json().collection, true);
    assert.deepEqual(response.json().collection.owner, {
      profileId: 'IiIiIiIiIiIiIiIiIiIiIg', handle: 'owner', displayName: 'Owner', avatarUrl: null,
    });
    assert.equal(response.json().page.hasMore, true);
  }

  const invalidSession = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2',
    headers: { origin: 'https://known.example', cookie: '__Host-known_session=invalid' },
  });
  assert.equal(invalidSession.statusCode, 200);
  assert.equal(invalidSession.json().collection.access, 'public');
  assertVary(invalidSession.headers.vary, ['Origin', 'Cookie']);
});

test('conceals a currently undiscoverable owner without leaking identity facts', async () => {
  ownerDiscoverable = false;
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/collections/published' });
    assert.equal(response.statusCode, 404);
    assert.equal(JSON.stringify(response.json()).includes('owner'), false);
    assert.equal(JSON.stringify(response.json()).includes('IiIiIiIiIiIiIiIiIiIiIg'), false);
  } finally {
    ownerDiscoverable = true;
  }
});

test('serves a private member projection without allowing shared caching', async () => {
  const client = await issueTestSession({
    factory,
    subject: 'public-page-member',
    handle: 'public-page-member',
  });
  visibility = 'private';
  memberSubject = client.subjectId;
  try {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/collections/published' });
    assert.equal(anonymous.statusCode, 404);
    const member = await app.inject({
      method: 'GET', url: '/api/v1/collections/published',
      headers: { cookie: client.cookie, origin: 'https://known.example' },
    });
    assert.equal(member.statusCode, 200);
    assert.equal(member.headers['cache-control'], 'private, no-store');
    assertVary(member.headers.vary, ['Origin', 'Cookie']);
    assert.equal(member.json().collection.access, 'member');
  } finally {
    visibility = 'public';
    memberSubject = null;
  }
});

test('isolates cursor purposes and maps a changed revision to snapshot_expired', async () => {
  const invalid = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2&cursor=psc1.invalid',
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'invalid_cursor');

  const first = await app.inject({ method: 'GET', url: '/api/v1/collections/published?limit=2' });
  const cursor = first.json().page.cursor as string;
  contentRevision = 'c2';
  try {
    const expired = await app.inject({
      method: 'GET', url: `/api/v1/collections/published?limit=2&cursor=${encodeURIComponent(cursor)}`,
    });
    assert.equal(expired.statusCode, 409);
    assert.equal(expired.json().error.code, 'snapshot_expired');
    assert.equal(expired.json().error.recovery, 'restart_from_first_page');
  } finally {
    contentRevision = 'c1';
  }
});

test('GET treats a live Collection OpaqueId as an unknown publication slug', async () => {
  const slugLookupsBefore = slugLookups.length;
  const factLoadsBefore = collectionFactLoads.length;
  const pageLoadsBefore = pageLoads;

  const byId = await app.inject({
    method: 'GET', url: '/api/v1/collections/collection',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(byId.statusCode, 404);
  assert.equal(byId.json().error.code, 'resource_not_found');
  assert.deepEqual(slugLookups.slice(slugLookupsBefore), ['collection']);
  assert.equal(collectionFactLoads.length, factLoadsBefore);
  assert.equal(pageLoads, pageLoadsBefore);

  const rfcUuid = '019f9031-c541-74d0-bc83-15a5526fbb54';
  const byUuid = await app.inject({
    method: 'GET', url: `/api/v1/collections/${rfcUuid}`,
    headers: { origin: 'https://known.example' },
  });
  assert.equal(byUuid.statusCode, 404);
  assert.equal(byUuid.json().error.code, 'resource_not_found');
  assert.equal(byUuid.json().error.message, byId.json().error.message);
  assert.deepEqual(slugLookups.slice(slugLookupsBefore), ['collection', rfcUuid]);
  assert.equal(collectionFactLoads.length, factLoadsBefore);
  assert.equal(pageLoads, pageLoadsBefore);

  const unknown = await app.inject({
    method: 'GET', url: '/api/v1/collections/unknown',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.code, 'resource_not_found');
  assert.equal(unknown.json().error.message, byId.json().error.message);
  assert.equal(unknown.json().error.recovery, byId.json().error.recovery);

  const bySlug = await app.inject({
    method: 'GET', url: '/api/v1/collections/published',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(bySlug.statusCode, 200);
  assert.equal(bySlug.json().collection.id, 'collection');
  assert.equal(bySlug.json().collection.slug, 'published');
  assert.equal(slugLookups.at(-1), 'published');
});

test('conceals invalid and unknown slugs and validates paging input', async () => {
  for (const url of ['/api/v1/collections/UPPER', '/api/v1/collections/unknown']) {
    const response = await app.inject({
      method: 'GET', url, headers: { origin: 'https://known.example', authorization: 'Bearer ignored' },
    });
    assert.equal(response.statusCode, 404);
    assertVary(response.headers.vary, ['Origin', 'Cookie']);
    assert.doesNotMatch(response.headers.vary ?? '', /Authorization/iu);
  }
  const invalidLimit = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=1',
    headers: { origin: 'https://known.example', cookie: '__Host-known_session=invalid' },
  });
  assert.equal(invalidLimit.statusCode, 400);
  assertVary(invalidLimit.headers.vary, ['Origin', 'Cookie']);

  const overflow = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=500',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(overflow.statusCode, 400);
  assert.equal(overflow.json().error.code, 'invalid_query');
  assert.match(overflow.json().error.message, /between 2 and 100/u);

  // Admission rejects duplicate query fields before route-specific session handling.
  const duplicate = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2&limit=3',
  });
  assert.equal(duplicate.statusCode, 400);
  assert.match(duplicate.headers['cache-control'] ?? '', /(?:^|,\s*)no-store(?:,|$)/u);
});

test('HTTP anonymous public page sets faviconCdnAllowed true and sends iconUrl null without a row', async () => {
  visibility = 'public';
  const response = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    collection: { access: string; faviconCdnAllowed?: boolean };
    nodes: Array<{ id: string; kind: string; iconUrl?: string | null }>;
  };
  assert.equal(body.collection.access, 'public');
  assert.equal(body.collection.faviconCdnAllowed, true);
  const bookmark = body.nodes.find((item) => item.kind === 'bookmark');
  const root = body.nodes.find((item) => item.kind === 'root');
  assert.equal(Object.hasOwn(bookmark ?? {}, 'iconUrl'), true);
  assert.equal(bookmark?.iconUrl, null);
  assert.equal(root?.iconUrl, null);
});

test('HTTP unlisted anonymous page sets faviconCdnAllowed false', async () => {
  visibility = 'unlisted';
  const response = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().collection.access, 'public');
  assert.equal(response.json().collection.faviconCdnAllowed, false);
});

test('HTTP anonymous GET slug returns the windowed viewCount sum', async () => {
  viewCount = 12;
  const response = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300');
  assert.equal(response.json().collection.viewCount, 12);
  assert.equal('viewCount' in response.json().collection, true);
});

test('HTTP unlisted anonymous GET slug is 200 with viewCount', async () => {
  visibility = 'unlisted';
  viewCount = 4;
  const response = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().collection.access, 'public');
  assert.equal(response.json().collection.viewCount, 4);
  assert.equal(response.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300');
});

test('HTTP private anonymous GET slug stays 404 without loading viewCount', async () => {
  visibility = 'private';
  viewCount = 9;
  const response = await app.inject({
    method: 'GET', url: '/api/v1/collections/published',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  assert.equal(viewCountLoads, 0);
  assert.equal('viewCount' in (response.json().collection ?? {}), false);
});

test('HTTP COLP directory still omits viewCount', async () => {
  const response = await app.inject({
    method: 'GET', url: '/colp/v0.1/directory',
    headers: {
      accept: 'application/vnd.collection-protocol.catalog+json;version=0.1',
      origin: 'https://known.example',
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { collections: Array<Record<string, unknown>> };
  assert.ok(body.collections.length > 0);
  for (const item of body.collections) {
    assert.equal('viewCount' in item, false);
  }
  assert.doesNotMatch(response.body, /"viewCount"/);
});

test('HTTP count port failure does not return a page without viewCount', async () => {
  const previous = query.viewCounts.sumCollectionViews;
  query.viewCounts.sumCollectionViews = async () => {
    throw new Error('insight store down');
  };
  try {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/collections/published',
      headers: { origin: 'https://known.example' },
    });
    assert.notEqual(response.statusCode, 200);
    assert.equal('viewCount' in (response.json().collection ?? {}), false);
  } finally {
    query.viewCounts.sumCollectionViews = previous;
  }
});

test('HTTP member Session on a public Collection sets faviconCdnAllowed false', async () => {
  const client = await issueTestSession({
    factory,
    subject: 'public-page-owner-member',
    handle: 'public-page-owner-member',
  });
  visibility = 'public';
  memberSubject = client.subjectId;
  const response = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2',
    headers: { cookie: client.cookie, origin: 'https://known.example' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().collection.access, 'member');
  assert.equal(response.json().collection.faviconCdnAllowed, false);
});

test('HTTP live JOIN returns same-origin iconUrl for a public bookmark', async () => {
  visibility = 'public';
  iconObjectIds.set('a', ICON_OBJECT_A);
  const response = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    collection: { faviconCdnAllowed?: boolean };
    nodes: Array<{ id: string; kind: string; iconUrl?: string | null }>;
  };
  assert.equal(body.collection.faviconCdnAllowed, true);
  assert.equal(
    body.nodes.find((item) => item.id === 'a')?.iconUrl,
    `${PRODUCT_ORIGIN}/api/v1/favicon/${ICON_OBJECT_A}`,
  );
  assert.equal(body.nodes.find((item) => item.kind === 'root')?.iconUrl, null);
  assert.doesNotMatch(response.body, /favicon\.im|duckduckgo/i);
});

test('HTTP anonymous public page serializes public tldr/note marks on nodes', async () => {
  visibility = 'public';
  publicMarksByNode.set('a', { tldr: 'HTTP tldr', note: 'HTTP note' });
  publicMarksByNode.set('root', { tldr: 'Root tldr', note: null });
  const response = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    nodes: Array<{ id: string; kind: string; tldr?: string; note?: string }>;
  };
  assert.equal(body.nodes.find((item) => item.id === 'a')?.tldr, 'HTTP tldr');
  assert.equal(body.nodes.find((item) => item.id === 'a')?.note, 'HTTP note');
  assert.equal(body.nodes.find((item) => item.kind === 'root')?.tldr, 'Root tldr');
  assert.equal(
    Object.hasOwn(body.nodes.find((item) => item.kind === 'root') ?? {}, 'note'),
    false,
  );
  assert.equal(publicMarksCalls, 1);
});

test('HTTP anonymous public page serializes the curatorNote collection mark', async () => {
  visibility = 'public';
  collectionMarks.set('collection', 'HTTP curator note');
  const response = await app.inject({
    method: 'GET', url: '/api/v1/collections/published?limit=2',
    headers: { origin: 'https://known.example' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().collection.curatorNote, 'HTTP curator note');
  assert.equal(collectionMarksCalls, 1);
});

function assertVary(value: string | undefined, expected: readonly string[]): void {
  const actual = new Set((value ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean));
  for (const field of expected) assert.ok(actual.has(field.toLowerCase()), `Vary is missing ${field}: ${value}`);
  assert.equal(actual.size, (value ?? '').split(',').map((part) => part.trim()).filter(Boolean).length);
}

function collection(): PublicationCollectionRecord {
  return {
    id: 'collection', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Published', summary: null,
    visibility, publicationSlug: 'published', rootNodeId: 'root', contentRevision,
    policyRevision: 'p1', createdAt: instant, updatedAt: instant, deletedAt: null,
  };
}

function node(id: string): PublicationNodeRecord {
  return {
    id, collectionId: 'collection', parentId: 'root', kind: 'bookmark', isRoot: false,
    title: id, url: `https://example.test/${id}`, description: null, tags: [], visibility: 'inherit',
    ancestorRestricted: false, position: id, resourceRevision: `r-${id}`, createdAt: instant, updatedAt: instant,
  };
}

const root: PublicationNodeRecord = {
  ...node('root'), parentId: null, kind: 'folder', isRoot: true, url: null, position: null,
};

function locator(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32);
}


test('graph include returns relations without caching and rejects unsupported includes', async () => {
  const graph = await app.inject({ method: 'GET', url: '/api/v1/collections/published?include=relations' });
  assert.equal(graph.statusCode, 200);
  assert.deepEqual(graph.json().relations, []);
  assert.equal(graph.headers['cache-control'], 'private, no-store');
  const invalid = await app.inject({ method: 'GET', url: '/api/v1/collections/published?include=private' });
  assert.equal(invalid.statusCode, 400);
});
