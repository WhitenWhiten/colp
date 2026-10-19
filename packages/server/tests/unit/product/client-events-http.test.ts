import assert from 'node:assert/strict';
import { afterAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { parseClientEventBatch } from '../../../src/transport/product/client-event-routes.js';

/* R15-13: anonymous web client errors and Web Vitals. The self-hosted server collects no browser
   telemetry (1ba57c0b), so the beacon route stays unmounted; only its closed batch parser remains. */

const ORIGIN = 'https://known.example';
const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: ORIGIN,
  PUBLICATION_ORIGIN: ORIGIN,
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});
const app = buildApiApp({ config });

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

test('does not mount the beacon route, whatever the batch or Origin', async () => {
  for (const [payload, headers] of [
    [{ release: 'b-1', events: [ERROR_EVENT, VITAL_EVENT] }, { origin: ORIGIN }],
    [{ release: 'b-1', events: [{ ...VITAL_EVENT, route: 'https://x' }] }, { origin: ORIGIN }],
    [{ release: 'b-1', events: [VITAL_EVENT] }, { origin: 'https://evil.example' }],
    [{ release: 'b-1', events: [VITAL_EVENT] }, {}],
  ] as const) {
    assert.equal((await post(payload, headers)).statusCode, 404, JSON.stringify({ payload, headers }));
  }
});
