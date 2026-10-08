import { sql } from 'kysely';
import type { Operation } from '@know-n/colp/types';
import { SUBTREE_OBSERVATION_EXTENSION, subtreeDeleteSource } from '@know-n/colp/sync';
import {
  createCanonicalMutationApplication,
  type JsonObject,
} from '../../../modules/collections/index.js';
import {
  evaluateSyncNodeDelete,
  evaluateSyncNodeMove,
  isAllowedRecoveredParent,
  SyncNodeDeleteError,
  SyncNodeMoveError,
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
  createPostgresSyncNodeTombstonePort,
  SyncNodeTombstonePersistenceError,
} from '../sync-node-tombstone-postgres.js';
import {
  appliedPushResult,
  assertOperationIdClaimed,
  loadCanonicalAncestorPath,
  mapCanonicalCreateError,
  mapCanonicalMoveError,
  readSyncPlacementContext,
  resolveTombstoneRetentionMs,
  type PushSequenceTransaction,
} from './sync-push-repository-postgres.js';
import type { PostgresSyncNodeCreateOptions } from './sync-push-types-postgres.js';
import { lookupLiveRecovered } from './sync-push-create-update-postgres.js';

export async function evaluateCanonicalNodeDelete(
  operation: Operation,
  serverBatchId: string,
  transaction: PushSequenceTransaction,
  options: PostgresSyncNodeCreateOptions,
  managedAncestry: ManagedAncestryCapabilities,
) {
  const tx = transaction.databaseTransaction;
  const tombstoneRetentionMs = resolveTombstoneRetentionMs(options.tombstoneRetentionSeconds);
  await tx.selectFrom('collections').select('id')
    .where('id', '=', transaction.authority.collectionId).forUpdate().executeTakeFirstOrThrow();
  if (typeof operation.targetId !== 'string') throw new SyncPushHttpError('invalid_document');
  const current = await tx.selectFrom('nodes').select([
    'id', 'collection_id', 'parent_id', 'kind', 'is_root', 'resource_revision',
    'deleted_at', 'payload_json',
  ]).where('collection_id', '=', transaction.authority.collectionId)
    .where('id', '=', operation.targetId).forUpdate().executeTakeFirst();
  if (!current || current.deleted_at !== null) throw new SyncPushHttpError('resource_not_found');

  let mapped;
  try {
    mapped = evaluateSyncNodeDelete(operation, {
      id: current.id,
      collectionId: current.collection_id,
      revision: current.resource_revision,
      kind: current.kind,
      isRoot: current.is_root,
      deleted: current.deleted_at !== null,
    });
  } catch (error) {
    if (error instanceof SyncNodeDeleteError) throw new SyncPushHttpError(error.code);
    throw error;
  }

  const memberIds = mapped.scope === 'single'
    ? [mapped.targetId]
    : (await sql<{ id: string }>`
      with recursive members(id, path, depth) as (
        select id, array[id], 0 from nodes
        where collection_id=${mapped.collectionId} and id=${mapped.targetId} and deleted_at is null
        union all
        select child.id, parent.path || child.id, parent.depth + 1
        from members parent join nodes child
          on child.collection_id=${mapped.collectionId} and child.parent_id=parent.id
        where child.deleted_at is null and parent.depth < 1024 and not child.id=any(parent.path)
      ) select id from members order by id
    `.execute(tx)).rows.map((row) => row.id);
  if (memberIds.length < 1 || !memberIds.includes(mapped.targetId)) {
    throw new SyncPushHttpError('resource_not_found');
  }
  const members = await tx.selectFrom('nodes').select([
    'id', 'parent_id', 'kind', 'is_root', 'resource_revision', 'deleted_at', 'payload_json',
  ]).where('collection_id', '=', mapped.collectionId).where('id', 'in', memberIds)
    .orderBy('id').forUpdate().execute();
  if (members.length !== memberIds.length || members.some((row) => row.deleted_at !== null)) {
    throw new SyncPushHttpError('resource_not_found');
  }
  if (mapped.scope === 'subtree') {
    const observation = operation.source?.extensions?.[SUBTREE_OBSERVATION_EXTENSION] as Record<string, unknown> | undefined;
    // Legacy requests can only remove the root itself, never unseen children.
    if (observation === undefined && members.length > 1) throw new SyncPushHttpError('precondition_required');
    if (observation !== undefined) {
      const expected = subtreeDeleteSource(mapped.targetId, members.map(row => ({ id: row.id, revision: row.resource_revision })))
        .extensions[SUBTREE_OBSERVATION_EXTENSION]!;
      if (!observation || typeof observation !== 'object' || Array.isArray(observation)
          || Object.keys(observation).length !== 3 || observation.version !== expected.version
          || observation.count !== expected.count || observation.digest !== expected.digest) {
        throw new SyncPushHttpError('revision_conflict');
      }
    }
  }
  const ancestorPath = current.parent_id === null ? []
    : await loadLockedManagedAncestryChain(tx, mapped.collectionId, current.parent_id);
  assertManagedAncestryWritable(
    [...members.map(managedAncestryNodeFact), ...ancestorPath],
    managedAncestry,
  );
  await options.faultInjector?.afterPhase?.('delete_facts_loaded');

  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, {
    operationIdClaimOwner: {
      async assertClaimed(claimTx, operationId) {
        await assertOperationIdClaimed(claimTx, operationId);
      },
    },
    ...(options.reportSourceInvalidation === undefined
      ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
    faultInjector: {
      async afterPhase(context) {
        if (context.phase === 'resource') await options.faultInjector?.afterPhase?.('node');
        if (context.phase === 'operation') await options.faultInjector?.afterPhase?.('operation');
      },
    },
  }));
  let mutation;
  try {
    mutation = await canonical.execute({ transaction: tx }, syncCanonicalMutationInput(
      operation, transaction.authority.accountId, {
        action: 'delete',
        target: {
          collectionId: mapped.collectionId,
          resourceId: mapped.targetId,
          resourceKind: 'node',
        },
        parentId: current.parent_id,
        expectedResourceRevision: mapped.expectedCurrentRevision,
        deleteIntent: { scope: mapped.scope },
      },
    ));
  } catch (error) {
    throw mapCanonicalCreateError(error);
  }

  await persistSyncOperationProjection(tx, operation);

  const deletedRevisions = mutation.allocation.deletedResourceRevisions ?? {};
  const deletedIds = Object.keys(deletedRevisions).sort();
  if (deletedIds.length < 1 || deletedIds.length !== memberIds.length
      || !deletedIds.includes(mapped.targetId)) throw new SyncPushHttpError('internal_error');
  const deletedRows = await tx.selectFrom('nodes').select([
    'id', 'kind', 'resource_revision', 'deleted_at', 'deleted_commit_ordinal', 'payload_json',
  ]).where('collection_id', '=', mapped.collectionId).where('id', 'in', deletedIds)
    .orderBy('id').execute();
  if (deletedRows.length !== deletedIds.length) throw new SyncPushHttpError('internal_error');
  const deletedAt = deletedRows[0]?.deleted_at;
  if (!(deletedAt instanceof Date) || deletedRows.some((row) => !(row.deleted_at instanceof Date)
      || row.deleted_at.getTime() !== deletedAt.getTime()
      || BigInt(row.deleted_commit_ordinal ?? 0) !== mutation.allocation.commitOrdinal
      || row.resource_revision !== deletedRevisions[row.id])) {
    throw new SyncPushHttpError('internal_error');
  }
  const cursor = `sync-delete-${mutation.allocation.commitOrdinal}`;
  try {
    await createPostgresSyncNodeTombstonePort(tx).append({
      collectionId: mapped.collectionId,
      rootTargetId: mapped.targetId,
      operationId: operation.opId,
      scope: mapped.scope,
      deleteCommitOrdinal: mutation.allocation.commitOrdinal,
      deleteCursor: cursor,
      deletedAt,
      purgeAfter: new Date(deletedAt.getTime() + tombstoneRetentionMs),
      members: deletedRows.map((row) => ({
        targetId: row.id,
        kind: row.kind,
        deleteRevision: row.resource_revision,
        extensions: (row.payload_json?.extensions ?? {}) as JsonObject,
      })),
    });
  } catch (error) {
    if (error instanceof SyncNodeTombstonePersistenceError) {
      throw new SyncPushHttpError(error.code === 'payload_too_large' ? 'payload_too_large' : 'internal_error');
    }
    throw error;
  }
  await options.faultInjector?.afterPhase?.('tombstone');
  const revision = deletedRevisions[mapped.targetId];
  if (!revision) throw new SyncPushHttpError('internal_error');
  await persistAuthoritativeOperationEffect({
    transaction: tx, operation, commitOrdinal: mutation.allocation.commitOrdinal,
    terminalStatus: 'applied', cursor, sourceParentId: current.parent_id ?? undefined,
    memberIds: deletedIds,
    ...(options.effectPageAuthority ? { effectPageAuthority: options.effectPageAuthority } : {}),
    ...(options.effectPageTemplate ? { effectPageTemplate: options.effectPageTemplate } : {}),
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  return appliedPushResult(serverBatchId, operation, 'applied', mapped.targetId, revision, cursor);
}

export async function evaluateCanonicalNodeMove(
  operation: Operation,
  serverBatchId: string,
  transaction: PushSequenceTransaction,
  options: PostgresSyncNodeCreateOptions,
  managedAncestry: ManagedAncestryCapabilities,
) {
  const tx = transaction.databaseTransaction;
  await tx.selectFrom('collections').select('id')
    .where('id', '=', transaction.authority.collectionId).forUpdate().executeTakeFirstOrThrow();
  const payload = operation.payload;
  const newParentId = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).newParentId : undefined;
  if (typeof operation.targetId !== 'string' || typeof newParentId !== 'string') {
    throw new SyncPushHttpError('invalid_document');
  }
  const current = await tx.selectFrom('nodes').select([
    'id', 'collection_id', 'parent_id', 'kind', 'is_root', 'title', 'url', 'description', 'tags',
    'visibility', 'resource_revision', 'deleted_at', 'payload_json',
  ]).where('collection_id', '=', transaction.authority.collectionId)
    .where('id', '=', operation.targetId).forUpdate().executeTakeFirst();
  if (!current || current.deleted_at !== null || current.parent_id === null) {
    throw new SyncPushHttpError(current?.is_root ? 'invalid_document' : 'resource_not_found');
  }

  const sourcePath = await loadCanonicalAncestorPath(tx, transaction.authority.collectionId, current.parent_id);
  const targetPath = current.parent_id === newParentId
    ? sourcePath : await loadCanonicalAncestorPath(tx, transaction.authority.collectionId, newParentId);
  const lockIds = [...new Set([current.id, ...sourcePath.map((row) => row.id),
    ...targetPath.map((row) => row.id)])].sort();
  const lockedRows = await tx.selectFrom('nodes').select([
    'id', 'collection_id', 'parent_id', 'kind', 'is_root', 'resource_revision',
    'children_revision', 'title', 'url', 'description', 'tags', 'visibility',
    'deleted_at', 'payload_json',
  ]).where('collection_id', '=', transaction.authority.collectionId)
    .where('id', 'in', lockIds).orderBy('id').forUpdate().execute();
  const byId = new Map(lockedRows.map((row) => [row.id, row] as const));
  const lockedCurrent = byId.get(current.id);
  const sourceParent = byId.get(current.parent_id);
  const targetParent = byId.get(newParentId);
  if (!lockedCurrent || !sourceParent || !targetParent
      || sourcePath.at(-1)?.is_root !== true || targetPath.at(-1)?.is_root !== true) {
    throw new SyncPushHttpError('resource_not_found');
  }
  const protectedFacts = [...new Set([...sourcePath, ...targetPath].map((row) => row.id))]
    .map((id) => byId.get(id))
    .map((row) => {
      if (!row) throw new SyncPushHttpError('resource_not_found');
      return managedAncestryNodeFact(row);
    });
  assertManagedAncestryWritable(
    [...protectedFacts, managedAncestryNodeFact(lockedCurrent)],
    managedAncestry,
  );
  let mapped;
  try {
    mapped = evaluateSyncNodeMove(operation, {
      node: {
        id: lockedCurrent.id, collectionId: lockedCurrent.collection_id,
        parentId: lockedCurrent.parent_id, revision: lockedCurrent.resource_revision,
        kind: lockedCurrent.kind, isRoot: lockedCurrent.is_root,
        deleted: lockedCurrent.deleted_at !== null,
      },
      sourceParent: {
        id: sourceParent.id, collectionId: sourceParent.collection_id, kind: sourceParent.kind,
        childrenRevision: sourceParent.children_revision, isRoot: sourceParent.is_root,
        deleted: sourceParent.deleted_at !== null,
      },
      targetParent: {
        id: targetParent.id, collectionId: targetParent.collection_id, kind: targetParent.kind,
        childrenRevision: targetParent.children_revision, isRoot: targetParent.is_root,
        deleted: targetParent.deleted_at !== null,
      },
      targetAncestorIds: targetPath.map((row) => row.id),
    });
  } catch (error) {
    if (error instanceof SyncNodeMoveError) throw new SyncPushHttpError(error.code);
    throw error;
  }
  const currentRole = typeof lockedCurrent.payload_json?.folderRole === 'string'
    ? lockedCurrent.payload_json.folderRole : null;
  if (currentRole === 'recovered') {
    const targetRole = typeof targetParent.payload_json?.folderRole === 'string'
      ? targetParent.payload_json.folderRole : null;
    if (!isAllowedRecoveredParent({
      isRoot: targetParent.is_root, nodeKind: targetParent.kind, folderRole: targetRole,
    })) {
      throw new SyncPushHttpError('invalid_document');
    }
    if (mapped.newParentId !== current.parent_id) {
      const existing = await lookupLiveRecovered(tx, transaction.authority.collectionId, mapped.newParentId);
      if (existing && existing.id !== current.id) throw new SyncPushHttpError('invalid_document');
    }
  }
  const preresolvedPlacement = await readSyncPlacementContext(
    transaction,
    mapped.newParentId,
    mapped.relativePosition,
    mapped.targetId,
  );
  await options.faultInjector?.afterPhase?.('move_facts_loaded');
  const canonicalTags = lockedCurrent.payload_json?.tags;
  if (!Array.isArray(canonicalTags)
      || canonicalTags.some((tag) => typeof tag !== 'string')) {
    throw new SyncPushHttpError('internal_error');
  }

  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, {
    operationIdClaimOwner: {
      async assertClaimed(claimTx, operationId) {
        await assertOperationIdClaimed(claimTx, operationId);
      },
    },
    ...(options.reportSourceInvalidation === undefined
      ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
    preresolvedPlacement,
    faultInjector: {
      async afterPhase(context) {
        if (context.phase === 'resource' && context.resourceId === mapped.targetId) {
          await options.faultInjector?.afterPhase?.('node');
        }
        if (context.phase === 'operation') await options.faultInjector?.afterPhase?.('operation');
      },
    },
  }));
  let mutation;
  try {
    mutation = await canonical.execute({ transaction: tx }, syncCanonicalMutationInput(
      operation, transaction.authority.accountId, {
        action: 'move',
        target: {
          collectionId: transaction.authority.collectionId,
          resourceId: mapped.targetId,
          resourceKind: 'node',
        },
        parentId: mapped.newParentId,
        ...(Object.keys(mapped.relativePosition).length === 0
          ? {} : { relativePosition: mapped.relativePosition }),
        expectedResourceRevision: mapped.expectedCurrentRevision,
        fields: {
          kindFields: {
            kind: lockedCurrent.kind,
            title: lockedCurrent.title,
            url: lockedCurrent.url,
            description: lockedCurrent.description,
            tags: canonicalTags,
            visibility: lockedCurrent.visibility,
          },
          extensions: (lockedCurrent.payload_json?.extensions ?? {}) as JsonObject,
        },
      },
    ));
  } catch (error) {
    if (currentRole === 'recovered'
        && ((error instanceof DatabaseOperationError && error.kind === 'unique_violation')
          || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'))) {
      throw new SyncPushHttpError('invalid_document');
    }
    throw mapCanonicalMoveError(error);
  }
  await persistSyncOperationProjection(tx, operation);
  const revision = mutation.allocation.resourceRevision;
  if (!revision) throw new SyncPushHttpError('internal_error');
  const cursor = `sync-move-${mutation.allocation.commitOrdinal}`;
  await persistAuthoritativeOperationEffect({
    transaction: tx, operation, commitOrdinal: mutation.allocation.commitOrdinal,
    terminalStatus: 'applied', cursor, sourceParentId: current.parent_id ?? undefined,
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  return appliedPushResult(serverBatchId, operation, 'applied', mapped.targetId, revision, cursor);
}
