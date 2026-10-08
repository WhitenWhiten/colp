export type AccountCredentialInputErrorCode = 'invalid_request' | 'invalid_query' | 'invalid_cursor';

export class AccountCredentialInputError extends Error {
  constructor(
    readonly code: AccountCredentialInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccountCredentialInputError';
  }
}

export type AccountCredentialCommandErrorCode =
  | 'invalid_request'
  | 'resource_not_found'
  | 'insufficient_permission'
  | 'precondition_required'
  | 'precondition_failed'
  | 'rate_limited';

export class AccountCredentialCommandError extends Error {
  constructor(
    readonly code: AccountCredentialCommandErrorCode,
    message: string,
    readonly currentEtag: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'AccountCredentialCommandError';
  }
}

export class AccountCredentialCursorError extends Error {
  constructor(readonly code: 'invalid_cursor' | 'snapshot_expired') {
    super(code === 'snapshot_expired' ? 'The credential cursor snapshot expired.' : 'The credential cursor is invalid.');
    this.name = 'AccountCredentialCursorError';
  }
}
