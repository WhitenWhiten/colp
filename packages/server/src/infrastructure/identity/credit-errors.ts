import { CreditError } from '../../modules/identity/index.js';
import { DatabaseOperationError } from '../database/errors.js';

/** SQL failures never become a zero balance or permission to call a provider for free. */
export function rethrowCreditError(error: unknown): never {
  if (error instanceof CreditError) throw error;
  if (error instanceof DatabaseOperationError) {
    if (error.kind === 'lock_timeout' || error.kind === 'deadlock' || error.kind === 'serialization_failure') {
      throw new CreditError('credits_busy', undefined, { cause: error });
    }
    if (error.kind === 'commit_outcome_unknown') {
      throw new CreditError('credits_unavailable', undefined, { cause: error });
    }
    if (error.cause) return rethrowCreditError(error.cause);
  }
  const failure = typeof error === 'object' && error !== null
    ? error as { code?: unknown; message?: unknown } : undefined;
  if (failure?.code === '55P03' || failure?.code === '40P01' || failure?.code === '40001') {
    throw new CreditError('credits_busy', undefined, { cause: error });
  }
  if (failure?.code === 'P0001' && failure.message === 'credit_reconciliation_required') {
    throw new CreditError('credits_reconciling', undefined, { cause: error });
  }
  if (failure?.code === 'P0001' && failure.message === 'insufficient_credits') {
    throw new CreditError('insufficient_credits', undefined, { cause: error });
  }
  throw new CreditError('credits_unavailable', undefined, { cause: error });
}
