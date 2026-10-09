import assert from 'node:assert/strict';
import { ColpClient } from '@know-n/colp/client';
import { assembleSnapshotPages, validateSnapshotSemantics } from '@know-n/colp/semantic';
import type { Snapshot } from '@know-n/colp/types';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildPublicationRelationCandidateStatement,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPublicationCursorKeyring,
  createPublicationManifestCandidate,
  getPublicationSnapshotPage,
  getProductPublicCollectionPage,
  type PublicationSnapshotQueryPorts,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = 'publication-relation-collection';
const ROOT_ID = 'publication-relation-root';
const FROM_ID = 'publication-relation-from';
const TO_ID = 'publication-relation-to';
const HIDDEN_ID = 'publication-relation-hidden';
const MEMBER_ID = 'publication-relation-member';
const ORIGIN = 'https://known.example';
const instant = '2026-07-25T04:00:00.000Z';

describeWithPostgres('PostgreSQL Publication Relation projection', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('publication_relation_projection', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCollection();
    await insertRelation('relation-public', FROM_ID, TO_ID, 'public', 'visible label');
    await insertRelation('relation-protected', FROM_ID, TO_ID, 'protected', 'member label', 'supports');
    await insertRelation('relation-private', FROM_ID, TO_ID, 'private', 'editor label', 'precedes');
    await insertRelation('relation-hidden-endpoint', FROM_ID, HIDDEN_ID, 'public', 'must not leak');
    await insertRelation('relation-member-endpoint', FROM_ID, MEMBER_ID, 'protected', 'member endpoint');
  }, 120_000);

  afterAll(async () => { await isolated?.close(); });

  test('Product graph traverses real PostgreSQL relation pages for anonymous and member audiences', async () => {
    const snapshot = ports();
    const query = {
      snapshot, cursors: snapshot.cursors,
      locators: { async findCollectionIdBySlug() { return COLLECTION_ID; } },
      viewCounts: { async sumCollectionViews() { return 0; } },
      owners: { async findByOwnerSubjectId(ownerSubjectId: string) { return { ownerSubjectId, profileId: 'owner-profile', handle: 'owner', displayName: 'Owner', avatarUrl: null }; } },
    };
    try {
      for (const member of [false, true]) {
        const principal = member ? { kind: 'account' as const, principalId: 'account-viewer', subjectId: 'subject-viewer' } : { kind: 'anonymous' as const };
        const nodeIds = new Set<string>();
        const relations: Array<{ id: string; fromNodeId: string; toNodeId: string }> = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await getProductPublicCollectionPage(query, { slug: 'publication-relations', principal, includeRelations: true, limit: 2, cursor });
          page.nodes.forEach((node) => nodeIds.add(node.id));
          relations.push(...page.relations!);
          assert.ok(page.nodes.length + page.relations!.length <= 2);
          cursor = page.page.cursor ?? undefined;
          assert.ok(++pages < 20);
        } while (cursor);
        assert.deepEqual(relations.map((row) => row.id).sort(), member ? ['relation-member-endpoint', 'relation-protected', 'relation-public'] : ['relation-public']);
        assert.ok(relations.every((row) => nodeIds.has(row.fromNodeId) && nodeIds.has(row.toNodeId)));
        assert.ok(pages > 1);
      }
    } finally { snapshot.cursors.destroy(); }
  });

  test('projects only Relations whose two endpoints belong to the authorized Snapshot scope', async () => {
    const pages = await traverse(ports(), ['relations']);
    const assembled = assembleSnapshotPages(pages, { publicationExtensionMode: 'producer' });
    assert.equal(assembled.valid, true);
    if (!assembled.valid) return;
    assert.deepEqual(assembled.snapshot.relations.map((row) => row.id), ['relation-public']);
    assert.equal(JSON.stringify(assembled.snapshot).includes('must not leak'), false);
    assert.deepEqual(validateSnapshotSemantics(assembled.snapshot, {
      publicationExtensionMode: 'producer',
    }), { valid: true, issues: [] });

    const subtree = await getPublicationSnapshotPage(ports(), {
      collectionId: COLLECTION_ID, principal: { kind: 'anonymous' },
      query: { root: FROM_ID, depth: 0, include: ['relations'], limit: 20 },
    });
    assert.deepEqual(subtree.snapshot.relations, []);
  });

  test('applies real PostgreSQL anonymous, viewer, and editor projection facts', async () => {
    const viewer = assembleSnapshotPages(await traverseAs(ports(), {
      kind: 'account', principalId: 'account-viewer', subjectId: 'subject-viewer',
    }), { publicationExtensionMode: 'producer' });
    assert.equal(viewer.valid, true, JSON.stringify(viewer));
    if (viewer.valid) assert.deepEqual(viewer.snapshot.relations.map((row) => row.id).sort(), [
      'relation-member-endpoint', 'relation-protected', 'relation-public',
    ]);

    const editor = assembleSnapshotPages(await traverseAs(ports(), {
      kind: 'account', principalId: 'account-editor', subjectId: 'subject-editor',
    }), { publicationExtensionMode: 'producer' });
    assert.equal(editor.valid, true, JSON.stringify(editor));
    if (editor.valid) assert.deepEqual(editor.snapshot.relations.map((row) => row.id).sort(), [
      'relation-member-endpoint', 'relation-private', 'relation-protected', 'relation-public',
    ]);
  });

  test('a real COLP client assembles PostgreSQL/Fastify Relation pages without dangling endpoints', async () => {
    const queryPorts = ports();
    const app = buildApiApp({
      config: loadConfig({
        DATABASE_URL: isolated.databaseUrl, PRODUCT_ORIGIN: ORIGIN,
        PUBLICATION_ORIGIN: ORIGIN, LOG_LEVEL: 'silent',
        OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      }),
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      publicationSnapshotQuery: queryPorts,
    });
    const coreManifest = createPublicationManifestCandidate({
      origin: ORIGIN, mountPath: '/colp/v0.1/',
      serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de', title: 'Known',
      maxPageSize: 500, maxSnapshotNodes: 100_000,
      endpoints: {
        directory: `${ORIGIN}/colp/v0.1/directory`,
        collection: `${ORIGIN}/colp/v0.1/collections/{collectionId}`,
        snapshot: `${ORIGIN}/colp/v0.1/collections/{collectionId}/snapshot`,
      },
    }, ['directory', 'collection', 'snapshot']).manifest;
    const manifest = { ...coreManifest, mounts: coreManifest.mounts.map((mount) => ({
      ...mount, profiles: ['core', 'publication'] as const,
    })) };
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/collection-protocol') {
        return Response.json(manifest, { headers: { ETag: '"manifest"' } });
      }
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => { headers[name] = value; });
      const response = await app.inject({
        method: request.method as 'GET' | 'HEAD', url: `${url.pathname}${url.search}`, headers,
      });
      return new Response(response.rawPayload, {
        status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : String(value)]])),
      });
    };
    try {
      const snapshot = await new ColpClient({
        manifestUrl: `${ORIGIN}/.well-known/collection-protocol`, fetch,
      }).getSnapshot(COLLECTION_ID, { include: ['relations'], limit: 2 });
      assert.deepEqual(snapshot.relations.map((row) => row.id), ['relation-public']);
      const nodeIds = new Set(snapshot.nodes.map((row) => row.id));
      assert.equal(snapshot.relations.every((row) =>
        nodeIds.has(row.fromNodeId) && nodeIds.has(row.toNodeId)), true);
      assert.deepEqual(validateSnapshotSemantics(snapshot, { publicationExtensionMode: 'consumer' }), {
        valid: true, issues: [],
      });
    } finally {
      queryPorts.cursors.destroy();
      await app.close();
    }
  });

  test('uses the Publication Relation tuple index without Sort or Relation Seq Scan on first/middle/final pages', async () => {
    const count = 12_000;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      select 'publication-plan-node-' || lpad(value::text, 6, '0'), 'node', current_timestamp
      from generate_series(1,$1) value`, [count]);
    // The nodes insert fires the per-row live-node-count / locator-hash
    // triggers; one 12k-row statement exceeded the runtime's 15s
    // statement_timeout on a loaded CI runner (SQLSTATE 57014). Seed the same
    // 12,000 rows (same ids, same triggers, same production pool budget) in
    // bounded statements so the fixture, not the runtime budget, absorbs the
    // runner variance. The plan assertions below are unchanged.
    const SEED_BATCH = 2_000;
    for (let start = 1; start <= count; start += SEED_BATCH) {
      const end = Math.min(start + SEED_BATCH - 1, count);
      await isolated.runtime.pool.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,position_token,
        resource_revision,children_revision)
        select node_id,$1,$2,'bookmark',false,node_id,'https://example.test/' || value,'[]','inherit',
          lpad(value::text,20,'0'),'node-revision-' || value,'children-' || value
        from (select value,'publication-plan-node-' || lpad(value::text,6,'0') node_id
          from generate_series($3::integer,$4::integer) value) seeded`, [COLLECTION_ID, ROOT_ID, start, end]);
    }
    const seededNodes = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from nodes where id like 'publication-plan-node-%'`,
    );
    assert.equal(Number(seededNodes.rows[0]?.count), count, 'bounded seeding must still land all 12,000 nodes');
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      select 'publication-plan-relation-' || lpad(value::text, 6, '0'), 'relation', current_timestamp
      from generate_series(1,$1) value`, [count]);
    await isolated.runtime.pool.query(`insert into relations(
      id,collection_id,from_node_id,to_node_id,type,label,visibility,resource_revision,
      created_at,updated_at,payload_json)
      select relation_id,$1,$2,node_id,'related',null,'public',revision,$3,$3,
        jsonb_build_object('id',relation_id,'collectionId',$1::text,'type','related',
          'fromNodeId',$2::text,'toNodeId',node_id,'visibility','public','revision',revision,
          'createdAt',$4::text,'updatedAt',$4::text)
      from (select value,'publication-plan-node-' || lpad(value::text,6,'0') node_id,
        'publication-plan-relation-' || lpad(value::text,6,'0') relation_id,
        'relation-revision-' || value revision from generate_series(1,$5::integer) value) seeded`,
    [COLLECTION_ID, FROM_ID, instant, instant, count]);
    await isolated.runtime.pool.query('analyze relations');

    const positions = [
      ['first', undefined],
      ['middle', { fromNodeId: FROM_ID, toNodeId: 'publication-plan-node-006000',
        type: 'related' as const, relationId: 'publication-plan-relation-006000' }],
      ['final', { fromNodeId: FROM_ID, toNodeId: 'publication-plan-node-011980',
        type: 'related' as const, relationId: 'publication-plan-relation-011980' }],
    ] as const;
    for (const [label, after] of positions) {
      const statement = buildPublicationRelationCandidateStatement({
        collectionId: COLLECTION_ID, projection: 'public', rootId: ROOT_ID, depth: 1, limit: 20,
        ...(after ? { after } : {}),
      });
      const explained = await isolated.runtime.pool.query<{ 'QUERY PLAN': unknown }>(
        `explain (analyze, buffers, format json) ${statement.text}`, [...statement.values],
      );
      const plan = JSON.stringify(explained.rows[0]?.['QUERY PLAN']);
      assert.match(plan, /relations_live_publication_keyset_idx/u, `${label}: ${plan}`);
      // The ORDER BY is keyset-satisfied; no external (disk) Sort may appear. A
      // bounded in-memory top-N sort is tolerable, an external sort is not.
      assert.doesNotMatch(plan, /"Sort Method":"external"/u, `${label}: ${plan}`);
      assert.doesNotMatch(plan, /"Node Type":"Seq Scan"[^}]*"Relation Name":"relations"/u, `${label}: ${plan}`);
    }
  }, 120_000);

  function ports(): PublicationSnapshotQueryPorts {
    return {
      reads: createPostgresPublicationSnapshotReadPort(isolated.runtime),
      relations: createPostgresPublicationRelationReadPort(isolated.runtime),
      accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
      cursors: createPublicationCursorKeyring({
        active: { id: 'relation-projection', secret: Buffer.alloc(32, 45).toString('base64') }, retained: [],
      }),
      origin: 'https://known.example',
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    };
  }

  async function traverse(queryPorts: PublicationSnapshotQueryPorts, include: ['relations']): Promise<Snapshot[]> {
    return traverseAs(queryPorts, { kind: 'anonymous' });
  }

  async function traverseAs(
    queryPorts: PublicationSnapshotQueryPorts,
    principal: Parameters<typeof getPublicationSnapshotPage>[1]['principal'],
  ): Promise<Snapshot[]> {
    const pages: Snapshot[] = [];
    let pageCursor: string | undefined;
    do {
      const result = await getPublicationSnapshotPage(queryPorts, {
        collectionId: COLLECTION_ID, principal,
        query: { include: ['relations'], limit: 2, ...(pageCursor ? { pageCursor } : {}) },
      });
      pages.push(result.snapshot); pageCursor = result.nextCursor ?? undefined;
    } while (pageCursor);
    return pages;
  }

  async function seedCollection(): Promise<void> {
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values ($1,'collection'),($2,'node'),($3,'node'),($4,'node'),($5,'node'),($6,'node')`,
    [COLLECTION_ID, ROOT_ID, FROM_ID, TO_ID, HIDDEN_ID, MEMBER_ID]);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,
        content_revision,policy_revision,commit_ordinal,publication_slug,published_at)
        values ($1,'subject-owner','Publication relations','knowledge_collection','public',$2,
          'collection-resource-1','content-1','policy-1',1,'publication-relations',current_timestamp)`,
      [COLLECTION_ID, ROOT_ID]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,position_token,
        resource_revision,children_revision) values
        ($1,$5,null,'folder',true,'Root',null,'[]','inherit',null,'root-revision','root-children'),
        ($2,$5,$1,'bookmark',false,'From','https://example.test/from','[]','inherit','A','from-revision','from-children'),
        ($3,$5,$1,'bookmark',false,'To','https://example.test/to','[]','inherit','B','to-revision','to-children'),
        ($4,$5,$1,'bookmark',false,'Hidden','https://example.test/hidden','[]','private','C','hidden-revision','hidden-children'),
        ($6,$5,$1,'bookmark',false,'Member','https://example.test/member','[]','protected','D','member-revision','member-children')`,
      [ROOT_ID, FROM_ID, TO_ID, HIDDEN_ID, COLLECTION_ID, MEMBER_ID]);
      await client.query(`insert into collection_members(collection_id,subject_id,role) values
        ($1,'subject-viewer','viewer'),($1,'subject-editor','editor')`, [COLLECTION_ID]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertRelation(
    id: string, fromNodeId: string, toNodeId: string,
    visibility: 'public' | 'protected' | 'private', label: string, type = 'related',
  ): Promise<void> {
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type) values ($1,'relation')`, [id]);
    await isolated.runtime.pool.query(`insert into relations(
      id,collection_id,from_node_id,to_node_id,type,label,visibility,resource_revision,
      created_at,updated_at,payload_json) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`, [
      id, COLLECTION_ID, fromNodeId, toNodeId, type, label, visibility, `revision-${id}`, instant,
      { id, collectionId: COLLECTION_ID, type, fromNodeId, toNodeId, label, visibility,
        revision: `revision-${id}`, createdAt: instant, updatedAt: instant },
    ]);
  }
});
