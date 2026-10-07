import {
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const PRODUCT_CLASSIFY_INBOX_CURSOR_PURPOSE = 'classify_inbox_v1' as const;
export const PRODUCT_CLASSIFY_INBOX_CURSOR_VERSION = 1 as const;
export const PRODUCT_CLASSIFY_INBOX_COMPARATOR_VERSION = 'created-at-desc-id-desc-v1' as const;
export const PRODUCT_CLASSIFY_INBOX_SORT = 'created_at:desc,id:desc' as const;
export const PRODUCT_CLASSIFY_INBOX_CURSOR_TTL_MS = 15 * 60 * 1000;

export class ClassifyInboxCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'ClassifyInboxCursorError'; }
}

export interface ClassifyInboxCursorAfter {
  readonly createdAt: string;
  readonly nodeId: string;
}
export interface ProductClassifyInboxCursorPayload {
  readonly v: 1;
  readonly purpose: typeof PRODUCT_CLASSIFY_INBOX_CURSOR_PURPOSE;
  readonly subjectId: string;
  readonly limit: number;
  readonly sort: typeof PRODUCT_CLASSIFY_INBOX_SORT;
  readonly comparatorVersion: typeof PRODUCT_CLASSIFY_INBOX_COMPARATOR_VERSION;
  readonly keyVersion: string;
  readonly after: ClassifyInboxCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type ProductClassifyInboxCursorUnsignedPayload = Omit<ProductClassifyInboxCursorPayload, 'keyVersion'>;
export interface ProductClassifyInboxCursorKey { readonly id: string; readonly key: string; }
export interface ProductClassifyInboxCursorPreviousKey extends ProductClassifyInboxCursorKey {
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}
export interface ProductClassifyInboxCursorSignerPort {
  sign(payload: ProductClassifyInboxCursorUnsignedPayload): string;
  verify(token: string, now: Date): ProductClassifyInboxCursorPayload;
  destroy(): void;
}

const payloadKeys = ['after','comparatorVersion','expiresAt','issuedAt','keyVersion','limit','purpose','sort','subjectId','v'];
const afterKeys = ['createdAt','nodeId'];

export function createProductClassifyInboxCursorSigner(keys: {
  readonly current: ProductClassifyInboxCursorKey;
  readonly previous?: readonly ProductClassifyInboxCursorPreviousKey[];
}): ProductClassifyInboxCursorSignerPort {
  return createKeyedCursorCodec({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: PRODUCT_CLASSIFY_INBOX_CURSOR_TTL_MS,
    keys,
    invalid: () => new ClassifyInboxCursorError(),
    validate,
    messages: {
      invalidKey: 'invalid classify-inbox cursor key',
      tooManyKeys: 'classify-inbox cursor supports at most 8 previous keys',
      uniqueKeys: 'classify-inbox cursor keys must be unique',
      retention: 'classify-inbox previous key retention must cover cursor TTL',
    },
  });
}

function validate(value: unknown): ProductClassifyInboxCursorPayload {
  if (!recordWithExactKeys(value, payloadKeys)) throw new Error();
  const after = value.after;
  if (!recordWithExactKeys(after, afterKeys)) throw new Error();
  if (value.v !== 1 || value.purpose !== PRODUCT_CLASSIFY_INBOX_CURSOR_PURPOSE
    || value.sort !== PRODUCT_CLASSIFY_INBOX_SORT || value.comparatorVersion !== PRODUCT_CLASSIFY_INBOX_COMPARATOR_VERSION
    || typeof value.subjectId !== 'string' || value.subjectId.length < 1 || typeof value.keyVersion !== 'string'
    || typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 50
    || typeof after.nodeId !== 'string' || after.nodeId.length < 1 || typeof after.createdAt !== 'string'
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  parseCursorTimestamp(after.createdAt);
  parseCursorTimestamp(value.issuedAt); parseCursorTimestamp(value.expiresAt);
  return {
    v: 1, purpose: PRODUCT_CLASSIFY_INBOX_CURSOR_PURPOSE, subjectId: value.subjectId,
    limit: value.limit,
    sort: PRODUCT_CLASSIFY_INBOX_SORT, comparatorVersion: PRODUCT_CLASSIFY_INBOX_COMPARATOR_VERSION,
    keyVersion: value.keyVersion, after: { createdAt: after.createdAt, nodeId: after.nodeId },
    issuedAt: value.issuedAt, expiresAt: value.expiresAt,
  };
}
