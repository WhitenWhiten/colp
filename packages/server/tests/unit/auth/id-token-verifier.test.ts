import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JSONWebKeySet,
  type JWK,
  type KeyLike,
} from 'jose';
import {
  ALLOWED_ID_TOKEN_ALGORITHMS,
  IdTokenVerificationError,
  createIdTokenVerifier,
  type IdTokenVerificationFailureReason,
  type IdTokenVerifier,
  type JwksProvider,
} from '../../../src/modules/identity/index.js';
import { createCachingJwksClient } from '../../../src/infrastructure/identity/index.js';

const ISSUER = 'https://issuer.example.test/';
const CLIENT_ID = 'known-client';
const AUDIENCE = CLIENT_ID;
const NONCE = 'nonce-abc-123';
const SUBJECT = 'subject-1';

const FIXED_NOW = new Date('2026-07-22T12:00:00.000Z');
const NOW_SEC = Math.floor(FIXED_NOW.getTime() / 1000);

interface TestKeyMaterial {
  readonly privateKey: KeyLike;
  readonly publicJwk: JWK;
  readonly kid: string;
  readonly alg: 'RS256' | 'ES256';
}

async function mintRsaKey(kid = 'rsa-1'): Promise<TestKeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  return { privateKey, publicJwk, kid, alg: 'RS256' };
}

async function mintEcKey(kid = 'ec-1'): Promise<TestKeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';
  return { privateKey, publicJwk, kid, alg: 'ES256' };
}

function jwksOf(...keys: JWK[]): JSONWebKeySet {
  return { keys };
}

function staticJwksProvider(
  document: JSONWebKeySet,
  options: {
    onGet?: (forceRefresh: boolean) => void;
    failTimes?: number;
    failReason?: IdTokenVerificationFailureReason;
  } = {},
): JwksProvider {
  let failuresLeft = options.failTimes ?? 0;
  return {
    async getKeySet(getOptions = {}) {
      options.onGet?.(getOptions.forceRefresh === true);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new IdTokenVerificationError(
          options.failReason ?? 'jwks_fetch_failed',
          'injected JWKS failure',
        );
      }
      return document;
    },
  };
}

function mutableJwksProvider(initial: JSONWebKeySet): JwksProvider & {
  setDocument(document: JSONWebKeySet): void;
  calls: { forceRefresh: boolean }[];
} {
  let document = initial;
  const calls: { forceRefresh: boolean }[] = [];
  return {
    calls,
    setDocument(next) {
      document = next;
    },
    async getKeySet(getOptions = {}) {
      calls.push({ forceRefresh: getOptions.forceRefresh === true });
      return document;
    },
  };
}

async function signIdToken(
  key: TestKeyMaterial,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const builder = new SignJWT(claims as never)
    .setProtectedHeader({
      alg: key.alg,
      kid: key.kid,
      typ: 'JWT',
      ...header,
    });
  return builder.sign(key.privateKey);
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: SUBJECT,
    aud: AUDIENCE,
    nonce: NONCE,
    email: 'user@example.test',
    email_verified: true,
    name: 'Test User',
    picture: 'https://cdn.example/user.png',
    iat: NOW_SEC - 60,
    exp: NOW_SEC + 3_600,
    ...overrides,
  };
}

function verifierFor(jwks: JwksProvider, overrides: Parameters<typeof createIdTokenVerifier>[0] = { jwks }): IdTokenVerifier {
  return createIdTokenVerifier({
    clockToleranceSeconds: 60,
    maxIatAgeSeconds: 86_400,
    ...overrides,
    jwks,
  });
}

async function expectFailure(
  run: () => Promise<unknown>,
  reason: IdTokenVerificationFailureReason,
): Promise<void> {
  try {
    await run();
    assert.fail(`expected IdTokenVerificationError with reason ${reason}`);
  } catch (error: unknown) {
    assert.ok(
      error instanceof IdTokenVerificationError,
      `expected IdTokenVerificationError, got ${String(error)}`,
    );
    assert.equal(error.reason, reason);
  }
}

describe('id-token-verifier allowlist', () => {
  test('documents asymmetric algorithms only', () => {
    assert.deepEqual([...ALLOWED_ID_TOKEN_ALGORITHMS], ['RS256', 'ES256', 'PS256', 'ES384']);
  });
});

describe('id-token-verifier: valid tokens', () => {
  test('accepts a valid RS256 ID token and returns claims', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims());
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    const claims = await verifier.verify({
      token,
      expectedIssuer: ISSUER,
      expectedAudience: AUDIENCE,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
      now: FIXED_NOW,
    });

    assert.equal(claims.issuer, ISSUER);
    assert.equal(claims.subject, SUBJECT);
    assert.equal(claims.audience, AUDIENCE);
    assert.equal(claims.nonce, NONCE);
    assert.equal(claims.email, 'user@example.test');
    assert.equal(claims.emailVerified, true);
    assert.equal(claims.name, 'Test User');
    assert.equal(claims.picture, 'https://cdn.example/user.png');
    assert.equal(claims.exp, NOW_SEC + 3_600);
    assert.equal(claims.iat, NOW_SEC - 60);
  });

  test('accepts a valid ES256 ID token', async () => {
    const key = await mintEcKey();
    const token = await signIdToken(key, baseClaims());
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    const claims = await verifier.verify({
      token,
      expectedIssuer: ISSUER,
      expectedAudience: AUDIENCE,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
      now: FIXED_NOW,
    });
    assert.equal(claims.subject, SUBJECT);
  });

  test('accepts audience as array containing the expected client', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({
      aud: [CLIENT_ID, 'other-resource'],
      azp: CLIENT_ID,
    }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    const claims = await verifier.verify({
      token,
      expectedIssuer: ISSUER,
      expectedAudience: CLIENT_ID,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
      now: FIXED_NOW,
    });
    assert.deepEqual(claims.audience, [CLIENT_ID, 'other-resource']);
    assert.equal(claims.azp, CLIENT_ID);
  });
});

describe('id-token-verifier: negative cases fail closed', () => {
  test('rejects bad signature', async () => {
    const signer = await mintRsaKey('signer');
    const other = await mintRsaKey('other');
    const token = await signIdToken(signer, baseClaims());
    // Publish a different key under the same kid so signature check fails.
    const forgedJwk = { ...other.publicJwk, kid: signer.kid };
    const verifier = verifierFor(staticJwksProvider(jwksOf(forgedJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'invalid_signature',
    );
  });

  test('rejects unknown kid after cache refresh', async () => {
    const key = await mintRsaKey('present');
    const token = await signIdToken(key, baseClaims());
    // JWKS never contains the signing key.
    const missing = await mintRsaKey('other-kid');
    const provider = mutableJwksProvider(jwksOf(missing.publicJwk));
    const verifier = verifierFor(provider);

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'unknown_kid',
    );
    assert.equal(provider.calls.length, 2);
    assert.equal(provider.calls[0]?.forceRefresh, false);
    assert.equal(provider.calls[1]?.forceRefresh, true);
  });

  test('recovers from key rotation when kid is unknown until refresh', async () => {
    const oldKey = await mintRsaKey('old');
    const newKey = await mintRsaKey('new');
    const token = await signIdToken(newKey, baseClaims());

    // First get returns old keys; force refresh returns rotated set including new key.
    let call = 0;
    const rotating: JwksProvider = {
      async getKeySet(getOptions = {}) {
        call += 1;
        if (getOptions.forceRefresh) return jwksOf(oldKey.publicJwk, newKey.publicJwk);
        return jwksOf(oldKey.publicJwk);
      },
    };
    const verifier = verifierFor(rotating);
    const claims = await verifier.verify({
      token,
      expectedIssuer: ISSUER,
      expectedAudience: AUDIENCE,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
      now: FIXED_NOW,
    });
    assert.equal(claims.subject, SUBJECT);
    assert.equal(call, 2);
  });

  test('rejects wrong issuer', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({ iss: 'https://evil.example/' }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'wrong_issuer',
    );
  });

  test('rejects wrong audience', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({ aud: 'other-client' }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'wrong_audience',
    );
  });

  test('rejects a configured resource audience when aud omits this client_id', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({ aud: 'resource-api' }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: 'resource-api',
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'wrong_audience',
    );
  });

  test('rejects multi-audience token without matching azp', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({
      aud: [CLIENT_ID, 'resource-api'],
      azp: 'someone-else',
    }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: CLIENT_ID,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'wrong_azp',
    );
  });

  test('rejects multi-audience token missing azp', async () => {
    const key = await mintRsaKey();
    const claims = baseClaims({ aud: [CLIENT_ID, 'resource-api'] });
    delete claims.azp;
    const token = await signIdToken(key, claims);
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: CLIENT_ID,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'wrong_azp',
    );
  });

  test('rejects wrong nonce', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({ nonce: 'different-nonce' }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'wrong_nonce',
    );
  });

  test('rejects expired token', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({
      iat: NOW_SEC - 7_200,
      exp: NOW_SEC - 60,
    }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'expired',
    );
  });

  test('rejects not-yet-valid token (nbf in the future)', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({
      nbf: NOW_SEC + 600,
    }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'not_yet_valid',
    );
  });

  test('rejects iat unreasonably far in the future', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({
      iat: NOW_SEC + 3_600,
      exp: NOW_SEC + 7_200,
    }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'invalid_iat',
    );
  });

  test('rejects empty subject', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims({ sub: '   ' }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'missing_subject',
    );
  });

  test('rejects disallowed algorithm alg=none (unsigned)', async () => {
    // Manually craft an unsigned JWT with alg=none.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
    const payload = Buffer.from(JSON.stringify(baseClaims()), 'utf8').toString('base64url');
    const token = `${header}.${payload}.`;
    const key = await mintRsaKey();
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'disallowed_algorithm',
    );
  });

  test('rejects HS256 even when a symmetric key is presented in JWKS', async () => {
    const secret = new TextEncoder().encode('super-secret-attacker-controlled');
    const token = await new SignJWT(baseClaims() as never)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'hs' })
      .sign(secret);

    // Even if a malicious JWKS entry looked symmetric, allowlist blocks HS256 first.
    const jwk = await exportJWK(await importJWK({
      kty: 'oct',
      k: Buffer.from('super-secret-attacker-controlled').toString('base64url'),
      kid: 'hs',
      alg: 'HS256',
    }));
    const verifier = verifierFor(staticJwksProvider(jwksOf(jwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'disallowed_algorithm',
    );
  });

  test('rejects malformed compact JWT without returning claims', async () => {
    const key = await mintRsaKey();
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token: 'not-a-jwt',
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        now: FIXED_NOW,
      }),
      'invalid_token',
    );
  });

  test('never succeeds via decode-only: unsigned payload-looking token is rejected', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'x', typ: 'JWT' }), 'utf8').toString('base64url');
    const payload = Buffer.from(JSON.stringify(baseClaims()), 'utf8').toString('base64url');
    const token = `${header}.${payload}.not-a-real-signature`;
    const key = await mintRsaKey('x');
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk)));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'invalid_signature',
    );
  });
});

describe('caching JWKS client', () => {
  test('serves cached JWKS within max-age and refetches after expiry', async () => {
    const key = await mintRsaKey();
    const document = jwksOf(key.publicJwk);
    let now = 1_000_000;
    let fetches = 0;

    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = createCachingJwksClient({
      jwksUri: 'https://issuer.example.test/jwks',
      fetchImpl,
      cacheMaxAgeMs: 1_000,
      fetchTimeoutMs: 1_000,
      now: () => now,
    });

    const first = await client.getKeySet();
    const second = await client.getKeySet();
    assert.deepEqual(first, document);
    assert.deepEqual(second, document);
    assert.equal(fetches, 1);

    now += 1_001;
    const third = await client.getKeySet();
    assert.deepEqual(third, document);
    assert.equal(fetches, 2);
  });

  test('forceRefresh bypasses cache', async () => {
    const key = await mintRsaKey();
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify(jwksOf(key.publicJwk)), { status: 200 });
    };
    const client = createCachingJwksClient({
      jwksUri: 'https://issuer.example.test/jwks',
      fetchImpl,
      cacheMaxAgeMs: 60_000,
      now: () => 0,
    });

    await client.getKeySet();
    await client.getKeySet({ forceRefresh: true });
    assert.equal(fetches, 2);
  });

  test('maps abort/timeout to jwks_timeout', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    };

    const client = createCachingJwksClient({
      jwksUri: 'https://issuer.example.test/jwks',
      fetchImpl,
      fetchTimeoutMs: 20,
      cacheMaxAgeMs: 60_000,
    });

    await expectFailure(() => client.getKeySet(), 'jwks_timeout');
  });

  test('maps malformed JWKS JSON body to jwks_malformed', async () => {
    const fetchImpl: typeof fetch = async () => new Response('{"not":"jwks"}', { status: 200 });
    const client = createCachingJwksClient({
      jwksUri: 'https://issuer.example.test/jwks',
      fetchImpl,
    });
    await expectFailure(() => client.getKeySet(), 'jwks_malformed');
  });

  test('maps non-JSON body to jwks_malformed', async () => {
    const fetchImpl: typeof fetch = async () => new Response('not-json', { status: 200 });
    const client = createCachingJwksClient({
      jwksUri: 'https://issuer.example.test/jwks',
      fetchImpl,
    });
    await expectFailure(() => client.getKeySet(), 'jwks_malformed');
  });

  test('rejects a JWKS response that exceeds the configured byte limit', async () => {
    const fetchImpl: typeof fetch = async () => new Response('{"keys":[]}' + ' '.repeat(100), { status: 200 });
    const client = createCachingJwksClient({
      jwksUri: 'https://issuer.example.test/jwks',
      fetchImpl,
      maxResponseBytes: 32,
    });
    await expectFailure(() => client.getKeySet(), 'jwks_malformed');
  });

  test('maps HTTP errors to jwks_fetch_failed', async () => {
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 503 });
    const client = createCachingJwksClient({
      jwksUri: 'https://issuer.example.test/jwks',
      fetchImpl,
    });
    await expectFailure(() => client.getKeySet(), 'jwks_fetch_failed');
  });

  test('verifier propagates jwks_timeout without returning claims', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims());
    const verifier = verifierFor(staticJwksProvider(jwksOf(key.publicJwk), {
      failTimes: 1,
      failReason: 'jwks_timeout',
    }));

    await expectFailure(
      () => verifier.verify({
        token,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
        now: FIXED_NOW,
      }),
      'jwks_timeout',
    );
  });

  test('maps malformed JWKS documents from JwksProvider through assertJwksShape to jwks_malformed', async () => {
    const key = await mintRsaKey();
    const token = await signIdToken(key, baseClaims());
    const verifyOptions = {
      token,
      expectedIssuer: ISSUER,
      expectedAudience: AUDIENCE,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
      now: FIXED_NOW,
    };
    for (const document of [{}, { keys: null }, { keys: {} }] as const) {
      const verifier = verifierFor(staticJwksProvider(document as unknown as JSONWebKeySet));
      await expectFailure(() => verifier.verify(verifyOptions), 'jwks_malformed');
    }
  });
});
