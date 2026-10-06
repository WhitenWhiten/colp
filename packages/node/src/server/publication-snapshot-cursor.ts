import { createHmac, timingSafeEqual } from 'node:crypto';

import { hasWellFormedUtf16 } from '../shared/utf16.js';
import {
  decodeCanonicalBase64Url,
  updateFrame,
  updateInteger,
  updateOptionalFrame,
  updateOptionalInteger,
} from './cursor-hmac-primitives.js';

const MIN_KEY_BYTES = 32;
const MAX_KEY_BYTES = 1024;
/** MAC-bound scope fields (revision, principal, root) — not on the wire cursor string. */
const MAX_SCOPE_FIELD_BYTES = 4096;
/**
 * Wire cursor character budget:
 * `psc1.p` + base64url(nextPosition) + `.` + base64url(32-byte MAC).
 * nextPosition is rejected early so oversized positions fail at encode time
 * against this budget rather than after MAC work under a 4096-byte field cap.
 */
const MAX_CURSOR_LENGTH = 128;
const CURSOR_PREFIX = 'psc1.p';
const MAC_BYTES = 32;
/** Unpadded base64url length of {@link MAC_BYTES}. */
const MAC_WIRE_CHARS = 43;
/** Fixed wire overhead excluding the position payload: prefix + `.` + MAC. */
const CURSOR_FIXED_OVERHEAD_CHARS = CURSOR_PREFIX.length + 1 + MAC_WIRE_CHARS;
/**
 * Max UTF-8 bytes for nextPosition that still fit the wire cursor budget.
 * base64url(n) length is `ceil(4n/3)` without padding; largest n with that ≤ 78 is 58.
 */
const MAX_NEXT_POSITION_BYTES = Math.floor(
  (MAX_CURSOR_LENGTH - CURSOR_FIXED_OVERHEAD_CHARS) * 3 / 4,
);
const CONTEXT = Buffer.from('collection-protocol/publication/snapshot-cursor/hmac-sha-256/v1', 'ascii');
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const CURSOR_PATTERN = /^psc1\.p([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u;
const INCLUDE_VALUES = ['annotations', 'attachments', 'relations'] as const;

export type PublicationSnapshotInclude = (typeof INCLUDE_VALUES)[number];

export interface PublicationSnapshotCursorContext {
  readonly revision: string;
  readonly principal: string;
  readonly root?: string;
  readonly depth?: number;
  readonly include?: readonly PublicationSnapshotInclude[];
  readonly pageSize: number;
}

export interface PublicationSnapshotCursorScope extends PublicationSnapshotCursorContext {
  /** Exclusive position at which the following page starts. */
  readonly nextPosition: string;
}

export interface PublicationSnapshotCursorHmacKey {
  readonly destroyed: boolean;
  destroy(): void;
}

export type PublicationSnapshotCursorVerification =
  | { readonly valid: true; readonly nextPosition: string }
  | { readonly valid: false; readonly code: 'invalid_cursor_scope' };

const cursorKeys = new WeakMap<PublicationSnapshotCursorHmacKey, Buffer>();

class PublicationSnapshotCursorHmacKeyHandle implements PublicationSnapshotCursorHmacKey {
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
export function createPublicationSnapshotCursorHmacKey(
  keyMaterial: Uint8Array,
): PublicationSnapshotCursorHmacKey {
  const key = copyKeyMaterial(keyMaterial);
  const handle = Object.freeze(new PublicationSnapshotCursorHmacKeyHandle());
  cursorKeys.set(handle, key);
  return handle;
}

/** Signs a Publication Snapshot continuation without disclosing its bound scope. */
export function createPublicationSnapshotCursor(
  scope: PublicationSnapshotCursorScope,
  keyHandle: PublicationSnapshotCursorHmacKey,
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
      throw new RangeError(
        `Publication Snapshot cursor must not exceed ${MAX_CURSOR_LENGTH} characters (wire budget).`,
      );
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
export function verifyPublicationSnapshotCursor(
  cursor: string,
  context: PublicationSnapshotCursorContext,
  keyHandle: PublicationSnapshotCursorHmacKey,
): PublicationSnapshotCursorVerification {
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

interface NormalizedScope {
  readonly revision: Buffer;
  readonly principal: Buffer;
  readonly root: Buffer | undefined;
  readonly depth: number | undefined;
  readonly include: readonly Buffer[];
  readonly pageSize: number;
  readonly nextPosition: Buffer;
}

function normalizeScope(scope: PublicationSnapshotCursorScope): NormalizedScope {
  if (typeof scope !== 'object' || scope === null) {
    throw new TypeError('Publication Snapshot cursor scope must be an object.');
  }
  const revision = encodeField('revision', scope.revision);
  const principal = encodeField('principal', scope.principal);
  const root = scope.root === undefined ? undefined : encodeField('root', scope.root);
  const depth = encodeOptionalInteger('depth', scope.depth, true);
  const pageSize = encodeInteger('pageSize', scope.pageSize, false);
  const nextPosition = encodeField('nextPosition', scope.nextPosition);
  const include = normalizeInclude(scope.include);
  return { revision, principal, root, depth, include, pageSize, nextPosition };
}

function normalizeInclude(value: readonly PublicationSnapshotInclude[] | undefined): readonly Buffer[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError('include must be an array when provided.');
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !(INCLUDE_VALUES as readonly string[]).includes(item)) {
      throw new TypeError('include contains an unsupported value.');
    }
    seen.add(item);
  }
  return Object.freeze([...seen].sort().map((item) => Buffer.from(item, 'ascii')));
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
  if (name === 'nextPosition') {
    // Position rides on the wire cursor; enforce the 128-char budget at encode time.
    if (encoded.length > MAX_NEXT_POSITION_BYTES) {
      throw new RangeError(
        `Publication Snapshot cursor must not exceed ${MAX_CURSOR_LENGTH} characters (wire budget).`,
      );
    }
    return encoded;
  }
  if (encoded.length > MAX_SCOPE_FIELD_BYTES) {
    throw new RangeError(`${name} must not exceed ${MAX_SCOPE_FIELD_BYTES} UTF-8 bytes.`);
  }
  return encoded;
}

function encodeOptionalInteger(name: string, value: number | undefined, allowZero: boolean): number | undefined {
  return value === undefined ? undefined : encodeInteger(name, value, allowZero);
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
  updateFrame(mac, scope.revision);
  updateFrame(mac, scope.principal);
  updateOptionalFrame(mac, scope.root);
  updateOptionalInteger(mac, scope.depth);
  updateInteger(mac, scope.include.length);
  for (const item of scope.include) updateFrame(mac, item);
  updateInteger(mac, scope.pageSize);
  updateFrame(mac, scope.nextPosition);
  return mac.digest();
}

function copyKeyMaterial(value: Uint8Array): Buffer {
  let byteLength: number;
  try {
    if (!(value instanceof Uint8Array)) throw new TypeError();
    byteLength = value.byteLength;
  } catch {
    throw new TypeError('Publication Snapshot cursor HMAC key must be a Uint8Array.');
  }
  if (byteLength < MIN_KEY_BYTES || byteLength > MAX_KEY_BYTES) {
    throw new TypeError(`Publication Snapshot cursor HMAC key must contain ${MIN_KEY_BYTES}-${MAX_KEY_BYTES} bytes.`);
  }
  return Buffer.from(value);
}

function borrowKey(value: PublicationSnapshotCursorHmacKey): Buffer {
  const stored = cursorKeys.get(value);
  if (stored === undefined) throw new TypeError('Invalid or destroyed cursor key.');
  return Buffer.from(stored);
}

function destroyNormalizedScope(scope: NormalizedScope): void {
  scope.revision.fill(0);
  scope.principal.fill(0);
  scope.root?.fill(0);
  scope.include.forEach((item) => item.fill(0));
  scope.nextPosition.fill(0);
}
