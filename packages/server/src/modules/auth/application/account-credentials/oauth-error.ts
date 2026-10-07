export type AccountKeyOAuthErrorCode =
  | 'invalid_request'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'temporarily_unavailable';

export class AccountKeyOAuthError extends Error {
  readonly statusCode: number;
  readonly error: AccountKeyOAuthErrorCode;
  readonly error_description: string;
  readonly retryAfterSeconds: number | null;

  constructor(
    statusCode: number,
    error: AccountKeyOAuthErrorCode,
    description: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(description);
    this.name = 'AccountKeyOAuthError';
    this.statusCode = statusCode;
    this.error = error;
    this.error_description = description.slice(0, 256);
    this.retryAfterSeconds = retryAfterSeconds;
  }

  toJSON(): { readonly error: AccountKeyOAuthErrorCode; readonly error_description: string } {
    return { error: this.error, error_description: this.error_description };
  }
}

export function invalidRequest(description: string): AccountKeyOAuthError {
  return new AccountKeyOAuthError(400, 'invalid_request', description);
}

export function invalidGrant(): AccountKeyOAuthError {
  return new AccountKeyOAuthError(401, 'invalid_grant', 'The credential is invalid.');
}

export function invalidScope(description: string): AccountKeyOAuthError {
  return new AccountKeyOAuthError(400, 'invalid_scope', description);
}

export function featureDisabled(): AccountKeyOAuthError {
  return new AccountKeyOAuthError(404, 'invalid_request', 'The request is invalid.');
}

export function temporarilyUnavailable(retryAfterSeconds = 1): AccountKeyOAuthError {
  return new AccountKeyOAuthError(503, 'temporarily_unavailable', 'The token service is temporarily unavailable.', retryAfterSeconds);
}

export function tokenRateLimited(retryAfterSeconds: number): AccountKeyOAuthError {
  return new AccountKeyOAuthError(429, 'temporarily_unavailable', 'Too many token requests.', Math.max(1, retryAfterSeconds));
}
