import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createDatabasePoolConfig } from '../../../src/infrastructure/database/index.js';

describe('PostgreSQL connection policy', () => {
  test('enforces certificate-validated TLS in production', () => {
    const config = createDatabasePoolConfig('postgres://db.example/known', { production: true });
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  });

  test('sets finite statement, lock and idle transaction timeouts', () => {
    const defaults = createDatabasePoolConfig('postgres://localhost/known');
    assert.equal(defaults.statement_timeout, 15_000);
    assert.equal(defaults.lock_timeout, 5_000);
    assert.equal(defaults.idle_in_transaction_session_timeout, 15_000);
    assert.equal(defaults.keepAlive, true, 'T-13: TCP keepalive protects LISTEN connections');

    const configured = createDatabasePoolConfig('postgres://localhost/known', {
      statementTimeoutMs: 20_000,
      lockTimeoutMs: 2_000,
      idleTransactionTimeoutMs: 7_000,
    });
    assert.equal(configured.statement_timeout, 20_000);
    assert.equal(configured.lock_timeout, 2_000);
    assert.equal(configured.idle_in_transaction_session_timeout, 7_000);
  });
});
