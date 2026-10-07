import type {
  AbortableOperationOptions,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  TransactionSettings,
} from 'kysely';

/**
 * Transaction-phase driver wrapper (FIX-L-010).
 *
 * Kysely only reports a transaction outcome through the promise of
 * `db.transaction().execute(...)`. When the server applies COMMIT but the
 * acknowledgement is lost on the wire, that promise REJECTS and the caller
 * cannot distinguish "rolled back" from "committed, response lost". The unit
 * of work therefore classified the failure as a provable rollback.
 *
 * This wrapper observes the driver-level transaction phases: once
 * `commitTransaction` is in flight, a failure that does not prove the server
 * rejected the COMMIT leaves the outcome indeterminate. The error is tagged
 * so `unit-of-work.ts` can classify it as `commit_outcome_unknown`; the
 * command receipt / idempotency boundary then recovers by re-reading state
 * instead of blindly retrying.
 *
 * Ordinary statement and BEGIN failures are never tagged (they happen before
 * COMMIT is sent, so a connection failure there is a provable rollback). A
 * server SQLSTATE rejection of the COMMIT statement (40001, 25P02, …) is not
 * tagged either — the server proved the outcome. Connection-class failures at
 * COMMIT time (08xxx, 57P01-3, ECONNRESET, EPIPE, ETIMEDOUT, client closed) are
 * tagged: the server may have applied the commit before the connection died,
 * and `commit_outcome_unknown` is not retryable at the command boundary, so it
 * can never induce a non-idempotent automatic retry.
 */

/** Errors whose COMMIT was sent but whose outcome is indeterminate. */
const commitOutcomeUnknownErrors = new WeakSet<object>();

function markCommitOutcomeUnknown(error: unknown): void {
  if (typeof error === 'object' && error !== null) {
    commitOutcomeUnknownErrors.add(error);
  }
}

export function isCommitOutcomeUnknownError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && commitOutcomeUnknownErrors.has(error);
}

/**
 * PostgreSQL SQLSTATE codes are five characters (class + subclass), e.g. 23505.
 * Domain/application error codes (handle_taken, session_expired, …) must not match.
 */
export function isPostgresSqlStateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

export function isConnectionTransportError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (
    code.startsWith('08')
    || code === '57P01'
    || code === '57P02'
    || code === '57P03'
    || code === 'ECONNRESET'
    || code === 'EPIPE'
    || code === 'ETIMEDOUT'
  );
}

export interface TransactionPhaseFaultInjector {
  /**
   * Runs after the COMMIT statement has been applied by the server and before
   * the acknowledgement is returned to the caller. Throwing simulates a REAL
   * lost COMMIT acknowledgement — the server committed, the response was
   * dropped — and the unit of work classifies the failure as
   * `commit_outcome_unknown`. Evidence probes and integration tests only;
   * never set in production.
   */
  afterCommitApplied?(): void | Promise<void>;
}

type TransactionPhase = 'begin' | 'active' | 'commit-in-flight' | 'commit-unknown' | 'committed';

export class TransactionPhaseDriver implements Driver {
  private readonly inner: Driver;
  private readonly faultInjector: TransactionPhaseFaultInjector | undefined;
  private readonly phases = new WeakMap<DatabaseConnection, TransactionPhase>();

  constructor(inner: Driver, faultInjector?: TransactionPhaseFaultInjector) {
    this.inner = inner;
    this.faultInjector = faultInjector;
  }

  init(options?: AbortableOperationOptions): Promise<void> {
    return this.inner.init(options);
  }

  acquireConnection(options?: AbortableOperationOptions): Promise<DatabaseConnection> {
    return this.inner.acquireConnection(options);
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    this.phases.set(connection, 'begin');
    try {
      await this.inner.beginTransaction(connection, settings);
      this.phases.set(connection, 'active');
    } catch (error) {
      this.phases.delete(connection);
      throw error;
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    this.phases.set(connection, 'commit-in-flight');
    try {
      await this.inner.commitTransaction(connection);
    } catch (error) {
      this.recordCommitFailure(connection, error);
      throw error;
    }
    try {
      await this.faultInjector?.afterCommitApplied?.();
      this.phases.set(connection, 'committed');
    } catch (error) {
      // The COMMIT statement was applied by the server; the injected failure
      // models the lost acknowledgement, so the outcome is indeterminate
      // regardless of the error shape.
      this.phases.set(connection, 'commit-unknown');
      markCommitOutcomeUnknown(error);
      throw error;
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const commitUnknown = this.phases.get(connection) === 'commit-unknown';
    try {
      await this.inner.rollbackTransaction(connection);
      this.phases.delete(connection);
    } catch (error) {
      // Kysely rolls back after a failed COMMIT and the rollback error replaces
      // the commit error. When the COMMIT outcome is indeterminate, any
      // rollback failure leaves it indeterminate: the propagated error must
      // keep the unknown classification.
      if (commitUnknown) {
        markCommitOutcomeUnknown(error);
      }
      throw error;
    }
  }

  savepoint(connection: DatabaseConnection, savepointName: string, compileQuery: QueryCompiler['compileQuery']): Promise<void> {
    if (!this.inner.savepoint) throw new Error('The `savepoint` method is not supported by this driver');
    return this.inner.savepoint(connection, savepointName, compileQuery);
  }

  rollbackToSavepoint(connection: DatabaseConnection, savepointName: string, compileQuery: QueryCompiler['compileQuery']): Promise<void> {
    if (!this.inner.rollbackToSavepoint) {
      throw new Error('The `rollbackToSavepoint` method is not supported by this driver');
    }
    return this.inner.rollbackToSavepoint(connection, savepointName, compileQuery);
  }

  releaseSavepoint(connection: DatabaseConnection, savepointName: string, compileQuery: QueryCompiler['compileQuery']): Promise<void> {
    if (!this.inner.releaseSavepoint) {
      throw new Error('The `releaseSavepoint` method is not supported by this driver');
    }
    return this.inner.releaseSavepoint(connection, savepointName, compileQuery);
  }

  async releaseConnection(connection: DatabaseConnection, options?: AbortableOperationOptions): Promise<void> {
    // Pooled pg clients are reused; the phase record must never leak into the
    // next transaction that borrows the same connection.
    this.phases.delete(connection);
    return this.inner.releaseConnection(connection, options);
  }

  destroy(options?: AbortableOperationOptions): Promise<void> {
    return this.inner.destroy(options);
  }

  private recordCommitFailure(connection: DatabaseConnection, error: unknown): void {
    if (isConnectionTransportError(error)) {
      // Connection/transport-class failure (08xxx, 57P01-3, ECONNRESET, …): the
      // connection died while COMMIT was in flight and the server may have
      // applied it — the outcome is indeterminate.
      this.phases.set(connection, 'commit-unknown');
      markCommitOutcomeUnknown(error);
    } else if (isPostgresSqlStateError(error)) {
      // The server responded with a SQLSTATE rejection of the COMMIT statement
      // (40001, 25P02, 57014, …): the outcome is provably a rollback and the
      // error keeps its normal classification.
      this.phases.delete(connection);
    } else {
      // Uncoded failure while the COMMIT was in flight (client closed, …): the
      // outcome is indeterminate; prefer commit_outcome_unknown over a false
      // rollback.
      this.phases.set(connection, 'commit-unknown');
      markCommitOutcomeUnknown(error);
    }
  }
}

export class TransactionPhaseDialect implements Dialect {
  private readonly inner: Dialect;
  private readonly faultInjector: TransactionPhaseFaultInjector | undefined;

  constructor(inner: Dialect, faultInjector?: TransactionPhaseFaultInjector) {
    this.inner = inner;
    this.faultInjector = faultInjector;
  }

  createDriver(): Driver {
    return new TransactionPhaseDriver(this.inner.createDriver(), this.faultInjector);
  }

  createQueryCompiler(): QueryCompiler {
    return this.inner.createQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return this.inner.createAdapter();
  }

  createIntrospector<DB>(db: Kysely<DB>): DatabaseIntrospector {
    return this.inner.createIntrospector(db);
  }
}
