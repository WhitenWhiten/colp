/**
 * Task E1 contract tests for the Better Auth test session factory (in-memory
 * backend; plan §11 E1 steps 1/5).
 *
 * 假阴性防护:
 * - every minted cookie is validated through the REAL A3 authority (real
 *   `parseBrowserSessionCookie` / `browserSessionTokenOf` / CSRF derivation)
 *   and the REAL `createBrowserSessionAuthority` facade — never a hand-rolled
 *   session lookup;
 * - the CSRF flow ends in a REAL product mutation (PATCH /api/v1/me) through
 *   buildApiApp with the returned CSRF.
 *
 * 假阳性防护:
 * - no legacy `sessions` row is written by the factory and no `known_test.`
 *   material appears in the cookie (legacy token exchange is never reused);
 * - a tampered cookie, a disabled account, a revoked session and a foreign
 *   factory secret all fail authentication (no stub can satisfy them).
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { SESSION_ROTATION_MIN_AGE_MS } from '../../../src/modules/identity/index.js';
import { BROWSER_SESSION_LIVE_CAP, browserSessionTokenHash } from '../../../src/modules/auth/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';
import {
  createInMemoryBetterAuthTestFactory,
  issueTestSession,
  BETTER_AUTH_TEST_SECRET,
} from '../../support/better-auth-test-factory.js';

const NOW = new Date('2026-08-01T12:00:00.000Z');
const ORIGIN = 'https://app.example.test';

function createHarness() {
  const identityState = createIdentityMemoryState(NOW);
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(identityState);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/known_test',
    PRODUCT_ORIGIN: ORIGIN,
    ALLOWED_ORIGINS: ORIGIN,
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });
  const app = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
  });
  return { identityState, identityUnitOfWork, factory, config, app };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
});

test('issue returns the compatible shape; the cookie passes the REAL parser and authenticates', async () => {
  const { identityState, factory, app } = createHarness();
  apps.push(app);

  const client = await issueTestSession({
    factory,
    subject: 'factory-user-1',
    handle: 'Factory_User_1',
    displayName: 'Factory User',
  });

  assert.equal(typeof client.cookie, 'string');
  assert.equal(typeof client.csrfToken, 'string');
  assert.match(client.accountId, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
  assert.match(client.subjectId, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
  assert.notEqual(client.accountId, client.subjectId, 'business ids must be distinct');

  // The cookie is a full Cookie header the browser would send back.
  assert.match(client.cookie, /^__Host-known_session=/u);
  assert.ok(client.cookie.length > 0);

  // The REAL authority (real parsers + real facade) authenticates the cookie.
  const actor = await factory.authority.authenticate({ cookie: client.cookie });
  assert.ok(actor, 'the factory cookie must authenticate through the real authority');
  assert.equal(actor.account.id, client.accountId);
  assert.equal(actor.account.subjectId, client.subjectId);
  assert.equal(actor.account.status, 'active');
  assert.equal(actor.session.accountId, client.accountId);

  // The business account/profile/handle live in the harness identity state.
  const account = identityState.accounts.get(client.accountId);
  assert.ok(account);
  assert.equal(account.email, null, 'unverified email must not be stored by default');
  assert.equal(identityState.profiles.get(client.accountId)?.displayName, 'Factory User');
  assert.equal(identityState.handles.get('factory_user_1')?.accountId, client.accountId, 'handle must be lowercased');

  // 假阳性防护: the factory never writes legacy sessions rows and never
  // produces known_test.* material.
  assert.equal(identityState.sessions.size, 0, 'no legacy sessions row may be written');
  assert.equal(client.cookie.includes('known_test.'), false, 'known_test.* token exchange must never be reused');
});

test('bootstrap returns the derived CSRF and a foreign CSRF fails the real mutation check', async () => {
  const { factory, config, app } = createHarness();
  apps.push(app);

  const client = await issueTestSession({ factory, subject: 'csrf-user', handle: 'csrf_user' });
  const other = await issueTestSession({ factory, subject: 'csrf-other', handle: 'csrf_other' });

  const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie: client.cookie } });
  assert.equal(session.statusCode, 200);
  const body = session.json() as { authenticated: boolean; csrfToken: string };
  assert.equal(body.authenticated, true);
  assert.equal(body.csrfToken, client.csrfToken, 'bootstrap must re-issue the same derived CSRF below the rotation threshold');

  const mutationHeaders = (csrf: string, commandId: string) => ({
    cookie: client.cookie,
    origin: config.productOrigin,
    'x-csrf-token': csrf,
    'known-command-id': commandId,
    'content-type': 'application/json',
  });

  const foreign = await app.inject({
    method: 'PATCH', url: '/api/v1/me', headers: mutationHeaders(other.csrfToken, '123e4567-e89b-42d3-a456-426614174001'),
    payload: { handle: 'csrf_user', displayName: 'Updated' },
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal((foreign.json() as { error: { code: string } }).error.code, 'csrf_failed');

  const missing = await app.inject({
    method: 'PATCH', url: '/api/v1/me', headers: mutationHeaders('not-a-real-csrf-token-value____________', '123e4567-e89b-42d3-a456-426614174002'),
    payload: { handle: 'csrf_user', displayName: 'Updated' },
  });
  assert.equal(missing.statusCode, 403);
  assert.equal((missing.json() as { error: { code: string } }).error.code, 'csrf_failed');

  const own = await app.inject({
    method: 'PATCH', url: '/api/v1/me', headers: mutationHeaders(client.csrfToken, '123e4567-e89b-42d3-a456-426614174003'),
    payload: { handle: 'csrf_user', displayName: 'Updated' },
  });
  assert.equal(own.statusCode, 200);
  assert.equal((own.json() as { profile: { displayName: string } }).profile.displayName, 'Updated');
});

test('signOut revokes the session; a tampered cookie never authenticates', async () => {
  const { factory } = createHarness();
  const client = await issueTestSession({ factory, subject: 'revoke-user', handle: 'revoke_user' });

  assert.ok(await factory.authority.authenticate({ cookie: client.cookie }));

  // Tampered cookie: flip one character in the signed value.
  const parsed = decodeURIComponent(client.cookie.split('=', 2)[1]!);
  const flipped = parsed.length > 0
    ? `${parsed.slice(0, -1)}${parsed.endsWith('a') ? 'b' : 'a'}`
    : 'tampered';
  const tampered = `__Host-known_session=${encodeURIComponent(flipped)}`;
  assert.equal(await factory.authority.authenticate({ cookie: tampered }), null, 'a tampered signature must fail');

  await factory.authority.signOut({ cookie: client.cookie });
  assert.equal(await factory.authority.authenticate({ cookie: client.cookie }), null, 'a signed-out session must fail');
  assert.equal(factory.liveSessionCountForAccount(client.accountId), 0);
});

test('a disabled business account fails authentication (real assertAccountUsable)', async () => {
  const { identityState, factory } = createHarness();
  const client = await issueTestSession({ factory, subject: 'disabled-user', handle: 'disabled_user' });
  assert.ok(await factory.authority.authenticate({ cookie: client.cookie }));

  const account = identityState.accounts.get(client.accountId);
  assert.ok(account);
  identityState.accounts.set(client.accountId, { ...account, status: 'disabled' });
  assert.equal(await factory.authority.authenticate({ cookie: client.cookie }), null);
});

test('parallel factories never cross-validate (per-factory secrets)', async () => {
  const { identityState, identityUnitOfWork, factory } = createHarness();
  const otherFactory = createInMemoryBetterAuthTestFactory({
    identityUnitOfWork,
    secret: 'another-test-secret-00000000000000000000',
  });
  const client = await issueTestSession({ factory, subject: 'parallel-user', handle: 'parallel_user' });

  assert.ok(await factory.authority.authenticate({ cookie: client.cookie }));
  assert.equal(
    await otherFactory.authority.authenticate({ cookie: client.cookie }),
    null,
    'a cookie signed by another factory secret must fail',
  );
  assert.equal(identityState.sessions.size, 0);
});

test('re-issuing the same subject reuses the business account and mints a fresh session', async () => {
  const { factory } = createHarness();
  const first = await issueTestSession({ factory, subject: 'reuse-user', handle: 'reuse_user' });
  const second = await issueTestSession({ factory, subject: 'reuse-user', handle: 'reuse_user' });

  assert.equal(second.accountId, first.accountId, 'the same subject must reuse the business account');
  assert.equal(second.subjectId, first.subjectId);
  assert.notEqual(second.cookie, first.cookie, 'each issue must mint a fresh session');
  assert.notEqual(second.csrfToken, first.csrfToken);
  assert.equal(factory.liveSessionCountForAccount(first.accountId), 2);
  assert.ok(await factory.authority.authenticate({ cookie: first.cookie }));
  assert.ok(await factory.authority.authenticate({ cookie: second.cookie }));
});

test('the 51st issued live session evicts the oldest cookie', async () => {
  const { factory, identityState } = createHarness();
  const first = await issueTestSession({ factory, subject: 'cap-user', handle: 'cap_user' });
  assert.equal(
    factory.setMetadataLastSeenAt(first.accountId, new Date(identityState.now.getTime() - 60_000)),
    true,
  );
  for (let index = 1; index < BROWSER_SESSION_LIVE_CAP; index += 1) {
    await issueTestSession({ factory, subject: 'cap-user', handle: 'cap_user' });
  }
  assert.equal(factory.liveSessionCountForAccount(first.accountId), BROWSER_SESSION_LIVE_CAP);
  const newest = await issueTestSession({ factory, subject: 'cap-user', handle: 'cap_user' });
  assert.equal(factory.liveSessionCountForAccount(first.accountId), BROWSER_SESSION_LIVE_CAP);
  assert.equal(await factory.authority.authenticate({ cookie: first.cookie }), null);
  assert.ok(await factory.authority.authenticate({ cookie: newest.cookie }));
});

test('an unverified occupancy session is not a product actor', async () => {
  const { factory } = createHarness();
  const occupancy = await issueTestSession({
    factory, subject: 'occupancy-user', handle: 'occupancy_user', emailVerified: false,
  });
  assert.equal(await factory.authority.authenticate({ cookie: occupancy.cookie }), null);
  assert.deepEqual(await factory.authority.bootstrap({ cookie: occupancy.cookie }), {
    authenticated: false,
    verificationRequired: true,
  });
});

test('bootstrap rotates above the rotation age and the successor cookie authenticates', async () => {
  const { identityState, factory } = createHarness();
  const client = await issueTestSession({ factory, subject: 'rotate-user', handle: 'rotate_user' });

  // Below the threshold: no rotation.
  const before = await factory.authority.bootstrap({ cookie: client.cookie });
  assert.ok(before.authenticated === true && before.rotated === false);

  // Advance the harness clock past the rotation age.
  identityState.now = new Date(NOW.getTime() + SESSION_ROTATION_MIN_AGE_MS + 1000);
  const rotated = await factory.authority.bootstrap({ cookie: client.cookie });
  assert.ok(rotated.authenticated === true);
  assert.equal(rotated.rotated, true);
  assert.ok(rotated.rotatedCookieValue);
  const rotatedCookie = `__Host-known_session=${encodeURIComponent(rotated.rotatedCookieValue)}`;

  const actor = await factory.authority.authenticate({ cookie: rotatedCookie });
  assert.ok(actor, 'the rotated successor cookie must authenticate');
  assert.equal(actor.account.id, client.accountId);
  // The predecessor metadata is revoked; the predecessor cookie no longer authenticates.
  assert.equal(await factory.authority.authenticate({ cookie: client.cookie }), null);
});

test('factory secret is the BA secret: the signed cookie matches the scheme and the metadata stores only digests', async () => {
  const { factory } = createHarness();
  const client = await issueTestSession({ factory, subject: 'scheme-user', handle: 'scheme_user' });
  assert.equal(factory.secret, BETTER_AUTH_TEST_SECRET);
  const rawCookieValue = decodeURIComponent(client.cookie.split('=', 2)[1]!);
  // BA scheme: <32-char token>.<base64 HMAC-SHA256 signature> (no dots in the
  // token or base64 alphabet, so exactly one dot).
  assert.match(rawCookieValue, /^[A-Za-z0-9]{32}\.[A-Za-z0-9+/=]+$/u);
  const token = rawCookieValue.slice(0, 32);
  assert.notEqual(client.csrfToken, token, 'the CSRF must be purpose-separated from the session token');
  assert.equal(factory.state.metadata.size, 1);
  const metadata = [...factory.state.metadata.values()][0]!;
  assert.equal(metadata.sessionTokenHash, browserSessionTokenHash(token), 'metadata must store the sha256 digest only');
  assert.notEqual(metadata.sessionTokenHash, token, 'the raw token must never be persisted by the product side');
  assert.equal(factory.state.sessions.size, 1);
});
