import canonicalize from 'canonicalize';
import {
  createPublicationSnapshotPageSeries as createBoundSeries,
  releasePublicationSnapshotPage as releaseBoundPage,
  type PublicationSnapshotPageScope,
  type PublicationSnapshotPageSeries,
  type PublicationSnapshotPageSeriesStart,
} from './publication-snapshot-page-series-core.js';
import type { Snapshot } from '../types/index.js';

export type {
  PublicationSnapshotPageScope, PublicationSnapshotPageSeries, PublicationSnapshotPageSeriesStart,
} from './publication-snapshot-page-series-core.js';

const contexts = new WeakMap<object, string>();

/**
 * Compose the protocol's five-field scope binding with logical Snapshot
 * framing. This additional package contract matches page assembly; it does
 * not redefine the protocol's Principal/query binding requirements.
 */
export function createPublicationSnapshotPageSeries(
  firstPage: unknown,
  scope: PublicationSnapshotPageScope,
): PublicationSnapshotPageSeriesStart {
  const result = createBoundSeries(firstPage, scope);
  if (result.page.page.sequence !== 1) throw new TypeError('Publication Snapshot page-series input is invalid.');
  contexts.set(result.series, logicalContext(result.page));
  return result;
}

/**
 * Release a continuation without changing logical metadata. Requests may be
 * retried or served concurrently; this capability is not a mutable cursor.
 * Cursor authorization and complete sequence assembly remain separate gates.
 */
export function releasePublicationSnapshotPage(
  series: PublicationSnapshotPageSeries,
  page: unknown,
  scope: PublicationSnapshotPageScope,
): Readonly<Snapshot> {
  const result = releaseBoundPage(series, page, scope);
  const expected = contexts.get(series);
  if (expected === undefined || result.page.sequence < 2 || logicalContext(result) !== expected) {
    throw new TypeError('Publication Snapshot page-series context does not match.');
  }
  return result;
}

function logicalContext(snapshot: Readonly<Snapshot>): string {
  const context = canonicalize({
    protocolVersion: snapshot.protocolVersion,
    snapshotId: snapshot.snapshotId,
    revision: snapshot.revision,
    mode: snapshot.mode,
    complete: snapshot.complete,
    generatedAt: snapshot.generatedAt,
    syncCursor: snapshot.syncCursor ?? null,
    collection: snapshot.collection,
  });
  if (context === undefined) throw new TypeError('Publication Snapshot page-series input is invalid.');
  return context;
}
