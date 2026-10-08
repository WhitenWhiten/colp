import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { jwtVerify, importJWK, decodeProtectedHeader, decodeJwt } from 'jose';
import Fastify from 'fastify';
import {
  ACCOUNT_KEY_GRANT_TYPE,
  PRODUCT_READ_SCOPE,
  PRODUCT_WRITE_SCOPE,
  ancestorEpochDigest,
  machineCredentialBindingId,
  mergeAutomationJwks,
  parseAccountKeyTokenRequest,
  publicJwkFromPrivate,
  resolveAccountKeyAudience,
  signAccountKeyAccessToken,
  sortScopeTokens,
  supportedAccountKeyScopes,
} from '../../../src/modules/auth/application/account-credentials/token.js';
import { verifyAccountKeyJwt } from '../../../src/modules/auth/application/account-credentials/authority.js';
import { AccountKeyOAuthError } from '../../../src/modules/auth/application/account-credentials/oauth-error.js';
import { registerAccountCredentialJwks } from '../../../src/transport/auth/account-credential-jwks.js';

const ISSUER = 'https://app.example.test/api/v1/auth';
const PRODUCT_ORIGIN = 'https://app.example.test';
const MCP_STRICT = 'https://app.example.test/collections/-/mcp';
const MCP_COMPAT = 'https://app.example.test/collections/-/mcp-compat';
const CHILD_SECRET = 'kn_c_aaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function testPrivateJwk(kid = 'acct-cred-es256') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return Object.freeze({
    kid,
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: jwk.x!,
    y: jwk.y!,
    d: jwk.d!,
  });
}

test('audience selectors resolve to exact resource URLs, never the short enum', () => {
  const resolved = {
    product: resolveAccountKeyAudience('product', {
      productOrigin: PRODUCT_ORIGIN,
      mcpStrictAudience: MCP_STRICT,
    }),
    mcp_strict: resolveAccountKeyAudience('mcp_strict', {
      productOrigin: PRODUCT_ORIGIN,
      mcpStrictAudience: MCP_STRICT,
    }),
    mcp_compat: resolveAccountKeyAudience('mcp_compat', {
      productOrigin: PRODUCT_ORIGIN,
      mcpStrictAudience: MCP_STRICT,
    }),
  };
  assert.equal(resolved.product, PRODUCT_ORIGIN);
  assert.equal(resolved.mcp_strict, MCP_STRICT);
  assert.equal(resolved.mcp_compat, MCP_COMPAT);
  assert.notEqual(resolved.product, 'product');
  assert.throws(
    () => resolveAccountKeyAudience('mcp_strict', { productOrigin: PRODUCT_ORIGIN }),
    AccountKeyOAuthError,
  );
});

test('trailing slash is stripped from PRODUCT_ORIGIN', () => {
  assert.equal(
    resolveAccountKeyAudience('product', { productOrigin: 'https://app.example.test/' }),
    'https://app.example.test',
  );
});

test('token request parsing rejects extra fields, parent keys as grant, and forbidden scopes', () => {
  const supported = supportedAccountKeyScopes(['mcp:read:own', 'mcp:read:public']);
  const ok = parseAccountKeyTokenRequest({
    grant_type: ACCOUNT_KEY_GRANT_TYPE,
    credential: CHILD_SECRET,
    audience: 'product',
    scope: 'product:write product:read',
  }, supported);
  assert.equal(ok.audience, 'product');
  assert.deepEqual(ok.scopes, [PRODUCT_READ_SCOPE, PRODUCT_WRITE_SCOPE]);
  assert.equal(sortScopeTokens(ok.scopes), 'product:read product:write');

  const extra = parseAccountKeyTokenRequest({
    grant_type: ACCOUNT_KEY_GRANT_TYPE,
    credential: CHILD_SECRET,
    audience: 'product',
    scope: 'product:read',
    extra: true,
  }, supported);
  assert.equal(extra instanceof AccountKeyOAuthError, true);
  if (extra instanceof AccountKeyOAuthError) {
    assert.equal(extra.statusCode, 400);
    assert.equal(extra.error, 'invalid_request');
  }

  const parent = parseAccountKeyTokenRequest({
    grant_type: ACCOUNT_KEY_GRANT_TYPE,
    credential: CHILD_SECRET.replace('kn_c_', 'kn_p_'),
    audience: 'product',
    scope: 'product:read',
  }, supported);
  assert.equal(parent instanceof AccountKeyOAuthError, true);
  if (parent instanceof AccountKeyOAuthError) {
    assert.equal(parent.statusCode, 401);
    assert.equal(parent.error, 'invalid_grant');
  }

  const offline = parseAccountKeyTokenRequest({
    grant_type: ACCOUNT_KEY_GRANT_TYPE,
    credential: CHILD_SECRET,
    audience: 'product',
    scope: 'product:read offline_access',
  }, supported);
  assert.equal(offline instanceof AccountKeyOAuthError, true);
  if (offline instanceof AccountKeyOAuthError) {
    assert.equal(offline.statusCode, 400);
    assert.equal(offline.error, 'invalid_scope');
  }

  const unknownAud = parseAccountKeyTokenRequest({
    grant_type: ACCOUNT_KEY_GRANT_TYPE,
    credential: CHILD_SECRET,
    audience: 'mcp',
    scope: 'product:read',
  }, supported);
  assert.equal(unknownAud instanceof AccountKeyOAuthError, true);
  if (unknownAud instanceof AccountKeyOAuthError) {
    assert.equal(unknownAud.statusCode, 400);
    assert.equal(unknownAud.error, 'invalid_scope');
  }

  for (const body of [
    { grant_type: ACCOUNT_KEY_GRANT_TYPE, credential: CHILD_SECRET, audience: 'product' },
    { grant_type: ACCOUNT_KEY_GRANT_TYPE, credential: CHILD_SECRET, audience: 'product', scope: null },
    { grant_type: null, credential: CHILD_SECRET, audience: 'product', scope: 'product:read' },
    { grant_type: ACCOUNT_KEY_GRANT_TYPE, credential: null, audience: 'product', scope: 'product:read' },
  ]) {
    const parsed = parseAccountKeyTokenRequest(body, supported);
    assert.equal(parsed instanceof AccountKeyOAuthError, true, JSON.stringify(body));
    if (parsed instanceof AccountKeyOAuthError) {
      assert.equal(parsed.statusCode, 400);
      assert.equal(parsed.error, 'invalid_request');
    }
  }

  const tooLong = parseAccountKeyTokenRequest({
    grant_type: ACCOUNT_KEY_GRANT_TYPE,
    credential: CHILD_SECRET,
    audience: 'product',
    scope: `${'a'.repeat(2048)}b`,
  }, supported);
  assert.equal(tooLong instanceof AccountKeyOAuthError, true);
  if (tooLong instanceof AccountKeyOAuthError) {
    assert.equal(tooLong.statusCode, 400);
    assert.equal(tooLong.error, 'invalid_request');
  }
});

test('supported scopes preserve MCP entries, add product read/write, and omit offline_access', () => {
  const scopes = supportedAccountKeyScopes(['mcp:read:public', 'mcp:read:own', 'offline_access']);
  assert.deepEqual(scopes, [
    'mcp:read:own',
    'mcp:read:public',
    PRODUCT_READ_SCOPE,
    PRODUCT_WRITE_SCOPE,
  ]);
  assert.equal(scopes.includes('offline_access'), false);
});

test('ancestor epoch is lowercase SHA-256 of root-first id:epoch pairs', () => {
  const digest = ancestorEpochDigest([
    { id: 'grandparent', epoch: 1n },
    { id: 'parent-1', epoch: 3n },
  ]);
  const expected = createHash('sha256')
    .update('grandparent:1\0parent-1:3', 'utf8')
    .digest('hex');
  assert.equal(digest, expected);
  assert.match(digest, /^[0-9a-f]{64}$/u);
});

test('machine binding is stable across jti and uses NUL-joined authority fields', () => {
  const fields = {
    iss: ISSUER,
    clientId: '11111111-1111-4111-8111-111111111111',
    credentialId: 'cred-1',
    resourceAudience: MCP_STRICT,
    accountEpoch: '0',
    credentialEpoch: '1',
    ancestorEpochDigest: 'a'.repeat(64),
    serverSecurityEpoch: 'known.mcp.oauth.v1',
  };
  const first = machineCredentialBindingId(fields);
  const second = machineCredentialBindingId(fields);
  assert.equal(first, second);
  const expected = createHash('sha256').update([
    'known-machine-v1',
    fields.iss,
    fields.clientId,
    fields.credentialId,
    fields.resourceAudience,
    fields.accountEpoch,
    fields.credentialEpoch,
    fields.ancestorEpochDigest,
    fields.serverSecurityEpoch,
  ].join('\0'), 'utf8').digest('base64url');
  assert.equal(first, expected);
});

test('token route maps product transport errors onto OAuthError only', async () => {
  const { mapTokenRouteError } = await import('../../../src/transport/auth/account-credential-token-routes.js');
  const { ProductHttpError } = await import('../../../src/transport/product-error.js');
  const mapped = mapTokenRouteError(new ProductHttpError({
    statusCode: 400, code: 'invalid_json', message: 'The JSON body is invalid.',
  }));
  assert.equal(mapped.error, 'invalid_request');
  assert.equal(mapped.statusCode, 400);
  const limited = mapTokenRouteError(new ProductHttpError({
    statusCode: 429, code: 'rate_limited', message: 'Too many.', retryAfterSeconds: 4,
  }));
  assert.equal(limited.error, 'temporarily_unavailable');
  assert.equal(limited.statusCode, 429);
});

test('issuer signs ES256 with pinned kid and required machine claims', async () => {
  const privateJwk = testPrivateJwk('prod-kid');
  const now = new Date('2026-09-14T00:00:00.000Z');
  const subjectId = 'subject-ordinary';
  const clientId = randomUUID();
  const token = await signAccountKeyAccessToken({
    privateJwk,
    issuer: ISSUER,
    audienceUrl: PRODUCT_ORIGIN,
    subjectId,
    scopes: [PRODUCT_READ_SCOPE, PRODUCT_WRITE_SCOPE],
    credentialId: 'cred-child',
    accountEpoch: '0',
    credentialEpoch: '2',
    ancestorEpoch: ancestorEpochDigest([{ id: 'parent-1', epoch: 4n }]),
    clientId,
    now,
    ttlSeconds: 300,
  });
  const header = decodeProtectedHeader(token);
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'prod-kid');
  const claims = decodeJwt(token);
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.aud, PRODUCT_ORIGIN);
  assert.equal(claims.sub, subjectId);
  assert.equal(claims.client_id, clientId);
  assert.equal(claims.scope, 'product:read product:write');
  assert.equal(claims.known_credential_id, 'cred-child');
  assert.equal(claims.known_account_epoch, '0');
  assert.equal(claims.known_credential_epoch, '2');
  assert.equal(typeof claims.known_ancestor_epoch, 'string');
  assert.equal(typeof claims.jti, 'string');
  assert.equal(typeof claims.iat, 'number');
  assert.equal(typeof claims.nbf, 'number');
  assert.equal(claims.exp, Number(claims.iat) + 300);
  assert.equal('isBot' in claims, false);
  assert.equal('email_verified' in claims, false);
  assert.equal('secret' in claims, false);
  assert.equal('d' in claims, false);
  const publicJwk = publicJwkFromPrivate(privateJwk);
  assert.equal('d' in publicJwk, false);
  const verified = await jwtVerify(token, await importJWK(publicJwk, 'ES256'), {
    issuer: ISSUER,
    audience: PRODUCT_ORIGIN,
    algorithms: ['ES256'],
    currentDate: now,
  });
  assert.equal(verified.payload.sub, subjectId);
});

test('JWKS merge publishes current then previous keys without duplicating kids', () => {
  const current = publicJwkFromPrivate(testPrivateJwk('current-kid'));
  const previous = publicJwkFromPrivate(testPrivateJwk('previous-kid'));
  const merged = mergeAutomationJwks(
    { keys: [{ kid: 'current-kid', kty: 'EC' }, { kid: 'ba-kid', kty: 'OKP' }] },
    current,
    [previous],
  );
  assert.deepEqual(merged.keys.map((key) => key.kid), ['current-kid', 'previous-kid', 'ba-kid']);
  assert.equal('d' in (merged.keys[0] as object), false);
});

test('verifier accepts a previous configured public key after rotation overlap', async () => {
  const previous = testPrivateJwk('previous-kid');
  const current = testPrivateJwk('current-kid');
  const now = new Date('2026-09-14T00:00:00.000Z');
  const token = await signAccountKeyAccessToken({
    privateJwk: previous,
    issuer: ISSUER,
    audienceUrl: PRODUCT_ORIGIN,
    subjectId: 'subject-ordinary',
    scopes: [PRODUCT_READ_SCOPE],
    credentialId: 'cred-child',
    accountEpoch: '0',
    credentialEpoch: '1',
    ancestorEpoch: ancestorEpochDigest([{ id: 'parent-1', epoch: 1n }]),
    clientId: randomUUID(),
    now,
    ttlSeconds: 300,
  });
  const claims = await verifyAccountKeyJwt({
    token,
    issuer: ISSUER,
    audience: PRODUCT_ORIGIN,
    publicKeys: [publicJwkFromPrivate(current), publicJwkFromPrivate(previous)],
    now,
  });
  assert.equal(claims.kid, 'previous-kid');
  assert.equal(claims.sub, 'subject-ordinary');
});

test('JWKS onSend merges configured keys into the existing issuer document and rewrites Content-Length', async () => {
  const current = publicJwkFromPrivate(testPrivateJwk('ac02-es256'));
  const app = Fastify({ logger: false });
  registerAccountCredentialJwks(app, {
    enabled: true,
    oauthIssuerEnabled: true,
    publicKeys: [current],
  });
  app.get('/api/v1/auth/jwks', async (_request, reply) => {
    const original = JSON.stringify({ keys: [{ kid: 'ba-kid', kty: 'OKP' }] });
    reply.header('Content-Length', String(Buffer.byteLength(original)));
    return reply.type('application/json').send(original);
  });
  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/jwks' });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { keys: Array<{ kid: string }> };
  assert.deepEqual(body.keys.map((key) => key.kid), ['ac02-es256', 'ba-kid']);
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.body)));
  assert.equal(response.headers['cache-control'], 'no-store');
  await app.close();
});
