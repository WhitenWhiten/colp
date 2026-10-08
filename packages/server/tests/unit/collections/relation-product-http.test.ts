import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createProductRelationCursorSigner,
  type CollectionsUnitOfWork,
  type ProductRelationRow,
  type RelationMutationUnitOfWork,
  type RelationReadUnitOfWork,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import { createIdentityMemoryState, createIdentityMemoryUnitOfWork } from '../../support/product-http-harness.js';
import { createMemoryProductCollectionMutationUnitOfWork } from '../../support/product-canonical-memory.js';

const ORIGIN = 'https://app.example.test';
const COLLECTION_ID = 'relation-http-collection';
const NODE_ID = 'relation-http-node';
const NOW = new Date('2026-07-25T11:00:00.000Z');

function relationRow(): ProductRelationRow {
  return { id: 'relation-http-1', collectionId: COLLECTION_ID, fromNodeId: NODE_ID, toNodeId: 'other-node',
    payload: { id: 'relation-http-1', collectionId: COLLECTION_ID, fromNodeId: NODE_ID,
      toNodeId: 'other-node', type: 'related', label: 'Related', visibility: 'protected',
      revision: 'relation-revision-1', createdAt: '2026-07-25T10:00:00.000Z',
      updatedAt: '2026-07-25T10:00:00.000Z', extensions: {} },
    resourceRevision: 'relation-revision-1', updatedAt: new Date('2026-07-25T10:00:00.000Z'), deletedAt: null };
}

function harness() {
  const identityState = createIdentityMemoryState(NOW);
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(identityState);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const rows = [relationRow()];
  const relationReadUnitOfWork: RelationReadUnitOfWork = { execute: async (work) => work({
    clock: { now: async () => new Date(NOW) },
    cursorSigner: createProductRelationCursorSigner({ current: { id: 'relation-http-v1', key: 'relation-http-cursor-key' } }),
    accessPolicy: { loadCollectionFacts: async ({ actorSubjectId }) => ({ collectionId: COLLECTION_ID,
      ownerSubjectId: actorSubjectId, visibility: 'private', policyRevision: 'policy-http-1',
      membershipRole: 'owner', deleted: false }) },
    reads: {
      loadLiveNode: async ({ nodeId }) => nodeId === NODE_ID || nodeId === 'other-node'
        ? { id: nodeId, collectionId: COLLECTION_ID, visibility: 'private' } : null,
      loadLiveById: async ({ relationId }) => rows.find((row) => row.id === relationId) ?? null,
      listLiveByNode: async ({ limit }) => rows.slice(0, limit + 1),
    },
  }) };
  const relationMutationUnitOfWork: RelationMutationUnitOfWork = {
    execute: async () => { throw new Error('mutation must not pass admission'); },
  };
  const collectionsUnitOfWork: CollectionsUnitOfWork = { execute: async () => { throw new Error('unused'); } };
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/known_test', PRODUCT_ORIGIN: ORIGIN,
    ALLOWED_ORIGINS: ORIGIN, OIDC_ISSUER: 'https://issuer.example/realms/known', OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token', OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  const app = buildApiApp({ config, collectionMetadataMutationRoutes: 'disabled', identityUnitOfWork,
    collectionsUnitOfWork, productCollectionMutationUnitOfWork: createMemoryProductCollectionMutationUnitOfWork(collectionsUnitOfWork),
    relationReadUnitOfWork, relationMutationUnitOfWork, browserSessionAuthority: factory.authority });
  return { app, identityUnitOfWork, identityState, factory };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length > 0) await apps.pop()!.close(); });

async function session(value: ReturnType<typeof harness>) {
  const client = await issueTestSession({
    factory: value.factory, subject: randomUUID(), displayName: 'Relation',
    handle: `relation_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
  });
  return { cookie: client.cookie, csrf: client.csrfToken, accountId: client.accountId };
}

describe('P2B-12 Relation Product HTTP boundary', () => {
  test('requires Session and exposes item/list with ETag and private no-store', async () => {
    const value = harness(); apps.push(value.app);
    const url = `/api/v1/collections/${COLLECTION_ID}/relations?nodeId=${NODE_ID}&direction=both`;
    assert.equal((await value.app.inject({ method: 'GET', url })).statusCode, 401);
    const client = await session(value);
    const list = await value.app.inject({ method: 'GET', url, headers: { cookie: client.cookie } });
    assert.equal(list.statusCode, 200); assert.equal(list.headers['cache-control'], 'private, no-store');
    assert.deepEqual(list.json().relations.map((item: { id: string }) => item.id), ['relation-http-1']);
    const item = await value.app.inject({ method: 'GET',
      url: `/api/v1/collections/${COLLECTION_ID}/relations/relation-http-1`, headers: { cookie: client.cookie } });
    assert.equal(item.statusCode, 200); assert.equal(item.headers.etag, '"relation-revision-1"');
    assert.equal(item.body.includes('payload'), false);
  });

  test('rejects unknown, repeated, empty, noncanonical and invalid filters', async () => {
    const value = harness(); apps.push(value.app); const client = await session(value);
    for (const query of [
      `nodeId=${NODE_ID}&direction=incoming&direction=outgoing`, `nodeId=${NODE_ID}&direction=sideways`,
      `nodeId=&direction=both`, `nodeId=${NODE_ID}&direction=both&type=related,related`,
      `nodeId=${NODE_ID}&direction=both&type=unknown`, `nodeId=${NODE_ID}&direction=both&visibility=private,private`,
      `nodeId=${NODE_ID}&direction=both&limit=01`, `nodeId=${NODE_ID}&direction=both&unknown=1`,
      `nodeId=%20${NODE_ID}&direction=both`,
    ]) {
      const response = await value.app.inject({ method: 'GET',
        url: `/api/v1/collections/${COLLECTION_ID}/relations?${query}`, headers: { cookie: client.cookie } });
      assert.equal(response.statusCode, 400, query); assert.equal(response.json().error.code, 'invalid_query', query);
    }
  });

  test('enforces Origin, CSRF, media, body, command and strong If-Match admission', async () => {
    const value = harness(); apps.push(value.app); const client = await session(value);
    const item = `/api/v1/collections/${COLLECTION_ID}/relations/relation-http-1`;
    const missingCsrf = await value.app.inject({ method: 'PATCH', url: item, headers: { cookie: client.cookie,
      origin: ORIGIN, 'known-command-id': randomUUID(), 'if-match': '"relation-revision-1"',
      'content-type': 'application/merge-patch+json' }, payload: { label: 'changed' } });
    assert.equal(missingCsrf.statusCode, 403);
    const weak = await value.app.inject({ method: 'DELETE', url: item, headers: { cookie: client.cookie,
      origin: ORIGIN, 'x-csrf-token': client.csrf, 'known-command-id': randomUUID(),
      'if-match': 'W/"relation-revision-1"' } });
    assert.equal(weak.statusCode, 400);
    const missing = await value.app.inject({ method: 'DELETE', url: item, headers: { cookie: client.cookie,
      origin: ORIGIN, 'x-csrf-token': client.csrf, 'known-command-id': randomUUID() } });
    assert.equal(missing.statusCode, 428);
    const oversized = await value.app.inject({ method: 'POST',
      url: `/api/v1/collections/${COLLECTION_ID}/relations`, headers: { cookie: client.cookie,
        origin: ORIGIN, 'x-csrf-token': client.csrf, 'known-command-id': randomUUID(),
        'content-type': 'application/json' }, payload: { fromNodeId: NODE_ID, toNodeId: 'other', type: 'related',
        label: 'x'.repeat(129 * 1024), visibility: 'protected', extensions: {} } });
    assert.equal(oversized.statusCode, 413);
  });

  test('GET does not slide session idle expiry; mutations still touch', async () => {
    const value = harness(); apps.push(value.app); const client = await session(value);
    const rewound = new Date('2026-07-25T09:00:00.000Z');
    // BA-world session facts: the metadata row is the product session store.
    assert.equal(value.factory.setMetadataLastSeenAt(client.accountId, rewound), true);
    const list = await value.app.inject({ method: 'GET',
      url: `/api/v1/collections/${COLLECTION_ID}/relations?nodeId=${NODE_ID}&direction=both`,
      headers: { cookie: client.cookie } });
    assert.equal(list.statusCode, 200);
    assert.equal(metadataLastSeenAt(value, client.accountId).getTime(), rewound.getTime());
    const item = await value.app.inject({ method: 'GET',
      url: `/api/v1/collections/${COLLECTION_ID}/relations/relation-http-1`,
      headers: { cookie: client.cookie } });
    assert.equal(item.statusCode, 200);
    assert.equal(metadataLastSeenAt(value, client.accountId).getTime(), rewound.getTime());
    const mutation = await value.app.inject({ method: 'POST',
      url: `/api/v1/collections/${COLLECTION_ID}/relations`,
      headers: { cookie: client.cookie, origin: ORIGIN } });
    assert.equal(mutation.statusCode, 403);
    assert.equal(metadataLastSeenAt(value, client.accountId).getTime(), NOW.getTime());
  });

  test('relation GET past idle TTL is unusable; a heartbeat GET /me would have been required to slide', async () => {
    const value = harness(); apps.push(value.app); const client = await session(value);
    const row = [...value.factory.state.metadata.values()].find((entry) => entry.accountId === client.accountId);
    assert.ok(row);
    value.identityState.now = new Date(row.idleExpiresAt.getTime() + 1);
    const list = await value.app.inject({ method: 'GET',
      url: `/api/v1/collections/${COLLECTION_ID}/relations?nodeId=${NODE_ID}&direction=both`,
      headers: { cookie: client.cookie } });
    assert.equal(list.statusCode, 401);
    assert.equal(list.json().error.code, 'authentication_required');
  });
});

function metadataLastSeenAt(value: ReturnType<typeof harness>, accountId: string): Date {
  const row = [...value.factory.state.metadata.values()].find((entry) => entry.accountId === accountId);
  assert.ok(row, 'expected a live metadata row for the account');
  return row.lastSeenAt;
}
