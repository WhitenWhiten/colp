import { sql } from 'kysely';
import type { DatabaseTransaction } from './unit-of-work.js';
import type {
  HistoricalOperationPayloadPort,
  OperationPayloadDocument,
  OperationPayloadFacts,
} from './operation-payload-tables.js';

export type OperationPayloadReadErrorCode =
  | 'operation_payload_unavailable'
  | 'operation_payload_integrity_failure';

export class OperationPayloadReadError extends Error {
  readonly code: OperationPayloadReadErrorCode;

  constructor(code: OperationPayloadReadErrorCode) {
    super(code);
    this.name = 'OperationPayloadReadError';
    this.code = code;
  }
}
export interface AppendOperationWithPayloadInput {
  readonly operationId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly operationType: string;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  readonly syncWireJson?: Readonly<Record<string, unknown>> | null;
  readonly actorPrincipalId: string | null;
  readonly createdAt?: Date;
}

/** The sole production insert primitive: fact, payload, and durable lookups are one SQL statement. */
export async function appendOperationWithPayload(
  transaction: DatabaseTransaction,
  input: AppendOperationWithPayloadInput,
): Promise<void> {
  const payloadJson = JSON.stringify(input.payloadJson);
  const syncWireJson = input.syncWireJson == null ? null : JSON.stringify(input.syncWireJson);
  await sql`WITH supplied AS (
      SELECT ${input.operationId}::text AS operation_id,
        ${input.collectionId}::text AS collection_id,
        ${input.commitOrdinal}::bigint AS commit_ordinal,
        ${input.operationType}::text AS operation_type,
        ${payloadJson}::jsonb AS payload_json,
        ${syncWireJson}::jsonb AS sync_wire_json,
        ${input.actorPrincipalId}::text AS actor_principal_id,
        coalesce(${input.createdAt ?? null}::timestamptz, current_timestamp) AS created_at
    ), materialized AS (
      SELECT supplied.*,
        date_trunc('month', created_at AT TIME ZONE 'UTC')::date AS payload_bucket,
        operation_payload_sha256(payload_json, sync_wire_json) AS digest,
        octet_length(operation_payload_canonical_bytes(payload_json, sync_wire_json))::bigint AS bytes
      FROM supplied
    ), inserted_fact AS (
      INSERT INTO operations (
        operation_id, collection_id, commit_ordinal, operation_type, actor_principal_id, created_at,
        payload_source, payload_locator, payload_digest_sha256, payload_bytes,
        payload_schema_version, payload_bucket, sync_wire_present
      ) SELECT operation_id, collection_id, commit_ordinal, operation_type, actor_principal_id, created_at,
        'hot', 'operation_payloads/' || payload_bucket::text || '/' || operation_id,
        digest, bytes, 1, payload_bucket, sync_wire_json IS NOT NULL
      FROM materialized RETURNING operation_id
    ), inserted_payload AS (
    INSERT INTO operation_payloads (
      operation_id, collection_id, commit_ordinal, payload_bucket, payload_schema_version,
      payload_json, sync_wire_json, canonical_digest_sha256, canonical_bytes, created_at
    ) SELECT materialized.operation_id, collection_id, commit_ordinal, payload_bucket, 1,
        payload_json, sync_wire_json, digest, bytes, created_at
      FROM materialized JOIN inserted_fact USING (operation_id)
      RETURNING operation_id
    )
    INSERT INTO operation_lookup_facts (
      operation_id, collection_id, commit_ordinal, operation_type,
      command_id, attachment_id, blob_id
    ) SELECT materialized.operation_id, collection_id, commit_ordinal, operation_type,
        operation_lookup_fact_text(payload_json, 'commandId', false),
        operation_lookup_fact_text(payload_json, 'attachmentId', true),
        operation_lookup_fact_text(payload_json, 'blobId', true)
      FROM materialized
      JOIN inserted_fact USING (operation_id)
      JOIN inserted_payload USING (operation_id)
      WHERE operation_type IN ('attachment.finalized', 'attachment.retired')`.execute(transaction);
}

interface HotPayloadRow {
  payload_json: Record<string, unknown> | null;
  sync_wire_json: Record<string, unknown> | null;
  actual_digest: string | null;
  actual_bytes: bigint | string | null;
}

/** Resolve one payload without ever converting absence into an empty document. */
export async function readOperationPayload(
  transaction: DatabaseTransaction,
  facts: OperationPayloadFacts,
  historicalSource?: HistoricalOperationPayloadPort,
): Promise<OperationPayloadDocument> {
  if (facts.source === 'archive') {
    const archived = await historicalSource?.read(facts);
    if (!archived) throw new OperationPayloadReadError('operation_payload_unavailable');
    assertDocumentMatchesFacts(archived, facts);
    return archived;
  }
  const result = await sql<HotPayloadRow>`SELECT payload.payload_json, payload.sync_wire_json,
      operation_payload_sha256(payload.payload_json, payload.sync_wire_json) AS actual_digest,
      octet_length(operation_payload_canonical_bytes(
        payload.payload_json, payload.sync_wire_json))::bigint AS actual_bytes
    FROM operation_payloads payload
    WHERE payload.operation_id=${facts.operationId}
      AND payload.collection_id=${facts.collectionId}
      AND payload.commit_ordinal=${facts.commitOrdinal}`.execute(transaction);
  const row = result.rows[0];
  if (!row) throw new OperationPayloadReadError('operation_payload_unavailable');
  if (row.payload_json === null || row.actual_digest === null || row.actual_bytes === null) {
    throw new OperationPayloadReadError('operation_payload_integrity_failure');
  }
  const document: OperationPayloadDocument = Object.freeze({
    payloadJson: Object.freeze(row.payload_json),
    syncWireJson: row.sync_wire_json === null ? null : Object.freeze(row.sync_wire_json),
    digestSha256: row.actual_digest,
    byteCount: BigInt(row.actual_bytes),
    schemaVersion: 1,
  });
  assertDocumentMatchesFacts(document, facts);
  return document;
}

function assertDocumentMatchesFacts(
  document: OperationPayloadDocument,
  facts: OperationPayloadFacts,
): void {
  if (document.digestSha256 !== facts.digestSha256
      || document.byteCount !== facts.byteCount
      || document.schemaVersion !== facts.schemaVersion
      || (document.syncWireJson !== null) !== facts.syncWirePresent) {
    throw new OperationPayloadReadError('operation_payload_integrity_failure');
  }
}
