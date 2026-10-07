import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createHardenedEgressFetch,
  HardenedEgressError,
  type HardenedEgressConnector,
} from '../../../src/infrastructure/egress/index.js';
import {
  createFetchResponseFromNodeHttp,
  isFetchNullBodyStatus,
} from '../../../src/infrastructure/egress/hardened-egress.js';
import { createCachingJwksClient } from '../../../src/infrastructure/identity/index.js';
import { FetchPublicationCachePurgeProvider, PublicationCachePurgeProviderError } from '../../../src/infrastructure/outbox/publication-cache-purge.js';
import {
  createOidcProvider,
  OidcExchangeError,
  verifyOidcDiscoveryMetadata,
} from '../../../src/transport/auth/oidc-provider.js';
import type { OidcConfig } from '../../../src/bootstrap/config.js';
import { IdTokenVerificationError, type JwksProvider } from '../../../src/modules/identity/index.js';

const PUBLIC_IP = '93.184.216.34';
const ISSUER = 'https://issuer.example.test/realms/known';
const JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`;
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;
const AUTHORIZATION_ENDPOINT = `${ISSUER}/protocol/openid-connect/auth`;
const PURGE_ENDPOINT = 'https://purge.example.test/v1/cache';

const DENIED_REDIRECTS = [
  'https://169.254.169.254/latest',
  'https://metadata.google.internal/computeMetadata/v1/',
  'https://[fe80::1]/',
] as const;

function oidcConfig(): OidcConfig {
  return {
    issuer: ISSUER,
    clientId: 'known-web',
    clientAuthMode: 'none',
    clientSecret: '',
    redirectUri: 'https://app.example.test/api/v1/auth/oidc/callback',
    audience: 'known-web',
    authorizationEndpoint: AUTHORIZATION_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    jwksUri: JWKS_URI,
    allowTestProvider: false,
    testProviderHmacSecret: '',
  };
}

function unusedJwks(): JwksProvider {
  return {
    async getKeySet() {
      throw new Error('JWKS must not be fetched when the token hop is denied');
    },
  };
}

function redirectingFetch(publicHostname: string, location: string): {
  readonly fetchImpl: ReturnType<typeof createHardenedEgressFetch>;
  readonly connectorCalls: () => number;
} {
  let connectorCalls = 0;
  const connect: HardenedEgressConnector = async (target) => {
    connectorCalls += 1;
    assert.equal(target.url.hostname, publicHostname, 'only the public first hop may connect');
    return new Response(null, { status: 302, headers: { location } });
  };
  return {
    fetchImpl: createHardenedEgressFetch({
      resolve: async () => [PUBLIC_IP],
      connect,
    }),
    connectorCalls: () => connectorCalls,
  };
}

function publicJsonFetch(body: unknown, status = 200): ReturnType<typeof createHardenedEgressFetch> {
  return createHardenedEgressFetch({
    resolve: async () => [PUBLIC_IP],
    connect: async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  });
}

function purgeRequest() {
  return {
    eventId: 'event-1',
    idempotencyKey: 'idempotency-1',
    collectionId: 'collection-1',
    publicationSlug: 'engineering-notes',
    visibility: 'public' as const,
    contentRevision: 'content-7',
    policyRevision: 'policy-4',
    sourceEventType: 'node.updated',
    sourceEventVersion: 1,
    urls: [] as const,
    surrogateKeys: [] as const,
    signal: new AbortController().signal,
  };
}

describe('hardened egress consumers deny metadata and link-local redirects', () => {
  test('JWKS client denies redirects into 169.254.169.254, metadata hosts, and link-local', async () => {
    for (const location of DENIED_REDIRECTS) {
      const { fetchImpl, connectorCalls } = redirectingFetch('issuer.example.test', location);
      const jwks = createCachingJwksClient({ jwksUri: JWKS_URI, fetchImpl });
      await assert.rejects(
        jwks.getKeySet(),
        (error: unknown) => error instanceof IdTokenVerificationError
          && error.reason === 'jwks_fetch_failed'
          && !error.message.includes('169.254'),
        location,
      );
      assert.equal(connectorCalls(), 1, location);
    }
  });

  test('OIDC discovery denies redirects into 169.254.169.254, metadata hosts, and link-local', async () => {
    for (const location of DENIED_REDIRECTS) {
      const { fetchImpl, connectorCalls } = redirectingFetch('issuer.example.test', location);
      await assert.rejects(
        () => verifyOidcDiscoveryMetadata(oidcConfig(), { fetchImpl }),
        (error: unknown) => error instanceof HardenedEgressError && error.reason === 'denied',
        location,
      );
      assert.equal(connectorCalls(), 1, location);
    }
  });

  test('OIDC token exchange denies redirects into 169.254.169.254, metadata hosts, and link-local', async () => {
    for (const location of DENIED_REDIRECTS) {
      const { fetchImpl, connectorCalls } = redirectingFetch('issuer.example.test', location);
      const provider = createOidcProvider(oidcConfig(), { fetchImpl, jwks: unusedJwks() });
      await assert.rejects(
        () => provider.exchangeAuthorizationCode({
          code: 'code',
          codeVerifier: 'verifier',
          expectedNonce: 'nonce-1',
        }),
        (error: unknown) => error instanceof HardenedEgressError && error.reason === 'denied',
        location,
      );
      assert.equal(connectorCalls(), 1, location);
    }
  });

  test('publication cache purge denies redirects into 169.254.169.254, metadata hosts, and link-local', async () => {
    for (const location of DENIED_REDIRECTS) {
      const { fetchImpl, connectorCalls } = redirectingFetch('purge.example.test', location);
      const provider = new FetchPublicationCachePurgeProvider({
        endpoint: PURGE_ENDPOINT,
        fetch: fetchImpl,
      });
      await assert.rejects(
        provider.purge(purgeRequest()),
        (error: unknown) => error instanceof PublicationCachePurgeProviderError
          && error.failureKind === 'permanent'
          && error.cause instanceof HardenedEgressError
          && error.cause.reason === 'denied',
        location,
      );
      assert.equal(connectorCalls(), 1, location);
    }
  });
});

describe('hardened egress consumers still allow legitimate public HTTPS', () => {
  test('JWKS client accepts a public HTTPS document', async () => {
    const jwks = createCachingJwksClient({
      jwksUri: JWKS_URI,
      fetchImpl: publicJsonFetch({ keys: [] }),
    });
    assert.deepEqual(await jwks.getKeySet(), { keys: [] });
  });

  test('OIDC discovery accepts matching public HTTPS metadata', async () => {
    await verifyOidcDiscoveryMetadata(oidcConfig(), {
      fetchImpl: publicJsonFetch({
        issuer: ISSUER,
        authorization_endpoint: AUTHORIZATION_ENDPOINT,
        token_endpoint: TOKEN_ENDPOINT,
        jwks_uri: JWKS_URI,
      }),
    });
  });

  test('publication cache purge accepts a public HTTPS 200', async () => {
    const provider = new FetchPublicationCachePurgeProvider({
      endpoint: PURGE_ENDPOINT,
      fetch: publicJsonFetch({ ok: true }),
    });
    await provider.purge(purgeRequest());
  });

  test('OIDC token exchange reaches a legitimate public HTTPS token endpoint', async () => {
    const provider = createOidcProvider(oidcConfig(), {
      fetchImpl: publicJsonFetch({ access_token: 'x' }),
      jwks: unusedJwks(),
    });
    await assert.rejects(
      () => provider.exchangeAuthorizationCode({
        code: 'code',
        codeVerifier: 'verifier',
        expectedNonce: 'nonce-1',
      }),
      (error: unknown) => error instanceof OidcExchangeError && error.reason === 'missing_id_token',
    );
  });
});

describe('createFetchResponseFromNodeHttp', () => {
  test('null-body statuses are 204, 205, and 304', () => {
    assert.equal(isFetchNullBodyStatus(204), true);
    assert.equal(isFetchNullBodyStatus(205), true);
    assert.equal(isFetchNullBodyStatus(304), true);
    assert.equal(isFetchNullBodyStatus(200), false);
  });

  test('204 with a stream body would throw in undici; the helper uses a null body', () => {
    const stream = new ReadableStream<Uint8Array>();
    assert.throws(
      () => new Response(stream, { status: 204 }),
      /Invalid response status code 204/u,
    );
    const response = createFetchResponseFromNodeHttp({
      statusCode: 204,
      statusText: 'No Content',
      headers: {},
      body: stream,
    });
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
  });

  test('missing statusCode becomes 502 instead of the invalid Fetch status 0', () => {
    const response = createFetchResponseFromNodeHttp({
      statusCode: undefined,
      statusText: undefined,
      headers: { 'x-known': '1' },
      body: null,
    });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('x-known'), '1');
  });
});
