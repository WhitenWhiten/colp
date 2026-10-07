import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';

const env = { DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known', NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' };

test('Follow exposure defaults off and explicit on keeps bounded production settings', () => {
  assert.equal(loadConfig(env).follow?.enabled, false);
  const enabled = loadConfig({ ...env, KNOWN_FEATURE_FOLLOW: 'true', FOLLOW_HTTP_TIMEOUT_MS: '250',
    FOLLOW_RATE_LIMIT_MAX: '7', FOLLOW_RATE_LIMIT_WINDOW_MS: '1000' }).follow!;
  assert.equal(enabled.enabled, true); assert.equal(enabled.timeoutMs, 250);
  assert.deepEqual(enabled.rateLimit, { maxRequests: 7, windowMs: 1000 });
  const retained = loadConfig({ ...env, FOLLOW_CURSOR_RETAINED_KEYS: JSON.stringify([{
    id: 'old-v1', secret: Buffer.alloc(32, 8).toString('base64'),
    lastIssuedAt: '2026-07-29T00:00:00.000Z', retainUntil: '2026-07-29T00:15:00.000Z',
  }]) }).follow!;
  assert.equal(retained.cursorKeys.retained[0]?.id, 'old-v1');
});

test('Follow configuration rejects ambiguous flags and invalid independent cursor material', () => {
  assert.throws(() => loadConfig({ ...env, KNOWN_FEATURE_FOLLOW: 'yes' }), /must be true or false/u);
  assert.throws(() => loadConfig({ ...env, FOLLOW_CURSOR_ACTIVE_SECRET: 'shared-secret' }), /key is invalid/u);
  assert.throws(() => loadConfig({ ...env, FOLLOW_CURSOR_RETAINED_KEYS: JSON.stringify([{
    id: 'old-v1', secret: Buffer.alloc(32, 8).toString('base64'),
    lastIssuedAt: '2026-07-29T00:00:00.000Z', retainUntil: '2026-07-29T00:14:59.999Z',
  }]) }), /does not cover Follow cursor TTL/u);
});
