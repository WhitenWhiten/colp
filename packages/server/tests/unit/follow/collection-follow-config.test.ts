import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  productRouteRateLimitSharedEnv,
  productionEnv,
  publicActivityRateLimitSharedEnv,
} from '../../support/http-security-config-env.js';

const env = { DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known', NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' };

const PROD_FOLLOWED_COLLECTIONS_SECRET = Buffer.alloc(32, 37).toString('base64');
const RETAINED_FOLLOWED_COLLECTIONS_SECRET = Buffer.alloc(32, 41).toString('base64');

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

test('Library order admission reads from LIBRARY_ORDER_* instead of a hardcoded 120/2s', () => {
  const defaults = loadConfig(env).libraryOrder;
  assert.deepEqual(defaults.rateLimit, { maxRequests: 120, windowMs: 60_000 });
  assert.equal(defaults.timeoutMs, 2_000);
  const tuned = loadConfig({
    ...env,
    LIBRARY_ORDER_RATE_LIMIT_MAX: '9',
    LIBRARY_ORDER_RATE_LIMIT_WINDOW_MS: '1500',
    LIBRARY_ORDER_HTTP_TIMEOUT_MS: '400',
  }).libraryOrder;
  assert.deepEqual(tuned.rateLimit, { maxRequests: 9, windowMs: 1500 });
  assert.equal(tuned.timeoutMs, 400);
});

test('Collection Follow exposure defaults on and explicit settings stay bounded', () => {
  const defaults = loadConfig(env).collectionFollow;
  assert.equal(defaults.enabled, true);
  assert.deepEqual(defaults.rateLimit, { maxRequests: 120, windowMs: 60_000 });
  assert.equal(defaults.timeoutMs, 2_000);
  assert.equal(defaults.cursorKeys.active.id, 'dev-followed-collections-v1');
  assert.equal(defaults.cursorKeys.active.secret, Buffer.alloc(32, 29).toString('base64'));
  assert.deepEqual(defaults.cursorKeys.retained, []);
  assert.equal(defaults.rateLimitShared.enabled, false);
  assert.equal(defaults.rateLimitShared.keyPrefix, 'known-collection-follow');
  assert.equal(Object.isFrozen(defaults), true);

  const enabled = loadConfig({ ...env, KNOWN_FEATURE_COLLECTION_FOLLOW: 'true',
    COLLECTION_FOLLOW_HTTP_TIMEOUT_MS: '250',
    COLLECTION_FOLLOW_RATE_LIMIT_MAX: '7', COLLECTION_FOLLOW_RATE_LIMIT_WINDOW_MS: '1000' }).collectionFollow;
  assert.equal(enabled.enabled, true); assert.equal(enabled.timeoutMs, 250);
  assert.deepEqual(enabled.rateLimit, { maxRequests: 7, windowMs: 1000 });
  const retained = loadConfig({ ...env, FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS: JSON.stringify([{
    id: 'old-v1', secret: RETAINED_FOLLOWED_COLLECTIONS_SECRET,
    lastIssuedAt: '2026-07-29T00:00:00.000Z', retainUntil: '2026-07-29T00:15:00.000Z',
  }]) }).collectionFollow;
  assert.equal(retained.cursorKeys.retained[0]?.id, 'old-v1');
});

test('Collection Follow configuration rejects ambiguous flags and invalid independent cursor material', () => {
  assert.throws(() => loadConfig({ ...env, KNOWN_FEATURE_COLLECTION_FOLLOW: 'yes' }),
    /KNOWN_FEATURE_COLLECTION_FOLLOW must be true or false/u);
  assert.throws(() => loadConfig({ ...env, KNOWN_FEATURE_COLLECTION_FOLLOW: '' }),
    /KNOWN_FEATURE_COLLECTION_FOLLOW must be true or false/u);
  assert.throws(() => loadConfig({ ...env, KNOWN_FEATURE_COLLECTION_FOLLOW: '1' }),
    /KNOWN_FEATURE_COLLECTION_FOLLOW must be true or false/u);
  assert.throws(() => loadConfig({ ...env, FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: 'shared-secret' }),
    /key is invalid/u);
  assert.throws(() => loadConfig({ ...env, FOLLOWED_COLLECTIONS_CURSOR_RETAINED_KEYS: JSON.stringify([{
    id: 'old-v1', secret: RETAINED_FOLLOWED_COLLECTIONS_SECRET,
    lastIssuedAt: '2026-07-29T00:00:00.000Z', retainUntil: '2026-07-29T00:14:59.999Z',
  }]) }), /does not cover Followed collections cursor TTL/u);
  assert.throws(() => loadConfig({ ...env, COLLECTION_FOLLOW_RATE_LIMIT_MAX: '10001' }),
    /COLLECTION_FOLLOW_RATE_LIMIT_MAX must be <= 10000/u);
  assert.throws(() => loadConfig({ ...env, COLLECTION_FOLLOW_RATE_LIMIT_WINDOW_MS: '3600001' }),
    /COLLECTION_FOLLOW_RATE_LIMIT_WINDOW_MS must be <= 3600000/u);
});

test('production rejects followed-collections cursor that collides with sibling cursor material', () => {
  const collisions: ReadonlyArray<readonly [string, string]> = [
    ['follow', Buffer.alloc(32, 19).toString('base64')],
    ['feed', Buffer.alloc(32, 21).toString('base64')],
    ['notification', Buffer.alloc(32, 23).toString('base64')],
    ['public-activity', Buffer.alloc(32, 27).toString('base64')],
    ['classify', 'prod-classify-inbox-cursor-hmac-key-not-dev-default'],
    ['editor', 'prod-product-editor-cursor-hmac-key-not-dev-default'],
    ['owned', 'prod-owned-collections-cursor-key-not-dev-default'],
    ['link-health', 'prod-link-health-cursor-hmac-key-not-dev-default'],
    ['collection-history', 'prod-collection-versions-cursor-hmac-key-not-dev-default'],
  ];
  for (const [, secret] of collisions) {
    assert.throws(
      () => loadConfig(productionEnv({
        FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
        FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: secret,
      })),
      /independent non-development values of at least 32 bytes in production/u,
    );
  }
  assert.throws(
    () => loadConfig(productionEnv({
      FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'dev-followed-collections-v1',
      FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: PROD_FOLLOWED_COLLECTIONS_SECRET,
    })),
    /independent non-development values of at least 32 bytes in production/u,
  );
  assert.throws(
    () => loadConfig(productionEnv({
      FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
      FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 29).toString('base64'),
    })),
    /independent non-development values of at least 32 bytes in production/u,
  );
  const config = loadConfig(productionEnv({
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: PROD_FOLLOWED_COLLECTIONS_SECRET,
  }));
  assert.equal(config.collectionFollow.cursorKeys.active.id, 'prod-followed-collections-v1');
  assert.equal(config.collectionFollow.cursorKeys.active.secret, PROD_FOLLOWED_COLLECTIONS_SECRET);
});

test('production multi-replica with Collection Follow enabled requires the shared family', () => {
  assert.throws(
    () => loadConfig(productionEnv(replicaShared({
      KNOWN_FEATURE_COLLECTION_FOLLOW: 'true',
      FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
      FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: PROD_FOLLOWED_COLLECTIONS_SECRET,
    }))),
    /AUTH_API_REPLICAS > 1.*with Collection Follow enabled requires COLLECTION_FOLLOW_RATE_LIMIT_SHARED=true/s,
  );
  const disabled = loadConfig(productionEnv(replicaShared({
    KNOWN_FEATURE_COLLECTION_FOLLOW: 'false',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: PROD_FOLLOWED_COLLECTIONS_SECRET,
  })));
  assert.equal(disabled.collectionFollow.enabled, false);
  const shared = loadConfig(productionEnv(replicaShared({
    KNOWN_FEATURE_COLLECTION_FOLLOW: 'true',
    COLLECTION_FOLLOW_RATE_LIMIT_SHARED: 'true',
    COLLECTION_FOLLOW_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    COLLECTION_FOLLOW_RATE_LIMIT_KEY_SECRET: 'collection-follow-rate-limit-hmac-secret',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: PROD_FOLLOWED_COLLECTIONS_SECRET,
  })));
  assert.equal(shared.collectionFollow.enabled, true);
  assert.equal(shared.collectionFollow.rateLimitShared.enabled, true);
});
