import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { test, vi } from 'vitest';
import { registerAccountCredentialGrantRoutes, type AccountCredentialGrantRoutesDependencies } from '../../../src/transport/product/account-credential-grant-routes.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';

vi.mock('../../../src/transport/auth/account-credential-parent-key-routes.js', () => ({
  requireParentKey: async () => ({ managerAccountId: 'owner', subjectId: 'subject' }),
}));

test('all grant mutations share an account budget, regardless of command id, before any command writes', async () => {
  const app = Fastify();
  let writes = 0;
  const deps = {
    enabled: true, cursors: {}, grantCursors: {}, timeoutMs: 1000,
    rateLimiter: createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    unitOfWork: { execute: async () => { writes++; throw new Error('unexpected write'); } },
  } as unknown as AccountCredentialGrantRoutesDependencies;
  registerAccountCredentialGrantRoutes(app, deps);
  try {
    // The first invalid request consumes the sole allowance; rotating the
    // command and mutation endpoint must not create a fresh quota bucket.
    await app.inject({ method: 'POST', url: '/api/v1/me/credential-grants', payload: {},
      headers: { 'known-command-id': randomUUID() } });
    for (const url of ['/api/v1/me/credential-grants',
      '/api/v1/me/credential-grants/grant/revoke',
      '/api/v1/me/credential-grants/grant/authorize-plan']) {
      const response = await app.inject({ method: 'POST', url, payload: {},
        headers: { 'known-command-id': randomUUID() } });
      assert.equal(response.statusCode, 429, url);
    }
    assert.equal(writes, 0);
  } finally { await app.close(); }
});
