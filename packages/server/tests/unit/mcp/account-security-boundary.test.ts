import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createMcpReadOAuthTransportDependencies } from '../../../src/bootstrap/api-mcp-oauth-composition.js';
import {
  createInMemoryMcpOauthRevocationStore,
  createMcpOauthVerifier,
  isMcpAccountSecurityBoundaryRevoked,
  mcpAccountSecurityBoundaryVerdict,
  McpOauthVerificationError,
  type McpAccountSecurityBoundary,
  type McpOauthRevocationStore,
} from '../../../src/modules/mcp/index.js';
import { createAccountSecurityEventNotification } from '../../../src/modules/auth/index.js';
import {
  ACCOUNT_ID,
  CLIENT_ID,
  ISSUER,
  AUDIENCE,
  SCOPES,
  SUBJECT,
  createKeyFixture,
  mcpEnv,
  mintCredential,
  prodEnv,
  staticJwksProvider,
} from '../../support/phase4b-mcp-transport-scaffold.js';

const ACTIVE: McpAccountSecurityBoundary = {
  status: 'active',
  securityEpoch: '1',
  bumpedAt: new Date('2026-08-20T06:00:00.400Z'),
};
const FLOOR = Math.floor(ACTIVE.bumpedAt!.getTime() / 1_000);

test('account boundary uses epoch equality or rejects the boundary second and fails closed', () => {
  assert.equal(isMcpAccountSecurityBoundaryRevoked({
    boundary: ACTIVE, issuedAtSeconds: FLOOR - 30, knownAccountEpoch: '1',
  }), false, 'a matching account epoch is not revoked by an earlier iat');
  assert.equal(isMcpAccountSecurityBoundaryRevoked({
    boundary: ACTIVE, issuedAtSeconds: FLOOR, knownAccountEpoch: '0',
  }), true, 'an old account epoch is revoked in the event second');
  assert.equal(isMcpAccountSecurityBoundaryRevoked({
    boundary: ACTIVE, issuedAtSeconds: FLOOR, knownAccountEpoch: undefined,
  }), true, 'boundary-second iat is rejected without an exact epoch claim');
  assert.equal(isMcpAccountSecurityBoundaryRevoked({
    boundary: ACTIVE, issuedAtSeconds: FLOOR - 1, knownAccountEpoch: undefined,
  }), true);
  assert.equal(isMcpAccountSecurityBoundaryRevoked({
    boundary: { status: 'active', securityEpoch: '0', bumpedAt: null },
    issuedAtSeconds: FLOOR, knownAccountEpoch: undefined,
  }), false);
  assert.equal(isMcpAccountSecurityBoundaryRevoked({
    boundary: { status: 'active', securityEpoch: '2', bumpedAt: null },
    issuedAtSeconds: FLOOR, knownAccountEpoch: undefined,
  }), true);
  assert.equal(isMcpAccountSecurityBoundaryRevoked({
    boundary: null, issuedAtSeconds: FLOOR, knownAccountEpoch: undefined,
  }), true);
  assert.equal(isMcpAccountSecurityBoundaryRevoked({
    boundary: { ...ACTIVE, status: 'disabled' }, issuedAtSeconds: FLOOR, knownAccountEpoch: '1',
  }), true);
  assert.equal(isMcpAccountSecurityBoundaryRevoked({
    boundary: ACTIVE, issuedAtSeconds: FLOOR, knownAccountEpoch: '01',
  }), true, 'a non-canonical epoch claim is not a match');
});

test('a built-in epoch mismatch does not need the reader, and a reader failure is revoked', async () => {
  let reads = 0;
  const mismatch = await mcpAccountSecurityBoundaryVerdict({
    requireAccountEpoch: true,
    readAccountSecurityBoundary: async () => {
      reads += 1;
      return ACTIVE;
    },
    account: { id: 'acct', securityEpoch: '1' },
    knownAccountEpoch: '0',
    issuedAtSeconds: FLOOR,
  });
  assert.equal(mismatch, 'revoked');
  assert.equal(reads, 0);
  const failed = await mcpAccountSecurityBoundaryVerdict({
    requireAccountEpoch: true,
    readAccountSecurityBoundary: async () => {
      throw new Error('boundary unreadable');
    },
    account: { id: 'acct', securityEpoch: '1' },
    knownAccountEpoch: '1',
    issuedAtSeconds: FLOOR,
  });
  assert.equal(failed, 'revoked');
  const noStore = await mcpAccountSecurityBoundaryVerdict({
    requireAccountEpoch: false,
    account: { id: 'acct', securityEpoch: '1' },
    knownAccountEpoch: undefined,
    issuedAtSeconds: FLOOR - 10,
  });
  assert.equal(noStore, 'ok');
});

test('notification deliveries do not throw and do not need a revocation store', async () => {
  const lines: string[] = [];
  const notify = createAccountSecurityEventNotification({
    info(bindings, message) {
      lines.push(`${message}:${JSON.stringify(bindings)}`);
    },
    warn() {
      throw new Error('warn must not run when info exists');
    },
  });
  await notify.propagate({ accountId: 'acct-a', event: 'mfa_disable' });
  await notify.propagate({ accountId: 'acct-a', event: 'mfa_disable' });
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /acct-a/);
  assert.match(lines[0]!, /mfa_disable/);
});

async function signedToken(input: {
  readonly key: KeyLike;
  readonly kid: string;
  readonly issuedAtSeconds: number;
  readonly knownAccountEpoch?: string;
  readonly subject?: string;
}): Promise<string> {
  const claims: Record<string, string> = {
    scope: SCOPES.join(' '),
    client_id: CLIENT_ID,
  };
  if (input.knownAccountEpoch !== undefined) claims.known_account_epoch = input.knownAccountEpoch;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: input.kid })
    .setIssuer(ISSUER)
    .setSubject(input.subject ?? SUBJECT)
    .setAudience(AUDIENCE)
    .setIssuedAt(input.issuedAtSeconds)
    .setExpirationTime(input.issuedAtSeconds + 3_600)
    .setJti(`boundary-${input.issuedAtSeconds}-${input.knownAccountEpoch ?? 'iat'}`)
    .sign(input.key);
}

test('production composition checks the resolved account and test mode does not', async () => {
  const key = await createKeyFixture('boundary-key');
  const boundaryAt = new Date();
  const floor = Math.floor(boundaryAt.getTime() / 1_000);
  const memory = createInMemoryMcpOauthRevocationStore({ now: () => new Date(boundaryAt.getTime() - 3_600_000) });
  const store: McpOauthRevocationStore = {
    revoke: (target) => memory.revoke(target),
    revokeClient: (clientId) => memory.revokeClient(clientId),
    isRevoked: (query) => memory.isRevoked(query),
    securityEpoch: () => memory.securityEpoch(),
    bumpSecurityEpoch: (value) => memory.bumpSecurityEpoch(value),
    async readAccountSecurityBoundary(): Promise<McpAccountSecurityBoundary> {
      return { status: 'active', securityEpoch: '1', bumpedAt: boundaryAt };
    },
  };
  const resolveAccountBySubject = async (sub: string) => (
    sub === SUBJECT ? { id: ACCOUNT_ID, subjectId: SUBJECT, status: 'active', securityEpoch: '1' } : null
  );
  const production = createMcpReadOAuthTransportDependencies(
    loadConfig(prodEnv({ MCP_OAUTH_REVOCATION_STORE: 'postgres' })),
    { jwksProvider: staticJwksProvider([key.jwk]), revocationStore: store, resolveAccountBySubject },
  );
  const oldExternal = await signedToken({ key: key.privateKey, kid: key.kid, issuedAtSeconds: floor - 30 });
  await assert.rejects(
    () => production.oauthVerifier!.verify({ authorization: `Bearer ${oldExternal}` }),
    (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
  );
  const freshExternal = await signedToken({
    key: key.privateKey, kid: key.kid, issuedAtSeconds: floor + 30,
  });
  assert.equal(
    (await production.oauthVerifier!.verify({ authorization: `Bearer ${freshExternal}` })).accountSubjectId,
    SUBJECT,
  );
  const oldBuiltIn = await signedToken({
    key: key.privateKey, kid: key.kid, issuedAtSeconds: floor - 30, knownAccountEpoch: '1',
  });
  const builtIn = createMcpOauthVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    allowedScopes: SCOPES,
    jwks: staticJwksProvider([key.jwk]),
    isRevoked: (query) => store.isRevoked(query),
    securityEpoch: () => store.securityEpoch(),
    resolveAccountBySubject,
    requireAccountEpoch: true,
    readAccountSecurityBoundary: (accountId) => store.readAccountSecurityBoundary!(accountId),
  });
  assert.equal(
    (await builtIn.verify({ authorization: `Bearer ${oldBuiltIn}` })).evidence.principalId,
    ACCOUNT_ID,
    'matching known_account_epoch is not revoked by an earlier iat',
  );
  const missing = await signedToken({
    key: key.privateKey, kid: key.kid, issuedAtSeconds: floor, subject: 'missing-subject',
  });
  await assert.rejects(
    () => production.oauthVerifier!.verify({ authorization: `Bearer ${missing}` }),
    (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'invalid_token',
  );
  const testMode = createMcpReadOAuthTransportDependencies(loadConfig(mcpEnv()), {
    jwksProvider: staticJwksProvider([key.jwk]),
    revocationStore: store,
    resolveAccountBySubject,
  });
  assert.equal(
    (await testMode.oauthVerifier!.verify({ authorization: `Bearer ${oldExternal}` })).accountSubjectId,
    SUBJECT,
    'a deployment without the production revocation path does not revoke external credentials',
  );
});

test('an unreadable account boundary rejects a token the global floor would allow', async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: 'unread', alg: 'RS256', use: 'sig' });
  const now = new Date();
  const store = createInMemoryMcpOauthRevocationStore({ now: () => new Date(now.getTime() - 3_600_000) });
  const verifier = createMcpOauthVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    allowedScopes: SCOPES,
    jwks: staticJwksProvider([jwk]),
    isRevoked: (query) => store.isRevoked(query),
    securityEpoch: () => store.securityEpoch(),
    resolveAccountBySubject: async () => ({
      id: ACCOUNT_ID, subjectId: SUBJECT, status: 'active', securityEpoch: '0',
    }),
    readAccountSecurityBoundary: async () => {
      throw new Error('accounts unreadable');
    },
    now: () => now,
  });
  const token = await mintCredential({ key: pair.privateKey, kid: 'unread', jti: 'unread-jti', now });
  await assert.rejects(
    () => verifier.verify({ authorization: `Bearer ${token}` }),
    (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
  );
});
