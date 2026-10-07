import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import Fastify from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import {
  createBetterAuthRuntime,
  fastifyRequestToFetchRequest,
  applyFetchResponse,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { openBetterAuthPostgres, type BetterAuthPostgresFixture } from '../../support/better-auth-postgres.js';

/**
 * Task A1 bridge tests: REAL Better Auth 1.7.1 handler over a REAL
 * PostgreSQL (testcontainers postgres:16.4-alpine, schema created from the
 * library-generated migration) mounted through the production Fastify app
 * (buildApiApp + the A1 runtime seam).
 *
 * False-positive protection: every 2xx evidence comes from the real handler
 * writing real rows (checked in the database); auth.handler is never mocked.
 * The only synthetic Response is the redirect forwarding probe — no allowlisted
 * endpoint of the G1 §10 contract produces a 302 in 1.7.1 without the OAuth
 * callback surface (which stays unregistered until A4/C3, G1 §17 P2).
 */

const TRUSTED_ORIGIN = 'https://app.example.test';

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: TRUSTED_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    // Small bounded body limit so the 413 admission path is exercised by the
    // bridge routes (product-admission content-length check).
    BETTER_AUTH_BODY_LIMIT_BYTES: '1024',
    ...overrides,
  };
}

let app: ReturnType<typeof buildApiApp>;
let postgres: BetterAuthPostgresFixture;

beforeAll(async () => {
  const config = loadConfig(env());
  const built = buildBetterAuthConfig(config.betterAuth);
  assert.ok(built, 'enabled config must produce Better Auth settings');
  postgres = await openBetterAuthPostgres(built);
  const runtime = createBetterAuthRuntime({
    enabled: true,
    config: built,
    database: { db: postgres.db, type: 'postgres', transaction: true },
  });
  assert.ok(runtime, 'enabled runtime must construct');
  app = buildApiApp({ config, betterAuthRuntime: runtime });
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await postgres?.close();
});

function setCookieValues(headers: Record<string, unknown>): string[] {
  const raw = headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? (raw as string[]) : [raw as string];
}

function sessionCookieValue(setCookies: string[]): string | null {
  const entry = setCookies.find((cookie) => cookie.startsWith('__Host-known_session='));
  return entry ? entry.split(';', 1)[0] : null;
}

function jsonBody(response: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

async function markEmailVerified(email: string): Promise<void> {
  const result = await postgres.adminPool.query(
    `UPDATE "${postgres.schemaName}"."auth_users" SET "emailVerified" = true WHERE email = $1`,
    [email],
  );
  assert.equal(result.rowCount, 1, `must mark ${email} verified`);
}

describe('Better Auth Fastify bridge (real handler, real PostgreSQL)', () => {
  test('GET /api/v1/auth/get-session bridges to the real handler (200 null)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/get-session' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'null');
    assert.match(String(res.headers['content-type'] ?? ''), /application\/json/u);
  });

  test('POST sign-up/email JSON body creates a user with Argon2id credential and no session cookie', async () => {
    const email = `adapter-json-${Date.now()}@example.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'Adapter Json', email, password: 'adapter-password-1' }), // secret-scan: allow 'adapter-password-1'
    });
    assert.equal(res.statusCode, 200);
    const body = jsonBody(res);
    assert.equal(body.user && (body.user as { email?: string }).email, email);
    // Task A4 R9: the raw session token is stripped from 2xx bodies — the
    // __Host-known_session cookie is the only credential carrier.
    assert.equal('token' in body, false, 'A4 R9: sign-up must not expose the raw session token');
    const cookies = setCookieValues(res.headers);
    const sessionEntry = cookies.find((cookie) => cookie.startsWith('__Host-known_session='));
    assert.equal(sessionEntry, undefined, 'P1: password sign-up must not set __Host-known_session');
    // Real database evidence: user row + credential row with the Argon2id hash.
    const rows = await postgres.adminPool.query(
      `SELECT u.email, a."providerId", a.password FROM "${postgres.schemaName}"."auth_users" u`
      + ` JOIN "${postgres.schemaName}"."auth_accounts" a ON a."userId" = u.id WHERE u.email = $1`,
      [email],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]?.providerId, 'credential');
    assert.match(String(rows.rows[0]?.password ?? ''), /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
  });

  test('session cookie round-trips through the bridge (get-session returns the user)', async () => {
    const email = `adapter-roundtrip-${Date.now()}@example.test`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'Adapter Roundtrip', email, password: 'adapter-password-2' }), // secret-scan: allow 'adapter-password-2'
    });
    assert.equal(signUp.statusCode, 200);
    await markEmailVerified(email);
    const cookie = sessionCookieValue(setCookieValues(signUp.headers));
    assert.equal(cookie, null, 'P1: sign-up must not set a session cookie');
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ email, password: 'adapter-password-2' }), // secret-scan: allow 'adapter-password-2'
    });
    assert.equal(signIn.statusCode, 200);
    const sessionCookie = sessionCookieValue(setCookieValues(signIn.headers));
    assert.ok(sessionCookie);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/get-session?disableRefresh=true',
      headers: { cookie: sessionCookie },
    });
    assert.equal(res.statusCode, 200);
    const body = jsonBody(res);
    assert.equal(body.user && (body.user as { email?: string }).email, email);
  });

  test('multiple Set-Cookie headers keep their order (session first, dont_remember second)', async () => {
    const email = `adapter-order-${Date.now()}@example.test`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'Adapter Order', email, password: 'adapter-password-3' }), // secret-scan: allow 'adapter-password-3'
    });
    assert.equal(signUp.statusCode, 200);
    await markEmailVerified(email);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ email, password: 'adapter-password-3', rememberMe: false }), // secret-scan: allow 'adapter-password-3'
    });
    assert.equal(res.statusCode, 200);
    const cookies = setCookieValues(res.headers);
    assert.ok(cookies.length >= 2, `expected >= 2 Set-Cookie entries, got ${cookies.length}`);
    assert.ok(cookies[0]!.startsWith('__Host-known_session='), `first cookie must be the session cookie: ${cookies[0]}`);
    assert.ok(cookies[1]!.startsWith('known.dont_remember='), `second cookie must be dont_remember: ${cookies[1]}`);
  });

  test('form-encoded body reaches the real handler (sign-in/email)', async () => {
    const email = `adapter-form-${Date.now()}@example.test`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'Adapter Form', email, password: 'adapter-password-4' }), // secret-scan: allow 'adapter-password-4'
    });
    assert.equal(signUp.statusCode, 200);
    await markEmailVerified(email);
    const form = new URLSearchParams({ email, password: 'adapter-password-4' }).toString(); // secret-scan: allow 'adapter-password-4'
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TRUSTED_ORIGIN },
      payload: form,
    });
    assert.equal(res.statusCode, 200);
    assert.ok(sessionCookieValue(setCookieValues(res.headers)) !== null, 'form sign-in must issue the session cookie');
  });

  test('bridge forwards redirect status, Location header and empty body', async () => {
    const probe = Fastify({ logger: false });
    probe.get('/redirect-probe', async (_request, reply) => {
      const response = new Response(null, {
        status: 302,
        headers: { location: 'https://app.example.test/dashboard' },
      });
      await applyFetchResponse(reply, response);
    });
    const res = await probe.inject({ method: 'GET', url: '/redirect-probe' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, 'https://app.example.test/dashboard');
    assert.equal(res.body, '');
    await probe.close();
  });

  test('client abort propagates to the bridge Request signal', async () => {
    const probe = Fastify({ logger: false });
    probe.get('/abort-probe', async () => 'ok');
    let observedAborted: boolean | null = null;
    let requestStartedResolve!: () => void;
    const requestStarted = new Promise<void>((resolve) => { requestStartedResolve = resolve; });
    let signalObservedResolve!: () => void;
    const signalObserved = new Promise<void>((resolve) => { signalObservedResolve = resolve; });
    probe.addHook('onRequest', async (request, reply) => {
      const fetchRequest = fastifyRequestToFetchRequest(request, reply);
      const aborted = fetchRequest.signal.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) => fetchRequest.signal.addEventListener('abort', () => resolve(), { once: true }));
      requestStartedResolve();
      await aborted;
      observedAborted = fetchRequest.signal.aborted;
      signalObservedResolve();
      reply.send('ok');
    });
    await probe.listen({ port: 0, host: '127.0.0.1' });
    const port = (probe.server.address() as { readonly port: number }).port;
    const controller = new AbortController();
    const outcomePromise = fetch(`http://127.0.0.1:${port}/abort-probe`, { signal: controller.signal })
      .catch((error: unknown) => ({
        aborted: error instanceof Error && error.name === 'AbortError',
      }));
    await requestStarted;
    controller.abort();
    const settled = await outcomePromise;
    await signalObserved;
    assert.equal(settled.aborted, true, 'client fetch must reject with AbortError');
    assert.equal(observedAborted, true, 'server-side bridge signal must observe the abort');
    await probe.close();
  });

  test('aborting a real handler request does not break the server', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { readonly port: number }).port;
    const email = `adapter-abort-${Date.now()}@example.test`;
    const controller = new AbortController();
    let requestReachedResolve!: () => void;
    const requestReached = new Promise<void>((resolve) => { requestReachedResolve = resolve; });
    const observeRequest = (request: { readonly url?: string }): void => {
      if (request.url === '/api/v1/auth/sign-up/email') requestReachedResolve();
    };
    app.server.on('request', observeRequest);
    const outcomePromise = fetch(`http://127.0.0.1:${port}/api/v1/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      body: JSON.stringify({ name: 'Adapter Abort', email, password: 'adapter-password-5' }), // secret-scan: allow 'adapter-password-5'
      signal: controller.signal,
    }).catch((error: unknown) => ({
      aborted: error instanceof Error && error.name === 'AbortError',
    }));
    await requestReached;
    controller.abort();
    const settled = await outcomePromise;
    app.server.off('request', observeRequest);
    assert.equal(settled.aborted, true, 'client must observe AbortError');
    // The server stays healthy: a follow-up request still works.
    const probe = await app.inject({ method: 'GET', url: '/api/v1/auth/get-session' });
    assert.equal(probe.statusCode, 200);
  });

  test('untrusted Origin is rejected by the real handler (403 INVALID_ORIGIN)', async () => {
    const email = `adapter-origin-${Date.now()}@example.test`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'Adapter Origin', email, password: 'adapter-password-6' }), // secret-scan: allow 'adapter-password-6'
    });
    assert.equal(signUp.statusCode, 200);
    await markEmailVerified(email);
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ email, password: 'adapter-password-6' }), // secret-scan: allow 'adapter-password-6'
    });
    assert.equal(signIn.statusCode, 200);
    const cookie = sessionCookieValue(setCookieValues(signIn.headers));
    assert.ok(cookie, 'verified sign-in must set the session cookie');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie },
      payload: JSON.stringify({ email, password: 'adapter-password-6' }), // secret-scan: allow 'adapter-password-6'
    });
    assert.equal(res.statusCode, 403);
    // Task A4: BA's INVALID_ORIGIN is translated to the unified product
    // envelope (csrf_failed) — never the raw BA body.
    const body = res.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'csrf_failed');
  });

  test('unsupported content type is rejected by product admission (415)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { 'content-type': 'text/plain', origin: TRUSTED_ORIGIN },
      payload: 'not-json',
    });
    assert.equal(res.statusCode, 415);
    assert.match(res.body, /unsupported_media_type/u);
  });

  test('oversized body is rejected with 413 before reaching the bridge', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'x'.repeat(4096), email: 'oversize@example.test', password: 'adapter-password-7' }), // secret-scan: allow 'adapter-password-7'
    });
    assert.equal(res.statusCode, 413);
    assert.match(res.body, /payload_too_large/u);
  });
});
