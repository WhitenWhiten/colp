export type AccessPolicyErrorCode =
  | 'invalid_membership_role'
  | 'invalid_visibility'
  | 'invalid_access_policy_input';

export class AccessPolicyError extends Error {
  readonly code: AccessPolicyErrorCode;

  constructor(code: AccessPolicyErrorCode, message: string) {
    super(message);
    this.name = 'AccessPolicyError';
    this.code = code;
  }
}

/** Closed domain codes SC-02 maps to Product HTTP. Messages must not include raw emails. */
export type CollaborationErrorCode =
  | 'conceal'
  | 'insufficient_role'
  | 'already_member'
  | 'invite_already_pending'
  | 'invite_not_pending'
  | 'invite_expired'
  | 'owner_immutable'
  | 'self_invite'
  | 'member_limit'
  | 'pending_invite_limit'
  | 'invalid_email'
  | 'invalid_role';

export class CollaborationError extends Error {
  readonly code: CollaborationErrorCode;

  constructor(code: CollaborationErrorCode, message: string) {
    super(message);
    this.name = 'CollaborationError';
    this.code = code;
  }
}

/** Policy ETag mismatch after the collection row lock. Mapped to HTTP 412. */
export class CollaborationPreconditionError extends Error {
  readonly currentEtag: string;

  constructor(currentEtag: string) {
    super('The resource ETag does not match the current representation.');
    this.name = 'CollaborationPreconditionError';
    this.currentEtag = currentEtag;
  }
}
