import { createHmac, timingSafeEqual } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { hasWellFormedUtf16 } from '../shared/utf16.js';
import {
  decodeCanonicalBase64Url,
  updateFrame,
} from '../server/cursor-hmac-primitives.js';
import { getProblemDefinition, type ProblemCode } from '../shared/problems.js';
import { isHttpUrl } from '../schema/uri.js';

const MIN_KEY_BYTES = 32;
const MAX_KEY_BYTES = 1024;
const MAX_SCOPE_FIELD_BYTES = 4096;
const MAX_CURSOR_LENGTH = 256;
/** Feed-only namespace; deliberately distinct from Sync and Publication cursors. */
const CURSOR_PREFIX = 'fdc1.p';
const MAC_BYTES = 32;
const CONTEXT = Buffer.from('collection-protocol/feed/cursor/hmac-sha-256/v1', 'ascii');
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const CURSOR_PATTERN = /^fdc1\.p([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u;

/**
 * Scope bound into every Feed Cursor (FEED-0002).
 *
 * Cross-context reuse (principal, feed, filter, protocol version) must fail.
 * The exclusive checkpoint is the opaque position encoded in the cursor body.
 */
export interface FeedCursorContext {
  readonly principalId: string;
  readonly feedId: string;
  readonly filterDigest: string;
  readonly protocolVersion: string;
}

export interface FeedCursorScope extends FeedCursorContext {
  /** Exclusive position: response events are those after this checkpoint. */
  readonly position: string;
}

export interface FeedCursorHmacKey {
  readonly destroyed: boolean;
  destroy(): void;
}

export type FeedCursorVerification =
  | { readonly valid: true; readonly position: string }
  | { readonly valid: false; readonly code: 'invalid_cursor_scope' };

export type FeedCursorExpiryResult = {
  readonly code: 'feed_cursor_expired';
  readonly status: 410;
  readonly retryable: false;
  readonly snapshotUrl: string;
};

export interface FeedCursorCodec {
  encode(position: string, context: FeedCursorContext): string;
  decode(cursor: string, context: FeedCursorContext): FeedCursorVerification;
}

const cursorKeys = new WeakMap<FeedCursorHmacKey, Buffer>();

class FeedCursorHmacKeyHandle implements FeedCursorHmacKey {
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

/** Imports private signing key material into a non-readable, destroyable capability. */
export function createFeedCursorHmacKey(keyMaterial: Uint8Array): FeedCursorHmacKey {
  const key = copyKeyMaterial(keyMaterial);
  const handle = Object.freeze(new FeedCursorHmacKeyHandle());
  cursorKeys.set(handle, key);
  return handle;
}

/**
 * Builds a stable filter digest from optional Feed query filter fields.
 *
 * Absent and empty objects produce the same digest. Fields are length-framed
 * so adjacent values cannot collide.
 */
export function createFeedFilterDigest(
  filter: Readonly<Record<string, string | undefined>> = {},
): string {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter) || isProxy(filter)) {
    throw new TypeError('Feed filter must be a plain object.');
  }
  const names = Object.keys(filter).sort();
  const parts: Buffer[] = [];
  try {
    // Always frame a version tag so the empty-filter digest is non-empty and
    // stable (required by cursor scope field non-empty rules).
    parts.push(Buffer.from('feed-filter-v1', 'utf8'));
    for (const name of names) {
      const value = filter[name];
      if (value === undefined) {
        parts.push(Buffer.from([0]));
        continue;
      }
      const nameBytes = encodeField('filterField', name);
      const valueBytes = encodeField(name, value);
      parts.push(Buffer.from([1]));
      const nameLength = Buffer.allocUnsafe(4);
      nameLength.writeUInt32BE(nameBytes.byteLength);
      const valueLength = Buffer.allocUnsafe(4);
      valueLength.writeUInt32BE(valueBytes.byteLength);
      parts.push(nameLength, nameBytes, valueLength, valueBytes);
    }
    return Buffer.concat(parts).toString('base64url');
  } finally {
    for (const part of parts) part.fill(0);
  }
}

/** Signs a Feed continuation without disclosing bound principal/feed/filter. */
export function createFeedCursor(scope: FeedCursorScope, keyHandle: FeedCursorHmacKey): string {
  const normalized = normalizeScope(scope);
  let key: Buffer | undefined;
  try {
    key = borrowKey(keyHandle);
    const position = normalized.position.toString('base64url');
    const macBytes = computeMac(key, normalized);
    const mac = macBytes.toString('base64url');
    macBytes.fill(0);
    const cursor = `${CURSOR_PREFIX}${position}.${mac}`;
    if (cursor.length > MAX_CURSOR_LENGTH) {
      throw new RangeError(`Feed cursor must not exceed ${MAX_CURSOR_LENGTH} characters.`);
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
 * Malformed cursors, wrong keys, Sync/Publication cursor strings, and scope
 * mismatches collapse to the same wire-safe `invalid_cursor_scope` result.
 */
export function verifyFeedCursor(
  cursor: string,
  context: FeedCursorContext,
  keyHandle: FeedCursorHmacKey,
): FeedCursorVerification {
  let normalized: NormalizedScope | undefined;
  let key: Buffer | undefined;
  try {
    const position = decodePosition(cursor);
    normalized = normalizeScope({ ...context, position });
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
      ? Object.freeze({ valid: true, position })
      : invalidCursorScope;
  } catch {
    return invalidCursorScope;
  } finally {
    key?.fill(0);
    if (normalized !== undefined) destroyNormalizedScope(normalized);
  }
}

/**
 * Builds the registered `410 feed_cursor_expired` recovery payload.
 *
 * `snapshotUrl` must be a safe absolute HTTP(S) Snapshot recovery URL without
 * private query material invented by this boundary.
 */
export function createFeedCursorExpiredProblem(snapshotUrl: string): FeedCursorExpiryResult {
  if (!isHttpUrl(snapshotUrl)) {
    throw new TypeError('Feed cursor expiry recovery Snapshot URL must be absolute HTTP(S) without userinfo.');
  }
  const definition = getProblemDefinition('feed_cursor_expired' satisfies ProblemCode);
  return Object.freeze({
    code: 'feed_cursor_expired',
    status: definition.status as 410,
    retryable: definition.retryable as false,
    snapshotUrl,
  });
}

/** Codec bound to one HMAC key for host adapters. */
export function createFeedCursorCodec(keyHandle: FeedCursorHmacKey): FeedCursorCodec {
  return Object.freeze({
    encode(position: string, context: FeedCursorContext): string {
      return createFeedCursor({ ...context, position }, keyHandle);
    },
    decode(cursor: string, context: FeedCursorContext): FeedCursorVerification {
      return verifyFeedCursor(cursor, context, keyHandle);
    },
  });
}

/**
 * Advances an exclusive cursor to `nextPosition` after a page (including empty).
 * Callers must only persist the result after events are durable.
 */
export function advanceFeedCursor(
  nextPosition: string,
  context: FeedCursorContext,
  keyHandle: FeedCursorHmacKey,
): string {
  return createFeedCursor({ ...context, position: nextPosition }, keyHandle);
}

const invalidCursorScope = Object.freeze({
  valid: false,
  code: 'invalid_cursor_scope',
} as const);

interface NormalizedScope {
  readonly principalId: Buffer;
  readonly feedId: Buffer;
  readonly filterDigest: Buffer;
  readonly protocolVersion: Buffer;
  readonly position: Buffer;
}

function normalizeScope(scope: FeedCursorScope): NormalizedScope {
  if (typeof scope !== 'object' || scope === null || isProxy(scope)) {
    throw new TypeError('Feed cursor scope must be an object.');
  }
  return {
    principalId: encodeField('principalId', scope.principalId),
    feedId: encodeField('feedId', scope.feedId),
    filterDigest: encodeField('filterDigest', scope.filterDigest),
    protocolVersion: encodeField('protocolVersion', scope.protocolVersion),
    position: encodeField('position', scope.position),
  };
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
  if (Buffer.from(value, 'utf8').toString('base64url') !== encoded) {
    throw new TypeError('Invalid cursor.');
  }
  encodeField('position', value).fill(0);
  return value;
}

function computeMac(key: Buffer, scope: NormalizedScope): Buffer {
  const mac = createHmac('sha256', key);
  updateFrame(mac, CONTEXT);
  updateFrame(mac, scope.principalId);
  updateFrame(mac, scope.feedId);
  updateFrame(mac, scope.filterDigest);
  updateFrame(mac, scope.protocolVersion);
  updateFrame(mac, scope.position);
  return mac.digest();
}

function copyKeyMaterial(value: Uint8Array): Buffer {
  let byteLength: number;
  try {
    if (!(value instanceof Uint8Array)) throw new TypeError();
    byteLength = value.byteLength;
  } catch {
    throw new TypeError('Feed cursor HMAC key must be a Uint8Array.');
  }
  if (byteLength < MIN_KEY_BYTES || byteLength > MAX_KEY_BYTES) {
    throw new TypeError(
      `Feed cursor HMAC key must contain ${MIN_KEY_BYTES}-${MAX_KEY_BYTES} bytes.`,
    );
  }
  return Buffer.from(value);
}

function borrowKey(value: FeedCursorHmacKey): Buffer {
  const stored = cursorKeys.get(value);
  if (stored === undefined) throw new TypeError('Invalid or destroyed cursor key.');
  return Buffer.from(stored);
}

function destroyNormalizedScope(scope: NormalizedScope): void {
  scope.principalId.fill(0);
  scope.feedId.fill(0);
  scope.filterDigest.fill(0);
  scope.protocolVersion.fill(0);
  scope.position.fill(0);
}
