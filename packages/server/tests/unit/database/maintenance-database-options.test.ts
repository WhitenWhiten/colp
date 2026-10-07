import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  MAINTENANCE_IDLE_TX_TIMEOUT_DEFAULT_MS,
  MAINTENANCE_LOCK_TIMEOUT_DEFAULT_MS,
  MAINTENANCE_STATEMENT_TIMEOUT_DEFAULT_MS,
  maintenanceDatabaseRuntimeOptions,
} from '../../../src/infrastructure/database/maintenance-options.js';

describe('maintenance database runtime options (PGC-02 / T-05)', () => {
  test('defaults widen the request-serving 15s/5s/15s budgets', () => {
    const options = maintenanceDatabaseRuntimeOptions({});
    assert.equal(options.statementTimeoutMs, MAINTENANCE_STATEMENT_TIMEOUT_DEFAULT_MS);
    assert.equal(options.lockTimeoutMs, MAINTENANCE_LOCK_TIMEOUT_DEFAULT_MS);
    assert.equal(options.idleTransactionTimeoutMs, MAINTENANCE_IDLE_TX_TIMEOUT_DEFAULT_MS);
    assert.ok(options.statementTimeoutMs > 15_000);
    assert.ok(options.lockTimeoutMs > 5_000);
    assert.ok(options.idleTransactionTimeoutMs > 15_000);
  });

  test('env overrides apply and invalid values fail closed', () => {
    const options = maintenanceDatabaseRuntimeOptions({
      MAINTENANCE_STATEMENT_TIMEOUT_MS: '120000',
      MAINTENANCE_LOCK_TIMEOUT_MS: '10000',
      MAINTENANCE_IDLE_TX_TIMEOUT_MS: '180000',
    });
    assert.equal(options.statementTimeoutMs, 120_000);
    assert.equal(options.lockTimeoutMs, 10_000);
    assert.equal(options.idleTransactionTimeoutMs, 180_000);
    assert.throws(
      () => maintenanceDatabaseRuntimeOptions({ MAINTENANCE_STATEMENT_TIMEOUT_MS: '0' }),
      RangeError,
    );
    assert.throws(
      () => maintenanceDatabaseRuntimeOptions({ MAINTENANCE_LOCK_TIMEOUT_MS: 'later' }),
      RangeError,
    );
  });

  test('migrator and seed CLIs compose the maintenance options', () => {
    for (const source of [
      '../../../src/infrastructure/database/migrate.ts',
      '../../../src/infrastructure/seed/run.ts',
    ]) {
      const text = readFileSync(resolve(import.meta.dirname, source), 'utf8');
      assert.match(text, /maintenanceDatabaseRuntimeOptions\(\)/, source);
    }
    const migrator = readFileSync(resolve(
      import.meta.dirname,
      '../../../src/infrastructure/database/migrate.ts',
    ), 'utf8');
    assert.match(migrator, /loadDatabaseConnectionConfig\(\)/u);
    assert.doesNotMatch(migrator, /\bloadConfig\(\)/u);
  });

  test('the delivery process reads the standard database pool env config', () => {
    const text = readFileSync(
      resolve(import.meta.dirname, '../../../src/bootstrap/delivery-main.ts'),
      'utf8',
    );
    assert.match(text, /database: loadDatabasePoolConfig\(env\)/);
    assert.match(text, /statementTimeoutMs: config\.database\.statementTimeoutMs/);
  });
});
