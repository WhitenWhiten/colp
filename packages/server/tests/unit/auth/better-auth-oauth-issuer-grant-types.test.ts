import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  BETTER_AUTH_OAUTH_ISSUER_GRANT_TYPES,
  buildBetterAuthOptions,
  type BetterAuthRuntimeConfig,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { builtinIssuerTestEnv } from '../../support/builtin-issuer-test-helpers.js';

function issuerOnEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef1',
    BETTER_AUTH_BODY_LIMIT_BYTES: '1024',
    ...builtinIssuerTestEnv(),
  };
}

test('mcp() advertises only the allowlisted grant types', () => {
  assert.deepEqual([...BETTER_AUTH_OAUTH_ISSUER_GRANT_TYPES], [
    'authorization_code',
    'refresh_token',
  ]);
  const config = loadConfig(issuerOnEnv());
  const built = buildBetterAuthConfig(config.betterAuth);
  assert.ok(built);
  const options = buildBetterAuthOptions({
    enabled: true,
    config: built as BetterAuthRuntimeConfig,
    database: { db: {} as never, type: 'postgres', transaction: true },
  });
  const mcpPlugin = (options.plugins ?? []).find((plugin) => plugin.id === 'oauth-provider') as {
    readonly options?: { readonly grantTypes?: readonly string[]; readonly scopes?: readonly string[] };
  } | undefined;
  assert.deepEqual(mcpPlugin?.options?.grantTypes, ['authorization_code', 'refresh_token']);
  assert.equal(mcpPlugin?.options?.grantTypes?.includes('client_credentials'), false);
  assert.ok(mcpPlugin?.options?.scopes?.includes('offline_access'));
});
