import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  freezeReadableReplicaEtag,
  type ReadableReplicaFailureCode,
  type ReadableReplicaSection,
  type ReadableReplicaStoredStatus,
} from '../../modules/collections/index.js';

export interface ReadableReplicaClaim {
  readonly nodeId: string;
  readonly url: string;
  readonly leaseOwner: string;
}

export interface ReadableReplicaCompleteInput {
  readonly nodeId: string;
  readonly leaseOwner: string;
  readonly status: ReadableReplicaStoredStatus;
  readonly sourceUrl: string;
  readonly title: string | null;
  readonly byline: string | null;
  readonly wordCount: number;
  readonly sections: readonly ReadableReplicaSection[];
  readonly failureCode: ReadableReplicaFailureCode | null;
  readonly extractedAt: Date | null;
  readonly updatedAt: Date;
}

export interface ReadableReplicaWorkerRepository {
  claimDue(input: {
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseDurationMs: number;
  }): Promise<readonly ReadableReplicaClaim[]>;
  completeExtract(input: ReadableReplicaCompleteInput): Promise<boolean>;
}

interface ClaimRow {
  node_id: string;
  url: string;
  lease_owner: string;
}

export function createPostgresReadableReplicaWorkerRepository(
  pool: Pool,
): ReadableReplicaWorkerRepository {
  return Object.freeze({
    async claimDue(input: {
      readonly limit: number;
      readonly leaseOwner: string;
      readonly leaseDurationMs: number;
    }): Promise<readonly ReadableReplicaClaim[]> {
      const result = await pool.query<ClaimRow>(`
        WITH candidates AS (
          SELECT r.node_id
          FROM collection_readable_replicas AS r
          INNER JOIN nodes AS n ON n.id = r.node_id AND r.collection_id = n.collection_id
          INNER JOIN collections AS c ON c.id = n.collection_id
          WHERE r.status = 'pending'
            AND (r.lease_until IS NULL OR r.lease_until < current_timestamp)
            AND n.deleted_at IS NULL
            AND c.deleted_at IS NULL
            AND n.kind = 'bookmark'
            AND n.url IS NOT NULL
            AND n.url <> ''
          ORDER BY r.lease_until NULLS FIRST, n.id
          FOR UPDATE OF r SKIP LOCKED
          LIMIT $1
        )
        UPDATE collection_readable_replicas AS replica
        SET lease_owner = $2,
            lease_until = current_timestamp + ($3 * interval '1 millisecond')
        FROM candidates
        INNER JOIN nodes AS n ON n.id = candidates.node_id
        WHERE replica.node_id = candidates.node_id
          AND replica.status = 'pending'
          AND (replica.lease_until IS NULL OR replica.lease_until < current_timestamp)
        RETURNING replica.node_id, n.url, replica.lease_owner
      `, [input.limit, `${input.leaseOwner}:${randomUUID()}`, input.leaseDurationMs]);
      return Object.freeze(result.rows.flatMap((row): ReadableReplicaClaim[] => {
        if (row.url === null || row.url === '') return [];
        return [Object.freeze({
          nodeId: row.node_id, url: row.url, leaseOwner: row.lease_owner,
        })];
      }));
    },

    async completeExtract(input: ReadableReplicaCompleteInput): Promise<boolean> {
      const etag = freezeReadableReplicaEtag({
        nodeId: input.nodeId,
        status: input.status,
        sourceUrl: input.sourceUrl,
        extractedAt: input.extractedAt,
        sections: input.sections,
      });
      const result = await pool.query(`
        UPDATE collection_readable_replicas AS r
        SET status = $3,
            source_url = $4,
            title = $5,
            byline = $6,
            word_count = $7,
            sections = $8::jsonb,
            failure_code = $9,
            etag = $10,
            extracted_at = $11,
            updated_at = $12,
            lease_owner = NULL,
            lease_until = NULL
        WHERE r.node_id = $1
          AND r.lease_owner = $2
          AND r.lease_until IS NOT NULL
          AND r.lease_until > current_timestamp
          AND r.status = 'pending'
        RETURNING r.node_id
      `, [
        input.nodeId,
        input.leaseOwner,
        input.status,
        input.sourceUrl,
        input.title,
        input.byline,
        input.wordCount,
        JSON.stringify(input.sections),
        input.failureCode,
        etag,
        input.extractedAt,
        input.updatedAt,
      ]);
      return result.rowCount === 1;
    },
  });
}
