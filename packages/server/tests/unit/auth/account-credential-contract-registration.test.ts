import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, test } from 'vitest';
import { PRODUCT_ROUTE_MANIFEST } from '../../../generated/openapi/product-v1.routes.js';
import { loadConfig } from '../../support/test-config.js';
import type { PostgresAccountCredentialUnitOfWork } from '../../../src/infrastructure/auth/account-credentials-postgres.js';
import type { IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { AUTH_ROUTE_MANIFEST } from '../../../src/transport/auth/auth-route-manifest.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { productionEnv } from '../../support/http-security-config-env.js';

const ACCOUNT_CREDENTIAL_OPERATION_IDS = [
  'issueChildWithParentKey', 'listChildrenWithParentKey', 'getChildWithParentKey',
  'rotateChildWithParentKey', 'revokeChildWithParentKey', 'exchangeAccountKey', 'getCredentialIdentity',
  'listCredentialGrants', 'createCredentialGrant', 'getCredentialGrant',
  'revokeCredentialGrant', 'authorizePlanWithCredentialGrant', 'getCredentialPlan',
] as const;

const PARENT_KEY_OPERATION_IDS = [
  'issueChildWithParentKey',
  'listChildrenWithParentKey',
  'getChildWithParentKey',
  'rotateChildWithParentKey',
  'revokeChildWithParentKey',
  'exchangeAccountKey',
] as const;

const CREDENTIAL_ROUTE_SAMPLES = [
  { method: 'GET', url: '/api/v1/me/credentials' },
  { method: 'POST', url: '/api/v1/me/credential-parents' },
  { method: 'POST', url: '/api/v1/auth/key-token' },
  { method: 'GET', url: '/api/v1/me/credential-identity' },
  { method: 'GET', url: '/api/v1/me/credential-grants' },
] as const;

const unusedUnitOfWork = {
  async execute(): Promise<never> {
    throw new Error('unused');
  },
};
const identityUnitOfWork = unusedUnitOfWork as IdentityUnitOfWork;
const accountCredentialUnitOfWork = unusedUnitOfWork as PostgresAccountCredentialUnitOfWork;

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
});

function testEs256Jwk(kid = 'acct-cred-test-kid'): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return JSON.stringify({ ...jwk, kid, kty: 'EC', crv: 'P-256' });
}

test('Product OpenAPI and auth manifest register every AC-01..05 operation', () => {
  const product = new Map(PRODUCT_ROUTE_MANIFEST.map((entry) => [entry.operationId, entry]));
  for (const operationId of ACCOUNT_CREDENTIAL_OPERATION_IDS) {
    assert.equal(product.has(operationId), true, `missing Product operation ${operationId}`);
  }
  assert.equal(ACCOUNT_CREDENTIAL_OPERATION_IDS.length, 13);
  for (const operationId of PARENT_KEY_OPERATION_IDS) {
    const auth = AUTH_ROUTE_MANIFEST.find((entry) => entry.operationId === operationId);
    assert.equal(auth?.status, 'registered', `${operationId} is not a registered auth-owned route`);
  }
});

test('feature-off does not register account credential surfaces', async () => {
  const app = buildApiApp({
    config: loadConfig(productionEnv()),
    identityUnitOfWork,
    accountCredentialUnitOfWork,
  });
  apps.push(app);
  for (const route of CREDENTIAL_ROUTE_SAMPLES) {
    assert.equal(
      app.hasRoute(route),
      false,
      `${route.method} ${route.url} must stay unregistered when the feature is off`,
    );
  }
  const listed = await app.inject({ method: 'GET', url: '/api/v1/me/credentials' });
  assert.equal(listed.statusCode, 404);
  const token = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/key-token',
    headers: { 'content-type': 'application/json' },
    payload: { grant_type: 'urn:known:params:oauth:grant-type:account-key' },
  });
  assert.equal(token.statusCode, 404);
});

test('feature-on registers account credential surfaces when identity and unit of work exist', () => {
  const app = buildApiApp({
    config: loadConfig(productionEnv({
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true',
      AUTOMATION_CURSOR_HMAC_KEY: Buffer.alloc(32, 13).toString('base64url'),
      AUTOMATION_ES256_PRIVATE_JWK: testEs256Jwk(),
    })),
    identityUnitOfWork,
    accountCredentialUnitOfWork,
  });
  apps.push(app);
  for (const route of CREDENTIAL_ROUTE_SAMPLES) {
    assert.equal(
      app.hasRoute(route),
      !['/api/v1/me/credentials', '/api/v1/me/credential-parents'].includes(route.url),
      `${route.method} ${route.url} must match the operator-only surface`,
    );
  }
});
