import {
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';
import type { CollectionKind } from '../domain/index.js';

export const PRODUCT_OWNED_COLLECTIONS_CURSOR_PURPOSE = 'product-owned-collections-cursor' as const;
export const PRODUCT_SHARED_COLLECTIONS_CURSOR_PURPOSE = 'product-shared-collections-cursor' as const;
export const PRODUCT_OWNED_COLLECTIONS_CURSOR_VERSION = 1 as const;
export const PRODUCT_OWNED_COLLECTIONS_COMPARATOR_VERSION = 'updated-desc-id-c-v1' as const;
export const PRODUCT_OWNED_COLLECTIONS_SORT = 'updated_at:desc,id:asc' as const;
export const PRODUCT_OWNED_COLLECTIONS_CURSOR_TTL_MS = 15 * 60 * 1000;

export type ProductCollectionListCursorPurpose =
  | typeof PRODUCT_OWNED_COLLECTIONS_CURSOR_PURPOSE
  | typeof PRODUCT_SHARED_COLLECTIONS_CURSOR_PURPOSE;

export class OwnedCollectionsCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'OwnedCollectionsCursorError'; }
}

export class SharedCollectionsCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'SharedCollectionsCursorError'; }
}

export interface OwnedCollectionsCursorFilters {
  readonly kind: CollectionKind | null;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public' | null;
}
export interface OwnedCollectionsCursorAfter { readonly updatedAt: string; readonly id: string; }
export interface ProductOwnedCollectionsCursorPayload {
  readonly v: 1;
  readonly purpose: ProductCollectionListCursorPurpose;
  readonly subjectId: string;
  readonly filters: OwnedCollectionsCursorFilters;
  readonly limit: number;
  readonly sort: typeof PRODUCT_OWNED_COLLECTIONS_SORT;
  readonly comparatorVersion: typeof PRODUCT_OWNED_COLLECTIONS_COMPARATOR_VERSION;
  readonly keyVersion: string;
  readonly after: OwnedCollectionsCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type ProductOwnedCollectionsCursorUnsignedPayload = Omit<ProductOwnedCollectionsCursorPayload, 'keyVersion'>;
export interface ProductOwnedCollectionsCursorKey { readonly id: string; readonly key: string; }
export interface ProductOwnedCollectionsCursorPreviousKey extends ProductOwnedCollectionsCursorKey {
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}
export interface ProductOwnedCollectionsCursorSignerPort {
  sign(payload: ProductOwnedCollectionsCursorUnsignedPayload): string;
  verify(token: string, now: Date): ProductOwnedCollectionsCursorPayload;
  destroy(): void;
}

const payloadKeys = ['after','comparatorVersion','expiresAt','filters','issuedAt','keyVersion','limit','purpose','sort','subjectId','v'];
const filterKeys = ['kind','visibility'];
const afterKeys = ['id','updatedAt'];

function createProductCollectionListCursorSigner(
  keys: {
    readonly current: ProductOwnedCollectionsCursorKey;
    readonly previous?: readonly ProductOwnedCollectionsCursorPreviousKey[];
  },
  purpose: ProductCollectionListCursorPurpose,
  invalidCursor: () => Error,
): ProductOwnedCollectionsCursorSignerPort {
  return createKeyedCursorCodec({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: PRODUCT_OWNED_COLLECTIONS_CURSOR_TTL_MS,
    keys,
    invalid: invalidCursor,
    validate: (value) => validate(value, purpose),
    messages: {
      invalidKey: 'invalid owned Collections cursor key',
      tooManyKeys: 'owned Collections cursor supports at most 8 previous keys',
      uniqueKeys: 'owned Collections cursor keys must be unique',
      retention: 'owned Collections previous key retention must cover cursor TTL',
    },
  });
}

export function createProductOwnedCollectionsCursorSigner(keys: {
  readonly current: ProductOwnedCollectionsCursorKey;
  readonly previous?: readonly ProductOwnedCollectionsCursorPreviousKey[];
}): ProductOwnedCollectionsCursorSignerPort {
  return createProductCollectionListCursorSigner(
    keys, PRODUCT_OWNED_COLLECTIONS_CURSOR_PURPOSE, () => new OwnedCollectionsCursorError(),
  );
}

export function createProductSharedCollectionsCursorSigner(keys: {
  readonly current: ProductOwnedCollectionsCursorKey;
  readonly previous?: readonly ProductOwnedCollectionsCursorPreviousKey[];
}): ProductOwnedCollectionsCursorSignerPort {
  return createProductCollectionListCursorSigner(
    keys, PRODUCT_SHARED_COLLECTIONS_CURSOR_PURPOSE, () => new SharedCollectionsCursorError(),
  );
}

function validate(
  value: unknown,
  purpose: ProductCollectionListCursorPurpose,
): ProductOwnedCollectionsCursorPayload {
  if (!recordWithExactKeys(value, payloadKeys)) throw new Error();
  const filters = value.filters;
  const after = value.after;
  if (!recordWithExactKeys(filters, filterKeys) || !recordWithExactKeys(after, afterKeys)) throw new Error();
  const kind = filters.kind;
  const visibility = filters.visibility;
  if (value.v !== 1 || value.purpose !== purpose
    || value.sort !== PRODUCT_OWNED_COLLECTIONS_SORT || value.comparatorVersion !== PRODUCT_OWNED_COLLECTIONS_COMPARATOR_VERSION
    || typeof value.subjectId !== 'string' || value.subjectId.length < 1 || typeof value.keyVersion !== 'string'
    || typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100
    || !isKindFilter(kind) || !isVisibilityFilter(visibility)
    || typeof after.id !== 'string' || after.id.length < 1 || typeof after.updatedAt !== 'string'
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  parseCursorTimestamp(after.updatedAt); parseCursorTimestamp(value.issuedAt); parseCursorTimestamp(value.expiresAt);
  return {
    v: 1, purpose, subjectId: value.subjectId,
    filters: { kind, visibility }, limit: value.limit,
    sort: PRODUCT_OWNED_COLLECTIONS_SORT, comparatorVersion: PRODUCT_OWNED_COLLECTIONS_COMPARATOR_VERSION,
    keyVersion: value.keyVersion, after: { id: after.id, updatedAt: after.updatedAt },
    issuedAt: value.issuedAt, expiresAt: value.expiresAt,
  };
}
function isKindFilter(value: unknown): value is OwnedCollectionsCursorFilters['kind'] {
  return value === null || value === 'bookmarks' || value === 'reading_path'
    || value === 'knowledge_collection' || value === 'mixed';
}
function isVisibilityFilter(value: unknown): value is OwnedCollectionsCursorFilters['visibility'] {
  return value === null || value === 'private' || value === 'protected'
    || value === 'unlisted' || value === 'public';
}
