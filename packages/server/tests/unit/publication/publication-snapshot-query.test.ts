import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { assembleSnapshotPages } from '@know-n/colp/semantic';
import {
  createPublicationCursorKeyring,
  getPublicationSnapshotPage,
  PublicationNotFoundError,
  PUBLICATION_SNAPSHOT_MAX_BYTES,
  PublicationSnapshotExpiredError,
  type PublicationCollectionRecord,
  type PublicationNodeRecord,
  type PublicationSnapshotQueryPorts,
  type PublicationSnapshotReadPort,
} from '../../../src/modules/publication/index.js';

const instant = '2026-07-24T00:00:00Z';

function collection(overrides: Partial<PublicationCollectionRecord> = {}): PublicationCollectionRecord {
  return {
    id: 'c', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Collection', summary: null,
    visibility: 'public', publicationSlug: 'pub', rootNodeId: 'r', contentRevision: 'c1',
    policyRevision: 'p1', createdAt: instant, updatedAt: instant, deletedAt: null, ...overrides,
  };
}

function node(id: string, overrides: Partial<PublicationNodeRecord> = {}): PublicationNodeRecord {
  return {
    id, collectionId: 'c', parentId: 'r', kind: 'bookmark', isRoot: false, title: id,
    url: `https://example.test/${id}`, description: null, tags: [], visibility: 'inherit',
    ancestorRestricted: false, position: id.toUpperCase(), resourceRevision: `rev-${id}`,
    createdAt: instant, updatedAt: instant, ...overrides,
  };
}

const root = node('r', {
  parentId: null, kind: 'folder', isRoot: true, title: 'Root', url: null, position: null,
});

function reader(records: readonly PublicationNodeRecord[], current = collection()): PublicationSnapshotReadPort {
  return {
    async loadPage(request) {
      const start = request.afterLocator
        ? Math.max(0, records.findIndex((item) => createHash('sha256').update(item.id).digest('hex').slice(0, 32) === request.afterLocator) + 1)
        : request.after
          ? Math.max(0, records.findIndex((item) => item.id === request.after?.nodeId) + 1)
          : 0;
      return {
        isolation: 'repeatable read',
        comparatorVersion: 'parent-position-id-v1',
        collection: current,
        root,
        candidates: records.slice(start, start + request.limit + 1),
      };
    },
  };
}

function ports(
  reads: PublicationSnapshotReadPort,
  options: { member?: boolean; now?: () => Date } = {},
): PublicationSnapshotQueryPorts {
  return {
    reads,
    cursors: createPublicationCursorKeyring({
      active: { id: 'v1', secret: Buffer.alloc(32, 13).toString('base64') },
      retained: [],
    }),
    accessPolicy: {
      async loadCollectionFacts() {
        return {
          collectionId: 'c', ownerSubjectId: 'owner', visibility: 'public', policyRevision: 'p1',
          membershipRole: options.member ? 'viewer' : null, deleted: false,
        };
      },
    },
    origin: 'https://known.example',
    now: options.now,
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  };
}

test('assembles revision-fenced first and continuation pages with stable sequence', async () => {
  const queryPorts = ports(reader([node('a'), node('b'), node('d'), node('e')]));
  const first = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3 },
  });
  assert.deepEqual(first.snapshot.nodes.map((item) => item.id), ['r', 'a', 'b']);
  assert.equal(first.snapshot.page.sequence, 1);
  assert.ok(first.nextCursor);
  const second = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' },
    query: { limit: 3, pageCursor: first.nextCursor! },
  });
  assert.deepEqual(second.snapshot.nodes.map((item) => item.id), ['d', 'e']);
  assert.equal(second.snapshot.page.sequence, 2);
  assert.equal(second.nextCursor, null);
  const assembly = assembleSnapshotPages([first.snapshot, second.snapshot], {
    publicationExtensionMode: 'producer',
  });
  assert.equal(assembly.valid, true);
  if (assembly.valid) assert.deepEqual(assembly.snapshot.nodes.map((item) => item.id), ['r', 'a', 'b', 'd', 'e']);
});

test('public projection removes restricted nodes and their descendants while member projection retains them', async () => {
  const records = [
    node('a'),
    node('b', { kind: 'folder', url: null, visibility: 'private' }),
    node('d', { parentId: 'b', ancestorRestricted: true }),
  ];
  const publicPage = await getPublicationSnapshotPage(ports(reader(records)), {
    collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 4 },
  });
  assert.deepEqual(publicPage.snapshot.nodes.map((item) => item.id), ['r', 'a']);

  const memberPage = await getPublicationSnapshotPage(ports(reader(records), { member: true }), {
    collectionId: 'c', principal: { kind: 'account', principalId: 'account', subjectId: 'member' },
    query: { limit: 4 },
  });
  assert.deepEqual(memberPage.snapshot.nodes.map((item) => item.id), ['r', 'a', 'b', 'd']);
  assert.equal(memberPage.projection, 'member');
});

test('public custom-root snapshots reject hide_public bookmarks instead of leaking their URL/title', async () => {
  const hiddenRoot = node('hidden-root', {
    parentId: null, isRoot: true, title: 'Secret bookmark', url: 'https://private.example/secret',
    moderationHidden: true,
  });
  const reads: PublicationSnapshotReadPort = {
    async loadPage() {
      return {
        isolation: 'repeatable read', comparatorVersion: 'parent-position-id-v1',
        collection: collection({ rootNodeId: hiddenRoot.id }), root: hiddenRoot, candidates: [],
      };
    },
  };
  await assert.rejects(
    () => getPublicationSnapshotPage(ports(reads), {
      collectionId: 'c', principal: { kind: 'anonymous' }, query: { root: hiddenRoot.id, limit: 2 },
    }),
    PublicationNotFoundError,
  );
});

test('publishes compact wire positions instead of leaking oversized internal position tokens', async () => {
  const internalPosition = '~'.repeat(512);
  const publicationPosition = '00000000000000000000';
  const page = await getPublicationSnapshotPage(ports(reader([
    node('long-position', { position: internalPosition, publicationPosition }),
  ])), {
    collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 2 },
  });
  assert.equal(page.snapshot.nodes[1]?.position, publicationPosition);
});

test('cursor tamper, cross-principal replay, expiry, and revision changes become snapshot_expired', async () => {
  let nowMs = Date.parse(instant);
  let current = collection();
  const mutableReader: PublicationSnapshotReadPort = {
    async loadPage(request) {
      return reader([node('a'), node('b'), node('d')], current).loadPage(request);
    },
  };
  const queryPorts = ports(mutableReader, { now: () => new Date(nowMs) });
  const first = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3 },
  });
  const cursor = first.nextCursor!;
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
  for (const [pageCursor, principal] of [
    [tampered, { kind: 'anonymous' }],
    [cursor, { kind: 'account', principalId: 'other', subjectId: 'other' }],
  ] as const) {
    await assert.rejects(
      () => getPublicationSnapshotPage(queryPorts, { collectionId: 'c', principal, query: { limit: 3, pageCursor } }),
      PublicationSnapshotExpiredError,
    );
  }
  nowMs += 15 * 60 * 1000;
  await assert.rejects(
    () => getPublicationSnapshotPage(queryPorts, {
      collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3, pageCursor: cursor },
    }),
    PublicationSnapshotExpiredError,
  );
  nowMs = Date.parse(instant);
  current = collection({ contentRevision: 'c2' });
  await assert.rejects(
    () => getPublicationSnapshotPage(queryPorts, {
      collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3, pageCursor: cursor },
    }),
    PublicationSnapshotExpiredError,
  );
});

test('continuations collapse missing, deleted, unpublished, and missing-root state to snapshot_expired', async () => {
  let currentCollection: PublicationCollectionRecord | null = collection();
  let currentRoot: PublicationNodeRecord | null = root;
  const mutableReader: PublicationSnapshotReadPort = {
    async loadPage(request) {
      const page = await reader([node('a'), node('b'), node('d')]).loadPage(request);
      return { ...page, collection: currentCollection, root: currentRoot };
    },
  };
  const queryPorts = ports(mutableReader);
  for (const queryScope of [{}, { root: 'requested-root' }] as const) {
    currentCollection = collection();
    currentRoot = root;
    const first = await getPublicationSnapshotPage(queryPorts, {
      collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3, ...queryScope },
    });
    assert.ok(first.nextCursor);

    for (const state of [
      { collection: null, root: null },
      { collection: collection({ deletedAt: instant }), root },
      { collection: collection({ publicationSlug: null }), root },
      { collection: collection(), root: null },
    ] as const) {
      currentCollection = state.collection;
      currentRoot = state.root;
      await assert.rejects(
        () => getPublicationSnapshotPage(queryPorts, {
          collectionId: 'c', principal: { kind: 'anonymous' },
          query: { limit: 3, ...queryScope, pageCursor: first.nextCursor! },
        }),
        PublicationSnapshotExpiredError,
      );
    }
  }
});

test('first pages retain resource_not_found for missing, deleted, unpublished, and missing-root state', async () => {
  for (const queryScope of [{}, { root: 'requested-root' }] as const) {
    for (const state of [
      { collection: null, root: null },
      { collection: collection({ deletedAt: instant }), root },
      { collection: collection({ publicationSlug: null }), root },
      { collection: collection(), root: null },
    ] as const) {
      const reads: PublicationSnapshotReadPort = {
        async loadPage(request) {
          const page = await reader([]).loadPage(request);
          return { ...page, collection: state.collection, root: state.root };
        },
      };
      await assert.rejects(
        () => getPublicationSnapshotPage(ports(reads), {
          collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3, ...queryScope },
        }),
        PublicationNotFoundError,
      );
    }
  }
});

test('comparator upgrades expire old cursors without changing the Snapshot wire revision', async () => {
  let comparatorVersion = 'parent-position-id-v0';
  const reads: PublicationSnapshotReadPort = {
    async loadPage(request) {
      const page = await reader([node('a'), node('b'), node('d')]).loadPage(request);
      return { ...page, comparatorVersion } as unknown as Awaited<ReturnType<PublicationSnapshotReadPort['loadPage']>>;
    },
  };
  const queryPorts = ports(reads);
  const first = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3 },
  });
  assert.equal(first.snapshot.revision, 'c1.p1');
  comparatorVersion = 'parent-position-id-v1';
  await assert.rejects(
    () => getPublicationSnapshotPage(queryPorts, {
      collectionId: 'c', principal: { kind: 'anonymous' },
      query: { limit: 3, pageCursor: first.nextCursor! },
    }),
    PublicationSnapshotExpiredError,
  );
});

test('continuation rejects a comparator change between fence read and anchored read', async () => {
  let loadCount = 0;
  const reads: PublicationSnapshotReadPort = {
    async loadPage(request) {
      loadCount += 1;
      const page = await reader([node('a'), node('b'), node('d'), node('e')]).loadPage(request);
      const comparatorVersion = loadCount === 3 ? 'parent-position-id-v0' : 'parent-position-id-v1';
      return { ...page, comparatorVersion } as unknown as Awaited<ReturnType<PublicationSnapshotReadPort['loadPage']>>;
    },
  };
  const queryPorts = ports(reads);
  const first = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3 },
  });
  await assert.rejects(
    () => getPublicationSnapshotPage(queryPorts, {
      collectionId: 'c', principal: { kind: 'anonymous' },
      query: { limit: 3, pageCursor: first.nextCursor! },
    }),
    PublicationSnapshotExpiredError,
  );
});

test('anonymous reads conceal private collections and unsafe Bookmark URLs fail closed', async () => {
  await assert.rejects(
    () => getPublicationSnapshotPage(ports(reader([], collection({ visibility: 'private' }))), {
      collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3 },
    }),
    PublicationNotFoundError,
  );
  await assert.rejects(
    () => getPublicationSnapshotPage(ports(reader([node('a', { url: 'file:///secret' })])), {
      collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3 },
    }),
    /Bookmark|Schema|snapshot/iu,
  );
});

test('fixed-size continuation supports maximum-length opaque ids within the COLP cursor budget', async () => {
  const longId = `n${'x'.repeat(127)}`;
  const queryPorts = ports(reader([node(longId, { resourceRevision: 'long-id-revision' }), node('after-long-id')]));
  const first = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 2 },
  });
  assert.ok(first.nextCursor);
  assert.ok(first.nextCursor.length <= 128);
  const second = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' },
    query: { limit: 2, pageCursor: first.nextCursor },
  });
  assert.deepEqual(second.snapshot.nodes.map((item) => item.id), ['after-long-id']);
});

test('public filtering advances the continuation by raw candidates across an empty visible page', async () => {
  const queryPorts = ports(reader([
    node('hidden-a', { visibility: 'private' }),
    node('hidden-b', { visibility: 'protected' }),
    node('visible-c'),
    node('visible-d'),
  ]));
  const first = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 3 },
  });
  assert.deepEqual(first.snapshot.nodes.map((item) => item.id), ['r']);
  assert.ok(first.nextCursor);
  const second = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' },
    query: { limit: 3, pageCursor: first.nextCursor },
  });
  assert.deepEqual(second.snapshot.nodes.map((item) => item.id), ['visible-c', 'visible-d']);
  assert.equal(second.nextCursor, null);
});

test('shrinks a page at a raw-node boundary to stay within the 4 MiB wire budget', async () => {
  const records = Array.from({ length: 300 }, (_, index) => node(`large-${String(index).padStart(3, '0')}`, {
    description: 'x'.repeat(20_000),
  }));
  const queryPorts = ports(reader(records));
  const first = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' }, query: { limit: 301 },
  });
  assert.ok(first.byteLength <= PUBLICATION_SNAPSHOT_MAX_BYTES);
  assert.ok(first.snapshot.nodes.length < 301);
  assert.ok(first.nextCursor);
  const second = await getPublicationSnapshotPage(queryPorts, {
    collectionId: 'c', principal: { kind: 'anonymous' },
    query: { limit: 301, pageCursor: first.nextCursor },
  });
  assert.ok(second.byteLength <= PUBLICATION_SNAPSHOT_MAX_BYTES);
  assert.equal(first.snapshot.nodes.length + second.snapshot.nodes.length, 301);
});

test('authenticated non-members select public filtering before any candidate scan', async () => {
  const requests: Parameters<PublicationSnapshotReadPort['loadPage']>[0][] = [];
  const base = reader([node('a'), node('b'), node('d')]);
  const queryPorts = ports({ async loadPage(request) { requests.push(request); return base.loadPage(request); } });
  const principal = { kind: 'account' as const, principalId: 'outsider', subjectId: 'outsider' };
  const first = await getPublicationSnapshotPage(queryPorts, { collectionId: 'c', principal, query: { limit: 2 } });
  assert.equal(requests[0]?.metadataOnly, true);
  assert.equal(requests[1]?.projection, 'public');
  assert.ok(first.nextCursor);
  await getPublicationSnapshotPage(queryPorts, { collectionId: 'c', principal,
    query: { limit: 2, pageCursor: first.nextCursor } });
  assert.equal(requests.at(-1)?.projection, 'public');
});
