import { formatUtcDateTime } from '../domain/index.js';
import {
  CollectionVersionInputError,
  CollectionVersionNotFoundError,
  countCollectionTreeChangesWithIndex,
  indexLiveCollectionTree,
  type CollectionVersionStorePort,
} from './capture-collection-tree-version.js';
import {
  CollectionVersionCursorError,
  PRODUCT_COLLECTION_VERSIONS_COMPARATOR_VERSION,
  PRODUCT_COLLECTION_VERSIONS_CURSOR_PURPOSE,
  PRODUCT_COLLECTION_VERSIONS_CURSOR_TTL_MS,
  PRODUCT_COLLECTION_VERSIONS_SORT,
  type ProductCollectionVersionCursorSignerPort,
} from './collection-version-cursor.js';
import { toCollectionVersionDto, type CollectionVersionDto } from './create-collection-version.js';

export const COLLECTION_VERSIONS_DEFAULT_LIMIT = 20;
export const COLLECTION_VERSIONS_MAX_LIMIT = 50;
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface CollectionVersionPage {
  readonly items: readonly CollectionVersionDto[];
  readonly nextCursor: string | null;
}

export interface ListCollectionVersionsPorts {
  readonly versions: CollectionVersionStorePort;
  readonly cursors: ProductCollectionVersionCursorSignerPort;
  readonly clock: { now(): Date | Promise<Date> };
}

export interface ListCollectionVersionsInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly collectionId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export async function listCollectionVersions(
  ports: ListCollectionVersionsPorts,
  input: ListCollectionVersionsInput,
): Promise<CollectionVersionPage> {
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new CollectionVersionInputError('The collection-version actor is invalid.');
  }
  if (typeof input.collectionId !== 'string' || !OPAQUE_ID.test(input.collectionId)) {
    throw new CollectionVersionNotFoundError();
  }
  if (input.cursor !== undefined && input.limit !== undefined) {
    throw new CollectionVersionInputError('cursor and first-page parameters are mutually exclusive');
  }
  const collection = await ports.versions.getOwnedLive(input.collectionId, input.actor.subjectId);
  if (!collection) throw new CollectionVersionNotFoundError();
  const now = await Promise.resolve(ports.clock.now());
  let limit: number;
  let after: { createdAt: Date; versionId: string } | undefined;
  let issuedAt: string;
  let expiresAt: string;
  if (input.cursor !== undefined) {
    const cursor = ports.cursors.verify(input.cursor, now);
    if (cursor.subjectId !== input.actor.subjectId
      || cursor.purpose !== PRODUCT_COLLECTION_VERSIONS_CURSOR_PURPOSE
      || cursor.sort !== PRODUCT_COLLECTION_VERSIONS_SORT
      || cursor.comparatorVersion !== PRODUCT_COLLECTION_VERSIONS_COMPARATOR_VERSION) {
      throw new CollectionVersionCursorError();
    }
    limit = cursor.limit;
    after = { createdAt: new Date(cursor.after.createdAt), versionId: cursor.after.versionId };
    issuedAt = cursor.issuedAt;
    expiresAt = cursor.expiresAt;
  } else {
    limit = normalizeLimit(input.limit);
    issuedAt = formatUtcDateTime(now);
    expiresAt = formatUtcDateTime(new Date(now.getTime() + PRODUCT_COLLECTION_VERSIONS_CURSOR_TTL_MS));
  }
  const rows = await ports.versions.list(input.actor.principalId, input.collectionId, {
    limit,
    ...(after ? { after } : {}),
  });
  if (rows.length > limit + 1) throw new Error('collection-version read port exceeded limit+1 contract');
  const live = await ports.versions.loadLiveMembers(input.collectionId);
  const liveIndex = indexLiveCollectionTree(live);
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => {
    const changeCounts = countCollectionTreeChangesWithIndex(row.treeJson, liveIndex);
    return toCollectionVersionDto(row, changeCounts);
  });
  const hasMore = rows.length > limit;
  const last = pageRows.at(-1);
  const nextCursor = hasMore && last ? ports.cursors.sign({
    v: 1,
    purpose: PRODUCT_COLLECTION_VERSIONS_CURSOR_PURPOSE,
    subjectId: input.actor.subjectId,
    limit,
    sort: PRODUCT_COLLECTION_VERSIONS_SORT,
    comparatorVersion: PRODUCT_COLLECTION_VERSIONS_COMPARATOR_VERSION,
    after: {
      createdAt: last.createdAt.toISOString(),
      versionId: last.versionId,
    },
    issuedAt,
    expiresAt,
  }) : null;
  return { items, nextCursor };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return COLLECTION_VERSIONS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > COLLECTION_VERSIONS_MAX_LIMIT) {
    throw new CollectionVersionInputError('limit is invalid.');
  }
  return limit;
}
