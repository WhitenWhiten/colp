import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import type { IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  productionEnv,
  testEnv,
} from '../../support/http-security-config-env.js';

function emptyIdentityUnitOfWork(): IdentityUnitOfWork {
  return {
    execute: async () => {
      throw new Error('identity work not expected in http-security tests');
    },
  };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];

function searchSharedEnv(overrides: Record<string, string> = {}) {
  return {
    SEARCH_RATE_LIMIT_SHARED: 'true',
    SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
    ...overrides,
  };
}

function insightsSharedEnv(overrides: Record<string, string> = {}) {
  return {
    PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED: 'true',
    PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  };
}

function collaborationInviteSharedEnv(overrides: Record<string, string> = {}) {
  return {
    COLLABORATION_INVITE_RATE_LIMIT_SHARED: 'true',
    COLLABORATION_INVITE_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'collaboration-invite-rate-limit-hmac-secret',
    ...overrides,
  };
}

function exploreDirectorySharedEnv(overrides: Record<string, string> = {}) {
  return {
    EXPLORE_DIRECTORY_RATE_LIMIT_SHARED: 'true',
    EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET: 'explore-directory-rate-limit-hmac-secret',
    PUBLIC_ACTIVITY_RATE_LIMIT_SHARED: 'true',
    PUBLIC_ACTIVITY_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET: 'public-activity-rate-limit-hmac-secret',
    PRODUCT_ROUTE_RATE_LIMIT_SHARED: 'true',
    PRODUCT_ROUTE_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET: 'product-route-rate-limit-hmac-secret',
    ...overrides,
  };
}

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
});

describe('shared MCP rate-limit adapter config (FIX-M-018)', () => {
  /** Auth shared adapter env (local copy: the FIX-M-001 helper is describe-scoped). */
  const authSharedEnv = (overrides: Record<string, string> = {}) => ({
    AUTH_RATE_LIMIT_SHARED: 'true',
    AUTH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_RATE_LIMIT_KEY_SECRET: 'auth-rate-limit-hmac-secret-001',
    ...overrides,
  });

  /** Minimal MCP Read feature env (test and production shapes). */
  const mcpFeatureEnv = (overrides: Record<string, string> = {}) => ({
    KNOWN_FEATURE_MCP_READ: 'true',
    // testEnv leaves PUBLICATION_SERVER_UUID at the DEV default, so the
    // anti-drift check needs MCP_SERVER_UUID to match it here; the
    // production shape overrides BOTH through mcpProdEnv.
    MCP_SERVER_UUID: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: 'https://collections.example.test',
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'collections:read',
    MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_KEY_ID: 'mcp-collection-resource-v1',
    // Canonical base64 >= 32 bytes: accepted in test mode and required by the
    // production shape (mcpProdEnv only overrides the key id).
    MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 31).toString('base64'),
    MCP_REQUEST_RATE_LIMIT_MAX: '120',
    MCP_REQUEST_RATE_LIMIT_WINDOW_MS: '60000',
    ...overrides,
  });

  const mcpSharedEnv = (overrides: Record<string, string> = {}) => ({
    MCP_RATE_LIMIT_SHARED: 'true',
    MCP_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    MCP_RATE_LIMIT_KEY_SECRET: 'mcp-rate-limit-hmac-secret-018',
    ...overrides,
  });

  test('disabled by default; enabled parses URL/secret/prefix/timeouts fail closed', () => {
    const defaults = loadConfig(testEnv());
    assert.equal(defaults.mcpRateLimit.enabled, false);
    assert.equal(defaults.mcpRateLimit.redisUrl, null);
    assert.equal(defaults.mcpRateLimit.keySecret, null);
    assert.equal(defaults.mcpRateLimit.keyPrefix, 'known');
    assert.equal(defaults.mcpRateLimit.commandTimeoutMs, 75);
    assert.equal(defaults.mcpRateLimit.connectTimeoutMs, 1000);
    assert.equal(defaults.mcpRateLimit.maxRetriesPerRequest, 1);

    const enabled = loadConfig(testEnv(mcpSharedEnv({
      MCP_RATE_LIMIT_KEY_PREFIX: 'mcp-test',
      MCP_RATE_LIMIT_COMMAND_TIMEOUT_MS: '250',
      MCP_RATE_LIMIT_CONNECT_TIMEOUT_MS: '2000',
      MCP_RATE_LIMIT_MAX_RETRIES_PER_REQUEST: '2',
    })));
    const shared = enabled.mcpRateLimit;
    assert.equal(shared.enabled, true);
    assert.equal(shared.redisUrl, 'redis://127.0.0.1:6379');
    assert.equal(shared.keySecret?.toString('utf8'), 'mcp-rate-limit-hmac-secret-018');
    assert.equal(shared.keyPrefix, 'mcp-test');
    assert.equal(shared.commandTimeoutMs, 250);
    assert.equal(shared.connectTimeoutMs, 2000);
    assert.equal(shared.maxRetriesPerRequest, 2);
  });

  test('shared=true without URL or secret fails closed; invalid values are rejected', () => {
    assert.throws(
      () => loadConfig(testEnv({ MCP_RATE_LIMIT_SHARED: 'true' })),
      /MCP_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => loadConfig(testEnv(mcpSharedEnv({ MCP_RATE_LIMIT_REDIS_URL: '' }))),
      /MCP_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => loadConfig(testEnv(mcpSharedEnv({ MCP_RATE_LIMIT_KEY_SECRET: '' }))),
      /MCP_RATE_LIMIT_KEY_SECRET is required/,
    );
    assert.throws(
      () => loadConfig(testEnv({ MCP_RATE_LIMIT_SHARED: 'maybe' })),
      /MCP_RATE_LIMIT_SHARED must be true or false/,
    );
    assert.throws(
      () => loadConfig(testEnv(mcpSharedEnv({ MCP_RATE_LIMIT_REDIS_URL: 'http://127.0.0.1:6379' }))),
      /MCP_RATE_LIMIT_REDIS_URL must use redis:\/\/ or rediss:\/\//,
    );
    assert.throws(
      () => loadConfig(testEnv(mcpSharedEnv({ MCP_RATE_LIMIT_KEY_PREFIX: 'bad prefix!' }))),
      /MCP_RATE_LIMIT_KEY_PREFIX/,
    );
    assert.throws(
      () => loadConfig(testEnv(mcpSharedEnv({ MCP_RATE_LIMIT_COMMAND_TIMEOUT_MS: '99999' }))),
      /MCP_RATE_LIMIT_COMMAND_TIMEOUT_MS/,
    );
  });

  test('production multi-replica MCP without the shared limiter fails startup', () => {
    const mcpProdEnv = (overrides: Record<string, string> = {}) => productionEnv(mcpFeatureEnv({
      MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_KEY_ID: 'prod-mcp-collection-v1',
      // productionEnv declares PUBLICATION_SERVER_UUID 019f9031…; the MCP
      // serverUuid must match it (anti-drift) or the gate never runs.
      MCP_SERVER_UUID: '019f9031-c541-74d0-bc83-15a5526fbb54',
      // AM-07: production + JWKS requires postgres revocation before later
      // replica limiter gates can run.
      MCP_OAUTH_REVOCATION_STORE: 'postgres',
      ...overrides,
    }));
    // MCP enabled + production + replicas>1 without the shared limiter fails
    // (the auth/search shared adapters are present so the MCP gate is the
    // one that fails startup).
    assert.throws(
      () => loadConfig(mcpProdEnv(authSharedEnv(searchSharedEnv(insightsSharedEnv(collaborationInviteSharedEnv(exploreDirectorySharedEnv({ AUTH_API_REPLICAS: '2' }))))))),
      /AUTH_API_REPLICAS > 1.*MCP_RATE_LIMIT_SHARED=true/s,
    );
    // Single-instance production with MCP keeps the in-process limiter.
    assert.doesNotThrow(() => loadConfig(mcpProdEnv()));
    // MCP disabled does not force the shared limiter in multi-replica.
    assert.doesNotThrow(() => loadConfig(productionEnv(authSharedEnv(searchSharedEnv(insightsSharedEnv(collaborationInviteSharedEnv(exploreDirectorySharedEnv({ AUTH_API_REPLICAS: '2' }))))))));
    // Multi-replica production WITH the shared MCP adapter is valid.
    const ok = loadConfig(mcpProdEnv(mcpSharedEnv(authSharedEnv(searchSharedEnv(insightsSharedEnv(collaborationInviteSharedEnv(exploreDirectorySharedEnv({ AUTH_API_REPLICAS: '2' }))))))));
    assert.equal(ok.httpSecurity.authApiReplicas, 2);
    assert.equal(ok.mcpRateLimit.enabled, true);
    assert.equal(ok.mcpRateLimit.redisUrl, 'redis://127.0.0.1:6379');
    // Non-production multi-replica may keep the in-process limiter.
    assert.doesNotThrow(() => loadConfig(testEnv(mcpFeatureEnv({ AUTH_API_REPLICAS: '2' }))));
  });

  test('shared adapter enabled without an injected mcpRateLimiter fails closed at composition', () => {
    const config = loadConfig(testEnv(mcpFeatureEnv(mcpSharedEnv())));
    assert.equal(config.mcpRateLimit.enabled, true);
    assert.throws(
      () => buildApiApp({ config, identityUnitOfWork: emptyIdentityUnitOfWork() }),
      /injected mcpRateLimiter.*MCP_RATE_LIMIT_SHARED=true/s,
    );
    // MCP disabled with the shared flag configured is inert at composition.
    const noMcp = loadConfig(testEnv(mcpSharedEnv()));
    const inert = buildApiApp({ config: noMcp, identityUnitOfWork: emptyIdentityUnitOfWork() });
    apps.push(inert);
  });
});
