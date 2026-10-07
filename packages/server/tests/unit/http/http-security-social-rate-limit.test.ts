import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  effectPageRateLimitSharedEnv,
  feedRateLimitSharedEnv,
  collectionFollowRateLimitSharedEnv,
  followRateLimitSharedEnv,
  notificationRateLimitSharedEnv,
  productRouteRateLimitSharedEnv,
  productionEnv,
  publicActivityRateLimitSharedEnv,
  syncRateLimitSharedEnv,
  testEnv,
} from '../../support/http-security-config-env.js';

describe('shared follow/feed/notification/effect-page rate-limit families (PERIPH-P1-c)', () => {
  type SocialFamily = {
    readonly name: string;
    readonly sharedFlag: string;
    readonly redisUrlEnv: string;
    readonly keySecretEnv: string;
    readonly keyPrefixEnv: string;
    readonly defaultPrefix: string;
    readonly secret: string;
    readonly env: (overrides?: Record<string, string>) => Record<string, string>;
    readonly sharedOf: (config: ReturnType<typeof loadConfig>) => {
      readonly enabled: boolean;
      readonly redisUrl: string | null;
      readonly keySecret: Buffer | null;
      readonly keyPrefix: string;
    };
    readonly failClosed: (config: ReturnType<typeof loadConfig>) => void;
    readonly failClosedPattern: RegExp;
    readonly featureEnv?: Record<string, string>;
    readonly replicaError: RegExp;
  };

  const families: readonly SocialFamily[] = [
    {
      name: 'follow',
      sharedFlag: 'FOLLOW_RATE_LIMIT_SHARED',
      redisUrlEnv: 'FOLLOW_RATE_LIMIT_REDIS_URL',
      keySecretEnv: 'FOLLOW_RATE_LIMIT_KEY_SECRET',
      keyPrefixEnv: 'FOLLOW_RATE_LIMIT_KEY_PREFIX',
      defaultPrefix: 'known-follow',
      secret: 'follow-rate-limit-hmac-secret',
      env: followRateLimitSharedEnv,
      sharedOf: (config) => config.follow!.rateLimitShared,
      failClosed: (config) => { buildApiApp({ config }); },
      failClosedPattern: /injected followRateLimiter.*FOLLOW_RATE_LIMIT_SHARED=true/s,
      featureEnv: { KNOWN_FEATURE_FOLLOW: 'true' },
      replicaError: /AUTH_API_REPLICAS > 1.*with Follow enabled requires FOLLOW_RATE_LIMIT_SHARED=true/s,
    },
    {
      name: 'collection-follow',
      sharedFlag: 'COLLECTION_FOLLOW_RATE_LIMIT_SHARED',
      redisUrlEnv: 'COLLECTION_FOLLOW_RATE_LIMIT_REDIS_URL',
      keySecretEnv: 'COLLECTION_FOLLOW_RATE_LIMIT_KEY_SECRET',
      keyPrefixEnv: 'COLLECTION_FOLLOW_RATE_LIMIT_KEY_PREFIX',
      defaultPrefix: 'known-collection-follow',
      secret: 'collection-follow-rate-limit-hmac-secret', // secret-scan: allow 'collection-follow-rate-limit-hmac-secret'
      env: collectionFollowRateLimitSharedEnv,
      sharedOf: (config) => config.collectionFollow.rateLimitShared,
      failClosed: (config) => { buildApiApp({ config }); },
      failClosedPattern: /injected collectionFollowRateLimiter.*COLLECTION_FOLLOW_RATE_LIMIT_SHARED=true/s,
      featureEnv: { KNOWN_FEATURE_COLLECTION_FOLLOW: 'true' },
      replicaError: /AUTH_API_REPLICAS > 1.*with Collection Follow enabled requires COLLECTION_FOLLOW_RATE_LIMIT_SHARED=true/s,
    },
    {
      name: 'feed',
      sharedFlag: 'FEED_RATE_LIMIT_SHARED',
      redisUrlEnv: 'FEED_RATE_LIMIT_REDIS_URL',
      keySecretEnv: 'FEED_RATE_LIMIT_KEY_SECRET',
      keyPrefixEnv: 'FEED_RATE_LIMIT_KEY_PREFIX',
      defaultPrefix: 'known-feed',
      secret: 'feed-rate-limit-hmac-secret',
      env: feedRateLimitSharedEnv,
      sharedOf: (config) => config.feed!.rateLimitShared,
      failClosed: (config) => { buildApiApp({ config }); },
      failClosedPattern: /injected feedRateLimiter.*FEED_RATE_LIMIT_SHARED=true/s,
      featureEnv: { KNOWN_FEATURE_FEED: 'true' },
      replicaError: /AUTH_API_REPLICAS > 1.*with Feed enabled requires FEED_RATE_LIMIT_SHARED=true/s,
    },
    {
      name: 'notification',
      sharedFlag: 'NOTIFICATION_RATE_LIMIT_SHARED',
      redisUrlEnv: 'NOTIFICATION_RATE_LIMIT_REDIS_URL',
      keySecretEnv: 'NOTIFICATION_RATE_LIMIT_KEY_SECRET',
      keyPrefixEnv: 'NOTIFICATION_RATE_LIMIT_KEY_PREFIX',
      defaultPrefix: 'known-notification',
      secret: 'notification-rate-limit-hmac-secret', // secret-scan: allow 'notification-rate-limit-hmac-secret'
      env: notificationRateLimitSharedEnv,
      sharedOf: (config) => config.notifications!.rateLimitShared,
      failClosed: (config) => { buildApiApp({ config }); },
      failClosedPattern: /injected notificationRateLimiter.*NOTIFICATION_RATE_LIMIT_SHARED=true/s,
      featureEnv: { KNOWN_FEATURE_NOTIFICATIONS: 'true' },
      replicaError: /AUTH_API_REPLICAS > 1.*with Notifications enabled requires NOTIFICATION_RATE_LIMIT_SHARED=true/s,
    },
    {
      name: 'effect-page',
      sharedFlag: 'SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED',
      redisUrlEnv: 'SYNC_EFFECT_PAGE_RATE_LIMIT_REDIS_URL',
      keySecretEnv: 'SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_SECRET',
      keyPrefixEnv: 'SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_PREFIX',
      defaultPrefix: 'known-effect-page',
      secret: 'effect-page-rate-limit-hmac-secret', // secret-scan: allow 'effect-page-rate-limit-hmac-secret'
      env: effectPageRateLimitSharedEnv,
      sharedOf: (config) => config.syncEffectPageRateLimit.shared,
      failClosed: (config) => {
        buildApiApp({
          config,
          syncEffectPageRoutes: {
            pathTemplate: '/private/effects/{effectId}/{pageNumber}',
            credentialVerifier: { async verify() { throw new Error('unused'); } },
            reader: { async read() { throw new Error('unused'); } },
            allowedOrigins: ['https://known.example'],
            responseBudgetBytes: 1024,
            rateLimit: {
              subjectMaxRequests: 10, effectMaxRequests: 10, ipMaxRequests: 10, windowMs: 60_000,
            },
          },
        });
      },
      failClosedPattern: /injected effectPageRateLimiter.*SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED=true/s,
      replicaError: /AUTH_API_REPLICAS > 1.*with Sync Sessions enabled requires SYNC_EFFECT_PAGE_RATE_LIMIT_SHARED=true/s,
    },
  ];

  function replicaShared(overrides: Record<string, string> = {}) {
    return {
      AUTH_RATE_LIMIT_SHARED: 'true',
      AUTH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
      AUTH_RATE_LIMIT_KEY_SECRET: 'auth-rate-limit-hmac-secret-001',
      SEARCH_RATE_LIMIT_SHARED: 'true',
      SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
      SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
      PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED: 'true',
      PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
      COLLABORATION_INVITE_RATE_LIMIT_SHARED: 'true',
      COLLABORATION_INVITE_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
      COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'collaboration-invite-rate-limit-hmac-secret',
      EXPLORE_DIRECTORY_RATE_LIMIT_SHARED: 'true',
      EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
      EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET: 'explore-directory-rate-limit-hmac-secret',
      ...publicActivityRateLimitSharedEnv(),
      ...productRouteRateLimitSharedEnv(),
      AUTH_API_REPLICAS: '2',
      ...overrides,
    };
  }

  test('defaults are disabled with independent prefixes; shared=true without secret or url fails closed', () => {
    const defaults = loadConfig(testEnv());
    assert.equal(defaults.follow!.rateLimitShared.enabled, false);
    assert.equal(defaults.feed!.rateLimitShared.enabled, false);
    assert.equal(defaults.notifications!.rateLimitShared.enabled, false);
    assert.equal(defaults.syncEffectPageRateLimit.shared.enabled, false);
    assert.equal(defaults.follow!.rateLimitShared.keyPrefix, 'known-follow');
    assert.equal(defaults.collectionFollow.rateLimitShared.enabled, false);
    assert.equal(defaults.collectionFollow.rateLimitShared.keyPrefix, 'known-collection-follow');
    assert.equal(defaults.feed!.rateLimitShared.keyPrefix, 'known-feed');
    assert.equal(defaults.notifications!.rateLimitShared.keyPrefix, 'known-notification');
    assert.equal(defaults.syncEffectPageRateLimit.shared.keyPrefix, 'known-effect-page');
    assert.equal(defaults.publicActivityRateLimit.shared.enabled, false);
    assert.equal(defaults.publicActivityRateLimit.shared.keyPrefix, 'known-public-activity');
    const prefixes = new Set([
      defaults.httpSecurity.searchRateLimit.shared.keyPrefix,
      defaults.exploreDirectoryRateLimit.shared.keyPrefix,
      defaults.syncRateLimit.shared.keyPrefix,
      defaults.follow!.rateLimitShared.keyPrefix,
      defaults.collectionFollow.rateLimitShared.keyPrefix,
      defaults.feed!.rateLimitShared.keyPrefix,
      defaults.notifications!.rateLimitShared.keyPrefix,
      defaults.syncEffectPageRateLimit.shared.keyPrefix,
      defaults.publicActivityRateLimit.shared.keyPrefix,
    ]);
    assert.equal(prefixes.size, 9);

    for (const family of families) {
      assert.throws(
        () => loadConfig(testEnv({ [family.sharedFlag]: 'true' })),
        new RegExp(`${family.redisUrlEnv} is required`),
      );
      assert.throws(
        () => loadConfig(testEnv(family.env({ [family.keySecretEnv]: '' }))),
        new RegExp(`${family.keySecretEnv} is required`),
      );
      assert.throws(
        () => loadConfig(testEnv({ [family.sharedFlag]: 'maybe' })),
        new RegExp(`${family.sharedFlag} must be true or false`),
      );
      const reused = loadConfig(testEnv({
        [family.sharedFlag]: 'true',
        SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
        [family.keySecretEnv]: family.secret,
      }));
      const shared = family.sharedOf(reused);
      assert.equal(shared.enabled, true);
      assert.equal(shared.redisUrl, 'redis://127.0.0.1:6379');
      assert.equal(shared.keyPrefix, family.defaultPrefix);
      assert.throws(
        () => loadConfig(testEnv(family.env({ [family.keyPrefixEnv]: 'known' }))),
        new RegExp(`${family.keyPrefixEnv} must be independent from SEARCH_RATE_LIMIT_KEY_PREFIX`),
      );
      assert.throws(
        () => loadConfig(testEnv(family.env({
          [family.keySecretEnv]: 'search-rate-limit-hmac-secret-006',
          SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
        }))),
        new RegExp(`${family.keySecretEnv} must not reuse`),
      );
    }
  });

  test('public Activity prefix cannot reuse Explore or Search prefixes', () => {
    assert.throws(
      () => loadConfig(testEnv({ PUBLIC_ACTIVITY_RATE_LIMIT_KEY_PREFIX: 'known-explore' })),
      /PUBLIC_ACTIVITY_RATE_LIMIT_KEY_PREFIX must be independent from EXPLORE_DIRECTORY_RATE_LIMIT_KEY_PREFIX/,
    );
    assert.throws(
      () => loadConfig(testEnv({ PUBLIC_ACTIVITY_RATE_LIMIT_KEY_PREFIX: 'known' })),
      /PUBLIC_ACTIVITY_RATE_LIMIT_KEY_PREFIX must be independent from SEARCH_RATE_LIMIT_KEY_PREFIX/,
    );
  });

  test('sibling social secrets and prefixes stay isolated', () => {
    assert.throws(
      () => loadConfig(testEnv({
        ...followRateLimitSharedEnv(),
        ...feedRateLimitSharedEnv({ FEED_RATE_LIMIT_KEY_SECRET: 'follow-rate-limit-hmac-secret' }),
      })),
      /FOLLOW_RATE_LIMIT_KEY_SECRET must not reuse/,
    );
    assert.throws(
      () => loadConfig(testEnv(followRateLimitSharedEnv({
        FOLLOW_RATE_LIMIT_KEY_PREFIX: 'known-feed',
      }))),
      /FEED_RATE_LIMIT_KEY_PREFIX must be independent from FOLLOW_RATE_LIMIT_KEY_PREFIX/,
    );
  });

  test('shared adapter without an injected limiter fails closed at composition', () => {
    for (const family of families) {
      const config = loadConfig(testEnv(family.env()));
      assert.throws(() => family.failClosed(config), family.failClosedPattern);
    }
  });

  test('production replicas>1 requires each family only when its surface is enabled', () => {
    assert.doesNotThrow(() => loadConfig(productionEnv(replicaShared())));
    for (const family of families) {
      const feature = family.name === 'effect-page'
        ? {
            SYNC_SESSION_ENABLED: 'true',
            SYNC_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop',
            SYNC_OAUTH_ISSUER: 'https://issuer.example.test',
            SYNC_OAUTH_CLIENT_ID: 'known-extension',
            SYNC_OAUTH_AUDIENCE: 'known-sync-api',
            SYNC_OAUTH_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/oauth2/authorize',
            SYNC_OAUTH_TOKEN_ENDPOINT: 'https://issuer.example.test/oauth2/token',
            SYNC_OAUTH_JWKS_URI: 'https://issuer.example.test/.well-known/jwks.json',
            SYNC_OAUTH_REDIRECT_URI: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback',
            SYNC_OAUTH_SCOPES: 'openid known.sync',
            SYNC_OAUTH_ALGORITHMS: 'RS256',
            SYNC_SESSION_REPLAY_KEY: Buffer.alloc(32, 23).toString('base64'),
            SYNC_SNAPSHOT_CURSOR_KEY: Buffer.alloc(32, 29).toString('base64'),
            SYNC_SNAPSHOT_CURSOR_KEY_ID: 'test-sync-snapshot-v1',
            SYNC_PULL_CURSOR_KEY_ID: 'test-sync-pull-v1',
            SYNC_PULL_CURSOR_KEY: Buffer.alloc(32, 41).toString('base64'),
            SYNC_RECOVERY_CAPABILITY_KEY_ID: 'recovery-v1',
            SYNC_RECOVERY_CAPABILITY_KEY: Buffer.alloc(32, 44).toString('base64'),
            SYNC_PULL_LINEAGE_KEY_ID: 'lineage-v1',
            SYNC_PULL_LINEAGE_KEY: Buffer.alloc(32, 47).toString('base64'),
            ...syncRateLimitSharedEnv(),
          }
        : (family.featureEnv ?? {});
      assert.throws(
        () => loadConfig(productionEnv(replicaShared(feature))),
        family.replicaError,
      );
      const ok = loadConfig(productionEnv(replicaShared({ ...feature, ...family.env() })));
      assert.equal(family.sharedOf(ok).enabled, true);
    }
  });
});
