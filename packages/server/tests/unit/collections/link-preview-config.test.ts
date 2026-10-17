import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';

const env = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

test('KNOWN_FEATURE_LINK_PREVIEW defaults off with the contracted numbers', () => {
  const { linkPreview } = loadConfig(env);
  assert.equal(Object.isFrozen(linkPreview), true);
  assert.deepEqual({ ...linkPreview }, {
    enabled: false,
    workerConcurrency: 2,
    perHostGapMs: 2_000,
    retentionSeconds: 1_296_000,
  });
  assert.equal(loadConfig({ ...env, KNOWN_FEATURE_LINK_PREVIEW: 'TRUE' }).linkPreview?.enabled, true);
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_LINK_PREVIEW: 'yes' }),
    /KNOWN_FEATURE_LINK_PREVIEW must be true or false/u,
  );
});

test('out-of-range numbers fail startup with the env key', () => {
  for (const [key, value] of [
    ['LINK_PREVIEW_CONCURRENCY', '0'],
    ['LINK_PREVIEW_CONCURRENCY', '9'],
    ['LINK_PREVIEW_CONCURRENCY', '1.5'],
    ['LINK_PREVIEW_HOST_GAP_MS', '-1'],
    ['LINK_PREVIEW_HOST_GAP_MS', '60001'],
    // A displaced object must outlive the longest (15-day) image cache.
    ['LINK_PREVIEW_RETENTION_SECONDS', '86400'],
    ['LINK_PREVIEW_RETENTION_SECONDS', '1295999'],
  ] as const) {
    assert.throws(() => loadConfig({ ...env, [key]: value }), new RegExp(key, 'u'), `${key}=${value}`);
  }
  assert.equal(loadConfig({ ...env, LINK_PREVIEW_HOST_GAP_MS: '0' }).linkPreview?.perHostGapMs, 0);
  assert.equal(loadConfig({ ...env, LINK_PREVIEW_RETENTION_SECONDS: '1296000' }).linkPreview?.retentionSeconds, 1_296_000);
});

test('the worker budget counts link preview fetches only while the feature is on', () => {
  const tight = { ...env, DATABASE_POOL_MAX: '3' };
  assert.doesNotThrow(() => loadConfig(tight));
  assert.throws(
    () => loadConfig({ ...tight, KNOWN_FEATURE_LINK_PREVIEW: 'true' }),
    /LINK_PREVIEW_CONCURRENCY=2/u,
  );
});
