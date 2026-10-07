import { createKeyedCursorCodec, recordWithExactKeys } from '../../commands/index.js';
import { EditorCursorError } from '../domain/errors.js';

/** Closed cursor purpose — never reuse publication/sync key material or purpose strings. */
export const PRODUCT_EDITOR_CURSOR_PURPOSE = 'product-editor-cursor' as const;

export const PRODUCT_EDITOR_CURSOR_VERSION = 1 as const;

export const PRODUCT_EDITOR_COMPARATOR_VERSION = 'v1' as const;

/** Absolute TTL from first-page issue; not refreshed on continuation. */
export const PRODUCT_EDITOR_CURSOR_TTL_MS = 15 * 60 * 1000;

/** Caps legacy verification work and secret-manager configuration mistakes. */
export const PRODUCT_EDITOR_CURSOR_MAX_PREVIOUS_KEYS = 8;

const CLOSED_PAYLOAD_KEYS = [
  'after',
  'collectionId',
  'comparatorVersion',
  'contentRevision',
  'expiresAt',
  'issuedAt',
  'limit',
  'policyRevision',
  'principalId',
  'purpose',
  'snapshotId',
  'v',
] as const;

const CLOSED_AFTER_KEYS = ['nodeId', 'parentKey', 'positionKey'] as const;

export interface ProductEditorCursorAfter {
  /** parent_id or root sentinel '' */
  readonly parentKey: string;
  /** position_token or root sentinel '' */
  readonly positionKey: string;
  readonly nodeId: string;
}

/**
 * Closed Product Editor cursor payload (ADR-0004 / Phase 1 contract).
 * Wire form is opaque base64url(payload)+base64url(hmac); clients must not parse.
 */
export interface ProductEditorCursorPayload {
  readonly v: typeof PRODUCT_EDITOR_CURSOR_VERSION;
  readonly purpose: typeof PRODUCT_EDITOR_CURSOR_PURPOSE;
  readonly principalId: string;
  readonly collectionId: string;
  readonly limit: number;
  readonly comparatorVersion: typeof PRODUCT_EDITOR_COMPARATOR_VERSION;
  readonly after: ProductEditorCursorAfter;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly snapshotId: string;
  /** RFC 3339 UTC from first-page issue */
  readonly issuedAt: string;
  /** Absolute expiry = issuedAt + 15 minutes */
  readonly expiresAt: string;
}

export interface ProductEditorCursorKeyMaterial {
  readonly current: ProductEditorCursorKey;
  readonly previous?: readonly ProductEditorCursorPreviousKey[];
  /** Phase A emits the exact pre-key-ID wire format; Phase B emits keyed tokens. */
  readonly issuanceFormat?: 'legacy' | 'keyed';
  /** Exclusive deadline for accepting pre-key-ID tokens. Required for legacy issuance. */
  readonly legacyAcceptUntil?: string;
}

export interface ProductEditorCursorKey {
  readonly id: string;
  readonly key: string;
}

export interface ProductEditorCursorPreviousKey extends ProductEditorCursorKey {
  /** Inclusive upper bound for issuance by the final old-key signer. */
  readonly lastIssuedAt: string;
  /** Must be at least one maximum cursor TTL after lastIssuedAt. */
  readonly retainUntil: string;
}

export interface ProductEditorCursorSignerPort {
  /** Exact UTF-8 byte length of the token returned by sign(payload), without signing. */
  encodedLength(payload: ProductEditorCursorPayload): number;
  sign(payload: ProductEditorCursorPayload): string;
  /**
   * Verify signature (current + previous keys), closed fields, purpose, version,
   * and absolute expiry against `now`. Throws EditorCursorError on any failure.
   */
  verify(token: string, now: Date): ProductEditorCursorPayload;
}

export type ProductEditorCursorMetric =
  | 'issued'
  | 'issued_legacy'
  | 'verified_current'
  | 'verified_previous'
  | 'verified_legacy'
  | 'rejected_malformed_token'
  | 'rejected_unknown_key'
  | 'rejected_retired_key'
  | 'rejected_bad_signature'
  | 'rejected_invalid_payload'
  | 'rejected_expired'
  | 'rejected_legacy_disabled';

export function createProductEditorCursorSigner(
  keys: ProductEditorCursorKeyMaterial,
  options: { readonly observe?: (metric: ProductEditorCursorMetric) => void } = {},
): ProductEditorCursorSignerPort {
  return createKeyedCursorCodec({
    mode: 'hmac-sha256',
    hmac: {
      variant: 'editor',
      issuanceFormat: keys.issuanceFormat,
      legacyAcceptUntil: keys.legacyAcceptUntil,
      observe: options.observe,
      maxPreviousKeys: PRODUCT_EDITOR_CURSOR_MAX_PREVIOUS_KEYS,
    },
    ttlMs: PRODUCT_EDITOR_CURSOR_TTL_MS,
    keys,
    invalid: () => new EditorCursorError(),
    validate: assertClosedPayload,
  });
}

function assertClosedPayload(value: unknown): ProductEditorCursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EditorCursorError();
  }
  const record = value as Record<string, unknown>;
  if (!recordWithExactKeys(record, CLOSED_PAYLOAD_KEYS)) throw new EditorCursorError();

  if (record.v !== PRODUCT_EDITOR_CURSOR_VERSION) throw new EditorCursorError();
  if (record.purpose !== PRODUCT_EDITOR_CURSOR_PURPOSE) throw new EditorCursorError();
  if (record.comparatorVersion !== PRODUCT_EDITOR_COMPARATOR_VERSION) {
    throw new EditorCursorError();
  }

  const principalId = assertNonEmptyString(record.principalId);
  const collectionId = assertNonEmptyString(record.collectionId);
  const contentRevision = assertNonEmptyString(record.contentRevision);
  const policyRevision = assertNonEmptyString(record.policyRevision);
  const snapshotId = assertNonEmptyString(record.snapshotId);
  const issuedAt = assertNonEmptyString(record.issuedAt);
  const expiresAt = assertNonEmptyString(record.expiresAt);
  const limit = assertLimit(record.limit);
  const after = assertAfter(record.after);

  return {
    v: PRODUCT_EDITOR_CURSOR_VERSION,
    purpose: PRODUCT_EDITOR_CURSOR_PURPOSE,
    principalId,
    collectionId,
    limit,
    comparatorVersion: PRODUCT_EDITOR_COMPARATOR_VERSION,
    after,
    contentRevision,
    policyRevision,
    snapshotId,
    issuedAt,
    expiresAt,
  };
}

function assertAfter(value: unknown): ProductEditorCursorAfter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EditorCursorError();
  }
  const record = value as Record<string, unknown>;
  if (!recordWithExactKeys(record, CLOSED_AFTER_KEYS)) throw new EditorCursorError();
  // parentKey / positionKey may be empty sentinels; nodeId must be non-empty.
  if (typeof record.parentKey !== 'string') throw new EditorCursorError();
  if (typeof record.positionKey !== 'string') throw new EditorCursorError();
  const nodeId = assertNonEmptyString(record.nodeId);
  return {
    parentKey: record.parentKey,
    positionKey: record.positionKey,
    nodeId,
  };
}

function assertNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1) throw new EditorCursorError();
  return value;
}

function assertLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 500) {
    throw new EditorCursorError();
  }
  return value;
}
