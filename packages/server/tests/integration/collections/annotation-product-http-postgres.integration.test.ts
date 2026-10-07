import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresAnnotationMutationUnitOfWork, createPostgresAnnotationReadUnitOfWork, createPostgresCanonicalMutationUnitOfWork, createPostgresCollectionsUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createProductAnnotationCursorSigner } from '../../../src/modules/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';

interface Client { cookie: string; csrf: string; subjectId: string; accountId: string }

describeWithPostgres('P2B-07 real Product Annotation HTTP + PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_annotation_product_http', { maxConnections: 10 });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
    config = loadConfig({
      DATABASE_URL: isolated.databaseUrl, PRODUCT_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: 'https://issuer.example/realms/known', OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'annotation-http-editor-key', NODE_ENV: 'test', LOG_LEVEL: 'silent',
    });
  }, 120_000);

  afterAll(async () => isolated?.close());

  function app() {
    const identity = createPostgresIdentityUnitOfWork(runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    return buildApiApp({
      config, identityUnitOfWork: identity,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      annotationMutationUnitOfWork: createPostgresAnnotationMutationUnitOfWork(runtime.db),
      annotationReadUnitOfWork: createPostgresAnnotationReadUnitOfWork(runtime.db, {
        cursorSigner: createProductAnnotationCursorSigner({
          current: { id: 'annotation-http-v1', key: 'annotation-product-http-key' },
        }),
      }),
      browserSessionAuthority: factory.authority,
    });
  }

  async function login(oidcSubject: string): Promise<Client> {
    const client = await issueTestSession({
      factory,
      subject: oidcSubject,
      displayName: oidcSubject,
      handle: `anno_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    });
    return { cookie: client.cookie, csrf: client.csrfToken, subjectId: client.subjectId,
      accountId: client.accountId };
  }

  function mutation(client: Client, commandId: string, contentType = 'application/json') {
    return { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf,
      'known-command-id': commandId, 'content-type': contentType };
  }

  test('CRUD, complete keyset traversal, cross-principal rejection and exact replay are durable', async () => {
    const api = app();
    try {
      const owner = await login(`annotation-owner-${randomUUID()}`);
      const member = await login(`annotation-member-${randomUUID()}`);
      const editor = await login(`annotation-editor-${randomUUID()}`);
      const outsider = await login(`annotation-outsider-${randomUUID()}`);
      await runtime.pool.query(`update profile_handles set handle='annotation_owner' where account_id=$1`,
        [owner.accountId]);
      await runtime.pool.query(`update profile_handles set handle='annotation_member' where account_id=$1`,
        [member.accountId]);
      const createCollection = await api.inject({ method: 'POST', url: '/api/v1/collections',
        headers: mutation(owner, randomUUID()), payload: { kind: 'knowledge_collection', title: 'Annotations', summary: null } });
      assert.equal(createCollection.statusCode, 201);
      const collection = createCollection.json() as {
        collection: { id: string; etag: string }; root: { id: string };
      };
      const publishCollection = await api.inject({ method: 'PATCH',
        url: `/api/v1/collections/${collection.collection.id}`,
        headers: { ...mutation(owner, randomUUID(), 'application/merge-patch+json'),
          'if-match': collection.collection.etag },
        payload: { visibility: 'public', publicationSlug: `annotation-${randomUUID()}` } });
      assert.equal(publishCollection.statusCode, 200, publishCollection.body);
      await runtime.pool.query(`insert into collection_members(collection_id,subject_id,role)
        values ($1,$2,'viewer') on conflict (collection_id,subject_id) do update set role='viewer'`,
      [collection.collection.id, member.subjectId]);
      await runtime.pool.query(`insert into collection_members(collection_id,subject_id,role)
        values ($1,$2,'editor') on conflict (collection_id,subject_id) do update set role='editor'`,
      [collection.collection.id, editor.subjectId]);
      const nodeResponse = await api.inject({ method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`, headers: mutation(owner, randomUUID()),
        payload: { parentId: collection.root.id, afterId: null, beforeId: null,
          node: { kind: 'bookmark', title: 'Subject', url: 'https://example.test/', description: null, tags: [], visibility: 'inherit' } } });
      assert.equal(nodeResponse.statusCode, 201);
      const nodeId = (nodeResponse.json() as { node: { id: string } }).node.id;

      const reservedBefore = await runtime.pool.query(`select
        (select count(*)::int from annotations) annotations,
        (select count(*)::int from resource_id_ledger) ledger,
        (select count(*)::int from operations) operations,
        (select count(*)::int from audit_events) audit,
        (select count(*)::int from outbox_events) outbox,
        (select count(*)::int from product_command_receipts) receipts`);
      const reserved = await api.inject({ method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/annotations?resourceType=node&resourceId=${nodeId}`,
        headers: mutation(owner, randomUUID()),
        payload: { type: 'reading_state', format: 'json', value: { status: 'completed', progress: 1 },
          visibility: 'private', extensions: {} } });
      assert.equal(reserved.statusCode, 422, reserved.body);
      assert.equal(reserved.json().error.code, 'invalid_document');
      const reservedAfter = await runtime.pool.query(`select
        (select count(*)::int from annotations) annotations,
        (select count(*)::int from resource_id_ledger) ledger,
        (select count(*)::int from operations) operations,
        (select count(*)::int from audit_events) audit,
        (select count(*)::int from outbox_events) outbox,
        (select count(*)::int from product_command_receipts) receipts`);
      assert.deepEqual(reservedAfter.rows[0], reservedBefore.rows[0]);

      const privateCreate = await api.inject({ method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/annotations?resourceType=node&resourceId=${nodeId}`,
        headers: mutation(member, randomUUID()),
        payload: { type: 'custom', value: { score: 5 }, visibility: 'private' } });
      assert.equal(privateCreate.statusCode, 201, privateCreate.body);
      const privateId = privateCreate.json().id as string;
      for (const denied of [owner, editor]) {
        const concealed = await api.inject({ method: 'GET',
          url: `/api/v1/collections/${collection.collection.id}/annotations/${privateId}`,
          headers: { cookie: denied.cookie } });
        assert.equal(concealed.statusCode, 404);
      }
      const creatorRead = await api.inject({ method: 'GET',
        url: `/api/v1/collections/${collection.collection.id}/annotations/${privateId}`,
        headers: { cookie: member.cookie } });
      assert.equal(creatorRead.statusCode, 200);
      assert.equal(creatorRead.json().creator.id, `${ORIGIN}/profiles/annotation_member`);
      assert.deepEqual(creatorRead.json().value, { score: 5 });
      assert.equal(creatorRead.body.includes(member.accountId), false);
      const outsiderRead = await api.inject({ method: 'GET',
        url: `/api/v1/collections/${collection.collection.id}/annotations?resourceType=node&resourceId=${nodeId}`,
        headers: { cookie: outsider.cookie } });
      assert.equal(outsiderRead.statusCode, 200);
      assert.deepEqual(outsiderRead.json(), {
        annotations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null },
      });
      assert.equal(outsiderRead.body.includes(privateId), false);
      const anonymousRead = await api.inject({ method: 'GET',
        url: `/api/v1/collections/${collection.collection.id}/annotations?resourceType=node&resourceId=${nodeId}` });
      assert.equal(anonymousRead.statusCode, 401);

      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const commandId = randomUUID();
        const request = { method: 'POST' as const,
          url: `/api/v1/collections/${collection.collection.id}/annotations?resourceType=node&resourceId=${nodeId}`,
          headers: mutation(owner, commandId),
          payload: { type: 'note', format: index === 0 ? 'html' : 'plain', value: index === 0 ? '<em>untrusted</em>' : `note-${index}`,
            visibility: 'protected', extensions: {} } };
        const response = await api.inject(request);
        assert.equal(response.statusCode, 201);
        assert.match(String(response.headers.location), /\/annotations\//u);
        assert.equal(response.headers.etag, `"${response.json().revision}"`);
        ids.push(response.json().id);
        if (index === 0) {
          const replay = await api.inject(request);
          assert.equal(replay.statusCode, 201);
          assert.equal(replay.body, response.body);
          assert.equal(replay.headers.location, response.headers.location);
          assert.equal(replay.headers.etag, response.headers.etag);
          const counts = await runtime.pool.query<{ annotations: string; receipts: string }>(
            `select (select count(*) from annotations where id=$1)::text annotations,
                    (select count(*) from product_command_receipts where target_identity=$1)::text receipts`,
            [response.json().id]);
          assert.deepEqual(counts.rows[0], { annotations: '1', receipts: '1' });
        }
      }

      for (const allowed of [owner, editor, member]) {
        const sharedRead = await api.inject({ method: 'GET',
          url: `/api/v1/collections/${collection.collection.id}/annotations/${ids[0]}`,
          headers: { cookie: allowed.cookie } });
        assert.equal(sharedRead.statusCode, 200);
        assert.equal(sharedRead.json().id, ids[0]);
      }
      const concealedShared = await api.inject({ method: 'GET',
        url: `/api/v1/collections/${collection.collection.id}/annotations/${ids[0]}`,
        headers: { cookie: outsider.cookie } });
      assert.equal(concealedShared.statusCode, 404);
      const outsiderSharedPage = await api.inject({ method: 'GET',
        url: `/api/v1/collections/${collection.collection.id}/annotations?resourceType=node&resourceId=${nodeId}`,
        headers: { cookie: outsider.cookie } });
      assert.equal(outsiderSharedPage.statusCode, 200);
      assert.deepEqual(outsiderSharedPage.json().annotations, []);

      const traversed: string[] = [];
      let url = `/api/v1/collections/${collection.collection.id}/annotations?resourceType=node&resourceId=${nodeId}&limit=2`;
      let firstCursor: string | null = null;
      do {
        const pageResponse = await api.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
        assert.equal(pageResponse.statusCode, 200);
        const page = pageResponse.json() as { annotations: Array<{ id: string }>; page: { nextCursor: string | null } };
        traversed.push(...page.annotations.map((item) => item.id));
        firstCursor ??= page.page.nextCursor;
        url = page.page.nextCursor
          ? `/api/v1/collections/${collection.collection.id}/annotations?resourceType=node&resourceId=${nodeId}&cursor=${encodeURIComponent(page.page.nextCursor)}` : '';
      } while (url);
      assert.deepEqual(new Set(traversed), new Set(ids));
      assert.equal(traversed.length, ids.length);
      assert.ok(firstCursor);
      const crossPrincipal = await api.inject({ method: 'GET',
        url: `/api/v1/collections/${collection.collection.id}/annotations?resourceType=node&resourceId=${nodeId}&cursor=${encodeURIComponent(firstCursor)}`,
        headers: { cookie: member.cookie } });
      assert.equal(crossPrincipal.statusCode, 400);
      assert.equal(crossPrincipal.json().error.code, 'invalid_cursor');

      const target = ids[0]!;
      const get = await api.inject({ method: 'GET', url: `/api/v1/collections/${collection.collection.id}/annotations/${target}`, headers: { cookie: owner.cookie } });
      assert.equal(get.statusCode, 200);
      assert.equal(get.json().value, '<em>untrusted</em>');
      const patchCommand = randomUUID();
      const patchRequest = { method: 'PATCH' as const, url: `/api/v1/collections/${collection.collection.id}/annotations/${target}`,
        headers: { ...mutation(owner, patchCommand, 'application/merge-patch+json'), 'if-match': String(get.headers.etag) },
        payload: JSON.stringify({ format: 'plain', value: 'edited' }) };
      const patched = await api.inject(patchRequest);
      assert.equal(patched.statusCode, 200);
      const patchReplay = await api.inject(patchRequest);
      assert.equal(patchReplay.statusCode, 200);
      assert.equal(patchReplay.body, patched.body);
      assert.equal(patchReplay.headers.etag, patched.headers.etag);
      assert.equal(patchReplay.headers.location, patched.headers.location);
      assert.equal(typeof patched.headers.location, 'string');
      const stalePatch = await api.inject({ method: 'PATCH', url: patchRequest.url,
        headers: { ...mutation(owner, randomUUID(), 'application/merge-patch+json'),
          'if-match': String(get.headers.etag) }, payload: JSON.stringify({ value: 'stale' }) });
      assert.equal(stalePatch.statusCode, 412);
      assert.equal(stalePatch.json().error.code, 'precondition_failed');

      const beforeDelete = await runtime.pool.query<{ operations: string; outbox: string; receipts: string }>(
        `select (select count(*) from operation_payloads where payload_json->>'resourceId'=$1
                  and payload_json->>'resourceKind'='annotation')::text operations,
                (select count(*) from outbox_events where aggregate_id=$1)::text outbox,
                (select count(*) from product_command_receipts where target_identity=$1)::text receipts`, [target]);
      const deleteCommand = randomUUID();
      const deleteRequest = { method: 'DELETE' as const,
        url: `/api/v1/collections/${collection.collection.id}/annotations/${target}`,
        headers: { cookie: owner.cookie, origin: ORIGIN, 'x-csrf-token': owner.csrf,
          'known-command-id': deleteCommand, 'if-match': String(patched.headers.etag) } };
      const deleted = await api.inject(deleteRequest);
      assert.equal(deleted.statusCode, 200, deleted.body);
      const replay = await api.inject(deleteRequest);
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.body, deleted.body);
      assert.equal(replay.headers.location, deleted.headers.location);
      assert.equal(replay.headers.etag, deleted.headers.etag);
      const afterDelete = await runtime.pool.query<{ operations: string; outbox: string; receipts: string }>(
        `select (select count(*) from operation_payloads where payload_json->>'resourceId'=$1
                  and payload_json->>'resourceKind'='annotation')::text operations,
                (select count(*) from outbox_events where aggregate_id=$1)::text outbox,
                (select count(*) from product_command_receipts where target_identity=$1)::text receipts`, [target]);
      assert.equal(Number(afterDelete.rows[0]!.operations) - Number(beforeDelete.rows[0]!.operations), 1);
      assert.equal(Number(afterDelete.rows[0]!.outbox) - Number(beforeDelete.rows[0]!.outbox), 1);
      assert.equal(Number(afterDelete.rows[0]!.receipts) - Number(beforeDelete.rows[0]!.receipts), 1);
      const concealed = await api.inject({ method: 'GET', url: `/api/v1/collections/${collection.collection.id}/annotations/${target}`, headers: { cookie: owner.cookie } });
      assert.equal(concealed.statusCode, 404);
    } finally {
      await api.close();
    }
  }, 120_000);

  test('first, middle, and final Annotation pages use the matching live-subject keyset index', async () => {
    const api = app();
    try {
      const owner = await login(`annotation-plan-owner-${randomUUID()}`);
      const createCollection = await api.inject({ method: 'POST', url: '/api/v1/collections',
        headers: mutation(owner, randomUUID()),
        payload: { kind: 'knowledge_collection', title: 'Annotation query plan', summary: null } });
      assert.equal(createCollection.statusCode, 201, createCollection.body);
      const collection = createCollection.json() as { collection: { id: string }; root: { id: string } };
      const otherNodeIds: string[] = [];
      for (let index = 0; index < 9; index += 1) {
        const created = await api.inject({ method: 'POST',
          url: `/api/v1/collections/${collection.collection.id}/nodes`,
          headers: mutation(owner, randomUUID()), payload: { parentId: collection.root.id,
            afterId: null, beforeId: null, node: { kind: 'bookmark', title: `Plan distractor ${index}`,
              url: `https://example.test/plan/${index}`, description: null, tags: [], visibility: 'inherit' } } });
        assert.equal(created.statusCode, 201, created.body);
        otherNodeIds.push((created.json() as { node: { id: string } }).node.id);
      }
      const count = 6_000;
      await runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
        select 'annotation-plan-' || value::text, 'annotation', current_timestamp
        from generate_series(1,$1) value`, [count]);
      await runtime.pool.query(`insert into annotations(
          id,collection_id,subject_type,subject_id,creator_principal_id,type,format,value_json,
          visibility,resource_revision,created_at,updated_at,deleted_at,deleted_commit_ordinal,
          payload_json,payload_schema_version,payload_authority_status)
        select annotation_id,$1::text,'node',$2::text,$3::text,'note','plain',to_jsonb(value),
          'protected',revision,created_at,created_at,null,null,
          jsonb_build_object(
            'id',annotation_id,'collectionId',$1::text,
            'subject',jsonb_build_object('type','node','id',$2::text),
            'creator',jsonb_build_object('id','https://app.example.test/profiles/plan','name','Plan'),
            'type','note','format','plain','value',to_jsonb(value),'visibility','protected',
            'revision',revision,
            'createdAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'updatedAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'extensions',jsonb_build_object()),1,'backfilled'
        from (select value,'annotation-plan-' || value::text annotation_id,
          'annotation-plan-revision-' || value::text revision,
          timestamptz '2026-07-01T00:00:00Z' + value * interval '1 second' created_at
        from generate_series(1,$4::integer) value) seeded`,
      [collection.collection.id, collection.root.id, owner.accountId, count]);
      const distractorCount = 54_000;
      await runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
        select 'annotation-plan-other-' || value::text, 'annotation', current_timestamp
        from generate_series(1,$1) value`, [distractorCount]);
      await runtime.pool.query(`insert into annotations(
          id,collection_id,subject_type,subject_id,creator_principal_id,type,format,value_json,
          visibility,resource_revision,created_at,updated_at,deleted_at,deleted_commit_ordinal,
          payload_json,payload_schema_version,payload_authority_status)
        select annotation_id,$1::text,'node',subject_id,$2::text,'note','plain',to_jsonb(value),
          'protected',revision,created_at,created_at,null,null,
          jsonb_build_object(
            'id',annotation_id,'collectionId',$1::text,
            'subject',jsonb_build_object('type','node','id',subject_id),
            'creator',jsonb_build_object('id','https://app.example.test/profiles/plan','name','Plan'),
            'type','note','format','plain','value',to_jsonb(value),'visibility','protected',
            'revision',revision,
            'createdAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'updatedAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'extensions',jsonb_build_object()),1,'backfilled'
        from (select value,'annotation-plan-other-' || value::text annotation_id,
          'annotation-plan-other-revision-' || value::text revision,
          ($3::text[])[((value - 1) % array_length($3::text[],1)) + 1] subject_id,
          timestamptz '2026-07-01T00:00:00Z' + value * interval '1 second' created_at
        from generate_series(1,$4::integer) value) seeded`,
      [collection.collection.id, owner.accountId, otherNodeIds, distractorCount]);
      await runtime.pool.query('analyze annotations');

      const explain = async (after?: { updatedAt: string; id: string }) => {
        const result = await runtime.pool.query<{ 'QUERY PLAN': unknown }>(`explain (analyze, buffers, format json)
          select * from annotations
          where collection_id=$1 and subject_type='node' and subject_id=$2 and deleted_at is null
            and (creator_principal_id=$3 or visibility in ('public','unlisted','protected'))
            ${after ? `and updated_at <= $4::timestamptz
              and (updated_at < $4::timestamptz
              or (updated_at = $4::timestamptz and id collate "C" > $5::text collate "C"))` : ''}
          order by updated_at desc, id collate "C" asc limit 21`,
        after
          ? [collection.collection.id, collection.root.id, owner.accountId, after.updatedAt, after.id]
          : [collection.collection.id, collection.root.id, owner.accountId]);
        return JSON.stringify(result.rows[0]?.['QUERY PLAN']);
      };
      for (const [label, plan] of [
        ['first', await explain()],
        ['middle', await explain({ updatedAt: '2026-07-01T00:50:00.000Z', id: 'annotation-plan-3000' })],
        ['final', await explain({ updatedAt: '2026-07-01T00:00:22.000Z', id: 'annotation-plan-22' })],
      ] as const) {
        assert.match(plan, /annotations_live_subject_keyset_idx/u, `${label}: ${plan}`);
        assert.doesNotMatch(plan, /"Node Type":"(?:Sort|Seq Scan)"/u, `${label}: ${plan}`);
      }
    } finally {
      await api.close();
    }
  }, 120_000);
  test('collection notes snapshot reflects updates and deletes and conceals other owners', async () => {
    const api = app();
    try {
      const owner = await login(`note-snapshot-owner-${randomUUID()}`), foreign = await login(`note-snapshot-foreign-${randomUUID()}`);
      const created = await api.inject({ method: 'POST', url: '/api/v1/collections', headers: mutation(owner, randomUUID()),
        payload: { kind: 'knowledge_collection', title: 'Note snapshot', summary: null } });
      assert.equal(created.statusCode, 201, created.body);
      const collection = created.json() as { collection: { id: string }; root: { id: string } };
      const collectionId = collection.collection.id;
      const node = await api.inject({ method: 'POST', url: `/api/v1/collections/${collectionId}/nodes`, headers: mutation(owner, randomUUID()),
        payload: { parentId: collection.root.id, afterId: null, beforeId: null,
          node: { kind: 'bookmark', title: 'Page', url: 'https://example.test/snapshot', description: null, tags: [], visibility: 'inherit' } } });
      assert.equal(node.statusCode, 201, node.body);
      const note = await api.inject({ method: 'POST', url: `/api/v1/collections/${collectionId}/annotations?resourceType=node&resourceId=${node.json().node.id}`,
        headers: mutation(owner, randomUUID()), payload: { type: 'note', format: 'plain', value: 'Original', visibility: 'private', extensions: {} } });
      assert.equal(note.statusCode, 201, note.body);
      const url = `/api/v1/collections/${collectionId}/annotations?resourceType=collection&resourceId=${collectionId}&collectionNotes=true`;
      const snapshot = await api.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
      assert.equal(snapshot.statusCode, 200, snapshot.body); assert.equal(snapshot.json().annotations[0].value, 'Original');
      const cached = await api.inject({ method: 'GET', url: `${url}&knownRevision=${snapshot.json().revision}`, headers: { cookie: owner.cookie } });
      assert.equal(cached.statusCode, 200, cached.body); assert.equal(cached.json().unchanged, true);
      assert.equal((await api.inject({ method: 'GET', url, headers: { cookie: foreign.cookie } })).statusCode, 404);
      const patch = await api.inject({ method: 'PATCH', url: `/api/v1/collections/${collectionId}/annotations/${note.json().id}`,
        headers: { ...mutation(owner, randomUUID(), 'application/merge-patch+json'), 'if-match': `"${note.json().revision}"` }, payload: { value: 'Changed' } });
      assert.equal(patch.statusCode, 200, patch.body);
      const changed = await api.inject({ method: 'GET', url: `${url}&knownRevision=${snapshot.json().revision}`, headers: { cookie: owner.cookie } });
      assert.equal(changed.statusCode, 200, changed.body); assert.equal(changed.json().annotations[0].value, 'Changed');
      const removed = await api.inject({ method: 'DELETE', url: `/api/v1/collections/${collectionId}/annotations/${note.json().id}`,
        headers: { cookie: owner.cookie, origin: ORIGIN, 'x-csrf-token': owner.csrf, 'known-command-id': randomUUID(), 'if-match': `"${patch.json().revision}"` } });
      assert.equal(removed.statusCode, 200, removed.body);
      const empty = await api.inject({ method: 'GET', url: `${url}&knownRevision=${changed.json().revision}`, headers: { cookie: owner.cookie } });
      assert.equal(empty.statusCode, 200, empty.body); assert.deepEqual(empty.json().annotations, []); assert.notEqual(empty.json().unchanged, true);
    } finally { await api.close(); }
  }, 120_000);

});
