import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Operation } from '@know-n/colp/types';
import { sql } from 'kysely';
import { SYNC_PULL_STREAM_KIND_ORDER, SyncPullReadError,
  type SyncPullTuple } from '../../../modules/sync/index.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';

export interface SyncPullStreamRow {
  readonly commit_ordinal: bigint | string; readonly stream_kind: number;
  readonly stable_id: string; readonly payload: unknown; readonly effect: unknown;
  readonly effect_operation_id: string | null; readonly effect_collection_id: string | null;
  readonly effect_replica_id: string | null; readonly effect_sequence: bigint | string | null;
  readonly effect_commit_ordinal: bigint | string | null; readonly effect_protocol_version: string | null;
  readonly effect_terminal_status: string | null; readonly operation_digest: string | null;
  readonly effect_digest: string | null; readonly payload_source: 'hot' | 'archive' | null;
  readonly payload_locator: string | null; readonly payload_digest_sha256: string | null;
  readonly payload_bytes: bigint | string | null; readonly payload_schema_version: number | null;
  readonly payload_bucket: Date | string | null; readonly sync_wire_present: boolean | null;
  readonly actual_payload_digest: string | null; readonly actual_payload_bytes: bigint | string | null;
}

const validators = createValidatorRegistry();

/** Validate the projection already inserted atomically by the canonical writer. */
export async function persistSyncOperationProjection(
  transaction: DatabaseTransaction,
  operation: Operation,
): Promise<void> {
  if (!validators.validate('operation', operation).valid || typeof operation.collectionId !== 'string') {
    throw new SyncPullReadError('integrity_failure');
  }
  const persisted = await sql<{ sync_wire_json: Record<string, unknown> | null }>`
    SELECT payload.sync_wire_json FROM operations operation
    LEFT JOIN operation_payloads payload ON payload.operation_id=operation.operation_id
    WHERE operation.operation_id=${operation.opId} AND operation.collection_id=${operation.collectionId}
      AND operation.sync_wire_present`.execute(transaction);
  if (!persisted.rows[0]?.sync_wire_json
      || canonicalJson(persisted.rows[0].sync_wire_json) !== canonicalJson(operation)) {
    throw new SyncPullReadError('integrity_failure');
  }
}

export interface SyncPullStreamCut {
  readonly rows: readonly SyncPullStreamRow[];
  /**
   * Content revision captured with this statement's event upper bound.
   * It is the cut revision, not a head that commits afterwards.
   */
  readonly contentRevision: string;
  /** Inclusive commit-ordinal ceiling of the visible stream in that cut. Null when the stream is empty. */
  readonly upperCommitOrdinal: string | null;
}

interface SyncPullCutQueryRow extends SyncPullStreamRow {
  readonly cut_content_revision: string | null;
  readonly cut_upper_commit_ordinal: bigint | string | null;
}

/**
 * One statement reads the collection content revision and the stream ceiling,
 * then returns only events inside that cut. A later commit is a new head, not
 * part of this page.
 */
export async function readSyncPullStreamCut(
  transaction: DatabaseTransaction,
  collectionId: string,
  after: SyncPullTuple,
  limit: number,
): Promise<SyncPullStreamCut | null> {
  const streamKind = SYNC_PULL_STREAM_KIND_ORDER[after.streamKind];
  const result = await sql<SyncPullCutQueryRow>`
    WITH stream_cut AS MATERIALIZED (
      SELECT collection.content_revision AS content_revision,
        (
          SELECT MAX(bound.commit_ordinal) FROM (
            SELECT operation.commit_ordinal
            FROM operations AS operation
            WHERE operation.collection_id = ${collectionId} AND operation.sync_wire_present
              AND operation.operation_type <> 'sync.conflict.dismissed'
              AND NOT EXISTS (
                SELECT 1 FROM sync_conflicts AS operation_conflict
                WHERE operation_conflict.collection_id = operation.collection_id
                  AND operation_conflict.operation_id = operation.operation_id)
            UNION ALL
            SELECT conflict.commit_ordinal
            FROM sync_conflicts AS conflict
            WHERE conflict.collection_id = ${collectionId}
            UNION ALL
            SELECT resolution.commit_ordinal
            FROM operations AS resolution
            JOIN sync_conflicts AS conflict ON conflict.collection_id = resolution.collection_id
              AND conflict.resolved_by_operation_id = resolution.operation_id
            WHERE resolution.collection_id = ${collectionId}
              AND resolution.operation_type = 'sync.conflict.dismissed'
              AND conflict.status = 'resolved'
          ) AS bound
        ) AS upper_commit_ordinal
      FROM collections AS collection
      WHERE collection.id = ${collectionId}
    )
    SELECT visible_stream.*,
      stream_cut.content_revision AS cut_content_revision,
      stream_cut.upper_commit_ordinal AS cut_upper_commit_ordinal
    FROM stream_cut
    LEFT JOIN LATERAL (
      SELECT commit_ordinal, stream_kind, stable_id, payload, effect,
        effect_operation_id, effect_collection_id, effect_replica_id, effect_sequence,
        effect_commit_ordinal, effect_protocol_version, effect_terminal_status,
        operation_digest, effect_digest, payload_source, payload_locator,
        payload_digest_sha256, payload_bytes, payload_schema_version, payload_bucket,
        sync_wire_present, actual_payload_digest, actual_payload_bytes
      FROM (
        (SELECT operation.commit_ordinal, operation.sync_stream_kind AS stream_kind,
            operation.operation_id AS stable_id, payload.sync_wire_json AS payload,
            effect.effect_json AS effect, effect.operation_id AS effect_operation_id,
            effect.collection_id AS effect_collection_id, effect.origin_replica_id AS effect_replica_id,
            effect.origin_sequence AS effect_sequence, effect.commit_ordinal AS effect_commit_ordinal,
            effect.protocol_version AS effect_protocol_version,
            effect.terminal_status AS effect_terminal_status,
            effect.operation_digest, effect.effect_digest,
            operation.payload_source, operation.payload_locator, operation.payload_digest_sha256,
            operation.payload_bytes, operation.payload_schema_version,
            operation.payload_bucket::text AS payload_bucket,
            operation.sync_wire_present,
            operation_payload_sha256(payload.payload_json, payload.sync_wire_json) AS actual_payload_digest,
            octet_length(operation_payload_canonical_bytes(
              payload.payload_json, payload.sync_wire_json))::bigint AS actual_payload_bytes
          FROM operations AS operation
          LEFT JOIN operation_payloads AS payload ON payload.operation_id=operation.operation_id
          LEFT JOIN sync_operation_effects AS effect
            ON effect.collection_id=operation.collection_id AND effect.operation_id=operation.operation_id
          WHERE operation.collection_id = ${collectionId} AND operation.sync_wire_present
            -- Historical dismiss writers attached a delete wire without an effect.
            -- Its authoritative fact is the resolved Conflict below.
            AND operation.operation_type <> 'sync.conflict.dismissed'
            -- A conflicted Operation has a privacy-minimal Conflict stream row. Its
            -- original Base/Incoming wire must never be a protocol-version bypass.
            AND NOT EXISTS (
              SELECT 1 FROM sync_conflicts AS operation_conflict
              WHERE operation_conflict.collection_id = operation.collection_id
                AND operation_conflict.operation_id = operation.operation_id)
            AND operation.commit_ordinal <= stream_cut.upper_commit_ordinal
            AND (operation.commit_ordinal, operation.sync_stream_kind, operation.operation_id COLLATE "C") >
              (${BigInt(after.commitOrdinal)}::bigint, ${streamKind}::smallint,
               ${after.stableId}::text COLLATE "C")
          ORDER BY operation.commit_ordinal, stream_kind, operation.operation_id COLLATE "C"
          LIMIT ${limit + 1})
        UNION ALL
        (SELECT conflict.commit_ordinal, conflict.sync_stream_kind, conflict.conflict_id,
            conflict.pull_wire_json, NULL::jsonb, NULL::text, NULL::text, NULL::text,
            NULL::bigint, NULL::bigint, NULL::text, NULL::text, NULL::text, NULL::text,
            NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::integer, NULL::text,
            NULL::boolean, NULL::text, NULL::bigint
          FROM sync_conflicts AS conflict WHERE conflict.collection_id = ${collectionId}
            AND conflict.commit_ordinal <= stream_cut.upper_commit_ordinal
            AND (conflict.commit_ordinal, conflict.sync_stream_kind, conflict.conflict_id COLLATE "C") >
              (${BigInt(after.commitOrdinal)}::bigint, ${streamKind}::smallint,
               ${after.stableId}::text COLLATE "C")
          ORDER BY conflict.commit_ordinal, conflict.sync_stream_kind, conflict.conflict_id COLLATE "C"
          LIMIT ${limit + 1})
        UNION ALL
        (SELECT resolution.commit_ordinal, conflict.sync_stream_kind, conflict.conflict_id,
            conflict.resolution_result_json->'conflict', NULL::jsonb, NULL::text, NULL::text, NULL::text,
            NULL::bigint, NULL::bigint, NULL::text, NULL::text, NULL::text, NULL::text,
            NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::integer, NULL::text,
            NULL::boolean, NULL::text, NULL::bigint
          FROM operations AS resolution
          JOIN sync_conflicts AS conflict ON conflict.collection_id = resolution.collection_id
            AND conflict.resolved_by_operation_id = resolution.operation_id
          WHERE resolution.collection_id = ${collectionId}
            AND resolution.operation_type = 'sync.conflict.dismissed' AND conflict.status = 'resolved'
            AND resolution.commit_ordinal <= stream_cut.upper_commit_ordinal
            AND (resolution.commit_ordinal, conflict.sync_stream_kind, conflict.conflict_id COLLATE "C") >
              (${BigInt(after.commitOrdinal)}::bigint, ${streamKind}::smallint,
               ${after.stableId}::text COLLATE "C")
          ORDER BY resolution.commit_ordinal, conflict.sync_stream_kind, conflict.conflict_id COLLATE "C"
          LIMIT ${limit + 1})
      ) AS visible_stream ORDER BY commit_ordinal, stream_kind, stable_id COLLATE "C"
      LIMIT ${limit + 1}
    ) AS visible_stream ON true`.execute(transaction);
  return streamCutFromRows(result.rows);
}

/** Ordinary Pull reads hot history only. Missing or archived hot rows are integrity failures. */
export async function readSyncPullRows(
  transaction: DatabaseTransaction,
  collectionId: string,
  after: SyncPullTuple,
  limit: number,
): Promise<readonly SyncPullStreamRow[]> {
  return (await readSyncPullStreamCut(transaction, collectionId, after, limit))?.rows ?? [];
}

function streamCutFromRows(raw: readonly SyncPullCutQueryRow[]): SyncPullStreamCut | null {
  const first = raw[0];
  if (!first) return null;
  const contentRevision = first.cut_content_revision;
  if (typeof contentRevision !== 'string' || contentRevision.length < 1
      || raw.some((row) => row.cut_content_revision !== contentRevision)) {
    throw new SyncPullReadError('integrity_failure');
  }
  const upperRaw = first.cut_upper_commit_ordinal;
  const upperCommitOrdinal = upperRaw === null || upperRaw === undefined ? null : BigInt(upperRaw).toString();
  const rows = raw.flatMap((row) => {
    // The empty-stream left join yields one all-null event row so the cut revision is still returned.
    if (row.commit_ordinal === null || row.commit_ordinal === undefined
        || row.stable_id === null || row.stable_id === undefined) return [];
    if (upperCommitOrdinal === null || BigInt(row.commit_ordinal) > BigInt(upperCommitOrdinal)) {
      throw new SyncPullReadError('integrity_failure');
    }
    const stream: SyncPullStreamRow = {
      commit_ordinal: row.commit_ordinal, stream_kind: row.stream_kind, stable_id: row.stable_id,
      payload: row.payload, effect: row.effect, effect_operation_id: row.effect_operation_id,
      effect_collection_id: row.effect_collection_id, effect_replica_id: row.effect_replica_id,
      effect_sequence: row.effect_sequence, effect_commit_ordinal: row.effect_commit_ordinal,
      effect_protocol_version: row.effect_protocol_version, effect_terminal_status: row.effect_terminal_status,
      operation_digest: row.operation_digest, effect_digest: row.effect_digest,
      payload_source: row.payload_source, payload_locator: row.payload_locator,
      payload_digest_sha256: row.payload_digest_sha256, payload_bytes: row.payload_bytes,
      payload_schema_version: row.payload_schema_version, payload_bucket: row.payload_bucket,
      sync_wire_present: row.sync_wire_present, actual_payload_digest: row.actual_payload_digest,
      actual_payload_bytes: row.actual_payload_bytes,
    };
    return [resolveHotPullOperationRow(stream)];
  });
  return Object.freeze({ rows: Object.freeze(rows), contentRevision, upperCommitOrdinal });
}

export function resolveHotPullOperationRow(row: SyncPullStreamRow): SyncPullStreamRow {
  if (row.stream_kind !== SYNC_PULL_STREAM_KIND_ORDER.operation) return row;
  if (row.payload_source !== 'hot' || row.payload === null
      || row.actual_payload_digest !== row.payload_digest_sha256
      || row.actual_payload_bytes === null
      || BigInt(row.actual_payload_bytes) !== BigInt(row.payload_bytes ?? 0)) {
    throw new SyncPullReadError('integrity_failure');
  }
  return row;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
