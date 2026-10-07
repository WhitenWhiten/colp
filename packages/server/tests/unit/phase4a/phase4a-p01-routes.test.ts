/**
 * P4A-P01 production mount skeleton: closed-state HTTP contract.
 *
 * The routes under test are registered by the REAL production app composition
 * (buildApiApp) through the REAL generated client (createProductAttachmentClient
 * from generated/openapi/product-v1.client.ts). No test route replaces the
 * production mount and no hand-written DTO replaces the generated client
 * (plan §6 P4A-P01 anti-false-positive). Until P03/P04/P06/P07/P08 land, every
 * Attachment operation must return the explicit closed state
 * `503 attachments_not_implemented` with the pinned Attachment envelope,
 * private no-store headers, and zero grant/URL/secret leakage — never a fake
 * success. Framework-level transport rejections (415/413/400/404/405) on
 * Attachment paths use the same envelope through the production error and
 * not-found handlers.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { alwaysReady } from '../../../src/infrastructure/health.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createProductAttachmentClient } from '../../../generated/openapi/product-v1.client.js';

const ORIGIN = 'https://app.known.example';

function buildApp(): FastifyInstance {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PRODUCT_ORIGIN: ORIGIN,
    LOG_LEVEL: 'silent',
  });
  return buildApiApp({ config, readiness: alwaysReady });
}

const openApps: FastifyInstance[] = [];
afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()!.close();
});

const DIGEST = 'a'.repeat(64);
const ISSUE_BODY = {
  collectionId: 'collection-1',
  declaredSize: 1024,
  declaredSha256: DIGEST,
  mediaHint: 'image/png',
  expectedPolicyRevision: null,
};
const COMPLETE_BODY = {
  binding: { intentId: 'intent-1', generationId: 'generation-1', blobId: 'blob-1' },
  declared: { size: 1024, sha256: DIGEST, mediaType: 'image/png', etag: '"etag-1"' },
};
const REPLACEMENT_BODY = { declaredSize: 2048, mediaHint: null };
const COMMAND_ID = '018f0e3d-1111-4111-8111-111111111111';

interface ClosedProblem {
  error: {
    code: string;
    message: string;
    requestId: string;
    recovery: string;
    sameRequestRetrySafe: boolean;
    precondition: unknown;
    currentEtag: unknown;
    retryAfterSeconds: unknown;
    fieldErrors: unknown[];
  };
}

function assertClosedState(body: ClosedProblem, raw: string): void {
  assert.equal(body.error.code, 'attachments_not_implemented');
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
  assert.ok(body.error.requestId.length > 0);
  assert.equal(body.error.recovery, 'none');
  assert.equal(body.error.sameRequestRetrySafe, false);
  assert.equal(body.error.precondition, null);
  assert.equal(body.error.currentEtag, null);
  assert.equal(body.error.retryAfterSeconds, null);
  assert.deepEqual(body.error.fieldErrors, []);
  // Zero secret/key/URL leakage in the closed-state body (anti-false-positive:
  // assert on the serialized bytes, not just the parsed shape).
  assert.doesNotMatch(raw, /grant|presigned|downloadUrl|credential|"url"|"key"|"token"/i);
}

const ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
  { method: 'POST', url: '/api/v1/attachments/issue', payload: ISSUE_BODY },
  { method: 'POST', url: '/api/v1/attachments/complete', payload: COMPLETE_BODY },
  { method: 'GET', url: '/api/v1/attachments/blob-1' },
  { method: 'POST', url: '/api/v1/attachments/blob-1/finalize' },
  { method: 'POST', url: '/api/v1/attachments/blob-1/replacement', payload: REPLACEMENT_BODY },
  { method: 'POST', url: '/api/v1/attachments/blob-1/retire' },
  { method: 'POST', url: '/api/v1/attachments/blob-1/download' },
];

describe('P4A-P01 production mount skeleton', () => {
  test('every Attachment operation returns the explicit closed state, never a fake success', async () => {
    const app = buildApp();
    openApps.push(app);
    for (const route of ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        ...(route.payload === undefined
          ? {}
          : { payload: JSON.stringify(route.payload), headers: { 'content-type': 'application/json' } }),
      });
      assert.equal(response.statusCode, 503, `${route.method} ${route.url} must be closed`);
      assert.equal(response.headers['cache-control'], 'private, no-store', route.url);
      assert.ok(response.headers['x-request-id'], route.url);
      assert.equal(response.headers['retry-after'], undefined,
        `${route.url} closed state must not fabricate a Retry-After quota fact`);
      assert.match(String(response.headers['content-type']), /^application\/json/);
      const raw = response.body;
      const body = response.json() as ClosedProblem;
      assertClosedState(body, raw);
    }
  });

  test('the closed state is identical for anonymous requests (no auth leak before shutdown)', async () => {
    const app = buildApp();
    openApps.push(app);
    const anonymous = await app.inject({
      method: 'POST', url: '/api/v1/attachments/issue',
      payload: JSON.stringify(ISSUE_BODY), headers: { 'content-type': 'application/json' },
    });
    assert.equal(anonymous.statusCode, 503);
    assertClosedState(anonymous.json() as ClosedProblem, anonymous.body);
  });

  test('transport rejections on Attachment paths use the same Attachment envelope', async () => {
    const app = buildApp();
    openApps.push(app);

    const unsupported = await app.inject({
      method: 'POST', url: '/api/v1/attachments/issue',
      payload: 'not json', headers: { 'content-type': 'text/plain' },
    });
    assert.equal(unsupported.statusCode, 415);
    assert.equal((unsupported.json() as ClosedProblem).error.code, 'unsupported_media_type');

    const oversized = await app.inject({
      method: 'POST', url: '/api/v1/attachments/issue',
      payload: JSON.stringify({ ...ISSUE_BODY, padding: 'x'.repeat(20_000) }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal((oversized.json() as ClosedProblem).error.code, 'payload_too_large');

    const badQuery = await app.inject({ method: 'GET', url: '/api/v1/attachments/blob-1?x=1' });
    assert.equal(badQuery.statusCode, 400);
    assert.equal((badQuery.json() as ClosedProblem).error.code, 'invalid_request');

    const concealed = await app.inject({ method: 'GET', url: '/api/v1/attachments/blob-1/unknown-suffix' });
    assert.equal(concealed.statusCode, 404);
    assert.equal((concealed.json() as ClosedProblem).error.code, 'resource_not_found');

    const methodNotAllowed = await app.inject({ method: 'DELETE', url: '/api/v1/attachments/blob-1' });
    assert.equal(methodNotAllowed.statusCode, 405);
    assert.equal((methodNotAllowed.json() as ClosedProblem).error.code, 'method_not_allowed');
  });

  test('the generated client drives the production mount and surfaces the closed Problem', async () => {
    const app = buildApp();
    openApps.push(app);
    const fetchShim = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const response = await app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST',
        url: url.pathname + url.search,
        headers,
        ...(init?.body === undefined ? {} : { payload: String(init.body) }),
      });
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        headers: response.headers as unknown as Headers,
        json: async () => response.json(),
      };
    };
    const client = createProductAttachmentClient({
      origin: ORIGIN,
      csrfToken: 'c'.repeat(43),
      originHeader: ORIGIN,
      fetch: fetchShim,
    });

    const closed = async (call: Promise<unknown>): Promise<void> => {
      await assert.rejects(call, (error: unknown) => {
        const failure = error as { status?: number; problem?: ClosedProblem };
        return failure.status === 503
          && failure.problem?.error.code === 'attachments_not_implemented';
      });
    };

    await closed(client.issue(ISSUE_BODY, COMMAND_ID));
    await closed(client.complete(COMPLETE_BODY, COMMAND_ID));
    await closed(client.status('blob-1'));
    await closed(client.finalize('blob-1', COMMAND_ID));
    await closed(client.replace('blob-1', REPLACEMENT_BODY, COMMAND_ID));
    await closed(client.retire('blob-1', COMMAND_ID));
    await closed(client.download('blob-1'));
  });
});
