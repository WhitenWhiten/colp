import {
  createKeyedCursorCodec,
  parseCursorTimestamp,
  recordWithExactKeys,
} from '../../commands/index.js';

export const PRODUCT_ANNOTATION_CURSOR_PURPOSE = 'product-annotation-cursor' as const;
export const PRODUCT_ANNOTATION_CURSOR_VERSION = 1 as const;
export const PRODUCT_ANNOTATION_COMPARATOR_VERSION = 'updated-desc-id-asc-v1' as const;
export const PRODUCT_ANNOTATION_CURSOR_TTL_MS = 15 * 60 * 1000;

export interface ProductAnnotationCursorAfter {
  readonly updatedAt: string;
  readonly id: string;
}

export interface ProductAnnotationCursorPayload {
  readonly v: typeof PRODUCT_ANNOTATION_CURSOR_VERSION;
  readonly purpose: typeof PRODUCT_ANNOTATION_CURSOR_PURPOSE;
  readonly principalId: string;
  readonly collectionId: string;
  readonly resourceType: 'collection' | 'node';
  readonly resourceId: string;
  readonly scope: 'product-visible' | 'product-private-notes';
  readonly limit: number;
  readonly comparatorVersion: typeof PRODUCT_ANNOTATION_COMPARATOR_VERSION;
  readonly policyRevision: string;
  readonly after: ProductAnnotationCursorAfter;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ProductAnnotationCursorKey {
  readonly id: string;
  readonly key: string;
}

export interface ProductAnnotationCursorPreviousKey extends ProductAnnotationCursorKey {
  readonly retainUntil?: string;
}

export interface ProductAnnotationCursorKeyMaterial {
  readonly current: ProductAnnotationCursorKey;
  readonly previous?: readonly ProductAnnotationCursorPreviousKey[];
}

export interface ProductAnnotationCursorSignerPort {
  sign(payload: ProductAnnotationCursorPayload): string;
  verify(token: string, now: Date): ProductAnnotationCursorPayload;
}

const payloadKeys = [
  'after', 'collectionId', 'comparatorVersion', 'expiresAt', 'issuedAt', 'limit',
  'policyRevision', 'principalId', 'purpose', 'resourceId', 'resourceType', 'scope', 'v',
] as const;
const afterKeys = ['id', 'updatedAt'] as const;

export function createProductAnnotationCursorSigner(
  material: ProductAnnotationCursorKeyMaterial,
): ProductAnnotationCursorSignerPort {
  return createKeyedCursorCodec({
    mode: 'hmac-sha256',
    hmac: { variant: 'derived', purpose: PRODUCT_ANNOTATION_CURSOR_PURPOSE },
    ttlMs: PRODUCT_ANNOTATION_CURSOR_TTL_MS,
    keys: material,
    invalid: () => new AnnotationCursorError(),
    validate,
    messages: {
      invalidCurrent: 'A valid current Annotation cursor key is required',
      uniqueIds: 'Annotation cursor key ids must be unique',
      invalidRetainUntil: 'Invalid retainUntil',
    },
  });
}

export class AnnotationCursorError extends Error {
  constructor() { super('The Annotation cursor is invalid.'); this.name = 'AnnotationCursorError'; }
}

function validate(value: unknown): ProductAnnotationCursorPayload {
  assertPayload(value);
  return value;
}

function assertPayload(value: unknown): asserts value is ProductAnnotationCursorPayload {
  if (!isRecord(value) || !recordWithExactKeys(value, payloadKeys) || !isRecord(value.after)
    || !recordWithExactKeys(value.after, afterKeys)
    || value.v !== PRODUCT_ANNOTATION_CURSOR_VERSION
    || value.purpose !== PRODUCT_ANNOTATION_CURSOR_PURPOSE
    || (value.scope !== 'product-visible' && value.scope !== 'product-private-notes')
    || value.comparatorVersion !== PRODUCT_ANNOTATION_COMPARATOR_VERSION
    || !nonEmpty(value.principalId) || !nonEmpty(value.collectionId) || !nonEmpty(value.resourceId)
    || !nonEmpty(value.policyRevision)
    || (value.resourceType !== 'collection' && value.resourceType !== 'node')
    || !Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100
    || !nonEmpty(value.after.id) || !canonicalDate(value.after.updatedAt)
    || !canonicalDate(value.issuedAt) || !canonicalDate(value.expiresAt)
    || Date.parse(value.expiresAt as string) - Date.parse(value.issuedAt as string) > PRODUCT_ANNOTATION_CURSOR_TTL_MS
    || Date.parse(value.expiresAt as string) <= Date.parse(value.issuedAt as string)) {
    throw new AnnotationCursorError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseCursorTimestamp(value, 'rfc3339-seconds');
    return true;
  } catch {
    return false;
  }
}
