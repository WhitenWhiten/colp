/**
 * P1-14 complementary editor correctness: cursor fencing, multi-page assembly,
 * and concurrency isolation (not timing SLA).
 *
 * Full 10k page-without-mix coverage lives in editor-page-query-authorization.test.ts; this suite
 * adds fence stability, dual-collection isolation, and mid-size full-walk invariants
 * without deleting or relaxing that evidence.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type {
  AccessPolicyFactsPort,
  CollectionVisibility,
  MembershipRole,
  ResourcePolicyFacts,
} from '../../../src/modules/access-policy/index.js';
import {
  EDITOR_PAGE_DEFAULT_LIMIT,
  EDITOR_PAGE_MAX_BYTES,
  SnapshotExpiredError,
  createProductEditorCursorSigner,
  getCollectionEditorPage,
  type CollectionEditorSnapshot,
  type EditorCollectionRow,
  type EditorLiveNodeRow,
  type EditorPage,
  type EditorRootNodeRow,
  type GetCollectionEditorPageInput,
  type GetCollectionEditorPagePorts,
  type ProductEditorCursorAfter,
} from '../../../src/modules/collections/index.js';

// ---------------------------------------------------------------------------
// Fixtures (aligned with editor-page-query memory ports)
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-22T12:00:00.000Z');
const CURSOR_KEY = 'product-editor-cursor-p1-14-key';
const CONTENT_REV = 'content-rev-p114';
const POLICY_REV = 'policy-rev-p114';
const RESOURCE_REV = 'resource-rev-p114';
const CHILDREN_REV = 'children-rev-p114';

interface MemoryMembership {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
}

interface MemoryState {
  now: Date;
  collections: Map<string, EditorCollectionRow>;
  roots: Map<string, EditorRootNodeRow>;
  owners: Map<string, string>;
  nodes: EditorLiveNodeRow[];
  memberships: MemoryMembership[];
  cursorKey: string;
}

function createState(): MemoryState {
  return {
    now: new Date(NOW),
    collections: new Map(),
    roots: new Map(),
    owners: new Map(),
    nodes: [],
    memberships: [],
    cursorKey: CURSOR_KEY,
  };
}

function seedCollection(
  state: MemoryState,
  options: {
    collectionId: string;
    rootId: string;
    principalId: string;
    subjectId: string;
    title?: string;
    visibility?: CollectionVisibility;
    contentRevision?: string;
    policyRevision?: string;
  },
): void {
  const createdAt = new Date(state.now);
  state.collections.set(options.collectionId, {
    id: options.collectionId,
    kind: 'bookmarks',
    title: options.title ?? options.collectionId,
    summary: null,
    visibility: options.visibility ?? 'private',
    rootNodeId: options.rootId,
    resourceRevision: RESOURCE_REV,
    contentRevision: options.contentRevision ?? CONTENT_REV,
    policyRevision: options.policyRevision ?? POLICY_REV,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
  state.roots.set(options.collectionId, {
    id: options.rootId,
    collectionId: options.collectionId,
    title: options.title ?? options.collectionId,
    description: null,
    tags: [],
    resourceRevision: RESOURCE_REV,
    childrenRevision: CHILDREN_REV,
    createdAt,
    updatedAt: createdAt,
  });
  state.owners.set(options.collectionId, options.subjectId);
  state.memberships.push({
    collectionId: options.collectionId,
    subjectId: options.subjectId,
    role: 'owner',
  });
}

function addBookmark(
  state: MemoryState,
  input: {
    id: string;
    collectionId: string;
    parentId: string;
    positionToken: string;
    title?: string;
  },
): void {
  const createdAt = new Date(state.now);
  state.nodes.push({
    id: input.id,
    collectionId: input.collectionId,
    parentId: input.parentId,
    kind: 'bookmark',
    title: input.title ?? input.id,
    url: 'https://example.com/',
    description: null,
    tags: [],
    positionToken: input.positionToken,
    resourceRevision: `rev-${input.id}`,
    childrenRevision: `ch-${input.id}`,
    createdAt,
    updatedAt: createdAt,
  });
}

function compareLiveNodes(a: EditorLiveNodeRow, b: EditorLiveNodeRow): number {
  if (a.parentId < b.parentId) return -1;
  if (a.parentId > b.parentId) return 1;
  if (a.positionToken < b.positionToken) return -1;
  if (a.positionToken > b.positionToken) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function sortedNodes(state: MemoryState, collectionId: string): EditorLiveNodeRow[] {
  return state.nodes
    .filter((n) => n.collectionId === collectionId)
    .slice()
    .sort(compareLiveNodes);
}

function isAfter(node: EditorLiveNodeRow, after: ProductEditorCursorAfter): boolean {
  if (node.parentId > after.parentKey) return true;
  if (node.parentId < after.parentKey) return false;
  if (node.positionToken > after.positionKey) return true;
  if (node.positionToken < after.positionKey) return false;
  return node.id > after.nodeId;
}

function createMemoryPorts(state: MemoryState): GetCollectionEditorPagePorts {
  const accessPolicy: AccessPolicyFactsPort = {
    async loadCollectionFacts(input) {
      const collection = state.collections.get(input.collectionId);
      if (!collection) return null;
      const membership = state.memberships.find(
        (m) => m.collectionId === input.collectionId && m.subjectId === input.actorSubjectId,
      );
      const facts: ResourcePolicyFacts = {
        collectionId: collection.id,
        ownerSubjectId: state.owners.get(input.collectionId) ?? 'unknown-owner',
        visibility: collection.visibility,
        policyRevision: collection.policyRevision,
        membershipRole: membership?.role ?? null,
        deleted: collection.deletedAt !== null,
      };
      return facts;
    },
  };

  return {
    clock: {
      now: async () => new Date(state.now),
    },
    collections: {
      async lockForShare(collectionId) {
        const collection = state.collections.get(collectionId);
        if (!collection) return null;
        return {
          id: collection.id,
          ownerSubjectId: state.owners.get(collectionId) ?? 'unknown-owner',
          title: collection.title,
          summary: collection.summary,
          kind: collection.kind,
          visibility: collection.visibility,
          allowSearchIndexing: collection.allowSearchIndexing ?? false,
          publicationSlug: collection.publicationSlug ?? null,
          publishedAt: collection.publishedAt ?? null,
          rootNodeId: collection.rootNodeId,
          resourceRevision: collection.resourceRevision,
          contentRevision: collection.contentRevision,
          policyRevision: collection.policyRevision,
          commitOrdinal: 0n,
          createdAt: collection.createdAt,
          updatedAt: collection.updatedAt,
          deletedAt: collection.deletedAt,
        };
      },
    },
    accessPolicy,
    cursorSigner: createProductEditorCursorSigner({ current: { id: 'test-v1', key: state.cursorKey } }),
    loadSnapshot: {
      async loadCollectionEditorSnapshot(input) {
        const collection = state.collections.get(input.collectionId);
        const root = state.roots.get(input.collectionId);
        if (!collection || !root) return null;
        let rows = sortedNodes(state, input.collectionId);
        if (input.after) {
          rows = rows.filter((n) => isAfter(n, input.after!));
        }
        const page = rows.slice(0, input.limit + 1).map((n) => ({ ...n }));
        const snapshot: CollectionEditorSnapshot = {
          collection: { ...collection },
          root: { ...root },
          nodes: page,
        };
        return snapshot;
      },
    },
  };
}

function ownerInput(
  collectionId: string,
  principalId: string,
  subjectId: string,
  overrides: Partial<GetCollectionEditorPageInput> = {},
): GetCollectionEditorPageInput {
  return {
    actor: { principalId, subjectId },
    collectionId,
    ...overrides,
  };
}

async function pageAll(
  ports: GetCollectionEditorPagePorts,
  collectionId: string,
  principalId: string,
  subjectId: string,
  limit = EDITOR_PAGE_DEFAULT_LIMIT,
): Promise<{ pages: EditorPage[]; ids: string[] }> {
  const pages: EditorPage[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let guard = 0; guard < 500; guard += 1) {
    const input = cursor
      ? ownerInput(collectionId, principalId, subjectId, { cursor })
      : ownerInput(collectionId, principalId, subjectId, { limit });
    const page = await getCollectionEditorPage(ports, input);
    pages.push(page);
    for (const node of page.nodes) {
      assert.ok(!seen.has(node.id), `duplicate ${node.id} in ${collectionId}`);
      seen.add(node.id);
      ids.push(node.id);
    }
    if (!page.page.hasMore) {
      assert.equal(page.page.nextCursor, null);
      break;
    }
    assert.ok(page.page.nextCursor);
    cursor = page.page.nextCursor;
  }

  return { pages, ids };
}

function seedLinearTree(
  state: MemoryState,
  collectionId: string,
  rootId: string,
  principalId: string,
  subjectId: string,
  count: number,
  idPrefix: string,
): void {
  seedCollection(state, { collectionId, rootId, principalId, subjectId });
  for (let i = 0; i < count; i += 1) {
    addBookmark(state, {
      id: `${idPrefix}-${String(i).padStart(5, '0')}`,
      collectionId,
      parentId: rootId,
      positionToken: String(i).padStart(6, '0'),
      title: `${idPrefix} ${i}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Contract anchors for P1-14 evidence
// ---------------------------------------------------------------------------

describe('P1-14 editor contract anchors', () => {
  test('default page limit 200 and 4 MiB page budget remain product constants', () => {
    assert.equal(EDITOR_PAGE_DEFAULT_LIMIT, 200);
    assert.equal(EDITOR_PAGE_MAX_BYTES, 4 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Mid-size full walk + cursor fence stability
// ---------------------------------------------------------------------------

describe('P1-14 mid-size paging and cursor fence', () => {
  test('1200-node linear tree pages without mix/drop and stable snapshot fence', async () => {
    const NODE_COUNT = 1200;
    const state = createState();
    seedLinearTree(
      state,
      'col-fence-a',
      'root-fence-a',
      'principal-a',
      'subject-a',
      NODE_COUNT,
      'na',
    );

    const ports = createMemoryPorts(state);
    const expected = sortedNodes(state, 'col-fence-a').map((n) => n.id);
    const { pages, ids } = await pageAll(ports, 'col-fence-a', 'principal-a', 'subject-a', 200);

    assert.deepEqual(ids, expected);
    assert.ok(pages.length >= Math.ceil(NODE_COUNT / 200));

    const first = pages[0]!;
    for (const page of pages) {
      assert.equal(page.page.snapshotId, first.page.snapshotId);
      assert.equal(page.page.contentRevision, first.page.contentRevision);
      assert.equal(page.page.policyRevision, first.page.policyRevision);
      assert.equal(page.page.contentRevision, CONTENT_REV);
      assert.equal(page.page.policyRevision, POLICY_REV);
    }
  });

  test('contentRevision bump mid-walk fails closed with snapshot_expired', async () => {
    const state = createState();
    seedLinearTree(
      state,
      'col-fence-b',
      'root-fence-b',
      'principal-b',
      'subject-b',
      50,
      'nb',
    );
    const ports = createMemoryPorts(state);
    const first = await getCollectionEditorPage(
      ports,
      ownerInput('col-fence-b', 'principal-b', 'subject-b', { limit: 10 }),
    );
    assert.ok(first.page.nextCursor);

    const collection = state.collections.get('col-fence-b')!;
    state.collections.set('col-fence-b', {
      ...collection,
      contentRevision: 'content-rev-bumped',
    });

    await assert.rejects(
      () => getCollectionEditorPage(
        ports,
        ownerInput('col-fence-b', 'principal-b', 'subject-b', {
          cursor: first.page.nextCursor!,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof SnapshotExpiredError);
        assert.equal((error as { code?: string }).code, 'snapshot_expired');
        return true;
      },
    );
  });

  test('cursor is exclusive: second page never re-emits first page ids', async () => {
    const state = createState();
    seedLinearTree(
      state,
      'col-fence-c',
      'root-fence-c',
      'principal-c',
      'subject-c',
      25,
      'nc',
    );
    const ports = createMemoryPorts(state);
    const first = await getCollectionEditorPage(
      ports,
      ownerInput('col-fence-c', 'principal-c', 'subject-c', { limit: 10 }),
    );
    assert.equal(first.nodes.length, 10);
    assert.ok(first.page.nextCursor);

    const second = await getCollectionEditorPage(
      ports,
      ownerInput('col-fence-c', 'principal-c', 'subject-c', {
        cursor: first.page.nextCursor!,
      }),
    );
    const firstIds = new Set(first.nodes.map((n) => n.id));
    for (const node of second.nodes) {
      assert.ok(!firstIds.has(node.id), `cursor not exclusive: ${node.id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency isolation (correctness only — no timing SLA)
// ---------------------------------------------------------------------------

describe('P1-14 concurrency isolation correctness', () => {
  test('parallel full walks on two collections never mix node identities', async () => {
    const PER_COLLECTION = 400;
    const state = createState();
    seedLinearTree(
      state,
      'col-iso-a',
      'root-iso-a',
      'principal-iso-a',
      'subject-iso-a',
      PER_COLLECTION,
      'ia',
    );
    seedLinearTree(
      state,
      'col-iso-b',
      'root-iso-b',
      'principal-iso-b',
      'subject-iso-b',
      PER_COLLECTION,
      'ib',
    );

    const ports = createMemoryPorts(state);
    const [walkA, walkB] = await Promise.all([
      pageAll(ports, 'col-iso-a', 'principal-iso-a', 'subject-iso-a', 100),
      pageAll(ports, 'col-iso-b', 'principal-iso-b', 'subject-iso-b', 100),
    ]);

    assert.equal(walkA.ids.length, PER_COLLECTION);
    assert.equal(walkB.ids.length, PER_COLLECTION);
    assert.deepEqual(walkA.ids, sortedNodes(state, 'col-iso-a').map((n) => n.id));
    assert.deepEqual(walkB.ids, sortedNodes(state, 'col-iso-b').map((n) => n.id));

    const setA = new Set(walkA.ids);
    for (const id of walkB.ids) {
      assert.ok(!setA.has(id), `cross-collection mix: ${id}`);
    }

    // Fence identity must stay collection-local
    assert.notEqual(walkA.pages[0]!.page.snapshotId, walkB.pages[0]!.page.snapshotId);
    for (const page of walkA.pages) {
      assert.equal(page.collection.id, 'col-iso-a');
    }
    for (const page of walkB.pages) {
      assert.equal(page.collection.id, 'col-iso-b');
    }
  });

  test('concurrent first-page readers on same collection share fence revisions', async () => {
    const state = createState();
    seedLinearTree(
      state,
      'col-iso-c',
      'root-iso-c',
      'principal-iso-c',
      'subject-iso-c',
      80,
      'ic',
    );
    const ports = createMemoryPorts(state);
    const input = ownerInput('col-iso-c', 'principal-iso-c', 'subject-iso-c', { limit: 20 });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => getCollectionEditorPage(ports, input)),
    );

    const head = results[0]!;
    for (const page of results) {
      // content/policy revisions are the authoritative fence; snapshotId is issued per first page.
      assert.equal(page.page.contentRevision, head.page.contentRevision);
      assert.equal(page.page.policyRevision, head.page.policyRevision);
      assert.equal(page.page.contentRevision, CONTENT_REV);
      assert.equal(page.page.policyRevision, POLICY_REV);
      assert.deepEqual(
        page.nodes.map((n) => n.id),
        head.nodes.map((n) => n.id),
      );
    }
  });

  test('cursor from collection A is rejected when presented against collection B', async () => {
    const state = createState();
    seedLinearTree(state, 'col-x', 'root-x', 'principal-x', 'subject-x', 30, 'x');
    seedLinearTree(state, 'col-y', 'root-y', 'principal-y', 'subject-y', 30, 'y');
    // Same principal cannot reuse A cursor on B — cursor binds collectionId.
    // Use distinct principals that own each tree so authorization is not the fail mode.
    const ports = createMemoryPorts(state);
    const firstA = await getCollectionEditorPage(
      ports,
      ownerInput('col-x', 'principal-x', 'subject-x', { limit: 5 }),
    );
    assert.ok(firstA.page.nextCursor);

    await assert.rejects(
      () => getCollectionEditorPage(
        ports,
        ownerInput('col-y', 'principal-y', 'subject-y', {
          cursor: firstA.page.nextCursor!,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, 'invalid_cursor');
        return true;
      },
    );
  });
});

