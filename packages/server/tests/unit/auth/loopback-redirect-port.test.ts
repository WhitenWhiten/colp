import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ClientDiscovery } from '@better-auth/oauth-provider';
import {
  dispatchBetterAuthWithLoopbackRedirectContext,
  expandLoopbackRedirectUris,
  isLoopbackRedirectHostname,
  isLoopbackRedirectPortVariant,
  redirectUriFromRequestBody,
  redirectUriFromRequestUrl,
  requestedRedirectUri,
  runWithRequestedRedirectUri,
  wrapCimdClientDiscoveryWithLoopbackRedirectVariance,
} from '../../../src/infrastructure/auth/loopback-redirect-port.js';

const LOCALHOST = 'http://localhost/callback';
const LOCALHOST_EPHEMERAL = 'http://localhost:3118/callback';
const LOCALHOST_SECOND_EPHEMERAL = 'http://localhost:4118/callback';
const LOOPBACK = 'http://127.0.0.1/callback';
const LOOPBACK_EPHEMERAL = 'http://127.0.0.1:3118/callback';

test('localhost and 127.0.0.1 are loopback redirect hosts; public hosts are not', () => {
  assert.equal(isLoopbackRedirectHostname('localhost'), true);
  assert.equal(isLoopbackRedirectHostname('app.localhost'), true);
  assert.equal(isLoopbackRedirectHostname('127.0.0.1'), true);
  assert.equal(isLoopbackRedirectHostname('127.1.2.3'), true);
  assert.equal(isLoopbackRedirectHostname('::1'), true);
  assert.equal(isLoopbackRedirectHostname('example.com'), false);
  assert.equal(isLoopbackRedirectHostname('notlocalhost'), false);
  assert.equal(isLoopbackRedirectHostname('10.0.0.1'), false);
});

test('port variance matches same loopback host+path and rejects host or path drift', () => {
  assert.equal(isLoopbackRedirectPortVariant(LOCALHOST, LOCALHOST_EPHEMERAL), true);
  assert.equal(isLoopbackRedirectPortVariant(LOOPBACK, LOOPBACK_EPHEMERAL), true);
  assert.equal(isLoopbackRedirectPortVariant(LOCALHOST, LOCALHOST), true);
  assert.equal(isLoopbackRedirectPortVariant(LOCALHOST, LOOPBACK_EPHEMERAL), false);
  assert.equal(isLoopbackRedirectPortVariant(LOOPBACK, LOCALHOST_EPHEMERAL), false);
  assert.equal(isLoopbackRedirectPortVariant(LOCALHOST, 'http://localhost:3118/other'), false);
  assert.equal(isLoopbackRedirectPortVariant(LOCALHOST, 'https://localhost:3118/callback'), false);
  assert.equal(isLoopbackRedirectPortVariant('https://clients.example.test/cb', LOCALHOST_EPHEMERAL), false);
});

test('expandLoopbackRedirectUris appends only a matching requested URI', () => {
  assert.deepEqual(expandLoopbackRedirectUris([LOCALHOST, LOOPBACK], undefined), [LOCALHOST, LOOPBACK]);
  assert.deepEqual(
    expandLoopbackRedirectUris([LOCALHOST, LOOPBACK], LOCALHOST_EPHEMERAL),
    [LOCALHOST, LOOPBACK, LOCALHOST_EPHEMERAL],
  );
  assert.deepEqual(expandLoopbackRedirectUris([LOCALHOST], LOCALHOST), [LOCALHOST]);
  assert.deepEqual(
    expandLoopbackRedirectUris([LOCALHOST], 'http://localhost:3118/other'),
    [LOCALHOST],
  );
});

test('each cached CIMD resolution gets only its request port without mutating the canonical client', async () => {
  const canonicalClient = {
    clientId: 'https://cimd.example.test/oauth',
    clientDiscoveryId: 'cimd',
    redirectUris: [LOCALHOST],
  };
  let resolveCalls = 0;
  const wrapped = wrapCimdClientDiscoveryWithLoopbackRedirectVariance({
    id: 'cimd',
    matches: () => true,
    resolve: async () => {
      resolveCalls += 1;
      // Deliberately return the same object, as the upstream metadata-cache
      // hit does for an existing DB client.
      return canonicalClient;
    },
  } as ClientDiscovery);

  const first = await runWithRequestedRedirectUri(LOCALHOST_EPHEMERAL, () =>
    wrapped.resolve({} as never, canonicalClient.clientId, canonicalClient));
  const second = await runWithRequestedRedirectUri(LOCALHOST_SECOND_EPHEMERAL, () =>
    wrapped.resolve({} as never, canonicalClient.clientId, canonicalClient));

  assert.deepEqual(first?.redirectUris, [LOCALHOST, LOCALHOST_EPHEMERAL]);
  assert.deepEqual(second?.redirectUris, [LOCALHOST, LOCALHOST_SECOND_EPHEMERAL]);
  assert.deepEqual(canonicalClient.redirectUris, [LOCALHOST], 'ephemeral ports must never enter cache/DB state');
  assert.equal(resolveCalls, 2, 'the request-local decorator must run on every cache hit');
});

test('dispatchBetterAuthWithLoopbackRedirectContext binds redirect_uri from the request URL', async () => {
  const request = new Request(`https://know-n.com/api/v1/auth/oauth2/authorize?redirect_uri=${encodeURIComponent(LOCALHOST_EPHEMERAL)}`);
  let seen: string | undefined;
  const response = await dispatchBetterAuthWithLoopbackRedirectContext(request, async () => {
    seen = requestedRedirectUri();
    return new Response('ok');
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(seen, LOCALHOST_EPHEMERAL);
  assert.equal(redirectUriFromRequestUrl(request.url), LOCALHOST_EPHEMERAL);
});

test('consent oauth_query and token form bodies restore the same request-local redirect', () => {
  const oauthQuery = new URLSearchParams({
    client_id: 'https://cimd.example.test/oauth',
    redirect_uri: LOCALHOST_EPHEMERAL,
    sig: 'signature-still-verified-by-better-auth',
  }).toString();
  assert.equal(
    redirectUriFromRequestBody(
      Buffer.from(JSON.stringify({ accept: true, oauth_query: oauthQuery })),
      'application/json',
      'oauth-query',
    ),
    LOCALHOST_EPHEMERAL,
  );
  assert.equal(
    redirectUriFromRequestBody(
      Buffer.from(new URLSearchParams({ redirect_uri: LOCALHOST_SECOND_EPHEMERAL }).toString()),
      'application/x-www-form-urlencoded',
      'direct',
    ),
    LOCALHOST_SECOND_EPHEMERAL,
  );
});
