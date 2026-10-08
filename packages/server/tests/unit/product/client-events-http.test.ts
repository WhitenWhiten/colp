import assert from 'node:assert/strict';
import { afterAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { parseClientEventBatch } from '../../../src/transport/product/client-event-routes.js';

/* R15-13: anonymous web client errors and Web Vitals. */

const ORIGIN = 'https://known.example';
const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: ORIGIN,
  PUBLICATION_ORIGIN: ORIGIN,
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});
const app = buildApiApp({
  config,
  publicObjectRateLimiter: createFixedWindowRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
});

afterAll(async () => {
  await app.close();
});

const ERROR_EVENT = { kind: 'error', source: 'render_error', route: '/c/:slug', message: 'boom', stack: 'at X' };
const VITAL_EVENT = { kind: 'vital', name: 'CLS', value: 0.04, rating: 'good', route: '/explore' };

function post(payload: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/client-events',
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(payload),
  });
}

test('parses a mixed batch and rejects anything outside the closed schema', () => {
  assert.deepEqual(parseClientEventBatch({ release: 'b-1', events: [ERROR_EVENT, VITAL_EVENT] }), {
    release: 'b-1',
    events: [ERROR_EVENT, VITAL_EVENT],
  });
  const invalid: unknown[] = [
    null,
    { release: 'b-1', events: [] },
    { release: 'b 1', events: [VITAL_EVENT] },
    { release: 'b-1', events: [VITAL_EVENT], extra: true },
    { release: 'b-1', events: Array.from({ length: 21 }, () => VITAL_EVENT) },
    { release: 'b-1', events: [{ ...VITAL_EVENT, route: 'https://known.example/c/secret' }] },
    { release: 'b-1', events: [{ ...VITAL_EVENT, name: 'FID' }] },
    { release: 'b-1', events: [{ ...VITAL_EVENT, value: -1 }] },
    { release: 'b-1', events: [{ ...ERROR_EVENT, message: 'x'.repeat(501) }] },
    { release: 'b-1', events: [{ ...ERROR_EVENT, email: 'a@b.c' }] },
    { release: 'b-1', events: [{ kind: 'metric', route: '/' }] },
  ];
  for (const body of invalid) {
    assert.throws(() => parseClientEventBatch(body), /invalid|closed set|properties|items|template/u, JSON.stringify(body));
  }
});

test('accepts a same-origin batch with 204 and an empty body', async () => {
  const response = await post({ release: 'b-1', events: [ERROR_EVENT, VITAL_EVENT] });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
});

test('rejects an invalid batch with 400', async () => {
  const response = await post({ release: 'b-1', events: [{ ...VITAL_EVENT, route: 'https://x' }] });
  assert.equal(response.statusCode, 400);
});

test('rejects a foreign or missing Origin with 403', async () => {
  assert.equal((await post({ release: 'b-1', events: [VITAL_EVENT] }, { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await post({ release: 'b-1', events: [VITAL_EVENT] }, {})).statusCode, 403);
});

test('rate limits per client with 429 and Retry-After', async () => {
  let last = await post({ release: 'b-1', events: [VITAL_EVENT] });
  for (let i = 0; i < 5 && last.statusCode !== 429; i += 1) {
    last = await post({ release: 'b-1', events: [VITAL_EVENT] });
  }
  assert.equal(last.statusCode, 429);
  assert.ok(Number(last.headers['retry-after']) > 0);
});
