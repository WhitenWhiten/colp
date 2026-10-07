import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  DATABASE_BUDGET_POOL_RESERVE,
  DATABASE_BUDGET_SERVER_OVERHEAD,
  assertDatabaseConnectionBudget,
} from '../../../src/bootstrap/config-cache.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://operator:s3cret-value@db.example:5432/known',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
} as const;

const DATABASE = Object.freeze({
  maxConnections: 10,
  connectionTimeoutMs: 2_000,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 5_000,
  idleTransactionTimeoutMs: 15_000,
});

describe('database connection budget (PGC-01 / T-06)', () => {
  test('sums only enabled worker loops against pool minus reserve', () => {
    assert.equal(DATABASE_BUDGET_POOL_RESERVE, 2);
    // 4 + 4 = 8 <= 10 - 2 passes; disabled loops contribute nothing.
    assertDatabaseConnectionBudget({
      env: {},
      database: DATABASE,
      apiReplicas: 1,
      workerLoops: [
        { name: 'WORKER_CONCURRENCY', concurrency: 4 },
        { name: 'LINK_HEALTH_WORKER_CONCURRENCY', concurrency: 4 },
        { name: 'READABLE_REPLICA_WORKER_CONCURRENCY', concurrency: 0 },
      ],
    });
    assert.throws(
      () => assertDatabaseConnectionBudget({
        env: {},
        database: DATABASE,
        apiReplicas: 1,
        workerLoops: [
          { name: 'WORKER_CONCURRENCY', concurrency: 4 },
          { name: 'LINK_HEALTH_WORKER_CONCURRENCY', concurrency: 4 },
          { name: 'READABLE_REPLICA_WORKER_CONCURRENCY', concurrency: 2 },
        ],
      }),
      /Worker loop concurrency total \(WORKER_CONCURRENCY=4 \+ LINK_HEALTH_WORKER_CONCURRENCY=4 \+ READABLE_REPLICA_WORKER_CONCURRENCY=2 = 10\) must be <= DATABASE_POOL_MAX - 2 \(8\)/,
    );
  });

  test('asserts replica demand against DATABASE_SERVER_MAX_CONNECTIONS when set', () => {
    assert.equal(DATABASE_BUDGET_SERVER_OVERHEAD, 6);
    const loops = [{ name: 'WORKER_CONCURRENCY', concurrency: 1 }];
    // 3 x 10 + 10 + 6 = 46 <= 80 passes.
    assertDatabaseConnectionBudget({
      env: { DATABASE_SERVER_MAX_CONNECTIONS: '80' },
      database: DATABASE,
      apiReplicas: 3,
      workerLoops: loops,
    });
    // 7 x 10 + 10 + 6 = 86 > 80 fails fast.
    assert.throws(
      () => assertDatabaseConnectionBudget({
        env: { DATABASE_SERVER_MAX_CONNECTIONS: '80' },
        database: DATABASE,
        apiReplicas: 7,
        workerLoops: loops,
      }),
      /connection demand \(7 API replicas x DATABASE_POOL_MAX 10 \+ worker pool 10 \+ overhead 6 = 86\) exceeds DATABASE_SERVER_MAX_CONNECTIONS \(80\)/,
    );
    // Unset server max skips the replica assertion entirely.
    assertDatabaseConnectionBudget({
      env: {},
      database: DATABASE,
      apiReplicas: 100,
      workerLoops: loops,
    });
  });

  test('loadConfig wires enabled feature loops into the budget', () => {
    // Defaults pass: outbox 1 <= 10 - 2.
    loadConfig({ ...BASE_ENV });
    // link-health (4) + readable-replica (2) + outbox (4) = 10 > 8.
    assert.throws(
      () => loadConfig({
        ...BASE_ENV,
        WORKER_CONCURRENCY: '4',
        KNOWN_FEATURE_LINK_HEALTH: 'true',
        KNOWN_FEATURE_READABLE_REPLICA: 'true',
      }),
      /Worker loop concurrency total .* must be <= DATABASE_POOL_MAX - 2/,
    );
    // Raising the pool restores the budget.
    loadConfig({
      ...BASE_ENV,
      DATABASE_POOL_MAX: '16',
      WORKER_CONCURRENCY: '4',
      KNOWN_FEATURE_LINK_HEALTH: 'true',
      KNOWN_FEATURE_READABLE_REPLICA: 'true',
    });
    // The server budget rejects an over-provisioned replica count.
    assert.throws(
      () => loadConfig({
        ...BASE_ENV,
        AUTH_API_REPLICAS: '8',
        DATABASE_SERVER_MAX_CONNECTIONS: '80',
      }),
      /exceeds DATABASE_SERVER_MAX_CONNECTIONS \(80\)/,
    );
  });
});
