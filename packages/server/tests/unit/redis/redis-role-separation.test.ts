import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { loadMcpRateLimitSharedConfig } from '../../../src/bootstrap/config-rate-limit.js';
import {
  DEFAULT_LIMITER_PEAK_SUBJECTS,
  LIMITER_PURPOSE_COUNT,
  estimateLimiterMaxmemoryBytes,
  formatRedisMaxmemory,
  redisInstanceFingerprint,
  resolveCacheRedisUrl,
  resolveLimiterRedisUrl,
} from '../../../src/bootstrap/config-redis-roles.js';
import { limiterCapabilityFromStates } from '../../../src/transport/limiter-readiness.js';

const env = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

test('fingerprint ignores credentials, db index and treats host:port as the instance', () => {
  assert.equal(
    redisInstanceFingerprint('redis://:secret@cache.internal:6379/0'),
    redisInstanceFingerprint('redis://other:other@cache.internal:6379/3'),
  );
  assert.notEqual(
    redisInstanceFingerprint('redis://cache.internal:6379/0'),
    redisInstanceFingerprint('redis://limiter.internal:6379/0'),
  );
  assert.equal(
    redisInstanceFingerprint('rediss://cache.internal/0'),
    'cache.internal:6380',
  );
});

test('CACHE_REDIS_URL aliases REDIS_URL and rejects a split alias', () => {
  assert.equal(
    resolveCacheRedisUrl({
      CACHE_REDIS_URL: 'redis://cache.internal:6379/0',
    }).url,
    'redis://cache.internal:6379/0',
  );
  assert.equal(
    resolveCacheRedisUrl({
      REDIS_URL: 'redis://cache.internal:6379/0',
    }).label,
    'REDIS_URL',
  );
  assert.throws(
    () => resolveCacheRedisUrl({
      CACHE_REDIS_URL: 'redis://cache.internal:6379/0',
      REDIS_URL: 'redis://limiter.internal:6379/0',
    }),
    /CACHE_REDIS_URL and REDIS_URL must name the same cache instance/u,
  );
});

test('shared limiter URLs fall back to LIMITER_REDIS_URL', () => {
  const loaded = loadMcpRateLimitSharedConfig({
    MCP_RATE_LIMIT_SHARED: 'true',
    LIMITER_REDIS_URL: 'redis://limiter.internal:6379/0',
    MCP_RATE_LIMIT_KEY_SECRET: 'mcp-limiter-key-secret',
  });
  assert.equal(loaded.redisUrl, 'redis://limiter.internal:6379/0');
  assert.equal(
    resolveLimiterRedisUrl(
      { LIMITER_REDIS_URL: 'redis://limiter.internal:6379/0' },
      'SYNC_RATE_LIMIT_REDIS_URL',
      { enabled: true, requiredMessage: 'missing', allowSearchFallback: true },
    ),
    'redis://limiter.internal:6379/0',
  );
});

test('loadConfig refuses the same host:port for cache and limiter', () => {
  assert.throws(
    () => loadConfig({
      ...env,
      KNOWN_CACHE_MODE: 'serve',
      CACHE_REDIS_URL: 'redis://shared.internal:6379/0',
      LIMITER_REDIS_URL: 'redis://shared.internal:6379/1',
    }),
    /Cache Redis and limiter Redis must use distinct instances/u,
  );
  const ok = loadConfig({
    ...env,
    KNOWN_CACHE_MODE: 'serve',
    CACHE_REDIS_URL: 'redis://cache.internal:6379/0',
    REDIS_URL: 'redis://cache.internal:6379/0',
    LIMITER_REDIS_URL: 'redis://limiter.internal:6379/0',
  });
  assert.equal(ok.cache.redis.url, 'redis://cache.internal:6379/0');
});

test('limiter maxmemory is purpose × peak × window × overhead, not a 64 MiB guess', () => {
  const bytes = estimateLimiterMaxmemoryBytes(DEFAULT_LIMITER_PEAK_SUBJECTS);
  assert.equal(bytes, LIMITER_PURPOSE_COUNT * 4000 * 2 * 128 * 5 / 2);
  assert.equal(bytes, 40_960_000);
  assert.equal(formatRedisMaxmemory(bytes), '40mb');
  assert.ok(bytes < 64 * 1024 * 1024);
});

test('limiter capability probe distinguishes in-process ready from shared unavailable', () => {
  assert.deepEqual(limiterCapabilityFromStates(false, false), {
    capability: 'limiter',
    status: 'ready',
    mode: 'in-process',
  });
  assert.deepEqual(limiterCapabilityFromStates(true, true), {
    capability: 'limiter',
    status: 'not-ready',
    mode: 'shared',
    reason: 'limiter_unavailable',
  });
});
