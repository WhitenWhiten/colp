import { sql } from 'kysely';
import type { Operation, SyncPushResult } from '@know-n/colp/types';
import {
  CanonicalMutationInvariantError,
  CollectionsError,
  NODE_DELETION_PURGE_RETENTION_MS,
  NodeConflictError,
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  validateResourcePayload,
} from '../../../modules/collections/index.js';
import { SyncPushHttpError } from '../../../modules/sync/index.js';
import { readBoundedPlacementContext } from '../../collections/postgres-sibling-placement-read.js';
import type { PostgresSyncSequenceTransaction } from '../sync-sequence-postgres.js';

export type PushSequenceTransaction = PostgresSyncSequenceTransaction<SyncPushResult>;
export type PushDatabaseTransaction = PushSequenceTransaction['databaseTransaction'];

export async function loadCanonicalAncestorPath(
  tx: PushDatabaseTransaction,
  collectionId: string,
  startId: string,
) {
  const result = await sql<{
    id: string; parent_id: string | null; is_root: boolean; payload_json: Record<string, unknown> | null;
  }>`
    with recursive ancestry(id, parent_id, is_root, payload_json, depth, path) as (
      select id, parent_id, is_root, payload_json, 0, array[id]
      from nodes where collection_id = ${collectionId} and id = ${startId} and deleted_at is null
      union all
      select parent.id, parent.parent_id, parent.is_root, parent.payload_json,
        child.depth + 1, child.path || parent.id
      from ancestry child
      join nodes parent on parent.collection_id = ${collectionId} and parent.id = child.parent_id
      where child.depth < 255 and parent.deleted_at is null and not parent.id = any(child.path)
    )
    select id, parent_id, is_root, payload_json from ancestry order by depth
  `.execute(tx);
  return result.rows;
}

export function resolveTombstoneRetentionMs(seconds: number | undefined): number {
  if (seconds === undefined) return NODE_DELETION_PURGE_RETENTION_MS;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    throw new TypeError('Sync tombstone retention seconds are invalid.');
  }
  return Math.max(seconds * 1_000, NODE_DELETION_PURGE_RETENTION_MS);
}

export function mapCanonicalMoveError(error: unknown): SyncPushHttpError {
  if (error instanceof SyncPushHttpError) return error;
  if (error instanceof CollectionsError && error.code === 'invalid_node_anchor') {
    return new SyncPushHttpError('position_context_stale');
  }
  if (error instanceof CanonicalMutationInvariantError || error instanceof CollectionsError) {
    const mapped = new SyncPushHttpError('invalid_document');
    mapped.cause = error;
    return mapped;
  }
  throw error;
}

export function mapCanonicalCreateError(error: unknown): SyncPushHttpError {
  if (error instanceof SyncPushHttpError) return error;
  if (error instanceof CanonicalMutationInvariantError || error instanceof CollectionsError) {
    return new SyncPushHttpError('invalid_document', undefined, undefined, { cause: error });
  }
  throw error;
}

export function terminalNodeIdRejection(operation: Operation, serverBatchId: string) {
  const result: SyncPushResult = {
    batchId: serverBatchId,
    results: [{
      opId: operation.opId,
      sequence: operation.sequence,
      status: 'rejected' as const,
      code: 'resource_id_unavailable',
      warnings: [],
    }],
    serverCursor: 'sync-unchanged',
  };
  return Object.freeze({ status: 'rejected' as const, result });
}

export async function readSyncPlacementContext(
  transaction: PushSequenceTransaction,
  parentId: string,
  relativePosition: Readonly<{ readonly afterId?: string; readonly beforeId?: string }>,
  excludeNodeId?: string,
) {
  try {
    const bounded = await readBoundedPlacementContext(transaction.databaseTransaction, {
      collectionId: transaction.authority.collectionId,
      parentId,
      excludeNodeId,
      afterId: relativePosition.afterId,
      beforeId: relativePosition.beforeId,
      forUpdate: true,
    });
    return { siblings: bounded.siblings };
  } catch (error) {
    if (error instanceof NodeConflictError && error.code === 'position_context_stale') {
      throw new SyncPushHttpError('position_context_stale');
    }
    throw error;
  }
}

export function trustedNodeRevision(input: {
  readonly collectionId: string;
  readonly resourceId: string;
  readonly revision: string;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly deleted: boolean;
  readonly payload: Record<string, unknown> | null;
  readonly schemaVersion: number | null;
  readonly authorityStatus: string | null;
}) {
  const validated = validateResourcePayload('node', input.payload);
  if (!input.payload || !validated.ok || input.schemaVersion !== RESOURCE_PAYLOAD_SCHEMA_VERSION
      || input.authorityStatus !== 'backfilled'
      || input.payload.resourceType !== 'node'
      || input.payload.collectionId !== input.collectionId
      || input.payload.id !== input.resourceId
      || input.payload.resourceRevision !== input.revision
      || input.payload.kind !== input.kind) {
    throw new SyncPushHttpError('internal_error');
  }
  return Object.freeze({
    collectionId: input.collectionId,
    resourceId: input.resourceId,
    revision: input.revision,
    kind: input.kind,
    deleted: input.deleted,
    payload: Object.freeze(input.payload),
  });
}

export async function assertOperationIdClaimed(
  tx: PushDatabaseTransaction,
  operationId: string,
): Promise<void> {
  const claim = await tx.selectFrom('sync_sequence_operation_claims').select('operation_id')
    .where('operation_id', '=', operationId).executeTakeFirst();
  if (!claim) throw new SyncPushHttpError('internal_error');
}

export function appliedPushResult(
  serverBatchId: string,
  operation: Operation,
  status: 'applied' | 'rebased',
  targetId: string,
  revision: string,
  cursor: string,
  warnings: readonly { readonly code: string; readonly message: string }[] = [],
  transform?: Readonly<Record<string, unknown>>,
): { readonly status: 'applied' | 'rebased'; readonly result: SyncPushResult } {
  const result: SyncPushResult = {
    batchId: serverBatchId,
    results: [{
      opId: operation.opId,
      sequence: operation.sequence,
      status,
      targetId,
      revision,
      cursor,
      ...(transform === undefined ? {} : { transform: { ...transform } }),
      warnings: [...warnings],
    }],
    serverCursor: cursor,
  };
  return Object.freeze({ status, result });
}
