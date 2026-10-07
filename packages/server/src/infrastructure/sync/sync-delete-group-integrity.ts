import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/** Every immutable original member needs exactly one matching disposition. */
export async function hasCompleteDeleteGroup(
  tx: DatabaseTransaction,
  collectionId: string,
  operationId: string,
  affectedCount: number,
): Promise<boolean> {
  const result = await sql<{ valid: boolean }>`
    SELECT count(*) = ${affectedCount} AND bool_and(
      m.affected_count = ${affectedCount}
      AND ((t.target_id IS NOT NULL)::int + (r.target_id IS NOT NULL)::int) = 1
      AND (t.target_id IS NULL OR (t.delete_revision = m.delete_revision
        AND t.delete_commit_ordinal = m.delete_commit_ordinal
        AND t.affected_count = m.affected_count))
    ) AS valid
    FROM sync_delete_group_members m
    LEFT JOIN sync_node_tombstones t ON t.collection_id=m.collection_id
      AND t.operation_id=m.operation_id AND t.target_id=m.target_id
    LEFT JOIN sync_restored_tombstones r ON r.collection_id=m.collection_id
      AND r.operation_id=m.operation_id AND r.target_id=m.target_id
    WHERE m.collection_id=${collectionId} AND m.operation_id=${operationId}
  `.execute(tx);
  return result.rows[0]?.valid === true;
}
