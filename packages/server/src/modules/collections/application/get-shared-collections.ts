import { formatUtcDateTime, type CollectionKind } from '../domain/index.js';
import { capabilitiesForRole } from '../../access-policy/index.js';
import { strongEntityTag } from '../domain/index.js';
import type { CollectionCapabilities, CollectionView } from './get-editor-page.js';
import {
  OWNED_COLLECTIONS_DEFAULT_LIMIT,
  OWNED_COLLECTIONS_MAX_LIMIT,
  type OwnedCollectionFact,
} from './get-owned-collections.js';
import {
  PRODUCT_OWNED_COLLECTIONS_COMPARATOR_VERSION,
  PRODUCT_OWNED_COLLECTIONS_CURSOR_TTL_MS,
  PRODUCT_OWNED_COLLECTIONS_SORT,
  PRODUCT_SHARED_COLLECTIONS_CURSOR_PURPOSE,
  SharedCollectionsCursorError,
  type OwnedCollectionsCursorAfter,
  type OwnedCollectionsCursorFilters,
  type ProductOwnedCollectionsCursorSignerPort,
} from './owned-collections-cursor.js';
import type { CollectionsClock } from './ports.js';

export const SHARED_COLLECTIONS_DEFAULT_LIMIT = OWNED_COLLECTIONS_DEFAULT_LIMIT;
export const SHARED_COLLECTIONS_MAX_LIMIT = OWNED_COLLECTIONS_MAX_LIMIT;

export class SharedCollectionsInputError extends Error {
  readonly code = 'invalid_query' as const;
  constructor(message: string) { super(message); this.name = 'SharedCollectionsInputError'; }
}

export type SharedMembershipRole = 'editor' | 'viewer';

export interface SharedCollectionFact extends OwnedCollectionFact {
  readonly ownerSubjectId: string;
  readonly membershipRole: SharedMembershipRole;
}

export interface SharedCollectionsReadInput {
  readonly memberSubjectId: string;
  readonly kind?: CollectionKind;
  readonly visibility?: SharedCollectionFact['visibility'];
  readonly limit: number;
  readonly after?: { readonly updatedAt: Date; readonly id: string };
}

export interface SharedCollectionsReadPort {
  listSharedCollections(input: SharedCollectionsReadInput): Promise<readonly SharedCollectionFact[]>;
}

export interface GetSharedCollectionsPageInput {
  readonly actor: { readonly subjectId: string };
  readonly kind?: CollectionKind;
  readonly visibility?: SharedCollectionFact['visibility'];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SharedCollectionsPage {
  readonly items: readonly SharedCollectionFact[];
  readonly page: { readonly returnedCount: number; readonly hasMore: boolean; readonly nextCursor: string | null };
}

export function toSharedCollectionListItem(
  row: SharedCollectionFact,
  membershipRole: SharedMembershipRole,
): { collection: CollectionView; capabilities: CollectionCapabilities } {
  const capabilities = capabilitiesForRole(membershipRole);
  return {
    collection: {
      id: row.id, kind: row.kind, title: row.title, summary: row.summary, visibility: row.visibility,
      publicationSlug: row.publicationSlug, allowSearchIndexing: row.allowSearchIndexing,
      publishedAt: row.publishedAt ? formatUtcDateTime(row.publishedAt) : null,
      rootNodeId: row.rootNodeId, revision: row.resourceRevision, etag: strongEntityTag(row.resourceRevision),
      contentRevision: row.contentRevision, contentEtag: strongEntityTag(row.contentRevision),
      policyRevision: row.policyRevision, policyEtag: strongEntityTag(row.policyRevision),
      createdAt: formatUtcDateTime(row.createdAt), updatedAt: formatUtcDateTime(row.updatedAt),
    },
    capabilities: {
      updateCollection: capabilities.has('update_collection_metadata'),
      managePublication: capabilities.has('manage_publication'),
      createNode: capabilities.has('create_node'),
      updateNode: capabilities.has('update_node'),
      moveNode: capabilities.has('move_node'),
      deleteNode: capabilities.has('delete_node'),
    },
  };
}

export interface GetSharedCollectionsPagePorts {
  readonly reads: SharedCollectionsReadPort;
  readonly cursors: ProductOwnedCollectionsCursorSignerPort;
  readonly clock: CollectionsClock;
}

export async function getSharedCollectionsPage(
  ports: GetSharedCollectionsPagePorts,
  input: GetSharedCollectionsPageInput,
): Promise<SharedCollectionsPage> {
  const subjectId = nonEmpty(input.actor?.subjectId, 'actor.subjectId');
  if (input.cursor !== undefined && (input.limit !== undefined || input.kind !== undefined || input.visibility !== undefined)) {
    throw new SharedCollectionsInputError('cursor and first-page parameters are mutually exclusive');
  }
  const now = await ports.clock.now();
  let limit: number;
  let filters: OwnedCollectionsCursorFilters;
  let after: OwnedCollectionsCursorAfter | undefined;
  let issuedAt: string;
  let expiresAt: string;
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.verify(input.cursor, now);
    if (cursor.subjectId !== subjectId || cursor.purpose !== PRODUCT_SHARED_COLLECTIONS_CURSOR_PURPOSE
      || cursor.sort !== PRODUCT_OWNED_COLLECTIONS_SORT
      || cursor.comparatorVersion !== PRODUCT_OWNED_COLLECTIONS_COMPARATOR_VERSION) {
      throw new SharedCollectionsCursorError();
    }
    limit = cursor.limit; filters = cursor.filters; after = cursor.after;
    issuedAt = cursor.issuedAt; expiresAt = cursor.expiresAt;
  } else {
    limit = normalizeLimit(input.limit);
    if (input.kind !== undefined && !['bookmarks', 'reading_path', 'knowledge_collection', 'mixed'].includes(input.kind)) {
      throw new SharedCollectionsInputError('kind is invalid');
    }
    if (input.visibility !== undefined && !['private', 'protected', 'unlisted', 'public'].includes(input.visibility)) {
      throw new SharedCollectionsInputError('visibility is invalid');
    }
    filters = { kind: input.kind ?? null, visibility: input.visibility ?? null };
    issuedAt = formatUtcDateTime(now);
    expiresAt = formatUtcDateTime(new Date(now.getTime() + PRODUCT_OWNED_COLLECTIONS_CURSOR_TTL_MS));
  }
  const rows = await ports.reads.listSharedCollections({
    memberSubjectId: subjectId, limit,
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.visibility ? { visibility: filters.visibility } : {}),
    ...(after ? { after: { updatedAt: new Date(after.updatedAt), id: after.id } } : {}),
  });
  if (rows.length > limit + 1) throw new Error('shared Collections read port exceeded limit+1 contract');
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? ports.cursors.sign({
    v: 1, purpose: PRODUCT_SHARED_COLLECTIONS_CURSOR_PURPOSE,
    subjectId, filters, limit, sort: PRODUCT_OWNED_COLLECTIONS_SORT,
    comparatorVersion: PRODUCT_OWNED_COLLECTIONS_COMPARATOR_VERSION,
    after: { updatedAt: last.updatedAt.toISOString(), id: last.id }, issuedAt, expiresAt,
  }) : null;
  return { items, page: { returnedCount: items.length, hasMore, nextCursor } };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return SHARED_COLLECTIONS_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > SHARED_COLLECTIONS_MAX_LIMIT) {
    throw new SharedCollectionsInputError(`limit must be an integer between 1 and ${SHARED_COLLECTIONS_MAX_LIMIT}`);
  }
  return value;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SharedCollectionsInputError(`${field} is required`);
  }
  return value;
}
