import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';

const env = { DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known', NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' };

test('Feed exposure defaults closed and keeps independent bounded HTTP and cursor settings', () => {
  assert.equal(loadConfig(env).feed?.enabled, false);
  const config = loadConfig({ ...env, KNOWN_FEATURE_FEED: 'true', FEED_HTTP_TIMEOUT_MS: '250',
    FEED_RATE_LIMIT_MAX: '7', FEED_RATE_LIMIT_WINDOW_MS: '1000',
    FEED_CURSOR_ACTIVE_KEY_ID: 'feed-current',
    FEED_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 18).toString('base64'),
    FEED_CURSOR_RETAINED_KEYS: JSON.stringify([{ id: 'feed-old',
      secret: Buffer.alloc(32, 19).toString('base64'), lastIssuedAt: '2026-07-29T00:00:00.000Z',
      retainUntil: '2026-07-29T00:15:00.000Z' }]) }).feed!;
  assert.equal(config.enabled, true); assert.equal(config.timeoutMs, 250);
  assert.deepEqual(config.rateLimit, { maxRequests: 7, windowMs: 1000 });
  assert.equal(config.cursorKeys.retained[0]?.id, 'feed-old');
});

test('Feed rejects ambiguous flags and weak or under-retained independent cursor keys', () => {
  assert.throws(() => loadConfig({ ...env, KNOWN_FEATURE_FEED: 'yes' }), /must be true or false/u);
  assert.throws(() => loadConfig({ ...env, FEED_CURSOR_ACTIVE_SECRET: 'shared-secret' }), /key is invalid/u);
  assert.throws(() => loadConfig({ ...env, FEED_CURSOR_RETAINED_KEYS: JSON.stringify([{
    id: 'feed-old', secret: Buffer.alloc(32, 19).toString('base64'),
    lastIssuedAt: '2026-07-29T00:00:00.000Z', retainUntil: '2026-07-29T00:14:59.999Z',
  }]) }), /does not cover Feed cursor TTL/u);
});
