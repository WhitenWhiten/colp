import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { productionEnv } from '../../support/http-security-config-env.js';

const env = {
  DATABASE_URL: 'postgres://localhost/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

test('KNOWN_FEATURE_CLASSIFY defaults false and rejects illegal values', () => {
  assert.equal(loadConfig(env).classifyInbox.enabled, false);
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_CLASSIFY: 'yes' }),
    /KNOWN_FEATURE_CLASSIFY must be true or false/u,
  );
  assert.equal(loadConfig({ ...env, KNOWN_FEATURE_CLASSIFY: 'true' }).classifyInbox.enabled, true);
  assert.equal(loadConfig({ ...env, KNOWN_FEATURE_CLASSIFY: 'false' }).classifyInbox.enabled, false);
});

test('classify inbox cursor uses Product private TTL and documented non-production defaults', () => {
  const { classifyInbox, linkHealth } = loadConfig(env);
  assert.equal(classifyInbox.cursor.ttlMs, linkHealth.cursor.ttlMs);
  assert.equal(classifyInbox.cursor.current.id, 'dev-classify-inbox-v1');
  assert.equal(classifyInbox.cursor.current.key, 'dev-classify-inbox-cursor-hmac-key-change-me');
  assert.deepEqual(classifyInbox.cursor.previous, []);
  assert.equal(Object.isFrozen(classifyInbox), true);
  assert.equal('probeTimeoutMs' in classifyInbox, false);
  assert.equal('workerConcurrency' in classifyInbox, false);
  assert.equal('rateLimit' in classifyInbox, false);
});

test('classify inbox cursor key id rejects unsafe charset', () => {
  assert.throws(
    () => loadConfig({ ...env, PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'bad id!' }),
    /PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID must contain 1-64 URL-safe characters/u,
  );
});

test('production rejects classify HMAC that collides with link-health or editor keys', () => {
  const collidingLinkHealth = productionEnv({
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
  });
  assert.throws(
    () => loadConfig(collidingLinkHealth),
    /independent non-development values of at least 32 bytes in production/u,
  );
  const collidingEditor = productionEnv({
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
  });
  assert.throws(
    () => loadConfig(collidingEditor),
    /independent non-development values of at least 32 bytes in production/u,
  );
  const config = loadConfig(productionEnv({
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
  }));
  assert.equal(config.classifyInbox.cursor.current.id, 'prod-classify-inbox-v1');
  assert.equal(
    config.classifyInbox.cursor.current.key,
    'prod-classify-inbox-cursor-hmac-key-not-dev-default',
  );
});

test('classify inbox previous cursor keys must be unique versus the active key', () => {
  const previous = JSON.stringify([{
    id: 'dev-classify-inbox-v1',
    key: 'rotated-classify-inbox-cursor-hmac-key',
    lastIssuedAt: '2026-07-26T00:00:00.000Z',
    retainUntil: '2026-07-26T00:15:00.000Z',
  }]);
  assert.throws(
    () => loadConfig({ ...env, PRODUCT_CLASSIFY_INBOX_CURSOR_PREVIOUS_KEYS: previous }),
    /Classify inbox cursor key IDs and material must be unique/u,
  );
});
