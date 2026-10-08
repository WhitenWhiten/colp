import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createProductAnnotationCursorSigner,
  type AnnotationMutationUnitOfWork,
  type AnnotationReadUnitOfWork,
  type CollectionsUnitOfWork,
  type ProductAnnotationRow,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';
import { createMemoryProductCollectionMutationUnitOfWork } from '../../support/product-canonical-memory.js';

const NOW = new Date('2026-07-25T04:00:00.000Z');
const ORIGIN = 'https://app.example.test';
const COLLECTION_ID = 'annotation-http-collection';
const NODE_ID = 'annotation-http-node';

function annotationRow(): ProductAnnotationRow {
  return {
    id: 'annotation-http-1', collectionId: COLLECTION_ID, subjectType: 'node', subjectId: NODE_ID,
    creatorPrincipalId: 'unused-until-session-is-issued',
    payload: {
      id: 'annotation-http-1', collectionId: COLLECTION_ID,
      subject: { type: 'node', id: NODE_ID }, type: 'note', format: 'html',
      value: '<strong>untrusted</strong>', visibility: 'protected',
      creator: { id: 'https://app.example.test/profiles/alice', name: 'Alice' },
      revision: 'annotation-http-revision-1', createdAt: '2026-07-25T03:00:00.000Z',
      updatedAt: '2026-07-25T03:00:00.000Z', extensions: {},
    },
    resourceRevision: 'annotation-http-revision-1', updatedAt: new Date('2026-07-25T03:00:00.000Z'),
    deletedAt: null,
  };
}

function createHarness() {
  const identityState = createIdentityMemoryState(NOW);
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(identityState);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const rows = [annotationRow()];
  const annotationReadUnitOfWork: AnnotationReadUnitOfWork = {
    execute: async (work) => work({
      clock: { now: async () => new Date(NOW) },
      cursorSigner: createProductAnnotationCursorSigner({
        current: { id: 'annotation-http-v1', key: 'annotation-http-cursor-key' },
      }),
      accessPolicy: { loadCollectionFacts: async ({ actorSubjectId }) => ({
        collectionId: COLLECTION_ID, ownerSubjectId: actorSubjectId,
        visibility: 'private', policyRevision: 'policy-http-1', membershipRole: 'owner', deleted: false,
      }) },
      reads: {
        loadLiveSubject: async ({ resourceType, resourceId }) => resourceId === NODE_ID || resourceId === COLLECTION_ID
          ? { type: resourceType, id: resourceId, collectionId: COLLECTION_ID, visibility: 'private' }
          : null,
        loadLiveById: async ({ annotationId }) => rows.find((item) => item.id === annotationId) ?? null,
        listLiveBySubject: async ({ resourceType, resourceId, limit }) => rows
          .filter((item) => item.subjectType === resourceType && item.subjectId === resourceId)
          .slice(0, limit + 1),
      },
    }),
  };
  const annotationMutationUnitOfWork: AnnotationMutationUnitOfWork = {
    execute: async () => { throw new Error('mutation should not execute in admission tests'); },
  };
  const collectionsUnitOfWork: CollectionsUnitOfWork = {
    execute: async () => { throw new Error('collection write not used'); },
  };
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/known_test', PRODUCT_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN,
    OIDC_ISSUER: 'https://issuer.example/realms/known', OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token', OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    NODE_ENV: 'test', LOG_LEVEL: 'silent',
  });
  const app = buildApiApp({
    config, collectionMetadataMutationRoutes: 'disabled', identityUnitOfWork, collectionsUnitOfWork,
    productCollectionMutationUnitOfWork: createMemoryProductCollectionMutationUnitOfWork(collectionsUnitOfWork),
    annotationReadUnitOfWork, annotationMutationUnitOfWork,
    browserSessionAuthority: factory.authority,
  });
  return { app, identityUnitOfWork, factory };
}

type App = ReturnType<typeof buildApiApp>;
const apps: App[] = [];
afterEach(async () => { while (apps.length > 0) await apps.pop()!.close(); });

async function session(harness: ReturnType<typeof createHarness>) {
  const client = await issueTestSession({
    factory: harness.factory,
    subject: `annotation-http-${randomUUID()}`,
    displayName: 'Annotation HTTP',
    handle: `anno_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
  });
  return { cookie: client.cookie, csrf: client.csrfToken, accountId: client.accountId, subjectId: client.subjectId };
}

describe('P2B-07 Annotation Product HTTP boundary', () => {
  test('bound annotation reads reject cookie rotation and mutations fail before their UoW is called', async () => {
    const harness = createHarness(); apps.push(harness.app);
    const client = await session(harness);
    const url = `/api/v1/collections/${COLLECTION_ID}/annotations?resourceType=node&resourceId=${NODE_ID}`;
    const read = await harness.app.inject({ method: 'GET', url, headers: { cookie: client.cookie } });
    const bound = String(read.headers['known-annotation-session']);
    assert.ok(bound && bound !== 'undefined');
    const valid = await harness.app.inject({ method: 'GET', url, headers: { cookie: client.cookie, 'known-annotation-session': bound } });
    assert.equal(valid.statusCode, 200);
    const rotated = await session(harness);
    const denied = await harness.app.inject({ method: 'GET', url, headers: { cookie: rotated.cookie, 'known-annotation-session': bound } });
    assert.equal(denied.statusCode, 401);
    const write = await harness.app.inject({ method: 'POST', url, headers: { cookie: client.cookie, origin: ORIGIN,
      'x-csrf-token': client.csrf, 'known-command-id': randomUUID(), 'known-annotation-session': 'wrong-session' },
      payload: { type: 'note', format: 'plain', value: 'private', visibility: 'private' } });
    assert.equal(write.statusCode, 401);
  });
  test('requires Session and returns list/item with private no-store and strong ETag', async () => {
    const harness = createHarness(); apps.push(harness.app);
    const anonymous = await harness.app.inject({ method: 'GET', url: `/api/v1/collections/${COLLECTION_ID}/annotations?resourceType=node&resourceId=${NODE_ID}` });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().error.code, 'authentication_required');
    const client = await session(harness);
    const list = await harness.app.inject({ method: 'GET', url: `/api/v1/collections/${COLLECTION_ID}/annotations?resourceType=node&resourceId=${NODE_ID}&limit=20`, headers: { cookie: client.cookie } });
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers['cache-control'], 'private, no-store');
    assert.deepEqual((list.json() as { annotations: Array<{ id: string }> }).annotations.map((item) => item.id), ['annotation-http-1']);
    const item = await harness.app.inject({ method: 'GET', url: `/api/v1/collections/${COLLECTION_ID}/annotations/annotation-http-1`, headers: { cookie: client.cookie } });
    assert.equal(item.statusCode, 200);
    assert.equal(item.headers.etag, '"annotation-http-revision-1"');
    assert.equal(item.json().value, '<strong>untrusted</strong>');
  });

  test('rejects unknown/empty/repeated/non-canonical subject paging query', async () => {
    const harness = createHarness(); apps.push(harness.app); const client = await session(harness);
    for (const query of [
      'resourceType=node&resourceId=', 'resourceType=bookmark&resourceId=x',
      'resourceType=node&resourceType=collection&resourceId=x',
      'resourceType=node&resourceId=x&limit=01', 'resourceType=node&resourceId=x&unknown=1',
      'resourceType=node&resourceId=x&limit=1&cursor=opaque',
      'resourceType=node&resourceId=%20x', `resourceType=node&resourceId=x&cursor=${'x'.repeat(2049)}`,
    ]) {
      const response = await harness.app.inject({ method: 'GET', url: `/api/v1/collections/${COLLECTION_ID}/annotations?${query}`, headers: { cookie: client.cookie } });
      assert.equal(response.statusCode, 400, query);
      assert.ok(['invalid_query', 'invalid_cursor'].includes(response.json().error.code), query);
    }
  });

  test('enforces mutation Origin/CSRF/media/body/precondition/command admission', async () => {
    const harness = createHarness(); apps.push(harness.app); const client = await session(harness);
    const base = `/api/v1/collections/${COLLECTION_ID}/annotations/annotation-http-1`;
    const missingCsrf = await harness.app.inject({ method: 'PATCH', url: base, headers: {
      cookie: client.cookie, origin: ORIGIN, 'known-command-id': randomUUID(),
      'if-match': '"annotation-http-revision-1"', 'content-type': 'application/merge-patch+json',
    }, payload: JSON.stringify({ value: 'changed' }) });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(missingCsrf.json().error.code, 'csrf_failed');
    const weak = await harness.app.inject({ method: 'DELETE', url: base, headers: {
      cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf,
      'known-command-id': randomUUID(), 'if-match': 'W/"annotation-http-revision-1"',
    } });
    assert.equal(weak.statusCode, 400);
    for (const invalidIfMatch of ['*', '"one", "two"']) {
      const invalid = await harness.app.inject({ method: 'DELETE', url: base, headers: {
        cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf,
        'known-command-id': randomUUID(), 'if-match': invalidIfMatch,
      } });
      assert.equal(invalid.statusCode, 400, invalidIfMatch);
      assert.equal(invalid.json().error.code, 'invalid_request');
    }
    const missing = await harness.app.inject({ method: 'DELETE', url: base, headers: {
      cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf, 'known-command-id': randomUUID(),
    } });
    assert.equal(missing.statusCode, 428);
    const oversized = await harness.app.inject({ method: 'POST',
      url: `/api/v1/collections/${COLLECTION_ID}/annotations?resourceType=node&resourceId=${NODE_ID}`,
      headers: { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf,
        'known-command-id': randomUUID(), 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'note', format: 'plain', value: 'x'.repeat(129 * 1024),
        visibility: 'private', extensions: {} }),
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().error.code, 'payload_too_large');
  });

  test('raw duplicate command/precondition/origin headers fail before Fastify normalization', async () => {
    const harness = createHarness(); apps.push(harness.app); const client = await session(harness);
    const origin = await harness.app.listen({ host: '127.0.0.1', port: 0 });
    for (const duplicate of ['If-Match', 'Known-Command-Id', 'Origin']) {
      const response = await rawDelete(origin, client.cookie, client.csrf, duplicate);
      assert.equal(response.statusCode, 400, duplicate);
      assert.equal(JSON.parse(response.body).error.code, 'invalid_request', duplicate);
    }
  });
});

async function rawDelete(origin: string, cookie: string, csrf: string, duplicate: string) {
  const headers: Record<string, string | string[]> = {
    Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf,
    'Known-Command-Id': randomUUID(), 'If-Match': '"annotation-http-revision-1"',
  };
  headers[duplicate] = duplicate === 'Known-Command-Id'
    ? [randomUUID(), randomUUID()]
    : duplicate === 'Origin' ? [ORIGIN, ORIGIN] : ['"one"', '"two"'];
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const request = httpRequest(`${origin}/api/v1/collections/${COLLECTION_ID}/annotations/annotation-http-1`, {
      method: 'DELETE', headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.end();
  });
}
