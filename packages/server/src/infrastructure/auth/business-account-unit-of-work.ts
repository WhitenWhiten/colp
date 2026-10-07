/**
 * Task A2 business account unit of work over PostgreSQL.
 *
 * Each execute() opens ONE real database transaction (G0 spike R4: the
 * Better Auth Kysely adapter only provides real transactions when configured
 * with `transaction: true`; business account establishment therefore runs in
 * a self-managed transaction, never an after-hook) and binds every business
 * account port to it. A failure inside the callback rolls back the whole
 * batch — no auth user without a mapping, no business account without
 * profile/handle.
 *
 * Transient database failures (serialization 40001, deadlock 40P01, lock
 * timeout 55P03, unavailable connection before commit) are retried in a fresh
 * transaction up to `maxAttempts`; everything else propagates unchanged so
 * the application facade keeps its stable error classification. Commit-outcome
 * unknown failures are never retried (the commit may have applied).
 */
import type { Kysely } from 'kysely';
import { DatabaseOperationError } from '../database/errors.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  createUnitOfWork,
  type TransactionIsolationLevel,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';
import type { BusinessAccountPorts, BusinessAccountUnitOfWork } from '../../modules/auth/index.js';
import { createPostgresBusinessAccountPorts } from './business-account-repositories.js';

export interface PostgresBusinessAccountUnitOfWorkOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
  readonly retry?: {
    /** Total attempts including the first (default 3). */
    readonly maxAttempts: number;
    /** Base delay between retries in ms; doubles per attempt (default 10). */
    readonly baseDelayMs: number;
  };
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 10;

export function createPostgresBusinessAccountUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresBusinessAccountUnitOfWorkOptions = {},
): BusinessAccountUnitOfWork {
  const maxAttempts = options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('retry.maxAttempts must be a positive integer');
  }
  const baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const unitOfWork = createUnitOfWork(db, {
    isolationLevel: options.isolationLevel,
    faultInjector: options.faultInjector,
  });

  return {
    async execute<Result>(work: (ports: BusinessAccountPorts) => Promise<Result>): Promise<Result> {
      let lastError: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          return await unitOfWork.execute(({ transaction }) =>
            work(createPostgresBusinessAccountPorts(transaction)));
        } catch (error) {
          if (!isRetryableDatabaseError(error) || attempt + 1 >= maxAttempts) throw error;
          lastError = error;
          await sleep(baseDelayMs * 2 ** attempt);
        }
      }
      throw lastError;
    },
  };
}

function isRetryableDatabaseError(error: unknown): boolean {
  return error instanceof DatabaseOperationError && error.retryableAtCommandBoundary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { createPostgresAccountDeletionStore } from './account-deletion-postgres.js';
