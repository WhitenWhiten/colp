export type ReportsDomainErrorCode =
  | 'invalid_input'
  | 'invalid_transition'
  | 'source_rebind_forbidden'
  | 'self_follow_forbidden'
  | 'lease_conflict';

export class ReportsDomainError extends Error {
  readonly code: ReportsDomainErrorCode;
  constructor(code: ReportsDomainErrorCode, message: string) {
    super(message);
    this.name = 'ReportsDomainError';
    this.code = code;
  }
}
