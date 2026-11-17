import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
// Bootstrap and the maintenance CLIs share this exact surface: config.ts
// re-exports the env helpers the bootstrap import graph reaches through the
// dependency-free database-connection leaf.
import {
  loadConfig,
  loadListenHost,
  loadNodeEnvironment,
} from '../../../src/bootstrap/config.js';
import {
  DEFAULT_LISTEN_HOST,
  loadDatabaseConnectionConfig,
} from '../../../src/infrastructure/config/database-connection.js';

/**
 * Minimal legal test configuration. These tests only exercise environment
 * validation, so every feature stays at its closed default.
 */
const TEST_ENV = {
  DATABASE_URL: 'postgres://known:test@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
} as const;

describe('NODE_ENV (C6-1)', () => {
  test('normalizes trim/lowercase and treats a blank value as unset', () => {
    assert.equal(loadNodeEnvironment({}), 'development');
    assert.equal(loadNodeEnvironment({ NODE_ENV: '' }), 'development');
    assert.equal(loadNodeEnvironment({ NODE_ENV: '   ' }), 'development');
    assert.equal(loadNodeEnvironment({ NODE_ENV: 'Production' }), 'production');
    assert.equal(loadNodeEnvironment({ NODE_ENV: ' production ' }), 'production');
    assert.equal(loadNodeEnvironment({ NODE_ENV: 'TEST' }), 'test');
  });

  test('rejects values outside development|test|production', () => {
    assert.throws(
      () => loadNodeEnvironment({ NODE_ENV: 'staging' }),
      /NODE_ENV must be one of development, test, production/u,
    );
    assert.throws(() => loadNodeEnvironment({ NODE_ENV: 'prod' }), /received "prod"/u);
  });

  test('is validated before connection/feature loaders and normalized for them', () => {
    // NODE_ENV fails before the DATABASE_URL requirement can mask the mistake.
    assert.throws(
      () => loadConfig({ NODE_ENV: 'staging' }),
      (error: unknown) => error instanceof Error
        && /NODE_ENV must be one of/u.test(error.message)
        && !/DATABASE_URL/u.test(error.message),
    );
    // "Production" must keep the production SSL default, not fall back to
    // the development default.
    const productionConnection = loadDatabaseConnectionConfig({
      DATABASE_URL: TEST_ENV.DATABASE_URL,
      NODE_ENV: 'Production',
    });
    assert.equal(productionConnection.nodeEnv, 'production');
    assert.equal(productionConnection.databaseSsl, true);
    // Loaders that read NODE_ENV directly (e.g. the OIDC test-provider gate)
    // must see the normalized value rather than ' TEST ' falling through.
    const config = loadConfig({ ...TEST_ENV, NODE_ENV: ' TEST ' });
    assert.equal(config.nodeEnv, 'test');
  });
});

describe('HOST', () => {
  test('empty or whitespace-only HOST stays unset and keeps loopback', () => {
    assert.equal(DEFAULT_LISTEN_HOST, '127.0.0.1');
    assert.equal(loadListenHost({}), DEFAULT_LISTEN_HOST);
    assert.equal(loadListenHost({ HOST: '' }), DEFAULT_LISTEN_HOST);
    assert.equal(loadListenHost({ HOST: '   ' }), DEFAULT_LISTEN_HOST);
    assert.equal(loadConfig({ ...TEST_ENV, HOST: '' }).host, DEFAULT_LISTEN_HOST);
    assert.equal(loadConfig({ ...TEST_ENV, HOST: '  ' }).host, DEFAULT_LISTEN_HOST);
  });

  test('a non-empty HOST is preserved', () => {
    assert.equal(loadListenHost({ HOST: '0.0.0.0' }), '0.0.0.0');
    assert.equal(loadListenHost({ HOST: ' ::1 ' }), '::1');
    assert.equal(loadConfig({ ...TEST_ENV, HOST: '0.0.0.0' }).host, '0.0.0.0');
  });
});
