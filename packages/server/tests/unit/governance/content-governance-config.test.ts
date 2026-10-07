import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { phase4bMcpOnEnv } from '../../support/phase4b-mcp-config-env.js';

const env = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};
const hmac = Buffer.alloc(32, 9).toString('base64url');
const GOVERNANCE_MCP_SCOPE_ERROR =
  /KNOWN_FEATURE_CONTENT_GOVERNANCE requires product:read and product:write in MCP_OAUTH_SCOPES/u;

test('content governance defaults off and does not require a cursor key', () => {
  const config = loadConfig(env);
  assert.equal(config.contentGovernance.enabled, false);
  assert.equal(config.contentGovernance.cursorHmacKey, null);
  assert.equal(config.contentGovernance.evidenceMaxBytes, 65536);
  assert.equal(config.contentGovernance.evidenceRetentionDays, 365);
  assert.deepEqual(config.contentGovernance.reportRate, { maxRequests: 10, windowMs: 3_600_000 });
  assert.deepEqual(config.contentGovernance.actionRate, { maxRequests: 60, windowMs: 60_000 });
  assert.deepEqual(config.contentGovernance.appealRate, { maxRequests: 10, windowMs: 86_400_000 });
});

test('content governance on without GOVERNANCE_CURSOR_HMAC_KEY fails startup', () => {
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_CONTENT_GOVERNANCE: 'true' }),
    /GOVERNANCE_CURSOR_HMAC_KEY is required/u,
  );
});

test('content governance on requires a canonical 32-byte base64url secret', () => {
  const enabled = loadConfig({
    ...env,
    KNOWN_FEATURE_CONTENT_GOVERNANCE: 'true',
    GOVERNANCE_CURSOR_HMAC_KEY: hmac,
  }).contentGovernance;
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.cursorHmacKey, hmac);
  assert.throws(
    () => loadConfig({
      ...env,
      KNOWN_FEATURE_CONTENT_GOVERNANCE: 'true',
      GOVERNANCE_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
    }),
    /canonical base64url/u,
  );
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_CONTENT_GOVERNANCE: 'yes' }),
    /must be true or false/u,
  );
});

test('TRUE enables HTTP governance and the MCP product-scope check the same as true', () => {
  const uppercase = loadConfig({
    ...env,
    KNOWN_FEATURE_CONTENT_GOVERNANCE: 'TRUE',
    GOVERNANCE_CURSOR_HMAC_KEY: hmac,
  }).contentGovernance;
  assert.equal(uppercase.enabled, true);
  for (const flag of ['true', 'TRUE'] as const) {
    assert.throws(
      () => loadConfig(phase4bMcpOnEnv({
        KNOWN_FEATURE_CONTENT_GOVERNANCE: flag,
        GOVERNANCE_CURSOR_HMAC_KEY: hmac,
      })),
      GOVERNANCE_MCP_SCOPE_ERROR,
    );
  }
  const withScopes = loadConfig(phase4bMcpOnEnv({
    KNOWN_FEATURE_CONTENT_GOVERNANCE: 'TRUE',
    GOVERNANCE_CURSOR_HMAC_KEY: hmac,
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own,product:read,product:write',
  }));
  assert.equal(withScopes.contentGovernance.enabled, true);
  assert.ok(withScopes.mcp);
});
