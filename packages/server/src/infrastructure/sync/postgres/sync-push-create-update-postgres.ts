import { randomBytes } from 'node:crypto';
import type { Operation, SyncPushResult } from '@know-n/colp/types';
import { sql } from 'kysely';
import {
  createCanonicalMutationApplication,
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
} from '../../../modules/collections/index.js';
import {
  evaluateSyncNodeUpdate,
  isAllowedRecoveredParent,
  isSyncCreateFolderRoleUniqueLive,
  mapSyncNodeCreateOperation,
  SyncNodeCreateError,
  SyncNodeUpdateError,
  SyncPushHttpError,
} from '../../../modules/sync/index.js';
import { createPostgresCanonicalMutationPorts } from '../../collections/canonical-mutation-postgres-ports.js';
import { DatabaseOperationError } from '../../database/errors.js';
import {
  assertManagedAncestryWritable,
  loadLockedManagedAncestryChain,
  managedAncestryNodeFact,
  type ManagedAncestryCapabilities,
} from '../managed-ancestry-policy.js';
import { persistSyncOperationProjection } from './sync-pull-postgres.js';
import { persistAuthoritativeOperationEffect } from '../sync-operation-effects-postgres.js';
import { syncCanonicalMutationInput } from '../sync-canonical-mutation-input.js';
import {
  appendOpenSyncConflict,
  SyncConflictPersistenceError,
} from '../sync-conflict-postgres.js';
import {
  appliedPushResult,
  assertOperationIdClaimed,
  mapCanonicalCreateError,
  readSyncPlacementContext,
  terminalNodeIdRejection,
  trustedNodeRevision,
  type PushSequenceTransaction,
} from './sync-push-repository-postgres.js';
import type { PostgresSyncNodeCreateOptions } from './sync-push-types-postgres.js';

export async function evaluateCanonicalNodeCreate(
  operation: Operation,
  serverBatchId: string,
  transaction: PushSequenceTransaction,
  options: PostgresSyncNodeCreateOptions,
  managedAncestry: ManagedAncestryCapabilities,
) {
  let mapped;
  try {
    mapped = mapSyncNodeCreateOperation(operation, {
      managedBookmarkWrites: options.managedBookmarkWrites === true,
    });
  } catch (error) {
    if (error instanceof SyncNodeCreateError) throw new SyncPushHttpError(error.code);
    throw error;
  }
  const tx = transaction.databaseTransaction;
  const collection = await tx.selectFrom('collections').select(['id', 'root_node_id'])
    .where('id', '=', transaction.authority.collectionId).forUpdate().executeTakeFirst();
  if (!collection) throw new SyncPushHttpError('resource_not_found');
  if (mapped.folderRole && mapped.folderRole !== 'managed-bookmarks') {
    await assertCreateFolderRoleParent(tx, {
      collectionId: transaction.authority.collectionId,
      rootNodeId: collection.root_node_id,
      folderRole: mapped.folderRole,
      parentId: mapped.parentId,
    });
  }
  if (mapped.folderRole) {
    const existing = await lookupLiveUniqueFolderRole(
      tx, transaction.authority.collectionId, mapped.folderRole, mapped.parentId,
    );
    if (existing) {
      options.metrics?.increment('sync_mount_role_conflict_total');
      return rebasedFolderRoleResult(serverBatchId, operation, existing);
    }
  }
  const parentChain = await loadLockedManagedAncestryChain(
    transaction.databaseTransaction, transaction.authority.collectionId, mapped.parentId,
  );
  if (parentChain.some((fact) => fact.kind !== 'folder')) {
    throw new SyncPushHttpError('resource_not_found');
  }
  assertManagedAncestryWritable(parentChain, managedAncestry);
  const preresolvedPlacement = await readSyncPlacementContext(
    transaction,
    mapped.parentId,
    mapped.relativePosition,
  );
  const nodeId = (options.nodeId ?? (() => randomBytes(16).toString('base64url')))();
  const reservation = await transaction.idReservations.reserveAll([
    { id: nodeId, resourceType: 'node' },
  ]);
  if (reservation.state === 'conflict') {
    return terminalNodeIdRejection(operation, serverBatchId);
  }
  await options.faultInjector?.afterPhase?.('ledger');
  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(
    transaction.databaseTransaction,
    {
      operationIdClaimOwner: {
        async assertClaimed(tx, operationId) {
          await assertOperationIdClaimed(tx, operationId);
        },
      },
      resourceIdClaimOwner: {
        async assertClaimed(tx, resourceId, resourceType) {
          const claim = await tx.selectFrom('resource_id_ledger').select('resource_type')
            .where('resource_id', '=', resourceId).executeTakeFirst();
          if (claim?.resource_type !== resourceType) throw new SyncPushHttpError('internal_error');
        },
      },
      preresolvedPlacement,
      ...(options.reportSourceInvalidation === undefined
        ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
      faultInjector: {
        async afterPhase(context) {
          if (context.phase === 'resource' && context.resourceId === nodeId) {
            await options.faultInjector?.afterPhase?.('node');
          }
          if (context.phase === 'operation') {
            await options.faultInjector?.afterPhase?.('operation');
          }
        },
      },
    },
  ));
  let mutation;
  try {
    mutation = await canonical.execute({ transaction: transaction.databaseTransaction }, syncCanonicalMutationInput(
      operation, transaction.authority.accountId, {
        action: 'create',
        target: {
          collectionId: transaction.authority.collectionId,
          resourceId: nodeId,
          resourceKind: 'node',
        },
        parentId: mapped.parentId,
        ...(Object.keys(mapped.relativePosition).length === 0
          ? {} : { relativePosition: mapped.relativePosition }),
        fields: mapped.fields,
      },
    ));
  } catch (error) {
    if (mapped.folderRole
        && ((error instanceof DatabaseOperationError && error.kind === 'unique_violation')
          || isPostgresUniqueViolation(error))) {
      const existing = await lookupLiveUniqueFolderRole(
        transaction.databaseTransaction, transaction.authority.collectionId, mapped.folderRole, mapped.parentId,
      );
      if (existing) {
        options.metrics?.increment('sync_mount_role_conflict_total');
        return rebasedFolderRoleResult(serverBatchId, operation, existing);
      }
    }
    throw mapCanonicalCreateError(error);
  }
  await persistSyncOperationProjection(transaction.databaseTransaction, operation);
  const revision = mutation.allocation.resourceRevision;
  if (!revision) throw new SyncPushHttpError('internal_error');
  const cursor = `sync-create-${mutation.allocation.commitOrdinal}`;
  await persistAuthoritativeOperationEffect({
    transaction: transaction.databaseTransaction, operation,
    commitOrdinal: mutation.allocation.commitOrdinal, terminalStatus: 'applied', cursor,
    targetId: nodeId,
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  return appliedPushResult(serverBatchId, operation, 'applied', nodeId, revision, cursor);
}

export async function evaluateCanonicalNodeUpdate(
  operation: Operation,
  serverBatchId: string,
  sessionId: string,
  transaction: PushSequenceTransaction,
  options: PostgresSyncNodeCreateOptions,
  managedAncestry: ManagedAncestryCapabilities,
) {
  const tx = transaction.databaseTransaction;
  await tx.selectFrom('collections').select('id')
    .where('id', '=', transaction.authority.collectionId).forUpdate().executeTakeFirstOrThrow();
  const currentRow = await tx.selectFrom('nodes').select([
    'id', 'collection_id', 'parent_id', 'kind', 'is_root', 'resource_revision', 'deleted_at', 'payload_json',
    'payload_schema_version', 'payload_authority_status',
  ]).where('collection_id', '=', transaction.authority.collectionId)
    .where('id', '=', operation.targetId!).forUpdate().executeTakeFirst();
  if (!currentRow) throw new SyncPushHttpError('resource_not_found');
  const current = trustedNodeRevision({
    collectionId: currentRow.collection_id,
    resourceId: currentRow.id,
    revision: currentRow.resource_revision,
    kind: currentRow.kind,
    deleted: currentRow.deleted_at !== null,
    payload: currentRow.payload_json,
    schemaVersion: currentRow.payload_schema_version,
    authorityStatus: currentRow.payload_authority_status,
  });
  const baseRow = await tx.selectFrom('sync_node_revision_history').select([
    'collection_id', 'resource_id', 'revision', 'kind', 'payload_json',
  ]).where('collection_id', '=', transaction.authority.collectionId)
    .where('resource_id', '=', operation.targetId!)
    .where('revision', '=', operation.baseRevision!).executeTakeFirst();
  const trustedBase = baseRow ? trustedNodeRevision({
    collectionId: baseRow.collection_id,
    resourceId: baseRow.resource_id,
    revision: baseRow.revision,
    kind: baseRow.kind,
    deleted: baseRow.payload_json.deletedAt !== null
      && baseRow.payload_json.deletedAt !== undefined,
    payload: baseRow.payload_json,
    schemaVersion: RESOURCE_PAYLOAD_SCHEMA_VERSION,
    authorityStatus: 'backfilled',
  }) : undefined;
  await options.faultInjector?.afterPhase?.('current_history_loaded');

  // SYNC-R02: lock the closed target-to-root chain and reject managed-bookmarks
  // subtrees before evaluation or Conflict append can produce any side effect.
  const managedAncestryFacts = currentRow.parent_id === null
    ? []
    : await loadLockedManagedAncestryChain(tx, transaction.authority.collectionId, currentRow.parent_id);
  assertManagedAncestryWritable(
    [managedAncestryNodeFact(currentRow), ...managedAncestryFacts],
    managedAncestry,
  );

  let evaluation: ReturnType<typeof evaluateSyncNodeUpdate>;
  try {
    evaluation = evaluateSyncNodeUpdate(operation, trustedBase, current);
  } catch (error) {
    if (error instanceof SyncNodeUpdateError) throw new SyncPushHttpError(error.code);
    throw error;
  }
  if (evaluation.status === 'conflict') {
    let conflict;
    try {
      conflict = await appendOpenSyncConflict({
        transaction,
        sessionId,
        operation,
        code: evaluation.code,
        conflictingFields: evaluation.fields,
        ...(trustedBase ? { trustedBase } : {}),
        current,
        ...(options.conflictPayloadEncryption
          ? { conflictPayloadEncryption: options.conflictPayloadEncryption } : {}),
        ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
      });
    } catch (error) {
      if (error instanceof SyncConflictPersistenceError) {
        throw new SyncPushHttpError(error.code === 'payload_too_large' ? 'payload_too_large'
          : error.code === 'invalid_document' ? 'invalid_document' : 'internal_error');
      }
      throw error;
    }
    const result: SyncPushResult = {
      batchId: serverBatchId,
      results: [{
        opId: operation.opId,
        sequence: operation.sequence,
        status: 'conflicted' as const,
        targetId: operation.targetId,
        cursor: conflict.cursor,
        conflictId: conflict.conflictId,
        warnings: [],
      }],
      serverCursor: conflict.cursor,
    };
    return Object.freeze({ status: 'conflicted' as const, result });
  }
  const mergedEvaluation = evaluation;

  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(
    tx,
    {
      operationIdClaimOwner: {
        async assertClaimed(claimTx, operationId) {
          await assertOperationIdClaimed(claimTx, operationId);
        },
      },
      ...(options.reportSourceInvalidation === undefined
        ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
      faultInjector: {
        async afterPhase(context) {
          if (context.phase === 'resource' && context.resourceId === mergedEvaluation.targetId) {
            await options.faultInjector?.afterPhase?.('node');
          }
          if (context.phase === 'operation') {
            await options.faultInjector?.afterPhase?.('operation');
          }
        },
      },
    },
  ));
  let mutation;
  try {
    mutation = await canonical.execute({ transaction: tx }, syncCanonicalMutationInput(
      operation, transaction.authority.accountId, {
        action: 'update',
        target: {
          collectionId: transaction.authority.collectionId,
          resourceId: mergedEvaluation.targetId,
          resourceKind: 'node',
        },
        parentId: null,
        expectedResourceRevision: mergedEvaluation.expectedCurrentRevision,
        fields: mergedEvaluation.fields,
        trustedFacts: { replaceExtensions: true },
      },
    ));
  } catch (error) {
    throw mapCanonicalCreateError(error);
  }
  await persistSyncOperationProjection(tx, operation);
  const revision = mutation.allocation.resourceRevision;
  if (!revision) throw new SyncPushHttpError('internal_error');
  const cursor = `sync-update-${mutation.allocation.commitOrdinal}`;
  await persistAuthoritativeOperationEffect({
    transaction: tx, operation, commitOrdinal: mutation.allocation.commitOrdinal,
    terminalStatus: mergedEvaluation.resultStatus, cursor,
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  return appliedPushResult(
    serverBatchId, operation, mergedEvaluation.resultStatus,
    mergedEvaluation.targetId, revision, cursor, [], mergedEvaluation.merged,
  );
}

async function assertCreateFolderRoleParent(
  tx: PushSequenceTransaction['databaseTransaction'],
  input: {
    readonly collectionId: string; readonly rootNodeId: string;
    readonly folderRole: string; readonly parentId: string;
  },
): Promise<void> {
  const parent = await tx.selectFrom('nodes').select(['id', 'is_root', 'kind', 'deleted_at', 'payload_json'])
    .where('collection_id', '=', input.collectionId).where('id', '=', input.parentId).executeTakeFirst();
  if (!parent || parent.deleted_at !== null) throw new SyncPushHttpError('resource_not_found');
  const folderRole = typeof parent.payload_json?.folderRole === 'string' ? parent.payload_json.folderRole : null;
  if (input.folderRole === 'recovered') {
    if (!isAllowedRecoveredParent({ isRoot: parent.is_root, nodeKind: parent.kind, folderRole })) {
      throw new SyncPushHttpError('invalid_document');
    }
    return;
  }
  if (input.parentId !== input.rootNodeId) throw new SyncPushHttpError('invalid_document');
}

function rebasedFolderRoleResult(
  serverBatchId: string,
  operation: Operation,
  existing: { readonly id: string; readonly resource_revision: string },
) {
  return appliedPushResult(
    serverBatchId, operation, 'rebased', existing.id, existing.resource_revision, 'sync-unchanged',
    [{ code: 'invalid_node_constraints', message: 'A live Folder with this folderRole already exists.' }],
  );
}

export async function lookupLiveUniqueFolderRole(
  tx: PushSequenceTransaction['databaseTransaction'],
  collectionId: string,
  folderRole: string,
  parentId: string,
): Promise<{ readonly id: string; readonly resource_revision: string } | undefined> {
  if (folderRole === 'recovered') return lookupLiveRecovered(tx, collectionId, parentId);
  if (isSyncCreateFolderRoleUniqueLive(folderRole)) return lookupLiveSpecialRole(tx, collectionId, folderRole);
  return undefined;
}

export async function lookupLiveRecovered(
  tx: PushSequenceTransaction['databaseTransaction'],
  collectionId: string,
  parentId: string,
): Promise<{ readonly id: string; readonly resource_revision: string } | undefined> {
  const result = await sql<{ id: string; resource_revision: string }>`
    SELECT id, resource_revision FROM nodes
     WHERE collection_id = ${collectionId}
       AND parent_id = ${parentId}
       AND folder_role = 'recovered'
       AND deleted_at IS NULL
     FOR UPDATE
  `.execute(tx);
  return result.rows[0];
}

async function lookupLiveSpecialRole(
  tx: PushSequenceTransaction['databaseTransaction'],
  collectionId: string,
  folderRole: string,
): Promise<{ readonly id: string; readonly resource_revision: string } | undefined> {
  const result = await sql<{ id: string; resource_revision: string }>`
    SELECT id, resource_revision FROM nodes
     WHERE collection_id = ${collectionId}
       AND folder_role = ${folderRole}
       AND deleted_at IS NULL
     FOR UPDATE
  `.execute(tx);
  return result.rows[0];
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === '23505';
}
