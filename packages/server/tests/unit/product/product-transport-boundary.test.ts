import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';

const openApps: FastifyInstance[] = [];

function createApp(): FastifyInstance {
  const app = buildApiApp({
    config: loadConfig({ DATABASE_URL: 'postgres://localhost/known', LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' }),
  });
  openApps.push(app);
  return app;
}

function registerAdmissionProbe(app: FastifyInstance): void {
  app.post('/_phase0/admission', {
    config: {
      productTransport: {
        allowedQuery: ['view'],
        acceptedMediaTypes: ['application/json', 'application/merge-patch+json'],
        bodyLimitBytes: 64,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request) => ({
    accepted: true,
    rawHeaderPairs: request.rawHeaderPairs,
  }));
}

function assertProductError(
  response: { statusCode: number; headers: Record<string, string | string[] | undefined>; json(): unknown },
  expectedStatus: number,
  expectedCode: string,
): Record<string, unknown> {
  assert.equal(response.statusCode, expectedStatus);
  assert.match(String(response.headers['content-type']), /^application\/json(?:; charset=utf-8)?$/);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(typeof response.headers['x-request-id'], 'string');

  const envelope = response.json() as { error: Record<string, unknown> };
  assert.deepEqual(Object.keys(envelope), ['error']);
  assert.deepEqual(Object.keys(envelope.error).sort(), [
    'code',
    'currentEtag',
    'fieldErrors',
    'message',
    'precondition',
    'recovery',
    'requestId',
    'retryAfterSeconds',
    'sameRequestRetrySafe',
  ]);
  assert.equal(envelope.error.code, expectedCode);
  assert.equal(typeof envelope.error.message, 'string');
  assert.ok((envelope.error.message as string).length > 0);
  assert.equal(envelope.error.requestId, response.headers['x-request-id']);
  assert.equal(typeof envelope.error.recovery, 'string');
  assert.equal(typeof envelope.error.sameRequestRetrySafe, 'boolean');
  assert.equal(envelope.error.precondition, null);
  assert.equal(envelope.error.currentEtag, null);
  assert.equal(envelope.error.retryAfterSeconds, null);
  assert.deepEqual(envelope.error.fieldErrors, []);
  return envelope.error;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe('Product transport header admission', () => {
  for (const header of ['Origin', 'X-CSRF-Token', 'Known-Command-Id', 'If-Match']) {
    test(`rejects repeated ${header} lines instead of selecting one value`, async () => {
      const app = createApp();
      registerAdmissionProbe(app);

      const response = await app.inject({
        method: 'POST',
        url: '/_phase0/admission',
        headers: {
          [header]: ['first-value', 'second-value'],
          'content-type': 'application/json',
        },
        payload: '{}',
      });

      const error = assertProductError(response, 400, 'invalid_request');
      assert.equal(error.recovery, 'user_action');
      assert.equal(error.sameRequestRetrySafe, false);
    });
  }

  test('preserves accepted raw header lines for transport admission', async () => {
    const app = createApp();
    registerAdmissionProbe(app);

    const response = await app.inject({
      method: 'POST',
      url: '/_phase0/admission',
      headers: {
        origin: 'https://known.example',
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { rawHeaderPairs: ReadonlyArray<readonly [string, string]> };
    const origin = body.rawHeaderPairs.find(([name]) => name.toLowerCase() === 'origin');
    assert.deepEqual(origin, ['origin', 'https://known.example']);
  });
});

describe('Product transport media type, body, and query admission', () => {
  test('rejects a media type not allowed by the operation', async () => {
    const app = createApp();
    registerAdmissionProbe(app);
    const response = await app.inject({
      method: 'POST',
      url: '/_phase0/admission',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });

    assertProductError(response, 415, 'unsupported_media_type');
  });

  test('rejects malformed application/json through the registered parser', async () => {
    const app = createApp();
    registerAdmissionProbe(app);
    const response = await app.inject({
      method: 'POST',
      url: '/_phase0/admission',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });

    assertProductError(response, 400, 'invalid_json');
  });

  test('rejects malformed merge-patch JSON through the registered parser', async () => {
    const app = createApp();
    registerAdmissionProbe(app);
    const response = await app.inject({
      method: 'POST',
      url: '/_phase0/admission',
      headers: { 'content-type': 'application/merge-patch+json' },
      payload: '{',
    });

    assertProductError(response, 400, 'invalid_json');
  });

  test('rejects malformed percent-encoding in the raw query string', async () => {
    const app = createApp();
    registerAdmissionProbe(app);
    const response = await app.inject({
      method: 'POST',
      url: '/_phase0/admission?view=%',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    assertProductError(response, 400, 'invalid_query');
  });

  test('enforces the operation body byte limit before handler execution', async () => {
    const app = createApp();
    registerAdmissionProbe(app);
    const response = await app.inject({
      method: 'POST',
      url: '/_phase0/admission',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'x'.repeat(80) }),
    });

    assertProductError(response, 413, 'payload_too_large');
  });

  test('rejects unknown query keys without silently dropping them', async () => {
    const app = createApp();
    registerAdmissionProbe(app);
    const response = await app.inject({
      method: 'POST',
      url: '/_phase0/admission?unknown=true',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    assertProductError(response, 400, 'invalid_query');
  });

  test('rejects duplicate query keys even when the key itself is allowed', async () => {
    const app = createApp();
    registerAdmissionProbe(app);
    const response = await app.inject({
      method: 'POST',
      url: '/_phase0/admission?view=one&view=two',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    assertProductError(response, 400, 'invalid_request');
  });
});

describe('Product transport response mapping', () => {
  test('maps each route cache policy to its wire-level Cache-Control value', async () => {
    const app = createApp();
    const policies = [
      ['private-no-store', 'private, no-store'],
      ['no-store', 'no-store'],
      ['private-revalidate', 'private, no-cache, must-revalidate'],
      ['public-revalidate', 'public, no-cache, must-revalidate'],
    ] as const;
    for (const [policy] of policies) {
      app.get(`/_phase0/cache/${policy}`, {
        config: { productTransport: { cacheControl: policy } },
      }, async () => ({ ok: true }));
    }

    for (const [policy, expected] of policies) {
      const response = await app.inject({ method: 'GET', url: `/_phase0/cache/${policy}` });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], expected);
      assert.equal(typeof response.headers['x-request-id'], 'string');
    }
  });

  test('maps an unknown Product path to the Product 404 envelope', async () => {
    const app = createApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/not-a-route' });

    const error = assertProductError(response, 404, 'resource_not_found');
    assert.equal(error.recovery, 'none');
  });

  test('maps a known path with an unsupported method to a Product 405 and exact Allow', async () => {
    const app = createApp();
    app.get('/_phase0/read-only', {
      config: { productTransport: { cacheControl: 'private-no-store' } },
    }, async () => ({ ok: true }));

    const response = await app.inject({ method: 'POST', url: '/_phase0/read-only' });

    const error = assertProductError(response, 405, 'method_not_allowed');
    assert.equal(response.headers.allow, 'GET, HEAD');
    assert.equal(error.recovery, 'user_action');
  });

  test('normalizes framework failures into the Product envelope without leaking details', async () => {
    const app = createApp();
    app.get('/_phase0/failure', {
      config: { productTransport: { cacheControl: 'private-no-store' } },
    }, async () => {
      throw new Error('secret database detail');
    });

    const response = await app.inject({ method: 'GET', url: '/_phase0/failure' });
    const error = assertProductError(response, 500, 'internal_error');
    assert.doesNotMatch(JSON.stringify(error), /secret database detail|stack/i);
  });

  test('applies route Cache-Control and keeps dynamic request IDs out of stable replay data', async () => {
    const app = createApp();
    const stableResult = {
      status: 201,
      body: { receipt: { commandId: '5de3947e-6271-4fdf-a946-d22e58a99c2a' } },
      headers: { etag: '"stable-revision"', location: '/stable/resource' },
    } as const;
    app.get('/_phase0/replay', {
      config: { productTransport: { cacheControl: 'private-no-store' } },
    }, async (_request, reply) => {
      reply.code(stableResult.status);
      for (const [name, value] of Object.entries(stableResult.headers)) reply.header(name, value);
      return stableResult.body;
    });

    const first = await app.inject({ method: 'GET', url: '/_phase0/replay' });
    const second = await app.inject({ method: 'GET', url: '/_phase0/replay' });

    assert.equal(first.statusCode, stableResult.status);
    assert.equal(first.headers['cache-control'], 'private, no-store');
    assert.equal(first.headers.etag, stableResult.headers.etag);
    assert.equal(first.headers.location, stableResult.headers.location);
    assert.deepEqual(first.json(), stableResult.body);
    assert.deepEqual(second.json(), stableResult.body);
    assert.notEqual(first.headers['x-request-id'], second.headers['x-request-id']);
    assert.equal('requestId' in (first.json() as Record<string, unknown>), false);
  });
});
