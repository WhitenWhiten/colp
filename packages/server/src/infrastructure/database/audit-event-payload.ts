import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { evaluateLedgerArchivePolicyFromLinear } from './ledger-archive-policy.js';
import type { DatabaseSchema } from './runtime.js';
import type { DatabaseTransaction } from './unit-of-work.js';

export const AUDIT_PAYLOAD_SCHEMA_VERSION = 1;

export interface AppendAuditEventInput {
  readonly operationId: string | null;
  readonly collectionId: string | null;
  readonly principalId: string | null;
  readonly eventType: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdAt?: Date;
}

export interface AuditPayloadKey {
  readonly createdAt: Date;
  readonly id: bigint;
}

export interface AuditHotPayloadRecord {
  readonly id: bigint;
  readonly createdAt: Date;
  readonly operationId: string | null;
  readonly collectionId: string | null;
  readonly principalId: string | null;
  readonly eventType: string;
  readonly payloadDigest: string;
  readonly payloadBytes: bigint;
  readonly payloadSchemaVersion: number;
  readonly payloadBucketLocator: string;
  readonly canonicalJson: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface AuditHotPayloadSource {
  /** Read only within a caller-sealed upper key; no moving "latest" page. */
  readClosedBatch(input: {
    readonly afterExclusive?: AuditPayloadKey;
    readonly throughInclusive: AuditPayloadKey;
    readonly limit: number;
  }): Promise<readonly AuditHotPayloadRecord[]>;
}

export interface AuditPayloadReader {
  read(eventId: bigint): Promise<AuditHotPayloadRecord>;
}

export interface AuditPayloadColdFacts {
  readonly eventId: bigint;
  readonly archiveSegmentId: string;
  readonly createdAt: Date;
  readonly operationId: string | null;
  readonly collectionId: string | null;
  readonly principalId: string | null;
  readonly eventType: string;
  readonly payloadDigest: string;
  readonly payloadBytes: bigint;
  readonly payloadSchemaVersion: number;
  readonly payloadBucketLocator: string;
}

/** A cold implementation must fail closed; callers never synthesize an empty audit payload. */
export interface AuditPayloadColdSource {
  read(facts: AuditPayloadColdFacts, signal?: AbortSignal): Promise<AuditHotPayloadRecord | null>;
}

export interface AuditPayloadArchiveCapability {
  /** Retains the header and atomically removes exactly one verified hot payload. */
  cutover(input: { readonly eventId: bigint; readonly archiveSegmentId: string }): Promise<void>;
  cutoverMany(input: { readonly eventIds: readonly bigint[]; readonly archiveSegmentId: string }): Promise<void>;
}

export type AuditPayloadArchiveErrorCode =
  | 'archive_not_ready'
  | 'binding_mismatch'
  | 'hot_unavailable';

export class AuditPayloadArchiveError extends Error {
  constructor(readonly code: AuditPayloadArchiveErrorCode, message: string) {
    super(message);
    this.name = 'AuditPayloadArchiveError';
  }
}

export type AuditPayloadReadErrorCode =
  | 'not_found'
  | 'archive_unavailable'
  | 'integrity_failure';

export class AuditPayloadReadError extends Error {
  constructor(readonly code: AuditPayloadReadErrorCode, message: string) {
    super(message);
    this.name = 'AuditPayloadReadError';
  }
}

interface AuditPayloadDatabaseRow {
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
  payload_archive_segment_id: string | null;
  canonical_json: string | null;
}

type AuditDatabase = Kysely<DatabaseSchema> | DatabaseTransaction;

/** Atomically inserts the immutable header and its hot payload in one SQL statement. */
export async function appendAuditEvent(
  transaction: DatabaseTransaction,
  input: AppendAuditEventInput,
): Promise<bigint> {
  if (!input.details || Array.isArray(input.details)) {
    throw new TypeError('audit details must be a JSON object');
  }
  const encoded = JSON.stringify(input.details);
  if (encoded === undefined) throw new TypeError('audit details must be JSON serializable');
  const createdAt = input.createdAt ?? sql<Date>`current_timestamp`;
  const result = await sql<{ id: string | bigint }>`
    WITH materialized AS (
      SELECT ${encoded}::jsonb AS details_json,
             nextval(pg_get_serial_sequence('audit_events', 'id')) AS event_id
    ), header AS (
      INSERT INTO audit_events(
        id, operation_id, collection_id, principal_id, event_type, created_at,
        payload_digest, payload_bytes, payload_schema_version,
        payload_bucket_locator, hot_payload_id
      )
      SELECT event_id, ${input.operationId}, ${input.collectionId}, ${input.principalId},
             ${input.eventType}, ${createdAt},
             'sha256:' || encode(public.digest(
               convert_to(details_json::text, 'UTF8'), 'sha256'
             ), 'hex'),
             octet_length(convert_to(details_json::text, 'UTF8')),
             ${AUDIT_PAYLOAD_SCHEMA_VERSION},
             'hot://audit_event_payloads/' || event_id::text,
             event_id
        FROM materialized
      RETURNING id, created_at
    )
    INSERT INTO audit_event_payloads(event_id, details_json, created_at)
    SELECT header.id, materialized.details_json, header.created_at
      FROM header CROSS JOIN materialized
    RETURNING event_id AS id
  `.execute(transaction);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('audit event insert returned no identity');
  return BigInt(id);
}

export function createPostgresAuditPayloadReader(
  database: AuditDatabase,
  coldSource?: AuditPayloadColdSource,
): AuditPayloadReader {
  return {
    async read(eventId) {
      const result = await sql<AuditPayloadDatabaseRow>`
        SELECT event.id, event.operation_id, event.collection_id, event.principal_id,
               event.event_type, event.created_at, event.payload_digest,
               event.payload_bytes, event.payload_schema_version,
               event.payload_bucket_locator, event.hot_payload_id,
               event.payload_archive_segment_id::text,
               payload.details_json::text AS canonical_json
          FROM audit_events event
          LEFT JOIN audit_event_payloads payload ON payload.event_id = event.hot_payload_id
         WHERE event.id = ${eventId}
      `.execute(database);
      const row = result.rows[0];
      if (!row) throw new AuditPayloadReadError('not_found', `audit event ${eventId} was not found`);
      if (row.hot_payload_id !== null) return parseAndVerify(row);
      if (row.payload_archive_segment_id === null) {
        throw new AuditPayloadReadError('integrity_failure', `audit event ${eventId} has no payload locator`);
      }
      if (!coldSource) {
        throw new AuditPayloadReadError(
          'archive_unavailable', `audit payload ${eventId} requires an archive reader`,
        );
      }
      const facts = coldFacts(row);
      let archived: AuditHotPayloadRecord | null;
      try { archived = await coldSource.read(facts); } catch (error) {
        if (error instanceof AuditPayloadReadError) throw error;
        throw new AuditPayloadReadError('archive_unavailable', `audit payload ${eventId} archive read failed`);
      }
      if (!archived) {
        throw new AuditPayloadReadError('archive_unavailable', `audit payload ${eventId} is absent from its archive`);
      }
      return verifyColdRecord(archived, facts);
    },
  };
}

export function createPostgresAuditHotPayloadSource(database: AuditDatabase): AuditHotPayloadSource {
  return {
    async readClosedBatch(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
        throw new RangeError('audit payload batch limit must be between 1 and 10000');
      }
      if (input.afterExclusive && compareKeys(input.afterExclusive, input.throughInclusive) >= 0) {
        return Object.freeze([]);
      }
      const afterCreatedAt = input.afterExclusive?.createdAt ?? new Date('0001-01-01T00:00:00.000Z');
      const afterId = input.afterExclusive?.id ?? -1n;
      const result = await sql<AuditPayloadDatabaseRow>`
        SELECT event.id, event.operation_id, event.collection_id, event.principal_id,
               event.event_type, event.created_at, event.payload_digest,
               event.payload_bytes, event.payload_schema_version,
               event.payload_bucket_locator, event.hot_payload_id,
               event.payload_archive_segment_id::text,
               payload.details_json::text AS canonical_json
          FROM audit_events event
          LEFT JOIN audit_event_payloads payload ON payload.event_id = event.hot_payload_id
         WHERE event.hot_payload_id IS NOT NULL
           AND (event.created_at, event.id) > (${afterCreatedAt}, ${afterId})
           AND (event.created_at, event.id) <= (
             ${input.throughInclusive.createdAt}, ${input.throughInclusive.id}
           )
         ORDER BY event.created_at, event.id
         LIMIT ${input.limit}
      `.execute(database);
      return Object.freeze(result.rows.map(parseAndVerify));
    },
  };
}

/**
 * The database independently requires session_user membership in the
 * non-login `known_audit_payload_archiver` role. Migrations never create or
 * grant that role. Production composition remains disabled until governance
 * provisions it after approving retention and legal-hold controls.
 */
export function createPostgresAuditPayloadArchiveCapability(
  transaction: DatabaseTransaction,
): AuditPayloadArchiveCapability {
  async function cutoverMany(input: { readonly eventIds: readonly bigint[]; readonly archiveSegmentId: string }): Promise<void> {
    if (input.eventIds.length === 0) return;
    if (input.eventIds.length > 10_000 || new Set(input.eventIds).size !== input.eventIds.length) {
      throw new TypeError('Audit cutover requires at most 10000 distinct event IDs');
    }
    const ids = input.eventIds.map(String);
      await sql`SELECT
        set_config('known.audit_payload_archive_capability', 'enabled', true),
        set_config(
          'known.audit_payload_archive_transaction', pg_current_xact_id()::text, true
        )
      `.execute(transaction);
      const segment = await sql<{
        state: string; ledger_family: string; source_relation: string; source_scope: string;
        contains_event: boolean; archive_object_uri: string; archive_schema_version: number;
        legal_hold: boolean; verified_evidence: boolean; reader_evidence: boolean;
      }>`
        SELECT state, ledger_family, source_relation, source_scope,
               NOT EXISTS (SELECT 1 FROM unnest(${ids}::bigint[]) AS requested(id)
                 WHERE NOT source_key_bounds @> requested.id) AS contains_event,
               archive_object_uri, archive_schema_version, legal_hold,
               stage_evidence ? 'verified' AS verified_evidence,
               stage_evidence ? 'reader_cutover' AS reader_evidence
          FROM ledger_archive_segments
         WHERE segment_id = ${input.archiveSegmentId}::uuid
         FOR UPDATE
      `.execute(transaction);
      const manifest = segment.rows[0];
      if (!manifest
          || !evaluateLedgerArchivePolicyFromLinear(manifest.state, manifest.legal_hold).canHydratePayload
          || !manifest.verified_evidence || !manifest.reader_evidence || manifest.legal_hold) {
        throw new AuditPayloadArchiveError(
          'archive_not_ready', `audit archive segment ${input.archiveSegmentId} is not ready`,
        );
      }
      if (manifest.ledger_family !== 'audit_payload'
          || manifest.source_relation !== 'public.audit_event_payloads'
          || manifest.source_scope !== 'global' || !manifest.contains_event
          || manifest.archive_schema_version !== AUDIT_PAYLOAD_SCHEMA_VERSION) {
        throw new AuditPayloadArchiveError(
          'binding_mismatch', `audit archive segment ${input.archiveSegmentId} does not bind every requested event`,
        );
      }
      const updated = await sql<{ id: string | bigint }>`
        UPDATE audit_events
           SET hot_payload_id = NULL,
               payload_archive_segment_id = ${input.archiveSegmentId}::uuid,
               payload_bucket_locator = 'archive://ledger-segment/' || ${input.archiveSegmentId}::text || '/audit-event/' || id::text
         WHERE id = ANY(${ids}::bigint[]) AND hot_payload_id = id
        RETURNING id
      `.execute(transaction);
      if (updated.rows.length !== ids.length) {
        throw new AuditPayloadArchiveError(
          'hot_unavailable', 'not every audit payload is available for hot cutover',
        );
      }
      const removed = await sql<{ event_id: string | bigint }>`
        DELETE FROM audit_event_payloads WHERE event_id = ANY(${ids}::bigint[]) RETURNING event_id
      `.execute(transaction);
      if (removed.rows.length !== ids.length) {
        throw new AuditPayloadArchiveError(
          'hot_unavailable', 'an audit payload disappeared during cutover',
        );
      }
  }
  return Object.freeze({
    cutoverMany,
    cutover: (input: { readonly eventId: bigint; readonly archiveSegmentId: string }) =>
      cutoverMany({ eventIds: [input.eventId], archiveSegmentId: input.archiveSegmentId }),
  });
}

function parseAndVerify(row: AuditPayloadDatabaseRow): AuditHotPayloadRecord {
  if (row.hot_payload_id === null) {
    throw new AuditPayloadReadError(
      'archive_unavailable',
      `audit payload ${row.id} is not present in hot storage (${row.payload_bucket_locator})`,
    );
  }
  if (row.canonical_json === null) {
    throw new AuditPayloadReadError(
      'integrity_failure',
      `audit payload ${row.id} is declared hot but missing`,
    );
  }
  const bytes = Buffer.byteLength(row.canonical_json, 'utf8');
  const digest = `sha256:${createHash('sha256').update(row.canonical_json, 'utf8').digest('hex')}`;
  if (BigInt(row.payload_bytes) !== BigInt(bytes) || row.payload_digest !== digest) {
    throw new AuditPayloadReadError('integrity_failure', `audit payload ${row.id} digest mismatch`);
  }
  const details = JSON.parse(row.canonical_json) as unknown;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new AuditPayloadReadError('integrity_failure', `audit payload ${row.id} is not an object`);
  }
  return Object.freeze({
    id: BigInt(row.id), createdAt: row.created_at,
    operationId: row.operation_id, collectionId: row.collection_id,
    principalId: row.principal_id, eventType: row.event_type,
    payloadDigest: row.payload_digest, payloadBytes: BigInt(row.payload_bytes),
    payloadSchemaVersion: row.payload_schema_version,
    payloadBucketLocator: row.payload_bucket_locator,
    canonicalJson: row.canonical_json,
    details: Object.freeze(details as Record<string, unknown>),
  });
}

function coldFacts(row: AuditPayloadDatabaseRow): AuditPayloadColdFacts {
  if (row.payload_archive_segment_id === null) {
    throw new AuditPayloadReadError('integrity_failure', `audit event ${row.id} has no archive segment`);
  }
  return Object.freeze({
    eventId: BigInt(row.id), archiveSegmentId: row.payload_archive_segment_id,
    createdAt: row.created_at, operationId: row.operation_id,
    collectionId: row.collection_id, principalId: row.principal_id,
    eventType: row.event_type, payloadDigest: row.payload_digest,
    payloadBytes: BigInt(row.payload_bytes), payloadSchemaVersion: row.payload_schema_version,
    payloadBucketLocator: row.payload_bucket_locator,
  });
}

function verifyColdRecord(
  record: AuditHotPayloadRecord,
  facts: AuditPayloadColdFacts,
): AuditHotPayloadRecord {
  const bytes = BigInt(Buffer.byteLength(record.canonicalJson, 'utf8'));
  const digest = `sha256:${createHash('sha256').update(record.canonicalJson, 'utf8').digest('hex')}`;
  let details: unknown;
  try { details = JSON.parse(record.canonicalJson); } catch {
    throw new AuditPayloadReadError('integrity_failure', `audit payload ${facts.eventId} JSON is invalid`);
  }
  if (record.id !== facts.eventId || record.createdAt.getTime() !== facts.createdAt.getTime()
      || record.operationId !== facts.operationId || record.collectionId !== facts.collectionId
      || record.principalId !== facts.principalId || record.eventType !== facts.eventType
      || record.payloadDigest !== facts.payloadDigest || record.payloadBytes !== facts.payloadBytes
      || record.payloadSchemaVersion !== facts.payloadSchemaVersion
      || record.payloadBucketLocator !== facts.payloadBucketLocator
      || bytes !== facts.payloadBytes || digest !== facts.payloadDigest
      || !details || typeof details !== 'object' || Array.isArray(details)) {
    throw new AuditPayloadReadError(
      'integrity_failure', `audit payload ${facts.eventId} archive binding mismatch`,
    );
  }
  return Object.freeze({ ...record, details: Object.freeze(details as Record<string, unknown>) });
}

function compareKeys(left: AuditPayloadKey, right: AuditPayloadKey): number {
  const time = left.createdAt.getTime() - right.createdAt.getTime();
  return time === 0 ? (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) : time;
}
