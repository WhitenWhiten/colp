import type { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import {
  type EnqueueMyLinkHealthChecksPorts,
  type LinkHealthChecksWritePort,
  type LinkHealthProbeFact,
} from '../../modules/collections/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { type DatabaseTransaction } from '../database/unit-of-work.js';
import { createRequestUnitOfWork } from '../database/request-unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

export interface LinkHealthClaim {
  readonly nodeId: string;
  readonly url: string;
  readonly leaseOwner: string;
}

export interface LinkHealthWorkerRepository {
  claimDue(input: {
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseDurationMs: number;
  }): Promise<readonly LinkHealthClaim[]>;
  completeProbe(input: {
    readonly nodeId: string;
    readonly leaseOwner: string;
    readonly fact: LinkHealthProbeFact;
    readonly checkedAt: Date;
  }): Promise<boolean>;
}

interface ClaimRow {
  node_id: string;
  url: string;
  lease_owner: string;
}

/**
 * A single user command must never turn into an unbounded write.  The
 * collection and owner filters are intentionally still optional for backwards
 * compatibility with the existing client, so the database write itself is
 * capped.  Clients can issue another command to continue a large sweep.
 */
export const LINK_HEALTH_CHECKS_MAX_QUEUE_ROWS = 500;

export function createPostgresLinkHealthChecksWritePort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): LinkHealthChecksWritePort {
  return Object.freeze({
    async markOwnedPending(input: {
      readonly ownerSubjectId: string;
      readonly nodeIds?: readonly string[];
      readonly collectionId?: string;
    }): Promise<number> {
      if (input.nodeIds !== undefined && input.nodeIds.length === 0) return 0;
      const result = await sql<{ node_id: string }>`
        WITH candidates AS (
          SELECT h.node_id, h.collection_id
          FROM collection_link_health AS h
          INNER JOIN nodes AS n ON n.id = h.node_id AND h.collection_id = n.collection_id
          INNER JOIN collections AS c ON c.id = n.collection_id
          WHERE c.deleted_at IS NULL
            AND n.deleted_at IS NULL
            AND n.kind = 'bookmark'
            AND n.url IS NOT NULL
            AND n.url <> ''
            -- Never reset a row while a worker owns a live lease.  An
            -- expired lease is eligible for the next bounded sweep.
            AND (h.lease_until IS NULL OR h.lease_until < current_timestamp)
            AND (
              (
                ${input.collectionId ?? null}::text IS NULL
                AND c.owner_subject_id = ${input.ownerSubjectId}
              )
              OR (
                ${input.collectionId ?? null}::text IS NOT NULL
                AND n.collection_id = ${input.collectionId ?? null}
                AND (
                  c.owner_subject_id = ${input.ownerSubjectId}
                  OR EXISTS (
                    SELECT 1
                    FROM collection_members AS m
                    WHERE m.collection_id = c.id
                      AND m.subject_id = ${input.ownerSubjectId}
                      AND m.role = 'editor'
                  )
                )
              )
            )
            AND (${input.nodeIds ?? null}::text[] IS NULL OR n.id = ANY(${input.nodeIds ?? null}::text[]))
          ORDER BY h.node_id COLLATE "C" ASC
          FOR UPDATE OF h SKIP LOCKED
          LIMIT ${LINK_HEALTH_CHECKS_MAX_QUEUE_ROWS}
        )
        UPDATE collection_link_health AS h
        SET status = 'pending',
            http_status = NULL,
            final_url = NULL,
            checked_at = NULL,
            error_class = NULL,
            lease_owner = NULL,
            lease_until = NULL
        FROM candidates
        WHERE h.node_id = candidates.node_id
          AND h.collection_id = candidates.collection_id
        RETURNING h.node_id
      `.execute(transaction);
      return result.rows.length;
    },
  });
}

export function createPostgresLinkHealthEnqueueUnitOfWork(
  db: Kysely<DatabaseSchema>,
): {
  execute<Result>(
    work: (ports: EnqueueMyLinkHealthChecksPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
} {
  return Object.freeze({
    execute<Result>(
      work: (ports: EnqueueMyLinkHealthChecksPorts) => Promise<Result>,
      request: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      return createRequestUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => work({
          receipts: createPostgresProductCommandReceiptPort(transaction),
          checks: createPostgresLinkHealthChecksWritePort(transaction),
        }), request);
    },
  });
}

export function createPostgresLinkHealthWorkerRepository(pool: Pool): LinkHealthWorkerRepository {
  return Object.freeze({
    async claimDue(input: {
      readonly limit: number;
      readonly leaseOwner: string;
      readonly leaseDurationMs: number;
    }): Promise<readonly LinkHealthClaim[]> {
      const result = await pool.query<ClaimRow>(`
        WITH candidates AS (
          SELECT h.node_id
          FROM collection_link_health AS h
          INNER JOIN nodes AS n ON n.id = h.node_id AND h.collection_id = n.collection_id
          WHERE h.status = 'pending'
            AND (h.lease_until IS NULL OR h.lease_until < current_timestamp)
            AND n.deleted_at IS NULL
            AND n.kind = 'bookmark'
            AND n.url IS NOT NULL
            AND n.url <> ''
          ORDER BY h.lease_until NULLS FIRST, n.id
          FOR UPDATE OF h SKIP LOCKED
          LIMIT $1
        )
        UPDATE collection_link_health AS health
        SET lease_owner = $2,
            lease_until = current_timestamp + ($3 * interval '1 millisecond')
        FROM candidates
        INNER JOIN nodes AS n ON n.id = candidates.node_id
        WHERE health.node_id = candidates.node_id
          AND health.status = 'pending'
          AND (health.lease_until IS NULL OR health.lease_until < current_timestamp)
        RETURNING health.node_id, n.url, health.lease_owner
      `, [input.limit, input.leaseOwner, input.leaseDurationMs]);
      return Object.freeze(result.rows.flatMap((row): LinkHealthClaim[] => {
        if (row.url === null || row.url === '') return [];
        return [Object.freeze({
          nodeId: row.node_id, url: row.url, leaseOwner: row.lease_owner,
        })];
      }));
    },

    async completeProbe(input: {
      readonly nodeId: string;
      readonly leaseOwner: string;
      readonly fact: LinkHealthProbeFact;
      readonly checkedAt: Date;
    }): Promise<boolean> {
      const result = await pool.query(`
        UPDATE collection_link_health AS h
        SET status = $3,
            http_status = $4,
            final_url = $5,
            checked_at = $6,
            error_class = $7,
            lease_owner = NULL,
            lease_until = NULL
        FROM nodes AS n
        WHERE h.node_id = $1
          AND h.lease_owner = $2
          AND h.lease_until IS NOT NULL
          AND h.lease_until > current_timestamp
          AND h.status = 'pending'
          AND n.id = h.node_id
          AND n.deleted_at IS NULL
          AND n.kind = 'bookmark'
          AND n.url IS NOT NULL
        RETURNING h.node_id
      `, [
        input.nodeId,
        input.leaseOwner,
        input.fact.status,
        input.fact.httpStatus,
        input.fact.finalUrl,
        input.checkedAt,
        input.fact.errorClass,
      ]);
      return result.rowCount === 1;
    },
  });
}
