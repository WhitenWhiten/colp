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
    r2Prefix: 'link-previews/',
    workerConcurrency: 2,
    perHostGapMs: 2_000,
    retentionSeconds: 31_536_000,
  });
  assert.equal(loadConfig({ ...env, KNOWN_FEATURE_LINK_PREVIEW: 'TRUE' }).linkPreview.enabled, true);
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
    // Shorter than the one-year immutable cache lifetime of a served object.
    ['LINK_PREVIEW_RETENTION_SECONDS', '86400'],
  ] as const) {
    assert.throws(() => loadConfig({ ...env, [key]: value }), new RegExp(key, 'u'), `${key}=${value}`);
  }
  assert.equal(loadConfig({ ...env, LINK_PREVIEW_HOST_GAP_MS: '0' }).linkPreview.perHostGapMs, 0);
});

test('the prefix must be relative, end in / and not overlap other public objects', () => {
  assert.equal(loadConfig({ ...env, LINK_PREVIEW_R2_PREFIX: 'previews/' }).linkPreview.r2Prefix, 'previews/');
  assert.throws(() => loadConfig({ ...env, LINK_PREVIEW_R2_PREFIX: 'previews' }), /LINK_PREVIEW_R2_PREFIX/u);
  assert.throws(() => loadConfig({ ...env, LINK_PREVIEW_R2_PREFIX: '/previews/' }), /LINK_PREVIEW_R2_PREFIX/u);
  assert.throws(
    () => loadConfig({ ...env, LINK_PREVIEW_R2_PREFIX: 'favicon/previews/' }),
    (error: unknown) => error instanceof RangeError && /link preview prefix/u.test(error.message),
  );
});
