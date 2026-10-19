import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { allocatePosition, createCanonicalMutationApplication, NodeConflictError, NODE_DELETION_PURGE_RETENTION_MS,
  type RestoreCollectionVersionPorts } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { createPostgresCanonicalMutationPorts } from './canonical-mutation-postgres-ports.js';

/** Restore parents before children, preserving resource identity, sync effects and tombstone revisions. */
export async function restoreVersionDeletedNodes(tx: DatabaseTransaction,
  input: Parameters<NonNullable<RestoreCollectionVersionPorts['restoreDeletedNodes']>>[0],
  reportSourceInvalidation?: ReportSourceInvalidationOutboxPort,
): Promise<void> {
  const pending = new Map(input.nodes.map(node => [node.id, node]));
  while (pending.size) {
    const ready = [...pending.values()].filter(node => !pending.has(node.parentId));
    if (!ready.length) throw new NodeConflictError('revision_conflict', 'The saved tree contains a parent cycle.');
    for (const node of ready) {
      if (await tx.selectFrom('sync_purged_node_id_watermarks').select('target_id')
        .where('collection_id', '=', input.collectionId).where('target_id', '=', node.id).executeTakeFirst())
        throw new NodeConflictError('revision_conflict', 'A saved node was permanently removed.');
      const retained = await tx.selectFrom('nodes').select(['kind', 'deleted_at', 'deleted_commit_ordinal', 'resource_revision'])
        .where('collection_id', '=', input.collectionId).where('id', '=', node.id).executeTakeFirst();
      // Product deletes retain their canonical row/operation but historically wrote no sync trash row.
      // Materialize only this still-deleted member, never one whose purge watermark revoked restoration.
      if (retained?.deleted_at && retained.kind === node.kind) await retainProductDeletion(tx, input.collectionId, node.id);
      const deletion = await tx.selectFrom('sync_node_tombstones').select(['operation_id', 'delete_revision', 'payload_purged_at'])
        .where('collection_id', '=', input.collectionId).where('target_id', '=', node.id).executeTakeFirst();
      if (!retained?.deleted_at || retained.kind !== node.kind || !deletion || deletion.payload_purged_at !== null)
        throw new NodeConflictError('revision_conflict', 'A saved node was permanently removed or its retained deletion is unavailable.');
      const siblings = await tx.selectFrom('nodes').select('position_token').where('collection_id', '=', input.collectionId)
        .where('parent_id', '=', node.parentId).where('deleted_at', 'is', null).execute();
      const tokens = siblings.flatMap(row => row.position_token === null ? [] : [row.position_token]).sort();
      const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, {
        invalidateSyncReplicasOnNodeMutation: true, reportSourceInvalidation,
      }));
      await canonical.execute({ transaction: tx }, { operationId: randomUUID(), collectionId: input.collectionId,
        actor: { principalId: input.actor.principalId, principalType: 'account' },
        mutation: { action: 'restore', target: { collectionId: input.collectionId, resourceId: node.id, resourceKind: 'node' },
          parentId: node.parentId, expectedResourceRevision: deletion.delete_revision, fields: { kindFields: {}, extensions: {} },
          trustedFacts: { restorePositionToken: allocatePosition(tokens.at(-1) ?? null, null, tokens) } } });
      pending.delete(node.id);
    }
  }
}

async function retainProductDeletion(tx: DatabaseTransaction, collectionId: string, nodeId: string): Promise<void> {
  if (await tx.selectFrom('sync_node_tombstones').select('target_id').where('collection_id', '=', collectionId)
    .where('target_id', '=', nodeId).executeTakeFirst()) return;
  if (await tx.selectFrom('sync_purged_node_id_watermarks').select('target_id').where('collection_id', '=', collectionId)
    .where('target_id', '=', nodeId).executeTakeFirst()) return;
  const row = await tx.selectFrom('nodes').selectAll().where('collection_id', '=', collectionId).where('id', '=', nodeId).forUpdate().executeTakeFirst();
  if (!row?.deleted_at || row.deleted_commit_ordinal === null || !['folder', 'bookmark'].includes(row.kind)) return;
  const operation = await tx.selectFrom('operation_payloads').select(['operation_id', 'payload_json'])
    .where('collection_id', '=', collectionId).where('commit_ordinal', '=', row.deleted_commit_ordinal).executeTakeFirst();
  if (operation?.payload_json?.action !== 'delete' || operation.payload_json.resourceKind !== 'node') return;
  const payload = { resourceType: 'node', targetId: nodeId, collectionId, rootTargetId: nodeId, kind: row.kind,
    scope: 'single', deleteRevision: row.resource_revision, operationId: operation.operation_id,
    deleteCommitOrdinal: String(row.deleted_commit_ordinal), affectedCount: 1, extensions: {} };
  await tx.insertInto('sync_node_tombstones').values({
    collection_id: collectionId, target_id: nodeId, root_target_id: nodeId, operation_id: operation.operation_id, scope: 'single',
    delete_commit_ordinal: BigInt(row.deleted_commit_ordinal), delete_revision: row.resource_revision,
    delete_cursor: `sync-delete-${row.deleted_commit_ordinal}`, deleted_at: row.deleted_at,
    purge_after: new Date(row.deleted_at.getTime() + NODE_DELETION_PURGE_RETENTION_MS), affected_count: 1,
    payload_json: sql`${JSON.stringify(payload)}::jsonb`,
  }).execute();
}
