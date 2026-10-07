/**
 * FIX-L-010 real COMMIT ACK loss classification.
 *
 * The unit of work previously set its `committed` flag only AFTER the Kysely
 * transaction promise resolved. When the server applied the COMMIT but the
 * acknowledgement was lost on the wire, the transaction promise REJECTED and
 * the connection error was classified as `unavailable` — telemetry and
 * recovery treated the mutation as a provable rollback.
 *
 * The fix records the transaction phase inside a driver wrapper
 * (`TransactionPhaseDriver`): once COMMIT is in flight, a connection failure
 * tags the error as commit-outcome-unknown, and the unit of work classifies it
 * as `commit_outcome_unknown` (never a provable rollback, never auto-retried).
 * Ordinary statement/BEGIN failures and provable SQLSTATE rejections keep
 * their normal classification.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import type {
  AbortableOperationOptions,
  CompiledQuery,
  DatabaseConnection,
  Driver,
  QueryResult,
  TransactionSettings,
} from 'kysely';
import { createUnitOfWork, DatabaseOperationError } from '../../../src/infrastructure/database/index.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import { TransactionPhaseDialect } from '../../../src/infrastructure/database/transaction-phase-driver.js';
import type { TransactionPhaseFaultInjector } from '../../../src/infrastructure/database/transaction-phase-driver.js';

/** In-memory Driver whose phase methods can be programmed to fail. */
class FakeDriver implements Driver {
  beginError: unknown;
  executeError: unknown;
  commitError: unknown;
  rollbackError: unknown;
  beginCalls = 0;
  commitCalls = 0;
  rollbackCalls = 0;
  private readonly connection = new FakeConnection(this);

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}
  acquireConnection(): Promise<DatabaseConnection> {
    // The same connection object is reused, mirroring pg pool client reuse.
    return Promise.resolve(this.connection);
  }
  async releaseConnection(): Promise<void> {}
  async beginTransaction(_connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    this.beginCalls += 1;
    if (this.beginError !== undefined) throw this.beginError;
  }
  async commitTransaction(_connection: DatabaseConnection): Promise<void> {
    this.commitCalls += 1;
    if (this.commitError !== undefined) throw this.commitError;
  }
  async rollbackTransaction(_connection: DatabaseConnection): Promise<void> {
    this.rollbackCalls += 1;
    if (this.rollbackError !== undefined) throw this.rollbackError;
  }
}

class FakeConnection implements DatabaseConnection {
  constructor(private readonly driver: FakeDriver) {}
  async executeQuery<R>(_compiledQuery: CompiledQuery, _options?: AbortableOperationOptions): Promise<QueryResult<R>> {
    if (this.driver.executeError !== undefined) throw this.driver.executeError;
    return { rows: [] };
  }
  async *streamQuery<R>(_compiledQuery: CompiledQuery, _chunkSize: number, _options?: AbortableOperationOptions): AsyncIterableIterator<QueryResult<R>> {
    if (this.driver.executeError !== undefined) throw this.driver.executeError;
    yield { rows: [] };
  }
}

function driverError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function createUnitOfWorkDb(
  driver: Driver,
  faultInjector?: TransactionPhaseFaultInjector,
): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new TransactionPhaseDialect({
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    }, faultInjector),
  });
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail('expected the operation to reject');
}

function expectDatabaseFailure(error: unknown, kind: string): DatabaseOperationError {
  assert.ok(error instanceof DatabaseOperationError, `expected DatabaseOperationError, got ${String(error)}`);
  assert.equal(error.kind, kind);
  return error;
}

test('a clean transaction commits and resolves normally', async () => {
  const driver = new FakeDriver();
  const db = createUnitOfWorkDb(driver);

  const result = await createUnitOfWork(db).execute(async ({ transaction }) => {
    await sql`select 1`.execute(transaction);
    return { committed: true };
  });

  assert.deepEqual(result, { committed: true });
  assert.equal(driver.commitCalls, 1);
  assert.equal(driver.rollbackCalls, 0);
});

test('classifies a lost COMMIT acknowledgement as commit_outcome_unknown when the rollback also loses the connection', async () => {
  const driver = new FakeDriver();
  driver.commitError = driverError('connection reset while awaiting the COMMIT acknowledgement', 'ECONNRESET');
  driver.rollbackError = driverError('connection reset while rolling back after the lost COMMIT', 'ECONNRESET');
  const db = createUnitOfWorkDb(driver);

  // Kysely replaces the commit error with the rollback error when the rollback
  // also dies; the wrapper must keep the unknown classification on that error.
  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'commit_outcome_unknown',
  );
  assert.equal(error.retryableAtCommandBoundary, false,
    'an unknown commit outcome must never be auto-retried');
  assert.equal(driver.commitCalls, 1);
  assert.equal(driver.rollbackCalls, 1);
});

test('classifies a lost COMMIT acknowledgement as commit_outcome_unknown when the follow-up rollback succeeds', async () => {
  const driver = new FakeDriver();
  driver.commitError = driverError('timed out awaiting the COMMIT acknowledgement', 'ETIMEDOUT');
  const db = createUnitOfWorkDb(driver);

  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'commit_outcome_unknown',
  );
  assert.equal(error.retryableAtCommandBoundary, false);
  assert.equal(driver.commitCalls, 1);
  assert.equal(driver.rollbackCalls, 1);
});

test('classifies an uncoded client-close during COMMIT as commit_outcome_unknown', async () => {
  const driver = new FakeDriver();
  driver.commitError = new Error('Client was closed');
  const db = createUnitOfWorkDb(driver);

  // pg reports a client closed mid-query without a code; the outcome of the
  // sent COMMIT is still indeterminate and must not become a provable rollback.
  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'commit_outcome_unknown',
  );
  assert.equal(error.retryableAtCommandBoundary, false);
});

test('keeps the unknown classification when the rollback after a lost COMMIT fails without a code', async () => {
  const driver = new FakeDriver();
  driver.commitError = driverError('connection reset while awaiting the COMMIT acknowledgement', 'ECONNRESET');
  driver.rollbackError = new Error('Client was closed');
  const db = createUnitOfWorkDb(driver);

  // Kysely replaces the commit error with the rollback error; the uncoded
  // rollback failure must keep the indeterminate-commit classification.
  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'commit_outcome_unknown',
  );
  assert.equal(error.retryableAtCommandBoundary, false);
});

test('classifies a connection-class SQLSTATE during COMMIT as commit_outcome_unknown', async () => {
  const driver = new FakeDriver();
  driver.commitError = driverError('connection failure while awaiting the COMMIT acknowledgement', '08006');
  const db = createUnitOfWorkDb(driver);

  // 08006 (connection_failure) is a SQLSTATE but NOT a server rejection of
  // COMMIT: the connection died while the COMMIT was in flight and the server
  // may have applied it. It must classify as commit_outcome_unknown, never as
  // a provable rollback that would allow an automatic non-idempotent retry.
  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'commit_outcome_unknown',
  );
  assert.equal(error.retryableAtCommandBoundary, false,
    'a connection-class SQLSTATE at COMMIT time must never be auto-retried');
  assert.equal(driver.commitCalls, 1);
  assert.equal(driver.rollbackCalls, 1);
});

test('classifies an admin-shutdown SQLSTATE during COMMIT as commit_outcome_unknown even when the rollback replaces the error', async () => {
  const driver = new FakeDriver();
  driver.commitError = driverError('terminating connection due to administrator command', '57P01');
  driver.rollbackError = driverError('connection reset during the rollback', 'ECONNRESET');
  const db = createUnitOfWorkDb(driver);

  // 57P01 (admin_shutdown) is a transport-class failure, not a COMMIT
  // rejection: the server may have applied the commit. The rollback error
  // replaces the commit error; the unknown classification must survive.
  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'commit_outcome_unknown',
  );
  assert.equal(error.retryableAtCommandBoundary, false);
});

test('keeps a provable COMMIT rejection as serialization_failure instead of unknown', async () => {
  const driver = new FakeDriver();
  driver.commitError = driverError('commit could not be serialized', '40001');
  const db = createUnitOfWorkDb(driver);

  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'serialization_failure',
  );
  assert.equal(error.retryableAtCommandBoundary, true,
    'a provably rejected commit stays retryable at the command boundary');
});

test('keeps a statement connection failure as unavailable instead of unknown', async () => {
  const driver = new FakeDriver();
  driver.executeError = driverError('connection reset during the callback statement', 'ECONNRESET');
  const db = createUnitOfWorkDb(driver);

  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'unavailable',
  );
  assert.equal(driver.commitCalls, 0, 'the transaction must never reach COMMIT after a statement failure');
});

test('keeps a BEGIN connection failure as unavailable instead of unknown', async () => {
  const driver = new FakeDriver();
  driver.beginError = driverError('connection reset while beginning the transaction', 'ECONNRESET');
  const db = createUnitOfWorkDb(driver);

  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async () => undefined)),
    'unavailable',
  );
  assert.equal(driver.commitCalls, 0);
  assert.equal(driver.rollbackCalls, 0);
});

test('keeps a rollback connection failure after a callback failure as unavailable instead of unknown', async () => {
  const driver = new FakeDriver();
  driver.executeError = driverError('connection reset during the callback statement', 'ECONNRESET');
  driver.rollbackError = driverError('connection reset during the rollback', 'ECONNRESET');
  const db = createUnitOfWorkDb(driver);

  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'unavailable',
  );
  assert.equal(error.retryableAtCommandBoundary, true);
});

test('keeps a provable COMMIT rejection retryable even when the rollback then dies', async () => {
  const driver = new FakeDriver();
  driver.commitError = driverError('commit could not be serialized', '40001');
  driver.rollbackError = driverError('connection reset during the rollback', 'ECONNRESET');
  const db = createUnitOfWorkDb(driver);

  // The server provably rejected the COMMIT, so the outcome is NOT unknown;
  // the propagated rollback connection error classifies as unavailable and
  // stays retryable at the command boundary (the mutation cannot exist).
  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'unavailable',
  );
  assert.equal(error.retryableAtCommandBoundary, true);
});

test('propagates domain callback errors unchanged', async () => {
  const driver = new FakeDriver();
  const db = createUnitOfWorkDb(driver);

  const error = await captureRejection(createUnitOfWork(db).execute(async () => {
    throw new Error('domain failure');
  }));

  assert.ok(error instanceof Error);
  assert.equal(error.message, 'domain failure');
  assert.ok(!(error instanceof DatabaseOperationError), 'domain errors must not be classified');
  assert.equal(driver.commitCalls, 0);
});

test('keeps classifying the post-commit acknowledgement fault as commit_outcome_unknown', async () => {
  const driver = new FakeDriver();
  const db = createUnitOfWorkDb(driver);

  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db, {
      faultInjector: { afterCommitAcknowledged() { throw new Error('simulated lost acknowledgement'); } },
    }).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'commit_outcome_unknown',
  );
  assert.equal(driver.commitCalls, 1);
});

test('classifies the injected lost-COMMIT-acknowledgement fault as commit_outcome_unknown after the server applied the commit', async () => {
  const driver = new FakeDriver();
  const db = createUnitOfWorkDb(driver, {
    afterCommitApplied() { throw new Error('simulated lost commit acknowledgement'); },
  });

  const error = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'commit_outcome_unknown',
  );
  assert.equal(error.retryableAtCommandBoundary, false);
  assert.equal(driver.commitCalls, 1, 'the COMMIT statement must reach the server before the acknowledgement is lost');
});

test('a later transaction on a reused connection is not affected by a previous commit-unknown', async () => {
  const driver = new FakeDriver();
  const db = createUnitOfWorkDb(driver);
  driver.commitError = driverError('connection reset while awaiting the COMMIT acknowledgement', 'ECONNRESET');

  const first = expectDatabaseFailure(
    await captureRejection(createUnitOfWork(db).execute(async ({ transaction }) => {
      await sql`select 1`.execute(transaction);
    })),
    'commit_outcome_unknown',
  );
  assert.equal(first.retryableAtCommandBoundary, false);

  driver.commitError = undefined;
  const second = await createUnitOfWork(db).execute(async ({ transaction }) => {
    await sql`select 1`.execute(transaction);
    return 'ok';
  });
  assert.equal(second, 'ok');
  assert.equal(driver.beginCalls, 2);
  assert.equal(driver.commitCalls, 2);
});
