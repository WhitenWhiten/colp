import type { Relation } from '@know-n/colp/types';
import {
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const PRODUCT_RELATION_CURSOR_PURPOSE = 'product-relation-cursor' as const;
export const PRODUCT_RELATION_CURSOR_VERSION = 1 as const;
export const PRODUCT_RELATION_COMPARATOR_VERSION = 'updated-desc-id-asc-v1' as const;
export const PRODUCT_RELATION_CURSOR_TTL_MS = 15 * 60 * 1000;

export interface ProductRelationCursorAfter { readonly updatedAt: string; readonly id: string }
export interface ProductRelationCursorPayload {
  readonly v: typeof PRODUCT_RELATION_CURSOR_VERSION;
  readonly purpose: typeof PRODUCT_RELATION_CURSOR_PURPOSE;
  readonly principalId: string;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly direction: 'incoming' | 'outgoing' | 'both';
  readonly types: readonly Relation['type'][];
  readonly visibilities: readonly Relation['visibility'][];
  readonly scope: 'product-visible';
  readonly limit: number;
  readonly comparatorVersion: typeof PRODUCT_RELATION_COMPARATOR_VERSION;
  readonly policyRevision: string;
  readonly after: ProductRelationCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export interface ProductRelationCursorKey { readonly id: string; readonly key: string }
export interface ProductRelationCursorPreviousKey extends ProductRelationCursorKey { readonly retainUntil?: string }
export interface ProductRelationCursorKeyMaterial {
  readonly current: ProductRelationCursorKey; readonly previous?: readonly ProductRelationCursorPreviousKey[];
}
export interface ProductRelationCursorSignerPort {
  sign(payload: ProductRelationCursorPayload): string;
  verify(token: string, now: Date): ProductRelationCursorPayload;
}

const relationTypes = new Set(['related', 'precedes', 'follows', 'supports', 'contradicts',
  'duplicate_of', 'derived_from', 'mentions', 'custom']);
const relationVisibilities = new Set(['public', 'unlisted', 'protected', 'private']);
const payloadKeys = ['after', 'collectionId', 'comparatorVersion', 'direction', 'expiresAt', 'issuedAt',
  'limit', 'nodeId', 'policyRevision', 'principalId', 'purpose', 'scope', 'types', 'v', 'visibilities'] as const;

export function createProductRelationCursorSigner(material: ProductRelationCursorKeyMaterial): ProductRelationCursorSignerPort {
  return createKeyedCursorCodec({
    mode: 'hmac-sha256',
    hmac: { variant: 'derived', purpose: PRODUCT_RELATION_CURSOR_PURPOSE },
    ttlMs: PRODUCT_RELATION_CURSOR_TTL_MS,
    keys: material,
    invalid: () => new RelationCursorError(),
    validate,
    messages: {
      invalidCurrent: 'A valid current Relation cursor key is required',
      uniqueIds: 'Relation cursor key ids must be unique',
      invalidRetainUntil: 'Invalid retainUntil',
    },
  });
}

export class RelationCursorError extends Error {
  constructor() { super('The Relation cursor is invalid.'); this.name = 'RelationCursorError'; }
}

function validate(value: unknown): ProductRelationCursorPayload {
  assertPayload(value);
  return value;
}

function assertPayload(value: unknown): asserts value is ProductRelationCursorPayload {
  if (!record(value) || !recordWithExactKeys(value, payloadKeys) || !record(value.after)
    || !recordWithExactKeys(value.after, ['id', 'updatedAt']) || value.v !== PRODUCT_RELATION_CURSOR_VERSION
    || value.purpose !== PRODUCT_RELATION_CURSOR_PURPOSE || value.scope !== 'product-visible'
    || value.comparatorVersion !== PRODUCT_RELATION_COMPARATOR_VERSION
    || !text(value.principalId) || !text(value.collectionId) || !text(value.nodeId) || !text(value.policyRevision)
    || !['incoming', 'outgoing', 'both'].includes(value.direction as string)
    || !enumArray(value.types, relationTypes) || !enumArray(value.visibilities, relationVisibilities)
    || !Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100
    || !text(value.after.id) || !date(value.after.updatedAt) || !date(value.issuedAt) || !date(value.expiresAt)
    || Date.parse(value.expiresAt as string) <= Date.parse(value.issuedAt as string)
    || Date.parse(value.expiresAt as string) - Date.parse(value.issuedAt as string) > PRODUCT_RELATION_CURSOR_TTL_MS) {
    throw new RelationCursorError();
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function date(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseCursorTimestamp(value, 'rfc3339-seconds');
    return true;
  } catch {
    return false;
  }
}
function enumArray(value: unknown, allowed: ReadonlySet<string>): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && allowed.has(entry))
    && value.every((entry, index) => index === 0 || String(value[index - 1]).localeCompare(String(entry), 'en') < 0);
}
