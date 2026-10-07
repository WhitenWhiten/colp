import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadDatabaseConnectionConfig } from '../../../src/infrastructure/config/database-connection.js';

describe('migration database-only configuration', () => {
  test('does not require application authentication or feature configuration', () => {
    assert.deepEqual(loadDatabaseConnectionConfig({
      DATABASE_URL: 'postgres://known:test@127.0.0.1:5432/known',
      NODE_ENV: 'test',
    }), {
      databaseUrl: 'postgres://known:test@127.0.0.1:5432/known',
      databaseSsl: false,
      nodeEnv: 'test',
    });
  });

  test('keeps production SSL defaults and connection failures fail-closed', () => {
    assert.equal(loadDatabaseConnectionConfig({
      DATABASE_URL: 'postgres://known:test@db.example/known',
      NODE_ENV: 'production',
    }).databaseSsl, true);
    assert.throws(() => loadDatabaseConnectionConfig({}), /DATABASE_URL is required/u);
    assert.throws(() => loadDatabaseConnectionConfig({
      DATABASE_URL: 'postgres://known:test@127.0.0.1:5432/known',
      DATABASE_SSL_MODE: 'optional',
    }), /DATABASE_SSL_MODE must be require or disable/u);
  });
});
