import { withCanonicalTreeCapacity } from '../collections/canonical-tree-capacity.js';
import { assertManagedAncestryWritable, loadLockedManagedAncestryChain, managedAncestryNodeFact, type ManagedAncestryCapabilities } from './managed-ancestry-policy.js';
import { randomBytes } from 'node:crypto';
import type { Operation, SyncTombstone } from '@know-n/colp/types';
import {
  allocatePosition,
  createCanonicalMutationApplication,
} from '../../modules/collections/index.js';
import {
  evaluateSyncNodeRestore,
  SyncNodeRestoreError,
  SyncPushHttpError,
} from '../../modules/sync/index.js';
import { createPostgresCanonicalMutationPorts, type PostgresCanonicalOperationIdClaimOwner } from '../collections/canonical-mutation-postgres-ports.js';
import { syncCanonicalMutationInput } from './sync-canonical-mutation-input.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { persistSyncOperationProjection } from './postgres/sync-pull-postgres.js';
import { persistAuthoritativeOperationEffect } from './sync-operation-effects-postgres.js';
import { createSystemRecoveredFolder } from './postgres/sync-recovered-create-postgres.js';
import type { PostgresSyncNodeCreateOptions } from './postgres/sync-push-types-postgres.js';

const MOUNT_ROLES = new Set(['bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks', 'custom']);

export interface ApplyCanonicalNodeRestoreInput {
  readonly operation: Operation;
  readonly operationIdClaimOwner: PostgresCanonicalOperationIdClaimOwner;
  readonly actorPrincipalId: string;
  readonly managedAncestry?: ManagedAncestryCapabilities;
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  readonly nodeId?: () => string;
  readonly effectPageAuthority?: string;
  readonly effectPageTemplate?: string;
  readonly faultInjector?: PostgresSyncNodeCreateOptions['faultInjector'];
}

export interface ApplyCanonicalNodeRestoreResult {
  readonly revision: string;
  readonly cursor: string;
  readonly commitOrdinal: bigint;
  readonly parentId: string;
}

export async function applyCanonicalNodeRestore(tx: DatabaseTransaction, input: ApplyCanonicalNodeRestoreInput): Promise<ApplyCanonicalNodeRestoreResult> {
  await tx.selectFrom('collections').select('id').where('id', '=', input.operation.collectionId!).forUpdate().executeTakeFirst();
  return withCanonicalTreeCapacity(tx, input.operation.collectionId!, () => applyNodeRestore(tx, input));
}

async function applyNodeRestore(
  tx: DatabaseTransaction,
  input: ApplyCanonicalNodeRestoreInput,
): Promise<ApplyCanonicalNodeRestoreResult> {
  let mapped;
  try {
    mapped = evaluateSyncNodeRestore(input.operation);
  } catch (error) {
    if (error instanceof SyncNodeRestoreError) throw new SyncPushHttpError(error.code);
    throw error;
  }
  const collection = await tx.selectFrom('collections').selectAll()
    .where('id', '=', mapped.collectionId).forUpdate().executeTakeFirst();
  if (!collection || collection.deleted_at !== null) throw new SyncPushHttpError('resource_not_found');
  const watermark = await tx.selectFrom('sync_purged_node_id_watermarks').select('target_id')
    .where('collection_id', '=', mapped.collectionId).where('target_id', '=', mapped.targetId)
    .executeTakeFirst();
  // T-10 lock order (ADR-0027): nodes precedes sync_node_tombstones, matching
  // Canonical delete and Sync Push delete, which tombstone only after locking
  // the node rows they removed. Taking the tombstone lock first inverted that
  // pair against a concurrent recursive delete of the same subtree.
  const node = await tx.selectFrom('nodes').selectAll()
    .where('collection_id', '=', mapped.collectionId).where('id', '=', mapped.targetId)
    .forUpdate().executeTakeFirst();
  const tombstone = await tx.selectFrom('sync_node_tombstones').selectAll()
    .where('collection_id', '=', mapped.collectionId).where('target_id', '=', mapped.targetId)
    .forUpdate().executeTakeFirst();
  if (watermark || tombstone?.payload_purged_at != null) throw new SyncPushHttpError('resource_purged');
  if (!tombstone) throw new SyncPushHttpError('resource_not_found');
  if (!node || node.is_root || node.deleted_at === null) throw new SyncPushHttpError('resource_not_found');
  if (tombstone.delete_revision !== mapped.expectedDeleteRevision) {
    throw new SyncPushHttpError('revision_conflict');
  }
  const managedCapabilities = input.managedAncestry ?? { managedBookmarkWrites: false, replicaWrite: false };
  assertManagedAncestryWritable([managedAncestryNodeFact(node)], managedCapabilities);
  const consumedTombstone = mapConsumedTombstone(tombstone);
  const now = new Date();
  const placement = await resolveRestorePlacement(tx, {
    collectionId: mapped.collectionId,
    rootNodeId: collection.root_node_id,
    actorPrincipalId: input.actorPrincipalId,
    node,
    managedCapabilities,
    reportSourceInvalidation: input.reportSourceInvalidation,
    now,
    nodeId: input.nodeId ?? (() => randomBytes(16).toString('base64url')),
    ...(input.faultInjector ? { faultInjector: input.faultInjector } : {}),
  });
  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, {
    operationIdClaimOwner: input.operationIdClaimOwner,
    reportSourceInvalidation: input.reportSourceInvalidation,
    faultInjector: { async afterPhase(context) {
      if (context.phase === 'resource') {
        await input.faultInjector?.afterPhase?.('node');
        await input.faultInjector?.afterPhase?.('restore');
      }
      if (context.phase === 'revision') await input.faultInjector?.afterPhase?.('history');
      if (context.phase === 'operation') await input.faultInjector?.afterPhase?.('operation');
      if (context.phase === 'audit') await input.faultInjector?.afterPhase?.('audit');
      if (context.phase === 'outbox') await input.faultInjector?.afterPhase?.('outbox');
    } },
  }));
  const result = await canonical.execute({ transaction: tx }, syncCanonicalMutationInput(input.operation, input.actorPrincipalId, {
    action: 'restore', target: { collectionId: mapped.collectionId, resourceId: mapped.targetId, resourceKind: 'node' },
    parentId: placement.parentId, expectedResourceRevision: mapped.expectedDeleteRevision,
    fields: { kindFields: {}, extensions: {} },
    trustedFacts: { restorePositionToken: placement.positionToken },
  }));
  const { commitOrdinal, resourceRevision } = result.allocation;
  if (!resourceRevision) throw new SyncPushHttpError('internal_error');
  await persistSyncOperationProjection(tx, input.operation);
  const cursor = `sync-restore-${commitOrdinal}`;
  await persistAuthoritativeOperationEffect({
    transaction: tx, operation: input.operation, commitOrdinal, terminalStatus: 'applied', cursor,
    consumedTombstone,
    ...(input.effectPageAuthority ? { effectPageAuthority: input.effectPageAuthority } : {}),
    ...(input.effectPageTemplate ? { effectPageTemplate: input.effectPageTemplate } : {}),
    ...(input.faultInjector ? { faultInjector: input.faultInjector } : {}),
  });
  await input.faultInjector?.afterPhase?.('receipt');
  await input.faultInjector?.afterPhase?.('before_receipt_finalize');
  return { revision: resourceRevision, cursor, commitOrdinal, parentId: placement.parentId };
}

function mapConsumedTombstone(row: {
  readonly target_id: string; readonly collection_id: string; readonly scope: 'single' | 'subtree';
  readonly deleted_at: Date; readonly delete_revision: string; readonly operation_id: string;
  readonly delete_cursor: string; readonly affected_count: number; readonly purge_after: Date;
}): SyncTombstone {
  return {
    resourceType: 'node', targetId: row.target_id, collectionId: row.collection_id, scope: row.scope,
    deletedAt: row.deleted_at.toISOString(), deleteRevision: row.delete_revision,
    operationId: row.operation_id, deleteCursor: row.delete_cursor, affectedCount: row.affected_count,
    purgeAfter: row.purge_after.toISOString(),
  };
}

async function resolveRestorePlacement(
  tx: DatabaseTransaction,
  input: {
    readonly collectionId: string; readonly rootNodeId: string; readonly actorPrincipalId: string;
    readonly node: { readonly id: string; readonly parent_id: string | null; readonly position_token: string | null;
      readonly payload_json: Record<string, unknown> | null };
    readonly now: Date; readonly nodeId: () => string;
    readonly managedCapabilities: ManagedAncestryCapabilities;
    readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
    readonly faultInjector?: PostgresSyncNodeCreateOptions['faultInjector'];
  },
): Promise<{ readonly parentId: string; readonly positionToken: string }> {
  const originalParentId = input.node.parent_id;
  if (originalParentId) {
    const parent = await tx.selectFrom('nodes').select(['id', 'deleted_at'])
      .where('collection_id', '=', input.collectionId).where('id', '=', originalParentId)
      .executeTakeFirst();
    if (parent && parent.deleted_at === null) {
      assertManagedAncestryWritable(await loadLockedManagedAncestryChain(tx, input.collectionId, originalParentId), input.managedCapabilities);
      return {
        parentId: originalParentId,
        positionToken: await allocateNearOriginal(tx, input.collectionId, originalParentId, input.node.id,
          input.node.position_token),
      };
    }
  }
  const mountParentId = await liveMountParentId(tx, input.collectionId, originalParentId, input.rootNodeId);
  assertManagedAncestryWritable(await loadLockedManagedAncestryChain(tx, input.collectionId, mountParentId), input.managedCapabilities);
  const recovered = await createSystemRecoveredFolder(tx, {
    collectionId: input.collectionId, parentId: mountParentId, actorPrincipalId: input.actorPrincipalId,
    now: input.now, nodeId: input.nodeId,
    reportSourceInvalidation: input.reportSourceInvalidation,
    ...(input.faultInjector ? { faultInjector: input.faultInjector } : {}),
  });
  return {
    parentId: recovered.nodeId,
    positionToken: await allocateNearOriginal(tx, input.collectionId, recovered.nodeId, input.node.id, null),
  };
}

async function liveMountParentId(
  tx: DatabaseTransaction, collectionId: string, startParentId: string | null, rootNodeId: string,
): Promise<string> {
  let cursor = startParentId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const row = await tx.selectFrom('nodes').select(['id', 'parent_id', 'is_root', 'deleted_at', 'payload_json'])
      .where('collection_id', '=', collectionId).where('id', '=', cursor).executeTakeFirst();
    if (!row || row.is_root) break;
    const role = typeof row.payload_json?.folderRole === 'string' ? row.payload_json.folderRole : null;
    if (role && MOUNT_ROLES.has(role) && row.deleted_at === null) return row.id;
    cursor = row.parent_id;
  }
  return rootNodeId;
}

async function allocateNearOriginal(
  tx: DatabaseTransaction, collectionId: string, parentId: string, nodeId: string, originalToken: string | null,
): Promise<string> {
  const siblings = await tx.selectFrom('nodes').select(['id', 'position_token'])
    .where('collection_id', '=', collectionId).where('parent_id', '=', parentId)
    .where('deleted_at', 'is', null).where('id', '<>', nodeId).execute();
  const tokens = siblings.map((row) => row.position_token).filter((token): token is string => token !== null);
  if (originalToken && !tokens.includes(originalToken)) return originalToken;
  const sorted = [...tokens].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  let lower: string | null = null;
  let upper: string | null = null;
  if (originalToken) {
    for (const token of sorted) {
      if (token < originalToken) lower = token;
      else if (token > originalToken && upper === null) upper = token;
    }
  } else {
    lower = sorted.at(-1) ?? null;
  }
  return allocatePosition(lower, upper, tokens);
}
