import assert from 'node:assert/strict';
import { assembleSnapshotPages } from '@know-n/colp/semantic';
import type { Snapshot } from '@know-n/colp/types';
import { afterAll, beforeAll, test } from 'vitest';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import {
  buildPublicationAnnotationCandidateStatement,
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPublicationCursorKeyring,
  getPublicationSnapshotPage,
  type PublicationAnnotationPosition,
  type PublicationRelationPosition,
  type PublicationSnapshotQueryPorts,
} from '../../../src/modules/publication/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://known.example';
const INSTANT = '2026-07-25T08:00:00.000Z';

const MEMBER_ACCOUNT = 'r13-member-account';
const MEMBER_SUBJECT = 'r13-member-subject';
const OTHER_ACCOUNT = 'r13-other-account';
const OTHER_SUBJECT = 'r13-other-subject';

const MIXED_COLLECTION = 'r13-mixed-collection';
const MIXED_ROOT = 'r13-mixed-root';
const MIXED_VISIBLE_PARENT = 'r13-visible-parent';
const MIXED_PUBLIC = 'r13-public';
const MIXED_DEEP = 'r13-deep';
const MIXED_PRIVATE_PARENT = 'r13-private-parent';
const MIXED_PRIVATE_CHILD = 'r13-private-child';
const MIXED_PROTECTED_PARENT = 'r13-protected-parent';
const MIXED_PROTECTED_CHILD = 'r13-protected-child';
const MIXED_ORPHAN = 'r13-orphan';

const CYCLE_COLLECTION = 'r13-cycle-collection';
const CYCLE_ROOT = 'r13-cycle-root';
const CYCLE_A = 'r13-cycle-a';
const CYCLE_B = 'r13-cycle-b';

const MISSING_COLLECTION = 'r13-missing-collection';
const MISSING_ROOT = 'r13-missing-root';
const MISSING_NODE = 'r13-missing-node';

const DEEP_COLLECTION = 'r13-deep-collection';
const DEEP_ROOT = 'r13-deep-root';
const DEEP_CHAIN_ROOT = 'r13-deep-chain-root';
const DEEP_CHAIN_DEPTH = 1_025;

const INTERLEAVED_COLLECTION = 'r13-interleaved-collection';
const INTERLEAVED_ROOT = 'r13-zzz-root';
const INTERLEAVED_PRIVATE_PARENT = 'r13-aaa-private-parent';
const INTERLEAVED_RESTRICTED_PREFIX = 'r13-aaa-restricted-';
const INTERLEAVED_VISIBLE_PREFIX = 'r13-bbb-visible-';
const INTERLEAVED_VISIBLE_COUNT = 400;

const MAX_DEPTH = 2; // mixed tree: root(0) -> folder(1) -> bookmark(2)

describeWithPostgres('R13 page-level ancestry CTE', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('page_level_ancestry_cte', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedAccounts();
    await seedMixedCollection();
    await seedCycleCollection();
    await seedMissingParentCollection();
    await seedDeepCollection();
    await seedInterleavedCollection();
    await reloadReferenceModel();
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
  });

  // ---------------------------------------------------------------------------
  // Pure-TS reference evaluator. It models the intended fail-closed semantics in
  // memory (a visited-set walk) rather than mirroring the recursive SQL, so the
  // comparison cannot pass by duplicating the production algorithm.
  // ---------------------------------------------------------------------------

  interface RefNode {
    id: string; parentId: string | null; visibility: string; deleted: boolean;
  }
  interface RefAnnotation {
    id: string; collectionId: string; subjectType: 'collection' | 'node'; subjectId: string;
    visibility: string; deleted: boolean; creatorPrincipalId: string;
  }
  interface RefRelation {
    id: string; collectionId: string; fromNodeId: string; toNodeId: string; type: string;
    visibility: string; deleted: boolean;
  }
  const model = {
    nodes: new Map<string, RefNode>(),
    annotations: new Map<string, RefAnnotation>(),
    relations: new Map<string, RefRelation>(),
    collectionVisibility: new Map<string, string>(),
  };

  async function reloadReferenceModel(): Promise<void> {
    const allCollections = [MIXED_COLLECTION, CYCLE_COLLECTION, MISSING_COLLECTION, DEEP_COLLECTION, INTERLEAVED_COLLECTION];
    const nodeRows = await isolated.runtime.pool.query(
      `select id, parent_id, visibility, deleted_at from nodes where collection_id = any($1::text[])`,
      [allCollections],
    );
    for (const row of nodeRows.rows) {
      model.nodes.set(row.id as string, {
        id: row.id, parentId: row.parent_id as string | null, visibility: row.visibility,
        deleted: row.deleted_at !== null,
      });
    }
    const annotationRows = await isolated.runtime.pool.query(
      `select id, collection_id, subject_type, subject_id, visibility, creator_principal_id, deleted_at
         from annotations where collection_id = any($1::text[])`,
      [allCollections],
    );
    for (const row of annotationRows.rows) {
      model.annotations.set(row.id as string, {
        id: row.id, collectionId: row.collection_id as string,
        subjectType: row.subject_type as 'collection' | 'node', subjectId: row.subject_id,
        visibility: row.visibility, deleted: row.deleted_at !== null,
        creatorPrincipalId: row.creator_principal_id,
      });
    }
    const relationRows = await isolated.runtime.pool.query(
      `select id, collection_id, from_node_id, to_node_id, type, visibility, deleted_at
         from relations where collection_id = any($1::text[])`,
      [allCollections],
    );
    for (const row of relationRows.rows) {
      model.relations.set(row.id as string, {
        id: row.id, collectionId: row.collection_id as string,
        fromNodeId: row.from_node_id, toNodeId: row.to_node_id, type: row.type,
        visibility: row.visibility, deleted: row.deleted_at !== null,
      });
    }
    const collectionRows = await isolated.runtime.pool.query(
      `select id, visibility from collections where id = any($1::text[])`,
      [allCollections],
    );
    for (const row of collectionRows.rows) {
      model.collectionVisibility.set(row.id as string, row.visibility as string);
    }
  }

  function compareTuple(...pairs: Array<[string, string]>): number {
    for (const [a, b] of pairs) {
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  }

  function ancestorFacts(nodeId: string, cap = 1_024): {
    restricted: boolean; hasPrivate: boolean; hasProtected: boolean; hasCycle: boolean; reachedTop: boolean;
  } {
    const seen = new Set<string>();
    let current: string | null = nodeId;
    let distance = 0;
    let hasCycle = false;
    let hasPrivate = false;
    let hasProtected = false;
    let reachedTop = false;
    while (current !== null) {
      if (seen.has(current)) { hasCycle = true; break; }
      seen.add(current);
      const node = model.nodes.get(current);
      if (node === undefined) break; // missing parent
      if (distance >= 1) {
        if (node.visibility === 'private') hasPrivate = true;
        if (node.visibility === 'protected') hasProtected = true;
      }
      if (node.parentId === null) { reachedTop = true; break; }
      if (distance >= cap) break; // depth truncation
      current = node.parentId;
      distance += 1;
    }
    return {
      restricted: hasPrivate || hasProtected || hasCycle || !reachedTop,
      hasPrivate, hasProtected, hasCycle, reachedTop,
    };
  }

  function childrenById(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const node of model.nodes.values()) {
      if (node.parentId === null) continue;
      const siblings = out.get(node.parentId) ?? [];
      siblings.push(node.id);
      out.set(node.parentId, siblings);
    }
    return out;
  }

  function computeScope(rootId: string, depth: number): Map<string, number> | null {
    const children = childrenById();
    const out = new Map<string, number>();
    const root = model.nodes.get(rootId);
    if (!root || root.deleted) return out;
    out.set(rootId, 0);
    let frontier = [rootId];
    for (let d = 1; d <= depth; d += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const child of children.get(id) ?? []) {
          const node = model.nodes.get(child);
          if (!node || node.deleted || out.has(child)) continue;
          out.set(child, d);
          next.push(child);
        }
      }
      frontier = next;
    }
    return out;
  }

  function annotationVisible(
    ann: RefAnnotation,
    projection: 'public' | 'member',
    principalId: string | undefined,
    scope: Map<string, number> | null,
  ): boolean {
    if (ann.deleted) return false;
    if (projection === 'public') {
      if (ann.visibility !== 'public' && ann.visibility !== 'unlisted') return false;
      if (ann.subjectType === 'collection') return true;
      const subject = model.nodes.get(ann.subjectId);
      if (!subject || subject.deleted) return false;
      if (scope !== null && !scope.has(ann.subjectId)) return false;
      if (subject.visibility !== 'inherit') return false;
      return !ancestorFacts(ann.subjectId).restricted;
    }
    if (ann.visibility === 'private' && ann.creatorPrincipalId !== principalId) return false;
    if (ann.subjectType !== 'collection') {
      const subject = model.nodes.get(ann.subjectId);
      if (!subject || subject.deleted) return false;
      if (scope !== null && !scope.has(ann.subjectId)) return false;
    }
    return true;
  }

  function referenceAnnotationPage(
    collectionId: string,
    projection: 'public' | 'member',
    principalId: string | undefined,
    limit: number,
    after: PublicationAnnotationPosition | undefined,
    scope: Map<string, number> | null,
  ): Array<{ id: string; subjectType: string; subjectId: string; visibility: string;
    subjectVisibility: string | null; subjectAncestorRestricted: boolean }> {
    const all = [...model.annotations.values()]
      .filter((a) => !a.deleted && a.collectionId === collectionId)
      .sort((a, b) => compareTuple([a.subjectType, b.subjectType], [a.subjectId, b.subjectId], [a.id, b.id]));
    const page: Array<{ id: string; subjectType: string; subjectId: string; visibility: string;
      subjectVisibility: string | null; subjectAncestorRestricted: boolean }> = [];
    let started = after === undefined;
    for (const ann of all) {
      if (!started) {
        if (after !== undefined && ann.subjectType === after.subjectType
          && ann.subjectId === after.subjectId && ann.id === after.annotationId) {
          started = true;
        }
        continue;
      }
      if (page.length > limit) break;
      if (!annotationVisible(ann, projection, principalId, scope)) continue;
      const subjectVisibility = ann.subjectType === 'collection'
        ? model.collectionVisibility.get(ann.subjectId) ?? null
        : (model.nodes.get(ann.subjectId)?.visibility ?? null);
      page.push({
        id: ann.id, subjectType: ann.subjectType, subjectId: ann.subjectId, visibility: ann.visibility,
        subjectVisibility,
        subjectAncestorRestricted: ann.subjectType === 'collection'
          ? false : ancestorFacts(ann.subjectId).restricted,
      });
    }
    return page;
  }

  function endpointFacts(
    nodeId: string,
    scope: { rootId: string; depth: number } | null,
  ): { visibility: string; authorized: boolean; ancestorVisibility: 'private' | 'protected' | null;
    ancestorRestricted: boolean } {
    const node = model.nodes.get(nodeId);
    const live = node !== undefined && !node.deleted;
    const visibility = live ? node.visibility : 'private';
    let authorized = live;
    let ancestorVisibility: 'private' | 'protected' | null = null;
    let ancestorRestricted = !live;
    if (live) {
      const facts = ancestorFacts(nodeId);
      ancestorRestricted = facts.restricted;
      ancestorVisibility = facts.hasPrivate ? 'private'
        : facts.hasProtected ? 'protected'
        : (facts.hasCycle || !facts.reachedTop) ? 'private' : null;
      if (scope !== null) authorized = live && scopeReachable(nodeId, scope);
    }
    return { visibility, authorized, ancestorVisibility, ancestorRestricted };
  }

  function scopeReachable(nodeId: string, scope: { rootId: string; depth: number }): boolean {
    const seen = new Set<string>();
    let current: string | null = nodeId;
    let distance = 0;
    while (current !== null) {
      const node = model.nodes.get(current);
      if (!node || node.deleted) return false; // all-live path violated
      if (current === scope.rootId) return distance <= scope.depth;
      if (distance >= scope.depth) return false;
      if (seen.has(current)) return false;
      seen.add(current);
      current = node.parentId;
      distance += 1;
    }
    return false;
  }

  function referenceRelationPage(
    collectionId: string,
    limit: number,
    after: PublicationRelationPosition | undefined,
    scope: { rootId: string; depth: number } | null,
  ): Array<{ id: string; fromNodeId: string; toNodeId: string; type: string; visibility: string;
    fromVisibility: string; toVisibility: string; fromAuthorized: boolean; toAuthorized: boolean;
    fromAncestorVisibility: 'private' | 'protected' | null; toAncestorVisibility: 'private' | 'protected' | null;
    fromAncestorRestricted: boolean; toAncestorRestricted: boolean }> {
    const all = [...model.relations.values()]
      .filter((r) => !r.deleted && r.collectionId === collectionId)
      .sort((a, b) => compareTuple(
        [a.fromNodeId, b.fromNodeId], [a.toNodeId, b.toNodeId], [a.type, b.type], [a.id, b.id],
      ));
    const page: Array<{ id: string; fromNodeId: string; toNodeId: string; type: string; visibility: string;
      fromVisibility: string; toVisibility: string; fromAuthorized: boolean; toAuthorized: boolean;
      fromAncestorVisibility: 'private' | 'protected' | null; toAncestorVisibility: 'private' | 'protected' | null;
      fromAncestorRestricted: boolean; toAncestorRestricted: boolean }> = [];
    let started = after === undefined;
    for (const rel of all) {
      if (!started) {
        if (after !== undefined && rel.fromNodeId === after.fromNodeId
          && rel.toNodeId === after.toNodeId && rel.type === after.type
          && rel.id === after.relationId) {
          started = true;
        }
        continue;
      }
      if (page.length > limit) break;
      const from = endpointFacts(rel.fromNodeId, scope);
      const to = endpointFacts(rel.toNodeId, scope);
      // Public pagination counts only publicly visible relations/endpoints.
      // The reference walks the in-memory graph independently of the SQL.
      if (!['public', 'unlisted'].includes(rel.visibility)
        || from.visibility !== 'inherit' || to.visibility !== 'inherit'
        || from.ancestorRestricted || to.ancestorRestricted) continue;
      page.push({
        id: rel.id, fromNodeId: rel.fromNodeId, toNodeId: rel.toNodeId, type: rel.type,
        visibility: rel.visibility,
        fromVisibility: from.visibility, toVisibility: to.visibility,
        fromAuthorized: from.authorized, toAuthorized: to.authorized,
        fromAncestorVisibility: from.ancestorVisibility, toAncestorVisibility: to.ancestorVisibility,
        fromAncestorRestricted: from.ancestorRestricted, toAncestorRestricted: to.ancestorRestricted,
      });
    }
    return page;
  }

  function referenceAppAnnotationIds(): string[] {
    return [...model.annotations.values()]
      .filter((a) => !a.deleted && a.collectionId === MIXED_COLLECTION)
      .filter((a) => annotationVisible(a, 'public', undefined, null))
      .sort((a, b) => compareTuple([a.subjectType, b.subjectType], [a.subjectId, b.subjectId], [a.id, b.id]))
      .map((a) => a.id);
  }

  function referenceAppRelationIds(): string[] {
    const collectionRank = (visibility: string): number =>
      visibility === 'private' ? 2 : visibility === 'protected' ? 1 : 0;
    const endpointRank = (visibility: string, ancestorVisibility: 'private' | 'protected' | null): number =>
      visibility === 'private' || ancestorVisibility === 'private' ? 2
        : visibility === 'protected' || ancestorVisibility === 'protected' ? 1 : 0;
    return [...model.relations.values()]
      .filter((r) => !r.deleted && r.collectionId === MIXED_COLLECTION)
      .sort((a, b) => compareTuple(
        [a.fromNodeId, b.fromNodeId], [a.toNodeId, b.toNodeId], [a.type, b.type], [a.id, b.id],
      ))
      .filter((r) => {
        const from = endpointFacts(r.fromNodeId, null);
        const to = endpointFacts(r.toNodeId, null);
        if (!from.authorized || !to.authorized) return false;
        const rank = collectionRank(r.visibility);
        if (rank < collectionRank(model.collectionVisibility.get(MIXED_COLLECTION) ?? 'public')) return false;
        if (rank < endpointRank(from.visibility, from.ancestorVisibility)) return false;
        if (rank < endpointRank(to.visibility, to.ancestorVisibility)) return false;
        if (r.visibility !== 'public' && r.visibility !== 'unlisted') return false;
        return from.visibility === 'inherit' && !from.ancestorRestricted
          && to.visibility === 'inherit' && !to.ancestorRestricted;
      })
      .map((r) => r.id);
  }

  // ---------------------------------------------------------------------------
  // Port-level page-by-page comparisons against the reference evaluator.
  // ---------------------------------------------------------------------------

  async function assertAnnotationPagingMatches(options: {
    projection: 'public' | 'member';
    principalId?: string;
    limit: number;
    rootId?: string;
    depth?: number;
  }): Promise<void> {
    const port = createPostgresPublicationAnnotationReadPort(isolated.runtime, { origin: ORIGIN });
    const scope = options.rootId === undefined ? null : computeScope(options.rootId, options.depth ?? 1_024);
    let after: PublicationAnnotationPosition | undefined;
    let iterations = 0;
    while (true) {
      const portPage = await port.loadPage({
        collectionId: MIXED_COLLECTION, projection: options.projection, limit: options.limit,
        ...(options.principalId ? { principalId: options.principalId } : {}),
        ...(options.rootId ? { rootId: options.rootId } : {}),
        ...(options.depth !== undefined ? { depth: options.depth } : {}),
        ...(after ? { after } : {}),
      });
      const referencePage = referenceAnnotationPage(
        MIXED_COLLECTION, options.projection, options.principalId, options.limit, after, scope,
      );
      const actual = portPage.candidates.map((row) => ({
        id: row.id, subjectType: row.subjectType, subjectId: row.subjectId, visibility: row.visibility,
        subjectVisibility: row.subjectVisibility as string | null,
        subjectAncestorRestricted: row.subjectAncestorRestricted,
      }));
      assert.deepEqual(actual, referencePage,
        `annotation paging mismatch (${options.projection}, limit ${options.limit}, after ${JSON.stringify(after)})`);
      if (referencePage.length < options.limit + 1) break;
      const cursor = referencePage[options.limit - 1]!;
      after = { subjectType: cursor.subjectType as 'collection' | 'node', subjectId: cursor.subjectId, annotationId: cursor.id };
      iterations += 1;
      assert.ok(iterations <= 20, 'annotation paging comparison did not terminate');
    }
  }

  async function assertRelationPagingMatches(options: { limit: number; rootId?: string; depth?: number }): Promise<void> {
    const port = createPostgresPublicationRelationReadPort(isolated.runtime);
    const scope = options.rootId === undefined ? null : { rootId: options.rootId, depth: options.depth ?? 1_024 };
    let after: PublicationRelationPosition | undefined;
    let iterations = 0;
    while (true) {
      const portPage = await port.loadPage({
        collectionId: MIXED_COLLECTION, projection: 'public', limit: options.limit,
        ...(options.rootId ? { rootId: options.rootId } : {}),
        ...(options.depth !== undefined ? { depth: options.depth } : {}),
        ...(after ? { after } : {}),
      });
      const referencePage = referenceRelationPage(MIXED_COLLECTION, options.limit, after, scope);
      const actual = portPage.candidates.map((row) => ({
        id: row.id, fromNodeId: row.fromNodeId, toNodeId: row.toNodeId, type: row.payload.type, visibility: row.visibility,
        fromVisibility: row.fromVisibility, toVisibility: row.toVisibility,
        fromAuthorized: row.fromAuthorized, toAuthorized: row.toAuthorized,
        fromAncestorVisibility: row.fromAncestorVisibility, toAncestorVisibility: row.toAncestorVisibility,
        fromAncestorRestricted: row.fromAncestorRestricted, toAncestorRestricted: row.toAncestorRestricted,
      }));
      assert.deepEqual(actual, referencePage,
        `relation paging mismatch (limit ${options.limit}, after ${JSON.stringify(after)})`);
      if (referencePage.length < options.limit + 1) break;
      const cursor = referencePage[options.limit - 1]!;
      after = {
        fromNodeId: cursor.fromNodeId, toNodeId: cursor.toNodeId,
        type: cursor.type as 'related', relationId: cursor.id,
      };
      iterations += 1;
      assert.ok(iterations <= 20, 'relation paging comparison did not terminate');
    }
  }

  test('public annotation pages equal the reference page-by-page across the mixed tree', async () => {
    await assertAnnotationPagingMatches({ projection: 'public', limit: 4 });
    await assertAnnotationPagingMatches({ projection: 'public', limit: 7 });
  });

  test('member annotation pages equal the reference with private-self and restricted-subject rules', async () => {
    await assertAnnotationPagingMatches({ projection: 'member', principalId: MEMBER_ACCOUNT, limit: 4 });
    await assertAnnotationPagingMatches({ projection: 'member', principalId: OTHER_ACCOUNT, limit: 4 });
  });

  test('scoped annotation pages honor subtree depth 0, depth 1, and max depth exactly', async () => {
    await assertAnnotationPagingMatches({ projection: 'public', limit: 6, rootId: MIXED_VISIBLE_PARENT, depth: 0 });
    await assertAnnotationPagingMatches({ projection: 'public', limit: 6, rootId: MIXED_VISIBLE_PARENT, depth: 1 });
    await assertAnnotationPagingMatches({ projection: 'public', limit: 6, rootId: MIXED_VISIBLE_PARENT, depth: 1_024 });
    await assertAnnotationPagingMatches({ projection: 'member', principalId: MEMBER_ACCOUNT, limit: 6, rootId: MIXED_VISIBLE_PARENT, depth: 1 });
  });

  test('public relation pages equal the reference for unrestricted and restricted endpoints', async () => {
    await assertRelationPagingMatches({ limit: 4 });
  });

  test('scoped relation pages compute scope reachability for from/to endpoints once per page', async () => {
    await assertRelationPagingMatches({ limit: 4, rootId: MIXED_VISIBLE_PARENT, depth: 1 });
    await assertRelationPagingMatches({ limit: 4, rootId: MIXED_VISIBLE_PARENT, depth: 0 });
  });

  test('the assembled anonymous Snapshot matches the reference app-level emission', async () => {
    const queryPortsForSnapshot = queryPorts();
    try {
      const pages: Snapshot[] = [];
      let pageCursor: string | undefined;
      do {
        const result = await getPublicationSnapshotPage(queryPortsForSnapshot, {
          collectionId: MIXED_COLLECTION, principal: { kind: 'anonymous' },
          query: { include: ['annotations', 'relations'], limit: 3, ...(pageCursor ? { pageCursor } : {}) },
        });
        pages.push(result.snapshot);
        pageCursor = result.nextCursor ?? undefined;
      } while (pageCursor);
      const assembled = assembleSnapshotPages(pages, { publicationExtensionMode: 'producer' });
      assert.equal(assembled.valid, true, JSON.stringify(assembled));
      if (!assembled.valid) return;
      assert.deepEqual(assembled.snapshot.annotations.map((row) => row.id), referenceAppAnnotationIds());
      assert.deepEqual(assembled.snapshot.relations.map((row) => row.id), referenceAppRelationIds());
    } finally {
      queryPortsForSnapshot.cursors.destroy();
    }
  });

  // ---------------------------------------------------------------------------
  // Fail-closed evidence: cycle, missing parent and depth truncation.
  // ---------------------------------------------------------------------------

  test('a pre-existing parent cycle marks annotations restricted (public hidden, member flagged)', async () => {
    // a -> b -> a cycle: point cycle-a at its own descendant cycle-b.
    await isolated.runtime.pool.query('update nodes set parent_id = $2 where id = $1', [CYCLE_A, CYCLE_B]);
    await isolated.runtime.pool.query('insert into resource_id_ledger(resource_id, resource_type) values ($1, \'annotation\')', ['ann-cycle-b']);
    await isolated.runtime.pool.query(`insert into annotations(
      id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
      visibility, resource_revision, created_at, updated_at, payload_json)
      values ($1, $2, 'node', $3, $4, 'note', 'plain', '"cycle"', 'public', 'r13-cycle-r1', $5, $5, $6)`,
    ['ann-cycle-b', CYCLE_COLLECTION, CYCLE_B, MEMBER_ACCOUNT, INSTANT, JSON.stringify({
      id: 'ann-cycle-b', collectionId: CYCLE_COLLECTION, subject: { type: 'node', id: CYCLE_B },
      creator: { id: `${ORIGIN}/profiles/member`, name: 'Page Level' }, type: 'note', format: 'plain',
      value: 'cycle', visibility: 'public', revision: 'r13-cycle-r1', createdAt: INSTANT, updatedAt: INSTANT,
    })]);
    await reloadReferenceModel();

    const publicPage = await createPostgresPublicationAnnotationReadPort(isolated.runtime, { origin: ORIGIN })
      .loadPage({ collectionId: CYCLE_COLLECTION, projection: 'public', limit: 10 });
    assert.deepEqual(publicPage.candidates.map((row) => row.id), []);

    const memberPage = await createPostgresPublicationAnnotationReadPort(isolated.runtime, { origin: ORIGIN })
      .loadPage({ collectionId: CYCLE_COLLECTION, projection: 'member', principalId: MEMBER_ACCOUNT, limit: 10 });
    assert.deepEqual(memberPage.candidates.map((row) => ({ id: row.id, restricted: row.subjectAncestorRestricted })), [
      { id: 'ann-cycle-b', restricted: true },
    ]);
    const reference = referenceAnnotationPage(CYCLE_COLLECTION, 'member', MEMBER_ACCOUNT, 10, undefined, null);
    assert.deepEqual(
      memberPage.candidates.map((row) => ({ id: row.id, restricted: row.subjectAncestorRestricted })),
      reference.map((row) => ({ id: row.id, restricted: row.subjectAncestorRestricted })),
    );
  });

  test('a missing parent row fails closed as restricted with the FK and trigger suspended', async () => {
    const drop = await isolated.runtime.pool.connect();
    try {
      await drop.query('begin');
      await drop.query('alter table nodes drop constraint nodes_collection_id_parent_id_fkey');
      await drop.query('drop trigger nodes_parent_and_root_integrity on nodes');
      await drop.query('commit');
    } catch (error) {
      await drop.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      drop.release();
    }
    try {
      await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id, resource_type)
        values ($1, 'node')`, [MISSING_NODE]);
      await isolated.runtime.pool.query(`insert into nodes(
        id, collection_id, parent_id, kind, is_root, title, url, tags, visibility, position_token,
        resource_revision, children_revision)
        values ($1, $2, 'r13-missing-nonexistent', 'folder', false, 'missing', 'https://example.test/missing', '[]',
          'inherit', 'r13-missing-pos', 'r13-missing-r1', 'r13-missing-c1')`,
      [MISSING_NODE, MISSING_COLLECTION]);
      await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id, resource_type) values ($1, 'annotation')`, ['ann-missing']);
      await isolated.runtime.pool.query(`insert into annotations(
        id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
        visibility, resource_revision, created_at, updated_at, payload_json)
        values ($1, $2, 'node', $3, $4, 'note', 'plain', '"missing"', 'public', 'r13-missing-ar', $5, $5, $6)`,
      ['ann-missing', MISSING_COLLECTION, MISSING_NODE, MEMBER_ACCOUNT, INSTANT, JSON.stringify({
        id: 'ann-missing', collectionId: MISSING_COLLECTION, subject: { type: 'node', id: MISSING_NODE },
        creator: { id: `${ORIGIN}/profiles/member`, name: 'Page Level' }, type: 'note', format: 'plain',
        value: 'missing', visibility: 'public', revision: 'r13-missing-ar', createdAt: INSTANT, updatedAt: INSTANT,
      })]);
      await reloadReferenceModel();

      const publicPage = await createPostgresPublicationAnnotationReadPort(isolated.runtime, { origin: ORIGIN })
        .loadPage({ collectionId: MISSING_COLLECTION, projection: 'public', limit: 10 });
      assert.deepEqual(publicPage.candidates.map((row) => row.id), []);

      const memberPage = await createPostgresPublicationAnnotationReadPort(isolated.runtime, { origin: ORIGIN })
        .loadPage({ collectionId: MISSING_COLLECTION, projection: 'member', principalId: MEMBER_ACCOUNT, limit: 10 });
      assert.deepEqual(memberPage.candidates.map((row) => ({ id: row.id, restricted: row.subjectAncestorRestricted })), [
        { id: 'ann-missing', restricted: true },
      ]);
    } finally {
      const restore = await isolated.runtime.pool.connect();
      try {
        await restore.query('begin');
        await restore.query(`create constraint trigger nodes_parent_and_root_integrity
          after insert or update on nodes deferrable initially deferred
          for each row execute function validate_node_parent_and_root()`);
        await restore.query(`alter table nodes add constraint nodes_collection_id_parent_id_fkey
          foreign key (collection_id, parent_id) references nodes(collection_id, id)
          not valid deferrable initially deferred`);
        await restore.query('commit');
      } catch (error) {
        await restore.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        restore.release();
      }
    }
  });

  test('a chain deeper than the walk cap fails closed as restricted, distinct from any cycle', async () => {
    const publicPage = await createPostgresPublicationAnnotationReadPort(isolated.runtime, { origin: ORIGIN })
      .loadPage({ collectionId: DEEP_COLLECTION, projection: 'public', limit: 10 });
    assert.deepEqual(publicPage.candidates.map((row) => row.id), []);

    const memberPage = await createPostgresPublicationAnnotationReadPort(isolated.runtime, { origin: ORIGIN })
      .loadPage({ collectionId: DEEP_COLLECTION, projection: 'member', principalId: MEMBER_ACCOUNT, limit: 10 });
    assert.deepEqual(memberPage.candidates.map((row) => ({ id: row.id, restricted: row.subjectAncestorRestricted })), [
      { id: 'ann-deep-bottom', restricted: true },
    ]);
    const reference = referenceAnnotationPage(DEEP_COLLECTION, 'member', MEMBER_ACCOUNT, 10, undefined, null);
    assert.deepEqual(
      memberPage.candidates.map((row) => ({ id: row.id, restricted: row.subjectAncestorRestricted })),
      reference.map((row) => ({ id: row.id, restricted: row.subjectAncestorRestricted })),
    );
  });

  // ---------------------------------------------------------------------------
  // Statement-count constant as page size grows, and bounded recursive work.
  // ---------------------------------------------------------------------------

  test('public correction loop keeps the candidate statement count constant as the page size grows', async () => {
    const counts = await Promise.all([10, 50, 200].map(async (limit) => {
      const captured: string[] = [];
      const wrapped = {
        pool: {
          async connect() {
            const client = await isolated.runtime.pool.connect();
            const proxy = {
              captured,
              async query(text: string, values?: readonly unknown[]) {
                captured.push(text);
                return client.query(text, values as never[]);
              },
              release() { client.release(); },
            };
            return proxy;
          },
        },
      } as unknown as Pick<DatabaseRuntime, 'pool'>;
      await createPostgresPublicationAnnotationReadPort(wrapped, { origin: ORIGIN }).loadPage({
        collectionId: INTERLEAVED_COLLECTION, projection: 'public', limit,
      });
      return captured.filter((sql) => sql.includes('from annotations a')).length;
    }));
    assert.deepEqual(counts, [2, 2, 2]);
  });

  test('EXPLAIN ANALYZE shows one page-seeded recursive walk bounded by page size and tree depth', async () => {
    const statement = buildPublicationAnnotationCandidateStatement({
      collectionId: INTERLEAVED_COLLECTION, projection: 'public', limit: 20,
    });
    const explained = await isolated.runtime.pool.query<{ 'QUERY PLAN': unknown }>(
      `explain (analyze, format json) ${statement.text}`, [...statement.values],
    );
    const plan = JSON.stringify(explained.rows[0]?.['QUERY PLAN']);
    const recursiveUnion = /"Node Type":"Recursive Union"/u.exec(plan);
    assert.ok(recursiveUnion, `missing recursive ancestry walk: ${plan}`);
    const walkRows = /"Node Type":"Recursive Union"[^}]*"Actual Rows":(\d+)/u.exec(plan);
    assert.ok(walkRows, `no Actual Rows on the recursive walk: ${plan}`);
    const actualRows = Number(walkRows[1]);
    // The walk visits each page origin's own chain, not the full tree:
    // (limit + 1) origins x (maxDepth + 1) rows x a small join factor.
    const bound = (20 + 1) * (MAX_DEPTH + 1) * 2;
    assert.ok(actualRows <= bound, `recursive walk rows ${actualRows} exceed page x depth bound ${bound}: ${plan}`);
  });

  // ---------------------------------------------------------------------------
  // Seed helpers.
  // ---------------------------------------------------------------------------

  function queryPorts(): PublicationSnapshotQueryPorts {
    const annotationPort = createPostgresPublicationAnnotationReadPort(isolated.runtime, { origin: ORIGIN });
    return {
      reads: createPostgresPublicationSnapshotReadPort(isolated.runtime),
      annotations: {
        async loadPage(request) { return annotationPort.loadPage(request); },
      },
      relations: createPostgresPublicationRelationReadPort(isolated.runtime),
      accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
      cursors: createPublicationCursorKeyring({
        active: { id: 'page-level-ancestry', secret: Buffer.alloc(32, 77).toString('base64') },
        retained: [],
      }),
      origin: ORIGIN,
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    };
  }

  async function seedAccounts(): Promise<void> {
    await isolated.runtime.pool.query(`insert into accounts(id, subject_id, status, email)
      values ($1, $2, 'active', 'member@example.test'), ($3, $4, 'active', 'other@example.test')`,
    [MEMBER_ACCOUNT, MEMBER_SUBJECT, OTHER_ACCOUNT, OTHER_SUBJECT]);
    await isolated.runtime.pool.query(`insert into profiles(account_id, display_name)
      values ($1, 'Page Level'), ($2, 'Other Level')`, [MEMBER_ACCOUNT, OTHER_ACCOUNT]);
  }

  interface SeedNode {
    id: string; parentId: string | null; kind: 'folder' | 'bookmark';
    visibility: string; isRoot?: boolean; deleted?: boolean;
  }

  async function seedCollectionTree(collectionId: string, nodes: SeedNode[]): Promise<void> {
    const root = nodes.find((node) => node.isRoot);
    if (!root) throw new Error(`seed ${collectionId} requires a root node`);
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
      [collectionId, root.id],
    );
    const nonRoots = nodes.filter((node) => node.id !== root.id);
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select id, 'node' from jsonb_to_recordset($1::jsonb) as ledger(id text)
       on conflict (resource_id) do nothing`,
      [JSON.stringify(nonRoots.map((node) => ({ id: node.id })))],
    );
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into collections(
        id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
        content_revision, policy_revision, commit_ordinal, publication_slug, published_at)
        values ($1, 'subject-owner', $2, 'knowledge_collection', 'public', $3,
          'r13-resource-1', 'r13-content-1', 'r13-policy-1', 1, $4, current_timestamp)`,
      [collectionId, `collection-${collectionId}`, root.id, collectionId]);
      for (const node of nodes) {
        if (node.isRoot) {
          await client.query(`insert into nodes(
            id, collection_id, parent_id, kind, is_root, title, url, tags, visibility, position_token,
            resource_revision, children_revision)
            values ($1, $2, null, 'folder', true, $3, null, '[]', 'inherit', null, 'r13-root-r1', 'r13-root-c1')`,
          [node.id, collectionId, `root-${node.id}`]);
        } else {
          await client.query(`insert into nodes(
            id, collection_id, parent_id, kind, is_root, title, url, tags, visibility, position_token,
            resource_revision, children_revision)
            values ($1, $2, $3, $4, false, $5, $6, '[]', $7, $8, $9, $10)`,
          [node.id, collectionId, node.parentId, node.kind, node.id,
            node.kind === 'folder' ? null : `https://example.test/${node.id}`,
            node.visibility, node.id, `r13-r-${node.id}`, `r13-c-${node.id}`]);
        }
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertAnnotation(
    id: string, collectionId: string, subjectType: 'collection' | 'node', subjectId: string,
    visibility: string, creatorPrincipalId: string, deleted = false,
  ): Promise<void> {
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id, resource_type) values ($1, 'annotation')`, [id]);
    await isolated.runtime.pool.query(`insert into annotations(
      id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
      visibility, resource_revision, created_at, updated_at, deleted_at, deleted_commit_ordinal, payload_json)
      values ($1, $2, $3, $4, $5, 'note', 'plain', $6, $7, $8, $9, $9,
        case when $10 then $9::timestamptz else null end, case when $10 then 2 else null end, $11)`,
    [id, collectionId, subjectType, subjectId, creatorPrincipalId, JSON.stringify(`value-${id}`),
      visibility, `r13-ar-${id}`, INSTANT, deleted, JSON.stringify({
        id, collectionId, subject: { type: subjectType, id: subjectId },
        creator: {
          id: creatorPrincipalId === MEMBER_ACCOUNT ? `${ORIGIN}/profiles/member` : `${ORIGIN}/profiles/other`,
          name: creatorPrincipalId === MEMBER_ACCOUNT ? 'Page Level' : 'Other Level',
        },
        type: 'note', format: 'plain', value: `value-${id}`, visibility,
        revision: `r13-ar-${id}`, createdAt: INSTANT, updatedAt: INSTANT,
      })]);
  }

  async function insertRelation(
    id: string, collectionId: string, fromNodeId: string, toNodeId: string,
    visibility: string, type = 'related', deleted = false,
  ): Promise<void> {
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id, resource_type) values ($1, 'relation')`, [id]);
    await isolated.runtime.pool.query(`insert into relations(
      id, collection_id, from_node_id, to_node_id, type, label, visibility, resource_revision,
      created_at, updated_at, deleted_at, deleted_commit_ordinal, payload_json)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9,
        case when $10 then $9::timestamptz else null end, case when $10 then 2 else null end, $11)`,
    [id, collectionId, fromNodeId, toNodeId, type, `label-${id}`, visibility, `r13-rr-${id}`, INSTANT, deleted,
      JSON.stringify({ id, collectionId, type, fromNodeId, toNodeId, label: `label-${id}`, visibility,
        revision: `r13-rr-${id}`, createdAt: INSTANT, updatedAt: INSTANT })]);
  }

  async function seedMixedCollection(): Promise<void> {
    await seedCollectionTree(MIXED_COLLECTION, [
      { id: MIXED_ROOT, parentId: null, kind: 'folder', visibility: 'inherit', isRoot: true },
      { id: MIXED_VISIBLE_PARENT, parentId: MIXED_ROOT, kind: 'folder', visibility: 'inherit' },
      { id: MIXED_PUBLIC, parentId: MIXED_VISIBLE_PARENT, kind: 'bookmark', visibility: 'inherit' },
      { id: MIXED_DEEP, parentId: MIXED_VISIBLE_PARENT, kind: 'bookmark', visibility: 'inherit' },
      { id: MIXED_PRIVATE_PARENT, parentId: MIXED_ROOT, kind: 'folder', visibility: 'private' },
      { id: MIXED_PRIVATE_CHILD, parentId: MIXED_PRIVATE_PARENT, kind: 'bookmark', visibility: 'inherit' },
      { id: MIXED_PROTECTED_PARENT, parentId: MIXED_ROOT, kind: 'folder', visibility: 'protected' },
      { id: MIXED_PROTECTED_CHILD, parentId: MIXED_PROTECTED_PARENT, kind: 'bookmark', visibility: 'inherit' },
      // The orphan stays live while its annotation and relation are seeded; it is
      // deleted afterwards (with the endpoint-deletion trigger suspended) so the
      // live relation to a deleted endpoint exercises the fail-closed read.
      { id: MIXED_ORPHAN, parentId: MIXED_ROOT, kind: 'bookmark', visibility: 'inherit' },
    ]);
    await isolated.runtime.pool.query(`insert into collection_members(collection_id, subject_id, role)
      values ($1, $2, 'viewer')`, [MIXED_COLLECTION, MEMBER_SUBJECT]);

    // Collection subject.
    await insertAnnotation('ann-root', MIXED_COLLECTION, 'collection', MIXED_COLLECTION, 'public', MEMBER_ACCOUNT);
    // Visible node subjects.
    await insertAnnotation('ann-visible-parent', MIXED_COLLECTION, 'node', MIXED_VISIBLE_PARENT, 'public', MEMBER_ACCOUNT);
    await insertAnnotation('ann-public', MIXED_COLLECTION, 'node', MIXED_PUBLIC, 'public', MEMBER_ACCOUNT);
    await insertAnnotation('ann-unlisted', MIXED_COLLECTION, 'node', MIXED_PUBLIC, 'unlisted', MEMBER_ACCOUNT);
    await insertAnnotation('ann-deep', MIXED_COLLECTION, 'node', MIXED_DEEP, 'public', MEMBER_ACCOUNT);
    // Restricted by the subject's own visibility.
    await insertAnnotation('ann-private-subject', MIXED_COLLECTION, 'node', MIXED_PRIVATE_PARENT, 'public', MEMBER_ACCOUNT);
    await insertAnnotation('ann-protected-subject', MIXED_COLLECTION, 'node', MIXED_PROTECTED_PARENT, 'public', MEMBER_ACCOUNT);
    // Restricted by a private/protected ancestor.
    await insertAnnotation('ann-private-child', MIXED_COLLECTION, 'node', MIXED_PRIVATE_CHILD, 'public', MEMBER_ACCOUNT);
    await insertAnnotation('ann-protected-child', MIXED_COLLECTION, 'node', MIXED_PROTECTED_CHILD, 'public', MEMBER_ACCOUNT);
    // Orphan subject (deleted node) and deleted annotation.
    await insertAnnotation('ann-orphan', MIXED_COLLECTION, 'node', MIXED_ORPHAN, 'public', MEMBER_ACCOUNT);
    await insertAnnotation('ann-deleted', MIXED_COLLECTION, 'node', MIXED_PUBLIC, 'public', MEMBER_ACCOUNT, true);
    // Member-private annotations.
    await insertAnnotation('ann-member-private', MIXED_COLLECTION, 'node', MIXED_PUBLIC, 'private', MEMBER_ACCOUNT);
    await insertAnnotation('ann-other-private', MIXED_COLLECTION, 'node', MIXED_PUBLIC, 'private', OTHER_ACCOUNT);
    // Protected annotation visibility is member-only.
    await insertAnnotation('ann-protected-visibility', MIXED_COLLECTION, 'node', MIXED_PUBLIC, 'protected', MEMBER_ACCOUNT);

    await insertRelation('rel-visible-to-deep', MIXED_COLLECTION, MIXED_PUBLIC, MIXED_DEEP, 'public');
    await insertRelation('rel-visible-to-private-child', MIXED_COLLECTION, MIXED_PUBLIC, MIXED_PRIVATE_CHILD, 'public');
    await insertRelation('rel-visible-to-protected-child', MIXED_COLLECTION, MIXED_PUBLIC, MIXED_PROTECTED_CHILD, 'public');
    await insertRelation('rel-private-to-visible', MIXED_COLLECTION, MIXED_PRIVATE_PARENT, MIXED_PUBLIC, 'public');
    await insertRelation('rel-visible-to-orphan', MIXED_COLLECTION, MIXED_PUBLIC, MIXED_ORPHAN, 'public');
    await insertRelation('rel-deep-to-visible-protected', MIXED_COLLECTION, MIXED_DEEP, MIXED_PUBLIC, 'protected');
    await insertRelation('rel-deleted', MIXED_COLLECTION, MIXED_PUBLIC, MIXED_DEEP, 'public', 'related', true);
    // Delete the orphan endpoint after its live annotation and relation exist. The
    // endpoint-deletion trigger is suspended for the statement and restored inside
    // the same transaction, leaving a live relation whose endpoint is deleted.
    await deleteNodeWithLiveRelations(MIXED_ORPHAN);
  }

  async function deleteNodeWithLiveRelations(nodeId: string): Promise<void> {
    // The P2B-11 canonical cascade migration (202607250500) removed the
    // fail-closed nodes_live_relation_integrity trigger, so a live relation
    // whose endpoint is soft-deleted is reachable state in the current schema.
    // The live relation then exercises the fail-closed endpoint read below.
    await isolated.runtime.pool.query(
      `update nodes set deleted_at = current_timestamp, deleted_commit_ordinal = 2 where id = $1`, [nodeId],
    );
  }

  async function seedCycleCollection(): Promise<void> {
    await seedCollectionTree(CYCLE_COLLECTION, [
      { id: CYCLE_ROOT, parentId: null, kind: 'folder', visibility: 'inherit', isRoot: true },
      { id: CYCLE_A, parentId: CYCLE_ROOT, kind: 'folder', visibility: 'inherit' },
      { id: CYCLE_B, parentId: CYCLE_A, kind: 'folder', visibility: 'inherit' },
    ]);
  }

  async function seedMissingParentCollection(): Promise<void> {
    // The root only; the dangling child is inserted later under a suspended FK/trigger.
    await seedCollectionTree(MISSING_COLLECTION, [
      { id: MISSING_ROOT, parentId: null, kind: 'folder', visibility: 'inherit', isRoot: true },
    ]);
  }

  async function seedDeepCollection(): Promise<void> {
    await seedCollectionTree(DEEP_COLLECTION, [
      { id: DEEP_ROOT, parentId: null, kind: 'folder', visibility: 'inherit', isRoot: true },
      { id: DEEP_CHAIN_ROOT, parentId: DEEP_ROOT, kind: 'folder', visibility: 'inherit' },
    ]);
    const chain = (): string => `with recursive chain as (
        select 1::integer as depth, 'r13-dn-1'::text as id, '${DEEP_CHAIN_ROOT}'::text as parent_id
        union all
        select depth + 1, 'r13-dn-' || (depth + 1)::text, id from chain where depth < ${DEEP_CHAIN_DEPTH}
      )`;
    await isolated.runtime.pool.query(`${chain()}
      insert into resource_id_ledger(resource_id, resource_type)
      select id, 'node' from chain
      on conflict (resource_id) do nothing`);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(`${chain()}
        insert into nodes(
          id, collection_id, parent_id, kind, is_root, title, visibility, position_token,
          resource_revision, children_revision)
        select id, $1, parent_id, 'folder', false, id, 'inherit', id, 'r13-dn-r' || depth, 'r13-dn-c' || depth
        from chain`, [DEEP_COLLECTION]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await insertAnnotation('ann-deep-bottom', DEEP_COLLECTION, 'node', 'r13-dn-1025', 'public', MEMBER_ACCOUNT);
  }

  async function seedInterleavedCollection(): Promise<void> {
    await seedCollectionTree(INTERLEAVED_COLLECTION, [
      { id: INTERLEAVED_ROOT, parentId: null, kind: 'folder', visibility: 'inherit', isRoot: true },
      { id: INTERLEAVED_PRIVATE_PARENT, parentId: INTERLEAVED_ROOT, kind: 'folder', visibility: 'private' },
      { id: `${INTERLEAVED_RESTRICTED_PREFIX}1`, parentId: INTERLEAVED_PRIVATE_PARENT, kind: 'bookmark', visibility: 'inherit' },
      { id: `${INTERLEAVED_RESTRICTED_PREFIX}2`, parentId: INTERLEAVED_PRIVATE_PARENT, kind: 'bookmark', visibility: 'inherit' },
      { id: `${INTERLEAVED_RESTRICTED_PREFIX}3`, parentId: INTERLEAVED_PRIVATE_PARENT, kind: 'bookmark', visibility: 'inherit' },
    ]);
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id, resource_type)
      select '${INTERLEAVED_VISIBLE_PREFIX}' || value, 'node' from generate_series(1, ${INTERLEAVED_VISIBLE_COUNT}) value`);
    await isolated.runtime.pool.query(`insert into nodes(
      id, collection_id, parent_id, kind, is_root, title, url, tags, visibility, position_token,
      resource_revision, children_revision)
      select '${INTERLEAVED_VISIBLE_PREFIX}' || value, $1, $2, 'bookmark', false, 'v-' || value,
        'https://example.test/v-' || value, '[]', 'inherit', lpad(value::text, 20, '0'),
        'r13-iv-r-' || value, 'r13-iv-c-' || value
      from generate_series(1, ${INTERLEAVED_VISIBLE_COUNT}) value`,
    [INTERLEAVED_COLLECTION, INTERLEAVED_ROOT]);
    // Three invisible annotations first in tuple order, then a long visible run.
    await insertAnnotation('ann-restricted-1', INTERLEAVED_COLLECTION, 'node', `${INTERLEAVED_RESTRICTED_PREFIX}1`, 'public', MEMBER_ACCOUNT);
    await insertAnnotation('ann-restricted-2', INTERLEAVED_COLLECTION, 'node', `${INTERLEAVED_RESTRICTED_PREFIX}2`, 'public', MEMBER_ACCOUNT);
    await insertAnnotation('ann-restricted-3', INTERLEAVED_COLLECTION, 'node', `${INTERLEAVED_RESTRICTED_PREFIX}3`, 'public', MEMBER_ACCOUNT);
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id, resource_type)
      select 'r13-iv-annotation-' || value, 'annotation' from generate_series(1, ${INTERLEAVED_VISIBLE_COUNT}) value`);
    await isolated.runtime.pool.query(`insert into annotations(
      id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
      visibility, resource_revision, created_at, updated_at, payload_json)
      select ann_id, $1::text, 'node', node_id, $2::text, 'note', 'plain', to_jsonb('v-' || value::text), 'public', revision,
        $5::timestamptz, $5::timestamptz,
        jsonb_build_object('id', ann_id, 'collectionId', $1::text,
          'subject', jsonb_build_object('type', 'node', 'id', node_id),
          'creator', jsonb_build_object('id', $4::text, 'name', 'Page Level'),
          'type', 'note', 'format', 'plain', 'value', to_jsonb('v-' || value::text), 'visibility', 'public',
          'revision', revision, 'createdAt', $3::text, 'updatedAt', $3::text)
      from (select value, 'r13-iv-annotation-' || value ann_id, '${INTERLEAVED_VISIBLE_PREFIX}' || value node_id,
        'r13-iv-r-' || value revision from generate_series(1, ${INTERLEAVED_VISIBLE_COUNT}) value) seeded`,
    [INTERLEAVED_COLLECTION, MEMBER_ACCOUNT, INSTANT, `${ORIGIN}/profiles/member`, INSTANT]);
  }
});
