import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from 'jose';
import { loadConfig, sanitizedRuntimeCapacity } from '../../support/test-config.js';
import {
  IdTokenVerificationError,
  createIdTokenVerifier,
  type JwksProvider,
} from '../../../src/modules/identity/index.js';
import {
  OidcExchangeError,
  createOidcProvider,
  mapIdTokenVerificationError,
  mapTokenEndpointFailure,
  mintTestAuthorizationCode,
  verifyOidcDiscoveryMetadata,
} from '../../../src/transport/auth/oidc-provider.js';

const ISSUER = 'https://issuer.example/realms/known';
const CLIENT_ID = 'known-web';
const AUDIENCE = CLIENT_ID;
const JWKS_URI = 'https://issuer.example/realms/known/protocol/openid-connect/certs';
const TOKEN_ENDPOINT = 'https://issuer.example/realms/known/token';
const FIXED_NOW = new Date('2026-07-22T12:00:00.000Z');
const NOW_SEC = Math.floor(FIXED_NOW.getTime() / 1000);

interface TestKeyMaterial {
  readonly privateKey: KeyLike;
  readonly publicJwk: JWK;
  readonly kid: string;
}

async function mintRsaKey(kid = 'rsa-1'): Promise<TestKeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  return { privateKey, publicJwk, kid };
}

async function signIdToken(
  key: TestKeyMaterial,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(claims as never)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
    .sign(key.privateKey);
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'subject-1',
    aud: AUDIENCE,
    nonce: 'nonce-1',
    email: 'user@example.test',
    email_verified: true,
    name: 'Test User',
    iat: NOW_SEC - 60,
    exp: NOW_SEC + 3_600,
    ...overrides,
  };
}

const PROD_OIDC_TX_SECRETS = {
  OIDC_TRANSACTION_HMAC_SECRET: 'prod-oidc-transaction-hmac-secret-not-dev-default',
  OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${Buffer.alloc(32, 5).toString('base64')}`,
} as const;

const PROD_PUBLICATION_CONFIG = {
  PUBLICATION_SERVER_UUID: '019f9031-c541-74d0-bc83-15a5526fbb54',
  PUBLICATION_CURSOR_ACTIVE_KEY_ID: 'prod-publication-v1',
  PUBLICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 17).toString('base64'),
  FOLLOW_CURSOR_ACTIVE_KEY_ID: 'prod-follow-v1',
  FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 19).toString('base64'),
  FEED_CURSOR_ACTIVE_KEY_ID: 'prod-feed-v1',
  FEED_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 21).toString('base64'),
  PUBLIC_ACTIVITY_CURSOR_ACTIVE_KEY_ID: 'prod-public-activity-v1',
  PUBLIC_ACTIVITY_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 27).toString('base64'),
  NOTIFICATION_CURSOR_ACTIVE_KEY_ID: 'prod-notification-v1',
  NOTIFICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 23).toString('base64'),
  FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
  FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 37).toString('base64'),
    COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 43).toString('base64'),
    } as const;

function productionOidcConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: 'postgres://localhost/known_test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: TOKEN_ENDPOINT,
    OIDC_JWKS_URI: JWKS_URI,
    OIDC_ALLOW_TEST_PROVIDER: 'false',
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
    PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
    PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
    PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
    ...PROD_PUBLICATION_CONFIG,
    ...PROD_OIDC_TX_SECRETS,
    ...overrides,
  }).oidc;
}

function staticJwks(key: TestKeyMaterial): JwksProvider {
  return {
    async getKeySet() {
      return { keys: [key.publicJwk] };
    },
  };
}

function tokenEndpointFetch(idToken: string): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === TOKEN_ENDPOINT) {
      assert.equal(init?.method, 'POST');
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  }) as typeof fetch;
}

function capturingTokenEndpointFetch(
  idToken: string,
  capture: (body: URLSearchParams) => void,
): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === TOKEN_ENDPOINT) {
      assert.equal(init?.method, 'POST');
      capture(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  }) as typeof fetch;
}

describe('createOidcProvider construction', () => {
  test('refuses production-shaped config without jwksUri when test provider is disabled', () => {
    assert.throws(
      () => createOidcProvider({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: '',
        clientAuthMode: 'none',
        redirectUri: 'https://app.example.test/api/v1/auth/oidc/callback',
        audience: AUDIENCE,
        authorizationEndpoint: 'https://issuer.example/auth',
        tokenEndpoint: TOKEN_ENDPOINT,
        jwksUri: null,
        allowTestProvider: false,
        testProviderHmacSecret: '',
      }),
      /jwksUri is required/,
    );
  });

  test('allows test-only provider without jwksUri', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    }).oidc;
    assert.equal(config.jwksUri, null);
    const provider = createOidcProvider(config);
    const code = mintTestAuthorizationCode({
      subject: 's1',
      nonce: 'n1',
      codeVerifier: 'verifier-value',
      issuer: config.issuer,
      audience: config.audience,
      hmacSecret: config.testProviderHmacSecret,
    });
    const result = await provider.exchangeAuthorizationCode({
      code,
      codeVerifier: 'verifier-value',
      expectedNonce: 'n1',
    });
    assert.equal(result.claims.subject, 's1');
  });

  test('rejects a forged code signed with a different HMAC secret', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'per-test-provider-secret',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    }).oidc;
    const provider = createOidcProvider(config);
    // The public default secret must never verify: only the explicitly
    // configured per-deployment secret may mint/verify known_test.* codes.
    const forged = mintTestAuthorizationCode({
      subject: 'attacker',
      nonce: 'n1',
      codeVerifier: 'verifier-value',
      issuer: config.issuer,
      audience: config.audience,
      hmacSecret: 'known-oidc-test-secret',
    });
    await assert.rejects(
      () => provider.exchangeAuthorizationCode({
        code: forged,
        codeVerifier: 'verifier-value',
        expectedNonce: 'n1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof OidcExchangeError);
        assert.equal(error.reason, 'invalid_code');
        return true;
      },
    );
  });
});

describe('createOidcProvider production JWT verification', () => {
  test('accepts a valid signed ID token and returns verified claims', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims());
    const provider = createOidcProvider(productionOidcConfig(), {
      fetchImpl: tokenEndpointFetch(token),
      jwks: staticJwks(key),
      now: () => FIXED_NOW,
    });

    const result = await provider.exchangeAuthorizationCode({
      code: 'auth-code-1',
      codeVerifier: 'pkce-verifier',
      expectedNonce: 'nonce-1',
    });

    assert.equal(result.claims.issuer, ISSUER);
    assert.equal(result.claims.subject, 'subject-1');
    assert.equal(result.claims.nonce, 'nonce-1');
    assert.equal(result.claims.email, 'user@example.test');
    assert.equal(result.claims.emailVerified, true);
    assert.equal(result.claims.name, 'Test User');
  });

  test('rejects forged/unsigned tokens with invalid_signature', async () => {
    const signer = await mintRsaKey('signer');
    const other = await mintRsaKey('other');
    const token = await signIdToken(signer, baseClaims());
    // Publish a different public key under the same kid so signature verification fails.
    const forgedJwks: JwksProvider = {
      async getKeySet() {
        return { keys: [{ ...other.publicJwk, kid: signer.kid }] };
      },
    };
    const provider = createOidcProvider(productionOidcConfig(), {
      fetchImpl: tokenEndpointFetch(token),
      jwks: forgedJwks,
      now: () => FIXED_NOW,
    });

    await assert.rejects(
      () => provider.exchangeAuthorizationCode({
        code: 'auth-code-1',
        codeVerifier: 'pkce-verifier',
        expectedNonce: 'nonce-1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof OidcExchangeError);
        assert.equal(error.reason, 'invalid_signature');
        return true;
      },
    );
  });

  test('rejects alg=none forged tokens before claims are trusted', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
    const payload = Buffer.from(JSON.stringify(baseClaims()), 'utf8').toString('base64url');
    const noneToken = `${header}.${payload}.`;
    const key = await mintRsaKey();
    const provider = createOidcProvider(productionOidcConfig(), {
      fetchImpl: tokenEndpointFetch(noneToken),
      jwks: staticJwks(key),
      now: () => FIXED_NOW,
    });

    await assert.rejects(
      () => provider.exchangeAuthorizationCode({
        code: 'auth-code-1',
        codeVerifier: 'pkce-verifier',
        expectedNonce: 'nonce-1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof OidcExchangeError);
        assert.equal(error.reason, 'disallowed_algorithm');
        return true;
      },
    );
  });

  test('rejects wrong nonce via verified claims path', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({ nonce: 'other-nonce' }));
    const provider = createOidcProvider(productionOidcConfig(), {
      fetchImpl: tokenEndpointFetch(token),
      jwks: staticJwks(key),
      now: () => FIXED_NOW,
    });

    await assert.rejects(
      () => provider.exchangeAuthorizationCode({
        code: 'auth-code-1',
        codeVerifier: 'pkce-verifier',
        expectedNonce: 'nonce-1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof OidcExchangeError);
        assert.equal(error.reason, 'invalid_nonce');
        return true;
      },
    );
  });

  test('never treats known_test codes as production JWT decode fallback when test provider disabled', async () => {
    const config = productionOidcConfig();
    const key = await mintRsaKey();
    const provider = createOidcProvider(config, {
      jwks: staticJwks(key),
      fetchImpl: (async () => {
        throw new Error('token endpoint must not be called for known_test when disabled');
      }) as typeof fetch,
      now: () => FIXED_NOW,
    });
    const testCode = mintTestAuthorizationCode({
      subject: 'attacker',
      nonce: 'nonce-1',
      codeVerifier: 'pkce-verifier',
      issuer: ISSUER,
      audience: AUDIENCE,
      hmacSecret: 'test-oidc-provider-hmac-secret-not-prod-default',
    });
    // With test provider disabled, known_test.* goes to token endpoint (fetch fails)
    // or verification — never silent local claim acceptance.
    await assert.rejects(
      () => provider.exchangeAuthorizationCode({
        code: testCode,
        codeVerifier: 'pkce-verifier',
        expectedNonce: 'nonce-1',
      }),
      /token endpoint must not be called|OIDC exchange failed/,
    );
  });

  test('real JWT is never accepted via test-provider path even when allowTestProvider is true', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims());
    // Use test-provider mode without JWKS: real JWT must fail closed (jwks_required),
    // not decode-only success.
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_TOKEN_ENDPOINT: TOKEN_ENDPOINT,
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    }).oidc;
    assert.equal(config.jwksUri, null);
    const provider = createOidcProvider(config, {
      fetchImpl: tokenEndpointFetch(token),
      now: () => FIXED_NOW,
    });
    await assert.rejects(
      () => provider.exchangeAuthorizationCode({
        code: 'real-auth-code',
        codeVerifier: 'pkce-verifier',
        expectedNonce: 'nonce-1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof OidcExchangeError);
        assert.equal(error.reason, 'jwks_required');
        return true;
      },
    );
  });
});

describe('mapIdTokenVerificationError', () => {
  test('maps domain verification reasons onto transport exchange reasons', () => {
    assert.equal(
      mapIdTokenVerificationError(new IdTokenVerificationError('wrong_issuer')).reason,
      'invalid_issuer',
    );
    assert.equal(
      mapIdTokenVerificationError(new IdTokenVerificationError('wrong_audience')).reason,
      'invalid_audience',
    );
    assert.equal(
      mapIdTokenVerificationError(new IdTokenVerificationError('wrong_nonce')).reason,
      'invalid_nonce',
    );
    assert.equal(
      mapIdTokenVerificationError(new IdTokenVerificationError('missing_subject')).reason,
      'missing_subject',
    );
    assert.equal(
      mapIdTokenVerificationError(new IdTokenVerificationError('invalid_token')).reason,
      'invalid_id_token',
    );
    assert.equal(
      mapIdTokenVerificationError(new IdTokenVerificationError('invalid_signature')).reason,
      'invalid_signature',
    );
    assert.equal(
      mapIdTokenVerificationError(new IdTokenVerificationError('expired')).reason,
      'expired',
    );
    assert.equal(
      mapIdTokenVerificationError(new IdTokenVerificationError('disallowed_algorithm')).reason,
      'disallowed_algorithm',
    );
  });

  test('preserves OidcExchangeError instances', () => {
    const original = new OidcExchangeError('token_endpoint_error');
    assert.equal(mapIdTokenVerificationError(original), original);
  });
});

describe('mapTokenEndpointFailure', () => {
  test('maps OAuth invalid_grant to a terminal exchange reason', async () => {
    const response = new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'Code has been redeemed — do not leak this text',
    }), { status: 400, headers: { 'content-type': 'application/json' } });
    const mapped = await mapTokenEndpointFailure(response);
    assert.ok(mapped instanceof OidcExchangeError);
    assert.equal(mapped.reason, 'invalid_grant');
    assert.doesNotMatch(mapped.message, /redeemed|leak/i);
  });

  test('maps non-grant token endpoint failures generically', async () => {
    const response = new Response(JSON.stringify({ error: 'server_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
    const mapped = await mapTokenEndpointFailure(response);
    assert.equal(mapped.reason, 'token_endpoint_error');
  });

  test('production provider surfaces invalid_grant from token endpoint', async () => {
    const key = await mintRsaKey();
    const provider = createOidcProvider(productionOidcConfig(), {
      fetchImpl: (async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === TOKEN_ENDPOINT) {
          return new Response(JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Authorization code expired',
          }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected fetch URL: ${url}`);
      }) as typeof fetch,
      jwks: staticJwks(key),
      now: () => FIXED_NOW,
    });

    await assert.rejects(
      () => provider.exchangeAuthorizationCode({
        code: 'spent-code',
        codeVerifier: 'pkce-verifier',
        expectedNonce: 'nonce-1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof OidcExchangeError);
        assert.equal(error.reason, 'invalid_grant');
        assert.doesNotMatch(error.message, /expired|Authorization/i);
        return true;
      },
    );
  });

  test('bounds token endpoint response bodies', async () => {
    const key = await mintRsaKey();
    const provider = createOidcProvider(productionOidcConfig(), {
      fetchImpl: (async () => new Response(JSON.stringify({
        id_token: 'x'.repeat(256),
      }))) as typeof fetch,
      jwks: staticJwks(key),
      tokenEndpointMaxResponseBytes: 64,
    });

    await assert.rejects(
      () => provider.exchangeAuthorizationCode({
        code: 'code',
        codeVerifier: 'verifier',
        expectedNonce: 'nonce-1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof OidcExchangeError);
        assert.equal(error.reason, 'token_endpoint_error');
        return true;
      },
    );
  });

  test('aborts a token endpoint request at the configured deadline', async () => {
    const key = await mintRsaKey();
    let observedSignal: AbortSignal | null = null;
    const provider = createOidcProvider(productionOidcConfig(), {
      fetchImpl: (async (_input, init) => {
        observedSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }) as typeof fetch,
      jwks: staticJwks(key),
      tokenEndpointTimeoutMs: 5,
    });

    await assert.rejects(
      () => provider.exchangeAuthorizationCode({
        code: 'code',
        codeVerifier: 'verifier',
        expectedNonce: 'nonce-1',
      }),
      (error: unknown) => {
        assert.ok(error instanceof OidcExchangeError);
        assert.equal(error.reason, 'token_endpoint_error');
        return true;
      },
    );
    assert.equal(observedSignal?.aborted, true);
  });
});

describe('OIDC discovery startup verification', () => {
  function metadata(overrides: Record<string, unknown> = {}) {
    return {
      issuer: ISSUER,
      authorization_endpoint: 'https://issuer.example/realms/known/auth',
      token_endpoint: TOKEN_ENDPOINT,
      jwks_uri: JWKS_URI,
      ...overrides,
    };
  }

  test('accepts metadata only when every configured endpoint matches exactly', async () => {
    await verifyOidcDiscoveryMetadata(productionOidcConfig(), {
      fetchImpl: (async (input, init) => {
        assert.equal(
          input,
          `${ISSUER}/.well-known/openid-configuration`,
        );
        assert.equal(init?.signal instanceof AbortSignal, true);
        return new Response(JSON.stringify(metadata()));
      }) as typeof fetch,
    });
  });

  test('rejects discovery endpoint substitution and oversized metadata', async () => {
    await assert.rejects(
      () => verifyOidcDiscoveryMetadata(productionOidcConfig(), {
        fetchImpl: (async () => new Response(JSON.stringify(metadata({
          token_endpoint: 'https://evil.example/token',
        })))) as typeof fetch,
      }),
      /token_endpoint does not match configured value/,
    );

    await assert.rejects(
      () => verifyOidcDiscoveryMetadata(productionOidcConfig(), {
        fetchImpl: (async () => new Response(JSON.stringify(metadata({
          padding: 'x'.repeat(256),
        })))) as typeof fetch,
        maxResponseBytes: 64,
      }),
      /exceeds the size limit/,
    );
  });

  test('does not fetch discovery for the in-process test provider', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
    }).oidc;
    await verifyOidcDiscoveryMetadata(config, {
      fetchImpl: (async () => {
        throw new Error('test provider must not fetch discovery');
      }) as typeof fetch,
    });
  });
});

describe('production config requires coherent OIDC JWKS', () => {
  const prodBase = {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.example.test',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_ALLOW_TEST_PROVIDER: 'false',
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
    PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
    PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
    PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
    ...PROD_PUBLICATION_CONFIG,
    ...PROD_OIDC_TX_SECRETS,
  } as const;

  test('loadConfig fails closed in production without OIDC_JWKS_URI', () => {
    assert.throws(
      () => loadConfig({
        ...prodBase,
        OIDC_JWKS_URI: undefined,
      }),
      /OIDC_JWKS_URI is required/,
    );
  });

  test('loadConfig fails when test provider is disabled without JWKS even outside production', () => {
    assert.throws(
      () => loadConfig({
        DATABASE_URL: 'postgres://localhost/known',
        NODE_ENV: 'development',
        OIDC_ALLOW_TEST_PROVIDER: 'false',
      }),
      /OIDC_JWKS_URI is required/,
    );
  });

  test('loadConfig accepts production with JWKS and test provider disabled', () => {
    const config = loadConfig({
      ...prodBase,
      OIDC_JWKS_URI: JWKS_URI,
    });
    assert.equal(config.oidc.jwksUri, JWKS_URI);
    assert.equal(config.oidc.allowTestProvider, false);
    assert.ok(config.oidcTransactionSecrets.encryptionKeys.length >= 1);
  });

  test('loadConfig rejects malformed JWKS URI', () => {
    assert.throws(
      () => loadConfig({
        DATABASE_URL: 'postgres://localhost/known',
        OIDC_JWKS_URI: 'not-a-url',
        OIDC_ALLOW_TEST_PROVIDER: 'true',
        OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
        NODE_ENV: 'test',
      }),
      /OIDC_JWKS_URI must be a valid absolute URL/,
    );
  });
});

describe('test OIDC provider enablement fails closed', () => {
  const devBase = {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'development',
    PRODUCT_ORIGIN: 'https://app.example.test',
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: TOKEN_ENDPOINT,
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
    PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
    PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
    PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
    ...PROD_PUBLICATION_CONFIG,
    ...PROD_OIDC_TX_SECRETS,
  } as const;

  test('defaults to disabled outside test so development/staging need real JWKS', () => {
    const config = loadConfig({
      ...devBase,
      OIDC_JWKS_URI: JWKS_URI,
    });
    assert.equal(config.oidc.allowTestProvider, false);
    assert.equal(config.oidc.testProviderHmacSecret, '');
    // Without JWKS the disabled test provider must fail closed instead of
    // silently falling back to the forger-friendly in-process double.
    assert.throws(
      () => loadConfig(devBase),
      /OIDC_JWKS_URI is required when OIDC_ALLOW_TEST_PROVIDER is not enabled/,
    );
  });

  test('explicit enablement outside NODE_ENV=test is refused even with a secret', () => {
    assert.throws(
      () => loadConfig({
        ...devBase,
        OIDC_ALLOW_TEST_PROVIDER: 'true',
        OIDC_TEST_PROVIDER_HMAC_SECRET: 'explicit-secret-for-non-test',
      }),
      /OIDC_ALLOW_TEST_PROVIDER requires NODE_ENV=test/,
    );
  });

  test('NODE_ENV=test without an explicit HMAC secret is refused', () => {
    assert.throws(
      () => loadConfig({
        ...devBase,
        NODE_ENV: 'test',
        OIDC_ALLOW_TEST_PROVIDER: 'true',
      }),
      /OIDC_TEST_PROVIDER_HMAC_SECRET is required when OIDC_ALLOW_TEST_PROVIDER=true/,
    );
  });

  test('NODE_ENV=test accepts only with allow flag and explicit non-empty secret', () => {
    const config = loadConfig({
      ...devBase,
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    });
    assert.equal(config.oidc.allowTestProvider, true);
    assert.equal(config.oidc.testProviderHmacSecret, 'test-oidc-provider-hmac-secret-not-prod-default');
  });
});

describe('OIDC client auth mode (FIX-L-001)', () => {
  test('defaults to public client (none) and accepts an empty secret only', () => {
    // Public client + PKCE stays a legal deployment form without any secret.
    const config = productionOidcConfig();
    assert.equal(config.clientAuthMode, 'none');
    assert.equal(config.clientSecret, '');
    const explicit = productionOidcConfig({ OIDC_CLIENT_AUTH_MODE: 'none' });
    assert.equal(explicit.clientAuthMode, 'none');
    assert.equal(explicit.clientSecret, '');
  });

  test('accepts confidential client (client_secret_post) only with a non-empty secret', () => {
    const config = productionOidcConfig({
      OIDC_CLIENT_AUTH_MODE: 'client_secret_post',
      OIDC_CLIENT_SECRET: 'confidential-client-secret',
    });
    assert.equal(config.clientAuthMode, 'client_secret_post');
    assert.equal(config.clientSecret, 'confidential-client-secret');
  });

  test('rejects every mode/secret conflict at startup', () => {
    // none + secret: a stray secret must not silently flip the client to confidential.
    assert.throws(
      () => productionOidcConfig({ OIDC_CLIENT_SECRET: 'stray-secret' }),
      /OIDC_CLIENT_AUTH_MODE=none requires OIDC_CLIENT_SECRET to be empty/,
    );
    assert.throws(
      () => productionOidcConfig({
        OIDC_CLIENT_AUTH_MODE: 'none',
        OIDC_CLIENT_SECRET: 'stray-secret',
      }),
      /OIDC_CLIENT_AUTH_MODE=none requires OIDC_CLIENT_SECRET to be empty/,
    );
    // client_secret_post + empty secret: must fail now, not at the callback.
    assert.throws(
      () => productionOidcConfig({ OIDC_CLIENT_AUTH_MODE: 'client_secret_post' }),
      /OIDC_CLIENT_AUTH_MODE=client_secret_post requires a non-empty OIDC_CLIENT_SECRET/,
    );
  });

  test('rejects unknown auth mode values', () => {
    assert.throws(
      () => productionOidcConfig({ OIDC_CLIENT_AUTH_MODE: 'client_secret_basic' }),
      /OIDC_CLIENT_AUTH_MODE must be one of: none, client_secret_post/,
    );
  });

  test('sends client_secret in the token request only for client_secret_post', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims());

    let confidentialBody: URLSearchParams | null = null;
    const confidential = createOidcProvider(productionOidcConfig({
      OIDC_CLIENT_AUTH_MODE: 'client_secret_post',
      OIDC_CLIENT_SECRET: 'confidential-client-secret',
    }), {
      fetchImpl: capturingTokenEndpointFetch(token, (body) => { confidentialBody = body; }),
      jwks: staticJwks(key),
      now: () => FIXED_NOW,
    });
    await confidential.exchangeAuthorizationCode({
      code: 'auth-code-1',
      codeVerifier: 'pkce-verifier',
      expectedNonce: 'nonce-1',
    });
    assert.equal(confidentialBody?.get('client_secret'), 'confidential-client-secret');
    assert.equal(confidentialBody?.get('client_id'), CLIENT_ID);

    let publicBody: URLSearchParams | null = null;
    const publicClient = createOidcProvider(productionOidcConfig({
      OIDC_CLIENT_AUTH_MODE: 'none',
    }), {
      fetchImpl: capturingTokenEndpointFetch(token, (body) => { publicBody = body; }),
      jwks: staticJwks(key),
      now: () => FIXED_NOW,
    });
    await publicClient.exchangeAuthorizationCode({
      code: 'auth-code-1',
      codeVerifier: 'pkce-verifier',
      expectedNonce: 'nonce-1',
    });
    assert.equal(publicBody?.get('client_secret'), null);
    assert.equal(publicBody?.get('client_id'), CLIENT_ID);
  });

  test('provider construction refuses mode/secret conflicts too', () => {
    assert.throws(
      () => createOidcProvider({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: 'stray-secret', // secret-scan: allow 'stray-secret' -- synthetic conflict-fixture literal, not a real credential
        clientAuthMode: 'none',
        redirectUri: 'https://app.example.test/api/v1/auth/oidc/callback',
        audience: AUDIENCE,
        authorizationEndpoint: 'https://issuer.example/auth',
        tokenEndpoint: TOKEN_ENDPOINT,
        jwksUri: JWKS_URI,
        allowTestProvider: false,
        testProviderHmacSecret: '',
      }),
      /client auth mode none forbids a client secret/,
    );
    assert.throws(
      () => createOidcProvider({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: '',
        clientAuthMode: 'client_secret_post',
        redirectUri: 'https://app.example.test/api/v1/auth/oidc/callback',
        audience: AUDIENCE,
        authorizationEndpoint: 'https://issuer.example/auth',
        tokenEndpoint: TOKEN_ENDPOINT,
        jwksUri: JWKS_URI,
        allowTestProvider: false,
        testProviderHmacSecret: '',
      }),
      /client auth mode client_secret_post requires a non-empty client secret/,
    );
  });

  test('startup capacity snapshot records the mode but never the secret', () => {
    const appConfig = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      PRODUCT_ORIGIN: 'https://app.example.test',
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: TOKEN_ENDPOINT,
      OIDC_JWKS_URI: JWKS_URI,
      OIDC_CLIENT_AUTH_MODE: 'client_secret_post',
      OIDC_CLIENT_SECRET: 'confidential-client-secret',
      OIDC_ALLOW_TEST_PROVIDER: 'false',
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
      PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
      PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
      PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
      PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
      PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
      PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
      PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
      PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
      PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
      PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
      PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
      COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
      PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
      ...PROD_PUBLICATION_CONFIG,
      ...PROD_OIDC_TX_SECRETS,
    });
    const capacity = sanitizedRuntimeCapacity(appConfig);
    assert.equal(capacity.oidcClientAuthMode, 'client_secret_post');
    assert.doesNotMatch(JSON.stringify(capacity), /confidential-client-secret/);
  });
});

describe('createOidcProvider does not use token-supplied discovery endpoints', () => {
  test('verifier uses only config-backed JWKS provider', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({
      // Malicious claims sometimes used by confused-deputy clients — must be ignored.
      jwks_uri: 'https://evil.example/jwks',
      iss: ISSUER,
    }));
    let jwksCalls = 0;
    const jwks: JwksProvider = {
      async getKeySet() {
        jwksCalls += 1;
        return { keys: [key.publicJwk] };
      },
    };
    const fetchImpl = tokenEndpointFetch(token);
    const provider = createOidcProvider(productionOidcConfig(), {
      fetchImpl,
      jwks,
      now: () => FIXED_NOW,
    });
    await provider.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      expectedNonce: 'nonce-1',
    });
    assert.ok(jwksCalls >= 1);
  });

  test('injected verifier is used rather than any decode path', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims());
    let verified = false;
    const idTokenVerifier = createIdTokenVerifier({ jwks: staticJwks(key) });
    const wrapped: typeof idTokenVerifier = {
      async verify(input) {
        verified = true;
        return idTokenVerifier.verify(input);
      },
    };
    const provider = createOidcProvider(productionOidcConfig(), {
      fetchImpl: tokenEndpointFetch(token),
      idTokenVerifier: wrapped,
      now: () => FIXED_NOW,
    });
    const result = await provider.exchangeAuthorizationCode({
      code: 'c1',
      codeVerifier: 'v1',
      expectedNonce: 'nonce-1',
    });
    assert.equal(verified, true);
    assert.equal(result.claims.subject, 'subject-1');
  });
});

describe('source invariant: no production decode-only JWT path', () => {
  test('oidc-provider source does not contain decodeUnverifiedJwtPayload', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../src/transport/auth/oidc-provider.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /decodeUnverifiedJwtPayload/);
    // Production JWT path must go through createIdTokenVerifier / IdTokenVerificationError.
    assert.match(source, /createIdTokenVerifier/);
    assert.match(source, /IdTokenVerificationError/);
  });

  test('oidc-provider source carries no usable default test HMAC secret', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../src/transport/auth/oidc-provider.ts'),
      'utf8',
    );
    // No public default secret and no optional/defaulted hmacSecret parameters:
    // the test provider secret must always be injected explicitly.
    assert.doesNotMatch(source, /known-oidc-test-secret/);
    assert.doesNotMatch(source, /hmacSecret\s*=\s*['"]/);
    assert.doesNotMatch(source, /hmacSecret\?/);
  });

  test('oidc-provider defaults to hardened egress fetch and does not follow redirects itself', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../src/transport/auth/oidc-provider.ts'),
      'utf8',
    );
    assert.match(source, /createHardenedEgressFetch\(\{\s*label:\s*'legacy OIDC'\s*\}\)/);
    const deadline = source.match(/async function fetchWithDeadline[\s\S]*?\n\}/);
    assert.ok(deadline);
    assert.doesNotMatch(deadline[0], /redirect/);
    assert.doesNotMatch(deadline[0], /location/i);
  });
});
