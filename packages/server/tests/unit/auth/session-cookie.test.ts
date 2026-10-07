import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  IdentityError,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  parseSessionCookieField,
  readSessionCookie,
  SESSION_COOKIE_NAME,
} from '../../../src/transport/session-cookie.js';

function requestWithCookie(cookie: string | undefined): FastifyRequest {
  return { headers: cookie === undefined ? {} : { cookie } } as FastifyRequest;
}

/** Identity UoW whose work is never expected (admission must fail before handlers). */
function emptyIdentityUnitOfWork(): IdentityUnitOfWork {
  return {
    execute: async () => {
      throw new Error('identity work not expected in session-cookie tests');
    },
  };
}

/** Identity UoW that fails every session lookup (handlers map it to unauthenticated). */
function unauthenticatedIdentityUnitOfWork(): IdentityUnitOfWork {
  return {
    execute: async () => {
      throw new IdentityError('session_not_found', 'session not found');
    },
  };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
});

function testEnv(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

describe('session cookie field parsing (FIX-L-003)', () => {
  test('absent when the Cookie header is missing or holds no session cookie pair', () => {
    assert.equal(readSessionCookie(requestWithCookie(undefined)), null);
    assert.equal(readSessionCookie(requestWithCookie('other=1')), null);
    assert.deepEqual(parseSessionCookieField(''), { kind: 'absent' });
    assert.deepEqual(parseSessionCookieField('theme=dark; locale=en'), { kind: 'absent' });
  });

  test('exactly one session cookie pair yields the decoded raw token', () => {
    assert.equal(readSessionCookie(requestWithCookie(`${SESSION_COOKIE_NAME}=abc123`)), 'abc123');
    const encoded = encodeURIComponent('token/with%special');
    assert.deepEqual(parseSessionCookieField(`${SESSION_COOKIE_NAME}=${encoded}`),
      { kind: 'present', raw: 'token/with%special' });
    assert.equal(
      readSessionCookie(requestWithCookie(`${SESSION_COOKIE_NAME}=${encoded}`)),
      'token/with%special',
    );
    // A cookie pair may legally carry an empty value.
    assert.deepEqual(parseSessionCookieField(`${SESSION_COOKIE_NAME}=`), { kind: 'present', raw: '' });
  });

  test('normal multi-cookie fields keep working (other names are opaque)', () => {
    for (const field of [
      `theme=dark; ${SESSION_COOKIE_NAME}=abc; locale=en`,
      `${SESSION_COOKIE_NAME}=abc; theme=dark`,
      `theme=dark; ${SESSION_COOKIE_NAME}=abc`,
      `; ${SESSION_COOKIE_NAME}=abc ;`,
    ]) {
      assert.deepEqual(parseSessionCookieField(field), { kind: 'present', raw: 'abc' }, field);
      assert.equal(readSessionCookie(requestWithCookie(field)), 'abc', field);
    }
  });

  test('a duplicate session cookie pair in one field is a distinguishable parse error', () => {
    assert.deepEqual(
      parseSessionCookieField(`${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b`),
      { kind: 'parse-error' },
    );
    assert.deepEqual(
      parseSessionCookieField(`other=1; ${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b`),
      { kind: 'parse-error' },
    );
    // Fail closed: never picks the first or the last value.
    assert.equal(
      readSessionCookie(requestWithCookie(`${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b`)),
      null,
    );
  });

  test('malformed percent-encoding of the session cookie value is a parse error', () => {
    assert.deepEqual(parseSessionCookieField(`${SESSION_COOKIE_NAME}=%E0%A4%A`), { kind: 'parse-error' });
    assert.equal(readSessionCookie(requestWithCookie(`${SESSION_COOKIE_NAME}=%E0%A4%A`)), null);
    // Other cookies' values are opaque to the session cookie parse.
    assert.deepEqual(parseSessionCookieField(`other=%ZZ; ${SESSION_COOKIE_NAME}=abc`),
      { kind: 'present', raw: 'abc' });
  });

  test('cookie names are case-sensitive', () => {
    assert.deepEqual(parseSessionCookieField(`__Host-Known_session=b; ${SESSION_COOKIE_NAME}=a`),
      { kind: 'present', raw: 'a' });
    assert.deepEqual(parseSessionCookieField('__Host-Known_session=b'), { kind: 'absent' });
    assert.equal(readSessionCookie(requestWithCookie('__Host-Known_session=b')), null);
  });

  test('a pair without an equals sign is not a session cookie occurrence', () => {
    assert.deepEqual(parseSessionCookieField(SESSION_COOKIE_NAME), { kind: 'absent' });
    assert.deepEqual(parseSessionCookieField(`${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}`),
      { kind: 'present', raw: 'a' });
  });
});

describe('product admission maps session cookie parse errors to 400 (FIX-L-003)', () => {
  test('a duplicate session cookie inside one Cookie header is rejected with 400', async () => {
    const app = buildApiApp({ config: loadConfig(testEnv()), identityUnitOfWork: emptyIdentityUnitOfWork() });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: `${SESSION_COOKIE_NAME}=a; ${SESSION_COOKIE_NAME}=b` },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_request');
    assert.ok(typeof response.json().error.requestId === 'string'
      && response.json().error.requestId.length > 0);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('a malformed-encoded session cookie value is rejected with 400', async () => {
    const app = buildApiApp({ config: loadConfig(testEnv()), identityUnitOfWork: emptyIdentityUnitOfWork() });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: `${SESSION_COOKIE_NAME}=%E0%A4%A` },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_request');
  });

  test('duplicate Cookie header lines and comma-joined values stay rejected', async () => {
    const app = buildApiApp({ config: loadConfig(testEnv()), identityUnitOfWork: emptyIdentityUnitOfWork() });
    apps.push(app);
    for (const cookie of [
      [`${SESSION_COOKIE_NAME}=a`, `${SESSION_COOKIE_NAME}=b`],
      `${SESSION_COOKIE_NAME}=a, ${SESSION_COOKIE_NAME}=b`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/session',
        headers: { cookie },
      });
      assert.equal(response.statusCode, 400, String(cookie));
      assert.equal(response.json().error.code, 'invalid_request', String(cookie));
    }
  });

  test('a single well-formed session cookie passes admission to the handler', async () => {
    const app = buildApiApp({
      config: loadConfig(testEnv()),
      identityUnitOfWork: unauthenticatedIdentityUnitOfWork(),
    });
    apps.push(app);
    for (const cookie of [
      `${SESSION_COOKIE_NAME}=valid-token`,
      `theme=dark; ${SESSION_COOKIE_NAME}=valid-token; locale=en`,
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
      assert.equal(response.statusCode, 200, cookie);
      assert.deepEqual(response.json(), { authenticated: false }, cookie);
    }
  });

  test('a case-variant cookie name is not the session cookie (absent, not 400)', async () => {
    const app = buildApiApp({ config: loadConfig(testEnv()), identityUnitOfWork: emptyIdentityUnitOfWork() });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: '__Host-Known_session=valid-token' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { authenticated: false });
  });
});
