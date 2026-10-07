/**
 * Shared env fixtures for Phase 4B MCP config tests. Not a test file.
 */
export const PHASE4B_MCP_CONFIG_SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';

/** Built-in issuer shape (ADR D6): `https://<product-origin>/api/v1/auth`. */
export const PHASE4B_MCP_BUILTIN_ISSUER = 'https://app.example.test/api/v1/auth';
export const PHASE4B_MCP_BUILTIN_JWKS_URI = `${PHASE4B_MCP_BUILTIN_ISSUER}/jwks`;
export const PHASE4B_MCP_BUILTIN_AS_METADATA_URL =
  'https://app.example.test/.well-known/oauth-authorization-server/api/v1/auth';

export const phase4bMcpConfigBaseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: PHASE4B_MCP_CONFIG_SERVER_UUID,
};

export function phase4bMcpOnEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  return {
    ...phase4bMcpConfigBaseEnv,
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: PHASE4B_MCP_CONFIG_SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: PHASE4B_MCP_BUILTIN_ISSUER,
    MCP_OAUTH_AUDIENCE: 'https://collections.example.test/collections/-/mcp',
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: PHASE4B_MCP_BUILTIN_AS_METADATA_URL,
    MCP_OAUTH_JWKS_URI: PHASE4B_MCP_BUILTIN_JWKS_URI,
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
    ...overrides,
  } as Record<string, string>;
}

export function phase4bMcpProdEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const oidcKey = Buffer.alloc(32, 5).toString('base64');
  const prodServerUuid = '019f9031-c541-74d0-bc83-15a5526fbb54';
  return {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.example.test',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_JWKS_URI: 'https://issuer.example/jwks',
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
    PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
    PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
    PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${oidcKey}`,
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: prodServerUuid,
    PUBLICATION_CURSOR_ACTIVE_KEY_ID: 'prod-publication-v1',
    PUBLICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 17).toString('base64'),
    FOLLOW_CURSOR_ACTIVE_KEY_ID: 'prod-follow-v1',
    FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 19).toString('base64'),
    FEED_CURSOR_ACTIVE_KEY_ID: 'prod-feed-v1',
    FEED_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 21).toString('base64'),
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_KEY_ID: 'prod-public-activity-v1',
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 27).toString('base64'),
    NOTIFICATION_CURSOR_ACTIVE_KEY_ID: 'prod-notification-v1',
    NOTIFICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 23).toString('base64'),
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 37).toString('base64'),
    COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 43).toString('base64'),
    OIDC_ALLOW_TEST_PROVIDER: 'false',
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: prodServerUuid,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: PHASE4B_MCP_BUILTIN_ISSUER,
    MCP_OAUTH_AUDIENCE: 'https://collections.example.test/collections/-/mcp',
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL: PHASE4B_MCP_BUILTIN_AS_METADATA_URL,
    MCP_OAUTH_JWKS_URI: PHASE4B_MCP_BUILTIN_JWKS_URI,
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
    MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_KEY_ID: 'prod-mcp-collection-v1',
    MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 31).toString('base64'),
    MCP_REQUEST_RATE_LIMIT_MAX: '120',
    MCP_REQUEST_RATE_LIMIT_WINDOW_MS: '60000',
    MCP_OAUTH_REVOCATION_STORE: 'postgres',
    ...overrides,
  };
}
