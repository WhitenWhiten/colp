import { formatUtcDateTime, type CollectionKind } from '../domain/index.js';
import { capabilitiesForRole, resolveEffectiveRole } from '../../access-policy/index.js';
import { strongEntityTag } from '../domain/index.js';
import type { CollectionCapabilities, CollectionView } from './get-editor-page.js';
import {
  PRODUCT_OWNED_COLLECTIONS_COMPARATOR_VERSION,
  PRODUCT_OWNED_COLLECTIONS_CURSOR_PURPOSE,
  PRODUCT_OWNED_COLLECTIONS_CURSOR_TTL_MS,
  PRODUCT_OWNED_COLLECTIONS_SORT,
  OwnedCollectionsCursorError,
  type OwnedCollectionsCursorAfter,
  type OwnedCollectionsCursorFilters,
  type ProductOwnedCollectionsCursorSignerPort,
} from './owned-collections-cursor.js';
import type { CollectionsClock } from './ports.js';

export const OWNED_COLLECTIONS_DEFAULT_LIMIT = 30;
export const OWNED_COLLECTIONS_MAX_LIMIT = 100;
export class OwnedCollectionsInputError extends Error {
  readonly code = 'invalid_query' as const;
  constructor(message: string) { super(message); this.name = 'OwnedCollectionsInputError'; }
}
export interface OwnedCollectionFact {
  readonly id: string; readonly kind: CollectionKind; readonly title: string; readonly summary: string | null;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public'; readonly rootNodeId: string;
  readonly publicationSlug: string | null; readonly allowSearchIndexing: boolean; readonly publishedAt: Date | null;
  readonly resourceRevision: string; readonly contentRevision: string; readonly policyRevision: string;
  readonly createdAt: Date; readonly updatedAt: Date;
}
export interface OwnedCollectionsReadInput {
  readonly ownerSubjectId: string; readonly kind?: CollectionKind;
  readonly visibility?: OwnedCollectionFact['visibility']; readonly limit: number;
  readonly after?: { readonly updatedAt: Date; readonly id: string };
}
export interface OwnedCollectionsReadPort { listOwnedCollections(input: OwnedCollectionsReadInput): Promise<readonly OwnedCollectionFact[]>; }
export interface GetOwnedCollectionsPageInput {
  readonly actor: { readonly subjectId: string }; readonly kind?: CollectionKind;
  readonly visibility?: OwnedCollectionFact['visibility']; readonly limit?: number; readonly cursor?: string;
}
export interface OwnedCollectionsPage {
  readonly items: readonly OwnedCollectionFact[];
  readonly page: { readonly returnedCount: number; readonly hasMore: boolean; readonly nextCursor: string | null };
}
export function toOwnedCollectionListItem(
  row: OwnedCollectionFact,
  actor: { readonly principalId: string; readonly subjectId: string },
): { collection: CollectionView; capabilities: CollectionCapabilities } {
  const role = resolveEffectiveRole({ collectionId: row.id, ownerSubjectId: actor.subjectId,
    visibility: row.visibility, policyRevision: row.policyRevision, membershipRole: null, deleted: false },
  { principalId: actor.principalId, subjectId: actor.subjectId, kind: 'account' });
  const capabilities = capabilitiesForRole(role);
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
      managePublication: capabilities.has('manage_publication'), createNode: capabilities.has('create_node'),
      updateNode: capabilities.has('update_node'), moveNode: capabilities.has('move_node'),
      deleteNode: capabilities.has('delete_node'),
    },
  };
}
export interface GetOwnedCollectionsPagePorts { readonly reads: OwnedCollectionsReadPort; readonly cursors: ProductOwnedCollectionsCursorSignerPort; readonly clock: CollectionsClock; }

export async function getOwnedCollectionsPage(ports: GetOwnedCollectionsPagePorts, input: GetOwnedCollectionsPageInput): Promise<OwnedCollectionsPage> {
  const subjectId = nonEmpty(input.actor?.subjectId, 'actor.subjectId');
  if (input.cursor !== undefined && (input.limit !== undefined || input.kind !== undefined || input.visibility !== undefined)) {
    throw new OwnedCollectionsInputError('cursor and first-page parameters are mutually exclusive');
  }
  const now = await ports.clock.now();
  let limit: number;
  let filters: OwnedCollectionsCursorFilters;
  let after: OwnedCollectionsCursorAfter | undefined;
  let issuedAt: string;
  let expiresAt: string;
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.verify(input.cursor, now);
    if (cursor.subjectId !== subjectId || cursor.purpose !== PRODUCT_OWNED_COLLECTIONS_CURSOR_PURPOSE
      || cursor.sort !== PRODUCT_OWNED_COLLECTIONS_SORT || cursor.comparatorVersion !== PRODUCT_OWNED_COLLECTIONS_COMPARATOR_VERSION) {
      throw new OwnedCollectionsCursorError();
    }
    limit = cursor.limit; filters = cursor.filters; after = cursor.after;
    issuedAt = cursor.issuedAt; expiresAt = cursor.expiresAt;
  } else {
    limit = normalizeLimit(input.limit);
    if (input.kind !== undefined && !['bookmarks', 'reading_path', 'knowledge_collection', 'mixed'].includes(input.kind)) {
      throw new OwnedCollectionsInputError('kind is invalid');
    }
    if (input.visibility !== undefined && !['private', 'protected', 'unlisted', 'public'].includes(input.visibility)) {
      throw new OwnedCollectionsInputError('visibility is invalid');
    }
    filters = { kind: input.kind ?? null, visibility: input.visibility ?? null };
    issuedAt = formatUtcDateTime(now);
    expiresAt = formatUtcDateTime(new Date(now.getTime() + PRODUCT_OWNED_COLLECTIONS_CURSOR_TTL_MS));
  }
  const rows = await ports.reads.listOwnedCollections({ ownerSubjectId: subjectId, limit,
    ...(filters.kind ? { kind: filters.kind } : {}), ...(filters.visibility ? { visibility: filters.visibility } : {}),
    ...(after ? { after: { updatedAt: new Date(after.updatedAt), id: after.id } } : {}) });
  if (rows.length > limit + 1) throw new Error('owned Collections read port exceeded limit+1 contract');
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? ports.cursors.sign({ v: 1, purpose: PRODUCT_OWNED_COLLECTIONS_CURSOR_PURPOSE,
    subjectId, filters, limit, sort: PRODUCT_OWNED_COLLECTIONS_SORT,
    comparatorVersion: PRODUCT_OWNED_COLLECTIONS_COMPARATOR_VERSION,
    after: { updatedAt: last.updatedAt.toISOString(), id: last.id }, issuedAt, expiresAt }) : null;
  return { items, page: { returnedCount: items.length, hasMore, nextCursor } };
}
function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return OWNED_COLLECTIONS_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > OWNED_COLLECTIONS_MAX_LIMIT) throw new OwnedCollectionsInputError(`limit must be an integer between 1 and ${OWNED_COLLECTIONS_MAX_LIMIT}`);
  return value;
}
function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new OwnedCollectionsInputError(`${field} is required`);
  return value;
}
