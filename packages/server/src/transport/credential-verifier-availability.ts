import { DatabaseOperationError } from '../infrastructure/database/errors.js';
import { ExtensionAuthError, IdTokenVerificationError } from '../modules/identity/index.js';
import {
  isCredentialDriverDependencyFailure,
  McpOauthVerificationError,
} from '../modules/mcp/index.js';

const JWKS_DEPENDENCY_REASONS = new Set([
  'jwks_timeout',
  'jwks_fetch_failed',
  'jwks_malformed',
]);

/**
 * True when credential verification failed because a dependency could not be
 * consulted. Bad signatures, expiry, issuer, audience, and token shape stay
 * false so callers keep rejecting them as authentication failures.
 *
 * Driver failures include SQLSTATE / node errno values on the error or any
 * `cause`, and the three pg connection messages that production raises
 * without a `code`.
 */
export function isCredentialVerifierDependencyFailure(error: unknown): boolean {
  if (error instanceof ExtensionAuthError) return error.reason === 'verifier_unavailable';
  if (error instanceof McpOauthVerificationError) {
    return error.reason === 'dependency_unavailable'
      || JWKS_DEPENDENCY_REASONS.has(error.reason);
  }
  if (error instanceof IdTokenVerificationError) {
    return JWKS_DEPENDENCY_REASONS.has(error.reason);
  }
  if (error instanceof DatabaseOperationError) return true;
  return isCredentialDriverDependencyFailure(error);
}

export function credentialVerificationHttpCode(
  error: unknown,
): 'authentication_required' | 'service_unavailable' {
  return isCredentialVerifierDependencyFailure(error)
    ? 'service_unavailable'
    : 'authentication_required';
}
