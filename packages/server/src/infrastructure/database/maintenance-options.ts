import type { DatabaseRuntimeOptions } from './runtime.js';

export const MAINTENANCE_STATEMENT_TIMEOUT_DEFAULT_MS = 600_000;
export const MAINTENANCE_LOCK_TIMEOUT_DEFAULT_MS = 30_000;
export const MAINTENANCE_IDLE_TX_TIMEOUT_DEFAULT_MS = 600_000;

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/**
 * Session GUCs for maintenance processes (migrator, seed CLI). They must not
 * inherit the request-serving defaults (15s statement / 5s lock / 15s
 * idle-in-transaction): each migration file runs as one transaction and a
 * transactional CREATE INDEX or backfill on a grown table legitimately
 * outlives a request budget, while a migration waiting on a lock should hold
 * out longer than a request before failing the deploy.
 */
export function maintenanceDatabaseRuntimeOptions(
  env: NodeJS.ProcessEnv = process.env,
): Pick<DatabaseRuntimeOptions, 'statementTimeoutMs' | 'lockTimeoutMs' | 'idleTransactionTimeoutMs'> {
  return Object.freeze({
    statementTimeoutMs: positiveInt(
      'MAINTENANCE_STATEMENT_TIMEOUT_MS',
      env.MAINTENANCE_STATEMENT_TIMEOUT_MS,
      MAINTENANCE_STATEMENT_TIMEOUT_DEFAULT_MS,
    ),
    lockTimeoutMs: positiveInt(
      'MAINTENANCE_LOCK_TIMEOUT_MS',
      env.MAINTENANCE_LOCK_TIMEOUT_MS,
      MAINTENANCE_LOCK_TIMEOUT_DEFAULT_MS,
    ),
    idleTransactionTimeoutMs: positiveInt(
      'MAINTENANCE_IDLE_TX_TIMEOUT_MS',
      env.MAINTENANCE_IDLE_TX_TIMEOUT_MS,
      MAINTENANCE_IDLE_TX_TIMEOUT_DEFAULT_MS,
    ),
  });
}
