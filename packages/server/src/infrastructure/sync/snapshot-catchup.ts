import { CompiledQuery } from 'kysely';
import type { PoolClient } from 'pg';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/** Content drift is safe only when every intervening content revision has a
 * retained authoritative Pull event. Policy, binding and lease checks stay at
 * the callers. Legacy snapshots without a pinned ordinal remain strict. */
export async function snapshotCanCatchUp(db: PoolClient | DatabaseTransaction,
  collectionId: string, document: unknown): Promise<boolean> {
  const ordinal = document && typeof document === 'object'
    ? (document as { sourceCommitOrdinal?: unknown }).sourceCommitOrdinal : undefined;
  if (typeof ordinal !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(ordinal)) return false;
  const query = `SELECT EXISTS (
    SELECT 1 FROM collections c JOIN sync_history_floors f ON f.collection_id=c.id
    WHERE c.id=$1 AND c.commit_ordinal >= $2::bigint AND f.floor_commit_ordinal < $2::bigint
      AND EXISTS (SELECT 1 FROM content_revisions r WHERE r.collection_id=c.id
        AND r.revision=c.content_revision AND r.ordinal >= $2::bigint)
      AND NOT EXISTS (SELECT 1 FROM content_revisions r WHERE r.collection_id=c.id
        AND r.ordinal > $2::bigint AND r.ordinal <= c.commit_ordinal
        AND NOT EXISTS (SELECT 1 FROM operations o JOIN sync_operation_effects e
          ON e.operation_id=o.operation_id AND e.collection_id=o.collection_id
          WHERE o.collection_id=c.id AND o.commit_ordinal=r.ordinal AND o.sync_wire_present
            AND o.payload_source='hot' AND e.commit_ordinal=o.commit_ordinal))) AS allowed`;
  const parameters = [collectionId, ordinal];
  const result = 'executeQuery' in db
    ? await db.executeQuery<{ allowed: boolean }>(CompiledQuery.raw(query, parameters))
    : await db.query<{ allowed: boolean }>(query, parameters);
  return result.rows[0]?.allowed === true;
}
