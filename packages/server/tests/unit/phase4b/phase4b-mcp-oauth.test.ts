import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type KeyLike,
} from 'jose';
import {
  MCP_OAUTH_DEFAULT_SECURITY_EPOCH,
  createInMemoryMcpOauthRevocationStore,
  createMcpOauthVerifier,
  isMcpOauthVerificationResult,
  McpOauthVerificationError,
  parseSingleMcpOauthBearerAuthorization,
  redactMcpOauthLogContext,
  type McpOauthRevocationStore,
  type McpOauthVerificationFailureReason,
  type McpOauthVerifierOptions,
} from '../../../src/modules/mcp/index.js';
import {
  IdTokenVerificationError,
  type JwksProvider,
} from '../../../src/modules/identity/index.js';
import { createCachingJwksClient } from '../../../src/infrastructure/identity/jwks-client.js';
import {
  classifyEgressAddress,
  createHardenedEgressFetch,
  createPinnedLookup,
  HardenedEgressError,
  planHardenedEgressTarget,
  type HardenedEgressConnector,
  type HardenedEgressResolver,
} from '../../../src/infrastructure/egress/index.js';

const NOW = new Date('2026-08-05T08:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUER = 'https://issuer.example.test/realms/known';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const CLIENT_ID = 'known-mcp-oauth-client';
const SCOPES = ['mcp:read:public', 'mcp:read:own'];
const SUBJECT = 'urn:known:subject:alice';
const ACCOUNT_ID = 'account-alice-1';
const JTI = 'credential-jti-1';

async function expectReason(
  run: () => unknown | Promise<unknown>,
  reason: McpOauthVerificationFailureReason,
): Promise<void> {
  await assert.rejects(async () => run(), (error: unknown) => {
    assert.ok(error instanceof McpOauthVerificationError);
    assert.equal(error.reason, reason);
    return true;
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

async function createKeyFixture(kid: string): Promise<{
  readonly kid: string;
  readonly privateKey: KeyLike;
  readonly jwk: Record<string, unknown>;
}> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid, alg: 'RS256', use: 'sig' });
  return { kid, privateKey: pair.privateKey, jwk };
}

function staticJwksProvider(keys: readonly Record<string, unknown>[]): JwksProvider {
  return {
    async getKeySet(): Promise<JSONWebKeySet> {
      return { keys: [...keys] } as JSONWebKeySet;
    },
  };
}

async function mintCredential(input: {
  readonly key: KeyLike | Uint8Array;
  readonly kid: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly clientId?: string;
  readonly subject?: string;
  readonly scope?: string;
  readonly expOffsetSeconds?: number;
  readonly nbfOffsetSeconds?: number;
  readonly issuedAtSeconds?: number;
  readonly jti?: string;
  readonly alg?: string;
  readonly claims?: Record<string, unknown>;
}): Promise<string> {
  const builder = new SignJWT({
    scope: input.scope ?? SCOPES.join(' '),
    client_id: input.clientId ?? CLIENT_ID,
    ...(input.claims ?? {}),
  })
    .setProtectedHeader({ alg: input.alg ?? 'RS256', kid: input.kid })
    .setIssuer(input.issuer ?? ISSUER)
    .setSubject(input.subject ?? SUBJECT)
    .setAudience(input.audience ?? AUDIENCE)
    .setIssuedAt(input.issuedAtSeconds ?? NOW_SECONDS - 5)
    .setExpirationTime(NOW_SECONDS + (input.expOffsetSeconds ?? 3_600))
    .setJti(input.jti ?? JTI);
  if (input.nbfOffsetSeconds !== undefined) {
    builder.setNotBefore(NOW_SECONDS + input.nbfOffsetSeconds);
  }
  return builder.sign(input.key);
}

function makeOptions(overrides: Partial<McpOauthVerifierOptions> = {}): McpOauthVerifierOptions {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    allowedScopes: SCOPES,
    jwks: staticJwksProvider([]),
    isRevoked: async () => false,
    securityEpoch: async () => 'epoch-1',
    now: () => NOW,
    clockToleranceSeconds: 0,
    resolveAccountBySubject: async (sub) => (
      sub === SUBJECT
        ? { id: ACCOUNT_ID, subjectId: SUBJECT, status: 'active' }
        : null
    ),
    ...overrides,
  };
}

test('verifies a real signed Bearer credential and emits frozen COLP OAuth evidence and binding', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));

  const result = await verifier.verify({ authorization: `Bearer ${token}` });
  assert.equal(isMcpOauthVerificationResult(result), true);
  assert.equal(isMcpOauthVerificationResult({ ...result }), false, 'the trusted result brand must not survive spread/serialization');

  assert.equal(result.evidence.credentialKind, 'oauth');
  assert.equal(result.evidence.principalId, ACCOUNT_ID);
  assert.equal(result.accountSubjectId, SUBJECT);
  assert.equal(result.evidence.clientId, CLIENT_ID);
  assert.equal(result.evidence.resourceAudience, AUDIENCE);
  assert.equal(result.evidence.securityEpoch, 'epoch-1');
  assert.equal(result.evidence.credentialBindingId, sha256(`oauth\0${ISSUER}\0${JTI}`));

  assert.equal(result.binding.kind, 'authenticated');
  assert.equal(result.binding.principalId, result.evidence.principalId);
  assert.equal(result.binding.clientId, result.evidence.clientId);
  assert.equal(result.binding.credentialBindingId, result.evidence.credentialBindingId);
  assert.equal(result.binding.resourceAudience, result.evidence.resourceAudience);
  assert.equal(result.binding.securityEpoch, result.evidence.securityEpoch);
  assert.equal(result.credentialDigest, sha256(token));
  assert.match(result.credentialDigest, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(result.verifiedAt.getTime(), NOW.getTime());
  assert.equal(result.expiresAt.getTime(), NOW.getTime() + 3_600_000);

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.equal(Object.isFrozen(result.binding), true);
  assert.deepEqual(Object.keys(result.evidence), [
    'credentialKind',
    'principalId',
    'clientId',
    'credentialBindingId',
    'resourceAudience',
    'securityEpoch',
  ]);
  assert.deepEqual(Object.keys(result.binding), [
    'kind',
    'principalId',
    'clientId',
    'credentialBindingId',
    'resourceAudience',
    'securityEpoch',
  ]);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false, 'raw credential must not enter the result or later objects');
  assert.equal(serialized.includes('authorization'), false);
  assert.equal(serialized.includes('accessToken'), false);
});

test('verifies the same valid credential repeatedly with stable token-free binding', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));

  const first = await verifier.verify({ authorization: `Bearer ${token}` });
  const second = await verifier.verify({ authorization: `Bearer ${token}` });

  assert.equal(second.credentialDigest, first.credentialDigest);
  assert.deepEqual(second.evidence, first.evidence);
  assert.deepEqual(second.binding, first.binding);
  assert.equal(JSON.stringify(second).includes(token), false);
});

test('requires exactly one Authorization field and one Bearer credential', async () => {
  assert.equal(parseSingleMcpOauthBearerAuthorization('Bearer opaque-token'), 'opaque-token');
  assert.throws(
    () => parseSingleMcpOauthBearerAuthorization(undefined),
    (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'invalid_authorization_header',
  );
  assert.throws(
    () => parseSingleMcpOauthBearerAuthorization(['Bearer one', 'Bearer two']),
    (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'invalid_authorization_header',
  );
  assert.throws(
    () => parseSingleMcpOauthBearerAuthorization('Bearer one, Bearer two'),
    (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'invalid_authorization_header',
  );
  assert.throws(
    () => parseSingleMcpOauthBearerAuthorization('Basic abc'),
    (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'invalid_authorization_header',
  );

  const key = await createKeyFixture('key-1');
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));
  await expectReason(
    () => verifier.verify({ authorization: ['Bearer one', 'Bearer two'] }),
    'invalid_authorization_header',
  );
  await expectReason(
    () => verifier.verify({ authorization: 'Bearer one, Bearer two' }),
    'invalid_authorization_header',
  );
});

test('rejects disallowed algorithms before using JWKS', async () => {
  const key = await createKeyFixture('key-1');
  let jwksCalls = 0;
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: {
      async getKeySet(): Promise<JSONWebKeySet> {
        jwksCalls += 1;
        return { keys: [key.jwk] } as JSONWebKeySet;
      },
    },
  }));
  const token = await mintCredential({
    key: new TextEncoder().encode('0123456789abcdef0123456789abcdef'),
    kid: 'symmetric',
    alg: 'HS256',
  });
  await expectReason(() => verifier.verify({ authorization: `Bearer ${token}` }), 'disallowed_algorithm');
  assert.equal(jwksCalls, 0);
});

test('rejects expired and not-yet-valid credentials', async () => {
  const key = await createKeyFixture('key-1');
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]),
    clockToleranceSeconds: 0,
  }));
  const expired = await mintCredential({ key: key.privateKey, kid: key.kid, expOffsetSeconds: -60 });
  await expectReason(() => verifier.verify({ authorization: `Bearer ${expired}` }), 'expired');

  const notYetValid = await mintCredential({ key: key.privateKey, kid: key.kid, nbfOffsetSeconds: 120 });
  await expectReason(() => verifier.verify({ authorization: `Bearer ${notYetValid}` }), 'not_yet_valid');
});

test('unknown kid forces a JWKS refresh and still fails closed when refresh cannot recover', async () => {
  const oldKey = await createKeyFixture('old');
  const newKey = await createKeyFixture('new');
  const calls: boolean[] = [];
  const rotatingJwks: JwksProvider = {
    async getKeySet(options = {}): Promise<JSONWebKeySet> {
      calls.push(options.forceRefresh === true);
      return options.forceRefresh
        ? { keys: [oldKey.jwk, newKey.jwk] } as JSONWebKeySet
        : { keys: [oldKey.jwk] } as JSONWebKeySet;
    },
  };
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: rotatingJwks }));
  const rotated = await mintCredential({ key: newKey.privateKey, kid: newKey.kid });
  const result = await verifier.verify({ authorization: `Bearer ${rotated}` });
  assert.equal(result.evidence.principalId, ACCOUNT_ID);
  assert.equal(result.accountSubjectId, SUBJECT);
  assert.deepEqual(calls, [false, true]);

  const failingJwks: JwksProvider = {
    async getKeySet(options = {}): Promise<JSONWebKeySet> {
      calls.push(options.forceRefresh === true);
      return { keys: [oldKey.jwk] } as JSONWebKeySet;
    },
  };
  const failingVerifier = createMcpOauthVerifier(makeOptions({ jwks: failingJwks }));
  await expectReason(
    () => failingVerifier.verify({ authorization: `Bearer ${rotated}` }),
    'unknown_kid',
  );
});

test('revocation is checked per request with digest-only evidence and no token passthrough', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });
  const revocationInputs: Array<Record<string, string | number>> = [];
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]),
    isRevoked: async (input) => {
      revocationInputs.push({ ...input });
      return true;
    },
  }));

  await expectReason(() => verifier.verify({ authorization: `Bearer ${token}` }), 'revoked');
  assert.equal(revocationInputs.length, 1);
  assert.equal(revocationInputs[0]?.issuer, ISSUER);
  assert.equal(revocationInputs[0]?.subject, SUBJECT);
  assert.equal(revocationInputs[0]?.clientId, CLIENT_ID);
  assert.equal(revocationInputs[0]?.tokenId, JTI);
  assert.equal(revocationInputs[0]?.credentialDigest, sha256(token));
  assert.equal(revocationInputs[0]?.issuedAtSeconds, NOW_SECONDS - 5);
  assert.equal(JSON.stringify(revocationInputs[0]).includes(token), false);
  assert.equal('token' in (revocationInputs[0] ?? {}), false);
});

test('revocation store query failures fail closed as revoked', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]),
    isRevoked: async () => {
      throw new Error('revocation store offline');
    },
  }));

  await expectReason(() => verifier.verify({ authorization: `Bearer ${token}` }), 'revoked');
});

test('security epoch read failures fail closed as revoked', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]),
    securityEpoch: async () => {
      throw new Error('epoch store offline');
    },
  }));

  await expectReason(() => verifier.verify({ authorization: `Bearer ${token}` }), 'revoked');
});

test('maps JWKS outage, timeout and malformed documents to typed fail-closed reasons', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });

  const outageVerifier = createMcpOauthVerifier(makeOptions({
    jwks: {
      async getKeySet(): Promise<JSONWebKeySet> {
        throw new IdTokenVerificationError('jwks_fetch_failed', 'network unavailable');
      },
    },
  }));
  await expectReason(() => outageVerifier.verify({ authorization: `Bearer ${token}` }), 'jwks_fetch_failed');

  const timeoutVerifier = createMcpOauthVerifier(makeOptions({
    jwks: {
      async getKeySet(): Promise<JSONWebKeySet> {
        throw new IdTokenVerificationError('jwks_timeout', 'timed out');
      },
    },
  }));
  await expectReason(() => timeoutVerifier.verify({ authorization: `Bearer ${token}` }), 'jwks_timeout');

  const malformedVerifier = createMcpOauthVerifier(makeOptions({
    jwks: {
      async getKeySet(): Promise<JSONWebKeySet> {
        return { keys: 'not-an-array' } as unknown as JSONWebKeySet;
      },
    },
  }));
  await expectReason(() => malformedVerifier.verify({ authorization: `Bearer ${token}` }), 'jwks_malformed');
});

test('works with the identity CachingJwksClient and maps its real outage/timeout errors', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });
  const jwksUri = 'https://issuer.example.test/realms/known/protocol/openid-connect/certs';

  const outageClient = createCachingJwksClient({
    jwksUri,
    fetchImpl: async () => {
      throw new Error('offline');
    },
    fetchTimeoutMs: 5_000,
  });
  const outageVerifier = createMcpOauthVerifier(makeOptions({ jwks: outageClient }));
  await expectReason(() => outageVerifier.verify({ authorization: `Bearer ${token}` }), 'jwks_fetch_failed');

  const timeoutClient = createCachingJwksClient({
    jwksUri,
    fetchTimeoutMs: 20,
    fetchImpl: async (_input, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
      throw new Error('unreachable');
    },
  });
  const timeoutVerifier = createMcpOauthVerifier(makeOptions({ jwks: timeoutClient }));
  await expectReason(() => timeoutVerifier.verify({ authorization: `Bearer ${token}` }), 'jwks_timeout');
});

// ---------------------------------------------------------------------------
// FIX-L-042: shared MCP OAuth revocation store and rotatable security epoch.
// ---------------------------------------------------------------------------

function revocationTarget(token: string): {
  readonly issuer: string;
  readonly subject: string;
  readonly clientId: string;
  readonly tokenId: string;
  readonly credentialDigest: string;
} {
  return {
    issuer: ISSUER,
    subject: SUBJECT,
    clientId: CLIENT_ID,
    tokenId: JTI,
    credentialDigest: sha256(token),
  };
}

test('in-memory revocation store matches only the revoked credential and stores one-way digests', async () => {
  const store = createInMemoryMcpOauthRevocationStore({
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  const target = revocationTarget('raw-token-a');
  assert.equal(await store.securityEpoch(), MCP_OAUTH_DEFAULT_SECURITY_EPOCH);
  assert.equal(await store.isRevoked({ ...target, issuedAtSeconds: NOW_SECONDS - 5 }), false);

  await store.revoke(target);
  assert.equal(await store.isRevoked({ ...target, issuedAtSeconds: NOW_SECONDS - 5 }), true);

  const otherSubject = await store.isRevoked({
    ...target,
    subject: 'urn:known:subject:bob',
    issuedAtSeconds: NOW_SECONDS - 5,
  });
  assert.equal(otherSubject, false, 'a different subject must not match the revoked row');
  const otherJti = await store.isRevoked({
    ...target,
    tokenId: 'credential-jti-2',
    credentialDigest: sha256('raw-token-b'),
    issuedAtSeconds: NOW_SECONDS - 5,
  });
  assert.equal(otherJti, false, 'a different jti must not match the revoked row');
});

test('epoch bump retires tokens issued before the bump and accepts tokens issued after', async () => {
  let current = new Date('2026-08-05T07:00:00.000Z');
  const store = createInMemoryMcpOauthRevocationStore({ now: () => current });
  const target = revocationTarget('raw-token-a');
  const beforeSeconds = Math.floor(new Date('2026-08-05T08:00:00.000Z').getTime() / 1_000) - 5;
  const afterSeconds = Math.floor(new Date('2026-08-05T09:00:00.000Z').getTime() / 1_000) + 120;

  assert.equal(await store.isRevoked({ ...target, issuedAtSeconds: beforeSeconds }), false);

  current = new Date('2026-08-05T09:00:00.000Z');
  const bumped = await store.bumpSecurityEpoch('epoch-bumped-2');
  assert.equal(bumped.value, 'epoch-bumped-2');
  assert.equal(bumped.effectiveAt.getTime(), current.getTime());
  assert.equal(await store.securityEpoch(), 'epoch-bumped-2');

  assert.equal(
    await store.isRevoked({ ...target, issuedAtSeconds: beforeSeconds }),
    true,
    'tokens issued before the bump must be retired',
  );
  assert.equal(
    await store.isRevoked({ ...target, issuedAtSeconds: afterSeconds }),
    false,
    'tokens issued after the bump must be accepted',
  );

  await assert.rejects(
    () => store.bumpSecurityEpoch('  '),
    (error: unknown) => error instanceof TypeError,
  );
});

test('an incident bump does not lower the floor and same-second iat is not revoked', async () => {
  let current = new Date('2026-08-05T09:00:00.000Z');
  const store = createInMemoryMcpOauthRevocationStore({ now: () => current });
  const target = revocationTarget('raw-token-floor');
  const floor = Math.floor(current.getTime() / 1_000);
  assert.equal(await store.isRevoked({ ...target, issuedAtSeconds: floor }), false);
  assert.equal(await store.isRevoked({ ...target, issuedAtSeconds: floor - 1 }), true);
  current = new Date('2026-08-05T08:00:00.000Z');
  const bumped = await store.bumpSecurityEpoch('incident-name');
  assert.equal(bumped.value, 'incident-name');
  assert.equal(bumped.effectiveAt.toISOString(), '2026-08-05T09:00:00.000Z');
  assert.equal(await store.isRevoked({ ...target, issuedAtSeconds: floor - 1 }), true);
  assert.equal(await store.isRevoked({ ...target, issuedAtSeconds: floor }), false);
});

test('a revoked signed token fails immediately and an epoch bump retires old tokens while new tokens succeed', async () => {
  const key = await createKeyFixture('key-1');
  let current = new Date('2026-08-05T07:00:00.000Z');
  const store: McpOauthRevocationStore = createInMemoryMcpOauthRevocationStore({ now: () => current });
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]),
    isRevoked: (input) => store.isRevoked(input),
    securityEpoch: () => store.securityEpoch(),
  }));

  const token = await mintCredential({ key: key.privateKey, kid: key.kid, jti: 'jti-revoked-1' });
  const first = await verifier.verify({ authorization: `Bearer ${token}` });
  assert.equal(first.evidence.securityEpoch, MCP_OAUTH_DEFAULT_SECURITY_EPOCH);

  await store.revoke({
    issuer: ISSUER,
    subject: SUBJECT,
    clientId: CLIENT_ID,
    tokenId: 'jti-revoked-1',
    credentialDigest: sha256(token),
  });
  await expectReason(() => verifier.verify({ authorization: `Bearer ${token}` }), 'revoked');

  const oldToken = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    jti: 'jti-old-epoch',
    issuedAtSeconds: NOW_SECONDS - 300,
  });
  const newToken = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    jti: 'jti-new-epoch',
    issuedAtSeconds: NOW_SECONDS + 120,
  });

  current = new Date('2026-08-05T08:00:00.000Z');
  await store.bumpSecurityEpoch('epoch-bumped-2');
  await expectReason(() => verifier.verify({ authorization: `Bearer ${oldToken}` }), 'revoked');
  const fresh = await verifier.verify({ authorization: `Bearer ${newToken}` });
  assert.equal(fresh.evidence.securityEpoch, 'epoch-bumped-2');
  assert.equal(fresh.binding.securityEpoch, 'epoch-bumped-2');
});

test('security epoch is re-read for every verification and never cached', async () => {
  const key = await createKeyFixture('key-1');
  let epoch = 'epoch-1';
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]),
    securityEpoch: async () => epoch,
  }));
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });

  const first = await verifier.verify({ authorization: `Bearer ${token}` });
  epoch = 'epoch-2';
  const second = await verifier.verify({ authorization: `Bearer ${token}` });
  assert.equal(first.evidence.securityEpoch, 'epoch-1');
  assert.equal(first.binding.securityEpoch, 'epoch-1');
  assert.equal(second.evidence.securityEpoch, 'epoch-2');
  assert.equal(second.binding.securityEpoch, 'epoch-2');
});

test('log redaction removes bearer values, raw-token-like strings and identity fields from any context', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });
  const context = redactMcpOauthLogContext({
    reason: 'wrong_issuer',
    authorization: `Bearer ${token}`,
    rawToken: token,
    subject: SUBJECT,
    principalId: ACCOUNT_ID,
    accountSubjectId: SUBJECT,
    subjectId: SUBJECT,
    clientId: CLIENT_ID,
    issuer: ISSUER,
    audience: AUDIENCE,
    resourceAudience: AUDIENCE,
  });

  assert.equal(context.reason, 'wrong_issuer');
  assert.equal(context.authorization, '[REDACTED]');
  assert.equal(context.rawToken, '[REDACTED]');
  assert.equal(context.subject, '[REDACTED]');
  assert.equal(context.principalId, '[REDACTED]');
  assert.equal(context.accountSubjectId, '[REDACTED]');
  assert.equal(context.subjectId, '[REDACTED]');
  assert.equal(context.clientId, '[REDACTED]');
  assert.equal(context.issuer, '[REDACTED]');
  assert.equal(context.audience, '[REDACTED]');
  assert.equal(context.resourceAudience, '[REDACTED]');
  assert.equal(JSON.stringify(context).includes(token), false);
});

test('errors are generic and never leak token, subject, client, issuer or resource existence', async () => {
  const key = await createKeyFixture('key-1');
  const tokens = await Promise.all([
    mintCredential({ key: key.privateKey, kid: key.kid, issuer: 'https://evil.example.test/issuer' }),
    mintCredential({ key: key.privateKey, kid: key.kid, audience: 'https://other.example.test/api' }),
    mintCredential({ key: key.privateKey, kid: key.kid, clientId: '' }),
    mintCredential({ key: key.privateKey, kid: key.kid, expOffsetSeconds: -60 }),
  ]);
  const verifiers = [
    createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) })),
    createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) })),
    createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) })),
    createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) })),
  ];

  for (let index = 0; index < tokens.length; index += 1) {
    try {
      await verifiers[index]?.verify({ authorization: `Bearer ${tokens[index]}` });
      assert.fail('verification must fail');
    } catch (error: unknown) {
      assert.ok(error instanceof McpOauthVerificationError);
      assert.equal(error.message.includes(tokens[index] ?? ''), false);
      assert.equal(error.message.includes(SUBJECT), false);
      assert.equal(error.message.includes(CLIENT_ID), false);
      assert.equal(error.message.includes(ISSUER), false);
      assert.equal(error.message.includes(AUDIENCE), false);
    }
  }
});

// ---------------------------------------------------------------------------
// FIX-M-019: MCP JWKS egress hardening (shared hardened egress adapter).
// All network behavior is exercised through injected resolvers/connectors;
// no real public network is ever used.
// ---------------------------------------------------------------------------

function egressJsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('hardened egress address classification denies reserved networks and keeps public addresses', () => {
  const denied = [
    '0.0.0.0',
    '127.0.0.1',
    '127.8.8.8',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.254',
    '169.254.169.254',
    '169.254.0.9',
    '100.64.0.1',
    '100.127.255.254',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::2',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    // Mapped form is denied even when the embedded IPv4 is public.
    '::ffff:93.184.216.34',
    'fe80::1',
    'fc00::1',
    'fd00:ec2::254',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '64:ff9b::1',
    // IPv4 documentation (TEST-NET-1/2/3, RFC 5737), benchmarking
    // (198.18.0.0/15), deprecated 6to4 relay anycast (192.88.99.0/24).
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.9',
    '198.18.0.1',
    '198.19.255.254',
    '192.88.99.1',
    // IPv6 documentation (3fff::/20 per RFC 9637) and IETF protocol
    // assignments (2001::/23, incl. benchmarking 2001:2::/48).
    '3fff::1',
    '3fff:1::1',
    '2001:2::1',
    '2002:c0a8:1::1',
  ];
  for (const address of denied) {
    assert.equal(classifyEgressAddress(address), 'denied', `${address} must be denied`);
  }
  assert.equal(classifyEgressAddress('93.184.216.34'), 'public');
  assert.equal(classifyEgressAddress('2606:2800:220:1:248:1893:25c8:1946'), 'public');
  assert.equal(classifyEgressAddress('not-an-ip'), 'denied', 'malformed addresses fail closed');
});

test('hardened egress planning revalidates every resolved address and pins the first public one', async () => {
  const resolverCalls: string[] = [];
  const resolver: HardenedEgressResolver = async (hostname) => {
    resolverCalls.push(hostname);
    return ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  };
  const target = await planHardenedEgressTarget(
    'JWKS endpoint',
    'https://issuer.example.test/realms/known/certs',
    resolver,
  );
  assert.equal(target.url.hostname, 'issuer.example.test');
  assert.equal(target.url.protocol, 'https:');
  assert.equal(target.ip, '93.184.216.34');
  assert.equal(target.family, 4);
  assert.deepEqual(resolverCalls, ['issuer.example.test']);

  // Any single reserved record fails the whole resolution (fail closed).
  await assert.rejects(
    planHardenedEgressTarget('JWKS endpoint', 'https://issuer.example.test/certs',
      async () => ['93.184.216.34', '10.0.0.5']),
    (error: unknown) => error instanceof HardenedEgressError && error.reason === 'denied_address',
  );
  await assert.rejects(
    planHardenedEgressTarget('JWKS endpoint', 'https://issuer.example.test/certs',
      async () => ['::ffff:127.0.0.1']),
    (error: unknown) => error instanceof HardenedEgressError && error.reason === 'denied_address',
  );
  await assert.rejects(
    planHardenedEgressTarget('JWKS endpoint', 'https://issuer.example.test/certs', async () => []),
    (error: unknown) => error instanceof HardenedEgressError && error.reason === 'dns_failure',
  );
  await assert.rejects(
    planHardenedEgressTarget('JWKS endpoint', 'https://issuer.example.test/certs',
      async () => { throw new Error('ENOTFOUND'); }),
    (error: unknown) => error instanceof HardenedEgressError && error.reason === 'dns_failure',
  );

  // Metadata, private and non-HTTPS targets are rejected before any resolution.
  for (const deniedUrl of [
    'https://metadata.google.internal/certs',
    'https://127.0.0.1:8443/certs',
    'https://[fe80::1]/certs',
    'https://localhost/certs',
    'http://issuer.example.test/certs',
    'https://user:pass@issuer.example.test/certs',
  ]) {
    await assert.rejects(
      planHardenedEgressTarget('JWKS endpoint', deniedUrl, async () => ['93.184.216.34']),
      (error: unknown) => error instanceof HardenedEgressError && error.reason === 'denied',
      deniedUrl,
    );
  }
});

test('hardened egress fetch revalidates and pins every redirect hop', async () => {
  const targets: Array<{ hostname: string; ip: string }> = [];
  const connect: HardenedEgressConnector = async (target, init) => {
    targets.push({ hostname: target.url.hostname, ip: target.ip });
    assert.equal(init.redirect, 'manual', 'redirects must be handled by the adapter, never auto-followed');
    if (target.url.hostname === 'issuer.example.test') {
      return egressJsonResponse(302, {}, { location: 'https://cdn.example.test/certs' });
    }
    return egressJsonResponse(200, { keys: [] });
  };
  const resolver: HardenedEgressResolver = async (hostname) => {
    if (hostname === 'issuer.example.test') return ['93.184.216.34'];
    return ['2606:2800:220:1:248:1893:25c8:1946'];
  };
  const fetchImpl = createHardenedEgressFetch({ resolve: resolver, connect });
  const response = await fetchImpl('https://issuer.example.test/realms/known/certs', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.deepEqual(targets, [
    { hostname: 'issuer.example.test', ip: '93.184.216.34' },
    { hostname: 'cdn.example.test', ip: '2606:2800:220:1:248:1893:25c8:1946' },
  ]);
});

test('redirects into private networks or metadata hosts are denied before the connector is invoked', async () => {
  let connectorCalls = 0;
  const fetchImpl = createHardenedEgressFetch({
    resolve: async (hostname) => (hostname === 'internal.jwks.example.test' ? ['10.0.0.5'] : ['93.184.216.34']),
    connect: async (target) => {
      connectorCalls += 1;
      assert.equal(target.url.hostname, 'issuer.example.test');
      return egressJsonResponse(302, {}, { location: 'https://internal.jwks.example.test/certs' });
    },
  });
  await assert.rejects(
    fetchImpl('https://issuer.example.test/certs'),
    (error: unknown) => error instanceof HardenedEgressError && error.reason === 'denied_address',
  );
  assert.equal(connectorCalls, 1, 'the private redirect hop must never be connected');

  const metadataRedirect = createHardenedEgressFetch({
    resolve: async () => ['93.184.216.34'],
    connect: async () => egressJsonResponse(302, {}, { location: 'https://metadata.google.internal/certs' }),
  });
  await assert.rejects(
    metadataRedirect('https://issuer.example.test/certs'),
    (error: unknown) => error instanceof HardenedEgressError && error.reason === 'denied',
  );

  for (const location of [
    'https://169.254.169.254/latest',
    'https://[fe80::1]/certs',
  ]) {
    const deniedRedirect = createHardenedEgressFetch({
      resolve: async () => ['93.184.216.34'],
      connect: async () => egressJsonResponse(302, {}, { location }),
    });
    await assert.rejects(
      deniedRedirect('https://issuer.example.test/certs'),
      (error: unknown) => error instanceof HardenedEgressError && error.reason === 'denied',
      location,
    );
  }
});

test('IPv6 6to4 planning is denied while a global unicast literal still passes', async () => {
  await assert.rejects(
    planHardenedEgressTarget('JWKS endpoint', 'https://[2002:c0a8:1::1]/', async () => {
      throw new Error('resolver must not run for a denied 6to4 literal');
    }),
    (error: unknown) => error instanceof HardenedEgressError && error.reason === 'denied_address',
  );
  const target = await planHardenedEgressTarget(
    'JWKS endpoint',
    'https://[2606:2800:220:1:248:1893:25c8:1946]/certs',
    async () => {
      throw new Error('resolver must not run for a literal address');
    },
  );
  assert.equal(target.ip, '2606:2800:220:1:248:1893:25c8:1946');
  assert.equal(target.family, 6);
});

test('DNS rebinding is defeated: the connection lookup is pinned to the validated address', async () => {
  let resolveCalls = 0;
  const resolver: HardenedEgressResolver = async () => {
    resolveCalls += 1;
    return ['93.184.216.34'];
  };
  const connect: HardenedEgressConnector = async (target) => {
    // Even though DNS would have "changed" by connect time, the socket lookup
    // must still return the validated IP for any hostname.
    const lookup = createPinnedLookup(target.ip, target.family);
    const received = await new Promise<string>((done) => {
      lookup('attacker-controlled.example.test', { family: 0, hints: 0, all: false }, (error, address) => {
        assert.equal(error, null);
        done(typeof address === 'string' ? address : address[0].address);
      });
    });
    assert.equal(received, target.ip, 'the socket lookup must return the validated IP for any hostname');
    return egressJsonResponse(200, { keys: [] });
  };
  const fetchImpl = createHardenedEgressFetch({ resolve: resolver, connect });
  const response = await fetchImpl('https://issuer.example.test/certs');
  assert.equal(response.status, 200);
  assert.equal(resolveCalls, 1, 'no second DNS resolution may happen for the same hop');

  const allLookup = createPinnedLookup('2606:2800:220:1:248:1893:25c8:1946', 6);
  const allAddresses = await new Promise<Array<{ address: string; family: number }>>((done) => {
    allLookup('any.example.test', { family: 0, hints: 0, all: true }, (error, address) => {
      assert.equal(error, null);
      done(typeof address === 'string' ? [{ address, family: 0 }] : address);
    });
  });
  assert.deepEqual(allAddresses, [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
});

test('hardened egress ignores proxy environment variables by default', async () => {
  const previous: Record<string, string | undefined> = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  process.env.HTTP_PROXY = 'http://proxy.example.test:3128';
  process.env.HTTPS_PROXY = 'http://proxy.example.test:3128';
  process.env.http_proxy = 'http://proxy.example.test:3128';
  process.env.https_proxy = 'http://proxy.example.test:3128';
  process.env.NO_PROXY = '';
  process.env.no_proxy = '';
  try {
    const connect: HardenedEgressConnector = async (target, init) => {
      assert.equal(target.url.hostname, 'issuer.example.test');
      assert.equal(init.redirect, 'manual');
      assert.equal('dispatcher' in init, false, 'no proxy dispatcher may be attached');
      assert.equal('proxy' in init, false);
      return egressJsonResponse(200, { keys: [] });
    };
    const fetchImpl = createHardenedEgressFetch({ resolve: async () => ['93.184.216.34'], connect });
    const response = await fetchImpl('https://issuer.example.test/certs');
    assert.equal(response.status, 200);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('hardened egress enforces a redirect hop limit', async () => {
  let calls = 0;
  const fetchImpl = createHardenedEgressFetch({
    resolve: async () => ['93.184.216.34'],
    connect: async (target) => {
      calls += 1;
      return egressJsonResponse(302, {}, { location: `${target.url.origin}/certs` });
    },
    maxRedirects: 2,
  });
  await assert.rejects(
    fetchImpl('https://issuer.example.test/certs'),
    (error: unknown) => error instanceof HardenedEgressError && error.reason === 'too_many_redirects',
  );
  assert.equal(calls, 3, 'initial request plus two redirect hops');
});

test('hardened egress errors never echo internal IP or DNS details', async () => {
  const deniedFetch = createHardenedEgressFetch({
    resolve: async () => ['10.0.0.5'],
    connect: async () => { throw new Error('unreachable'); },
  });
  await assert.rejects(deniedFetch('https://internal.example.test/certs'), (error: unknown) => {
    assert.ok(error instanceof HardenedEgressError);
    assert.equal(error.reason, 'denied_address');
    assert.equal(error.message.includes('10.0.0.5'), false);
    assert.equal(error.message.includes('internal.example.test'), false);
    return true;
  });

  const dnsFailureFetch = createHardenedEgressFetch({
    resolve: async () => { throw new Error('ENOTFOUND internal.example.test'); },
    connect: async () => { throw new Error('unreachable'); },
  });
  await assert.rejects(dnsFailureFetch('https://internal.example.test/certs'), (error: unknown) => {
    assert.ok(error instanceof HardenedEgressError);
    assert.equal(error.reason, 'dns_failure');
    assert.equal(error.message.includes('internal.example.test'), false);
    return true;
  });
});

test('JWKS client maps hardened egress denials to a typed fetch failure', async () => {
  const jwks = createCachingJwksClient({
    jwksUri: 'https://issuer.example.test/certs',
    fetchImpl: createHardenedEgressFetch({
      resolve: async () => ['10.0.0.5'],
      connect: async () => { throw new Error('unreachable'); },
    }),
  });
  await assert.rejects(jwks.getKeySet(), (error: unknown) => {
    assert.ok(error instanceof IdTokenVerificationError);
    assert.equal(error.reason, 'jwks_fetch_failed');
    assert.equal(error.message.includes('10.0.0.5'), false);
    return true;
  });
});

