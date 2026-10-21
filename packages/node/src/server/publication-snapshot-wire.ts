import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import canonicalize from 'canonicalize';
import { cloneAndFreezeJsonData, createValidatorRegistry } from '../schema/index.js';
import type { Snapshot } from '../types/index.js';
import { assertPublicationSnapshotBookmarkUrls } from './publication-bookmark-url-guard.js';
import { assertAnonymousPublicationPrimaryVisibility } from './publication-anonymous-visibility.js';
import { rememberPublicationJsonBytes } from './publication-prepared-json.js';
import {
  hasBoundedPublicationGraph,
  hasSchemaValidatedSnapshot,
  publicationReuseDiagnostics,
  readOutboundProof,
  rememberBoundedPublicationGraph,
  rememberOutboundProof,
  rememberSchemaValidatedSnapshot,
} from './publication-snapshot-reuse.js';
import {
  projectPublicationPublicWire, PublicationPublicProjectionError,
  type PublicationPublicWireOptions,
} from './publication-public-projection.js';
import { projectPublicationAuthorizedWire } from './publication-authorized-projection.js';

const validators = createValidatorRegistry();
const MAX_SNAPSHOT_BYTES = 64 * 1_024 * 1_024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
class SnapshotLimitError extends Error {}

export type PublicationSnapshotAccess = 'anonymous-public' | 'authorized-private';

/** Internal receive/produce boundary; final content identity is computed after public projection. */
export function preparePublicationSnapshotWire(
  value: unknown,
  projectionOptions?: PublicationPublicWireOptions,
  access: PublicationSnapshotAccess = 'anonymous-public',
): Readonly<Snapshot> {
  try {
    if (access !== 'anonymous-public' && access !== 'authorized-private') throw new TypeError();
    const projectionKey = publicationProjectionKey(access, projectionOptions);
    if (typeof value === 'object' && value !== null) {
      const cached = readOutboundProof(value);
      if (cached !== undefined && cached.key === projectionKey) {
        publicationReuseDiagnostics.outboundReuses += 1;
        return cached.result as Readonly<Snapshot>;
      }
    }
    const reusableClone = typeof value === 'object' && value !== null
      && hasSchemaValidatedSnapshot(value)
      && hasBoundedPublicationGraph(value);
    let snapshot: Readonly<Snapshot>;
    if (reusableClone) {
      publicationReuseDiagnostics.schemaReuses += 1;
      snapshot = value as Readonly<Snapshot>;
      if (snapshot.mode !== 'publication') throw new TypeError();
    } else {
      assertBoundedDataGraph(value);
      snapshot = cloneAndFreezeJsonData(value) as Readonly<Snapshot>;
      publicationReuseDiagnostics.schemaValidations += 1;
      if (!validators.validate('snapshot', snapshot).valid || snapshot.mode !== 'publication') throw new TypeError();
      assertPublicationSnapshotBookmarkUrls(snapshot);
      rememberSchemaValidatedSnapshot(snapshot);
      rememberBoundedPublicationGraph(snapshot);
    }
    assertPage(snapshot);
    // Authorized callers receive the safe publication projection, including
    // ACL-approved restricted sidecars. Synchronization metadata, secrets,
    // crawl bodies, local paths, and unallowlisted extensions remain removed.
    const projected = access === 'anonymous-public'
      ? projectPublicationPublicWire(snapshot, projectionOptions)
      : projectPublicationAuthorizedWire(snapshot, projectionOptions);
    if (access === 'anonymous-public') assertAnonymousPublicationPrimaryVisibility(projected);
    // Projection materializes a new object even when the visible fields match.
    // A proof for the pre-projection snapshot does not cover that result.
    if (projected !== snapshot) {
      publicationReuseDiagnostics.projectionValidations += 1;
      if (!validators.validate('snapshot', projected).valid) throw new TypeError();
    } else if (!hasSchemaValidatedSnapshot(projected)) {
      publicationReuseDiagnostics.projectionValidations += 1;
      if (!validators.validate('snapshot', projected).valid) throw new TypeError();
    } else {
      publicationReuseDiagnostics.schemaReuses += 1;
    }
    const finalized = finalizePublicationSnapshotWire(projected as unknown as Readonly<Snapshot>);
    rememberOutboundProof(finalized, projectionKey, finalized);
    if (
      typeof value === 'object'
      && value !== null
      && value !== finalized
      && (reusableClone || hasSchemaValidatedSnapshot(value))
    ) {
      rememberOutboundProof(value, projectionKey, finalized);
    }
    return finalized;
  } catch (error) {
    if (error instanceof PublicationPublicProjectionError) throw error;
    if (error instanceof SnapshotLimitError) throw new RangeError('Publication Snapshot page resource limit exceeded.');
    throw new TypeError('Publication Snapshot page is invalid.');
  }
}

function publicationProjectionKey(
  access: PublicationSnapshotAccess,
  options: PublicationPublicWireOptions | undefined,
): string {
  if (options === undefined) return access;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return `${access}\ninvalid`;
  const namespaces = readProjectionData(options, 'publicExtensionNamespaces');
  const limits = readProjectionData(options, 'limits');
  const namespaceKey = Array.isArray(namespaces)
    ? namespaces.map((item) => typeof item === 'string' ? item : '').join('\n')
    : '';
  const limitKey = typeof limits === 'object' && limits !== null && !Array.isArray(limits)
    ? ['maxDepth', 'maxNodes', 'maxBytes'].map((key) => {
      const value = readProjectionData(limits, key);
      return typeof value === 'number' ? String(value) : '';
    }).join(',')
    : '';
  return `${access}\n${namespaceKey}\n${limitKey}`;
}

function readProjectionData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
  return descriptor.value;
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
  const bytes = new TextEncoder().encode(encoded);
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new SnapshotLimitError();
  rememberPublicationJsonBytes(result, bytes);
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
