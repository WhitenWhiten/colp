import {
  canonicalJson,
  decodeCanonicalBase64Url,
  decodeCanonicalCursorBody,
  deriveHmacPurposeKey,
  encodeCanonicalCursorBody,
  hmacSha256Base64Url,
  parseCursorTimestamp,
  recordWithExactKeys,
  timingSafeEqualText,
} from '../../commands/index.js';

/**
 * FO-05 `listCollectionChildren` continuation cursor.
 *
 * Contract (favicon-ordering-api-contract.yaml x-wire-rules cursor):
 * opaque base64url, 1..2048 chars; HMAC authenticated, v1, ttl 900 seconds;
 * binds endpoint (purpose), current viewer, target/generation (collectionId),
 * all normalized filters (parentId, sort, limit) and the content revision.
 * First page omits the cursor. Tamper / mismatch => 400 invalid_cursor;
 * a validly-signed but expired snapshot => 409 snapshot_expired
 * (restart_from_first_page). Current visibility is checked on every page by
 * the application query.
 */

export const PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE = 'product-collection-children-v1' as const;
export const PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION = 1 as const;
/** Contract ttl: 900 seconds. */
export const PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS = 900_000;
/**
 * The fixed key id used on the wire. The contract exposes exactly one key
 * (FAVICON_CURSOR_HMAC_KEY, stable across API instances), so there is no
 * rotation keyring: the id is a constant, never secret.
 */
export const PRODUCT_COLLECTION_CHILDREN_CURSOR_KEY_ID = 'favicon-children-cursor-v1';

/** base64url length of an HMAC-SHA256 digest (43 chars, no padding). */
const HMAC_SIGNATURE_B64URL_LENGTH = 43;

export type CollectionChildrenSort = 'curated' | 'created_asc' | 'created_desc';

export const COLLECTION_CHILDREN_SORTS: readonly CollectionChildrenSort[] = Object.freeze([
  'curated',
  'created_asc',
  'created_desc',
]);

export function isCollectionChildrenSort(value: unknown): value is CollectionChildrenSort {
  return typeof value === 'string' && (COLLECTION_CHILDREN_SORTS as readonly string[]).includes(value);
}

export type CollectionChildrenViewer =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'account'; readonly principalId: string; readonly subjectId: string };

export function viewerScope(viewer: CollectionChildrenViewer): string {
  return viewer.kind === 'anonymous' ? 'anon' : `account:${viewer.subjectId}`;
}

/**
 * Keyset continuation state for one layer of children. The last returned item
 * carries all three keys; the assigned sort decides which pair is significant.
 * `positionKey` is the C-collated COALESCE(position_token, '') and
 * `createdAt` the canonical created_at timestamp (both always present so a
 * created cursor can never be confused with a curated one and vice versa).
 */
export interface CollectionChildrenCursorAfter {
  readonly nodeId: string;
  readonly positionKey: string;
  readonly createdAt: string;
}

/** Closed signed payload; wire form is opaque base64url(payload)+base64url(hmac). */
export interface CollectionChildrenCursorPayload {
  readonly v: typeof PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION;
  readonly purpose: typeof PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE;
  readonly viewer: string;
  readonly collectionId: string;
  /** '' means the collection root. */
  readonly parentId: string;
  readonly sort: CollectionChildrenSort;
  /** 1..100; bound so a continuation can never silently change page size. */
  readonly limit: number;
  readonly contentRevision: string;
  readonly after: CollectionChildrenCursorAfter;
  /** RFC 3339 UTC millis from first-page issue. */
  readonly issuedAt: string;
  /** Absolute expiry = issuedAt + 900s. */
  readonly expiresAt: string;
}

const PAYLOAD_KEYS = [
  'after',
  'collectionId',
  'contentRevision',
  'expiresAt',
  'issuedAt',
  'limit',
  'parentId',
  'purpose',
  'sort',
  'v',
  'viewer',
] as const;

const AFTER_KEYS = ['createdAt', 'nodeId', 'positionKey'] as const;

/** Any verified-token failure that must surface as 400 invalid_cursor. */
export class CollectionChildrenCursorError extends Error {
  readonly code = 'invalid_cursor' as const;

  constructor(message = 'The collection children cursor is invalid.') {
    super(message);
    this.name = 'CollectionChildrenCursorError';
  }
}

/** Validly signed cursor whose absolute 900s window has elapsed. 409 snapshot_expired. */
export class CollectionChildrenCursorExpiredError extends Error {
  readonly code = 'snapshot_expired' as const;

  constructor(message = 'The collection children cursor has expired; restart from the first page.') {
    super(message);
    this.name = 'CollectionChildrenCursorExpiredError';
  }
}

export interface CollectionChildrenCursorSignerPort {
  sign(payload: CollectionChildrenCursorPayload): string;
  /**
   * Throws CollectionChildrenCursorError (400 invalid_cursor) on any
   * malformed/tampered/wrong-key token and
   * CollectionChildrenCursorExpiredError (409 snapshot_expired) when the
   * signature is valid but the absolute 900s window elapsed.
   */
  verify(token: string, now: Date): CollectionChildrenCursorPayload;
  /** Exact UTF-8 byte length of the token sign() would emit, without signing. */
  encodedLength(payload: CollectionChildrenCursorPayload): number;
}

/**
 * Deterministic across API instances: the same FAVICON_CURSOR_HMAC_KEY
 * (base64url 32-byte secret) derives the same per-purpose HMAC key.
 */
export function createCollectionChildrenCursorSigner(
  hmacSecretBase64Url: string,
): CollectionChildrenCursorSignerPort {
  const secret = decodeCanonicalBase64Url(hmacSecretBase64Url);
  if (secret.length !== 32) {
    secret.fill(0);
    throw new Error('FAVICON_CURSOR_HMAC_KEY must decode to exactly 32 bytes');
  }
  let key: Buffer;
  try {
    key = Buffer.from(deriveHmacPurposeKey(secret.toString('base64url'), PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE), 'base64url');
  } finally {
    secret.fill(0);
  }
  const tokenSign = (body: string): string => {
    // Dotless form `${body}${signature}`: the contract Cursor charset is
    // ^[A-Za-z0-9_-]+$ with no separators. The HMAC is exactly 43 base64url
    // chars, so verification splits deterministically at the tail; the fixed
    // purpose key id never appears on the wire.
    const signature = hmacSha256Base64Url(key, body);
    return `${body}${signature}`;
  };

  const sign = (payload: CollectionChildrenCursorPayload): string => {
    const { body } = encodeCanonicalCursorBody(assertAndReturnPayload(payload));
    return tokenSign(body);
  };

  const verify = (token: string, now: Date): CollectionChildrenCursorPayload => {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new CollectionChildrenCursorError();
    const failed = (): never => { throw new CollectionChildrenCursorError(); };
    try {
      if (typeof token !== 'string' || token.length < 1 || token.length > 2048) failed();
      const signature = token.slice(-HMAC_SIGNATURE_B64URL_LENGTH);
      const body = token.slice(0, -HMAC_SIGNATURE_B64URL_LENGTH);
      if (
        body.length < 1
        || !/^[A-Za-z0-9_-]+$/u.test(body)
        || !/^[A-Za-z0-9_-]{43}$/u.test(signature)
      ) failed();
      if (!timingSafeEqualText(signature, hmacSha256Base64Url(key, body))) failed();
      const canonical = decodeCanonicalCursorBody(body);
      const payload = assertAndReturnPayload(JSON.parse(canonical) as unknown);
      if (canonicalJson(payload) !== canonical) failed();
      const issuedAt = parseCursorTimestamp(payload.issuedAt);
      const expiresAt = parseCursorTimestamp(payload.expiresAt);
      if (
        issuedAt > nowMs
        || issuedAt > expiresAt
        || expiresAt - issuedAt !== PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS
      ) failed();
      if (nowMs >= expiresAt) throw new CollectionChildrenCursorExpiredError();
      return payload;
    } catch (error) {
      if (error instanceof CollectionChildrenCursorExpiredError) throw error;
      if (error instanceof CollectionChildrenCursorError) throw error;
      throw new CollectionChildrenCursorError();
    }
  };

  const encodedLength = (payload: CollectionChildrenCursorPayload): number =>
    tokenSign(encodeCanonicalCursorBody(assertAndReturnPayload(payload)).body).length;

  return Object.freeze({ sign, verify, encodedLength });
}

function assertAndReturnPayload(value: unknown): CollectionChildrenCursorPayload {
  try {
    if (!recordWithExactKeys(value, PAYLOAD_KEYS)) throw new CollectionChildrenCursorError();
    const record = value as Record<string, unknown>;
    const after = record.after;
    if (!recordWithExactKeys(after, AFTER_KEYS)) throw new CollectionChildrenCursorError();
    if (
      record.v !== PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION
      || record.purpose !== PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE
      || typeof record.viewer !== 'string' || record.viewer.length < 1 || record.viewer.length > 128
      || typeof record.collectionId !== 'string'
      || record.collectionId.length < 1 || record.collectionId.length > 128
      || typeof record.parentId !== 'string' || record.parentId.length > 128
      || !isCollectionChildrenSort(record.sort)
      || typeof record.limit !== 'number' || !Number.isInteger(record.limit)
      || record.limit < 1 || record.limit > 100
      || typeof record.contentRevision !== 'string'
      || record.contentRevision.length < 1 || record.contentRevision.length > 128
      || typeof record.issuedAt !== 'string' || typeof record.expiresAt !== 'string'
    ) throw new CollectionChildrenCursorError();
    const nodeId = after.nodeId;
    const positionKey = after.positionKey;
    const createdAt = after.createdAt;
    if (
      typeof nodeId !== 'string' || nodeId.length < 1 || nodeId.length > 128
      || typeof positionKey !== 'string' || positionKey.length > 512
      || typeof createdAt !== 'string'
    ) throw new CollectionChildrenCursorError();
    parseCursorTimestamp(createdAt);
    parseCursorTimestamp(record.issuedAt);
    parseCursorTimestamp(record.expiresAt);
    const payload: CollectionChildrenCursorPayload = {
      v: PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION,
      purpose: PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE,
      viewer: record.viewer,
      collectionId: record.collectionId,
      parentId: record.parentId,
      sort: record.sort,
      limit: record.limit,
      contentRevision: record.contentRevision,
      after: { nodeId, positionKey, createdAt },
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    };
    // Round-trip canonicalization guard: the reassembled object must serialize
    // to the exact signed text (rejects key reordering / extra fields).
    if (canonicalJson(payload) !== canonicalJson(record)) throw new CollectionChildrenCursorError();
    return payload;
  } catch (error) {
    if (error instanceof CollectionChildrenCursorError) throw error;
    throw new CollectionChildrenCursorError();
  }
}

/** UTC millis clock string used for cursor issuance (contract Timestamp format). */
export function formatChildrenCursorTime(date: Date): string {
  return date.toISOString();
}