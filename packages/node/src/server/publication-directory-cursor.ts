import { createHmac, timingSafeEqual } from 'node:crypto';

import { hasWellFormedUtf16 } from '../shared/utf16.js';
import {
  decodeCanonicalBase64Url,
  updateFrame,
  updateInteger,
} from './cursor-hmac-primitives.js';

const MIN_KEY_BYTES = 32;
const MAX_KEY_BYTES = 1024;
const MAX_SCOPE_FIELD_BYTES = 4096;
const MAX_CURSOR_LENGTH = 128;
const CURSOR_PREFIX = 'pdc1.p';
const MAC_BYTES = 32;
const CONTEXT = Buffer.from('collection-protocol/publication/directory-cursor/hmac-sha-256/v1', 'ascii');
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const CURSOR_PATTERN = /^pdc1\.p([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u;

/**
 * Protocol default Directory sort: `updatedAt DESC, id ASC`
 * (02-http-publication-feed Collection Directory).
 */
export const DEFAULT_PUBLICATION_DIRECTORY_SORT = 'updatedAt DESC, id ASC' as const;

/**
 * Directory query filter fields that participate in cursor scope
 * (`cursor` and `limit` are bound separately).
 */
export interface PublicationDirectoryCursorFilter {
  readonly tag?: string;
  readonly creator?: string;
  readonly kind?: string;
  readonly updatedSince?: string;
  readonly q?: string;
}

export interface PublicationDirectoryCursorContext {
  readonly principal: string;
  /**
   * Canonical filter/query summary for the active Directory (or Discovery)
   * selection. Prefer {@link createPublicationDirectoryFilterDigest} for the
   * standard Directory query filter fields so identical logical filters share
   * one stable digest.
   */
  readonly filterDigest: string;
  /** Sort expression bound into the cursor (default Directory sort above). */
  readonly sort: string;
  readonly limit: number;
  readonly protocolVersion: string;
}

export interface PublicationDirectoryCursorScope extends PublicationDirectoryCursorContext {
  /** Exclusive position at which the following page starts. */
  readonly nextPosition: string;
}

export interface PublicationDirectoryCursorHmacKey {
  readonly destroyed: boolean;
  destroy(): void;
}

export type PublicationDirectoryCursorVerification =
  | { readonly valid: true; readonly nextPosition: string }
  | { readonly valid: false; readonly code: 'invalid_cursor_scope' };

const cursorKeys = new WeakMap<PublicationDirectoryCursorHmacKey, Buffer>();

class PublicationDirectoryCursorHmacKeyHandle implements PublicationDirectoryCursorHmacKey {
  get destroyed(): boolean {
    return !cursorKeys.has(this);
  }

  destroy(): void {
    const key = cursorKeys.get(this);
    if (key === undefined) return;
    cursorKeys.delete(this);
    key.fill(0);
  }
}

/** Imports a private signing key into a non-readable, destroyable capability. */
export function createPublicationDirectoryCursorHmacKey(
  keyMaterial: Uint8Array,
): PublicationDirectoryCursorHmacKey {
  const key = copyKeyMaterial(keyMaterial);
  const handle = Object.freeze(new PublicationDirectoryCursorHmacKeyHandle());
  cursorKeys.set(handle, key);
  return handle;
}

/**
 * Builds a stable filter/query digest from Directory query filter fields.
 *
 * Fields are length-framed in fixed order (`tag`, `creator`, `kind`,
 * `updatedSince`, `q`) with presence flags so adjacent values cannot collide.
 * Absent and empty objects produce the same digest. The result is base64url of
 * the framed bytes and is suitable as {@link PublicationDirectoryCursorContext.filterDigest}.
 */
export function createPublicationDirectoryFilterDigest(
  filter: PublicationDirectoryCursorFilter = {},
): string {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw new TypeError('Directory filter must be an object.');
  }
  const parts: Buffer[] = [];
  try {
    for (const name of FILTER_FIELD_NAMES) {
      const value = (filter as Record<string, unknown>)[name];
      if (value === undefined) {
        parts.push(Buffer.from([0]));
        continue;
      }
      const encoded = encodeField(name, value as string);
      parts.push(Buffer.from([1]));
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(encoded.byteLength);
      parts.push(length, encoded);
    }
    return Buffer.concat(parts).toString('base64url');
  } finally {
    for (const part of parts) part.fill(0);
  }
}

/** Signs a Directory/Discovery continuation without disclosing its bound scope. */
export function createPublicationDirectoryCursor(
  scope: PublicationDirectoryCursorScope,
  keyHandle: PublicationDirectoryCursorHmacKey,
): string {
  const normalized = normalizeScope(scope);
  let key: Buffer | undefined;
  try {
    key = borrowKey(keyHandle);
    const position = normalized.nextPosition.toString('base64url');
    const macBytes = computeMac(key, normalized);
    const mac = macBytes.toString('base64url');
    macBytes.fill(0);
    const cursor = `${CURSOR_PREFIX}${position}.${mac}`;
    if (cursor.length > MAX_CURSOR_LENGTH) {
      throw new RangeError(`Publication Directory cursor must not exceed ${MAX_CURSOR_LENGTH} characters.`);
    }
    return cursor;
  } finally {
    key?.fill(0);
    destroyNormalizedScope(normalized);
  }
}

/**
 * Authenticates a cursor against the complete request scope.
 *
 * All malformed cursors, wrong keys, and scope mismatches deliberately collapse
 * to the same wire-safe result. The returned position is usable only after the
 * MAC has been compared in constant time.
 */
export function verifyPublicationDirectoryCursor(
  cursor: string,
  context: PublicationDirectoryCursorContext,
  keyHandle: PublicationDirectoryCursorHmacKey,
): PublicationDirectoryCursorVerification {
  let normalized: NormalizedScope | undefined;
  let key: Buffer | undefined;
  try {
    const nextPosition = decodePosition(cursor);
    normalized = normalizeScope({ ...context, nextPosition });
    key = borrowKey(keyHandle);

    const match = CURSOR_PATTERN.exec(cursor);
    if (match === null) return invalidCursorScope;
    const suppliedMac = decodeCanonicalBase64Url(match[2] as string, MAC_BYTES);
    if (suppliedMac === undefined) return invalidCursorScope;
    const expectedMac = computeMac(key, normalized);
    const valid = timingSafeEqual(suppliedMac, expectedMac);
    suppliedMac.fill(0);
    expectedMac.fill(0);
    return valid
      ? Object.freeze({ valid: true, nextPosition })
      : invalidCursorScope;
  } catch {
    return invalidCursorScope;
  } finally {
    key?.fill(0);
    if (normalized !== undefined) destroyNormalizedScope(normalized);
  }
}

const invalidCursorScope = Object.freeze({
  valid: false,
  code: 'invalid_cursor_scope',
} as const);

const FILTER_FIELD_NAMES = ['tag', 'creator', 'kind', 'updatedSince', 'q'] as const;

interface NormalizedScope {
  readonly principal: Buffer;
  readonly filterDigest: Buffer;
  readonly sort: Buffer;
  readonly limit: number;
  readonly protocolVersion: Buffer;
  readonly nextPosition: Buffer;
}

function normalizeScope(scope: PublicationDirectoryCursorScope): NormalizedScope {
  if (typeof scope !== 'object' || scope === null) {
    throw new TypeError('Publication Directory cursor scope must be an object.');
  }
  const principal = encodeField('principal', scope.principal);
  const filterDigest = encodeField('filterDigest', scope.filterDigest);
  const sort = encodeField('sort', scope.sort);
  const limit = encodeInteger('limit', scope.limit, false);
  const protocolVersion = encodeField('protocolVersion', scope.protocolVersion);
  const nextPosition = encodeField('nextPosition', scope.nextPosition);
  return { principal, filterDigest, sort, limit, protocolVersion, nextPosition };
}

function encodeField(name: string, value: string): Buffer {
  if (
    typeof value !== 'string'
    || value.length === 0
    || CONTROL_CHARACTER_PATTERN.test(value)
    || !hasWellFormedUtf16(value)
  ) {
    throw new TypeError(`${name} must be a non-empty, well-formed string without control characters.`);
  }
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > MAX_SCOPE_FIELD_BYTES) {
    throw new RangeError(`${name} must not exceed ${MAX_SCOPE_FIELD_BYTES} UTF-8 bytes.`);
  }
  return encoded;
}

function encodeInteger(name: string, value: number, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer.`);
  }
  return value;
}

function decodePosition(cursor: string): string {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw new TypeError('Invalid cursor.');
  }
  const match = CURSOR_PATTERN.exec(cursor);
  if (match === null) throw new TypeError('Invalid cursor.');
  const encoded = match[1] as string;
  const bytes = decodeCanonicalBase64Url(encoded);
  if (bytes === undefined) throw new TypeError('Invalid cursor.');
  const value = bytes.toString('utf8');
  bytes.fill(0);
  if (Buffer.from(value, 'utf8').toString('base64url') !== encoded) throw new TypeError('Invalid cursor.');
  encodeField('nextPosition', value).fill(0);
  return value;
}

function computeMac(key: Buffer, scope: NormalizedScope): Buffer {
  const mac = createHmac('sha256', key);
  updateFrame(mac, CONTEXT);
  updateFrame(mac, scope.principal);
  updateFrame(mac, scope.filterDigest);
  updateFrame(mac, scope.sort);
  updateInteger(mac, scope.limit);
  updateFrame(mac, scope.protocolVersion);
  updateFrame(mac, scope.nextPosition);
  return mac.digest();
}

function copyKeyMaterial(value: Uint8Array): Buffer {
  let byteLength: number;
  try {
    if (!(value instanceof Uint8Array)) throw new TypeError();
    byteLength = value.byteLength;
  } catch {
    throw new TypeError('Publication Directory cursor HMAC key must be a Uint8Array.');
  }
  if (byteLength < MIN_KEY_BYTES || byteLength > MAX_KEY_BYTES) {
    throw new TypeError(`Publication Directory cursor HMAC key must contain ${MIN_KEY_BYTES}-${MAX_KEY_BYTES} bytes.`);
  }
  return Buffer.from(value);
}

function borrowKey(value: PublicationDirectoryCursorHmacKey): Buffer {
  const stored = cursorKeys.get(value);
  if (stored === undefined) throw new TypeError('Invalid or destroyed cursor key.');
  return Buffer.from(stored);
}

function destroyNormalizedScope(scope: NormalizedScope): void {
  scope.principal.fill(0);
  scope.filterDigest.fill(0);
  scope.sort.fill(0);
  scope.protocolVersion.fill(0);
  scope.nextPosition.fill(0);
}
