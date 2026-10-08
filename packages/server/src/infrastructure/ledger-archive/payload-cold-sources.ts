import { createHash } from 'node:crypto';
import type {
  AuditHotPayloadRecord,
  AuditPayloadColdFacts,
  AuditPayloadColdSource,
} from '../database/audit-event-payload.js';
import { AuditPayloadReadError } from '../database/audit-event-payload.js';
import { evaluateLedgerArchivePolicyFromLinear } from '../database/ledger-archive-policy.js';
import type { LedgerArchiveSegment, LedgerArchiveSegmentRepository } from '../database/ledger-archive-segment-repository.js';
import type {
  HistoricalOperationPayloadPort,
  HistoricalOperationPayloadPurpose,
  OperationPayloadDocument,
  OperationPayloadFacts,
} from '../database/operation-payload-tables.js';
import { OperationPayloadReadError } from '../database/operation-payload-store.js';
import { LedgerArchiveColdReadError } from './cold-reader.js';
import {
  createSegmentPayloadCache,
  type SegmentPayloadCache,
  type SegmentPayloadCacheOptions,
} from './segment-payload-cache.js';
import {
  AUDIT_PAYLOAD_ARCHIVE_FAMILY,
  AUDIT_PAYLOAD_ARCHIVE_RELATION,
  AUDIT_PAYLOAD_ARCHIVE_SCOPE,
  OPERATION_ARCHIVE_FAMILY,
  OPERATION_ARCHIVE_RELATION,
} from './production-sources.js';

interface ArchiveRowReader {
  readRows(
    segmentId: string,
    onRow: (row: Readonly<{ key: bigint; value: unknown }>) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface PayloadArchiveMaterializationOptions extends SegmentPayloadCacheOptions {
  readonly cache?: SegmentPayloadCache;
  /** @deprecated Prefer maxBytesPerSegment. */
  readonly maxMaterializedBytesPerSegment?: bigint;
  /** @deprecated Prefer a shared SegmentPayloadCache. */
  readonly maxCachedSegments?: number;
}

/**
 * Proves that an archive row is consumable by the production payload cold adapter.
 * Cutover uses this before making archived payloads authoritative.
 */
export function validatePayloadArchiveRowForCutover(
  family: string,
  row: Readonly<{ key: bigint; value: unknown }>,
  sourceScope: string,
): void {
  if (family === OPERATION_ARCHIVE_FAMILY) {
    const value = requireCutoverRecord(row.value, 'operation');
    const operationId = requireText(value.operationId, 'operation');
    const collectionId = requireText(value.collectionId, 'operation');
    const commitOrdinal = requireCanonicalUnsigned(value.commitOrdinal, 'operation');
    const byteCount = requireCanonicalUnsigned(value.byteCount, 'operation');
    if (commitOrdinal !== row.key || sourceScope !== `collection:${collectionId}`
        || value.schemaVersion !== 1
        || typeof value.digestSha256 !== 'string' || typeof value.bucket !== 'string'
        || typeof value.syncWirePresent !== 'boolean') {
      throw new OperationPayloadReadError('operation_payload_integrity_failure');
    }
    parseOperationDocument(value, {
      operationId, collectionId, commitOrdinal, source: 'archive',
      locator: formatOperationArchiveLocator({
        segmentId: '00000000-0000-4000-8000-000000000000', operationId,
      }),
      digestSha256: value.digestSha256, byteCount, schemaVersion: 1,
      bucket: value.bucket, syncWirePresent: value.syncWirePresent,
    });
    return;
  }
  if (family === AUDIT_PAYLOAD_ARCHIVE_FAMILY) {
    const value = requireCutoverRecord(row.value, 'audit');
    const eventId = requireCanonicalUnsigned(value.eventId, 'audit');
    const payloadBytes = requireCanonicalUnsigned(value.payloadBytes, 'audit');
    const createdAt = new Date(requireText(value.createdAt, 'audit'));
    if (eventId !== row.key || !Number.isFinite(createdAt.getTime())
        || typeof value.eventType !== 'string' || typeof value.payloadDigest !== 'string'
        || typeof value.payloadSchemaVersion !== 'number'
        || typeof value.payloadBucketLocator !== 'string') {
      throw new AuditPayloadReadError('integrity_failure', 'Audit archive row is invalid.');
    }
    parseAuditRecord(value, {
      eventId, archiveSegmentId: '00000000-0000-4000-8000-000000000000', createdAt,
      operationId: nullableText(value.operationId, 'audit'),
      collectionId: nullableText(value.collectionId, 'audit'),
      principalId: nullableText(value.principalId, 'audit'),
      eventType: value.eventType, payloadDigest: value.payloadDigest, payloadBytes,
      payloadSchemaVersion: value.payloadSchemaVersion,
      payloadBucketLocator: value.payloadBucketLocator,
    });
    return;
  }
  if (family !== 'outbox_social') {
    throw new LedgerArchiveColdReadError(
      'archive_reader_family_unsupported', 'Archive family has no production cutover reader.',
    );
  }
}

export function createLedgerArchiveOperationPayloadSource(options: Readonly<{
  segments: LedgerArchiveSegmentRepository;
  reader: ArchiveRowReader;
  purpose: HistoricalOperationPayloadPurpose;
}> & PayloadArchiveMaterializationOptions): HistoricalOperationPayloadPort {
  const cache = options.cache ?? createSegmentPayloadCache(materializationOptions(options));
  return Object.freeze({
    purpose: options.purpose,
    async read(facts: OperationPayloadFacts, signal?: AbortSignal): Promise<OperationPayloadDocument | null> {
      let segmentId: string;
      try {
        const locator = parseOperationArchiveLocator(facts.locator);
        segmentId = locator.segmentId;
        if (locator.operationId !== facts.operationId) {
          throw new Error('operation_archive_locator_binding_invalid');
        }
      } catch {
        throw new OperationPayloadReadError('operation_payload_integrity_failure');
      }
      try {
        const segment = await options.segments.get(segmentId);
        assertOperationManifest(segment, facts);
        const value = await cache.get({
          segmentId, contentDigest: segment.contentDigest,
          archiveSchemaVersion: segment.archiveSchemaVersion,
        }, facts.commitOrdinal, options.reader, signal);
        if (value === undefined) return null;
        return parseOperationDocument(value, facts);
      } catch (error) {
        if (error instanceof OperationPayloadReadError) throw error;
        if (error instanceof LedgerArchiveColdReadError && coldUnavailable(error.stableCode)) {
          throw new OperationPayloadReadError('operation_payload_unavailable');
        }
        throw new OperationPayloadReadError('operation_payload_integrity_failure');
      }
    },
  });
}

export function createLedgerArchiveAuditPayloadColdSource(options: Readonly<{
  segments: LedgerArchiveSegmentRepository;
  reader: ArchiveRowReader;
}> & PayloadArchiveMaterializationOptions): AuditPayloadColdSource {
  const cache = options.cache ?? createSegmentPayloadCache(materializationOptions(options));
  return Object.freeze({
    async read(facts: AuditPayloadColdFacts, signal?: AbortSignal): Promise<AuditHotPayloadRecord | null> {
      try {
        const locator = parseAuditArchiveLocator(facts.payloadBucketLocator);
        if (locator.segmentId !== facts.archiveSegmentId || locator.eventId !== facts.eventId) {
          throw new AuditPayloadReadError('integrity_failure', 'Audit archive locator binding is invalid.');
        }
        const segment = await options.segments.get(facts.archiveSegmentId);
        assertAuditManifest(segment, facts.eventId);
        const value = await cache.get({
          segmentId: facts.archiveSegmentId, contentDigest: segment.contentDigest,
          archiveSchemaVersion: segment.archiveSchemaVersion,
        }, facts.eventId, options.reader, signal);
        if (value === undefined) return null;
        return parseAuditRecord(value, facts);
      } catch (error) {
        if (error instanceof AuditPayloadReadError) throw error;
        if (error instanceof LedgerArchiveColdReadError && coldUnavailable(error.stableCode)) {
          throw new AuditPayloadReadError('archive_unavailable', 'Audit archive object is unavailable.');
        }
        throw new AuditPayloadReadError('integrity_failure', 'Audit archive payload failed verification.');
      }
    },
  });
}

/** Canonical locator emitted by Operation cutover implementations. */
export function formatOperationArchiveLocator(input: Readonly<{
  segmentId: string; operationId: string;
}>): string {
  assertUuid(input.segmentId);
  if (!input.operationId) throw new Error('operation_archive_operation_id_invalid');
  return `archive://ledger-segment/${input.segmentId}/operation/${encodeURIComponent(input.operationId)}`;
}

export function operationSegmentIdFromLocator(locator: string): string {
  return parseOperationArchiveLocator(locator).segmentId;
}

function parseOperationArchiveLocator(locator: string): Readonly<{
  segmentId: string; operationId: string;
}> {
  let url: URL;
  try { url = new URL(locator); } catch { throw new Error('operation_archive_locator_invalid'); }
  if (url.protocol !== 'archive:' || url.hostname !== 'ledger-segment'
      || url.username || url.password || url.search || url.hash) {
    throw new Error('operation_archive_locator_invalid');
  }
  const match = /^\/([^/]+)\/operation\/([^/]+)$/u.exec(url.pathname);
  if (!match?.[1] || !match[2]) throw new Error('operation_archive_locator_invalid');
  const segmentId = match[1];
  assertUuid(segmentId);
  const operationId = decodeURIComponent(match[2]);
  if (!operationId) throw new Error('operation_archive_locator_invalid');
  return Object.freeze({ segmentId, operationId });
}

export function formatAuditPayloadArchiveLocator(input: Readonly<{
  segmentId: string; eventId: bigint;
}>): string {
  assertUuid(input.segmentId);
  return `archive://ledger-segment/${input.segmentId}/audit-event/${input.eventId}`;
}

function parseAuditArchiveLocator(locator: string): Readonly<{ segmentId: string; eventId: bigint }> {
  let url: URL;
  try { url = new URL(locator); } catch { throw new Error('audit_archive_locator_invalid'); }
  if (url.protocol !== 'archive:' || url.hostname !== 'ledger-segment'
      || url.username || url.password || url.search || url.hash) {
    throw new Error('audit_archive_locator_invalid');
  }
  const match = /^\/([^/]+)\/audit-event\/([1-9][0-9]*)$/u.exec(url.pathname);
  if (!match?.[1] || !match[2]) throw new Error('audit_archive_locator_invalid');
  assertUuid(match[1]);
  return Object.freeze({ segmentId: match[1], eventId: BigInt(match[2]) });
}

function materializationOptions(
  options: PayloadArchiveMaterializationOptions,
): SegmentPayloadCacheOptions {
  return {
    maxRowsPerSegment: options.maxRowsPerSegment,
    maxBytesPerSegment: options.maxBytesPerSegment ?? options.maxMaterializedBytesPerSegment,
    maxCachedBytes: options.maxCachedBytes,
    maxConcurrentLoads: options.maxConcurrentLoads ?? options.maxCachedSegments,
    loadTimeoutMs: options.loadTimeoutMs,
    maxQueuedLoads: options.maxQueuedLoads,
  };
}

function assertOperationManifest(
  segment: LedgerArchiveSegment | undefined,
  facts: OperationPayloadFacts,
): asserts segment is LedgerArchiveSegment {
  if (!segment) throw new OperationPayloadReadError('operation_payload_unavailable');
  if (!evaluateLedgerArchivePolicyFromLinear(segment.state, segment.legalHold).canHydratePayload
      || segment.ledgerFamily !== OPERATION_ARCHIVE_FAMILY
      || segment.sourceRelation !== OPERATION_ARCHIVE_RELATION
      || segment.sourceScope !== `collection:${facts.collectionId}`
      || segment.archiveSchemaVersion !== 1
      || facts.commitOrdinal < segment.sourceKeyBounds.lowerInclusive
      || facts.commitOrdinal >= segment.sourceKeyBounds.upperExclusive) {
    throw new OperationPayloadReadError('operation_payload_integrity_failure');
  }
}

function assertAuditManifest(
  segment: LedgerArchiveSegment | undefined,
  eventId: bigint,
): asserts segment is LedgerArchiveSegment {
  if (!segment) throw new AuditPayloadReadError('archive_unavailable', 'Audit archive manifest is unavailable.');
  if (!evaluateLedgerArchivePolicyFromLinear(segment.state, segment.legalHold).canHydratePayload
      || segment.ledgerFamily !== AUDIT_PAYLOAD_ARCHIVE_FAMILY
      || segment.sourceRelation !== AUDIT_PAYLOAD_ARCHIVE_RELATION
      || segment.sourceScope !== AUDIT_PAYLOAD_ARCHIVE_SCOPE
      || segment.archiveSchemaVersion !== 1
      || eventId < segment.sourceKeyBounds.lowerInclusive
      || eventId >= segment.sourceKeyBounds.upperExclusive) {
    throw new AuditPayloadReadError('integrity_failure', 'Audit archive manifest binding is invalid.');
  }
}

function parseOperationDocument(value: unknown, facts: OperationPayloadFacts): OperationPayloadDocument {
  if (!isRecord(value) || value.kind !== 'operation-payload-v1'
      || value.operationId !== facts.operationId || value.collectionId !== facts.collectionId
      || value.commitOrdinal !== facts.commitOrdinal.toString()
      || value.digestSha256 !== facts.digestSha256
      || value.byteCount !== facts.byteCount.toString()
      || value.schemaVersion !== facts.schemaVersion || value.bucket !== facts.bucket
      || value.syncWirePresent !== facts.syncWirePresent
      || typeof value.canonicalPayloadEnvelopeJson !== 'string') {
    throw new OperationPayloadReadError('operation_payload_integrity_failure');
  }
  const canonical = value.canonicalPayloadEnvelopeJson;
  const actualDigest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  if (actualDigest !== facts.digestSha256
      || BigInt(Buffer.byteLength(canonical, 'utf8')) !== facts.byteCount) {
    throw new OperationPayloadReadError('operation_payload_integrity_failure');
  }
  let envelope: unknown;
  try { envelope = JSON.parse(canonical); } catch {
    throw new OperationPayloadReadError('operation_payload_integrity_failure');
  }
  if (!isRecord(envelope) || Object.keys(envelope).sort().join(',') !== 'payloadJson,syncWireJson'
      || !isRecord(envelope.payloadJson)
      || !(envelope.syncWireJson === null || isRecord(envelope.syncWireJson))
      || (envelope.syncWireJson !== null) !== facts.syncWirePresent) {
    throw new OperationPayloadReadError('operation_payload_integrity_failure');
  }
  return Object.freeze({
    payloadJson: Object.freeze(envelope.payloadJson),
    syncWireJson: envelope.syncWireJson === null ? null : Object.freeze(envelope.syncWireJson),
    digestSha256: value.digestSha256, byteCount: facts.byteCount,
    schemaVersion: facts.schemaVersion,
  });
}

function parseAuditRecord(value: unknown, facts: AuditPayloadColdFacts): AuditHotPayloadRecord {
  if (!isRecord(value) || value.kind !== 'audit-payload-v1'
      || value.eventId !== facts.eventId.toString()
      || value.operationId !== facts.operationId || value.collectionId !== facts.collectionId
      || value.principalId !== facts.principalId || value.eventType !== facts.eventType
      || value.createdAt !== facts.createdAt.toISOString()
      || value.payloadDigest !== facts.payloadDigest
      || value.payloadBytes !== facts.payloadBytes.toString()
      || value.payloadSchemaVersion !== facts.payloadSchemaVersion
      || value.payloadBucketLocator !== `hot://audit_event_payloads/${facts.eventId}`
      || typeof value.canonicalJson !== 'string') {
    throw new AuditPayloadReadError('integrity_failure', 'Audit archive header binding is invalid.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value.canonicalJson); } catch {
    throw new AuditPayloadReadError('integrity_failure', 'Audit archive canonical JSON is invalid.');
  }
  const canonicalBytes = BigInt(Buffer.byteLength(value.canonicalJson, 'utf8'));
  const canonicalDigest = `sha256:${createHash('sha256').update(value.canonicalJson, 'utf8').digest('hex')}`;
  if (!isRecord(parsed) || canonicalBytes !== facts.payloadBytes
      || canonicalDigest !== facts.payloadDigest) throw new AuditPayloadReadError(
    'integrity_failure', 'Audit archive details identity is invalid.',
  );
  return Object.freeze({
    id: facts.eventId, createdAt: facts.createdAt, operationId: facts.operationId,
    collectionId: facts.collectionId, principalId: facts.principalId,
    eventType: facts.eventType, payloadDigest: facts.payloadDigest,
    payloadBytes: facts.payloadBytes, payloadSchemaVersion: facts.payloadSchemaVersion,
    payloadBucketLocator: facts.payloadBucketLocator, canonicalJson: value.canonicalJson,
    details: Object.freeze(parsed),
  });
}

function coldUnavailable(code: string): boolean {
  return code === 'archive_manifest_not_found' || code === 'archive_not_verified'
    || code === 'archive_object_not_found' || code === 'archive_object_unavailable'
    || code === 'archive_object_access_denied' || code === 'archive_read_failed'
    || code === 'archive_reader_busy';
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('operation_archive_segment_id_invalid');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireCutoverRecord(value: unknown, family: string): Record<string, unknown> {
  if (!isRecord(value)) throw new LedgerArchiveColdReadError(
    `archive_${family}_payload_invalid`, 'Archive payload row is invalid.',
  );
  return value;
}

function requireText(value: unknown, family: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new LedgerArchiveColdReadError(
    `archive_${family}_payload_invalid`, 'Archive payload text is invalid.',
  );
  return value;
}

function nullableText(value: unknown, family: string): string | null {
  if (value === null) return null;
  return requireText(value, family);
}

function requireCanonicalUnsigned(value: unknown, family: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new LedgerArchiveColdReadError(
      `archive_${family}_payload_invalid`, 'Archive payload integer is invalid.',
    );
  }
  return BigInt(value);
}
