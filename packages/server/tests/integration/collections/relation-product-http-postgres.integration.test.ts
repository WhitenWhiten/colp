import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import type { components, operations } from '../../../generated/openapi/product-v1.js';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { createPostgresSharedExposureFactsPort, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork, createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresCollectionsUnitOfWork, createPostgresRelationMutationUnitOfWork, createPostgresRelationReadUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresPublicationSnapshotReadPort, createPostgresPublicationRelationReadPort, createPostgresProductPublicCollectionLocatorReadPort, createPostgresProductPublicCollectionViewCountReadPort } from '../../../src/infrastructure/publication/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import { createProductRelationCursorSigner } from '../../../src/modules/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
type RelationView = components['schemas']['RelationView'];
type CreateBody = operations['createRelation']['requestBody']['content']['application/json'];
type PatchBody = operations['updateRelation']['requestBody']['content']['application/merge-patch+json'];
interface Client { cookie: string; csrf: string; subjectId: string }

describeWithPostgres('P2B-12 real generated-contract Relation HTTP + PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_relation_product_http', { maxConnections: 10 });
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
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'relation-http-editor-key', NODE_ENV: 'test', LOG_LEVEL: 'silent',
    });
  }, 120_000);

  afterAll(async () => isolated?.close());

  function app() {
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    const cursors = createPublicationCursorKeyring({ active: { id: 'graph-http', secret: Buffer.alloc(32, 85).toString('base64') }, retained: [] });
    const api = buildApiApp({
      config, identityUnitOfWork,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      relationMutationUnitOfWork: createPostgresRelationMutationUnitOfWork(runtime.db),
      relationReadUnitOfWork: createPostgresRelationReadUnitOfWork(runtime.db, {
        cursorSigner: createProductRelationCursorSigner({
          current: { id: 'relation-http-v1', key: 'relation-product-http-key' },
        }),
      }),
      browserSessionAuthority: factory.authority,
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      productPublicCollectionQuery: {
        cursors,
        locators: createPostgresProductPublicCollectionLocatorReadPort(runtime),
        viewCounts: createPostgresProductPublicCollectionViewCountReadPort(runtime),
        owners: createPostgresPublicProfileFactsReadPort(runtime),
        snapshot: {
          cursors, origin: ORIGIN,
          reads: createPostgresPublicationSnapshotReadPort(runtime),
          relations: createPostgresPublicationRelationReadPort(runtime),
          accessPolicy: createPostgresAccessPolicyFactsPort(runtime.db),
          sharedExposure: createPostgresSharedExposureFactsPort(runtime),
        },
      },
    });
    api.addHook('onClose', async () => { cursors.destroy(); });
    return api;
  }

  async function login(subject: string): Promise<Client> {
    const client = await issueTestSession({
      factory,
      subject: subject,
      displayName: subject,
      handle: `rel_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    return { cookie: client.cookie, csrf: client.csrfToken, subjectId: client.subjectId };
  }

  function mutation(client: Client, commandId: string, contentType = 'application/json') {
    return { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf,
      'known-command-id': commandId, 'content-type': contentType };
  }

  test('generated contract executes CRUD/list with exact replay and concealment', async () => {
    const api = app();
    try {
      const owner = await login(`relation-owner-${randomUUID()}`);
      const viewer = await login(`relation-viewer-${randomUUID()}`);
      const outsider = await login(`relation-outsider-${randomUUID()}`);
      const createdCollection = await api.inject({ method: 'POST', url: '/api/v1/collections',
        headers: mutation(owner, randomUUID()),
        payload: { kind: 'knowledge_collection', title: 'Relations', summary: null } });
      assert.equal(createdCollection.statusCode, 201, createdCollection.body);
      const collection = createdCollection.json() as {
        collection: { id: string; etag: string }; root: { id: string; etag: string };
      };
      const slug = `relations-${randomUUID()}`;
      const published = await api.inject({ method: 'PATCH',
        url: `/api/v1/collections/${collection.collection.id}`,
        headers: { ...mutation(owner, randomUUID(), 'application/merge-patch+json'),
          'if-match': collection.collection.etag },
        payload: { visibility: 'public', publicationSlug: slug } });
      assert.equal(published.statusCode, 200, published.body);
      await runtime.pool.query(`insert into collection_members(collection_id,subject_id,role)
        values ($1,$2,'viewer')`, [collection.collection.id, viewer.subjectId]);
      const nodeResponse = await api.inject({ method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`,
        headers: mutation(owner, randomUUID()), payload: { parentId: collection.root.id,
          afterId: null, beforeId: null, node: { kind: 'bookmark', title: 'Endpoint',
            url: 'https://example.test/relation', description: null, tags: [], visibility: 'inherit' } } });
      assert.equal(nodeResponse.statusCode, 201, nodeResponse.body);
      const endpointId = (nodeResponse.json() as { node: { id: string } }).node.id;
      const collectionUrl = `/api/v1/collections/${collection.collection.id}/relations`;
      const graph = async (client?: Client) => {
        const nodes = new Set<string>();
        const relations: NonNullable<components['schemas']['PublicCollectionPage']['relations']> = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const query = new URLSearchParams({ include: 'relations', limit: '2', ...(cursor ? { cursor } : {}) });
          const response = await api.inject({ method: 'GET', url: `/api/v1/collections/${slug}?${query}`, headers: client ? { cookie: client.cookie } : {} });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.headers['cache-control'], 'private, no-store');
          const page = response.json() as components['schemas']['PublicCollectionPage'];
          assert.ok(page.relations);
          page.nodes.forEach((node) => nodes.add(node.id));
          relations.push(...page.relations);
          cursor = page.page.cursor ?? undefined;
          assert.ok(++pages < 20);
        } while (cursor);
        assert.ok(relations.every((relation) => nodes.has(relation.fromNodeId) && nodes.has(relation.toNodeId)));
        return relations;
      };
      assert.deepEqual(await graph(owner), []);

      const privateNodeResponse = await api.inject({ method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`, headers: mutation(owner, randomUUID()),
        payload: { parentId: collection.root.id, afterId: endpointId, beforeId: null,
          node: { kind: 'bookmark', title: 'Private endpoint', url: 'https://example.test/private',
            description: null, tags: [], visibility: 'private' } } });
      assert.equal(privateNodeResponse.statusCode, 201, privateNodeResponse.body);
      const privateEndpointId = (privateNodeResponse.json() as { node: { id: string } }).node.id;
      const tooBroad = await api.inject({ method: 'POST', url: collectionUrl,
        headers: mutation(owner, randomUUID()), payload: { fromNodeId: collection.root.id,
          toNodeId: privateEndpointId, type: 'related', label: null, visibility: 'protected', extensions: {} } });
      assert.equal(tooBroad.statusCode, 422, tooBroad.body);
      assert.equal(tooBroad.json().error.code, 'invalid_document');
      const createBody: CreateBody = { fromNodeId: collection.root.id, toNodeId: endpointId,
        type: 'related', label: 'original label', visibility: 'protected', extensions: {} };
      const createRequest = { method: 'POST' as const, url: collectionUrl,
        headers: mutation(owner, randomUUID()), payload: createBody };
      const created = await api.inject(createRequest);
      assert.equal(created.statusCode, 201, created.body);
      const createdView = created.json() as RelationView;
      assert.deepEqual(await graph(viewer), [{ id: createdView.id, fromNodeId: createBody.fromNodeId, toNodeId: createBody.toNodeId, type: 'related', label: 'original label' }]);
      assert.deepEqual(await graph(), []);
      assert.equal(created.headers.etag, `"${createdView.revision}"`);
      assert.equal(created.body.includes('payload'), false);
      const createReplay = await api.inject(createRequest);
      assertReplay(createReplay, created);

      const itemUrl = `${collectionUrl}/${createdView.id}`;
      const item = await api.inject({ method: 'GET', url: itemUrl, headers: { cookie: viewer.cookie } });
      assert.equal(item.statusCode, 200, item.body);
      assert.deepEqual(item.json(), createdView);
      const outgoing = await api.inject({ method: 'GET',
        url: `${collectionUrl}?nodeId=${collection.root.id}&direction=outgoing&type=related&visibility=protected`,
        headers: { cookie: viewer.cookie } });
      assert.equal(outgoing.statusCode, 200, outgoing.body);
      assert.deepEqual(outgoing.json().relations.map((relation: RelationView) => relation.id), [createdView.id]);
      const incoming = await api.inject({ method: 'GET',
        url: `${collectionUrl}?nodeId=${endpointId}&direction=incoming`, headers: { cookie: owner.cookie } });
      assert.equal(incoming.statusCode, 200, incoming.body);
      assert.deepEqual(incoming.json().relations.map((relation: RelationView) => relation.id), [createdView.id]);
      const concealed = await api.inject({ method: 'GET', url: itemUrl, headers: { cookie: outsider.cookie } });
      assert.equal(concealed.statusCode, 404);
      assert.equal(concealed.body.includes('original label'), false);
      assert.equal((await api.inject({ method: 'GET', url: itemUrl })).statusCode, 401);

      const patchBody: PatchBody = { type: 'supports', label: 'updated label', visibility: 'private' };
      const patchRequest = { method: 'PATCH' as const, url: itemUrl,
        headers: { ...mutation(owner, randomUUID(), 'application/merge-patch+json'),
          'if-match': String(created.headers.etag) }, payload: patchBody };
      const patched = await api.inject(patchRequest);
      assert.equal(patched.statusCode, 200, patched.body);
      const patchedView = patched.json() as RelationView;
      assert.equal(patchedView.label, 'updated label');
      assert.equal(patchedView.type, 'supports');
      assert.equal(patchedView.visibility, 'private');
      assert.equal((await graph(owner))[0]?.label, 'updated label');
      assert.deepEqual(await graph(viewer), []);
      assertReplay(await api.inject(patchRequest), patched);
      const current = await api.inject({ method: 'GET', url: itemUrl, headers: { cookie: owner.cookie } });
      assert.equal(current.statusCode, 200);
      assert.deepEqual(current.json(), patchedView);

      const deleteRequest = { method: 'DELETE' as const, url: itemUrl,
        headers: { ...mutation(owner, randomUUID()), 'if-match': String(patched.headers.etag) } };
      delete deleteRequest.headers['content-type'];
      const deleted = await api.inject(deleteRequest);
      assert.equal(deleted.statusCode, 200, deleted.body);
      assertReplay(await api.inject(deleteRequest), deleted);
      assert.equal((await api.inject({ method: 'GET', url: itemUrl,
        headers: { cookie: owner.cookie } })).statusCode, 404);
      const afterDelete = await api.inject({ method: 'GET',
        url: `${collectionUrl}?nodeId=${collection.root.id}&direction=both`, headers: { cookie: owner.cookie } });
      assert.equal(afterDelete.statusCode, 200);
      assert.deepEqual(afterDelete.json().relations, []);
      assert.deepEqual(await graph(owner), []);
      // Public relation creation/deletion must also change the anonymous graph immediately.
      const publicRelation = await api.inject({ method: 'POST', url: collectionUrl,
        headers: mutation(owner, randomUUID()), payload: { ...createBody, visibility: 'public' } });
      assert.equal(publicRelation.statusCode, 201, publicRelation.body);
      assert.equal((await graph())[0]?.id, publicRelation.json().id);
      const publicDeleteHeaders = { ...mutation(owner, randomUUID()), 'if-match': String(publicRelation.headers.etag) };
      delete publicDeleteHeaders['content-type'];
      assert.equal((await api.inject({ method: 'DELETE', url: `${collectionUrl}/${publicRelation.json().id}`, headers: publicDeleteHeaders })).statusCode, 200);
      assert.deepEqual(await graph(), []);
    } finally {
      await api.close();
    }
  }, 120_000);
});

function assertReplay(actual: { statusCode: number; body: string; headers: Record<string, unknown> },
  expected: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  assert.equal(actual.statusCode, expected.statusCode);
  assert.equal(actual.body, expected.body);
  assert.equal(actual.headers.etag, expected.headers.etag);
  assert.equal(actual.headers.location, expected.headers.location);
}
