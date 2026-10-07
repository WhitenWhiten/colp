import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  loadConfig,
  sanitizedRuntimeCapacity,
} from '../../support/test-config.js';
import { PUBLICATION_CACHE_EPOCH_TTL_MS } from '../../../src/infrastructure/outbox/index.js';

const env = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

/**
 * Full legal cache fixture (serve mode with a password-bearing Redis URL).
 * Every invalid-input test starts from this fixture and changes exactly one
 * field, so the failing guard is the one under test rather than an earlier one.
 */
const cacheEnv = {
  ...env,
  KNOWN_CACHE_MODE: 'serve',
  KNOWN_CACHE_REQUIRED: 'false',
  REDIS_URL: 'redis://default:super-secret-token@cache.example.internal:6379/0',
  REDIS_COMMAND_TIMEOUT_MS: '75',
  REDIS_CONNECT_TIMEOUT_MS: '1000',
  REDIS_MAX_RETRIES_PER_REQUEST: '1',
  REDIS_KEY_PREFIX: 'known',
  CACHE_MAX_ENTRY_BYTES: '524288',
  CACHE_LOCK_TTL_MS: '1500',
  CACHE_METADATA_SOFT_TTL_MS: '10000',
  CACHE_METADATA_HARD_TTL_MS: '30000',
  CACHE_SNAPSHOT_SOFT_TTL_MS: '10000',
  CACHE_SNAPSHOT_HARD_TTL_MS: '30000',
  CACHE_DIRECTORY_SOFT_TTL_MS: '5000',
  CACHE_DIRECTORY_HARD_TTL_MS: '15000',
  CACHE_PUBLICATION_METADATA_ENABLED: 'false',
  CACHE_PUBLICATION_DIRECTORY_ENABLED: 'false',
  CACHE_PUBLICATION_SNAPSHOT_ENABLED: 'false',
  CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED: 'false',
  CACHE_COLLECTION_BOOKMARK_COUNT_SOFT_TTL_MS: '60000',
  CACHE_COLLECTION_BOOKMARK_COUNT_HARD_TTL_MS: '300000',
};

/**
 * Production-legal base env (mirrors http-security-baseline.test.ts): production
 * requires explicit OIDC/cursor secrets before cache rules are even reached, so
 * production cache assertions must start from a fixture that already parses.
 */
const productionEnv = {
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
  OIDC_TRANSACTION_HMAC_SECRET: 'prod-oidc-transaction-hmac-secret-not-dev-default',
  OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${Buffer.alloc(32, 5).toString('base64')}`,
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
    };

test('off mode parses without REDIS_URL and applies closed defaults', () => {
  const cache = loadConfig(env).cache;
  assert.equal(cache.redis.mode, 'off');
  assert.equal(cache.redis.required, false);
  assert.equal(cache.redis.url, null);
  assert.equal(cache.redis.commandTimeoutMs, 75);
  assert.equal(cache.redis.connectTimeoutMs, 1_000);
  assert.equal(cache.redis.maxRetriesPerRequest, 1);
  assert.equal(cache.redis.keyPrefix, 'known');
  assert.deepEqual(cache.limits, { maxEntryBytes: 524_288, lockTtlMs: 1_500 });
  assert.deepEqual(cache.publication.metadata, { softTtlMs: 10_000, hardTtlMs: 30_000 });
  assert.deepEqual(cache.publication.snapshot, { softTtlMs: 10_000, hardTtlMs: 30_000 });
  assert.deepEqual(cache.publication.directory, { softTtlMs: 5_000, hardTtlMs: 15_000 });
  assert.equal(cache.publication.metadataEnabled, false);
  assert.equal(cache.publication.directoryEnabled, false);
  assert.equal(cache.publication.snapshotEnabled, false);
  assert.deepEqual(cache.collection.bookmarkCount, { softTtlMs: 60_000, hardTtlMs: 300_000 });
  assert.equal(cache.collection.bookmarkCountEnabled, false);
});

test('shadow and serve modes require a REDIS_URL (fail closed)', () => {
  for (const mode of ['shadow', 'serve']) {
    assert.throws(
      () => loadConfig({ ...cacheEnv, KNOWN_CACHE_MODE: mode, REDIS_URL: undefined }),
      /REDIS_URL is required when KNOWN_CACHE_MODE is shadow or serve/u,
      `mode ${mode} must require REDIS_URL`,
    );
    assert.throws(
      () => loadConfig({ ...cacheEnv, KNOWN_CACHE_MODE: mode, REDIS_URL: '   ' }),
      /REDIS_URL is required when KNOWN_CACHE_MODE is shadow or serve/u,
      `mode ${mode} must reject a whitespace-only REDIS_URL`,
    );
  }
});

test('invalid REDIS_URL schemes fail closed without leaking the URL or password', () => {
  for (const mode of ['shadow', 'serve']) {
    for (const url of [
      'http://user:http-secret@cache.example.internal:6379/0',
      'postgres://user:pg-secret@cache.example.internal:5432/known',
      'not-a-url',
      'cache.example.internal:6379',
    ]) {
      assert.throws(
        () => loadConfig({ ...cacheEnv, KNOWN_CACHE_MODE: mode, REDIS_URL: url }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /REDIS_URL must use redis:\/\/ or rediss:\/\/ scheme/u);
          assert.doesNotMatch(message, /http-secret|pg-secret/u);
          assert.ok(
            !message.includes(url),
            `error message must not contain the full REDIS_URL (got: ${message})`,
          );
          return true;
        },
        `mode ${mode} with URL ${url} must fail closed`,
      );
    }
  }
  assert.equal(
    loadConfig({ ...cacheEnv, REDIS_URL: 'rediss://default:tls-token@cache.example.internal:6380/0' })
      .cache.redis.url,
    'rediss://default:tls-token@cache.example.internal:6380/0',
  );
});

test('invalid Redis timeouts and limits fail closed from the legal fixture', () => {
  assert.throws(
    () => loadConfig({ ...cacheEnv, REDIS_COMMAND_TIMEOUT_MS: '0' }),
    /REDIS_COMMAND_TIMEOUT_MS/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, REDIS_COMMAND_TIMEOUT_MS: '5001' }),
    /REDIS_COMMAND_TIMEOUT_MS must be <= 5000/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, REDIS_COMMAND_TIMEOUT_MS: 'abc' }),
    /REDIS_COMMAND_TIMEOUT_MS/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, REDIS_CONNECT_TIMEOUT_MS: '0' }),
    /REDIS_CONNECT_TIMEOUT_MS/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, REDIS_CONNECT_TIMEOUT_MS: '30001' }),
    /REDIS_CONNECT_TIMEOUT_MS must be <= 30000/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, REDIS_CONNECT_TIMEOUT_MS: 'abc' }),
    /REDIS_CONNECT_TIMEOUT_MS/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, REDIS_MAX_RETRIES_PER_REQUEST: '-1' }),
    /REDIS_MAX_RETRIES_PER_REQUEST/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, REDIS_MAX_RETRIES_PER_REQUEST: '11' }),
    /REDIS_MAX_RETRIES_PER_REQUEST must be <= 10/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_MAX_ENTRY_BYTES: '0' }),
    /CACHE_MAX_ENTRY_BYTES/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_MAX_ENTRY_BYTES: '524289' }),
    /CACHE_MAX_ENTRY_BYTES must be <= 524288/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_LOCK_TTL_MS: '0' }),
    /CACHE_LOCK_TTL_MS/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_LOCK_TTL_MS: '60001' }),
    /CACHE_LOCK_TTL_MS must be <= 60000/u,
  );
});

test('TTL inversion (soft >= hard) fails closed for every cache domain', () => {
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_METADATA_SOFT_TTL_MS: '30000' }),
    /CACHE_METADATA_SOFT_TTL_MS must be < CACHE_METADATA_HARD_TTL_MS/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_METADATA_SOFT_TTL_MS: '40000' }),
    /CACHE_METADATA_SOFT_TTL_MS must be <= 30000/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_SNAPSHOT_SOFT_TTL_MS: '30000' }),
    /CACHE_SNAPSHOT_SOFT_TTL_MS must be < CACHE_SNAPSHOT_HARD_TTL_MS/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_DIRECTORY_SOFT_TTL_MS: '15000' }),
    /CACHE_DIRECTORY_SOFT_TTL_MS must be < CACHE_DIRECTORY_HARD_TTL_MS/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_DIRECTORY_SOFT_TTL_MS: '20000' }),
    /CACHE_DIRECTORY_SOFT_TTL_MS must be <= 15000/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_COLLECTION_BOOKMARK_COUNT_SOFT_TTL_MS: '300000' }),
    /CACHE_COLLECTION_BOOKMARK_COUNT_SOFT_TTL_MS must be < CACHE_COLLECTION_BOOKMARK_COUNT_HARD_TTL_MS/u,
  );
  // Adjacent valid pair remains accepted (soft strictly smaller than hard).
  assert.deepEqual(
    loadConfig({ ...cacheEnv, CACHE_METADATA_SOFT_TTL_MS: '29999' }).cache.publication.metadata,
    { softTtlMs: 29_999, hardTtlMs: 30_000 },
  );
});

test('hard TTL above the safe ceiling fails closed for every cache domain', () => {
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_METADATA_HARD_TTL_MS: '30001' }),
    /CACHE_METADATA_HARD_TTL_MS must be <= 30000/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_SNAPSHOT_HARD_TTL_MS: '30001' }),
    /CACHE_SNAPSHOT_HARD_TTL_MS must be <= 30000/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_DIRECTORY_HARD_TTL_MS: '15001' }),
    /CACHE_DIRECTORY_HARD_TTL_MS must be <= 15000/u,
  );
  assert.throws(
    () => loadConfig({ ...cacheEnv, CACHE_COLLECTION_BOOKMARK_COUNT_HARD_TTL_MS: '300001' }),
    /CACHE_COLLECTION_BOOKMARK_COUNT_HARD_TTL_MS must be <= 300000/u,
  );
});

test('every accepted publication hard TTL expires before the epoch can return to zero', () => {
  const cache = loadConfig(cacheEnv).cache;
  for (const ttl of [
    cache.publication.metadata.hardTtlMs,
    cache.publication.snapshot.hardTtlMs,
    cache.publication.directory.hardTtlMs,
  ]) {
    assert.ok(PUBLICATION_CACHE_EPOCH_TTL_MS > 2 * ttl);
  }
});

test('invalid cache mode fails closed', () => {
  for (const mode of ['yes', 'on', 'serve-stale', 'cache', 'shadowy']) {
    assert.throws(
      () => loadConfig({ ...cacheEnv, KNOWN_CACHE_MODE: mode }),
      /KNOWN_CACHE_MODE must be one of off, shadow or serve/u,
      `mode ${mode} must be rejected`,
    );
  }
});

test('invalid publication domain switch values fail closed', () => {
  for (const key of [
    'CACHE_PUBLICATION_METADATA_ENABLED',
    'CACHE_PUBLICATION_DIRECTORY_ENABLED',
    'CACHE_PUBLICATION_SNAPSHOT_ENABLED',
    'CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED',
  ]) {
    for (const value of ['yes', '1', 'enabled', 'TRUEISH']) {
      assert.throws(
        () => loadConfig({ ...cacheEnv, [key]: value }),
        new RegExp(`${key} must be true or false`, 'u'),
        `${key}=${value} must be rejected`,
      );
    }
  }
});

test('KNOWN_CACHE_REQUIRED is a parse-neutral readiness fact', () => {
  const off = loadConfig({ ...env, KNOWN_CACHE_REQUIRED: 'true' }).cache.redis;
  assert.equal(off.required, true);
  assert.equal(off.mode, 'off');

  const serve = loadConfig({ ...cacheEnv, KNOWN_CACHE_REQUIRED: 'true' }).cache.redis;
  assert.equal(serve.required, true);
  assert.equal(serve.mode, 'serve');
  assert.equal(serve.url, cacheEnv.REDIS_URL);

  assert.throws(
    () => loadConfig({ ...cacheEnv, KNOWN_CACHE_REQUIRED: 'yes' }),
    /KNOWN_CACHE_REQUIRED must be true or false/u,
  );
});

test('collection bookmark-count domain flag does not require REDIS_URL in off mode', () => {
  const cache = loadConfig({ ...env, CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED: 'true' }).cache;
  assert.equal(cache.redis.mode, 'off');
  assert.equal(cache.redis.url, null);
  assert.equal(cache.collection.bookmarkCountEnabled, true);
  assert.deepEqual(cache.collection.bookmarkCount, { softTtlMs: 60_000, hardTtlMs: 300_000 });
});

test('production rejects missing explicit Redis URL outside off mode', () => {
  // Production off mode still parses with no Redis URL (dev defaults are off).
  const productionOff = loadConfig(productionEnv).cache.redis;
  assert.equal(productionOff.mode, 'off');
  assert.equal(productionOff.url, null);

  for (const mode of ['shadow', 'serve']) {
    assert.throws(
      () => loadConfig({ ...productionEnv, KNOWN_CACHE_MODE: mode }),
      /REDIS_URL is required when KNOWN_CACHE_MODE is shadow or serve/u,
      `production ${mode} mode must fail closed without an explicit REDIS_URL`,
    );
  }

  const productionServe = loadConfig({
    ...productionEnv,
    KNOWN_CACHE_MODE: 'serve',
    REDIS_URL: 'rediss://default:prod-token@cache.prod.example:6379/0',
  }).cache.redis;
  assert.equal(productionServe.mode, 'serve');
  assert.equal(productionServe.url, 'rediss://default:prod-token@cache.prod.example:6379/0');

  // Production still validates an explicitly supplied (but illegal) scheme.
  assert.throws(
    () => loadConfig({ ...productionEnv, REDIS_URL: 'http://cache.example:6379/0' }),
    /REDIS_URL must use redis:\/\/ or rediss:\/\/ scheme/u,
  );
});

test('off mode still validates an explicitly supplied REDIS_URL scheme', () => {
  assert.throws(
    () => loadConfig({ ...env, REDIS_URL: 'http://cache.example:6379/0' }),
    /REDIS_URL must use redis:\/\/ or rediss:\/\/ scheme/u,
  );
  assert.equal(
    loadConfig({ ...env, REDIS_URL: 'redis://localhost:6379/0' }).cache.redis.url,
    'redis://localhost:6379/0',
  );
});

test('sanitized capacity excludes the full REDIS_URL, password and token', () => {
  const config = loadConfig(cacheEnv);
  assert.equal(
    config.cache.redis.url,
    'redis://default:super-secret-token@cache.example.internal:6379/0',
  );
  const serialized = JSON.stringify(sanitizedRuntimeCapacity(config));
  assert.doesNotMatch(serialized, /super-secret-token/u);
  assert.doesNotMatch(serialized, /cache\.example\.internal/u);
  assert.doesNotMatch(serialized, /redis:\/\//u);
  assert.doesNotMatch(serialized, /REDIS_URL|password|token/i);

  const capacity = sanitizedRuntimeCapacity(config);
  assert.equal(capacity.cache.mode, 'serve');
  assert.equal(capacity.cache.required, false);
  assert.equal(capacity.cache.keyPrefix, 'known');
  assert.equal(capacity.cache.commandTimeoutMs, 75);
  assert.equal(capacity.cache.connectTimeoutMs, 1_000);
  assert.equal(capacity.cache.maxRetriesPerRequest, 1);
  assert.equal(capacity.cache.maxEntryBytes, 524_288);
  assert.equal(capacity.cache.lockTtlMs, 1_500);
  assert.equal(capacity.cache.publication.metadataEnabled, false);
  assert.equal(capacity.cache.publication.directoryEnabled, false);
  assert.equal(capacity.cache.publication.snapshotEnabled, false);
  assert.deepEqual(capacity.cache.publication.metadata, { softTtlMs: 10_000, hardTtlMs: 30_000 });
  assert.deepEqual(capacity.cache.publication.snapshot, { softTtlMs: 10_000, hardTtlMs: 30_000 });
  assert.deepEqual(capacity.cache.publication.directory, { softTtlMs: 5_000, hardTtlMs: 15_000 });
  assert.equal(capacity.cache.collectionBookmarkCountEnabled, false);
  assert.deepEqual(capacity.cache.collectionBookmarkCount, { softTtlMs: 60_000, hardTtlMs: 300_000 });
});

test('explicit bounded values and enabled domain switches parse', () => {
  const cache = loadConfig({
    ...cacheEnv,
    REDIS_COMMAND_TIMEOUT_MS: '5000',
    REDIS_CONNECT_TIMEOUT_MS: '30000',
    REDIS_MAX_RETRIES_PER_REQUEST: '10',
    REDIS_KEY_PREFIX: 'known-cache.v1:',
    CACHE_MAX_ENTRY_BYTES: '262144',
    CACHE_LOCK_TTL_MS: '60000',
    CACHE_METADATA_SOFT_TTL_MS: '1',
    CACHE_METADATA_HARD_TTL_MS: '30000',
    CACHE_SNAPSHOT_SOFT_TTL_MS: '20000',
    CACHE_SNAPSHOT_HARD_TTL_MS: '30000',
    CACHE_DIRECTORY_SOFT_TTL_MS: '5000',
    CACHE_DIRECTORY_HARD_TTL_MS: '15000',
    CACHE_PUBLICATION_METADATA_ENABLED: 'true',
    CACHE_PUBLICATION_DIRECTORY_ENABLED: 'true',
    CACHE_PUBLICATION_SNAPSHOT_ENABLED: 'true',
    CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED: 'true',
    CACHE_COLLECTION_BOOKMARK_COUNT_SOFT_TTL_MS: '1000',
    CACHE_COLLECTION_BOOKMARK_COUNT_HARD_TTL_MS: '300000',
  }).cache;
  assert.equal(cache.redis.commandTimeoutMs, 5_000);
  assert.equal(cache.redis.connectTimeoutMs, 30_000);
  assert.equal(cache.redis.maxRetriesPerRequest, 10);
  assert.equal(cache.redis.keyPrefix, 'known-cache.v1:');
  assert.equal(cache.limits.maxEntryBytes, 262_144);
  assert.equal(cache.limits.lockTtlMs, 60_000);
  assert.deepEqual(cache.publication.metadata, { softTtlMs: 1, hardTtlMs: 30_000 });
  assert.deepEqual(cache.publication.snapshot, { softTtlMs: 20_000, hardTtlMs: 30_000 });
  assert.equal(cache.publication.metadataEnabled, true);
  assert.equal(cache.publication.directoryEnabled, true);
  assert.equal(cache.publication.snapshotEnabled, true);
  assert.equal(cache.collection.bookmarkCountEnabled, true);
  assert.deepEqual(cache.collection.bookmarkCount, { softTtlMs: 1_000, hardTtlMs: 300_000 });
});

test('invalid key prefixes fail closed', () => {
  for (const prefix of ['', ' ', 'known prefix', 'known/prefix', '-leading-dash', 'x'.repeat(65), 'known*']) {
    assert.throws(
      () => loadConfig({ ...cacheEnv, REDIS_KEY_PREFIX: prefix }),
      /REDIS_KEY_PREFIX/u,
      `key prefix ${JSON.stringify(prefix)} must be rejected`,
    );
  }
});



