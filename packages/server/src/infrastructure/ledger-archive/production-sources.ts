import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import type { DatabaseSchema } from '../database/runtime.js';
import { LedgerArchiveSourceRegistry, type LedgerArchiveSource } from './source.js';
import { createPostgresSocialOutboxLedgerArchiveSource } from './social-outbox-source.js';

export const OPERATION_ARCHIVE_FAMILY = 'operation';
export const OPERATION_ARCHIVE_RELATION = 'public.operation_payloads';
export const AUDIT_PAYLOAD_ARCHIVE_FAMILY = 'audit_payload';
export const AUDIT_PAYLOAD_ARCHIVE_RELATION = 'public.audit_event_payloads';
export const AUDIT_PAYLOAD_ARCHIVE_SCOPE = 'global';

export class LedgerArchiveProductionSourceError extends Error {
  constructor(readonly stableCode: string, message: string) {
    super(message);
    this.name = 'LedgerArchiveProductionSourceError';
  }
}

interface OperationArchiveDatabaseRow {
  operation_id: string;
  fact_collection_id: string;
  fact_commit_ordinal: string | bigint;
  payload_source: string;
  payload_locator: string;
  payload_digest_sha256: string;
  payload_bytes: string | bigint;
  payload_schema_version: number;
  payload_bucket: string;
  sync_wire_present: boolean;
  payload_operation_id: string | null;
  payload_collection_id: string | null;
  payload_commit_ordinal: string | bigint | null;
  payload_json: Record<string, unknown> | null;
  sync_wire_json: Record<string, unknown> | null;
  canonical_digest_sha256: string | null;
  canonical_bytes: string | bigint | null;
  payload_row_schema_version: number | null;
  payload_row_bucket: string | null;
  actual_digest: string | null;
  actual_bytes: string | bigint | null;
  canonical_payload_envelope_json: string | null;
}

export interface OperationArchiveRow {
  readonly operationId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  /** Exact UTF-8 emitted by operation_payload_canonical_bytes(); never reconstructed in JS. */
  readonly canonicalPayloadEnvelopeJson: string;
  readonly digestSha256: string;
  readonly byteCount: bigint;
  readonly schemaVersion: 1;
  readonly bucket: string;
  readonly syncWirePresent: boolean;
}

interface AuditArchiveDatabaseRow {
  id: string | bigint;
  operation_id: string | null;
  collection_id: string | null;
  principal_id: string | null;
  event_type: string;
  created_at: Date;
  payload_digest: string;
  payload_bytes: string | bigint;
  payload_schema_version: number;
  payload_bucket_locator: string;
  hot_payload_id: string | bigint | null;
  payload_event_id: string | bigint | null;
  payload_created_at: Date | null;
  canonical_json: string | null;
}

export interface AuditPayloadArchiveRow {
  readonly eventId: bigint;
  readonly operationId: string | null;
  readonly collectionId: string | null;
  readonly principalId: string | null;
  readonly eventType: string;
  readonly createdAt: string;
  readonly payloadDigest: string;
  readonly payloadBytes: bigint;
  readonly payloadSchemaVersion: number;
  readonly payloadBucketLocator: string;
  readonly canonicalJson: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Create the Collection-scoped production source after proving the Collection exists. */
export async function createPostgresOperationLedgerArchiveSource(
  database: Kysely<DatabaseSchema>,
  sourceScope: string,
): Promise<LedgerArchiveSource<OperationArchiveRow>> {
  const collectionId = collectionIdFromScope(sourceScope);
  const collection = await sql<{ present: boolean }>`SELECT EXISTS(
    SELECT 1 FROM collections WHERE id = ${collectionId}
  ) AS present`.execute(database);
  if (collection.rows[0]?.present !== true) {
    throw sourceError('archive_source_collection_not_found', 'Operation archive Collection does not exist.');
  }

  return Object.freeze({
    ledgerFamily: OPERATION_ARCHIVE_FAMILY,
    sourceRelation: OPERATION_ARCHIVE_RELATION,
    sourceScope,
    keyOf: (row: OperationArchiveRow) => row.commitOrdinal,
    archiveValue: operationArchiveValue,
    async readPage(input: Parameters<LedgerArchiveSource<OperationArchiveRow>['readPage']>[0]) {
      assertPageLimit(input.limit);
      input.signal?.throwIfAborted();
      const after = input.afterExclusive ?? input.bounds.lowerInclusive - 1n;
      const result = await sql<OperationArchiveDatabaseRow>`
        SELECT operation.operation_id,
               operation.collection_id AS fact_collection_id,
               operation.commit_ordinal AS fact_commit_ordinal,
               operation.payload_source, operation.payload_locator,
               operation.payload_digest_sha256, operation.payload_bytes,
               operation.payload_schema_version, operation.payload_bucket::text AS payload_bucket,
               operation.sync_wire_present,
               payload.operation_id AS payload_operation_id,
               payload.collection_id AS payload_collection_id,
               payload.commit_ordinal AS payload_commit_ordinal,
               payload.payload_json, payload.sync_wire_json,
               payload.canonical_digest_sha256, payload.canonical_bytes,
               payload.payload_schema_version AS payload_row_schema_version,
               payload.payload_bucket::text AS payload_row_bucket,
               operation_payload_sha256(payload.payload_json, payload.sync_wire_json) AS actual_digest,
               octet_length(operation_payload_canonical_bytes(
                 payload.payload_json, payload.sync_wire_json))::bigint AS actual_bytes,
               convert_from(operation_payload_canonical_bytes(
                 payload.payload_json, payload.sync_wire_json), 'UTF8')
                 AS canonical_payload_envelope_json
          FROM operations operation
          LEFT JOIN operation_payloads payload ON payload.operation_id = operation.operation_id
         WHERE operation.collection_id = ${collectionId}
           AND operation.commit_ordinal >= ${input.bounds.lowerInclusive}
           AND operation.commit_ordinal < ${input.bounds.upperExclusive}
           AND operation.commit_ordinal > ${after}
         ORDER BY operation.commit_ordinal, operation.operation_id COLLATE "C"
         LIMIT ${input.limit + 1}
      `.execute(database);
      input.signal?.throwIfAborted();
      const materialized = result.rows.map((row) => parseOperationRow(row, collectionId));
      assertDenseOperationPage(materialized, input.bounds.lowerInclusive,
        input.bounds.upperExclusive, input.afterExclusive, input.limit);
      return Object.freeze({
        rows: Object.freeze(materialized.slice(0, input.limit)),
        hasMore: materialized.length > input.limit,
      });
    },
  });
}

/** Audit payload archives are keyed only by the permanent global event id. */
export function createPostgresAuditPayloadLedgerArchiveSource(
  database: Kysely<DatabaseSchema>,
  sourceScope = AUDIT_PAYLOAD_ARCHIVE_SCOPE,
): LedgerArchiveSource<AuditPayloadArchiveRow> {
  if (sourceScope !== AUDIT_PAYLOAD_ARCHIVE_SCOPE) {
    throw sourceError('archive_source_scope_invalid', 'Audit payload archive scope must be global.');
  }
  return Object.freeze({
    ledgerFamily: AUDIT_PAYLOAD_ARCHIVE_FAMILY,
    sourceRelation: AUDIT_PAYLOAD_ARCHIVE_RELATION,
    sourceScope,
    keyOf: (row: AuditPayloadArchiveRow) => row.eventId,
    archiveValue: auditArchiveValue,
    async readPage(input: Parameters<LedgerArchiveSource<AuditPayloadArchiveRow>['readPage']>[0]) {
      assertPageLimit(input.limit);
      input.signal?.throwIfAborted();
      const after = input.afterExclusive ?? input.bounds.lowerInclusive - 1n;
      const result = await sql<AuditArchiveDatabaseRow>`
        SELECT event.id, event.operation_id, event.collection_id, event.principal_id,
               event.event_type, event.created_at, event.payload_digest,
               event.payload_bytes, event.payload_schema_version,
               event.payload_bucket_locator, event.hot_payload_id,
               payload.event_id AS payload_event_id,
               payload.created_at AS payload_created_at,
               payload.details_json::text AS canonical_json
          FROM audit_events event
          LEFT JOIN audit_event_payloads payload ON payload.event_id = event.id
         WHERE event.id >= ${input.bounds.lowerInclusive}
           AND event.id < ${input.bounds.upperExclusive}
           AND event.id > ${after}
         ORDER BY event.id
         LIMIT ${input.limit + 1}
      `.execute(database);
      input.signal?.throwIfAborted();
      const materialized = result.rows.map(parseAuditRow);
      return Object.freeze({
        rows: Object.freeze(materialized.slice(0, input.limit)),
        hasMore: materialized.length > input.limit,
      });
    },
  });
}

/** Production registry factory used by CLI/runtime composition. */
export async function createPostgresLedgerArchiveSourceRegistry(
  database: Kysely<DatabaseSchema>,
  options: Readonly<{
    operationSourceScope?: string;
    socialOutboxSourceScope?: string;
  }> = {},
): Promise<LedgerArchiveSourceRegistry> {
  const registry = new LedgerArchiveSourceRegistry();
  registry.register(createPostgresAuditPayloadLedgerArchiveSource(database));
  if (options.operationSourceScope !== undefined) {
    registry.register(await createPostgresOperationLedgerArchiveSource(
      database, options.operationSourceScope,
    ));
  }
  if (options.socialOutboxSourceScope !== undefined) {
    registry.register(await createPostgresSocialOutboxLedgerArchiveSource(
      database, options.socialOutboxSourceScope,
    ));
  }
  return registry;
}

function parseOperationRow(row: OperationArchiveDatabaseRow, collectionId: string): OperationArchiveRow {
  const commitOrdinal = BigInt(row.fact_commit_ordinal);
  const byteCount = BigInt(row.payload_bytes);
  const bucket = dateOnly(row.payload_bucket);
  if (row.fact_collection_id !== collectionId || row.payload_source !== 'hot'
      || row.payload_operation_id !== row.operation_id
      || row.payload_collection_id !== collectionId
      || row.payload_commit_ordinal === null || BigInt(row.payload_commit_ordinal) !== commitOrdinal
      || row.payload_json === null || row.canonical_digest_sha256 === null
      || row.canonical_bytes === null || row.payload_row_schema_version !== 1
      || row.payload_row_bucket === null || dateOnly(row.payload_row_bucket) !== bucket
      || row.payload_schema_version !== 1
      || row.canonical_digest_sha256 !== row.payload_digest_sha256
      || BigInt(row.canonical_bytes) !== byteCount
      || row.actual_digest !== row.payload_digest_sha256
      || row.actual_bytes === null || BigInt(row.actual_bytes) !== byteCount
      || row.canonical_payload_envelope_json === null
      || createHash('sha256').update(row.canonical_payload_envelope_json, 'utf8').digest('hex')
        !== row.payload_digest_sha256
      || BigInt(Buffer.byteLength(row.canonical_payload_envelope_json, 'utf8')) !== byteCount) {
    throw sourceError('archive_source_operation_binding_mismatch',
      'Operation fact and hot payload bindings do not match.');
  }
  const envelope = parseOperationEnvelope(row.canonical_payload_envelope_json);
  if ((envelope.syncWireJson !== null) !== row.sync_wire_present) {
    throw sourceError('archive_source_operation_binding_mismatch',
      'Operation canonical envelope does not match its sync-wire fact.');
  }
  return Object.freeze({
    operationId: row.operation_id, collectionId, commitOrdinal,
    canonicalPayloadEnvelopeJson: row.canonical_payload_envelope_json,
    digestSha256: row.payload_digest_sha256, byteCount, schemaVersion: 1,
    bucket, syncWirePresent: row.sync_wire_present,
  });
}

function parseAuditRow(row: AuditArchiveDatabaseRow): AuditPayloadArchiveRow {
  const eventId = BigInt(row.id);
  if (row.hot_payload_id === null || BigInt(row.hot_payload_id) !== eventId
      || row.payload_event_id === null || BigInt(row.payload_event_id) !== eventId
      || row.payload_created_at === null
      || row.payload_created_at.getTime() !== row.created_at.getTime()
      || row.canonical_json === null) {
    throw sourceError('archive_source_audit_binding_mismatch',
      'Audit event header and hot payload bindings do not match.');
  }
  const bytes = BigInt(Buffer.byteLength(row.canonical_json, 'utf8'));
  const digest = `sha256:${createHash('sha256').update(row.canonical_json, 'utf8').digest('hex')}`;
  if (BigInt(row.payload_bytes) !== bytes || row.payload_digest !== digest
      || row.payload_schema_version !== 1) {
    throw sourceError('archive_source_audit_integrity_failure',
      'Audit payload digest, bytes, or schema does not match its header.');
  }
  let details: unknown;
  try { details = JSON.parse(row.canonical_json); } catch {
    throw sourceError('archive_source_audit_integrity_failure', 'Audit canonical JSON is invalid.');
  }
  if (!isRecord(details)) {
    throw sourceError('archive_source_audit_integrity_failure', 'Audit details are not an object.');
  }
  return Object.freeze({
    eventId, operationId: row.operation_id, collectionId: row.collection_id,
    principalId: row.principal_id, eventType: row.event_type,
    createdAt: row.created_at.toISOString(), payloadDigest: row.payload_digest,
    payloadBytes: bytes, payloadSchemaVersion: row.payload_schema_version,
    payloadBucketLocator: row.payload_bucket_locator, canonicalJson: row.canonical_json,
    details: Object.freeze(details),
  });
}

function operationArchiveValue(row: OperationArchiveRow): unknown {
  return {
    kind: 'operation-payload-v1', operationId: row.operationId,
    collectionId: row.collectionId, commitOrdinal: row.commitOrdinal.toString(),
    canonicalPayloadEnvelopeJson: row.canonicalPayloadEnvelopeJson,
    digestSha256: row.digestSha256, byteCount: row.byteCount.toString(),
    schemaVersion: row.schemaVersion, bucket: row.bucket,
    syncWirePresent: row.syncWirePresent,
  };
}

function auditArchiveValue(row: AuditPayloadArchiveRow): unknown {
  return {
    kind: 'audit-payload-v1', eventId: row.eventId.toString(),
    operationId: row.operationId, collectionId: row.collectionId,
    principalId: row.principalId, eventType: row.eventType, createdAt: row.createdAt,
    payloadDigest: row.payloadDigest, payloadBytes: row.payloadBytes.toString(),
    payloadSchemaVersion: row.payloadSchemaVersion,
    payloadBucketLocator: row.payloadBucketLocator,
    canonicalJson: row.canonicalJson,
  };
}

function assertDenseOperationPage(
  rows: readonly OperationArchiveRow[], lower: bigint, upper: bigint,
  after: bigint | undefined, limit: number,
): void {
  let expected = after === undefined ? lower : after + 1n;
  for (const row of rows) {
    if (row.commitOrdinal !== expected) {
      throw sourceError('archive_source_operation_range_not_dense',
        'Operation archive range contains a missing or duplicate ordinal.');
    }
    expected += 1n;
  }
  if (rows.length <= limit && expected !== upper) {
    throw sourceError('archive_source_operation_range_not_dense',
      'Operation archive range does not cover its complete closed bounds.');
  }
}

function collectionIdFromScope(scope: string): string {
  const match = /^collection:([A-Za-z0-9][A-Za-z0-9._/-]{0,244})$/u.exec(scope);
  if (!match?.[1] || scope.length > 256) {
    throw sourceError('archive_source_scope_invalid',
      'Operation archive scope must be collection:<collectionId>.');
  }
  return match[1];
}

function assertPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError('archive_source_page_size_invalid');
  }
}

function dateOnly(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result)) {
    throw sourceError('archive_source_operation_binding_mismatch', 'Operation payload bucket is invalid.');
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseOperationEnvelope(value: string): Readonly<{
  payloadJson: Record<string, unknown>; syncWireJson: Record<string, unknown> | null;
}> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw sourceError('archive_source_operation_binding_mismatch',
      'Operation canonical payload envelope is invalid JSON.');
  }
  if (!isRecord(parsed) || Object.keys(parsed).sort().join(',') !== 'payloadJson,syncWireJson'
      || !isRecord(parsed.payloadJson)
      || !(parsed.syncWireJson === null || isRecord(parsed.syncWireJson))) {
    throw sourceError('archive_source_operation_binding_mismatch',
      'Operation canonical payload envelope schema is invalid.');
  }
  return parsed as { payloadJson: Record<string, unknown>; syncWireJson: Record<string, unknown> | null };
}

function sourceError(code: string, message: string): LedgerArchiveProductionSourceError {
  return new LedgerArchiveProductionSourceError(code, message);
}
