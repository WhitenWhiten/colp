import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createBetterAuthRuntime } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { builtinIssuerTestEnv } from '../../support/builtin-issuer-test-helpers.js';
import {
  openBetterAuthPostgres,
  type BetterAuthPostgresFixture,
} from '../../support/better-auth-postgres.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const REGISTER_PATH = '/api/v1/auth/oauth2/register';

let fixture: BetterAuthPostgresFixture;
let app: ReturnType<typeof buildApiApp>;

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: TRUSTED_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef1',
    BETTER_AUTH_DCR_MAX_ANONYMOUS_CLIENTS: '1',
    BETTER_AUTH_DCR_UNUSED_CLIENT_RETENTION_SECONDS: '60',
    ...builtinIssuerTestEnv(),
  });
  const built = buildBetterAuthConfig(config.betterAuth);
  assert.ok(built);
  fixture = await openBetterAuthPostgres(built);
  const runtime = createBetterAuthRuntime({
    enabled: true,
    config: built,
    database: { db: fixture.db, type: 'postgres', transaction: true },
  });
  assert.ok(runtime);
  app = buildApiApp({ config, betterAuthRuntime: runtime });
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await fixture?.close();
});

function registration(
  clientName: string,
  policyMetadata: Record<string, unknown> = {
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  },
) {
  return app.inject({
    method: 'POST',
    url: REGISTER_PATH,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      client_name: clientName,
      redirect_uris: ['http://127.0.0.1:8943/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      ...policyMetadata,
    }),
  });
}

test('the HTTP DCR route persists at most the configured anonymous-client capacity', async () => {
  for (const [metadata, description] of [
    [{ application_type: 'native' }, 'missing token endpoint auth method'],
    [{ token_endpoint_auth_method: 'client_secret_basic', application_type: 'native' }, 'confidential client'],
    [{ token_endpoint_auth_method: 'none' }, 'missing application type'],
  ] as const) {
    const rejected = await registration(`rejected-${description.replaceAll(' ', '-')}`, metadata);
    assert.equal(rejected.statusCode, 400);
    assert.equal((rejected.json() as { error?: unknown }).error, 'invalid_client_metadata');
  }
  const beforeValid = await fixture.adminPool.query(
    `SELECT (SELECT count(*) FROM "${fixture.schemaName}"."auth_oauth_client")::int AS clients,
            (SELECT count(*) FROM "${fixture.schemaName}"."auth_oauth_dcr_registration")::int AS registrations`,
  );
  assert.deepEqual(
    beforeValid.rows[0],
    { clients: 0, registrations: 0 },
    'policy-rejected requests must not reach Better Auth or consume a capacity slot',
  );

  const first = await registration('capacity-first');
  assert.equal(first.statusCode, 201, first.body);
  const firstBody = first.json() as {
    client_id?: unknown;
    client_secret?: unknown;
    token_endpoint_auth_method?: unknown;
    application_type?: unknown;
  };
  assert.equal(typeof firstBody.client_id, 'string');
  assert.equal(firstBody.client_secret, undefined, 'public DCR must never mint a client secret');
  assert.equal(firstBody.token_endpoint_auth_method, 'none');
  assert.equal(firstBody.application_type, 'native');

  const second = await registration('capacity-second');
  assert.equal(second.statusCode, 503);
  assert.equal(second.headers['cache-control'], 'no-store');
  assert.equal(second.headers['retry-after'], '60');
  assert.deepEqual(second.json(), {
    error: 'temporarily_unavailable',
    error_description: 'Dynamic client registration capacity is temporarily unavailable.',
  });

  const clients = await fixture.adminPool.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE "clientSecret" IS NOT NULL)::int AS secrets
     FROM "${fixture.schemaName}"."auth_oauth_client"`,
  );
  const registrations = await fixture.adminPool.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE "clientId" IS NULL)::int AS pending
     FROM "${fixture.schemaName}"."auth_oauth_dcr_registration"`,
  );
  assert.deepEqual(clients.rows[0], { n: 1, secrets: 0 }, 'no rejected request may persist a secret/client');
  assert.deepEqual(registrations.rows[0], { n: 1, pending: 0 });

  const malformedSession = await app.inject({
    method: 'POST',
    url: REGISTER_PATH,
    headers: {
      'content-type': 'application/json',
      cookie: '__Host-known_session=not-a-valid-session',
    },
    payload: JSON.stringify({
      client_name: 'malformed-session',
      redirect_uris: ['http://127.0.0.1:8943/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });
  assert.equal(malformedSession.statusCode, 503, 'a malformed cookie must not take the owned bypass');
  assert.deepEqual(malformedSession.json(), {
    error: 'temporarily_unavailable',
    error_description: 'Dynamic client registration capacity is temporarily unavailable.',
  });
});
