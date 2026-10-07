import assert from 'node:assert/strict';
import { ColpClient } from '@know-n/colp/client';
import { assembleSnapshotPages } from '@know-n/colp/semantic';
import type { Snapshot } from '@know-n/colp/types';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildPublicationAnnotationCandidateStatement,
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPublicationCursorKeyring,
  createPublicationManifestCandidate,
  getPublicationSnapshotPage,
  PublicationSnapshotExpiredError,
  type PublicationSnapshotQueryPorts,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = 'publication-annotation-collection';
const ROOT_ID = 'publication-annotation-root';
const PUBLIC_NODE_ID = 'publication-annotation-node';
const PRIVATE_NODE_ID = 'publication-private-node';
const ORPHAN_NODE_ID = 'publication-orphan-node';
const MEMBER_ACCOUNT_ID = 'publication-member-account';
const OTHER_ACCOUNT_ID = 'publication-other-account';
const MEMBER_SUBJECT_ID = 'publication-member-subject';
const ORIGIN = 'https://known.example';
const instant = '2026-07-25T00:00:00.000Z';

describeWithPostgres('PostgreSQL Publication Annotation projection', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('publication_annotation_projection', {
      maxConnections: 8,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedIdentity();
    await seedCollection();
    await seedAnnotations();
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('projects Collection/Node sidecars exactly once with visibility, creator, redaction, and orphan filters', async () => {
    const anonymousQueries: unknown[] = [];
    const anonymousPorts = ports(anonymousQueries);
    const anonymousPages = await traverse(anonymousPorts, { kind: 'anonymous' }, 4);
    const anonymousAssembly = assembleSnapshotPages(anonymousPages, {
      publicationExtensionMode: 'producer',
    });
    assert.equal(anonymousAssembly.valid, true);
    if (!anonymousAssembly.valid) return;
    assert.deepEqual(anonymousAssembly.snapshot.annotations.map((row) => row.id), [
      'annotation-collection-public', 'annotation-node-ai',
    ]);
    assert.deepEqual(anonymousAssembly.snapshot.annotations.map((row) => row.subject), [
      { type: 'collection', id: COLLECTION_ID }, { type: 'node', id: PUBLIC_NODE_ID },
    ]);
    for (const annotation of anonymousAssembly.snapshot.annotations) {
      assert.deepEqual(annotation.creator, {
        id: `${ORIGIN}/profiles/member`, name: 'Publication Member',
      });
      const bytes = JSON.stringify(annotation);
      assert.equal(bytes.includes(MEMBER_ACCOUNT_ID), false);
      assert.equal(bytes.includes('internal-provider'), false);
      assert.equal(bytes.includes('internal-model'), false);
    }
    assert.ok(anonymousQueries.length > 0);

    const memberPages = await traverse(ports(), {
      kind: 'account', principalId: MEMBER_ACCOUNT_ID, subjectId: MEMBER_SUBJECT_ID,
    }, 4);
    const memberAssembly = assembleSnapshotPages(memberPages, {
      publicationExtensionMode: 'producer',
    });
    assert.equal(memberAssembly.valid, true);
    if (memberAssembly.valid) {
      assert.deepEqual(memberAssembly.snapshot.annotations.map((row) => row.id), [
        'annotation-collection-private-self', 'annotation-collection-protected',
        'annotation-collection-public', 'annotation-node-ai', 'annotation-private-subject',
      ]);
      assert.equal(memberAssembly.snapshot.annotations.some((row) =>
        row.id === 'annotation-collection-private-other'), false);
      assert.equal(memberAssembly.snapshot.annotations.some((row) =>
        row.id === 'annotation-deleted' || row.id === 'annotation-orphan'), false);
    }
  });

  test('performs zero Annotation queries without include and expires create/delete/visibility continuations by fence', async () => {
    const annotationQueries: unknown[] = [];
    const queryPorts = ports(annotationQueries);
    const oldClient = isolated.runtime.pool;
    const noInclude = await getPublicationSnapshotPage(queryPorts, {
      collectionId: COLLECTION_ID, principal: { kind: 'anonymous' }, query: { limit: 2 },
    });
    assert.deepEqual(noInclude.snapshot.annotations, []);
    assert.equal(annotationQueries.length, 0);

    const first = await getPublicationSnapshotPage(queryPorts, {
      collectionId: COLLECTION_ID, principal: { kind: 'anonymous' },
      query: { include: ['annotations'], limit: 2 },
    });
    assert.ok(first.nextCursor);
    await oldClient.query(`update collections set content_revision='content-after-create' where id=$1`, [COLLECTION_ID]);
    await assert.rejects(() => getPublicationSnapshotPage(queryPorts, {
      collectionId: COLLECTION_ID, principal: { kind: 'anonymous' },
      query: { include: ['annotations'], limit: 2, pageCursor: first.nextCursor! },
    }), PublicationSnapshotExpiredError);

    await oldClient.query(`update collections set content_revision='content-1' where id=$1`, [COLLECTION_ID]);
    const restarted = await getPublicationSnapshotPage(queryPorts, {
      collectionId: COLLECTION_ID, principal: { kind: 'anonymous' },
      query: { include: ['annotations'], limit: 2 },
    });
    await oldClient.query(`update collections set policy_revision='policy-after-visibility' where id=$1`, [COLLECTION_ID]);
    await assert.rejects(() => getPublicationSnapshotPage(queryPorts, {
      collectionId: COLLECTION_ID, principal: { kind: 'anonymous' },
      query: { include: ['annotations'], limit: 2, pageCursor: restarted.nextCursor! },
    }), PublicationSnapshotExpiredError);
    await oldClient.query(`update collections set policy_revision='policy-1' where id=$1`, [COLLECTION_ID]);
  });

  test('a real COLP client assembles PostgreSQL/Fastify Node and Annotation pages', async () => {
    await isolated.runtime.pool.query(`insert into reading_progress
      (account_id,resource_type,resource_id,status,progress,revision,created_at,updated_at)
      values ($1,'node',$2,'in_progress',0.54321,1,current_timestamp,current_timestamp)
      on conflict (account_id,resource_type,resource_id) do update set progress=excluded.progress`,
    [MEMBER_ACCOUNT_ID, PUBLIC_NODE_ID]);
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
    const manifest = {
      ...coreManifest,
      mounts: coreManifest.mounts.map((mount) => ({
        ...mount,
        profiles: ['core', 'publication'] as const,
      })),
    };
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
      }).getSnapshot(COLLECTION_ID, { include: ['annotations'], limit: 2 });
      assert.deepEqual(snapshot.annotations.map((row) => row.id), [
        'annotation-collection-public', 'annotation-node-ai',
      ]);
      assert.deepEqual(snapshot.nodes.map((row) => row.id), [ROOT_ID, PUBLIC_NODE_ID]);
      const anonymousBytes = JSON.stringify(snapshot);
      assert.equal(anonymousBytes.includes(MEMBER_ACCOUNT_ID), false);
      assert.equal(anonymousBytes.includes('0.54321'), false);
      assert.equal(snapshot.annotations.some((row) => row.type === ('reading_state' as never)), false);
    } finally {
      queryPorts.cursors.destroy();
      await app.close();
    }
  });

  test('uses the Publication tuple index without Sort or Annotation Seq Scan on first/middle/final pages', async () => {
    const count = 12_000;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      select 'publication-plan-annotation-' || lpad(value::text, 6, '0'), 'annotation', current_timestamp
      from generate_series(1,$1) value`, [count]);
    await isolated.runtime.pool.query(`insert into annotations(
        id,collection_id,subject_type,subject_id,creator_principal_id,type,format,value_json,
        visibility,resource_revision,created_at,updated_at,payload_json)
      select annotation_id,$1::text,'node',$2::text,$3::text,'note','plain',to_jsonb(value),'public',revision,
        timestamptz '2026-07-25T00:00:00Z',timestamptz '2026-07-25T00:00:00Z',
        jsonb_build_object(
          'id',annotation_id,'collectionId',$1::text,
          'subject',jsonb_build_object('type','node','id',$2::text),
          'creator',jsonb_build_object('id',$6::text,'name','Publication Member'),
          'type','note','format','plain','value',to_jsonb(value),'visibility','public',
          'revision',revision,'createdAt',$4::text,'updatedAt',$4::text)
      from (select value,
        'publication-plan-annotation-' || lpad(value::text, 6, '0') annotation_id,
        'plan-revision-' || value::text revision
        from generate_series(1,$5::integer) value) seeded`,
    [COLLECTION_ID, PUBLIC_NODE_ID, MEMBER_ACCOUNT_ID, instant, count,
      `${ORIGIN}/profiles/member`]);
    await isolated.runtime.pool.query('analyze annotations');

    const positions = [
      ['first', undefined],
      ['middle', { subjectType: 'node' as const, subjectId: PUBLIC_NODE_ID,
        annotationId: 'publication-plan-annotation-006000' }],
      ['final', { subjectType: 'node' as const, subjectId: PUBLIC_NODE_ID,
        annotationId: 'publication-plan-annotation-011980' }],
    ] as const;
    for (const [label, after] of positions) {
      const statement = buildPublicationAnnotationCandidateStatement({
        collectionId: COLLECTION_ID, projection: 'public', limit: 20, ...(after ? { after } : {}),
      });
      const explained = await isolated.runtime.pool.query<{ 'QUERY PLAN': unknown }>(
        `explain (analyze, buffers, format json) ${statement.text}`,
        [...statement.values],
      );
      const plan = JSON.stringify(explained.rows[0]?.['QUERY PLAN']);
      assert.match(plan, /annotations_live_publication_keyset_idx/u, `${label}: ${plan}`);
      // The ORDER BY is keyset-satisfied; no external (disk) Sort may appear. A
      // bounded in-memory top-N sort is tolerable, an external sort is not.
      assert.doesNotMatch(plan, /"Sort Method":"external"/u, `${label}: ${plan}`);
      assert.doesNotMatch(plan, /"Node Type":"Seq Scan","Parallel Aware":false,"Async Capable":false,"Relation Name":"annotations"/u,
        `${label}: ${plan}`);
    }
  }, 120_000);

  function ports(annotationQueries: unknown[] = []): PublicationSnapshotQueryPorts {
    const annotationPort = createPostgresPublicationAnnotationReadPort(isolated.runtime, { origin: ORIGIN });
    const cursors = createPublicationCursorKeyring({
      active: { id: 'publication-annotation-active', secret: Buffer.alloc(32, 99).toString('base64') },
      retained: [],
    });
    return {
      reads: createPostgresPublicationSnapshotReadPort(isolated.runtime),
      annotations: {
        async loadPage(request) {
          annotationQueries.push(request);
          return annotationPort.loadPage(request);
        },
      },
      accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
      cursors, origin: ORIGIN,
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    };
  }

  async function traverse(
    queryPorts: PublicationSnapshotQueryPorts,
    principal: { kind: 'anonymous' } | { kind: 'account'; principalId: string; subjectId: string },
    limit: number,
  ): Promise<Snapshot[]> {
    const pages: Snapshot[] = [];
    let pageCursor: string | undefined;
    do {
      const result = await getPublicationSnapshotPage(queryPorts, {
        collectionId: COLLECTION_ID, principal,
        query: { include: ['annotations'], limit, ...(pageCursor ? { pageCursor } : {}) },
      });
      pages.push(result.snapshot);
      pageCursor = result.nextCursor ?? undefined;
    } while (pageCursor);
    return pages;
  }

  async function seedIdentity(): Promise<void> {
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status,email)
      values ($1,$2,'active','member@example.test'),($3,'publication-other-subject','active','other@example.test')`,
    [MEMBER_ACCOUNT_ID, MEMBER_SUBJECT_ID, OTHER_ACCOUNT_ID]);
    await isolated.runtime.pool.query(`insert into profiles(account_id,display_name)
      values ($1,'Publication Member'),($2,'Publication Other')`, [MEMBER_ACCOUNT_ID, OTHER_ACCOUNT_ID]);
    await isolated.runtime.pool.query(`insert into profile_handles(handle,account_id)
      values ('member',$1),('other',$2)`, [MEMBER_ACCOUNT_ID, OTHER_ACCOUNT_ID]);
  }

  async function seedCollection(): Promise<void> {
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values ($1,'collection'),($2,'node'),($3,'node'),($4,'node'),($5,'node')`,
    [COLLECTION_ID, ROOT_ID, PUBLIC_NODE_ID, PRIVATE_NODE_ID, ORPHAN_NODE_ID]);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,
        content_revision,policy_revision,commit_ordinal,publication_slug,published_at)
        values ($1,'subject-owner','Publication annotations','knowledge_collection','public',$2,
          'collection-resource-1','content-1','policy-1',1,'publication-annotations',current_timestamp)`,
      [COLLECTION_ID, ROOT_ID]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,position_token,
        resource_revision,children_revision)
        values
        ($1,$4,null,'folder',true,'Root',null,'[]','inherit',null,'root-revision','root-children'),
        ($2,$4,$1,'bookmark',false,'Public','https://example.test/public','[]','inherit','A','public-revision','public-children'),
        ($3,$4,$1,'bookmark',false,'Private','https://example.test/private','[]','private','B','private-revision','private-children'),
        ($5,$4,$1,'bookmark',false,'Orphan','https://example.test/orphan','[]','inherit','C','orphan-revision','orphan-children')`,
      [ROOT_ID, PUBLIC_NODE_ID, PRIVATE_NODE_ID, COLLECTION_ID, ORPHAN_NODE_ID]);
      await client.query(`insert into collection_members(collection_id,subject_id,role)
        values ($1,$2,'viewer')`, [COLLECTION_ID, MEMBER_SUBJECT_ID]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedAnnotations(): Promise<void> {
    await insertAnnotation('annotation-collection-public', 'collection', COLLECTION_ID, 'public', MEMBER_ACCOUNT_ID);
    await insertAnnotation('annotation-collection-protected', 'collection', COLLECTION_ID, 'protected', MEMBER_ACCOUNT_ID);
    await insertAnnotation('annotation-collection-private-self', 'collection', COLLECTION_ID, 'private', MEMBER_ACCOUNT_ID);
    await insertAnnotation('annotation-collection-private-other', 'collection', COLLECTION_ID, 'private', OTHER_ACCOUNT_ID);
    await insertAnnotation('annotation-node-ai', 'node', PUBLIC_NODE_ID, 'public', MEMBER_ACCOUNT_ID, {
      provenance: {
        kind: 'ai', provider: 'internal-provider', model: 'internal-model', generatedAt: instant,
      },
    });
    await insertAnnotation('annotation-private-subject', 'node', PRIVATE_NODE_ID, 'private', MEMBER_ACCOUNT_ID);
    await insertAnnotation('annotation-deleted', 'node', PUBLIC_NODE_ID, 'public', MEMBER_ACCOUNT_ID, {}, true);
    await insertAnnotation('annotation-orphan', 'node', ORPHAN_NODE_ID, 'public', MEMBER_ACCOUNT_ID);
    await isolated.runtime.pool.query(`update nodes set deleted_at=current_timestamp,deleted_commit_ordinal=2
      where id=$1`, [ORPHAN_NODE_ID]);
  }

  async function insertAnnotation(
    id: string,
    subjectType: 'collection' | 'node',
    subjectId: string,
    visibility: 'public' | 'unlisted' | 'protected' | 'private',
    creatorPrincipalId: string,
    extra: Record<string, unknown> = {},
    deleted = false,
  ): Promise<void> {
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values ($1,'annotation')`, [id]);
    const payload = {
      id, collectionId: COLLECTION_ID, subject: { type: subjectType, id: subjectId },
      creator: { id: `${ORIGIN}/profiles/${creatorPrincipalId === MEMBER_ACCOUNT_ID ? 'member' : 'other'}`,
        name: creatorPrincipalId === MEMBER_ACCOUNT_ID ? 'Publication Member' : 'Publication Other' },
      type: 'note', format: 'plain', value: `value-${id}`, visibility,
      revision: `revision-${id}`, createdAt: instant, updatedAt: instant, ...extra,
    };
    await isolated.runtime.pool.query(`insert into annotations(
      id,collection_id,subject_type,subject_id,creator_principal_id,type,format,value_json,
      visibility,resource_revision,created_at,updated_at,deleted_at,deleted_commit_ordinal,payload_json)
      values ($1,$2,$3,$4,$5,'note','plain',$6,$7,$8,$9,$9,
        case when $10 then $9::timestamptz else null end,case when $10 then 2 else null end,$11)`,
    [id, COLLECTION_ID, subjectType, subjectId, creatorPrincipalId, JSON.stringify(`value-${id}`),
      visibility, `revision-${id}`, instant, deleted, JSON.stringify(payload)]);
  }
});
