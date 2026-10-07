const PROD_OIDC_TX_SECRETS = {
  OIDC_TRANSACTION_HMAC_SECRET: 'prod-oidc-transaction-hmac-secret-not-dev-default',
  OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${Buffer.alloc(32, 5).toString('base64')}`,
} as const;

export function productionEnv(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    OIDC_ALLOW_TEST_PROVIDER: 'false',
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
    PUBLICATION_SERVER_UUID: '019f9031-c541-74d0-bc83-15a5526fbb54',
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
    // Product default is on; this fixture keeps social surfaces opted-out unless a test sets them.
    KNOWN_FEATURE_COLLECTION_FOLLOW: 'false',
    LOG_LEVEL: 'silent',
    // FIX-M-006: production must EXPLICITLY declare the trusted ingress
    // (empty = direct peer-only exposure); readiness fails without it.
    TRUSTED_INGRESS: '',
    ...PROD_OIDC_TX_SECRETS,
    ...overrides,
  };
}

export function testEnv(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

export function syncRateLimitSharedEnv(overrides: Record<string, string> = {}) {
  return {
    SYNC_RATE_LIMIT_SHARED: 'true',
    SYNC_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    SYNC_RATE_LIMIT_KEY_SECRET: 'sync-colp-rate-limit-hmac-secret',
    ...overrides,
  };
}

export function followRateLimitSharedEnv(overrides: Record<string, string> = {}) {
  return {
    FOLLOW_RATE_LIMIT_SHARED: 'true',
    FOLLOW_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    FOLLOW_RATE_LIMIT_KEY_SECRET: 'follow-rate-limit-hmac-secret',
    ...overrides,
  };
}

export function collectionFollowRateLimitSharedEnv(overrides: Record<string, string> = {}) {
  return {
    COLLECTION_FOLLOW_RATE_LIMIT_SHARED: 'true',
    COLLECTION_FOLLOW_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    COLLECTION_FOLLOW_RATE_LIMIT_KEY_SECRET: 'collection-follow-rate-limit-hmac-secret',
    ...overrides,
  };
}

export function feedRateLimitSharedEnv(overrides: Record<string, string> = {}) {
  return {
    FEED_RATE_LIMIT_SHARED: 'true',
    FEED_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    FEED_RATE_LIMIT_KEY_SECRET: 'feed-rate-limit-hmac-secret',
    ...overrides,
  };
}

export function notificationRateLimitSharedEnv(overrides: Record<string, string> = {}) {
  return {
    NOTIFICATION_RATE_LIMIT_SHARED: 'true',
    NOTIFICATION_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    NOTIFICATION_RATE_LIMIT_KEY_SECRET: 'notification-rate-limit-hmac-secret', // secret-scan: allow 'notification-rate-limit-hmac-secret'
    ...overrides,
  };
}

export function effectPageRateLimitSharedEnv(overrides: Record<string, string> = {}) {
  return {
    SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED: 'true',
    SYNC_EFFECT_PAGE_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_SECRET: 'effect-page-rate-limit-hmac-secret', // secret-scan: allow 'effect-page-rate-limit-hmac-secret'
    ...overrides,
  };
}

export function publicActivityRateLimitSharedEnv(overrides: Record<string, string> = {}) {
  return {
    PUBLIC_ACTIVITY_RATE_LIMIT_SHARED: 'true',
    PUBLIC_ACTIVITY_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET: 'public-activity-rate-limit-hmac-secret',
    ...overrides,
  };
}

export function productRouteRateLimitSharedEnv(overrides: Record<string, string> = {}) {
  return {
    PRODUCT_ROUTE_RATE_LIMIT_SHARED: 'true',
    PRODUCT_ROUTE_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET: 'product-route-rate-limit-hmac-secret',
    ...overrides,
  };
}
