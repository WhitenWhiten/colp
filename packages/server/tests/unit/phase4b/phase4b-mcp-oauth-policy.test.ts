import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type KeyLike,
} from 'jose';
import { loadConfig } from '../../support/test-config.js';
import {
  BETTER_AUTH_OAUTH_OFFLINE_ACCESS_SCOPE,
  BETTER_AUTH_OAUTH_PRODUCT_READ_SCOPE,
  BETTER_AUTH_OAUTH_PRODUCT_WRITE_SCOPE,
  withBetterAuthOauthIssuerScopes,
} from '../../../src/modules/auth/better-auth-config.js';
import {
  createMcpOauthVerifier,
  MCP_OAUTH_SCOPE_OFFLINE_ACCESS,
  McpOauthVerificationError,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH,
  requiredScopesForMcpReadOperation,
  withMcpOauthAcceptedScopes,
  type McpOauthVerificationFailureReason,
  type McpOauthVerifierOptions,
} from '../../../src/modules/mcp/index.js';
import type { JwksProvider } from '../../../src/modules/identity/index.js';
import { mapMcpOauthChallengeToProductError } from '../../../src/transport/mcp/mcp-protected-resource-routes.js';
import { phase4bMcpOnEnv } from '../../support/phase4b-mcp-config-env.js';

const NOW = new Date('2026-08-05T08:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUER = 'https://issuer.example.test/realms/known';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const DEFAULT_CLIENT_ID = 'known-mcp-oauth-client';
const CIMD_CLIENT_ID = 'https://clients.example.test/mcp.json';
const SCOPES = ['mcp:read:public', 'mcp:read:own'] as const;
const SUBJECT = 'urn:known:subject:alice';
const ACCOUNT_ID = 'account-alice-1';
const JTI = 'policy-credential-jti-1';

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
  readonly clientId?: string | null;
  readonly scope?: string;
  readonly audience?: string;
  readonly claims?: Record<string, unknown>;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    scope: input.scope ?? SCOPES.join(' '),
    ...(input.claims ?? {}),
  };
  if (input.clientId !== null && payload.client_id === undefined) {
    payload.client_id = input.clientId ?? DEFAULT_CLIENT_ID;
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: input.kid })
    .setIssuer(ISSUER)
    .setSubject(SUBJECT)
    .setAudience(input.audience ?? AUDIENCE)
    .setIssuedAt(NOW_SECONDS - 5)
    .setExpirationTime(NOW_SECONDS + 3_600)
    .setJti(JTI)
    .sign(input.key);
}

function makeOptions(overrides: Partial<McpOauthVerifierOptions> = {}): McpOauthVerifierOptions {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
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

test('rejects a missing client_id claim as invalid_token', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid, clientId: null });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));
  await expectReason(() => verifier.verify({ authorization: `Bearer ${token}` }), 'invalid_token');
});

test('rejects an empty-string client_id claim as invalid_token', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid, clientId: '' });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));
  await expectReason(() => verifier.verify({ authorization: `Bearer ${token}` }), 'invalid_token');
});

test('rejects a non-string client_id claim as invalid_token', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    clientId: null,
    claims: { client_id: 42 },
  });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));
  await expectReason(() => verifier.verify({ authorization: `Bearer ${token}` }), 'invalid_token');
});

test('accepts any non-empty client_id including a CIMD URL when other claims are valid', async () => {
  const key = await createKeyFixture('key-1');
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));

  const opaque = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    clientId: 'other-oauth-client',
  });
  const opaqueResult = await verifier.verify({ authorization: `Bearer ${opaque}` });
  assert.equal(opaqueResult.evidence.clientId, 'other-oauth-client');
  assert.deepEqual([...opaqueResult.scopes].sort(), [...SCOPES].sort());

  const cimd = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    clientId: CIMD_CLIENT_ID,
  });
  const cimdResult = await verifier.verify({ authorization: `Bearer ${cimd}` });
  assert.equal(cimdResult.evidence.clientId, CIMD_CLIENT_ID);
});

test('uses the token client_id for revocation input and evidence', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    clientId: CIMD_CLIENT_ID,
  });
  const revocationInputs: Array<{ readonly clientId: string }> = [];
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]),
    isRevoked: async (input) => {
      revocationInputs.push({ clientId: input.clientId });
      return false;
    },
  }));
  const result = await verifier.verify({ authorization: `Bearer ${token}` });
  assert.equal(result.evidence.clientId, CIMD_CLIENT_ID);
  assert.deepEqual(revocationInputs, [{ clientId: CIMD_CLIENT_ID }]);
});

test('rejects a token scope value outside the configured support set as invalid_token', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: 'mcp:read:public mcp:read:own admin:all',
  });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));
  await expectReason(() => verifier.verify({ authorization: `Bearer ${token}` }), 'invalid_token');
});

test('accepts a true subset of the support set that meets the operation requirement', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: 'mcp:read:public',
  });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));
  const result = await verifier.verify({
    authorization: `Bearer ${token}`,
    requiredScopes: ['mcp:read:public'],
  });
  assert.equal(result.evidence.principalId, ACCOUNT_ID);
  assert.deepEqual([...result.scopes], ['mcp:read:public']);
});

test('rejects a token missing the operation-required scope as missing_scope', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: 'mcp:read:public',
  });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));
  await expectReason(
    () => verifier.verify({
      authorization: `Bearer ${token}`,
      requiredScopes: ['mcp:read:own'],
    }),
    'missing_scope',
  );
});

test('missing_scope maps to 403 with an insufficient_scope challenge advertising the support set', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: 'mcp:read:public',
  });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));
  let caught: unknown;
  try {
    await verifier.verify({
      authorization: `Bearer ${token}`,
      requiredScopes: ['mcp:read:own'],
    });
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(caught instanceof McpOauthVerificationError);
  assert.equal(caught.reason, 'missing_scope');

  const mcp = loadConfig(phase4bMcpOnEnv()).mcp;
  assert.ok(mcp);
  const mapped = mapMcpOauthChallengeToProductError(caught, mcp);
  assert.equal(mapped.statusCode, 403);
  const resourceMetadata =
    `${mcp.origin}${PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH}`;
  assert.equal(
    mapped.headers['WWW-Authenticate'],
    `Bearer error="insufficient_scope", scope="mcp:read:public mcp:read:own", resource_metadata="${resourceMetadata}"`,
  );
});

test('Read-public vs own-data operations declare the ADR D5 required scope subset', () => {
  assert.deepEqual([...requiredScopesForMcpReadOperation({ method: 'tools/list' })], []);
  assert.deepEqual([...requiredScopesForMcpReadOperation({ method: 'tools/call' })], []);
  assert.deepEqual(
    [...requiredScopesForMcpReadOperation({ method: 'resources/templates/list' })],
    ['mcp:read:public'],
  );
  assert.deepEqual(
    [...requiredScopesForMcpReadOperation({ method: 'resources/list' })],
    ['mcp:read:own'],
  );
  assert.deepEqual(
    [...requiredScopesForMcpReadOperation({ method: 'resources/read' })],
    ['mcp:read:own'],
  );
  assert.deepEqual(
    [...requiredScopesForMcpReadOperation({ method: 'subscriptions/listen' })],
    ['mcp:read:own'],
  );
  assert.deepEqual([...requiredScopesForMcpReadOperation({ method: 'server/discover' })], []);
});

test('offline_access is the reserved refresh scope, always unioned, never a capability', () => {
  assert.equal(MCP_OAUTH_SCOPE_OFFLINE_ACCESS, 'offline_access');
  assert.equal(BETTER_AUTH_OAUTH_OFFLINE_ACCESS_SCOPE, MCP_OAUTH_SCOPE_OFFLINE_ACCESS);
  assert.deepEqual([...withMcpOauthAcceptedScopes(SCOPES)], [
    'mcp:read:public',
    'mcp:read:own',
    'offline_access',
  ]);
  assert.equal(BETTER_AUTH_OAUTH_PRODUCT_READ_SCOPE, 'product:read');
  assert.equal(BETTER_AUTH_OAUTH_PRODUCT_WRITE_SCOPE, 'product:write');
  assert.deepEqual([...withBetterAuthOauthIssuerScopes(SCOPES)], [
    'mcp:read:public',
    'mcp:read:own',
    'product:read',
    'product:write',
    'offline_access',
  ]);
  assert.deepEqual(
    [...withBetterAuthOauthIssuerScopes(['mcp:read:public', 'offline_access'])],
    ['mcp:read:public', 'offline_access', 'product:read', 'product:write'],
  );
  assert.deepEqual(
    [...withMcpOauthAcceptedScopes(['mcp:read:public', 'offline_access'])],
    ['mcp:read:public', 'offline_access'],
  );
  assert.deepEqual([...requiredScopesForMcpReadOperation({ method: 'resources/read' })], ['mcp:read:own']);
});

test('accepts offline_access as an extra scope that does not satisfy MCP capabilities', async () => {
  const key = await createKeyFixture('key-1');
  const withRefresh = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: 'mcp:read:public mcp:read:own offline_access',
  });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));
  const accepted = await verifier.verify({
    authorization: `Bearer ${withRefresh}`,
    requiredScopes: ['mcp:read:own'],
  });
  assert.deepEqual([...accepted.scopes], ['mcp:read:own', 'mcp:read:public', 'offline_access']);

  const refreshOnly = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: 'offline_access',
  });
  await expectReason(
    () => verifier.verify({
      authorization: `Bearer ${refreshOnly}`,
      requiredScopes: ['mcp:read:own'],
    }),
    'missing_scope',
  );
});

test('product:read and product:write do not satisfy native MCP required scopes', async () => {
  const key = await createKeyFixture('key-1');
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]),
    allowedScopes: [
      ...SCOPES,
      BETTER_AUTH_OAUTH_PRODUCT_READ_SCOPE,
      BETTER_AUTH_OAUTH_PRODUCT_WRITE_SCOPE,
    ],
  }));
  const productOnly = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: `${BETTER_AUTH_OAUTH_PRODUCT_READ_SCOPE} ${BETTER_AUTH_OAUTH_PRODUCT_WRITE_SCOPE}`,
  });
  await expectReason(
    () => verifier.verify({
      authorization: `Bearer ${productOnly}`,
      requiredScopes: ['mcp:read:own'],
    }),
    'missing_scope',
  );
  const mixed = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: `mcp:read:own ${BETTER_AUTH_OAUTH_PRODUCT_READ_SCOPE}`,
  });
  const accepted = await verifier.verify({
    authorization: `Bearer ${mixed}`,
    requiredScopes: ['mcp:read:own'],
  });
  assert.equal(accepted.scopes.includes('mcp:read:own'), true);
  assert.equal(accepted.scopes.includes(BETTER_AUTH_OAUTH_PRODUCT_READ_SCOPE), true);
});

const COMPAT_AUDIENCE = 'https://collections.example.test/collections/-/mcp-compat';

test('accepts the compat resource audience when the verifier lists both resources', async () => {
  const key = await createKeyFixture('key-1');
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]),
    audience: [AUDIENCE, COMPAT_AUDIENCE],
  }));
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    audience: COMPAT_AUDIENCE,
  });
  const result = await verifier.verify({ authorization: `Bearer ${token}` });
  assert.equal(result.evidence.resourceAudience, COMPAT_AUDIENCE);
  assert.equal(result.binding.resourceAudience, COMPAT_AUDIENCE);
});

test('rejects an unrelated audience even when both MCP resources are listed', async () => {
  const key = await createKeyFixture('key-1');
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]),
    audience: [AUDIENCE, COMPAT_AUDIENCE],
  }));
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    audience: 'https://other.example.test/collections/-/mcp',
  });
  await expectReason(() => verifier.verify({ authorization: `Bearer ${token}` }), 'wrong_audience');
});
