import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_CONFIG_DEFAULT_I_JSON_LIMITS,
  PHASE4B_MCP_CONFIG_I_JSON_LIMIT_MAX,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_CONFIG_PROTOCOL_VERSION,
  PHASE4B_MCP_CONFIG_REQUEST_BUDGET_MAX,
  PHASE4B_MCP_FORBIDDEN_LEGACY_ENV_KEYS,
  assertMcpReadFeatureConfig,
  assertPhase4bMcpIJsonLimitConfig,
  createMcpReadProtectedResourceMetadata,
  createPhase4bMcpResourceIdentity,
  mcpReadFeatureConfigAssertOptions,
} from '../../../src/modules/mcp/index.js';
import { loadMcpReadFeatureConfig } from '../../../src/bootstrap/config-mcp.js';
import {
  PHASE4B_MCP_ENDPOINT_PATH,
  PHASE4B_MCP_HARD_LIMITS,
  PHASE4B_MCP_PROTOCOL_VERSION,
} from '../../../scripts/evidence/phase4b-mcp-entry-contract.js';
import {
  PHASE4B_MCP_BUILTIN_AS_METADATA_URL,
  PHASE4B_MCP_BUILTIN_ISSUER,
  PHASE4B_MCP_BUILTIN_JWKS_URI,
  PHASE4B_MCP_CONFIG_SERVER_UUID as SERVER_UUID,
  phase4bMcpConfigBaseEnv as baseEnv,
  phase4bMcpOnEnv as onEnv,
  phase4bMcpProdEnv as prodEnv,
} from '../../support/phase4b-mcp-config-env.js';

test('MCP exposure defaults closed and requires no MCP-specific configuration', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.mcp, undefined, 'MCP section must be absent when the feature flag is off');
  assert.equal(config.publication.serverUuid, SERVER_UUID);
});

test('report MCP flags cannot silently disable the shared MCP Read runtime', () => {
  assert.throws(
    () => loadMcpReadFeatureConfig(
      { ...baseEnv, KNOWN_FEATURE_MCP_READ: 'false' },
      'test',
      'https://collections.example.test',
      SERVER_UUID,
      { reportsMcpEnabled: true },
    ),
    /KNOWN_FEATURE_REPORTS_MCP requires KNOWN_FEATURE_MCP_READ=true/u,
  );
});

test('report MCP write config requires both write and publish scopes', () => {
  assert.throws(
    () => loadMcpReadFeatureConfig(
      onEnv({ MCP_OAUTH_SCOPES: 'reports:read' }),
      'test',
      'https://collections.example.test',
      SERVER_UUID,
      { reportsMcpEnabled: true, reportsMcpWriteEnabled: true },
    ),
    /reports:write and reports:publish/u,
  );
  const config = loadMcpReadFeatureConfig(
    onEnv({ MCP_OAUTH_SCOPES: 'reports:read,reports:write,reports:publish' }),
    'test',
    'https://collections.example.test',
    SERVER_UUID,
    { reportsMcpEnabled: true, reportsMcpWriteEnabled: true },
  );
  assert.ok(config);
  assert.deepEqual(config.oauth.scopes, ['reports:read', 'reports:write', 'reports:publish']);
});

test('MCP config freezes endpoint/protocol and binds budgets to the R01 hard limits', () => {
  const config = loadConfig(onEnv()).mcp!;
  assert.ok(config, 'MCP section must be present when enabled');
  assert.equal(config.enabled, true);
  assert.equal(config.protocolVersion, '2026-07-28');
  assert.equal(config.endpointPath, '/collections/-/mcp');
  assert.equal(config.origin, 'https://collections.example.test');
  assert.equal(config.endpoint, 'https://collections.example.test/collections/-/mcp');
  assert.equal(config.serverUuid, SERVER_UUID);
  // Config constants must agree with the R01 transport entry contract.
  assert.equal(PHASE4B_MCP_CONFIG_PROTOCOL_VERSION, PHASE4B_MCP_PROTOCOL_VERSION);
  assert.equal(PHASE4B_MCP_CONFIG_ENDPOINT_PATH, PHASE4B_MCP_ENDPOINT_PATH);
  assert.equal(config.budgets.request.maxBodyBytes, PHASE4B_MCP_HARD_LIMITS.maxBodyBytes);
  assert.equal(config.budgets.request.maxHeaderCount, PHASE4B_MCP_HARD_LIMITS.maxHeaderCount);
  assert.equal(config.budgets.request.maxHeaderNameBytes, PHASE4B_MCP_HARD_LIMITS.maxHeaderNameBytes);
  assert.equal(config.budgets.request.maxHeaderValueBytes, PHASE4B_MCP_HARD_LIMITS.maxHeaderValueBytes);
  assert.equal(config.budgets.request.maxConcurrent, PHASE4B_MCP_HARD_LIMITS.maxConcurrent);
  assert.equal(config.budgets.request.maxQueue, PHASE4B_MCP_HARD_LIMITS.maxQueue);
  assert.equal(config.budgets.listen.maxConnections, 16);
  assert.equal(config.budgets.output.maxDepth, 16);
  assert.deepEqual(config.budgets.strictIJson, PHASE4B_MCP_CONFIG_DEFAULT_I_JSON_LIMITS);
  assert.equal(Object.isFrozen(config.budgets.strictIJson), true);
  assert.deepEqual(config.requestRateLimit, { maxRequests: 120, windowMs: 60_000 });
  assert.deepEqual(config.oauth.scopes, ['mcp:read:public', 'mcp:read:own']);
  assert.equal(config.oauth.revocationStore, 'none');
  assert.equal(config.collectionResources.cursorTtlMs, 900_000);
  assert.equal(config.collectionResources.cursorKeys.active.id, 'mcp-collection-resource-v1');
  assert.equal('clientId' in config.oauth, false);
});

test('MCP OAuth revocation store wiring defaults closed and validates explicit values', () => {
  assert.throws(
    () => loadConfig(onEnv({ MCP_OAUTH_REVOCATION_STORE: 'redis' })),
    /MCP_OAUTH_REVOCATION_STORE must be 'postgres' or 'none'/u,
  );
  assert.throws(
    () => loadConfig(onEnv({ MCP_OAUTH_REVOCATION_STORE: 'pg' })),
    /MCP_OAUTH_REVOCATION_STORE must be 'postgres' or 'none'/u,
  );

  const postgres = loadConfig(onEnv({ MCP_OAUTH_REVOCATION_STORE: 'postgres' })).mcp!;
  assert.equal(postgres.oauth.revocationStore, 'postgres');
  assert.equal(Object.isFrozen(postgres.oauth), true);
  // Env flag parsing is case-insensitive like every other feature flag.
  const mixedCase = loadConfig(onEnv({ MCP_OAUTH_REVOCATION_STORE: 'Postgres' })).mcp!;
  assert.equal(mixedCase.oauth.revocationStore, 'postgres');
});

test('flag on requires every MCP value (fail closed on missing values)', () => {
  const required = [
    'MCP_SERVER_UUID',
    'MCP_ALLOWED_ORIGINS',
    'MCP_OAUTH_ISSUER',
    'MCP_OAUTH_AUDIENCE',
    'MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL',
    'MCP_OAUTH_SCOPES',
  ];
  for (const key of required) {
    assert.throws(
      () => loadConfig(onEnv({ [key]: undefined })),
      new RegExp(key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `${key} must be required when the flag is on`,
    );
  }
  assert.throws(() => loadConfig(onEnv({ KNOWN_FEATURE_MCP_READ: 'yes' })),
    /KNOWN_FEATURE_MCP_READ must be true or false/u);
  assert.throws(() => loadConfig(onEnv({ MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:public' })),
    /must be unique/u);
  assert.throws(() => loadConfig(onEnv({ MCP_OAUTH_SCOPES: 'BadScope' })),
    /MCP_OAUTH_SCOPES entry is invalid/u);
});

test('serverUuid drift from Publication is rejected', () => {
  assert.throws(
    () => loadConfig(onEnv({ MCP_SERVER_UUID: '019f9031-c541-74d0-bc83-15a5526fbb54' })),
    /serverUuid drift/u,
  );
  // Format is checked before drift: malformed values must fail closed as format errors.
  assert.throws(
    () => loadConfig(onEnv({ MCP_SERVER_UUID: '019B3C67-A03C-7F02-9C7E-1EE8D50A77DE' })),
    /lowercase UUID/u,
  );
  assert.throws(
    () => loadConfig(onEnv({ MCP_SERVER_UUID: 'not-a-uuid' })),
    /lowercase UUID/u,
  );
});

test('invalid origins and OAuth URLs are rejected', () => {
  for (const origin of [
    'not-a-url',
    'https://app.example.test/path',
    'https://user:pass@example.test',
    'http://app.example.test',
    'https://app.example.test?x=1',
    '',
  ]) {
    assert.throws(() => loadConfig(onEnv({ MCP_ALLOWED_ORIGINS: origin })),
      /MCP_ALLOWED_ORIGINS|https/u, `origin ${origin} must be rejected`);
  }
  assert.throws(() => loadConfig(onEnv({ MCP_OAUTH_ISSUER: 'http://issuer.example.test' })),
    /https/u);
  assert.throws(() => loadConfig(onEnv({ MCP_OAUTH_ISSUER: 'not-a-url' })),
    /MCP OAuth issuer/u);
  assert.throws(() => loadConfig(onEnv({ MCP_OAUTH_AUDIENCE: 'https://user:pass@x.test' })),
    /MCP OAuth audience/u);
  assert.throws(() => loadConfig(onEnv({ MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: 'ftp://x.test' })),
    /https/u);
  assert.throws(() => loadConfig(onEnv({ MCP_OAUTH_JWKS_URI: 'http://issuer.example.test/jwks' })),
    /https/u);
});

test('MCP OAuth egress endpoints reject loopback, private, link-local, mapped and metadata hosts at startup', () => {
  const denied: ReadonlyArray<readonly [key: string, value: string]> = [
    ['MCP_OAUTH_ISSUER', 'https://127.0.0.1:8443/realms/known'],
    ['MCP_OAUTH_ISSUER', 'https://localhost/realms/known'],
    ['MCP_OAUTH_ISSUER', 'https://10.0.0.5/realms/known'],
    ['MCP_OAUTH_ISSUER', 'https://172.16.0.9/realms/known'],
    ['MCP_OAUTH_ISSUER', 'https://192.168.1.10/realms/known'],
    ['MCP_OAUTH_ISSUER', 'https://169.254.169.254/latest/meta-data'],
    ['MCP_OAUTH_ISSUER', 'https://[fe80::1]/realms/known'],
    ['MCP_OAUTH_ISSUER', 'https://[::1]/realms/known'],
    ['MCP_OAUTH_ISSUER', 'https://[::ffff:127.0.0.1]/realms/known'],
    ['MCP_OAUTH_ISSUER', 'https://metadata.google.internal/realms/known'],
    ['MCP_OAUTH_AUDIENCE', 'https://10.1.2.3/collections/-/mcp'],
    ['MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL', 'https://169.254.169.254/.well-known/oauth-authorization-server'],
    ['MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL', 'https://metadata/oauth-authorization-server'],
    ['MCP_OAUTH_JWKS_URI', 'https://127.0.0.1:8443/certs'],
    ['MCP_OAUTH_JWKS_URI', 'https://100.64.0.1/certs'],
    ['MCP_OAUTH_JWKS_URI', 'https://[fd00:ec2::254]/certs'],
    ['MCP_OAUTH_JWKS_URI', 'https://[::ffff:10.0.0.1]/certs'],
  ];
  for (const [key, value] of denied) {
    assert.throws(
      () => loadConfig(onEnv({ [key]: value })),
      /must not target/u,
      `${key}=${value} must fail closed at startup`,
    );
  }
  // Public static URLs remain accepted.
  const ok = loadConfig(onEnv()).mcp!;
  assert.equal(ok.oauth.jwksUri, PHASE4B_MCP_BUILTIN_JWKS_URI);
  assert.equal(ok.oauth.issuer, PHASE4B_MCP_BUILTIN_ISSUER);
  assert.equal(ok.oauth.authorizationServerMetadataUrl, PHASE4B_MCP_BUILTIN_AS_METADATA_URL);
});

test('budget boundaries: R01 limits are accepted and anything stricter-than-equal is rejected', () => {
  const atLimits = onEnv({
    MCP_REQUEST_MAX_BODY_BYTES: '65536',
    MCP_REQUEST_MAX_HEADER_COUNT: '64',
    MCP_REQUEST_MAX_HEADER_NAME_BYTES: '128',
    MCP_REQUEST_MAX_HEADER_VALUE_BYTES: '4096',
    MCP_REQUEST_MAX_CONCURRENT: '1',
    MCP_REQUEST_MAX_QUEUE: '2',
    MCP_REQUEST_RATE_LIMIT_MAX: '10000',
    MCP_REQUEST_RATE_LIMIT_WINDOW_MS: '3600000',
    MCP_LISTEN_MAX_CONNECTIONS: '1024',
    MCP_LISTEN_MAX_QUEUE_BYTES: '1048576',
    MCP_LISTEN_MAX_DURATION_MS: '86400000',
    MCP_OUTPUT_MAX_BYTES: '16777216',
    MCP_OUTPUT_MAX_ITEMS: '100000',
    MCP_OUTPUT_MAX_DEPTH: '64',
  });
  const config = loadConfig(atLimits).mcp!;
  assert.equal(config.budgets.request.maxBodyBytes, 65_536);
  assert.equal(config.budgets.listen.maxConnections, 1_024);
  assert.equal(config.budgets.output.maxDepth, 64);
  assert.deepEqual(config.requestRateLimit, { maxRequests: 10_000, windowMs: 3_600_000 });

  const above: ReadonlyArray<[string, string]> = [
    ['MCP_REQUEST_MAX_BODY_BYTES', '65537'],
    ['MCP_REQUEST_MAX_HEADER_COUNT', '65'],
    ['MCP_REQUEST_MAX_HEADER_NAME_BYTES', '129'],
    ['MCP_REQUEST_MAX_HEADER_VALUE_BYTES', '4097'],
    ['MCP_REQUEST_MAX_CONCURRENT', '2'],
    ['MCP_REQUEST_MAX_QUEUE', '3'],
    ['MCP_REQUEST_RATE_LIMIT_MAX', '10001'],
    ['MCP_REQUEST_RATE_LIMIT_WINDOW_MS', '3600001'],
    ['MCP_LISTEN_MAX_CONNECTIONS', '1025'],
    ['MCP_LISTEN_MAX_QUEUE_BYTES', '1048577'],
    ['MCP_LISTEN_MAX_DURATION_MS', '86400001'],
    ['MCP_OUTPUT_MAX_BYTES', '16777217'],
    ['MCP_OUTPUT_MAX_ITEMS', '100001'],
    ['MCP_OUTPUT_MAX_DEPTH', '65'],
  ];
  for (const [key, value] of above) {
    assert.throws(() => loadConfig(onEnv({ [key]: value })),
      new RegExp(key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `${key}=${value} must exceed the frozen budget and be rejected`);
  }
  assert.throws(() => loadConfig(onEnv({ MCP_REQUEST_MAX_BODY_BYTES: '0' })), /safe integer >= 1/u);
  assert.throws(() => loadConfig(onEnv({ MCP_REQUEST_MAX_BODY_BYTES: 'abc' })), /MCP_REQUEST_MAX_BODY_BYTES/u);
  assert.throws(() => loadConfig(onEnv({ MCP_REQUEST_RATE_LIMIT_MAX: '0' })), /safe integer >= 1/u);
  assert.equal(PHASE4B_MCP_CONFIG_REQUEST_BUDGET_MAX.maxBodyBytes, PHASE4B_MCP_HARD_LIMITS.maxBodyBytes);
});

test('MCP strict I-JSON limits are frozen, bounded, and fail closed', () => {
  assert.equal(Object.isFrozen(PHASE4B_MCP_CONFIG_DEFAULT_I_JSON_LIMITS), true);
  assert.equal(Object.isFrozen(PHASE4B_MCP_CONFIG_I_JSON_LIMIT_MAX), true);
  assert.ok(PHASE4B_MCP_CONFIG_DEFAULT_I_JSON_LIMITS.maxDepth <= PHASE4B_MCP_CONFIG_I_JSON_LIMIT_MAX.maxDepth);
  assert.ok(PHASE4B_MCP_CONFIG_DEFAULT_I_JSON_LIMITS.maxMembers <= PHASE4B_MCP_CONFIG_I_JSON_LIMIT_MAX.maxMembers);
  assert.throws(
    () => assertPhase4bMcpIJsonLimitConfig({
      maxDepth: PHASE4B_MCP_CONFIG_I_JSON_LIMIT_MAX.maxDepth + 1,
      maxMembers: 1,
    }),
    /MCP strict I-JSON maxDepth/u,
  );
  assert.throws(
    () => assertPhase4bMcpIJsonLimitConfig({
      maxDepth: 1,
      maxMembers: PHASE4B_MCP_CONFIG_I_JSON_LIMIT_MAX.maxMembers + 1,
    }),
    /MCP strict I-JSON maxMembers/u,
  );
  assert.throws(
    () => assertPhase4bMcpIJsonLimitConfig({ maxDepth: 0, maxMembers: 1 }),
    /safe integer/u,
  );
});

test('MCP request rate limit defaults are dev/test-only and explicit values are frozen', () => {
  assert.deepEqual(loadConfig(onEnv()).mcp?.requestRateLimit, {
    maxRequests: 120,
    windowMs: 60_000,
  });

  const explicit = loadConfig(onEnv({
    MCP_REQUEST_RATE_LIMIT_MAX: '7',
    MCP_REQUEST_RATE_LIMIT_WINDOW_MS: '1000',
  })).mcp!;
  assert.deepEqual(explicit.requestRateLimit, { maxRequests: 7, windowMs: 1_000 });
  assert.equal(Object.isFrozen(explicit.requestRateLimit), true);

  assert.throws(
    () => loadConfig(prodEnv({
      MCP_REQUEST_RATE_LIMIT_MAX: undefined,
      MCP_REQUEST_RATE_LIMIT_WINDOW_MS: undefined,
    })),
    /MCP_REQUEST_RATE_LIMIT_MAX and MCP_REQUEST_RATE_LIMIT_WINDOW_MS are required in production/u,
  );
  assert.throws(
    () => loadConfig(prodEnv({ MCP_REQUEST_RATE_LIMIT_WINDOW_MS: undefined })),
    /MCP_REQUEST_RATE_LIMIT_WINDOW_MS are required in production/u,
  );
  assert.throws(
    () => loadConfig(prodEnv({ MCP_REQUEST_RATE_LIMIT_MAX: '' })),
    /MCP_REQUEST_RATE_LIMIT_MAX and MCP_REQUEST_RATE_LIMIT_WINDOW_MS are required in production/u,
  );

  const production = loadConfig(prodEnv({
    MCP_REQUEST_RATE_LIMIT_MAX: '5',
    MCP_REQUEST_RATE_LIMIT_WINDOW_MS: '2500',
  })).mcp!;
  assert.deepEqual(production.requestRateLimit, { maxRequests: 5, windowMs: 2_500 });
});

test('production enforces HTTPS origins and JWKS', () => {
  const ok = loadConfig(prodEnv()).mcp!;
  assert.equal(ok.enabled, true);
  assert.equal(ok.oauth.jwksUri, PHASE4B_MCP_BUILTIN_JWKS_URI);
  assert.equal(ok.oauth.issuer, PHASE4B_MCP_BUILTIN_ISSUER);
  assert.equal('clientId' in ok.oauth, false);
  assert.equal('clientSecretReference' in ok.oauth, false);
  assert.equal(ok.collectionResources.cursorKeys.active.id, 'prod-mcp-collection-v1');
  assert.equal(
    ok.oauth.revocationStore,
    'postgres',
    'production with a JWKS URI must use the shared postgres revocation store',
  );

  assert.throws(
    () => loadConfig(prodEnv({ MCP_OAUTH_REVOCATION_STORE: 'none' })),
    /MCP_OAUTH_REVOCATION_STORE/u,
  );

  const withStore = loadConfig(prodEnv({ MCP_OAUTH_REVOCATION_STORE: 'postgres' })).mcp!;
  assert.equal(withStore.oauth.revocationStore, 'postgres');

  assert.throws(
    () => loadConfig(prodEnv({ MCP_ALLOWED_ORIGINS: 'http://127.0.0.1:3000' })),
    /MCP allowed origins must use https in production/u,
  );
  assert.throws(
    () => loadConfig(prodEnv({ PUBLICATION_ORIGIN: 'http://127.0.0.1:3000' })),
    /MCP origin must use https in production/u,
  );
  assert.throws(
    () => loadConfig(prodEnv({ MCP_OAUTH_JWKS_URI: '' })),
    /MCP OAuth JWKS URI is required in production/u,
  );
  assert.throws(
    () => loadConfig(prodEnv({
      MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_KEY_ID: undefined,
      MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_SECRET: undefined,
    })),
    /MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_KEY_ID/u,
  );
});

test('MCP collection cursor config rejects weak keys, duplicate keys, and invalid TTLs', () => {
  assert.throws(
    () => loadConfig(onEnv({ MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_SECRET: 'too-short' })),
    /canonical base64 with at least 32 bytes/u,
  );
  assert.throws(
    () => loadConfig(onEnv({
      MCP_COLLECTION_RESOURCE_CURSOR_RETAINED_KEYS: JSON.stringify([
        { id: 'mcp-collection-resource-v1', secret: Buffer.alloc(32, 29).toString('base64') },
      ]),
    })),
    /cursor key ids must be unique/u,
  );
  assert.throws(
    () => loadConfig(onEnv({ MCP_COLLECTION_RESOURCE_CURSOR_TTL_MS: '999' })),
    /MCP_COLLECTION_RESOURCE_CURSOR_TTL_MS must be a safe integer/u,
  );
  assert.throws(
    () => loadConfig(onEnv({ MCP_COLLECTION_RESOURCE_CURSOR_TTL_MS: '3600001' })),
    /MCP_COLLECTION_RESOURCE_CURSOR_TTL_MS must be <= 3600000/u,
  );
});

test('issuer and JWKS must share origin when both are configured', () => {
  const ok = loadConfig(onEnv()).mcp!;
  assert.equal(ok.oauth.issuer, PHASE4B_MCP_BUILTIN_ISSUER);
  assert.equal(ok.oauth.jwksUri, PHASE4B_MCP_BUILTIN_JWKS_URI);

  assert.throws(
    () => loadConfig(onEnv({
      MCP_OAUTH_JWKS_URI: 'https://other-jwks.example.test/realms/known/protocol/openid-connect/certs',
    })),
    /same origin/u,
  );
});

const ISSUER_ON = {
  BETTER_AUTH_ENABLED: 'true',
  BETTER_AUTH_OAUTH_ISSUER_ENABLED: 'true',
} as const;
const PROD_BETTER_AUTH_SECRET = 'prod-better-auth-secret-0123456789abcdef';
const PROD_BETTER_AUTH_SESSION_TOKEN_KEYS = `1:${Buffer.alloc(32, 29).toString('base64')}`;
const LOOPBACK_ISSUER = 'https://127.0.0.1:8443/api/v1/auth';
const LOOPBACK_JWKS = `${LOOPBACK_ISSUER}/jwks`;
const LOOPBACK_AS_METADATA =
  'https://127.0.0.1:8443/.well-known/oauth-authorization-server/api/v1/auth';

test('issuer-on rejects issuer and JWKS that do not share origin', () => {
  assert.throws(
    () => loadConfig(onEnv({
      ...ISSUER_ON,
      MCP_OAUTH_ISSUER: 'https://app.example.test/api/v1/auth',
      MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
        'https://app.example.test/.well-known/oauth-authorization-server/api/v1/auth',
      MCP_OAUTH_JWKS_URI: 'https://other-jwks.example.test/api/v1/auth/jwks',
    })),
    /same origin/u,
  );
});

test('NODE_ENV=test allows same-origin loopback issuer and JWKS when the issuer flag is on', () => {
  const config = loadConfig(onEnv({
    ...ISSUER_ON,
    MCP_OAUTH_ISSUER: LOOPBACK_ISSUER,
    MCP_OAUTH_JWKS_URI: LOOPBACK_JWKS,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: LOOPBACK_AS_METADATA,
  })).mcp!;
  assert.equal(config.oauth.issuer, LOOPBACK_ISSUER);
  assert.equal(config.oauth.jwksUri, LOOPBACK_JWKS);
  assert.equal(config.oauth.authorizationServerMetadataUrl, LOOPBACK_AS_METADATA);
});

test('production rejects same-origin loopback issuer and JWKS even when the issuer flag is on', () => {
  assert.throws(
    () => loadConfig(prodEnv({
      ...ISSUER_ON,
      BETTER_AUTH_SECRET: PROD_BETTER_AUTH_SECRET,
      BETTER_AUTH_SESSION_TOKEN_KEYS: PROD_BETTER_AUTH_SESSION_TOKEN_KEYS,
      MCP_OAUTH_ISSUER: LOOPBACK_ISSUER,
      MCP_OAUTH_JWKS_URI: LOOPBACK_JWKS,
      MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: LOOPBACK_AS_METADATA,
    })),
    /must not target/u,
  );
});

test('loadConfig-accepted test loopback issuer also passes boot re-assert, PRM, and resource identity', () => {
  const app = loadConfig(onEnv({
    ...ISSUER_ON, MCP_OAUTH_ISSUER: LOOPBACK_ISSUER, MCP_OAUTH_JWKS_URI: LOOPBACK_JWKS,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: LOOPBACK_AS_METADATA,
  }));
  const boot = mcpReadFeatureConfigAssertOptions({
    nodeEnv: app.nodeEnv, oauthIssuerEnabled: app.betterAuth.oauthIssuerEnabled,
  });
  assert.equal(app.betterAuth.oauthIssuerEnabled, true);
  assert.doesNotThrow(() => assertMcpReadFeatureConfig(app.mcp!, boot));
  assert.equal(createMcpReadProtectedResourceMetadata(app.mcp!, boot).jwks_uri, LOOPBACK_JWKS);
  assert.equal(createPhase4bMcpResourceIdentity(app.mcp!, boot).serverUuid, app.mcp!.serverUuid);
});

test('boot re-assert, PRM, and resource identity reject loopback when production or issuer-off', () => {
  const mcp = loadConfig(onEnv({
    ...ISSUER_ON, MCP_OAUTH_ISSUER: LOOPBACK_ISSUER, MCP_OAUTH_JWKS_URI: LOOPBACK_JWKS,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: LOOPBACK_AS_METADATA,
  })).mcp!;
  const denied = /must not target/u;
  for (const options of [
    mcpReadFeatureConfigAssertOptions({ nodeEnv: 'production', oauthIssuerEnabled: true }),
    mcpReadFeatureConfigAssertOptions({ nodeEnv: 'test', oauthIssuerEnabled: false }),
    {},
  ]) {
    assert.throws(() => assertMcpReadFeatureConfig(mcp, options), denied);
    assert.throws(() => createMcpReadProtectedResourceMetadata(mcp, options), denied);
    assert.throws(() => createPhase4bMcpResourceIdentity(mcp, options), denied);
  }
});

test('legacy mode/Session/Legacy configuration fails closed even when the flag is off', () => {
  for (const key of PHASE4B_MCP_FORBIDDEN_LEGACY_ENV_KEYS) {
    assert.throws(
      () => loadConfig({ ...baseEnv, [key]: 'anything' }),
      /legacy MCP 2025-11-25 configuration/u,
      `${key} must fail boot even with the flag off`,
    );
  }
  assert.throws(
    () => loadConfig({ ...baseEnv, MCP_PROTOCOL_MODE: '2025-11-25' }),
    /MCP_PROTOCOL_MODE/u,
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, MCP_PROTOCOL_VERSION: '2026-07-28' }),
    /MCP_PROTOCOL_VERSION/u,
    'a configurable protocol version must be rejected even when it equals the frozen value',
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, MCP_SESSION_STORE: 'redis://session-store' }),
    /MCP_SESSION_STORE/u,
  );
});

test('MCP Write flag composes only with the full Read feature config and key material', () => {
  const off = loadConfig(baseEnv);
  assert.equal(off.mcpWriteEnabled, false);
  assert.equal(off.mcpWrite, undefined);

  const flagOnly = loadConfig({ ...baseEnv, KNOWN_FEATURE_MCP_WRITE: 'true' });
  assert.equal(flagOnly.mcpWriteEnabled, true);
  assert.equal(flagOnly.mcpWrite, undefined, 'W10 Write host config requires active MCP Read config');

  const on = loadConfig(onEnv({
    KNOWN_FEATURE_MCP_WRITE: 'true',
    PRODUCT_ORIGIN: 'https://app.example.test',
    MCP_WRITE_REQUEST_STATE_KEY: Buffer.alloc(32, 77).toString('base64'),
    MCP_WRITE_PLAN_TTL_MS: '600000',
  }));
  assert.equal(on.mcpWriteEnabled, true);
  assert.equal(on.mcpWrite?.requestStateKey, Buffer.alloc(32, 77).toString('base64'));
  assert.equal(on.mcpWrite?.planTtlMilliseconds, 600_000);
  assert.equal(on.mcpWrite?.approvalBaseUri, 'https://app.example.test/approvals');
  assert.deepEqual(on.mcpWrite?.commitRateLimit, { maxPlans: 60, windowMs: 60_000 });
  assert.equal(on.mcpWrite?.maintenanceIntervalMs, 60_000);
  assert.equal(Object.isFrozen(on.mcpWrite!.commitRateLimit), true);

  const explicitCommit = loadConfig(onEnv({
    KNOWN_FEATURE_MCP_WRITE: 'true',
    PRODUCT_ORIGIN: 'https://app.example.test',
    MCP_WRITE_REQUEST_STATE_KEY: Buffer.alloc(32, 77).toString('base64'),
    MCP_WRITE_PLAN_TTL_MS: '600000',
    MCP_WRITE_MAINTENANCE_INTERVAL_MS: '45000',
    MCP_WRITE_COMMIT_RATE_LIMIT_MAX: '7',
    MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS: '1000',
  })).mcpWrite!;
  assert.deepEqual(explicitCommit.commitRateLimit, { maxPlans: 7, windowMs: 1_000 });
  assert.equal(explicitCommit.maintenanceIntervalMs, 45_000);

  assert.throws(
    () => loadConfig(onEnv({ KNOWN_FEATURE_MCP_WRITE: 'true', MCP_WRITE_REQUEST_STATE_KEY: 'too-short' })),
    /canonical base64 with at least 32 bytes/u,
  );
  assert.throws(
    () => loadConfig(onEnv({ KNOWN_FEATURE_MCP_WRITE: 'true', MCP_WRITE_PLAN_TTL_MS: '0' })),
    /MCP_WRITE_PLAN_TTL_MS/u,
  );
  assert.throws(
    () => loadConfig(onEnv({ KNOWN_FEATURE_MCP_WRITE: 'true', MCP_WRITE_COMMIT_RATE_LIMIT_MAX: '0' })),
    /safe integer >= 1/u,
  );
});

test('MCP Write maintenance interval is bounded and fails closed on invalid values', () => {
  const writeEnv = {
    KNOWN_FEATURE_MCP_WRITE: 'true',
    PRODUCT_ORIGIN: 'https://app.example.test',
    MCP_WRITE_REQUEST_STATE_KEY: Buffer.alloc(32, 77).toString('base64'),
    MCP_WRITE_PLAN_TTL_MS: '600000',
  };

  const minimum = loadConfig(onEnv({
    ...writeEnv,
    MCP_WRITE_MAINTENANCE_INTERVAL_MS: '1000',
  })).mcpWrite!;
  assert.equal(minimum.maintenanceIntervalMs, 1_000);

  const maximum = loadConfig(onEnv({
    ...writeEnv,
    MCP_WRITE_MAINTENANCE_INTERVAL_MS: '3600000',
  })).mcpWrite!;
  assert.equal(maximum.maintenanceIntervalMs, 3_600_000);

  for (const value of ['0', '999', '3600001', '-1', 'not-a-number']) {
    assert.throws(
      () => loadConfig(onEnv({ ...writeEnv, MCP_WRITE_MAINTENANCE_INTERVAL_MS: value })),
      /MCP_WRITE_MAINTENANCE_INTERVAL_MS/u,
      `${value} must fail closed`,
    );
  }
});

test('production MCP Write requires an explicit commit rate budget', () => {
  const writeEnv = {
    KNOWN_FEATURE_MCP_WRITE: 'true',
    MCP_WRITE_REQUEST_STATE_KEY: Buffer.alloc(32, 77).toString('base64'),
    MCP_WRITE_PLAN_TTL_MS: '600000',
  };

  assert.throws(
    () => loadConfig(prodEnv({
      KNOWN_FEATURE_MCP_WRITE: 'true',
      KNOWN_FEATURE_MCP_READ: 'false',
    })),
    /MCP_WRITE_COMMIT_RATE_LIMIT_MAX and MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS are required in production/u,
  );

  assert.throws(
    () => loadConfig(prodEnv({
      ...writeEnv,
      MCP_WRITE_COMMIT_RATE_LIMIT_MAX: undefined,
      MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS: undefined,
    })),
    /MCP_WRITE_COMMIT_RATE_LIMIT_MAX and MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS are required in production/u,
  );
  assert.throws(
    () => loadConfig(prodEnv({
      ...writeEnv,
      MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS: undefined,
    })),
    /MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS are required in production/u,
  );
  assert.throws(
    () => loadConfig(prodEnv({
      ...writeEnv,
      MCP_WRITE_COMMIT_RATE_LIMIT_MAX: '',
    })),
    /MCP_WRITE_COMMIT_RATE_LIMIT_MAX and MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS are required in production/u,
  );

  const production = loadConfig(prodEnv({
    ...writeEnv,
    MCP_WRITE_COMMIT_RATE_LIMIT_MAX: '5',
    MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS: '2500',
  })).mcpWrite!;
  assert.deepEqual(production.commitRateLimit, { maxPlans: 5, windowMs: 2_500 });
});
