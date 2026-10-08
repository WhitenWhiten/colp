/**
 * Fixed Explore creator id when restrict_publication applies.
 * Not derived from the account or subject, and not a catalog filter key.
 */
export const EXPLORE_UNKNOWN_CREATOR_ID = 'unknown';

/**
 * Identity facts used to complete Explore collection creators.
 * Transport maps these onto ExploreCollectionItem.creators.
 * `publicationRestricted` means the account has active restrict_publication:
 * transport must emit EXPLORE_UNKNOWN_CREATOR_ID and ignore the other fields.
 */
export interface ExploreCreatorFacts {
  readonly ownerSubjectId: string;
  readonly accountId: string;
  readonly displayName: string;
  readonly handle: string | null;
  readonly avatarUrl: string | null;
  readonly publicationRestricted?: boolean;
}

export interface ExploreCreatorsQueryPort {
  findByOwnerSubjectIds(
    ownerSubjectIds: readonly string[],
  ): Promise<ReadonlyMap<string, ExploreCreatorFacts>>;
}
