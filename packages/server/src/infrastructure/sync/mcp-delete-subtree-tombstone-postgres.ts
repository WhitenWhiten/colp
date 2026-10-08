import type { JsonObject } from '../../modules/collections/index.js';
import { NODE_DELETION_PURGE_RETENTION_MS } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import {
  createPostgresSyncNodeTombstonePort,
  SyncNodeTombstonePersistenceError,
} from './sync-node-tombstone-postgres.js';

/**
 * Facts the MCP commit already proved by soft-deleting the subtree. The
 * recorder only appends the sync trash rows for those members.
 */
export interface McpDeleteSubtreeTombstoneFacts {
  readonly collectionId: string;
  readonly rootTargetId: string;
  readonly operationId: string;
  readonly commitOrdinal: bigint;
}

/**
 * Writes `sync_node_tombstones` for an MCP `nodes.delete_subtree` commit.
 * Product delete only sets `nodes.deleted_at`. Sync trash and restore read
 * the tombstone table, which the sync push delete path is otherwise the only
 * writer of. Members are the rows this commit ordinal just deleted, so an
 * older trash entry under the same parent is not written again.
 */
export async function recordMcpDeleteSubtreeTombstones(
  transaction: DatabaseTransaction,
  facts: McpDeleteSubtreeTombstoneFacts,
): Promise<void> {
  const rows = await transaction.selectFrom('nodes').select([
    'id', 'kind', 'resource_revision', 'deleted_at', 'deleted_commit_ordinal', 'payload_json',
  ]).where('collection_id', '=', facts.collectionId)
    .where('deleted_commit_ordinal', '=', facts.commitOrdinal)
    .orderBy('id')
    .execute();
  const deletedAt = rows[0]?.deleted_at;
  if (!(deletedAt instanceof Date) || rows.length < 1 || !rows.some((row) => row.id === facts.rootTargetId)) {
    throw new Error('MCP delete subtree wrote no sync tombstone members.');
  }
  if (rows.some((row) => !(row.deleted_at instanceof Date)
      || row.deleted_at.getTime() !== deletedAt.getTime()
      || BigInt(row.deleted_commit_ordinal ?? 0) !== facts.commitOrdinal
      || (row.kind !== 'folder' && row.kind !== 'bookmark' && row.kind !== 'separator'))) {
    throw new Error('MCP delete subtree tombstone members are inconsistent.');
  }
  const root = rows.find((row) => row.id === facts.rootTargetId);
  if (!root || (root.kind !== 'folder' && rows.length !== 1)) {
    throw new Error('MCP delete subtree tombstone members do not match their root.');
  }
  try {
    await createPostgresSyncNodeTombstonePort(transaction).append({
      collectionId: facts.collectionId,
      rootTargetId: facts.rootTargetId,
      operationId: facts.operationId,
      scope: root.kind === 'folder' ? 'subtree' : 'single',
      deleteCommitOrdinal: facts.commitOrdinal,
      deleteCursor: `sync-delete-${facts.commitOrdinal}`,
      deletedAt,
      purgeAfter: new Date(deletedAt.getTime() + NODE_DELETION_PURGE_RETENTION_MS),
      members: rows.map((row) => ({
        targetId: row.id,
        kind: row.kind,
        deleteRevision: row.resource_revision,
        extensions: ((row.payload_json?.extensions ?? {}) as JsonObject),
      })),
    });
  } catch (error) {
    if (error instanceof SyncNodeTombstonePersistenceError) {
      throw new Error(`MCP delete subtree tombstone persistence failed: ${error.code}`);
    }
    throw error;
  }
}
