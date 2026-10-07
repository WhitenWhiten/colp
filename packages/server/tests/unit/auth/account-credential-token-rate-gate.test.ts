import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { test } from 'vitest';
import { registerAccountCredentialTokenRoutes } from '../../../src/transport/auth/account-credential-token-routes.js';
import { AccountCredentialCommandError } from '../../../src/modules/auth/index.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';

/**
 * AC-F011 route-level regression: a format-invalid credential must be refused
 * BEFORE any credential-keyed rate bucket is claimed. The previous behavior
 * consumed consumeCredentialRate for any string and only later failed the
 * exchange; that difference is not observable through the response alone
 * (both reject the credential), so this test spies on the limiter keys.
 */
test('AC-F011 malformed credentials never claim a credential rate bucket', async () => {
  const credentialKeys: string[] = [];
  const clientKeys: string[] = [];
  const credentialLimiter = {
    consume: (key: string) => {
      credentialKeys.push(key);
      return { allowed: true as const, retryAfterSeconds: 0 };
    },
  };
  const clientLimiter = {
    consume: (key: string) => {
      clientKeys.push(key);
      return { allowed: true as const, retryAfterSeconds: 0 };
    },
  };
  const app = Fastify();
  registerAccountCredentialTokenRoutes(app, {
    enabled: true,
    unitOfWork: { execute: async () => { throw new Error('must not run for malformed credentials'); } } as never,
    privateJwk: {} as never,
    issuer: 'https://issuer.example.test',
    audienceConfig: {} as never,
    supportedScopes: [],
    credentialRateLimiter: credentialLimiter as never,
    clientRateLimiter: clientLimiter as never,
    ttlSeconds: 300,
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/key-token',
    headers: { 'content-type': 'application/json' },
    payload: { grant_type: 'client_credentials', credential: 'not-a-credential-value', audience: 'product', scope: 'product:read' },
  });
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(response.json().code, 'resource_not_found', response.body);
  // Every attempt consumes the client budget before credential authentication.
  assert.equal(clientKeys.length, 1, 'malformed credentials must consume the client budget');
  assert.equal(credentialKeys.filter((key) => key.startsWith('automation-token-credential:')).length, 0,
    `no credential bucket may be claimed for a malformed credential: ${credentialKeys.join(', ')}`);
  await app.close();
});

test('invalid child keys exhaust the client budget before further database authentication', async () => {
  let lookups = 0;
  const app = Fastify();
  registerAccountCredentialTokenRoutes(app, {
    enabled: true,
    unitOfWork: { execute: async () => {
      lookups += 1;
      throw new AccountCredentialCommandError('invalid_request', 'Invalid child key.');
    } } as never,
    privateJwk: {} as never,
    issuer: 'https://issuer.example.test',
    audienceConfig: {} as never,
    supportedScopes: [],
    credentialRateLimiter: { consume: () => { throw new Error('unauthenticated credential bucket'); } } as never,
    clientRateLimiter: createFixedWindowRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
    ttlSeconds: 300,
  });
  try {
    const request = {
      method: 'POST' as const,
      url: '/api/v1/auth/key-token',
      payload: {
        grant_type: 'client_credentials',
        credential: 'kn_c_aaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        audience: 'product', scope: 'product:read',
      },
    };
    assert.equal((await app.inject(request)).statusCode, 404);
    assert.equal((await app.inject(request)).statusCode, 404);
    const limited = await app.inject(request);
    assert.equal(limited.statusCode, 429, limited.body);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal(lookups, 2, 'exhausted client must not reach credential authentication');
  } finally {
    await app.close();
  }
});

test('client limiter failure refuses token exchange before any database access', async () => {
  let lookups = 0;
  const app = Fastify();
  registerAccountCredentialTokenRoutes(app, {
    enabled: true,
    unitOfWork: { execute: async () => { lookups += 1; } } as never,
    privateJwk: {} as never,
    issuer: 'https://issuer.example.test',
    audienceConfig: {} as never,
    supportedScopes: [],
    credentialRateLimiter: null,
    clientRateLimiter: {
      readiness: () => false,
      consume: async () => ({ kind: 'failed' }),
    } as never,
    ttlSeconds: 300,
  });
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/key-token',
      payload: { credential: 'invalid' },
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(lookups, 0);
  } finally {
    await app.close();
  }
});
