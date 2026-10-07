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

test('KNOWN_FEATURE_COLLECTION_HISTORY defaults false and rejects illegal values', () => {
  assert.equal(loadConfig(env).collectionHistory.enabled, false);
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_COLLECTION_HISTORY: 'yes' }),
    /KNOWN_FEATURE_COLLECTION_HISTORY must be true or false/u,
  );
  assert.equal(loadConfig({ ...env, KNOWN_FEATURE_COLLECTION_HISTORY: 'true' }).collectionHistory.enabled, true);
  assert.equal(loadConfig({ ...env, KNOWN_FEATURE_COLLECTION_HISTORY: 'false' }).collectionHistory.enabled, false);
});

test('collection history cursor uses Product private TTL and documented non-production defaults', () => {
  const { collectionHistory, linkHealth } = loadConfig(env);
  assert.equal(collectionHistory.cursor.ttlMs, linkHealth.cursor.ttlMs);
  assert.equal(collectionHistory.cursor.current.id, 'dev-collection-versions-v1');
  assert.equal(collectionHistory.cursor.current.key, 'dev-collection-versions-cursor-hmac-key-change-me');
  assert.deepEqual(collectionHistory.cursor.previous, []);
  assert.equal(Object.isFrozen(collectionHistory), true);
  assert.equal('probeTimeoutMs' in collectionHistory, false);
  assert.equal('workerConcurrency' in collectionHistory, false);
  assert.equal('rateLimit' in collectionHistory, false);
});

test('collection history cursor key id rejects unsafe charset', () => {
  assert.throws(
    () => loadConfig({ ...env, PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'bad id!' }),
    /PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID must contain 1-64 URL-safe characters/u,
  );
});

test('production rejects collection-versions HMAC that collides with classify, link-health, editor, or owned keys', () => {
  const collidingClassify = productionEnv({
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
  });
  assert.throws(
    () => loadConfig(collidingClassify),
    /independent non-development values of at least 32 bytes in production/u,
  );
  const collidingLinkHealth = productionEnv({
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
  });
  assert.throws(
    () => loadConfig(collidingLinkHealth),
    /independent non-development values of at least 32 bytes in production/u,
  );
  const collidingEditor = productionEnv({
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
  });
  assert.throws(
    () => loadConfig(collidingEditor),
    /independent non-development values of at least 32 bytes in production/u,
  );
  const collidingOwned = productionEnv({
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
  });
  assert.throws(
    () => loadConfig(collidingOwned),
    /independent non-development values of at least 32 bytes in production/u,
  );
  const config = loadConfig(productionEnv({
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
  }));
  assert.equal(config.collectionHistory.cursor.current.id, 'prod-collection-versions-v1');
  assert.equal(
    config.collectionHistory.cursor.current.key,
    'prod-collection-versions-cursor-hmac-key-not-dev-default',
  );
});

test('collection history previous cursor keys must be unique versus the active key', () => {
  const previous = JSON.stringify([{
    id: 'dev-collection-versions-v1',
    key: 'rotated-collection-versions-cursor-hmac-key',
    lastIssuedAt: '2026-07-26T00:00:00.000Z',
    retainUntil: '2026-07-26T00:15:00.000Z',
  }]);
  assert.throws(
    () => loadConfig({ ...env, PRODUCT_COLLECTION_VERSIONS_CURSOR_PREVIOUS_KEYS: previous }),
    /Collection history cursor key IDs and material must be unique/u,
  );
});
