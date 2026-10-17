/**
 * LP-04: GET /api/v1/link-preview/:previewId. Registered only while the
 * feature is on. Anonymous readers get bytes only while a public or unlisted
 * bookmark still exposes the object, with a jittered 7–15 day cache. A
 * signed-in owner or member also gets their private collection's objects,
 * cached only in their browser. Illegal ids, hidden objects, missing objects and non-images
 * share one 404.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import type { LinkPreviewCommandUnitOfWork } from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import type { LinkPreviewPublicAccess } from '../../../src/transport/product/link-preview-routes.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createMemoryObjectStore, makePng, type MemoryObjectStore } from '../../support/link-preview-fixtures.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';
import { loadConfig } from '../../support/test-config.js';

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NOW = new Date('2026-09-26T08:00:00.000Z');
const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/link_preview_route_test',
  PRODUCT_ORIGIN: 'https://app.example.test',
  ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  KNOWN_FEATURE_LINK_PREVIEW: 'true',
});
const noCommands: LinkPreviewCommandUnitOfWork = {
  execute: async () => { throw new Error('not used'); },
};

function access(input: { servable: boolean; readers?: readonly string[] }): LinkPreviewPublicAccess {
  return {
    isServable: async () => input.servable,
    isReadableBySubject: async (_objectId, subjectId) => input.readers?.includes(subjectId) === true,
  };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

function app(store: MemoryObjectStore, publicAccess: LinkPreviewPublicAccess, extra = {}) {
  const built = buildApiApp({ config, linkPreview: { store, publicAccess, commands: noCommands }, ...extra });
  apps.push(built);
  return built;
}

function previewCacheAge(value: unknown, visibility: 'public' | 'private'): number {
  const match = new RegExp(`^${visibility}, max-age=(\\d+), must-revalidate$`, 'u').exec(String(value));
  assert.ok(match, `unexpected cache policy: ${String(value)}`);
  const age = Number(match[1]);
  assert.ok(age >= 604_800 && age <= 1_296_000, `cache age out of 7–15 day range: ${age}`);
  return age;
}

describe('GET /api/v1/link-preview/:previewId', () => {
  test('serves stored image bytes with a 7–15 day cache, ETag and nosniff', async () => {
    const store = createMemoryObjectStore();
    const png = makePng(400, 210);
    await store.put(ID, png, 'text/html'); // declared type is ignored
    const response = await app(store, access({ servable: true })).inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['content-type'], 'image/png');
    previewCacheAge(response.headers['cache-control'], 'public');
    assert.match(String(response.headers.etag), /^"[a-f0-9]{64}"$/u);
    assert.equal(response.headers.vary, 'Cookie');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual(response.rawPayload, png);
  });

  test('spreads identical images across cache lifetimes and keeps each lifetime stable across servers', async () => {
    const store = createMemoryObjectStore();
    const png = makePng(400, 210);
    const server = app(store, access({ servable: true }));
    const replica = app(store, access({ servable: true }));
    const ages: number[] = [];
    for (let index = 0; index < 32; index += 1) {
      const id = `${index.toString(16).padStart(8, '0')}-4e5f-4a6b-8c7d-9e0f1a2b3c4d`;
      await store.put(id, png, 'image/png');
      const url = `/api/v1/link-preview/${id}`;
      const response = await server.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200);
      ages.push(previewCacheAge(response.headers['cache-control'], 'public'));
      const revalidated = await replica.inject({ method: 'GET', url, headers: { 'if-none-match': String(response.headers.etag) } });
      assert.equal(revalidated.statusCode, 304);
      assert.equal(revalidated.headers['cache-control'], response.headers['cache-control']);
    }
    assert.ok(new Set(ages).size > 24, 'different image IDs should not share one expiration');
    assert.ok(Math.max(...ages) - Math.min(...ages) > 6 * 86_400, 'lifetimes should span most of the jitter window');
  });

  test('revalidates strong, weak, list and wildcard validators without sending image bytes', async () => {
    const store = createMemoryObjectStore();
    await store.put(ID, makePng(400, 210), 'image/png');
    const server = app(store, access({ servable: true }));
    const url = `/api/v1/link-preview/${ID}`;
    const first = await server.inject({ method: 'GET', url });
    const etag = String(first.headers.etag);
    for (const validator of [etag, `W/${etag}`, `"other,tag", W/${etag}`, '*']) {
      const response = await server.inject({ method: 'GET', url, headers: { 'if-none-match': validator } });
      assert.equal(response.statusCode, 304, validator);
      assert.equal(response.rawPayload.length, 0);
      assert.equal(response.headers.etag, etag);
      assert.equal(response.headers['cache-control'], first.headers['cache-control']);
      assert.equal(response.headers.vary, 'Cookie');
      assert.equal(response.headers['set-cookie'], undefined);
    }
    for (const validator of ['"outdated"', `${etag}, garbage`, `"broken, ${etag}`, `${etag}, *`]) {
      const response = await server.inject({ method: 'GET', url, headers: { 'if-none-match': validator } });
      assert.equal(response.statusCode, 200, validator);
      assert.deepEqual(response.rawPayload, first.rawPayload);
    }
  });

  test('revalidation checks current public access, object existence and image validity before 304', async () => {
    const store = createMemoryObjectStore();
    await store.put(ID, makePng(400, 210), 'image/png');
    const visibility = { servable: true };
    const server = app(store, access(visibility));
    const url = `/api/v1/link-preview/${ID}`;
    const first = await server.inject({ method: 'GET', url });
    const headers = { 'if-none-match': String(first.headers.etag) };
    visibility.servable = false;
    const revoked = await server.inject({ method: 'GET', url, headers });
    assert.equal(revoked.statusCode, 404);
    assert.equal(revoked.headers.etag, undefined);
    visibility.servable = true;
    await store.delete(ID);
    assert.equal((await server.inject({ method: 'GET', url, headers })).statusCode, 404);
    await store.put(ID, Buffer.from('<html>invalid image</html>'), 'image/png');
    assert.equal((await server.inject({ method: 'GET', url, headers: { 'if-none-match': '*' } })).statusCode, 404);
  });

  test('a changed image version sends the new image even with the old ETag', async () => {
    const store = createMemoryObjectStore();
    const nextId = '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const nextPng = makePng(400, 210, 64);
    await store.put(ID, makePng(400, 210), 'image/png');
    await store.put(nextId, nextPng, 'image/png');
    const server = app(store, access({ servable: true }));
    const first = await server.inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
    const next = await server.inject({
      method: 'GET', url: `/api/v1/link-preview/${nextId}`,
      headers: { 'if-none-match': String(first.headers.etag) },
    });
    assert.equal(next.statusCode, 200);
    assert.notEqual(next.headers.etag, first.headers.etag);
    assert.deepEqual(next.rawPayload, nextPng);
  });

  test('illegal ids, missing objects and non-servable bytes share one short-cached 404', async () => {
    const store = createMemoryObjectStore();
    const ico = Buffer.from('00000100010010100000010020006804000016000000', 'hex');
    await store.put('1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', Buffer.from('<html>hi</html>'), 'image/png');
    await store.put('2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', ico, 'image/x-icon');
    const server = app(store, access({ servable: true }));
    for (const id of [
      'not-a-uuid',
      '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D',
      ID,
      '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      '2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    ]) {
      const response = await server.inject({ method: 'GET', url: `/api/v1/link-preview/${id}` });
      assert.equal(response.statusCode, 404, id);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'resource_not_found');
      assert.equal(response.headers['cache-control'], 'public, max-age=60', id);
    }
  });

  test('a stored image is 404 when no public bookmark still exposes it', async () => {
    const store = createMemoryObjectStore();
    await store.put(ID, makePng(400, 210), 'image/png');
    const response = await app(store, access({ servable: false })).inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
    assert.equal(response.statusCode, 404);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'resource_not_found');
    assert.equal(response.headers['cache-control'], 'public, max-age=60');
    assert.equal(response.headers['content-type']?.includes('image/'), false);
  });

  test('a private image is browser-cached and revalidated only for its current signed-in reader', async () => {
    const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
    const owner = await issueTestSession({ factory, subject: 'lp-owner', displayName: 'Owner', handle: 'lpowner' });
    const outsider = await issueTestSession({ factory, subject: 'lp-outsider', displayName: 'Outsider', handle: 'lpoutside' });
    const store = createMemoryObjectStore();
    const png = makePng(400, 210);
    await store.put(ID, png, 'image/png');
    const visibility = { servable: false, readers: [owner.subjectId] };
    const server = app(store, access(visibility), {
      identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
    });
    const url = `/api/v1/link-preview/${ID}`;

    const read = await server.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
    assert.equal(read.statusCode, 200, read.body);
    const privateAge = previewCacheAge(read.headers['cache-control'], 'private');
    assert.equal(read.headers.vary, 'Cookie');
    assert.deepEqual(read.rawPayload, png);

    visibility.servable = true;
    const publicRead = await server.inject({ method: 'GET', url });
    assert.equal(previewCacheAge(publicRead.headers['cache-control'], 'public'), privateAge);
    visibility.servable = false;

    const etag = String(read.headers.etag);
    const revalidated = await server.inject({ method: 'GET', url, headers: { cookie: owner.cookie, 'if-none-match': etag } });
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.rawPayload.length, 0);
    assert.equal(revalidated.headers['cache-control'], read.headers['cache-control']);
    assert.equal(revalidated.headers.etag, etag);
    assert.equal(revalidated.headers.vary, 'Cookie');
    assert.equal(revalidated.headers['set-cookie'], undefined);

    for (const headers of [{ cookie: outsider.cookie }, { cookie: 'better-auth.session_token=forged' }]) {
      const denied = await server.inject({ method: 'GET', url, headers: { ...headers, 'if-none-match': etag } });
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(denied.headers['cache-control'], 'private, no-store');
      assert.equal(denied.headers.etag, undefined);
    }
    visibility.readers = [];
    const revoked = await server.inject({ method: 'GET', url, headers: { cookie: owner.cookie, 'if-none-match': etag } });
    assert.equal(revoked.statusCode, 404);
    assert.equal(revoked.headers['cache-control'], 'private, no-store');
    assert.equal(revoked.headers.etag, undefined);
    const anonymous = await server.inject({ method: 'GET', url, headers: { 'if-none-match': '*' } });
    assert.equal(anonymous.statusCode, 404);
    assert.equal(anonymous.headers['cache-control'], 'public, max-age=60');
  });

  test('while the feature is off the route is not registered', async () => {
    const built = buildApiApp({ config });
    apps.push(built);
    const response = await built.inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
    assert.equal(response.statusCode, 404);
  });
});
