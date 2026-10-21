/**
 * Connection failures from production node-postgres / pg-pool that mean a
 * credential store could not be consulted. Callers still reject the
 * credential; they must not treat these as a revoked token.
 *
 * `code` is read along the `cause` chain (pg-pool's connect timeout wraps
 * the original error). Messages are matched only by these stable prefixes.
 * A broad /timeout|connection/i test is intentionally not used: pg also
 * raises "Connection terminated" when the client is already ending, and
 * that is not one of these failures.
 */

const POSTGRES_SQLSTATE = /^(?=.*\d)[0-9A-Z]{5}$/u;

const NODE_DEPENDENCY_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const POSTGRES_CONNECTION_FAILURE_PREFIXES = [
  'Connection terminated unexpectedly',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
] as const;

function isPostgresConnectionFailureMessage(message: string): boolean {
  return POSTGRES_CONNECTION_FAILURE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function hasDependencyCode(code: unknown): boolean {
  return typeof code === 'string'
    && (POSTGRES_SQLSTATE.test(code) || NODE_DEPENDENCY_CODES.has(code));
}

export function isCredentialDriverDependencyFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
    };
    if (hasDependencyCode(record.code)) return true;
    if (typeof record.message === 'string' && isPostgresConnectionFailureMessage(record.message)) {
      return true;
    }
    current = record.cause;
  }
  return false;
}
