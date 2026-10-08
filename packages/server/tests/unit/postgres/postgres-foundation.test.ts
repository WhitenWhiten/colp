import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { Kysely } from 'kysely';
import { DatabaseOperationError, classifyDatabaseError, createDatabaseRuntime, createUnitOfWork, type DatabaseSchema, type DatabaseTransaction } from '../../../src/infrastructure/database/index.js';

interface TransactionHarness {
  readonly db: Kysely<DatabaseSchema>;
  readonly transaction: DatabaseTransaction;
  readonly events: string[];
  readonly isolationLevels: string[];
}

function createTransactionHarness(): TransactionHarness {
  const events: string[] = [];
  const isolationLevels: string[] = [];
  const transaction = { marker: 'shared-transaction' } as unknown as DatabaseTransaction;
  const builder = {
    setIsolationLevel(level: string) {
      isolationLevels.push(level);
      return this;
    },
    async execute<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result> {
      events.push('begin');
      try {
        const result = await callback(transaction);
        events.push('commit');
        return result;
      } catch (error: unknown) {
        events.push('rollback');
        throw error;
      }
    },
  };
  const db = { transaction: () => builder } as unknown as Kysely<DatabaseSchema>;
  return { db, transaction, events, isolationLevels };
}

describe('PostgreSQL runtime lifecycle', () => {
  test('closes the pg pool even when Kysely was never initialized', async () => {
    const runtime = createDatabaseRuntime('postgres://unused:unused@127.0.0.1:1/unused');

    const firstClose = runtime.close();
    assert.equal(firstClose, runtime.close());
    await firstClose;

    assert.equal(runtime.pool.ended, true);
    await assert.rejects(runtime.pool.query('select 1'), /end/i);
  });
});

describe('transaction-bound Unit of Work', () => {
  test('invokes the callback exactly once, returns its exact result, and commits', async () => {
    const harness = createTransactionHarness();
    const callbackResult = { operationId: 'operation-1' };
    let invocationCount = 0;

    const result = await createUnitOfWork(harness.db, { isolationLevel: 'serializable' }).execute(async () => {
      invocationCount += 1;
      return callbackResult;
    });

    assert.equal(invocationCount, 1);
    assert.equal(result, callbackResult);
    assert.deepEqual(harness.events, ['begin', 'commit']);
    assert.deepEqual(harness.isolationLevels, ['serializable']);
  });

  test('passes the same transaction object to every transaction-bound port', async () => {
    const harness = createTransactionHarness();
    const seen: DatabaseTransaction[] = [];
    const firstPort = async (transaction: DatabaseTransaction) => { seen.push(transaction); };
    const secondPort = async (transaction: DatabaseTransaction) => { seen.push(transaction); };

    await createUnitOfWork(harness.db).execute(async ({ transaction }) => {
      await firstPort(transaction);
      await secondPort(transaction);
    });

    assert.deepEqual(seen, [harness.transaction, harness.transaction]);
    assert.equal(seen[0], seen[1]);
  });

  test('rolls back a callback failure without re-entering the callback', async () => {
    const harness = createTransactionHarness();
    const callbackFailure = new Error('reject mutation');
    let invocationCount = 0;

    await assert.rejects(
      createUnitOfWork(harness.db).execute(async () => {
        invocationCount += 1;
        throw callbackFailure;
      }),
      // Non-SQLSTATE application/callback errors must not be reclassified as database_failure.
      (error: unknown) => error === callbackFailure,
    );

    assert.equal(invocationCount, 1);
    assert.deepEqual(harness.events, ['begin', 'rollback']);
  });

  test('fails closed if a transaction helper attempts to invoke its callback twice', async () => {
    const transaction = { marker: 'retrying-transaction' } as unknown as DatabaseTransaction;
    const retryingBuilder = {
      setIsolationLevel() { return this; },
      async execute<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result> {
        await callback(transaction);
        return callback(transaction);
      },
    };
    const db = { transaction: () => retryingBuilder } as unknown as Kysely<DatabaseSchema>;
    let invocationCount = 0;

    await assert.rejects(
      createUnitOfWork(db).execute(async () => {
        invocationCount += 1;
        return 'must-not-be-replayed';
      }),
      (error: unknown) => error instanceof Error
        && /re-entry is forbidden/.test(error.message),
    );

    assert.equal(invocationCount, 1);
  });

  test('reports an acknowledgement loss as unknown only after one committed callback', async () => {
    const harness = createTransactionHarness();
    const acknowledgementFailure = new Error('connection lost after COMMIT');
    let invocationCount = 0;

    await assert.rejects(
      createUnitOfWork(harness.db, {
        faultInjector: {
          afterCommitAcknowledged() { throw acknowledgementFailure; },
        },
      }).execute(async () => {
        invocationCount += 1;
        return 'committed';
      }),
      (error: unknown) => error instanceof DatabaseOperationError
        && error.kind === 'commit_outcome_unknown'
        && error.retryableAtCommandBoundary === false
        && error.cause === acknowledgementFailure,
    );

    assert.equal(invocationCount, 1);
    assert.deepEqual(harness.events, ['begin', 'commit']);
  });
});

describe('PostgreSQL failure classification', () => {
  const cases = [
    ['40001', 'serialization_failure', true],
    ['40P01', 'deadlock', true],
    ['23505', 'unique_violation', false],
  ] as const;

  for (const [code, kind, retryable] of cases) {
    test(`classifies SQLSTATE ${code} as ${kind}`, () => {
      const cause = Object.assign(new Error('driver detail'), { code });
      const error = classifyDatabaseError(cause);
      assert.equal(error.kind, kind);
      assert.equal(error.retryableAtCommandBoundary, retryable);
      assert.equal(error.cause, cause);
      assert.doesNotMatch(error.message, /driver detail/);
    });

    test(`does not replay a callback when transaction completion fails with SQLSTATE ${code}`, async () => {
      const transaction = { marker: code } as unknown as DatabaseTransaction;
      const cause = Object.assign(new Error('transaction completion failed'), { code });
      const failingBuilder = {
        setIsolationLevel() { return this; },
        async execute<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result> {
          await callback(transaction);
          throw cause;
        },
      };
      const db = { transaction: () => failingBuilder } as unknown as Kysely<DatabaseSchema>;
      let invocationCount = 0;

      await assert.rejects(
        createUnitOfWork(db).execute(async () => {
          invocationCount += 1;
          return 'not-committed';
        }),
        (error: unknown) => error instanceof DatabaseOperationError
          && error.kind === kind
          && error.retryableAtCommandBoundary === retryable,
      );
      assert.equal(invocationCount, 1);
    });
  }

  test('unknown commit outcome takes precedence over a retryable SQLSTATE', () => {
    const cause = Object.assign(new Error('lost response'), { code: '40001' });
    const error = classifyDatabaseError(cause, true);
    assert.equal(error.kind, 'commit_outcome_unknown');
    assert.equal(error.retryableAtCommandBoundary, false);
  });

  test('propagates domain and fault-injection errors without wrapping as database_failure', async () => {
    class DomainProbeError extends Error {
      readonly code = 'session_expired';
      constructor() {
        super('session expired probe');
        this.name = 'DomainProbeError';
      }
    }
    const harness = createTransactionHarness();

    await assert.rejects(
      createUnitOfWork(harness.db).execute(async () => {
        throw new DomainProbeError();
      }),
      (error: unknown) => error instanceof DomainProbeError && error.code === 'session_expired',
    );

    await assert.rejects(
      createUnitOfWork(harness.db, {
        faultInjector: {
          afterCallbackBeforeCommit: () => {
            throw new Error('force identity bootstrap rollback');
          },
        },
      }).execute(async () => 'ok'),
      /force identity bootstrap rollback/,
    );

    assert.deepEqual(harness.events, ['begin', 'rollback', 'begin', 'rollback']);
  });
});
