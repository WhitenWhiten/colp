export const PUBLICATION_DIRECTORY_SORT = 'updatedAt DESC, id ASC' as const;

export interface PublicationDirectoryFilter {
  readonly tag?: string;
  readonly creator?: string;
  readonly kind?: string;
  readonly updatedSince?: string;
  readonly q?: string;
}

export interface PublicationDirectoryPosition {
  /** Exact PostgreSQL ordering value. This is opaque cursor state, not a wire date-time. */
  readonly orderingUpdatedAtMicros: string;
  readonly idLocator: string;
}

export interface PublicationDirectoryReadRequest {
  readonly principal: 'anonymous' | { readonly subjectId: string };
  readonly filter: PublicationDirectoryFilter;
  readonly limit: number;
  readonly after?: PublicationDirectoryPosition;
  readonly signal?: AbortSignal;
}

export interface PublicationDirectoryRecord {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
  readonly visibility: 'public' | 'protected';
  readonly publicationSlug: string;
  readonly tags: readonly string[];
  readonly language: string | null;
  readonly nodeCount: number;
  readonly updatedAt: string;
  /** Exact PostgreSQL timestamptz value used for keyset ordering. */
  readonly orderingUpdatedAtMicros: string;
  readonly protectedAuthorized: boolean;
}

export interface PublicationDirectoryReadPort {
  loadPage(request: PublicationDirectoryReadRequest): Promise<readonly PublicationDirectoryRecord[]>;
  /** Optional batch owner/lifecycle fence for anonymous directory cache hits. */
  arePublicCacheCollectionsCurrent?(collectionIds: readonly string[]): Promise<boolean>;
}

export class PublicationDirectoryAnchorNotFoundError extends Error {
  constructor() {
    super('Publication Directory continuation anchor was not found.');
    this.name = 'PublicationDirectoryAnchorNotFoundError';
  }
}
