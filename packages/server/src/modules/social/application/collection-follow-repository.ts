export type CollectionFollowAuthorityErrorCode =
  | 'invalid_collection_follow_identity'
  | 'owner_follow'
  | 'invalid_collection_follow_record';

export class CollectionFollowAuthorityError extends Error {
  constructor(readonly code: CollectionFollowAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'CollectionFollowAuthorityError';
  }
}

export interface CollectionFollowBinding {
  readonly collectionId: string;
  readonly followerProfileId: string;
}

export interface CollectionFollowRecord extends CollectionFollowBinding {
  readonly followedAt: Date;
}

export interface SavedCollectionFollow {
  readonly follow: CollectionFollowRecord;
  readonly inserted: boolean;
}

/** Transaction-bound authority port. Its implementation must not open a nested transaction. */
export interface CollectionFollowRepository {
  save(binding: CollectionFollowBinding): Promise<SavedCollectionFollow | null>;
  remove(binding: CollectionFollowBinding): Promise<boolean>;
  countFollowers(collectionId: string): Promise<number>;
}
