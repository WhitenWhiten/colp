import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'vitest';
import {
  createPublicationCursorKeyring,
  PUBLICATION_RELATION_COMPARATOR_VERSION,
  type PublicationRelationRecord,
  getProductPublicCollectionPage,
  PRODUCT_PUBLIC_COLLECTION_DEFAULT_LIMIT,
  PRODUCT_PUBLIC_COLLECTION_MAX_LIMIT,
  ProductPublicCollectionCursorError,
  ProductPublicCollectionNotFoundError,
  PublicationNotFoundError,
  type PublicationCollectionRecord,
  type PublicationCursorKeyring,
  type PublicationNodeRecord,
  type ProductPublicCollectionQueryPorts,
} from '../../../src/modules/publication/index.js';

const instant = '2026-07-24T00:00:00.000Z';
let visibility: PublicationCollectionRecord['visibility'] = 'public';
let memberSubject: string | null = null;
let ownerDiscoverable = true;
let viewCount = 0;
let viewCountLoads = 0;
const nodes = [node('a'), node('b'), node('c')];
const keyrings: PublicationCursorKeyring[] = [];

const PRODUCT_ORIGIN = 'https://known.example';
const ICON_OBJECT_A = '01234567-89ab-4cde-8f01-23456789abcd';
const ICON_OBJECT_PRIVATE = 'fedcba98-7654-4321-8abc-0123456789ab';
const iconObjectIds = new Map<string, string>();
let iconLookupCalls = 0;
const publicMarks = new Map<string, { tldr: string | null; note: string | null }>();
let publicMarksPort = true;
let publicMarksCalls = 0;
const collectionMarks = new Map<string, string>();
let collectionMarksCalls = 0;

afterEach(() => {
  while (keyrings.length > 0) keyrings.pop()!.destroy();
  visibility = 'public';
  memberSubject = null;
  ownerDiscoverable = true;
  viewCount = 0;
  viewCountLoads = 0;
  iconObjectIds.clear();
  iconLookupCalls = 0;
  publicMarks.clear();
  publicMarksPort = true;
  publicMarksCalls = 0;
  collectionMarks.clear();
  collectionMarksCalls = 0;
});

test('maps anonymous public and unlisted Snapshot pages to the explicit Product DTO', async () => {
  for (const value of ['public', 'unlisted'] as const) {
    visibility = value;
    const page = await getProductPublicCollectionPage(ports(), {
      slug: 'published', principal: { kind: 'anonymous' }, limit: 2,
    });
    assert.equal(page.collection.slug, 'published');
    assert.equal(page.collection.access, 'public');
    assert.deepEqual(page.collection.owner, {
      profileId: 'IiIiIiIiIiIiIiIiIiIiIg', handle: 'owner', displayName: 'Owner', avatarUrl: null,
    });
    assert.deepEqual(page.nodes.map((item) => item.id), ['root', 'a']);
    assert.ok(page.page.cursor?.startsWith('ppc1.'));
    assert.deepEqual(Object.keys(page.collection).sort(), [
      'access', 'curatorNote', 'faviconCdnAllowed', 'id', 'kind', 'owner', 'rootNodeId', 'slug', 'summary',
      'title', 'updatedAt', 'viewCount',
    ]);
    assert.equal(page.collection.viewCount, 0);
    assert.equal(page.collection.faviconCdnAllowed, value === 'public');
    assert.equal('revision' in page.collection, false);
    assert.equal('visibility' in page.collection, false);
    assert.equal('ownerSubjectId' in page.collection, false);
  }
});

test('directory-public anonymous page sets faviconCdnAllowed true', async () => {
  visibility = 'public';
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  assert.equal(page.collection.access, 'public');
  assert.equal(page.collection.faviconCdnAllowed, true);
});

test('unlisted anonymous page sets faviconCdnAllowed false even when access is public', async () => {
  visibility = 'unlisted';
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  assert.equal(page.collection.access, 'public');
  assert.equal(page.collection.faviconCdnAllowed, false);
});

test('serializes viewCount 0 when the count port has no daily rows', async () => {
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' },
  });
  assert.equal(Object.hasOwn(page.collection, 'viewCount'), true);
  assert.equal(page.collection.viewCount, 0);
  assert.equal(viewCountLoads, 1);
});

test('forwards the windowed collection_view sum onto the snapshot collection', async () => {
  viewCount = 7;
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' },
  });
  assert.equal(page.collection.viewCount, 7);
});

test('unlisted anonymous snapshot still includes viewCount', async () => {
  visibility = 'unlisted';
  viewCount = 3;
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' },
  });
  assert.equal(page.collection.access, 'public');
  assert.equal(page.collection.viewCount, 3);
  assert.equal(page.collection.faviconCdnAllowed, false);
});

test('loads viewCount from the already-resolved collection id after snapshot success', async () => {
  const observed: string[] = [];
  const queryPorts = ports();
  queryPorts.viewCounts.sumCollectionViews = async (collectionId) => {
    observed.push(collectionId);
    return 2;
  };
  const page = await getProductPublicCollectionPage(queryPorts, {
    slug: 'published', principal: { kind: 'anonymous' },
  });
  assert.deepEqual(observed, ['collection']);
  assert.equal(page.collection.viewCount, 2);
});

test('does not load viewCount for a concealed anonymous private snapshot', async () => {
  visibility = 'private';
  await assert.rejects(
    () => getProductPublicCollectionPage(ports(), {
      slug: 'published', principal: { kind: 'anonymous' },
    }),
    PublicationNotFoundError,
  );
  assert.equal(viewCountLoads, 0);
});

test('count port failures fail the page instead of omitting viewCount', async () => {
  const queryPorts = ports();
  queryPorts.viewCounts.sumCollectionViews = async () => {
    throw new Error('insight store down');
  };
  await assert.rejects(
    () => getProductPublicCollectionPage(queryPorts, {
      slug: 'published', principal: { kind: 'anonymous' },
    }),
    /insight store down/,
  );
});

test('owner Session on a public Collection uses member projection and forbids CDN', async () => {
  visibility = 'public';
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published',
    principal: { kind: 'account', principalId: 'account', subjectId: 'owner' },
    limit: 4,
  });
  assert.equal(page.collection.access, 'member');
  assert.equal(page.collection.faviconCdnAllowed, false);
});

test('public nodes always send iconUrl; bookmarks without a row are JSON null; folder/root stay null', async () => {
  visibility = 'public';
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  const root = page.nodes.find((item) => item.id === 'root');
  const bookmark = page.nodes.find((item) => item.id === 'a');
  assert.ok(root);
  assert.ok(bookmark);
  assert.equal(root.kind, 'root');
  assert.equal(bookmark.kind, 'bookmark');
  assert.equal(Object.hasOwn(root, 'iconUrl'), true);
  assert.equal(Object.hasOwn(bookmark, 'iconUrl'), true);
  assert.equal(root.iconUrl, null);
  assert.equal(bookmark.iconUrl, null);
  assert.doesNotMatch(JSON.stringify(page), /favicon\.im|duckduckgo/i);
});

test('live JOIN projects same-origin iconUrl for public bookmarks and keeps folder/root null', async () => {
  visibility = 'public';
  iconObjectIds.set('a', ICON_OBJECT_A);
  iconObjectIds.set('root', ICON_OBJECT_A);
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  const root = page.nodes.find((item) => item.id === 'root')!;
  const bookmark = page.nodes.find((item) => item.id === 'a')!;
  assert.equal(bookmark.iconUrl, `${PRODUCT_ORIGIN}/api/v1/favicon/${ICON_OBJECT_A}`);
  assert.equal(root.iconUrl, null);
  assert.match(bookmark.iconUrl ?? '', /^https:\/\/known\.example\/api\/v1\/favicon\/[a-f0-9-]{36}$/i);
  assert.doesNotMatch(bookmark.iconUrl ?? '', /favicon\.im|duckduckgo/i);
});

test('unauthorized public projection drops private bookmarks and therefore their icons', async () => {
  visibility = 'public';
  const privateBookmark = {
    ...node('secret'),
    visibility: 'private' as const,
  };
  nodes.splice(0, nodes.length, privateBookmark, node('a'), node('b'), node('c'));
  iconObjectIds.set('secret', ICON_OBJECT_PRIVATE);
  iconObjectIds.set('a', ICON_OBJECT_A);
  try {
    const page = await getProductPublicCollectionPage(ports(), {
      slug: 'published', principal: { kind: 'anonymous' }, limit: 8,
    });
    assert.equal(page.nodes.some((item) => item.id === 'secret'), false);
    assert.equal(JSON.stringify(page).includes(ICON_OBJECT_PRIVATE), false);
    const publicBookmark = page.nodes.find((item) => item.id === 'a');
    assert.equal(publicBookmark?.iconUrl, `${PRODUCT_ORIGIN}/api/v1/favicon/${ICON_OBJECT_A}`);
  } finally {
    nodes.splice(0, nodes.length, node('a'), node('b'), node('c'));
  }
});

test('icon JOIN issues one batch lookup for a page of eight bookmarks', async () => {
  visibility = 'public';
  const many = Array.from({ length: 8 }, (_, index) => node(`bm-${index}`));
  for (const item of many) iconObjectIds.set(item.id, ICON_OBJECT_A);
  nodes.splice(0, nodes.length, ...many);
  try {
    const page = await getProductPublicCollectionPage(ports(), {
      slug: 'published', principal: { kind: 'anonymous' }, limit: 20,
    });
    assert.equal(page.nodes.filter((item) => item.kind === 'bookmark').length, 8);
    assert.equal(iconLookupCalls, 1);
    assert.ok(page.nodes.filter((item) => item.kind === 'bookmark').every((item) => (
      item.iconUrl === `${PRODUCT_ORIGIN}/api/v1/favicon/${ICON_OBJECT_A}`
    )));
  } finally {
    nodes.splice(0, nodes.length, node('a'), node('b'), node('c'));
  }
});

test('attaches batch public tldr/note marks to nodes of any kind', async () => {
  visibility = 'public';
  publicMarks.set('a', { tldr: 'Tl dr one', note: 'Note one' });
  publicMarks.set('root', { tldr: 'Root tldr', note: null });
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  assert.equal(publicMarksCalls, 1);
  const bookmark = page.nodes.find((item) => item.id === 'a')!;
  const rootNode = page.nodes.find((item) => item.id === 'root')!;
  assert.equal(bookmark.tldr, 'Tl dr one');
  assert.equal(bookmark.note, 'Note one');
  assert.equal(rootNode.tldr, 'Root tldr');
  assert.equal(Object.hasOwn(rootNode, 'note'), false);
  assert.equal(Object.hasOwn(bookmark, 'position'), true);
});

test('shows the owner\'s pins on bookmarks and omits the field otherwise', async () => {
  visibility = 'public';
  const original = nodes[0]!;
  nodes[0] = { ...original, pinned: true };
  try {
    const page = await getProductPublicCollectionPage(ports(), {
      slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
    });
    assert.equal(page.nodes.find((item) => item.id === 'a')!.pinned, true);
    assert.equal(Object.hasOwn(page.nodes.find((item) => item.id === 'b')!, 'pinned'), false);
    assert.equal(Object.hasOwn(page.nodes.find((item) => item.id === 'root')!, 'pinned'), false);
  } finally { nodes[0] = original; }
});

test('omits tldr/note fields without a publicMarks port or with empty marks', async () => {
  visibility = 'public';
  publicMarksPort = false;
  const withoutPort = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  assert.equal(publicMarksCalls, 0);
  for (const item of withoutPort.nodes) {
    assert.equal(Object.hasOwn(item, 'tldr'), false);
    assert.equal(Object.hasOwn(item, 'note'), false);
  }
  publicMarksPort = true;
  const withEmptyPort = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  assert.equal(publicMarksCalls, 1);
  for (const item of withEmptyPort.nodes) {
    assert.equal(Object.hasOwn(item, 'tldr'), false);
    assert.equal(Object.hasOwn(item, 'note'), false);
  }
  publicMarks.set('a', { tldr: null, note: null });
  const withNullMarks = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  assert.equal(Object.hasOwn(withNullMarks.nodes.find((item) => item.id === 'a')!, 'tldr'), false);
  assert.equal(Object.hasOwn(withNullMarks.nodes.find((item) => item.id === 'a')!, 'note'), false);
});

test('per-node multiple tldr rows resolve to the latest updated mark (port contract)', async () => {
  visibility = 'public';
  const queryPorts = ports();
  const rows = [
    { subjectId: 'a', type: 'tldr' as const, value: 'stale tldr', updatedAt: instant },
    { subjectId: 'a', type: 'tldr' as const, value: 'fresh tldr', updatedAt: '2026-07-24T02:00:00.000Z' },
    { subjectId: 'a', type: 'note' as const, value: 'note one', updatedAt: instant },
  ];
  queryPorts.publicMarks = {
    ...queryPorts.publicMarks,
    async findPublicMarksByNodeIds(collectionId, nodeIds) {
      assert.equal(collectionId, 'collection');
      const result = new Map<string, { tldr: string | null; note: string | null }>();
      for (const id of nodeIds) {
        const byType = (type: 'tldr' | 'note') => rows
          .filter((row) => row.subjectId === id && row.type === type)
          .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
          .at(-1)?.value ?? null;
        result.set(id, { tldr: byType('tldr'), note: byType('note') });
      }
      return result;
    },
  };
  const page = await getProductPublicCollectionPage(queryPorts, {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  const bookmark = page.nodes.find((item) => item.id === 'a')!;
  assert.equal(bookmark.tldr, 'fresh tldr');
  assert.equal(bookmark.note, 'note one');
});

test('non-public visibility marks never surface through the marks port (port contract)', async () => {
  visibility = 'public';
  const queryPorts = ports();
  queryPorts.publicMarks = {
    ...queryPorts.publicMarks,
    async findPublicMarksByNodeIds(collectionId, nodeIds) {
      // Port contract: only visibility=public rows are exposed; the Product
      // query never sees private/protected/unlisted marks at all.
      const rows = [
        { subjectId: 'a', type: 'tldr' as const, value: 'public tldr', visibility: 'public' },
        { subjectId: 'a', type: 'note' as const, value: 'PRIVATE SECRET NOTE', visibility: 'private' },
        { subjectId: 'a', type: 'note' as const, value: 'PROTECTED SECRET NOTE', visibility: 'protected' },
        { subjectId: 'b', type: 'tldr' as const, value: 'UNLISTED SECRET TLDR', visibility: 'unlisted' },
      ];
      const marks = new Map<string, { tldr: string | null; note: string | null }>();
      for (const id of nodeIds) {
        const tldr = rows.find((row) => row.subjectId === id && row.type === 'tldr'
          && row.visibility === 'public')?.value ?? null;
        const note = rows.find((row) => row.subjectId === id && row.type === 'note'
          && row.visibility === 'public')?.value ?? null;
        marks.set(id, { tldr, note });
      }
      return marks;
    },
  };
  const body = JSON.stringify(await getProductPublicCollectionPage(queryPorts, {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  }));
  assert.equal(body.includes('PRIVATE SECRET NOTE'), false);
  assert.equal(body.includes('PROTECTED SECRET NOTE'), false);
  assert.equal(body.includes('UNLISTED SECRET TLDR'), false);
  assert.equal(body.includes('public tldr'), true);
});

test('rejects v1 product-public-page cursors after the v2 response-shape bump', async () => {
  const queryPorts = ports();
  const v1Cursor = queryPorts.cursors.product.sign({
    slug: 'published', principal: 'anonymous', limit: 2,
    version: 'product-public-page-v1', nextPosition: 'x',
  });
  await assert.rejects(
    () => getProductPublicCollectionPage(queryPorts, {
      slug: 'published', principal: { kind: 'anonymous' }, limit: 2, cursor: v1Cursor,
    }),
    ProductPublicCollectionCursorError,
  );
});

test('attaches the latest public collection tldr as curatorNote on the collection block', async () => {
  visibility = 'public';
  collectionMarks.set('collection', 'Curator recommends this collection');
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  assert.equal(collectionMarksCalls, 1);
  assert.equal(page.collection.curatorNote, 'Curator recommends this collection');
});

test('curatorNote is null without the marks port or an empty collection lookup', async () => {
  visibility = 'public';
  publicMarksPort = false;
  const withoutPort = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  assert.equal(collectionMarksCalls, 0);
  assert.equal(withoutPort.collection.curatorNote, null);
  publicMarksPort = true;
  const withEmptyLookup = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
  });
  assert.equal(collectionMarksCalls, 1);
  assert.equal(withEmptyLookup.collection.curatorNote, null);
});

test('conceals a Collection when its current owner Profile is hidden or deleted', async () => {
  ownerDiscoverable = false;
  await assert.rejects(
    () => getProductPublicCollectionPage(ports(), {
      slug: 'published', principal: { kind: 'anonymous' }, limit: 2,
    }),
    ProductPublicCollectionNotFoundError,
  );
});

test('serves member projection for private Collections and conceals anonymous reads', async () => {
  visibility = 'private';
  memberSubject = 'member';
  const member = await getProductPublicCollectionPage(ports(), {
    slug: 'published',
    principal: { kind: 'account', principalId: 'account', subjectId: 'member' },
    limit: 4,
  });
  assert.equal(member.collection.access, 'member');
  await assert.rejects(
    () => getProductPublicCollectionPage(ports(), {
      slug: 'published', principal: { kind: 'anonymous' }, limit: 4,
    }),
    PublicationNotFoundError,
  );
});

test('continues atomically with a Product-only, principal-bound cursor', async () => {
  const queryPorts = ports();
  const first = await getProductPublicCollectionPage(queryPorts, {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 2,
  });
  const second = await getProductPublicCollectionPage(queryPorts, {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 2, cursor: first.page.cursor!,
  });
  assert.deepEqual(second.nodes.map((item) => item.id), ['b', 'c']);
  assert.equal(second.page.hasMore, false);
  for (const cursor of [
    queryPorts.cursors.snapshot.sign({
      collectionId: 'published', resourceId: 'https://colp.example/colp/v0.1/collections/published/snapshot',
      revision: 'c1.p1', comparatorVersion: 'parent-position-id-v1',
      principal: 'anonymous', pageSize: 2, nextPosition: 'x',
    }),
    'editor.cursor',
  ]) {
    await assert.rejects(
      () => getProductPublicCollectionPage(queryPorts, {
        slug: 'published', principal: { kind: 'anonymous' }, limit: 2, cursor,
      }),
      ProductPublicCollectionCursorError,
    );
  }
  await assert.rejects(
    () => getProductPublicCollectionPage(queryPorts, {
      slug: 'published',
      principal: { kind: 'account', principalId: 'other-account', subjectId: 'other' },
      limit: 2,
      cursor: first.page.cursor!,
    }),
    ProductPublicCollectionCursorError,
  );
});

test('does not resolve a live Collection OpaqueId as a publication slug', async () => {
  const observed: string[] = [];
  const queryPorts = ports();
  queryPorts.locators.findCollectionIdBySlug = async (slug) => {
    observed.push(slug);
    return slug === 'published' ? 'collection' : null;
  };
  await assert.rejects(
    () => getProductPublicCollectionPage(queryPorts, {
      slug: 'collection', principal: { kind: 'anonymous' },
    }),
    ProductPublicCollectionNotFoundError,
  );
  assert.deepEqual(observed, ['collection']);

  const page = await getProductPublicCollectionPage(queryPorts, {
    slug: 'published', principal: { kind: 'anonymous' },
  });
  assert.equal(page.collection.id, 'collection');
  assert.equal(page.collection.slug, 'published');
  assert.deepEqual(observed, ['collection', 'published']);
});

test('accepts the database-authoritative 3..263 canonical slug range, including legacy backfills', async () => {
  const observed: string[] = [];
  const queryPorts = ports();
  queryPorts.locators.findCollectionIdBySlug = async (slug) => {
    observed.push(slug);
    return null;
  };
  const legacy = `legacy-${Buffer.from('123e4567-e89b-12d3-a456-426614174000').toString('hex')}`;
  for (const slug of ['abc', 'a'.repeat(63), 'a'.repeat(64), legacy, 'a'.repeat(263)]) {
    await assert.rejects(
      () => getProductPublicCollectionPage(queryPorts, { slug, principal: { kind: 'anonymous' } }),
      ProductPublicCollectionNotFoundError,
    );
  }
  assert.deepEqual(observed, ['abc', 'a'.repeat(63), 'a'.repeat(64), legacy, 'a'.repeat(263)]);

  for (const slug of ['ab', 'a'.repeat(264)]) {
    const before = observed.length;
    await assert.rejects(
      () => getProductPublicCollectionPage(queryPorts, { slug, principal: { kind: 'anonymous' } }),
      ProductPublicCollectionNotFoundError,
    );
    assert.equal(observed.length, before, `invalid slug reached locator: ${slug.length}`);
  }
});

test('page limit matches Explore 24/100 and rejects Directory-sized 500', async () => {
  assert.equal(PRODUCT_PUBLIC_COLLECTION_DEFAULT_LIMIT, 24);
  assert.equal(PRODUCT_PUBLIC_COLLECTION_MAX_LIMIT, 100);
  await assert.rejects(
    () => getProductPublicCollectionPage(ports(), {
      slug: 'published', principal: { kind: 'anonymous' }, limit: 500,
    }),
    (error: unknown) => error instanceof RangeError
      && error.message === 'Public Collection page limit must be between 2 and 100',
  );
  await assert.rejects(
    () => getProductPublicCollectionPage(ports(), {
      slug: 'published', principal: { kind: 'anonymous' }, limit: 101,
    }),
    RangeError,
  );
  const page = await getProductPublicCollectionPage(ports(), {
    slug: 'published', principal: { kind: 'anonymous' }, limit: 100,
  });
  assert.equal(page.collection.slug, 'published');
});

function ports(): ProductPublicCollectionQueryPorts {
  const cursors = createPublicationCursorKeyring({
    active: { id: 'product-v1', secret: Buffer.alloc(32, 41).toString('base64') }, retained: [],
  });
  keyrings.push(cursors);
  return {
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
    locators: { async findCollectionIdBySlug(slug) { return slug === 'published' ? 'collection' : null; } },
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
    ...(publicMarksPort ? {
      publicMarks: {
        async findPublicMarksByNodeIds(collectionId, nodeIds) {
          publicMarksCalls += 1;
          assert.equal(collectionId, 'collection');
          const result = new Map<string, { tldr: string | null; note: string | null }>();
          if (nodeIds.length === 0) return result;
          for (const id of nodeIds) {
            const marks = publicMarks.get(id);
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
    } : {}),
    snapshot: {
      cursors,
      origin: 'https://known.example',
      // Q1 integration alignment: the attachments lane added the shared
      // exposure-facts port to the snapshot query ports (attachment
      // capability markers must be hidden from public pages); this fixture
      // now supplies the empty-facts default like the other query fixtures.
      sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
      accessPolicy: {
        async loadCollectionFacts(request) {
          return {
            collectionId: 'collection', ownerSubjectId: 'owner', visibility, policyRevision: 'p1',
            membershipRole: request.actorSubjectId === memberSubject ? 'viewer' : null, deleted: false,
          };
        },
      },
      reads: {
        async loadPage(request) {
          const start = request.afterLocator
            ? nodes.findIndex((item) => locator(item.id) === request.afterLocator) + 1
            : 0;
          return {
            isolation: 'repeatable read', comparatorVersion: 'parent-position-id-v1',
            collection: collection(), root, candidates: nodes.slice(start, start + request.limit + 1),
          };
        },
      },
    },
  };
}

function collection(): PublicationCollectionRecord {
  return {
    id: 'collection', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Published', summary: null,
    visibility, publicationSlug: 'published', rootNodeId: 'root', contentRevision: 'c1',
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


test('graph pages expose only projected relation fields and bind cursors to the graph include', async () => {
  const query = ports();
  const rows: PublicationRelationRecord[] = ['public', 'private', 'protected'].map((visibility, i) => ({
    id: `rel-${i}`, collectionId: 'collection', fromNodeId: 'a', toNodeId: 'b',
    visibility: visibility as PublicationRelationRecord['visibility'], fromVisibility: 'inherit', toVisibility: 'inherit',
    fromAuthorized: true, toAuthorized: true, fromAncestorVisibility: null, toAncestorVisibility: null,
    fromAncestorRestricted: false, toAncestorRestricted: false, deletedAt: null,
    payload: { id: `rel-${i}`, collectionId: 'collection', fromNodeId: 'a', toNodeId: 'b', type: 'supports',
      label: `evidence-${i}`, visibility: visibility as PublicationRelationRecord['visibility'], revision: 'r1', createdAt: instant, updatedAt: instant },
  }));
  const graphQuery = { ...query, snapshot: { ...query.snapshot, relations: { async loadPage(request: { afterLocator?: string; limit: number }) {
    const start = request.afterLocator ? rows.findIndex((row) => locator(row.id) === request.afterLocator) + 1 : 0;
    return { isolation: 'repeatable read' as const, comparatorVersion: PUBLICATION_RELATION_COMPARATOR_VERSION,
      contentRevision: 'c1', policyRevision: 'p1', candidates: rows.slice(start, start + request.limit + 1) };
  } } } };
  for (const member of [false, true]) {
    memberSubject = member ? 'viewer' : null;
    const principal = member ? { kind: 'account' as const, principalId: 'account', subjectId: 'viewer' } : { kind: 'anonymous' as const };
    const found: NonNullable<Awaited<ReturnType<typeof getProductPublicCollectionPage>>['relations']>[number][] = [];
    let cursor: string | undefined;
    do {
      const page = await getProductPublicCollectionPage(graphQuery, { slug: 'published', principal, includeRelations: true, limit: 2, cursor });
      found.push(...page.relations!);
      cursor = page.page.cursor ?? undefined;
      if (cursor) await assert.rejects(() => getProductPublicCollectionPage(graphQuery, { slug: 'published', principal, limit: 2, cursor }), ProductPublicCollectionCursorError);
    } while (cursor);
    assert.deepEqual(found.map((row) => row.id), member ? ['rel-0', 'rel-2'] : ['rel-0']);
    assert.deepEqual(Object.keys(found[0]!).sort(), ['fromNodeId', 'id', 'label', 'toNodeId', 'type']);
  }
});
