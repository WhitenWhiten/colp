import {
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const PRODUCT_LINK_HEALTH_CURSOR_PURPOSE = 'link_health_v1' as const;
export const PRODUCT_LINK_HEALTH_CURSOR_VERSION = 1 as const;
export const PRODUCT_LINK_HEALTH_COMPARATOR_VERSION = 'checked-at-nulls-first-node-id-v1' as const;
export const PRODUCT_LINK_HEALTH_SORT = 'checked_at:asc_nulls_first,node_id:asc' as const;
export const PRODUCT_LINK_HEALTH_CURSOR_TTL_MS = 15 * 60 * 1000;

export class LinkHealthCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() { super('invalid cursor'); this.name = 'LinkHealthCursorError'; }
}

export type LinkHealthCursorStatus = 'pending' | 'healthy' | 'redirect' | 'broken';
export type LinkHealthScope = 'owned' | 'shared' | 'all';
export interface LinkHealthCursorFilters {
  readonly status: LinkHealthCursorStatus | null;
  readonly collectionId: string | null;
  readonly duplicate: boolean;
  /** Present on newly issued tokens. Missing on pre-1.32 owned tokens. */
  readonly scope?: LinkHealthScope;
}
export interface LinkHealthCursorAfter {
  /** Explicit JSON null when checked_at is NULL; never omit the key. */
  readonly checkedAt: string | null;
  readonly nodeId: string;
}
export interface ProductLinkHealthCursorPayload {
  readonly v: 1;
  readonly purpose: typeof PRODUCT_LINK_HEALTH_CURSOR_PURPOSE;
  readonly subjectId: string;
  readonly filters: LinkHealthCursorFilters;
  readonly limit: number;
  readonly sort: typeof PRODUCT_LINK_HEALTH_SORT;
  readonly comparatorVersion: typeof PRODUCT_LINK_HEALTH_COMPARATOR_VERSION;
  readonly keyVersion: string;
  readonly after: LinkHealthCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type ProductLinkHealthCursorUnsignedPayload = Omit<ProductLinkHealthCursorPayload, 'keyVersion'>;
export interface ProductLinkHealthCursorKey { readonly id: string; readonly key: string; }
export interface ProductLinkHealthCursorPreviousKey extends ProductLinkHealthCursorKey {
  readonly lastIssuedAt: string;
  readonly retainUntil: string;
}
export interface ProductLinkHealthCursorSignerPort {
  sign(payload: ProductLinkHealthCursorUnsignedPayload): string;
  verify(token: string, now: Date): ProductLinkHealthCursorPayload;
  destroy(): void;
}

const payloadKeys = ['after','comparatorVersion','expiresAt','filters','issuedAt','keyVersion','limit','purpose','sort','subjectId','v'];
const filterKeysV2 = ['collectionId','duplicate','scope','status'];
const filterKeysV1 = ['collectionId','duplicate','status'];
const afterKeys = ['checkedAt','nodeId'];
const STATUSES = new Set<LinkHealthCursorStatus>(['pending', 'healthy', 'redirect', 'broken']);
const SCOPES = new Set<LinkHealthScope>(['owned', 'shared', 'all']);

export function createProductLinkHealthCursorSigner(keys: {
  readonly current: ProductLinkHealthCursorKey;
  readonly previous?: readonly ProductLinkHealthCursorPreviousKey[];
}): ProductLinkHealthCursorSignerPort {
  return createKeyedCursorCodec({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: PRODUCT_LINK_HEALTH_CURSOR_TTL_MS,
    keys,
    invalid: () => new LinkHealthCursorError(),
    validate,
    messages: {
      invalidKey: 'invalid link-health cursor key',
      tooManyKeys: 'link-health cursor supports at most 8 previous keys',
      uniqueKeys: 'link-health cursor keys must be unique',
      retention: 'link-health previous key retention must cover cursor TTL',
    },
  });
}

function validate(value: unknown): ProductLinkHealthCursorPayload {
  if (!recordWithExactKeys(value, payloadKeys)) throw new Error();
  const filters = parseFilters(value.filters);
  const after = value.after;
  if (!recordWithExactKeys(after, afterKeys)) throw new Error();
  const checkedAt = after.checkedAt;
  if (value.v !== 1 || value.purpose !== PRODUCT_LINK_HEALTH_CURSOR_PURPOSE
    || value.sort !== PRODUCT_LINK_HEALTH_SORT || value.comparatorVersion !== PRODUCT_LINK_HEALTH_COMPARATOR_VERSION
    || typeof value.subjectId !== 'string' || value.subjectId.length < 1 || typeof value.keyVersion !== 'string'
    || typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100
    || typeof after.nodeId !== 'string' || after.nodeId.length < 1
    || (checkedAt !== null && typeof checkedAt !== 'string')
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') throw new Error();
  if (checkedAt !== null) parseCursorTimestamp(checkedAt);
  parseCursorTimestamp(value.issuedAt); parseCursorTimestamp(value.expiresAt);
  return {
    v: 1, purpose: PRODUCT_LINK_HEALTH_CURSOR_PURPOSE, subjectId: value.subjectId,
    filters, limit: value.limit,
    sort: PRODUCT_LINK_HEALTH_SORT, comparatorVersion: PRODUCT_LINK_HEALTH_COMPARATOR_VERSION,
    keyVersion: value.keyVersion, after: { checkedAt, nodeId: after.nodeId },
    issuedAt: value.issuedAt, expiresAt: value.expiresAt,
  };
}
function parseFilters(value: unknown): LinkHealthCursorFilters {
  if (recordWithExactKeys(value, filterKeysV2)) {
    const status = value.status;
    const collectionId = value.collectionId;
    const duplicate = value.duplicate;
    const scope = value.scope;
    if (!isStatusFilter(status) || !isCollectionIdFilter(collectionId) || typeof duplicate !== 'boolean'
      || !isScopeFilter(scope)) throw new Error();
    return { status, collectionId, duplicate, scope };
  }
  if (recordWithExactKeys(value, filterKeysV1)) {
    const status = value.status;
    const collectionId = value.collectionId;
    const duplicate = value.duplicate;
    if (!isStatusFilter(status) || !isCollectionIdFilter(collectionId) || typeof duplicate !== 'boolean') {
      throw new Error();
    }
    return { status, collectionId, duplicate };
  }
  throw new Error();
}
function isStatusFilter(value: unknown): value is LinkHealthCursorFilters['status'] {
  return value === null || (typeof value === 'string' && STATUSES.has(value as LinkHealthCursorStatus));
}
function isScopeFilter(value: unknown): value is LinkHealthScope {
  return typeof value === 'string' && SCOPES.has(value as LinkHealthScope);
}
function isCollectionIdFilter(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 128);
}
