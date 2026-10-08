import { sql } from 'kysely';
import {
  CanonicalMutationInvariantError,
  NODE_DELETION_PURGE_RETENTION_MS,
  formatUtcDateTime,
  type JsonObject,
} from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/**
 * Sidecar (Annotation/Relation) subtree-delete cascade batches.
 *
 * Each sidecar type is tombstoned with ONE batched
 * `UPDATE ... FROM jsonb_to_recordset(...) ... RETURNING` per chunk. The
 * returned set is validated against a Map of expected exact (id, revision)
 * pairs, so any missing or stale row is a fail-closed invariant that rolls
 * back the whole enclosing transaction.
 *
 * The chunk size ties to the Node payload materialization batch
 * (`DELETE_SUBTREE_WRITE_BATCH_SIZE` = 128 in the canonical ports) so payload
 * JSON for sidecars is also materialized in bounded chunks rather than all at
 * once.
 */
export const DELETE_SIDECAR_CASCADE_BATCH_SIZE = 128;

function invariant(message: string, authority = false): never {
  throw new CanonicalMutationInvariantError(
    authority ? 'resource_field_authority_violation' : 'invalid_canonical_mutation',
    message,
  );
}

export interface SubtreeSidecarBatchFaultContext {
  readonly resourceId: string;
  readonly resourceIndex: number;
  readonly resourceCount: number;
  readonly transaction: DatabaseTransaction;
}

export type SubtreeSidecarBatchFaultHook = (
  context: SubtreeSidecarBatchFaultContext,
) => void | Promise<void>;

export interface AnnotationCascadeBatchRow {
  readonly id: string;
  readonly collection_id: string;
  readonly subject_type: 'collection' | 'node';
  readonly subject_id: string;
  readonly visibility: 'public' | 'unlisted' | 'protected' | 'private';
  readonly resource_revision: string;
  readonly revision?: string;
  readonly payload_json: Record<string, unknown>;
  deletedAt?: Date;
}

export interface RelationCascadeBatchRow {
  readonly id: string;
  readonly collection_id: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly visibility: 'public' | 'unlisted' | 'protected' | 'private';
  readonly resource_revision: string;
  readonly revision?: string;
  readonly payload_json: Record<string, unknown>;
  deletedAt?: Date;
}

export interface CascadeDeleteBatchInput<T> {
  readonly rows: readonly T[];
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly operationId: string;
  readonly now: Date;
  readonly afterPhase?: SubtreeSidecarBatchFaultHook;
}

interface AnnotationReturnedRow {
  id: string;
  collection_id: string;
  subject_type: 'collection' | 'node';
  subject_id: string;
  visibility: 'public' | 'unlisted' | 'protected' | 'private';
  resource_revision: string;
  deleted_at: Date | null;
  deleted_commit_ordinal: bigint | string | null;
  payload_json: JsonObject | null;
}

interface RelationReturnedRow {
  id: string;
  collection_id: string;
  from_node_id: string;
  to_node_id: string;
  visibility: 'public' | 'unlisted' | 'protected' | 'private';
  resource_revision: string;
  deleted_at: Date | null;
  updated_at: Date | null;
  deleted_commit_ordinal: bigint | string | null;
  payload_json: JsonObject | null;
}

interface AnnotationUpdateInput {
  id: string;
  current_revision: string;
  resource_revision: string;
  payload_json: JsonObject;
}

interface RelationUpdateInput {
  id: string;
  current_revision: string;
  resource_revision: string;
  payload_json: JsonObject;
}

/**
 * Tombstones Annotation cascades in bounded `UPDATE ... RETURNING` batches.
 * The annotation `deleted_at` keeps millisecond precision (matching the
 * current per-row write) while the payload `deletedAt` is the canonical
 * second-truncated `formatUtcDateTime` string.
 */
export async function cascadeDeleteAnnotations(
  tx: DatabaseTransaction,
  input: CascadeDeleteBatchInput<AnnotationCascadeBatchRow>,
): Promise<void> {
  const { rows, collectionId, commitOrdinal, operationId, now, afterPhase } = input;
  const purgeAfter = formatUtcDateTime(new Date(now.getTime() + NODE_DELETION_PURGE_RETENTION_MS));
  for (let offset = 0; offset < rows.length; offset += DELETE_SIDECAR_CASCADE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + DELETE_SIDECAR_CASCADE_BATCH_SIZE);
    const inputs: AnnotationUpdateInput[] = batch.map((sidecar) => {
      if (!sidecar.revision) invariant(`cascade Annotation revision is missing for ${sidecar.id}`);
      return {
        id: sidecar.id,
        current_revision: sidecar.resource_revision,
        resource_revision: sidecar.revision,
        payload_json: {
          ...sidecar.payload_json,
          revision: sidecar.revision,
          updatedAt: formatUtcDateTime(now),
          deletedAt: formatUtcDateTime(now),
          deletedCommitOrdinal: commitOrdinal.toString(),
          deletionOperationId: operationId,
          purgeAfter,
        } as JsonObject,
      };
    });
    const result = await sql<AnnotationReturnedRow>`
      update annotations as a
      set resource_revision = input.resource_revision,
          updated_at = ${now},
          deleted_at = ${now},
          deleted_commit_ordinal = ${commitOrdinal},
          payload_json = input.payload_json
      from jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb)
        as input(id text, current_revision text, resource_revision text, payload_json jsonb)
      where a.collection_id = ${collectionId}
        and a.id = input.id
        and a.resource_revision = input.current_revision
        and a.deleted_at is null
      returning a.*
    `.execute(tx);
    if (result.rows.length !== batch.length) {
      invariant(`Annotation cascade batch updated ${result.rows.length} rows instead of ${batch.length}`);
    }
    const returnedById = new Map(result.rows.map((row) => [row.id, row] as const));
    for (const sidecar of batch) {
      const returned = returnedById.get(sidecar.id);
      const readBackPayload = returned?.payload_json;
      if (!returned || !readBackPayload || returned.collection_id !== sidecar.collection_id
        || returned.subject_type !== sidecar.subject_type || returned.subject_id !== sidecar.subject_id
        || returned.visibility !== sidecar.visibility || returned.resource_revision !== sidecar.revision
        || !(returned.deleted_at instanceof Date)
        || returned.deleted_at.getTime() !== now.getTime()
        || BigInt(returned.deleted_commit_ordinal ?? 0) !== commitOrdinal
        || readBackPayload.revision !== sidecar.revision
        || readBackPayload.deletedAt !== formatUtcDateTime(now)
        || readBackPayload.deletedCommitOrdinal !== commitOrdinal.toString()
        || readBackPayload.deletionOperationId !== operationId) {
        invariant(`cascade Annotation read-back mismatch for ${sidecar.id}`, true);
      }
    }
    const lastIndex = offset + batch.length - 1;
    await afterPhase?.({
      resourceId: batch[batch.length - 1]!.id,
      resourceIndex: lastIndex,
      resourceCount: rows.length,
      transaction: tx,
    });
  }
}

/**
 * Tombstones Relation cascades in bounded `UPDATE ... RETURNING` batches.
 * Relation `deleted_at`/`updated_at`/payload `deletedAt`/`updatedAt` are all
 * second-truncated, matching the current per-row write semantics.
 */
export async function cascadeDeleteRelations(
  tx: DatabaseTransaction,
  input: CascadeDeleteBatchInput<RelationCascadeBatchRow>,
): Promise<void> {
  const { rows, collectionId, commitOrdinal, operationId, now, afterPhase } = input;
  const deletedAt = new Date(formatUtcDateTime(now));
  const purgeAfter = formatUtcDateTime(new Date(now.getTime() + NODE_DELETION_PURGE_RETENTION_MS));
  for (let offset = 0; offset < rows.length; offset += DELETE_SIDECAR_CASCADE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + DELETE_SIDECAR_CASCADE_BATCH_SIZE);
    const inputs: RelationUpdateInput[] = batch.map((relation) => {
      if (!relation.revision) invariant(`cascade Relation revision is missing for ${relation.id}`);
      return {
        id: relation.id,
        current_revision: relation.resource_revision,
        resource_revision: relation.revision,
        payload_json: {
          ...relation.payload_json,
          revision: relation.revision,
          updatedAt: formatUtcDateTime(deletedAt),
          deletedAt: formatUtcDateTime(deletedAt),
          deletedCommitOrdinal: commitOrdinal.toString(),
          deletionOperationId: operationId,
          purgeAfter,
        } as JsonObject,
      };
    });
    const result = await sql<RelationReturnedRow>`
      update relations as r
      set resource_revision = input.resource_revision,
          updated_at = ${deletedAt},
          deleted_at = ${deletedAt},
          deleted_commit_ordinal = ${commitOrdinal},
          payload_json = input.payload_json
      from jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb)
        as input(id text, current_revision text, resource_revision text, payload_json jsonb)
      where r.collection_id = ${collectionId}
        and r.id = input.id
        and r.resource_revision = input.current_revision
        and r.deleted_at is null
      returning r.*
    `.execute(tx);
    if (result.rows.length !== batch.length) {
      invariant(`Relation cascade batch updated ${result.rows.length} rows instead of ${batch.length}`);
    }
    const returnedById = new Map(result.rows.map((row) => [row.id, row] as const));
    for (const relation of batch) {
      const returned = returnedById.get(relation.id);
      const readBackPayload = returned?.payload_json;
      if (!returned || !readBackPayload || returned.collection_id !== relation.collection_id
        || returned.from_node_id !== relation.from_node_id || returned.to_node_id !== relation.to_node_id
        || returned.visibility !== relation.visibility || returned.resource_revision !== relation.revision
        || !(returned.deleted_at instanceof Date)
        || returned.deleted_at.getTime() !== deletedAt.getTime()
        || !(returned.updated_at instanceof Date)
        || returned.updated_at.getTime() !== deletedAt.getTime()
        || BigInt(returned.deleted_commit_ordinal ?? 0) !== commitOrdinal
        || readBackPayload.revision !== relation.revision
        || readBackPayload.deletedAt !== formatUtcDateTime(deletedAt)
        || readBackPayload.deletedCommitOrdinal !== commitOrdinal.toString()
        || readBackPayload.deletionOperationId !== operationId) {
        invariant(`cascade Relation read-back mismatch for ${relation.id}`, true);
      }
    }
    const lastIndex = offset + batch.length - 1;
    await afterPhase?.({
      resourceId: batch[batch.length - 1]!.id,
      resourceIndex: lastIndex,
      resourceCount: rows.length,
      transaction: tx,
    });
  }
}
