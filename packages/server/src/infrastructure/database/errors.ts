export type DatabaseFailureKind =
  | 'serialization_failure'
  | 'deadlock'
  | 'lock_timeout'
  | 'unavailable'
  | 'unique_violation'
  | 'commit_outcome_unknown'
  | 'database_failure';

interface ErrorWithCode {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

export class DatabaseOperationError extends Error {
  readonly kind: DatabaseFailureKind;
  readonly retryableAtCommandBoundary: boolean;
  /** Named database constraint only; driver detail and values remain in the private cause. */
  readonly constraint: string | null;

  constructor(kind: DatabaseFailureKind, cause: unknown) {
    super(messageFor(kind), { cause });
    this.name = 'DatabaseOperationError';
    this.kind = kind;
    this.constraint = constraintName(cause);
    this.retryableAtCommandBoundary = kind === 'serialization_failure'
      || kind === 'deadlock'
      || kind === 'lock_timeout'
      || kind === 'unavailable';
  }
}

function constraintName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const constraint = (error as ErrorWithCode).constraint;
  return typeof constraint === 'string' && constraint.length > 0 ? constraint : null;
}

export function isPostgresErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as ErrorWithCode).code === code;
}

export function classifyDatabaseError(
  error: unknown,
  commitMayHaveSucceeded = false,
): DatabaseOperationError {
  if (commitMayHaveSucceeded) {
    return new DatabaseOperationError('commit_outcome_unknown', error);
  }
  if (error instanceof DatabaseOperationError) return error;
  if (isConnectionOutcomeUnknown(error)) return new DatabaseOperationError('unavailable', error);
  if (isPostgresErrorCode(error, '40001')) return new DatabaseOperationError('serialization_failure', error);
  if (isPostgresErrorCode(error, '40P01')) return new DatabaseOperationError('deadlock', error);
  if (isPostgresErrorCode(error, '55P03')) return new DatabaseOperationError('lock_timeout', error);
  if (isPostgresErrorCode(error, '23505')) return new DatabaseOperationError('unique_violation', error);
  return new DatabaseOperationError('database_failure', error);
}

function isConnectionOutcomeUnknown(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as ErrorWithCode).code;
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

function messageFor(kind: DatabaseFailureKind): string {
  switch (kind) {
    case 'serialization_failure': return 'The database transaction could not be serialized.';
    case 'deadlock': return 'The database transaction was aborted after a deadlock.';
    case 'lock_timeout': return 'The database transaction exceeded its lock wait limit.';
    case 'unavailable': return 'The database service is temporarily unavailable.';
    case 'unique_violation': return 'The database rejected a duplicate value.';
    case 'commit_outcome_unknown': return 'The transaction commit outcome is unknown.';
    case 'database_failure': return 'The database operation failed.';
  }
}
