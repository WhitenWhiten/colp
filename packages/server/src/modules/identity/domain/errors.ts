export type IdentityErrorCode =
  | 'account_not_found'
  | 'account_disabled'
  | 'account_deleted'
  | 'identity_conflict'
  | 'handle_taken'
  | 'handle_not_found'
  | 'invalid_handle'
  | 'invalid_display_name'
  | 'invalid_about'
  | 'invalid_email'
  | 'email_unverified'
  | 'email_conflict'
  | 'invalid_return_to'
  | 'session_not_found'
  | 'session_expired'
  | 'session_revoked'
  | 'session_security_epoch_mismatch'
  | 'transaction_not_found'
  | 'transaction_consumed'
  | 'transaction_expired'
  | 'invalid_identity_input';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}
