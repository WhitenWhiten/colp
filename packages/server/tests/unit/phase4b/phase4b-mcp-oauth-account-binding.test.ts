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
// T-03 / ADR D3: JWT sub = Better Auth user.id = accounts.subject_id.
// Fixture value stays historical; resolveAccountBySubject still looks up by
// subject_id (T-A4). The lookup API and return shape are unchanged.
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
    // sub = BA user id = subject_id; resolver still keys on subject_id only.
    resolveAccountBySubject: async (sub) => (
      sub === SUBJECT
        ? { id: ACCOUNT_ID, subjectId: SUBJECT, status: 'active' }
        : null
    ),
    ...overrides,
  };
}

test('legal JWKS key rotation works through the hardened egress fetch', async () => {
  const oldKey = await createKeyFixture('old');
  const newKey = await createKeyFixture('new');
  const jwksUri = 'https://issuer.example.test/realms/known/protocol/openid-connect/certs';
  let fetches = 0;
  const connect: HardenedEgressConnector = async (target) => {
    assert.equal(target.url.hostname, 'issuer.example.test');
    fetches += 1;
    return egressJsonResponse(200, { keys: fetches === 1 ? [oldKey.jwk] : [oldKey.jwk, newKey.jwk] });
  };
  const jwks = createCachingJwksClient({
    jwksUri,
    fetchImpl: createHardenedEgressFetch({ resolve: async () => ['93.184.216.34'], connect }),
  });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks }));
  const rotated = await mintCredential({ key: newKey.privateKey, kid: newKey.kid });
  const result = await verifier.verify({ authorization: `Bearer ${rotated}` });
  assert.equal(result.evidence.principalId, ACCOUNT_ID);
  assert.equal(result.accountSubjectId, SUBJECT);
  assert.equal(fetches, 2, 'unknown kid must force exactly one hardened refresh');
});

test('rejects a Bearer sub that matches no active account', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    subject: 'urn:known:subject:nobody',
  });
  const verifier = createMcpOauthVerifier(makeOptions({ jwks: staticJwksProvider([key.jwk]) }));
  await expectReason(
    () => verifier.verify({ authorization: `Bearer ${token}` }),
    'invalid_token',
  );
});

test('rejects inactive, ambiguous, mismatched, and throwing account lookups', async () => {
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid });
  const jwks = staticJwksProvider([key.jwk]);

  await expectReason(
    () => createMcpOauthVerifier(makeOptions({
      jwks,
      resolveAccountBySubject: async () => ({
        id: ACCOUNT_ID,
        subjectId: SUBJECT,
        status: 'disabled',
      }),
    })).verify({ authorization: `Bearer ${token}` }),
    'invalid_token',
  );
  await expectReason(
    () => createMcpOauthVerifier(makeOptions({
      jwks,
      resolveAccountBySubject: async () => [
        { id: ACCOUNT_ID, subjectId: SUBJECT, status: 'active' },
        { id: 'account-other', subjectId: SUBJECT, status: 'active' },
      ],
    })).verify({ authorization: `Bearer ${token}` }),
    'invalid_token',
  );
  await expectReason(
    () => createMcpOauthVerifier(makeOptions({
      jwks,
      resolveAccountBySubject: async () => ({
        id: ACCOUNT_ID,
        subjectId: 'urn:known:subject:other',
        status: 'active',
      }),
    })).verify({ authorization: `Bearer ${token}` }),
    'invalid_token',
  );
  await expectReason(
    () => createMcpOauthVerifier(makeOptions({
      jwks,
      resolveAccountBySubject: async () => {
        throw new Error('lookup failed');
      },
    })).verify({ authorization: `Bearer ${token}` }),
    'invalid_token',
  );
});

test('AUTH-04: identical iat tokens distinguish old and new account epochs', async () => {
  const key = await createKeyFixture('password-epoch');
  let epoch = '8';
  const verifier = createMcpOauthVerifier(makeOptions({
    jwks: staticJwksProvider([key.jwk]), requireAccountEpoch: true,
    resolveAccountBySubject: async () => ({id:ACCOUNT_ID,subjectId:SUBJECT,status:'active',securityEpoch:epoch}),
  }));
  const old = await mintCredential({key:key.privateKey,kid:key.kid,issuedAtSeconds:NOW_SECONDS,claims:{known_account_epoch:'8'}});
  await verifier.verify({authorization:`Bearer ${old}`});
  epoch = '9';
  await expectReason(() => verifier.verify({authorization:`Bearer ${old}`}), 'revoked');
  const fresh = await mintCredential({key:key.privateKey,kid:key.kid,issuedAtSeconds:NOW_SECONDS,claims:{known_account_epoch:'9'}});
  await verifier.verify({authorization:`Bearer ${fresh}`});
  const legacy = await mintCredential({key:key.privateKey,kid:key.kid,issuedAtSeconds:NOW_SECONDS});
  await expectReason(() => verifier.verify({authorization:`Bearer ${legacy}`}), 'revoked');
});
