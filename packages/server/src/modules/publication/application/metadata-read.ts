export interface PublicationMetadataRecord {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
  readonly title: string;
  readonly summary: string | null;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly publicationSlug: string | null;
  readonly rootNodeId: string;
  readonly rootAvailable: boolean;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly tags: readonly string[];
  readonly language: string | null;
  readonly membershipRole: 'owner' | 'editor' | 'viewer' | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface PublicationMetadataReadPort {
  load(input: (
    | { readonly collectionId: string; readonly publicationSlug?: never }
    | { readonly collectionId?: never; readonly publicationSlug: string }
  ) & { readonly actorSubjectId?: string; readonly signal?: AbortSignal }): Promise<PublicationMetadataRecord | null>;
  /**
   * Optional authoritative fence for anonymous cache hits. Implementations
   * must verify the owner account is active and the collection revision still
   * matches the cached public value.
   */
  isPublicCacheCurrent?(collectionId: string, revision: string): Promise<boolean>;
}
