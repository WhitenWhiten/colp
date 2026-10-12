/**
 * SYNC-Q-014: the four COLP-sync favicon helper operations never mint a
 * route-local fixed-window limiter. An absent shared limiter must be tolerated
 * (the helper runs unlimited, like the sync routes whose admission policy is
 * absent) and flag-off must still conceal with 404 — never crash or 429.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSyncFaviconHelperRoutes } from '../../../src/transport/colp-sync/sync-favicon-helper-routes.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const POLICY_PATH = '/colp/v0.1/sync/favicon-policy';
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(enabled: boolean): FastifyInstance {
  const app = Fastify();
  apps.push(app);
  registerSyncFaviconHelperRoutes(app, {
    enabled,
    productOrigin: 'https://known.example',
    timeoutMs: 2_000,
    // Deliberately no rateLimiter: COLP-sync registration must tolerate the
    // absent shared limiter instead of minting a route-local one.
  });
  return app;
}

describe('SYNC-Q-014 favicon helper shared-limiter tolerance', () => {
  test('flag off without a shared limiter still conceals every helper operation with 404', async () => {
    const response = await build(false).inject({
      method: 'GET', url: POLICY_PATH, headers: { origin: ORIGIN },
    });
    assert.equal(response.statusCode, 404);
  });

  test('flag on without a shared limiter passes admission and reaches the helper dependency check', async () => {
    const response = await build(true).inject({
      method: 'GET', url: POLICY_PATH, headers: { origin: ORIGIN },
    });
    // No limiter => no local rate limiting; the request reaches the real
    // handler, which fails closed on the missing injected dependencies (503)
    // rather than the 429 a route-local limiter would produce.
    assert.notEqual(response.statusCode, 429);
    assert.equal(response.statusCode, 503);
  });
});
