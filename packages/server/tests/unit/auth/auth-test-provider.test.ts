/**
 * Task E1 contract tests for the controlled OAuth provider (plan §11 E1
 * step 4): a REAL HTTP authorization/token/userinfo chain with S256 PKCE,
 * one-time codes, client-credential verification and Bearer userinfo.
 *
 * 假阴性防护: the authorization code / PKCE / token / userinfo chain executes
 * over real HTTP with a REAL sha256(base64url) challenge — never a stub.
 *
 * 假阳性防护: replaying a consumed code, a wrong verifier, wrong client
 * credentials and an unknown Bearer token must ALL fail; the code prefix is
 * `controlled-*`, never `known_test.*` (the legacy exchange is not reused).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'vitest';
import { startControlledOAuthProvider, type ControlledOAuthProvider } from '../../support/auth-test-provider.js';

const CLIENT_ID = 'test-google-client-id';
const CLIENT_SECRET = 'test-google-client-secret'; // secret-scan: allow 'test-google-client-secret'
const USERINFO = { id: 'google-user-1', email: 'google-user@example.test', email_verified: true, name: 'Google User' };

const providers: ControlledOAuthProvider[] = [];
afterEach(async () => {
  while (providers.length > 0) {
    const provider = providers.pop();
    await provider?.close();
  }
});

async function startProvider() {
  const provider = await startControlledOAuthProvider({ providerId: 'google', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, userinfo: USERINFO });
  providers.push(provider);
  return provider;
}

function authorizeUrl(provider: ControlledOAuthProvider, input: { codeChallenge: string; state: string; redirectUri: string; clientId?: string }) {
  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId ?? provider.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function exchange(
  provider: ControlledOAuthProvider,
  input: { code: string; verifier: string; clientId?: string; clientSecret?: string },
): Promise<{ status: number; body: { access_token?: string; error?: string } }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.verifier,
    client_id: input.clientId ?? provider.clientId,
    client_secret: input.clientSecret ?? provider.clientSecret,
  });
  const response = await fetch(provider.tokenEndpoint, { method: 'POST', body });
  return { status: response.status, body: await response.json() as { access_token?: string; error?: string } };
}

test('full controlled flow: authorize -> PKCE exchange -> userinfo; no known_test material', async () => {
  const provider = await startProvider();
  const redirectUri = 'https://app.example.test/api/v1/auth/callback/google';
  const state = 'opaque-state';
  const verifier = 'x'.repeat(43);
  const challenge = s256(verifier);

  const authorize = await fetch(authorizeUrl(provider, { codeChallenge: challenge, state, redirectUri }), { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const callback = new URL(String(authorize.headers.get('location')));
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code')!;
  assert.match(code, /^controlled-google-/u);
  assert.equal(code.startsWith('known_test.'), false, 'the controlled provider must never mint legacy known_test codes');

  const token = await exchange(provider, { code, verifier });
  assert.equal(token.status, 200);
  assert.ok(token.body.access_token);
  assert.equal(provider.state.codes.get(code)?.used, true, 'codes are single-use');
  assert.equal(provider.state.tokenRequests.at(-1)?.hasCodeVerifier, true);

  const userinfo = await fetch(provider.userinfoEndpoint, {
    headers: { authorization: `Bearer ${token.body.access_token}` },
  });
  assert.equal(userinfo.status, 200);
  assert.deepEqual(await userinfo.json(), USERINFO);
  assert.equal(provider.state.tokens.has(token.body.access_token!), true);
});

test('PKCE verification is REAL: a wrong verifier is rejected and the code stays unused', async () => {
  const provider = await startProvider();
  const challenge = s256('correct-verifier-1234567890');
  const authorize = await fetch(authorizeUrl(provider, { codeChallenge: challenge, state: 's', redirectUri: 'https://app.example.test/cb' }), { redirect: 'manual' });
  const code = new URL(String(authorize.headers.get('location'))).searchParams.get('code')!;

  const wrong = await exchange(provider, { code, verifier: 'wrong-verifier-1234567890' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'invalid_grant');
  assert.equal(provider.state.codes.get(code)?.used, false, 'a failed exchange must not consume the code');

  const right = await exchange(provider, { code, verifier: 'correct-verifier-1234567890' });
  assert.equal(right.status, 200);
  assert.ok(right.body.access_token);
});

test('replaying a consumed code and wrong client credentials are rejected', async () => {
  const provider = await startProvider();
  const challenge = s256('verifier-for-replay');
  const authorize = await fetch(authorizeUrl(provider, { codeChallenge: challenge, state: 's', redirectUri: 'https://app.example.test/cb' }), { redirect: 'manual' });
  const code = new URL(String(authorize.headers.get('location'))).searchParams.get('code')!;

  const first = await exchange(provider, { code, verifier: 'verifier-for-replay' });
  assert.equal(first.status, 200);
  const replay = await exchange(provider, { code, verifier: 'verifier-for-replay' });
  assert.equal(replay.status, 400, 'a consumed code must be rejected on replay');

  const badSecret = await exchange(provider, { code, verifier: 'verifier-for-replay', clientSecret: 'wrong-secret' }); // secret-scan: allow 'wrong-secret'
  assert.equal(badSecret.status, 400, 'wrong client credentials must be rejected');
  const badId = await exchange(provider, { code, verifier: 'verifier-for-replay', clientId: 'wrong-client-id' });
  assert.equal(badId.status, 400, 'wrong client id must be rejected');
  assert.ok(provider.state.tokenRequests.every((request) => request.hasCodeVerifier));
});

test('unknown or unset user identity fails userinfo with 401', async () => {
  const provider = await startProvider();
  const challenge = s256('verifier-userinfo');
  const authorize = await fetch(authorizeUrl(provider, { codeChallenge: challenge, state: 's', redirectUri: 'https://app.example.test/cb' }), { redirect: 'manual' });
  const code = new URL(String(authorize.headers.get('location'))).searchParams.get('code')!;
  const token = await exchange(provider, { code, verifier: 'verifier-userinfo' });
  assert.equal(token.status, 200);

  const unknownToken = await fetch(provider.userinfoEndpoint, { headers: { authorization: 'Bearer not-issued' } });
  assert.equal(unknownToken.status, 401);

  provider.setUserinfo(null);
  const noIdentity = await fetch(provider.userinfoEndpoint, {
    headers: { authorization: `Bearer ${token.body.access_token}` },
  });
  assert.equal(noIdentity.status, 401, 'a provider without a controlled identity must refuse userinfo');
});
