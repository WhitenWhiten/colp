import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import canonicalize from 'canonicalize';
import { cloneAndFreezeJsonData, createValidatorRegistry } from '../schema/index.js';
import type { Snapshot } from '../types/index.js';
import { assertPublicationSnapshotBookmarkUrls } from './publication-bookmark-url-guard.js';
import { rememberPublicationJsonBytes } from './publication-prepared-json.js';
import {
  projectPublicationPublicWire, PublicationPublicProjectionError,
  type PublicationPublicWireOptions,
} from './publication-public-projection.js';

const validators = createValidatorRegistry();
const MAX_SNAPSHOT_BYTES = 64 * 1_024 * 1_024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
class SnapshotLimitError extends Error {}

/** Internal receive/produce boundary; final content identity is computed after public projection. */
export function preparePublicationSnapshotWire(
  value: unknown,
  projectionOptions?: PublicationPublicWireOptions,
): Readonly<Snapshot> {
  try {
    assertBoundedDataGraph(value);
    const snapshot = cloneAndFreezeJsonData(value) as Readonly<Snapshot>;
    if (!validators.validate('snapshot', snapshot).valid || snapshot.mode !== 'publication') throw new TypeError();
    assertPublicationSnapshotBookmarkUrls(snapshot);
    assertPage(snapshot);
    const projected = projectPublicationPublicWire(snapshot, projectionOptions);
    if (!validators.validate('snapshot', projected).valid) throw new TypeError();
    return finalizePublicationSnapshotWire(projected as unknown as Readonly<Snapshot>);
  } catch (error) {
    if (error instanceof PublicationPublicProjectionError) throw error;
    if (error instanceof SnapshotLimitError) throw new RangeError('Publication Snapshot page resource limit exceeded.');
    throw new TypeError('Publication Snapshot page is invalid.');
  }
}

/** Finalize only detached, deeply frozen Snapshot data that already passed schema validation. */
export function finalizePublicationSnapshotWire(snapshot: Readonly<Snapshot>): Readonly<Snapshot> {
  if (snapshot.mode !== 'publication') throw new TypeError();
  assertPage(snapshot);
  let result = snapshot;
  if (result.contentDigest !== undefined) {
    if (!result.complete || result.page.sequence !== 1 || result.page.hasMore) throw new TypeError();
    const { contentDigest: _oldDigest, ...content } = result;
    const canonical = canonicalize(content);
    if (canonical === undefined) throw new TypeError();
    result = Object.freeze({ ...content,
      contentDigest: `sha-256=:${createHash('sha256').update(canonical).digest('base64')}:`,
    });
  }
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SNAPSHOT_BYTES) throw new SnapshotLimitError();
  rememberPublicationJsonBytes(result, new TextEncoder().encode(encoded));
  return result;
}

function assertPage(snapshot: Readonly<Snapshot>): void {
  if (typeof snapshot.page !== 'object' || snapshot.page === null
    || (snapshot.page.hasMore && typeof snapshot.page.nextCursor !== 'string')
    || (!snapshot.page.hasMore && snapshot.page.nextCursor !== null)) throw new TypeError();
}

function assertBoundedDataGraph(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    if (isProxy(current)) throw new TypeError();
    seen.add(current);
    count += 1;
    if (count > 1_000_000) throw new SnapshotLimitError();
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === 'length') continue;
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) throw new TypeError();
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
      pending.push(descriptor.value);
    }
  }
}
