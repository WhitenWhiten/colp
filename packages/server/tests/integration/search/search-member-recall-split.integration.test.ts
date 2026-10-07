import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresSearchCandidatePort } from '../../../src/infrastructure/search/index.js';
import {
  compareSearchCandidateTuple,
  type SearchCandidate,
  type SearchPrincipal,
} from '../../../src/modules/search/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const MIGRATION_NAME = '202608011200_search_member_recall_indexes';
const PREVIOUS_STABLE_MIGRATION = '202608011100_collections_directory_filter_indexes';

const TYPE_ORDER: Readonly<Record<string, number>> = { collection: 0, node: 1, profile: 2, annotation: 3 };

const owner: SearchPrincipal = { kind: 'account', accountId: 'account-owner', principalId: 'account-owner',
  subjectId: 'subject-owner', securityEpoch: '1' };
const editor: SearchPrincipal = { kind: 'account', accountId: 'account-editor', principalId: 'account-editor',
  subjectId: 'subject-editor', securityEpoch: '1' };
const viewer: SearchPrincipal = { kind: 'account', accountId: 'account-viewer', principalId: 'account-viewer',
  subjectId: 'subject-viewer', securityEpoch: '1' };
const removed: SearchPrincipal = { kind: 'account', accountId: 'account-removed', principalId: 'account-removed',
  subjectId: 'subject-removed', securityEpoch: '1' };
const stale: SearchPrincipal = { kind: 'account', accountId: 'account-stale', principalId: 'account-stale',
  subjectId: 'subject-stale', securityEpoch: '1' };
const forged: SearchPrincipal = { kind: 'account', accountId: 'account-outsider', principalId: 'account-outsider',
  subjectId: 'subject-viewer', securityEpoch: '1' };
const anonymous: SearchPrincipal = { kind: 'anonymous' };

let isolated: IsolatedPostgresRuntime;

describeWithPostgres('R11 member recall public/member split', () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('search_member_recall_split', {
      maxConnections: 6,
      applicationName: 'known-search-member-recall-split',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedMemberRecallCorpus(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('public, protected, private member, creator-private, deleted, opt-out, and ancestor-restricted rows recall exactly per the split contract', async () => {
    const expected = await expectedRecallSets();
    for (const [label, principal] of Object.entries({
      anonymous, owner, editor, viewer, removed, stale, forged,
    }) as ReadonlyArray<[string, SearchPrincipal]>) {
      const page = await productionPage(principal, 'memberneedle',
        ['collection', 'node', 'annotation'], 100);
      assert.deepEqual(
        page.items.map(tupleKey).sort(),
        [...expected[label]!].sort(),
        `${label} memberneedle recall diverged`,
      );
      assert.equal(new Set(page.items.map(tupleKey)).size, page.items.length,
        `${label} memberneedle recall must not duplicate`);
    }

    const forbiddenAnon = await productionPage(anonymous, 'xzkforbidden',
      ['collection', 'node', 'annotation'], 100);
    assert.deepEqual(forbiddenAnon.items.map(tupleKey), []);
    const forbiddenEditor = await productionPage(editor, 'xzkforbidden',
      ['collection', 'node', 'annotation'], 100);
    assert.deepEqual(forbiddenEditor.items.map(tupleKey), ['annotation:a-creator-private']);
  });

  test('dedups the public/member overlap for an actor who owns a public collection', async () => {
    const ids = await fullPageIds(owner, 'memberneedle', ['collection', 'node', 'annotation'], 1);
    assert.equal(countById(ids, 'collection:c-public'), 1);
    assert.equal(countById(ids, 'collection:c-public-owned'), 1);
    const anonIds = await fullPageIds(anonymous, 'memberneedle', ['collection', 'node', 'annotation'], 1);
    assert.equal(countById(anonIds, 'collection:c-public'), 1);
  });

  test('every page for every principal matches the slow single-pass reference query with no gaps or repeats', async () => {
    for (const [label, principal] of Object.entries({
      anonymous, owner, editor, viewer, removed, stale, forged,
    }) as ReadonlyArray<[string, SearchPrincipal]>) {
      for (const query of ['memberneedle', 'crossrank', 'xzkforbidden']) {
        const { production, reference } = await comparePagedToReference(
          principal, query, ['collection', 'node', 'annotation'], 1,
        );
        assert.deepEqual(production, reference, `${label} ${query} diverged from the reference`);
        assert.equal(new Set(production).size, production.length, `${label} ${query} must not duplicate`);
      }
    }
    const { production: spot } = await comparePagedToReference(
      viewer, 'memberneedle', ['collection', 'node', 'annotation'], 3,
    );
    assert.ok(spot.length > 0);
  });

  test('cross-type equal ranks page in exclusive tuple order across limit boundaries', async () => {
    const ids = await fullPageIds(anonymous, 'crossrank', ['collection', 'node', 'annotation'], 1);
    assert.deepEqual(ids, ['collection:cross-tie-collection', 'node:cross-tie-node',
      'annotation:cross-tie-annotation']);
    const items = await fullPageItems(anonymous, 'crossrank', ['collection', 'node', 'annotation'], 1);
    assert.deepEqual([...items].sort(compareSearchCandidateTuple), items);
    assert.ok(items.every((item) => item.rank > 0 && item.rank <= 1
      && Number(item.rank.toFixed(6)) === item.rank));
  });

  test('revoking live membership removes member-only recall without breaking continuation paging', async () => {
    const first = await productionPage(viewer, 'zxkrevoke',
      ['collection', 'node', 'annotation'], 1);
    assert.deepEqual(first.items.map(tupleKey), ['collection:c-revoke']);
    assert.equal(first.hasMore, true);
    const continuation = first.items.at(-1)?.exclusive;
    await isolated.runtime.pool.query(
      `delete from collection_members where collection_id='c-revoke' and subject_id='subject-viewer'`);
    const second = await productionPage(viewer, 'zxkrevoke',
      ['collection', 'node', 'annotation'], 1, continuation);
    assert.deepEqual(second.items.map(tupleKey), []);
    assert.equal(second.hasMore, false);
  });
});

/* ------------------------------------------------------------------ *
 * Principal and query helpers
 * ------------------------------------------------------------------ */

let candidatePort: ReturnType<typeof createPostgresSearchCandidatePort> | undefined;

function port(isolatedRuntime: IsolatedPostgresRuntime) {
  candidatePort ??= createPostgresSearchCandidatePort(isolatedRuntime.runtime.db);
  return candidatePort;
}

function projectionOf(principal: SearchPrincipal) {
  return principal.kind === 'account'
    ? { kind: 'account' as const, accountId: principal.accountId, principalId: principal.principalId,
      subjectId: principal.subjectId, securityEpoch: principal.securityEpoch }
    : { kind: 'anonymous' as const };
}

async function productionPage(
  principal: SearchPrincipal,
  query: string,
  types: readonly string[],
  limit: number,
  after?: SearchCandidate['exclusive'],
): Promise<{ items: SearchCandidate[]; hasMore: boolean }> {
  const page = await port(isolated!).listCandidates({
    query, types: [...types] as SearchCandidate['resourceType'][], projection: projectionOf(principal),
    limit, timeoutMs: 5_000, ...(after ? { after } : {}),
  });
  return { items: [...page.items], hasMore: page.hasMore };
}

async function fullPageIds(
  principal: SearchPrincipal,
  query: string,
  types: readonly string[],
  limit: number,
): Promise<string[]> {
  const items = await fullPageItems(principal, query, types, limit);
  return items.map(tupleKey);
}

async function fullPageItems(
  principal: SearchPrincipal,
  query: string,
  types: readonly string[],
  limit: number,
): Promise<SearchCandidate[]> {
  const items: SearchCandidate[] = [];
  let after: SearchCandidate['exclusive'] | undefined;
  let guard = 0;
  do {
    const page = await productionPage(principal, query, types, limit, after);
    items.push(...page.items);
    after = page.hasMore ? page.items.at(-1)?.exclusive : undefined;
    guard += 1;
    assert.ok(guard < 500, 'production full paging guard exceeded');
  } while (after);
  return items;
}

function tupleKey(item: { resourceType: string; resourceId: string }): string {
  return `${item.resourceType}:${item.resourceId}`;
}

function countById(ids: readonly string[], target: string): number {
  return ids.filter((id) => id === target).length;
}

/* ------------------------------------------------------------------ *
 * Slow single-pass reference query
 * ------------------------------------------------------------------ */

/**
 * Reference oracle: the pre-split recall semantics computed in a single pass over
 * the OR-combined recall predicates. It has no public/member branch decomposition,
 * no per-branch LIMIT, and no dedup, so any bounded-branch continuation or dedup bug
 * in the split production query surfaces as a page mismatch.
 */
const REFERENCE_SQL = `
WITH verified_actor AS MATERIALIZED (
  SELECT a.id AS principal_id, a.subject_id
  FROM accounts a
  WHERE $7::boolean AND a.id=$8::text AND a.id=$9::text AND a.subject_id=$10::text
    AND a.security_epoch::text=$11::text AND a.status='active' AND a.deleted_at IS NULL
), actor_collections AS MATERIALIZED (
  SELECT c.id AS collection_id
  FROM verified_actor actor JOIN collections c ON c.owner_subject_id=actor.subject_id
  UNION
  SELECT member.collection_id
  FROM verified_actor actor JOIN collection_members member ON member.subject_id=actor.subject_id
), candidates AS (
  SELECT 'collection'::text AS resource_type, c.id AS resource_id, c.id AS collection_id,
    greatest(public.word_similarity($1, c.search_text),
      ts_rank_cd(c.search_vector, plainto_tsquery('english'::regconfig, $1))) AS raw_rank
  FROM collections c
  WHERE c.deleted_at IS NULL
    AND (c.visibility='public' OR c.id IN (SELECT collection_id FROM actor_collections))
    AND c.allow_search_indexing=true
    AND ($1 OPERATOR(public.<%) c.search_text
      OR c.search_vector @@ plainto_tsquery('english'::regconfig, $1))
  UNION ALL
  SELECT 'node'::text, n.id, n.collection_id,
    greatest(public.word_similarity($1, n.search_text),
      ts_rank_cd(n.search_vector, plainto_tsquery('english'::regconfig, $1)))
  FROM nodes n
  JOIN collections c ON c.id=n.collection_id
  LEFT JOIN nodes root_node ON root_node.collection_id=c.id AND root_node.id=c.root_node_id
  WHERE c.deleted_at IS NULL
    AND (c.visibility='public' OR c.id IN (SELECT collection_id FROM actor_collections))
    AND c.allow_search_indexing=true
    AND n.deleted_at IS NULL AND NOT n.is_root
    AND (c.id IN (SELECT collection_id FROM actor_collections)
      OR (c.visibility='public' AND n.visibility='inherit' AND (
        (n.parent_id IS NOT DISTINCT FROM c.root_node_id AND root_node.parent_id IS NULL
          AND (root_node.id IS NULL OR (
            root_node.deleted_at IS NULL AND root_node.visibility NOT IN ('private','protected'))))
        OR (NOT (n.parent_id IS NOT DISTINCT FROM c.root_node_id AND root_node.parent_id IS NULL)
          AND NOT EXISTS (
            WITH RECURSIVE ancestors(id,parent_id,visibility,deleted_at,path,depth) AS (
              SELECT p.id,p.parent_id,p.visibility,p.deleted_at,ARRAY[p.id]::text[],1
              FROM nodes p WHERE p.collection_id=n.collection_id AND p.id=n.parent_id
              UNION ALL
              SELECT p.id,p.parent_id,p.visibility,p.deleted_at,a.path || p.id,a.depth + 1
              FROM nodes p JOIN ancestors a ON p.id=a.parent_id
              WHERE p.collection_id=n.collection_id AND NOT p.id=ANY(a.path) AND a.depth < 256
            )
            SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL
              OR visibility IN ('private','protected') OR parent_id=ANY(path)
              OR (depth=256 AND parent_id IS NOT NULL)
          )
        )
      )))
    AND ($1 OPERATOR(public.<%) n.search_text
      OR n.search_vector @@ plainto_tsquery('english'::regconfig, $1))
  UNION ALL
  SELECT 'annotation'::text, a.id, a.collection_id,
    greatest(public.word_similarity($1, a.annotation_search_text),
      ts_rank_cd(a.annotation_search_vector, plainto_tsquery('simple'::regconfig, $1)))
  FROM annotations a
  JOIN collections c ON c.id=a.collection_id
  LEFT JOIN nodes subject_node ON a.subject_type='node'
    AND subject_node.collection_id=a.collection_id AND subject_node.id=a.subject_id
  WHERE a.deleted_at IS NULL AND a.type <> 'reading_state' AND c.deleted_at IS NULL
    AND (c.visibility='public' OR c.id IN (SELECT collection_id FROM actor_collections))
    AND c.allow_search_indexing=true
    AND ((c.id IN (SELECT collection_id FROM actor_collections)
        AND (a.visibility <> 'private' OR a.creator_principal_id=(SELECT principal_id FROM verified_actor)))
      OR (c.visibility='public' AND NOT (c.id IN (SELECT collection_id FROM actor_collections))
        AND a.visibility='public' AND (
          (a.subject_type='collection' AND a.subject_id=a.collection_id)
          OR (a.subject_type='node' AND subject_node.id IS NOT NULL AND NOT subject_node.is_root
            AND subject_node.deleted_at IS NULL AND subject_node.visibility='inherit'
            AND NOT EXISTS (
              WITH RECURSIVE ancestors(id,parent_id,visibility,deleted_at,path,depth) AS (
                SELECT p.id,p.parent_id,p.visibility,p.deleted_at,ARRAY[p.id]::text[],1
                FROM nodes p WHERE p.collection_id=subject_node.collection_id AND p.id=subject_node.parent_id
                UNION ALL
                SELECT p.id,p.parent_id,p.visibility,p.deleted_at,a.path || p.id,a.depth + 1
                FROM nodes p JOIN ancestors a ON p.id=a.parent_id
                WHERE p.collection_id=subject_node.collection_id
                  AND NOT p.id=ANY(a.path) AND a.depth < 256
              )
              SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL
                OR visibility IN ('private','protected') OR parent_id=ANY(path)
                OR (depth=256 AND parent_id IS NOT NULL)
            )
          )
        )))
    AND ($1 OPERATOR(public.<%) a.annotation_search_text
      OR a.annotation_search_vector @@ plainto_tsquery('simple'::regconfig, $1))
), scored AS (
  SELECT resource_type, resource_id,
    round(least(1.0, greatest(0.0, raw_rank))::numeric, 6)::double precision AS rank,
    CASE resource_type WHEN 'collection' THEN 0 WHEN 'node' THEN 1
      WHEN 'profile' THEN 2 WHEN 'annotation' THEN 3 ELSE 2147483647 END AS resource_order
  FROM candidates WHERE raw_rank > 0
)
SELECT resource_type, resource_id, rank FROM scored
WHERE ($2::double precision IS NULL OR rank < $2
  OR (rank = $2 AND resource_order > $3::integer)
  OR (rank = $2 AND resource_order = $3::integer AND resource_id COLLATE "C" > $4 COLLATE "C"))
  AND resource_type = ANY($5::text[])
ORDER BY rank DESC, resource_order ASC, resource_id COLLATE "C" ASC
LIMIT $6`;

interface ReferenceRow { readonly resource_type: string; readonly resource_id: string; readonly rank: number }

async function referencePage(
  client: PoolClient,
  principal: SearchPrincipal,
  query: string,
  types: readonly string[],
  limit: number,
  after?: { readonly rank: number; readonly resourceType: string; readonly resourceId: string },
): Promise<ReferenceRow[]> {
  const isAccount = principal.kind === 'account';
  const result = await client.query<ReferenceRow>(REFERENCE_SQL, [
    query,
    after?.rank ?? null,
    after ? TYPE_ORDER[after.resourceType] : 0,
    after?.resourceId ?? '',
    [...types],
    limit + 1,
    isAccount,
    isAccount ? principal.accountId : null,
    isAccount ? principal.principalId : null,
    isAccount ? principal.subjectId : null,
    isAccount ? principal.securityEpoch : null,
  ]);
  return result.rows.map((row) => ({ ...row, rank: Number(row.rank) }));
}

async function comparePagedToReference(
  principal: SearchPrincipal,
  query: string,
  types: readonly string[],
  limit: number,
): Promise<{ production: string[]; reference: string[] }> {
  const client = await isolated!.runtime.pool.connect();
  try {
    await client.query(`set pg_trgm.word_similarity_threshold='0.15'`);
    const production: string[] = [];
    const reference: string[] = [];
    let prodAfter: SearchCandidate['exclusive'] | undefined;
    let refAfter: { rank: number; resourceType: string; resourceId: string } | undefined;
    let guard = 0;
    do {
      const prodPage = await productionPage(principal, query, types, limit, prodAfter);
      const refRows = await referencePage(client, principal, query, types, limit, refAfter);
      const refPageItems = refRows.slice(0, limit);
      const refHasMore = refRows.length > limit;
      assert.deepEqual(
        prodPage.items.map(tupleKey),
        refPageItems.map((row) => `${row.resource_type}:${row.resource_id}`),
        `page mismatch for ${JSON.stringify(principal)} query=${query} limit=${limit} after=${JSON.stringify(prodAfter)}`,
      );
      production.push(...prodPage.items.map(tupleKey));
      reference.push(...refPageItems.map((row) => `${row.resource_type}:${row.resource_id}`));
      // The continuation tuple is the limit-th row of the fetched window, the same
      // convention the production port exposes through page.items.at(-1).exclusive.
      const continuationRef = refRows[limit - 1];
      prodAfter = prodPage.hasMore ? prodPage.items.at(-1)?.exclusive : undefined;
      refAfter = refHasMore && continuationRef
        ? { rank: continuationRef.rank, resourceType: continuationRef.resource_type,
          resourceId: continuationRef.resource_id }
        : undefined;
      guard += 1;
      assert.ok(guard < 500, 'reference paging guard exceeded');
    } while (prodAfter || refAfter);
    return { production, reference };
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ *
 * Expected recall sets (independent declarative oracle)
 * ------------------------------------------------------------------ */

async function expectedRecallSets(): Promise<Readonly<Record<string, ReadonlySet<string>>>> {
  const collection = (id: string) => `collection:${id}`;
  const node = (id: string) => `node:${id}`;
  const annotation = (id: string) => `annotation:${id}`;
  return {
    anonymous: new Set([collection('c-public'), collection('c-public-owned'), node('n-public'),
      annotation('a-public'), annotation('a-subject-node-visible')]),
    owner: new Set([collection('c-public'), collection('c-public-owned'), collection('c-protected'),
      collection('c-private'), node('n-public'), node('n-ancestor-restricted'),
      node('n-protected-collection'), node('n-private-collection'),
      annotation('a-public'), annotation('a-protected'), annotation('a-private-noncreator'),
      annotation('a-subject-node-visible'), annotation('a-subject-node-restricted')]),
    editor: new Set([collection('c-public'), collection('c-public-owned'), collection('c-protected'),
      collection('c-member-private'), node('n-public'), node('n-protected-collection'),
      annotation('a-public'), annotation('a-protected'), annotation('a-creator-private'),
      annotation('a-subject-node-visible')]),
    viewer: new Set([collection('c-public'), collection('c-public-owned'), collection('c-private'),
      collection('c-member-private'), node('n-public'), node('n-ancestor-restricted'),
      node('n-private-collection'), annotation('a-public'),
      annotation('a-subject-node-visible'), annotation('a-subject-node-restricted')]),
    removed: new Set([collection('c-public'), collection('c-public-owned'), node('n-public'),
      annotation('a-public'), annotation('a-subject-node-visible')]),
    stale: new Set([collection('c-public'), collection('c-public-owned'), node('n-public'),
      annotation('a-public'), annotation('a-subject-node-visible')]),
    forged: new Set([collection('c-public'), collection('c-public-owned'), node('n-public'),
      annotation('a-public'), annotation('a-subject-node-visible')]),
  };
}

/* ------------------------------------------------------------------ *
 * Fixture seeding
 * ------------------------------------------------------------------ */

async function seedMemberRecallCorpus(isolatedRuntime: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolatedRuntime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    for (const [accountId, subjectId, deleted] of [
      ['account-owner', 'subject-owner', false], ['account-editor', 'subject-editor', false],
      ['account-viewer', 'subject-viewer', false], ['account-removed', 'subject-removed', false],
      ['account-outsider', 'subject-outsider', false], ['account-stale', 'subject-stale', false],
      ['account-alice', 'subject-alice', false],
    ] as const) {
      await client.query(`insert into accounts(id,subject_id,status,security_epoch,deleted_at)
        values($1,$2,'active',1,case when $3 then current_timestamp end)`,
      [accountId, subjectId, deleted]);
    }
    await client.query(`insert into profiles(account_id,display_name)
      values('account-alice','memberneedle profile')`);
    await client.query(`insert into profile_handles(handle,account_id)
      values('memberneedle-alice','account-alice')`);

    // Collections: visibility, owner, opt-in, optional deleted.
    const collections: ReadonlyArray<[string, string, 'public' | 'protected' | 'private', boolean, boolean]> = [
      ['c-public', 'subject-owner', 'public', true, false],
      ['c-public-owned', 'subject-owner', 'public', true, false],
      ['c-protected', 'subject-owner', 'protected', true, false],
      ['c-private', 'subject-owner', 'private', true, false],
      ['c-member-private', 'subject-editor', 'private', true, false],
      ['c-optout', 'subject-owner', 'public', false, false],
      ['c-deleted', 'subject-owner', 'public', true, true],
      ['c-alice', 'subject-alice', 'public', true, false],
    ];
    for (const [id, ownerSubject, visibility, optIn, deleted] of collections) {
      const root = `${id}-root`;
      await client.query(`insert into resource_id_ledger(resource_id,resource_type)
        values($1,'collection'),($2,'node')`, [id, root]);
      // Deleted collections are inserted already-deleted together with their root.
      // The collections_root_lifecycle_integrity constraint trigger is deferred and
      // keeps the INSERT-time row snapshot, so deleting live rows via a later UPDATE
      // would mismatch against the root's deleted_at at commit time.
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,
        publication_slug,published_at,allow_search_indexing,root_node_id,resource_revision,content_revision,policy_revision,
        deleted_at)
        values($1,$2,$1,'bookmarks',$3,case when $3 in ('public','unlisted') then $1 end,
          case when $3 in ('public','unlisted') then current_timestamp end,$4,$5,'r1','c1','p1',
          case when $6 then current_timestamp end)`,
      [id, ownerSubject, visibility, optIn, root, deleted]);
      await client.query(`insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision,
        deleted_at,deleted_commit_ordinal)
        values($1,$2,'folder',true,'Root','r1','ch1',
          case when $3 then current_timestamp end,case when $3 then 1 end)`, [root, id, deleted]);
    }
    // Membership matrix (no row for the removed member, who was removed before seeding).
    for (const [collectionId, subjectId] of [
      ['c-protected', 'subject-editor'], ['c-private', 'subject-viewer'],
      ['c-member-private', 'subject-viewer'], ['c-public', 'subject-viewer'],
      ['c-public-owned', 'subject-viewer'],
    ] as const) {
      await client.query(`insert into collection_members(collection_id,subject_id,role)
        values($1,$2,'viewer')`, [collectionId, subjectId]);
    }

    // Nodes.
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      values('n-public','node'),('n-protected-collection','node'),('n-private-collection','node'),
        ('n-ancestor-restricted','node'),('n-restricted-parent','node'),('n-deleted','node'),('n-optout','node')`);
    await client.query(`insert into nodes(id,collection_id,parent_id,kind,title,url,visibility,
      position_token,resource_revision,children_revision)
      values('n-public','c-public','c-public-root','bookmark','n-public','https://example.test/n-public','inherit','n-public','r1','ch1'),
        ('n-protected-collection','c-protected','c-protected-root','bookmark','n-protected-collection','https://example.test/np','inherit','n-protected-collection','r1','ch1'),
        ('n-private-collection','c-private','c-private-root','bookmark','n-private-collection','https://example.test/npv','private','n-private-collection','r1','ch1'),
        ('n-restricted-parent','c-public','c-public-root','folder','n-restricted-parent',null,'protected','n-restricted-parent','r1','ch1'),
        ('n-ancestor-restricted','c-public','n-restricted-parent','bookmark','n-ancestor-restricted','https://example.test/nar','inherit','n-ancestor-restricted','r1','ch1'),
        ('n-deleted','c-public','c-public-root','bookmark','n-deleted','https://example.test/nd','inherit','n-deleted','r1','ch1'),
        ('n-optout','c-optout','c-optout-root','bookmark','n-optout','https://example.test/no','inherit','n-optout','r1','ch1')`);
    await client.query(`update nodes set deleted_at=current_timestamp where id='n-deleted'`);

    // Annotations.
    const annotations: ReadonlyArray<[string, string, string, string, string, string, boolean, string]> = [
      // id, collectionId, subjectType, subjectId, visibility, creator, deleted, value
      ['a-public', 'c-public', 'collection', 'c-public', 'public', 'account-owner', false, 'memberneedle'],
      ['a-protected', 'c-protected', 'collection', 'c-protected', 'protected', 'account-editor', false, 'memberneedle'],
      ['a-creator-private', 'c-protected', 'collection', 'c-protected', 'private', 'account-editor', false, 'memberneedle'],
      ['a-private-noncreator', 'c-private', 'collection', 'c-private', 'private', 'account-owner', false, 'memberneedle'],
      ['a-subject-node-visible', 'c-public', 'node', 'n-public', 'public', 'account-owner', false, 'memberneedle'],
      ['a-subject-node-restricted', 'c-public', 'node', 'n-ancestor-restricted', 'public', 'account-owner', false, 'memberneedle'],
      ['a-deleted', 'c-public', 'collection', 'c-public', 'public', 'account-owner', true, 'memberneedle'],
      ['a-optout', 'c-optout', 'collection', 'c-optout', 'public', 'account-owner', false, 'memberneedle'],
    ];
    for (const [id, collectionId, subjectType, subjectId, visibility, creator, deleted, value] of annotations) {
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values($1,'annotation')`, [id]);
      const timestamp = '2026-07-25T00:00:00.000Z';
      const payload = { id, collectionId, subject: { type: subjectType, id: subjectId },
        creator: { id: `https://known.test/profiles/${creator}`, name: 'Creator' }, type: 'note', format: 'plain',
        value, visibility, revision: 'r1', createdAt: timestamp, updatedAt: timestamp };
      await client.query(`insert into annotations(id,collection_id,subject_type,subject_id,
        creator_principal_id,type,format,value_json,visibility,resource_revision,created_at,updated_at,
        deleted_at,deleted_commit_ordinal,payload_json)
        values($1,$2,$3,$4,$5,'note','plain',to_jsonb($6::text),$7,'r1',$8,$8,
          case when $9 then $8::timestamptz end,case when $9 then 1 end,$10::jsonb)`,
      [id, collectionId, subjectType, subjectId, creator, value, visibility, timestamp, deleted, JSON.stringify(payload)]);
    }

    // Title overrides for the cross-type tie corpus.
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      values('cross-tie-collection','collection'),('cross-tie-root','node'),('cross-tie-node','node'),
        ('cross-tie-annotation','annotation')`);
    await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,
      publication_slug,published_at,allow_search_indexing,root_node_id,resource_revision,content_revision,policy_revision)
      values('cross-tie-collection','subject-owner','crossrank','bookmarks','public','cross-tie-collection',
        current_timestamp,true,'cross-tie-root','r1','c1','p1')`);
    await client.query(`insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision)
      values('cross-tie-root','cross-tie-collection','folder',true,'Root','r1','ch1')`);
    await client.query(`insert into nodes(id,collection_id,parent_id,kind,title,url,visibility,
      position_token,resource_revision,children_revision)
      values('cross-tie-node','cross-tie-collection','cross-tie-root','bookmark','crossrank',
        'https://example.test/cross-tie-node','inherit','cross-tie-node','r1','ch1')`);
    const tieTimestamp = '2026-07-25T00:00:00.000Z';
    const tiePayload = { id: 'cross-tie-annotation', collectionId: 'cross-tie-collection',
      subject: { type: 'collection', id: 'cross-tie-collection' },
      creator: { id: 'https://known.test/profiles/owner', name: 'Owner' }, type: 'note', format: 'plain',
      value: 'crossrank', visibility: 'public', revision: 'r1', createdAt: tieTimestamp, updatedAt: tieTimestamp };
    await client.query(`insert into annotations(id,collection_id,subject_type,subject_id,
      creator_principal_id,type,format,value_json,visibility,resource_revision,created_at,updated_at,payload_json)
      values('cross-tie-annotation','cross-tie-collection','collection','cross-tie-collection',
        'account-owner','note','plain',to_jsonb('crossrank'::text),'public','r1',$1,$1,$2::jsonb)`,
    [tieTimestamp, JSON.stringify(tiePayload)]);

    // Live revocation corpus (self-contained query). The needle token must share no
    // pg_trgm trigrams with the 'memberneedle'/'forbiddenneedle'/'crossrank' fixtures
    // or with node titles like 'n-restricted-parent' (the trigram padded word form of
    // 'restricted' collides with any 're...' needle at 0.2 similarity). 'zxkrevoke'
    // starts with 'z' and its inner trigrams appear nowhere else in the corpus.
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      values('c-revoke','collection'),('c-revoke-root','node'),('n-revoke','node'),('a-revoke','annotation')`);
    await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,
      allow_search_indexing,root_node_id,resource_revision,content_revision,policy_revision)
      values('c-revoke','subject-owner','zxkrevoke','bookmarks','protected',true,
        'c-revoke-root','r1','c1','p1')`);
    await client.query(`insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision)
      values('c-revoke-root','c-revoke','folder',true,'Root','r1','ch1')`);
    await client.query(`insert into collection_members(collection_id,subject_id,role)
      values('c-revoke','subject-viewer','viewer')`);
    await client.query(`insert into nodes(id,collection_id,parent_id,kind,title,url,visibility,
      position_token,resource_revision,children_revision)
      values('n-revoke','c-revoke','c-revoke-root','bookmark','zxkrevoke',
        'https://example.test/n-revoke','inherit','n-revoke','r1','ch1')`);
    const revokeTimestamp = '2026-07-25T00:00:00.000Z';
    const revokePayload = { id: 'a-revoke', collectionId: 'c-revoke',
      subject: { type: 'collection', id: 'c-revoke' },
      creator: { id: 'https://known.test/profiles/editor', name: 'Editor' }, type: 'note', format: 'plain',
      value: 'zxkrevoke', visibility: 'protected', revision: 'r1',
      createdAt: revokeTimestamp, updatedAt: revokeTimestamp };
    await client.query(`insert into annotations(id,collection_id,subject_type,subject_id,
      creator_principal_id,type,format,value_json,visibility,resource_revision,created_at,updated_at,payload_json)
      values('a-revoke','c-revoke','collection','c-revoke','account-editor','note','plain',
        to_jsonb('zxkrevoke'::text),'protected','r1',$1,$1,$2::jsonb)`,
    [revokeTimestamp, JSON.stringify(revokePayload)]);

    await client.query(`update collections set title='memberneedle public collection' where id='c-public'`);
    await client.query(`update collections set title='memberneedle protected collection' where id='c-protected'`);
    await client.query(`update collections set title='memberneedle private collection' where id='c-private'`);
    await client.query(`update collections set title='memberneedle member private collection' where id='c-member-private'`);
    await client.query(`update collections set title='memberneedle dup collection' where id='c-public-owned'`);
    await client.query(`update collections set title='memberneedle optout collection' where id='c-optout'`);
    await client.query(`update collections set title='memberneedle deleted xzkforbidden' where id='c-deleted'`);
    await client.query(`update nodes set title='memberneedle public node' where id='n-public'`);
    await client.query(`update nodes set title='memberneedle protected node' where id='n-protected-collection'`);
    await client.query(`update nodes set title='memberneedle private node' where id='n-private-collection'`);
    await client.query(`update nodes set title='memberneedle ancestor node' where id='n-ancestor-restricted'`);
    await client.query(`update annotations
      set value_json=to_jsonb('xzkforbidden deleted'::text),
          payload_json=jsonb_set(payload_json,'{value}',to_jsonb('xzkforbidden deleted'::text))
      where id='a-deleted'`);
    await client.query(`update annotations
      set value_json=to_jsonb('memberneedle xzkforbidden private'::text),
          payload_json=jsonb_set(payload_json,'{value}',to_jsonb('memberneedle xzkforbidden private'::text))
      where id='a-creator-private'`);
    await client.query(`update nodes set title='xzkforbidden deleted' where id='n-deleted'`);

    // Delete the stale account so its projection verifies to an empty actor.
    await client.query(`update accounts set deleted_at=current_timestamp where id='account-stale'`);

    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

void MIGRATION_NAME;
void PREVIOUS_STABLE_MIGRATION;
