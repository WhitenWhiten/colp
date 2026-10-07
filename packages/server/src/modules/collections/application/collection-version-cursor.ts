import {
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const PRODUCT_COLLECTION_VERSIONS_CURSOR_PURPOSE = 'collection_versions_v1' as const;
export const PRODUCT_COLLECTION_VERSIONS_CURSOR_VERSION = 1 as const;
export const PRODUCT_COLLECTION_VERSIONS_COMPARATOR_VERSION = 'created-at-desc-version-id-desc-v1' as const;
export const PRODUCT_COLLECTION_VERSIONS_SORT = 'created_at:desc,version_id:desc' as const;
export const PRODUCT_COLLECTION_VERSIONS_CURSOR_TTL_MS = 15 * 60 * 1000;

export class CollectionVersionCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'CollectionVersionCursorError'; }
}

export interface CollectionVersionsCursorAfter {
  readonly createdAt: string;
  readonly versionId: string;
}
export interface ProductCollectionVersionCursorPayload {
  readonly v: 1;
  readonly purpose: typeof PRODUCT_COLLECTION_VERSIONS_CURSOR_PURPOSE;
  readonly subjectId: string;
  readonly limit: number;
  readonly sort: typeof PRODUCT_COLLECTION_VERSIONS_SORT;
  readonly comparatorVersion: typeof PRODUCT_COLLECTION_VERSIONS_COMPARATOR_VERSION;
  readonly keyVersion: string;
  readonly after: CollectionVersionsCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type ProductCollectionVersionCursorUnsignedPayload = Omit<ProductCollectionVersionCursorPayload, 'keyVersion'>;
export interface ProductCollectionVersionCursorKey { readonly id: string; readonly key: string; }
export interface ProductCollectionVersionCursorPreviousKey extends ProductCollectionVersionCursorKey {
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}
export interface ProductCollectionVersionCursorSignerPort {
  sign(payload: ProductCollectionVersionCursorUnsignedPayload): string;
  verify(token: string, now: Date): ProductCollectionVersionCursorPayload;
  destroy(): void;
}

const payloadKeys = ['after','comparatorVersion','expiresAt','issuedAt','keyVersion','limit','purpose','sort','subjectId','v'];
const afterKeys = ['createdAt','versionId'];

export function createProductCollectionVersionCursorSigner(keys: {
  readonly current: ProductCollectionVersionCursorKey;
  readonly previous?: readonly ProductCollectionVersionCursorPreviousKey[];
}): ProductCollectionVersionCursorSignerPort {
  return createKeyedCursorCodec({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: PRODUCT_COLLECTION_VERSIONS_CURSOR_TTL_MS,
    keys,
    invalid: () => new CollectionVersionCursorError(),
    validate,
    messages: {
      invalidKey: 'invalid collection-versions cursor key',
      tooManyKeys: 'collection-versions cursor supports at most 8 previous keys',
      uniqueKeys: 'collection-versions cursor keys must be unique',
      retention: 'collection-versions previous key retention must cover cursor TTL',
    },
  });
}

function validate(value: unknown): ProductCollectionVersionCursorPayload {
  if (!recordWithExactKeys(value, payloadKeys)) throw new Error();
  const after = value.after;
  if (!recordWithExactKeys(after, afterKeys)) throw new Error();
  if (value.v !== 1 || value.purpose !== PRODUCT_COLLECTION_VERSIONS_CURSOR_PURPOSE
    || value.sort !== PRODUCT_COLLECTION_VERSIONS_SORT || value.comparatorVersion !== PRODUCT_COLLECTION_VERSIONS_COMPARATOR_VERSION
    || typeof value.subjectId !== 'string' || value.subjectId.length < 1 || typeof value.keyVersion !== 'string'
    || typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 50
    || typeof after.versionId !== 'string' || after.versionId.length < 1 || typeof after.createdAt !== 'string'
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  parseCursorTimestamp(after.createdAt);
  parseCursorTimestamp(value.issuedAt); parseCursorTimestamp(value.expiresAt);
  return {
    v: 1, purpose: PRODUCT_COLLECTION_VERSIONS_CURSOR_PURPOSE, subjectId: value.subjectId,
    limit: value.limit,
    sort: PRODUCT_COLLECTION_VERSIONS_SORT, comparatorVersion: PRODUCT_COLLECTION_VERSIONS_COMPARATOR_VERSION,
    keyVersion: value.keyVersion, after: { createdAt: after.createdAt, versionId: after.versionId },
    issuedAt: value.issuedAt, expiresAt: value.expiresAt,
  };
}
