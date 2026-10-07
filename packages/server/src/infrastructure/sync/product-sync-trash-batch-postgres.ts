import { sql } from 'kysely';
import {
  decodeTrashDeletionId,
  encodeTrashDeletionId,
  PRODUCT_SYNC_TRASH_RESTORE_BATCH_LIMIT,
  type ProductSyncCenterPorts,
  type ProductSyncTrashRestoreBatchView,
  type ProductSyncTrashRestoreItemResult,
} from '../../modules/sync/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  appliedRestoreResult, attemptRestoreTrashItem, invalidRequest, locateDeletion, notFound,
  ownedCollection, preconditionFailed, productTrashCommand, purged, restoreOutcomeResult,
  summarizeRestoreResults, type ProductSyncTrashPostgresOptions,
} from './product-sync-trash-shared-postgres.js';

export function productSyncTrashBatchPorts(
  transaction: DatabaseTransaction,
  options: ProductSyncTrashPostgresOptions,
): Pick<ProductSyncCenterPorts, 'restoreTrashBatch' | 'restoreTrashSubtree'> {
  return {
    restoreTrashBatch: (input) => productTrashCommand(transaction, {
      principalId: input.accountId,
      commandScope: `sync-trash-restore-batch:${input.collectionId}`,
      commandId: input.commandId,
    }, input.fingerprint, async () => restoreBatch(transaction, input, options)),
    restoreTrashSubtree: (input) => productTrashCommand(transaction, {
      principalId: input.accountId,
      commandScope: `sync-trash-restore-subtree:${input.deletionId}`,
      commandId: input.commandId,
    }, input.fingerprint, async () => restoreSubtree(transaction, input, options)),
  };
}

async function restoreBatch(
  transaction: DatabaseTransaction,
  input: {
    readonly accountId: string; readonly subjectId: string; readonly collectionId: string;
    readonly items: readonly { readonly deletionId: string; readonly expectedRevision: string }[];
  },
  options: ProductSyncTrashPostgresOptions,
): Promise<ProductSyncTrashRestoreBatchView> {
  if (input.items.length < 1 || input.items.length > PRODUCT_SYNC_TRASH_RESTORE_BATCH_LIMIT) {
    throw invalidRequest('Trash restore selection is empty or too large.');
  }
  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.deletionId)) throw invalidRequest('Trash restore selection contains duplicate deletion ids.');
    seen.add(item.deletionId);
  }
  const collection = await ownedCollection(transaction, input.collectionId, input.subjectId);
  if (!collection) throw notFound();
  const ordered = await orderRestoreItems(transaction, input.collectionId, input.items);
  const results: ProductSyncTrashRestoreItemResult[] = [];
  for (const item of ordered) {
    results.push(await restoreOneResult(transaction, {
      accountId: input.accountId, subjectId: input.subjectId, collectionId: input.collectionId,
      deletionId: item.deletionId, expectedRevision: item.expectedRevision,
    }, options));
  }
  const byId = new Map(results.map((result) => [result.deletionId, result]));
  const orderedResults = input.items.map((item) => byId.get(item.deletionId)!);
  options.metrics?.increment(orderedResults.some((result) => result.outcome !== 'applied')
    ? 'sync_trash_restore_batch_total.partial' : 'sync_trash_restore_batch_total.applied');
  return Object.freeze({
    collectionId: input.collectionId,
    results: Object.freeze(orderedResults),
    summary: summarizeRestoreResults(orderedResults),
  });
}

async function restoreSubtree(
  transaction: DatabaseTransaction,
  input: {
    readonly accountId: string; readonly subjectId: string; readonly deletionId: string;
    readonly expectedRevision: string;
  },
  options: ProductSyncTrashPostgresOptions,
): Promise<ProductSyncTrashRestoreBatchView> {
  const decoded = decodeTrashDeletionId(input.deletionId);
  if (!decoded) throw notFound();
  const located = await locateDeletion(transaction, decoded.operationId, decoded.targetId);
  if (located.kind === 'missing') throw notFound();
  const collection = await ownedCollection(transaction, located.collectionId, input.subjectId);
  if (!collection) throw notFound();
  if (located.kind === 'purged') throw purged();
  if (located.tombstone.delete_revision !== input.expectedRevision) throw preconditionFailed();
  const members = await loadRestorableSubtree(transaction, located.collectionId, decoded.targetId);
  if (members.length < 1) throw notFound();
  const root = members[0]!;
  if (root.kind !== 'folder' || root.targetId !== decoded.targetId) {
    throw invalidRequest('Subtree restore requires a deleted folder.');
  }
  if (members.length > PRODUCT_SYNC_TRASH_RESTORE_BATCH_LIMIT) {
    throw invalidRequest('Subtree restore selection is too large.');
  }
  const results: ProductSyncTrashRestoreItemResult[] = [];
  for (const member of members) {
    const deletionId = encodeTrashDeletionId(member.operationId, member.targetId);
    const expectedRevision = member.targetId === decoded.targetId
      ? input.expectedRevision : member.deleteRevision;
    results.push(await restoreOneResult(transaction, {
      accountId: input.accountId, subjectId: input.subjectId, collectionId: located.collectionId,
      deletionId, expectedRevision,
    }, options));
  }
  options.metrics?.increment(results.some((result) => result.outcome !== 'applied')
    ? 'sync_trash_restore_subtree_total.partial' : 'sync_trash_restore_subtree_total.applied');
  return Object.freeze({
    collectionId: located.collectionId,
    results: Object.freeze(results),
    summary: summarizeRestoreResults(results),
  });
}

async function restoreOneResult(
  transaction: DatabaseTransaction,
  input: {
    readonly accountId: string; readonly subjectId: string; readonly collectionId: string;
    readonly deletionId: string; readonly expectedRevision: string;
  },
  options: ProductSyncTrashPostgresOptions,
): Promise<ProductSyncTrashRestoreItemResult> {
  const attempt = await attemptRestoreTrashItem(transaction, input, options.metrics, options.reportSourceInvalidation);
  if (attempt.kind === 'applied') return appliedRestoreResult(input.deletionId, attempt.view);
  if (attempt.kind === 'invalid_request') return restoreOutcomeResult(input.deletionId, 'not_found');
  return restoreOutcomeResult(input.deletionId, attempt.kind);
}

async function orderRestoreItems(
  transaction: DatabaseTransaction,
  collectionId: string,
  items: readonly { readonly deletionId: string; readonly expectedRevision: string }[],
): Promise<readonly { readonly deletionId: string; readonly expectedRevision: string }[]> {
  const parents = new Map<string, string | null>();
  for (const item of items) {
    const decoded = decodeTrashDeletionId(item.deletionId);
    if (!decoded) continue;
    const row = await transaction.selectFrom('nodes')
      .select(['id', 'parent_id'])
      .where('collection_id', '=', collectionId).where('id', '=', decoded.targetId)
      .executeTakeFirst();
    if (row) parents.set(item.deletionId, row.parent_id);
  }
  const targetByDeletion = new Map<string, string>();
  for (const item of items) {
    const decoded = decodeTrashDeletionId(item.deletionId);
    if (decoded) targetByDeletion.set(item.deletionId, decoded.targetId);
  }
  const selectedTargets = new Set(targetByDeletion.values());
  const remaining = new Map(items.map((item) => [item.deletionId, item]));
  const ordered: Array<{ readonly deletionId: string; readonly expectedRevision: string }> = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const [deletionId, item] of remaining) {
      const parentId = parents.get(deletionId);
      const parentSelected = parentId !== undefined && parentId !== null && selectedTargets.has(parentId)
        && [...targetByDeletion.entries()].some(([id, target]) => remaining.has(id) && target === parentId);
      if (!parentSelected) {
        ordered.push(item);
        remaining.delete(deletionId);
        progressed = true;
      }
    }
    if (!progressed) {
      ordered.push(...remaining.values());
      break;
    }
  }
  return ordered;
}

interface SubtreeMember {
  readonly targetId: string;
  readonly operationId: string;
  readonly deleteRevision: string;
  readonly parentId: string | null;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly depth: number;
}

async function loadRestorableSubtree(
  transaction: DatabaseTransaction, collectionId: string, rootId: string,
): Promise<readonly SubtreeMember[]> {
  const rows = await sql<{
    target_id: string; operation_id: string; delete_revision: string;
    parent_id: string | null; kind: 'folder' | 'bookmark' | 'separator'; depth: number;
  }>`
    WITH RECURSIVE tree AS (
      SELECT node.id AS target_id, tombstone.operation_id,
        tombstone.delete_revision, node.parent_id, node.kind, 0 AS depth
      FROM nodes AS node
      INNER JOIN sync_node_tombstones AS tombstone
        ON tombstone.collection_id = node.collection_id AND tombstone.target_id = node.id
      WHERE node.collection_id = ${collectionId} AND node.id = ${rootId}
        AND node.deleted_at IS NOT NULL AND tombstone.payload_purged_at IS NULL
      UNION ALL
      SELECT child.id, child_tombstone.operation_id, child_tombstone.delete_revision,
        child.parent_id, child.kind, tree.depth + 1
      FROM tree
      INNER JOIN nodes AS child
        ON child.collection_id = ${collectionId} AND child.parent_id = tree.target_id
      INNER JOIN sync_node_tombstones AS child_tombstone
        ON child_tombstone.collection_id = child.collection_id AND child_tombstone.target_id = child.id
      WHERE child.deleted_at IS NOT NULL AND child_tombstone.payload_purged_at IS NULL
        AND tree.depth < ${PRODUCT_SYNC_TRASH_RESTORE_BATCH_LIMIT}
    )
    SELECT target_id, operation_id, delete_revision, parent_id, kind, depth
    FROM tree
    ORDER BY depth, target_id
  `.execute(transaction);
  return rows.rows.map((row) => Object.freeze({
    targetId: row.target_id, operationId: row.operation_id, deleteRevision: row.delete_revision,
    parentId: row.parent_id, kind: row.kind, depth: Number(row.depth),
  }));
}
