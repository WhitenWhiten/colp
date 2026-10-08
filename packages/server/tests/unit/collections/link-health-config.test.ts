import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';

const env = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

test('KNOWN_FEATURE_LINK_HEALTH defaults false and rejects illegal values', () => {
  assert.equal(loadConfig(env).linkHealth.enabled, false);
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_LINK_HEALTH: 'yes' }),
    /KNOWN_FEATURE_LINK_HEALTH must be true or false/u,
  );
  assert.equal(loadConfig({ ...env, KNOWN_FEATURE_LINK_HEALTH: 'true' }).linkHealth.enabled, true);
});

test('probe and worker numbers default to the contracted budgets', () => {
  const { linkHealth } = loadConfig(env);
  assert.equal(linkHealth.probeTimeoutMs, 8_000);
  assert.equal(linkHealth.connectTimeoutMs, 3_000);
  assert.equal(linkHealth.workerConcurrency, 4);
  assert.equal(linkHealth.perHostGapMs, 1_000);
  assert.equal(linkHealth.workerPollIntervalMs, 1_000);
  assert.equal(linkHealth.workerLeaseDurationMs, 60_000);
});

test('collections application sources do not import infrastructure/egress', () => {
  const roots = [
    join(import.meta.dirname, '../../../src/modules/collections/application'),
    join(import.meta.dirname, '../../../src/modules/collections'),
  ];
  for (const directory of roots) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(join(directory, name), 'utf8');
      assert.equal(
        source.includes('infrastructure/egress'),
        false,
        `${name} must not import infrastructure/egress`,
      );
    }
  }
});
