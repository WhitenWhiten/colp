/**
 * FO-02 favicon GC reservoir adapter (pool-scoped lease pattern).
 *
 * The same claim predicate handles fresh and lease-expired records (a crashed
 * GC run's lease simply expires and the record becomes claimable again), so
 * no separate expiry pass is required. The reference recheck runs inside the
 * claim processing right before the destructive delete.
 */
import type { Pool } from 'pg';
import {
  type FaviconGcClaim,
  type FaviconGcWorkerRepository,
} from '../../modules/collections/index.js';

interface GcClaimRow {
  object_id: string;
  node_id: string;
  collection_id: string;
  deletable_at: Date;
  attempts: number;
  lease_owner: string;
}

function mapGcClaim(row: GcClaimRow): FaviconGcClaim {
  return Object.freeze({
    objectId: row.object_id,
    leaseOwner: row.lease_owner,
    nodeId: row.node_id,
    collectionId: row.collection_id,
    deletableAt: row.deletable_at,
    attempts: row.attempts,
  });
}

export function createPostgresFaviconGcRepository(pool: Pool): {
  claimDue(input: { readonly limit: number; readonly leaseOwner: string; readonly leaseDurationMs: number }): Promise<readonly FaviconGcClaim[]>;
  readonly repository: FaviconGcWorkerRepository;
} {
  async function claimDue(input: {
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseDurationMs: number;
  }): Promise<readonly FaviconGcClaim[]> {
    const result = await pool.query<GcClaimRow>(`
      WITH candidates AS (
        SELECT object_id
        FROM favicon_pending_deletions
        WHERE deletable_at <= current_timestamp
          AND next_attempt_at <= current_timestamp
          AND (lease_until IS NULL OR lease_until < current_timestamp)
        ORDER BY deletable_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE favicon_pending_deletions AS record
      SET lease_owner = $2,
          lease_until = current_timestamp + ($3 * interval '1 millisecond')
      FROM candidates
      WHERE record.object_id = candidates.object_id
        AND (record.lease_until IS NULL OR record.lease_until < current_timestamp)
      RETURNING record.object_id, record.node_id, record.collection_id,
                record.deletable_at, record.attempts, record.lease_owner
    `, [input.limit, input.leaseOwner, input.leaseDurationMs]);
    return Object.freeze(result.rows.map(mapGcClaim));
  }

  const repository: FaviconGcWorkerRepository = Object.freeze({
    async isObjectReferenced(objectId: string) {
      const result = await pool.query<{ referenced: boolean }>(`
        SELECT (
          EXISTS (SELECT 1 FROM bookmark_icons WHERE object_id = $1)
          OR EXISTS (
            SELECT 1 FROM favicon_jobs
            WHERE object_id = $1 AND status IN ('pending', 'running')
          )
          -- FO-03: in-flight batch items and force-restore originals are hard
          -- references (current / non-expired history / force-restore
          -- references are never collected).
          OR EXISTS (
            SELECT 1 FROM favicon_job_items it
            JOIN favicon_jobs j ON j.id = it.job_id
            WHERE it.object_id = $1 AND j.status IN ('pending', 'running')
          )
          OR EXISTS (
            SELECT 1 FROM favicon_source_restores r WHERE r.original_object_id = $1
          )
        ) AS referenced
      `, [objectId]);
      return result.rows[0]?.referenced === true;
    },
    async markDeleted(input: { readonly objectId: string; readonly leaseOwner: string }) {
      const result = await pool.query(`
        DELETE FROM favicon_pending_deletions
        WHERE object_id = $1 AND lease_owner = $2 AND lease_until > current_timestamp
        RETURNING object_id
      `, [input.objectId, input.leaseOwner]);
      return (result.rowCount ?? 0) === 1;
    },
    async scheduleRetry(input: {
      readonly objectId: string;
      readonly leaseOwner: string;
      readonly attempts: number;
      readonly lastError: string;
      readonly nextAttemptAt: Date;
    }) {
      const result = await pool.query(`
        UPDATE favicon_pending_deletions
        SET attempts = $3,
            last_error = $4,
            next_attempt_at = $5,
            lease_owner = NULL,
            lease_until = NULL
        WHERE object_id = $1 AND lease_owner = $2 AND lease_until > current_timestamp
        RETURNING object_id
      `, [input.objectId, input.leaseOwner, input.attempts, input.lastError, input.nextAttemptAt]);
      return (result.rowCount ?? 0) === 1;
    },
  });

  return Object.freeze({ claimDue, repository });
}