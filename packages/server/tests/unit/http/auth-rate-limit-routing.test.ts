import assert from 'node:assert/strict';
import fastify from 'fastify';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { testEnv } from '../../support/http-security-config-env.js';
import { createMemoryAuthRateLimiter, installHttpSecurity } from '../../../src/transport/http-security.js';

test('encoded static auth routes share the canonical route family and IP budget', async () => {
  const app = fastify();
  const limiter = createMemoryAuthRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  installHttpSecurity(app, { security: loadConfig(testEnv()).httpSecurity, authRateLimiter: limiter });
  let recoveryCalls = 0;
  app.post('/api/v1/auth/recovery/password-reset', async () => { recoveryCalls += 1; return { status: true }; });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/recovery/password-reset' })).statusCode, 200);
    for (const url of ['/api/v1/auth/recovery/password%2dreset', '/api/v1/auth/recovery/%70assword-reset?ignored=1']) {
      assert.equal((await app.inject({ method: 'POST', url })).statusCode, 429);
    }
    assert.equal(recoveryCalls, 1);
  } finally { await app.close(); }
});

test('parameterized auth callbacks share a bucket across encoded paths', async () => {
  const app = fastify();
  installHttpSecurity(app, { security: loadConfig(testEnv()).httpSecurity,
    authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1, windowMs: 60_000 }) });
  app.get('/api/v1/auth/callback/:id', async () => ({ status: true }));
  try {
    assert.equal((await app.inject('/api/v1/auth/callback/provider-a')).statusCode, 200);
    assert.equal((await app.inject('/api/v1/auth/%63allback/provider-b')).statusCode, 429);
  } finally { await app.close(); }
});
