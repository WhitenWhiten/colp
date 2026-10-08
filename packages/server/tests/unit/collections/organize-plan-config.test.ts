import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';

const env = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

test('KNOWN_FEATURE_AI_ORGANIZE defaults false and rejects illegal values', () => {
  assert.equal(loadConfig(env).organizePlans.enabled, false);
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_AI_ORGANIZE: 'yes' }),
    /KNOWN_FEATURE_AI_ORGANIZE must be true or false/u,
  );
  assert.equal(loadConfig({ ...env, KNOWN_FEATURE_AI_ORGANIZE: 'true' }).organizePlans.enabled, true);
  assert.equal(loadConfig({ ...env, KNOWN_FEATURE_AI_ORGANIZE: 'false' }).organizePlans.enabled, false);
});

test('ORGANIZE_PLANNER_ID defaults to host_cluster and rejects unknown values', () => {
  assert.equal(loadConfig(env).organizePlans.plannerId, 'heuristic.v1.host_cluster');
  assert.equal(
    loadConfig({ ...env, ORGANIZE_PLANNER_ID: 'heuristic.v1.assign_existing' }).organizePlans.plannerId,
    'heuristic.v1.assign_existing',
  );
  assert.throws(
    () => loadConfig({ ...env, ORGANIZE_PLANNER_ID: 'llm.v1.demo' }),
    /ORGANIZE_PLANNER_ID is not an allowed heuristic planner id/u,
  );
  assert.throws(
    () => loadConfig({ ...env, ORGANIZE_PLANNER_ID: 'heuristic.v1.unknown' }),
    /ORGANIZE_PLANNER_ID is not an allowed heuristic planner id/u,
  );
});
