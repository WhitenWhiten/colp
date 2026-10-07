export type FollowAuthorityErrorCode = 'invalid_profile_identity' | 'self_follow' | 'invalid_follow_record';

export class FollowAuthorityError extends Error {
  constructor(readonly code: FollowAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'FollowAuthorityError';
  }
}

export interface FollowBinding {
  readonly actorProfileId: string;
  readonly targetProfileId: string;
}

export interface FollowRecord extends FollowBinding {
  readonly followedAt: Date;
}

export interface SavedFollow {
  readonly follow: FollowRecord;
  readonly inserted: boolean;
}

/** Transaction-bound authority port. Its implementation must not open a nested transaction. */
export interface FollowRepository {
  save(binding: FollowBinding): Promise<SavedFollow | null>;
  remove(binding: FollowBinding): Promise<boolean>;
}
