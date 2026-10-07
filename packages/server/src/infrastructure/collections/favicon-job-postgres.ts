/**
 * FO-02 favicon job + GC PostgreSQL adapters.
 *
 * Two boundaries:
 *
 * - transaction-scoped write/read ports used by the enqueue command and the
 *   worker's verify/CAS unit of work;
 * - a pool-scoped worker repository implementing the existing lease pattern
 *   (claimDue / expiry re-claim / lease-fenced outcome writes), so a restarted
 *   worker reclaims overdue work and duplicate consumption is impossible.
 */
import type { Pool } from 'pg';
import type { FaviconRestoreReadObserver } from './favicon-restore-scan-postgres.js';
import { sql, type Kysely } from 'kysely';
import {
  type FaviconGcWritePort,
  type FaviconJobClaim,
  type FaviconJobErrorReason,
  type FaviconJobInsert,
  type FaviconJobOperation,
  type FaviconJobReadPort,
  type FaviconJobRecord,
  type FaviconJobStatus,
  type FaviconJobWorkerPort,
  type FaviconJobWritePort,
  type FaviconRefreshCasPorts,
} from '../../modules/collections/index.js';
import {
  type FaviconBatchCasPorts,
} from '../../modules/collections/index.js';
import {
  createPostgresBookmarkIconWritePort,
} from './bookmark-icon-postgres.js';
import { createPostgresCollectionWritePort, createPostgresNodeWritePort } from './repositories.js';
import { createPostgresFaviconPolicyPort } from './favicon-policy-postgres.js';
import { createPostgresFaviconSourcePort } from './favicon-source-postgres.js';
import {
  createPostgresFaviconBatchItemPort,
  createPostgresFaviconRestoreWritePort,
} from './favicon-job-items-postgres.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

interface JobRow {
  id: string;
  account_id: string;
  owner_subject_id: string;
  operation: 'refresh_one' | 'fill_missing' | 'refresh_online' | 'apply_force_online' | 'restore_sources';
  policy_revision: string;
  status: FaviconJobStatus;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  error_node_id: string | null;
  error_reason: FaviconJobErrorReason | null;
  collection_id: string | null;
  node_id: string | null;
  source_url: string | null;
  source_revision: string | null;
  node_resource_revision: string | null;
  object_id: string | null;
  object_content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/x-icon' | null;
  object_byte_size: number | null;
  object_digest_sha256: Buffer | null;
  attempts: number;
  next_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
  lease_owner: string | null;
  lease_until: Date | null;
}

export function mapJob(row: JobRow): FaviconJobRecord {
  return Object.freeze({
    jobId: row.id,
    accountId: row.account_id,
    ownerSubjectId: row.owner_subject_id,
    operation: row.operation,
    policyRevision: BigInt(row.policy_revision),
    status: row.status,
    total: row.total,
    succeeded: row.succeeded,
    failed: row.failed,
    skipped: row.skipped,
    errorNodeId: row.error_node_id,
    errorReason: row.error_reason,
    collectionId: row.collection_id,
    nodeId: row.node_id,
    sourceUrl: row.source_url,
    sourceRevision: row.source_revision === null ? null : BigInt(row.source_revision),
    nodeResourceRevision: row.node_resource_revision,
    objectId: row.object_id,
    objectContentType: row.object_content_type,
    objectByteSize: row.object_byte_size,
    objectDigestSha256: row.object_digest_sha256 === null ? null : Buffer.from(row.object_digest_sha256),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
  });
}

const JOB_COLUMNS = sql`
  id, account_id, owner_subject_id, operation, policy_revision, status, total,
  succeeded, failed, skipped, error_node_id, error_reason, collection_id, node_id,
  source_url, source_revision, node_resource_revision, object_id,
  object_content_type, object_byte_size, object_digest_sha256, attempts,
  next_attempt_at, created_at, updated_at, lease_owner, lease_until
`;

export { JOB_COLUMNS };

/** FO-03 batch insert: any batch operation with a total. */
export async function insertFaviconJobRow(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
  input: {
    readonly jobId: string;
    readonly accountId: string;
    readonly ownerSubjectId: string;
    readonly operation: 'fill_missing' | 'refresh_online' | 'apply_force_online' | 'restore_sources';
    readonly policyRevision: bigint;
    readonly total: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  },
): Promise<void> {
  await sql`
    insert into favicon_jobs (
      id, account_id, owner_subject_id, operation, policy_revision, status,
      total, succeeded, failed, skipped, attempts, next_attempt_at,
      created_at, updated_at
    ) values (
      ${input.jobId}, ${input.accountId}, ${input.ownerSubjectId}, ${input.operation},
      ${input.policyRevision.toString()}, 'pending', ${input.total}, 0, 0, 0, 0, null,
      ${input.createdAt}, ${input.updatedAt}
    )
  `.execute(transaction);
}

export function createPostgresFaviconJobWritePort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): FaviconJobWritePort {
  return Object.freeze({
    async insert(input: FaviconJobInsert) {
      await sql`
        insert into favicon_jobs (
          id, account_id, owner_subject_id, operation, policy_revision, status,
          total, succeeded, failed, skipped, collection_id, node_id, source_url,
          source_revision, node_resource_revision, attempts, next_attempt_at,
          created_at, updated_at
        ) values (
          ${input.jobId}, ${input.accountId}, ${input.ownerSubjectId}, 'refresh_one',
          ${input.policyRevision.toString()}, 'pending', 1, 0, 0, 0,
          ${input.collectionId}, ${input.nodeId}, ${input.sourceUrl},
          ${input.sourceRevision.toString()}, ${input.nodeResourceRevision}, 0, null,
          ${input.createdAt}, ${input.updatedAt}
        )
      `.execute(transaction);
    },
    async findByJobId(jobId: string) {
      const row = (await sql<JobRow>`
        select ${JOB_COLUMNS} from favicon_jobs where id = ${jobId}
      `.execute(transaction)).rows[0];
      return row === undefined ? null : mapJob(row);
    },
    async lockByJobId(jobId: string) {
      const row = (await sql<JobRow>`
        select ${JOB_COLUMNS} from favicon_jobs where id = ${jobId} for update
      `.execute(transaction)).rows[0];
      return row === undefined ? null : mapJob(row);
    },
    async setObjectId(input: { readonly jobId: string; readonly objectId: string; readonly updatedAt: Date }) {
      await transaction.updateTable('favicon_jobs')
        .set({ object_id: input.objectId, updated_at: input.updatedAt })
        .where('id', '=', input.jobId)
        .execute();
    },
    async setObjectMetadata(input: {
      readonly jobId: string;
      readonly objectId: string;
      readonly contentType: string;
      readonly byteSize: number;
      readonly digestSha256: Buffer;
      readonly updatedAt: Date;
    }) {
      // Only canonical raster MIME values are ever written (magic-sniffed);
      // the DB CHECK constraint backstops this at write time.
      await transaction.updateTable('favicon_jobs')
        .set({
          object_id: input.objectId,
          object_content_type: input.contentType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/x-icon',
          object_byte_size: input.byteSize,
          object_digest_sha256: input.digestSha256,
          updated_at: input.updatedAt,
        })
        .where('id', '=', input.jobId)
        .execute();
    },
  });
}

export function createPostgresFaviconJobReadPort(
  db: DatabaseTransaction | Kysely<DatabaseSchema>,
): FaviconJobReadPort {
  return Object.freeze({
    async latestForNode(nodeId: string) {
      // refresh_one rows carry the node directly; batch items join the parent
      // job (FO-03) so a node covered by a fill/refresh/force/restore job
      // projects pending/failed/ready through the same read port.
      //
      // F-A3: SUCCEEDED batch items participate in the union too. Before, only
      // ('pending','running','failed') item rows were included, so an online
      // node whose newest work was a SUCCEEDED batch capture but which also has
      // an older FAILED refresh_one row projected 'failed' forever. The
      // created_at desc ordering keeps the newest row winning; id desc breaks
      // exact-timestamp ties deterministically.
      const row = (await sql<{ status: FaviconJobStatus; operation: 'refresh_one' | 'fill_missing' | 'refresh_online' | 'apply_force_online' | 'restore_sources' }>`
        select status, operation from (
          (
            select j.status, j.operation, j.created_at, j.id
            from favicon_jobs j
            where j.node_id = ${nodeId}
          )
          union all
          (
            select j.status, j.operation, j.created_at, j.id
            from favicon_job_items it
            join favicon_jobs j on j.id = it.job_id
            where it.node_id = ${nodeId}
              and it.status in ('pending', 'running', 'failed', 'succeeded')
          )
        ) latest
        order by created_at desc, id desc
        limit 1
      `.execute(db)).rows[0];
      return row === undefined
        ? null
        : { status: row.status, operation: row.operation };
    },
  });
}

export function createPostgresFaviconGcWritePort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): FaviconGcWritePort {
  return Object.freeze({
    async recordRetired(input: {
      readonly objectId: string;
      readonly nodeId: string;
      readonly collectionId: string;
      readonly retiredAt: Date;
      readonly deletableAt: Date;
    }) {
      // Keep the earliest exit-of-reference window on conflict; an object can
      // only leave live reference once (object ids are never rebound).
      await transaction.insertInto('favicon_pending_deletions')
        .values({
          object_id: input.objectId,
          node_id: input.nodeId,
          collection_id: input.collectionId,
          retired_at: input.retiredAt,
          deletable_at: input.deletableAt,
          attempts: 0,
          last_error: null,
          next_attempt_at: input.deletableAt,
          lease_owner: null,
          lease_until: null,
          created_at: input.retiredAt,
        })
        .onConflict((oc) => oc.column('object_id').doNothing())
        .execute();
    },
  });
}

// ---------------------------------------------------------------------------
// Worker repository (pool-scoped lease pattern)
// ---------------------------------------------------------------------------

interface ClaimRow {
  id: string;
  account_id: string;
  owner_subject_id: string;
  operation: FaviconJobOperation;
  status: FaviconJobStatus;
  attempts: number;
  collection_id: string;
  node_id: string;
  source_url: string;
  source_revision: string;
  policy_revision: string;
  node_resource_revision: string;
  object_id: string | null;
  lease_owner: string;
}

function mapClaim(row: ClaimRow): FaviconJobClaim {
  return Object.freeze({
    jobId: row.id,
    leaseOwner: row.lease_owner,
    accountId: row.account_id,
    ownerSubjectId: row.owner_subject_id,
    operation: row.operation,
    status: row.status,
    attempts: row.attempts,
    collectionId: row.collection_id,
    nodeId: row.node_id,
    sourceUrl: row.source_url,
    sourceRevision: row.source_revision,
    policyRevision: row.policy_revision,
    nodeResourceRevision: row.node_resource_revision,
    objectId: row.object_id,
  });
}

const CLAIM_RETURN = `
  job.id, job.account_id, job.owner_subject_id, job.operation, job.status, job.attempts,
  job.collection_id, job.node_id, job.source_url, job.source_revision,
  job.policy_revision, job.node_resource_revision, job.object_id, job.lease_owner
`;

export function createPostgresFaviconJobWorkerRepository(pool: Pool): {
  claimDue(input: { readonly limit: number; readonly leaseOwner: string; readonly leaseDurationMs: number }): Promise<readonly FaviconJobClaim[]>;
  expireOverdue(input: { readonly limit: number; readonly leaseOwner: string; readonly leaseDurationMs: number }): Promise<readonly FaviconJobClaim[]>;
  readonly worker: FaviconJobWorkerPort;
} {
  async function claim(input: {
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseDurationMs: number;
    readonly overdueOnly: boolean;
  }): Promise<readonly FaviconJobClaim[]> {
    const predicate = input.overdueOnly
      ? `status = 'running' AND lease_until IS NOT NULL AND lease_until < current_timestamp`
      : `status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= current_timestamp)
         AND (lease_until IS NULL OR lease_until < current_timestamp)`;
    const result = await pool.query<ClaimRow>(`
      WITH candidates AS (
        SELECT id
        FROM favicon_jobs
        WHERE ${predicate}
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE favicon_jobs AS job
      SET status = 'running',
          lease_owner = $2,
          lease_until = current_timestamp + ($3 * interval '1 millisecond'),
          updated_at = current_timestamp
      FROM candidates
      WHERE job.id = candidates.id
        AND (job.lease_until IS NULL OR job.lease_until < current_timestamp)
      RETURNING ${CLAIM_RETURN}
    `, [input.limit, input.leaseOwner, input.leaseDurationMs]);
    return Object.freeze(result.rows.map(mapClaim));
  }

  async function leasedUpdate(
    query: string,
    parameters: unknown[],
  ): Promise<boolean> {
    const result = await pool.query(query, parameters);
    return (result.rowCount ?? 0) === 1;
  }

  const worker: FaviconJobWorkerPort = Object.freeze({
    async markRunning(input: { readonly jobId: string; readonly leaseOwner: string }) {
      return leasedUpdate(`
        UPDATE favicon_jobs
        SET updated_at = current_timestamp
        WHERE id = $1 AND lease_owner = $2 AND lease_until > current_timestamp
          AND status IN ('pending', 'running')
        RETURNING id
      `, [input.jobId, input.leaseOwner]);
    },
    async scheduleRetry(input: {
      readonly jobId: string;
      readonly leaseOwner: string;
      readonly attempts: number;
      readonly nextAttemptAt: Date;
      readonly errorNodeId: string;
      readonly errorReason: FaviconJobErrorReason;
    }) {
      return leasedUpdate(`
        UPDATE favicon_jobs
        SET status = 'pending',
            attempts = $3,
            next_attempt_at = $4,
            error_node_id = $5,
            error_reason = $6,
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = current_timestamp
        WHERE id = $1 AND lease_owner = $2 AND lease_until > current_timestamp
        RETURNING id
      `, [input.jobId, input.leaseOwner, input.attempts, input.nextAttemptAt,
        input.errorNodeId, input.errorReason]);
    },
    async markFailed(input: {
      readonly jobId: string;
      readonly leaseOwner: string;
      readonly attempts: number;
      readonly errorNodeId: string;
      readonly errorReason: FaviconJobErrorReason;
    }) {
      return leasedUpdate(`
        UPDATE favicon_jobs
        SET status = 'failed',
            failed = 1,
            attempts = $3,
            error_node_id = $4,
            error_reason = $5,
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = current_timestamp
        WHERE id = $1 AND lease_owner = $2 AND lease_until > current_timestamp
        RETURNING id
      `, [input.jobId, input.leaseOwner, input.attempts, input.errorNodeId, input.errorReason]);
    },
    async markSucceeded(input: { readonly jobId: string; readonly leaseOwner: string; readonly completedAt: Date }) {
      return leasedUpdate(`
        UPDATE favicon_jobs
        SET status = 'succeeded',
            succeeded = 1,
            failed = 0,
            error_node_id = NULL,
            error_reason = NULL,
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = $3
        WHERE id = $1 AND lease_owner = $2 AND lease_until > current_timestamp
        RETURNING id
      `, [input.jobId, input.leaseOwner, input.completedAt]);
    },
    async renewLease(input: {
      readonly jobId: string;
      readonly leaseOwner: string;
      readonly leaseDurationMs: number;
    }) {
      // FO-08: renew succeeds while we still OWN the job — a lapsed-but-owned
      // lease is re-armed, not abandoned (a single slow item must not throw
      // away the rest of the cycle). Only losing ownership (another worker
      // re-claimed the expired job) is a lost lease: the claim SQL still
      // fences `lease_until < now`, so a concurrent takeover and this renew
      // resolve atomically — one of them wins, never both.
      return leasedUpdate(`
        UPDATE favicon_jobs
        SET lease_until = current_timestamp + ($3 * interval '1 millisecond'),
            updated_at = current_timestamp
        WHERE id = $1 AND lease_owner = $2
        RETURNING id
      `, [input.jobId, input.leaseOwner, input.leaseDurationMs]);
    },
    async updateBatch(input: {
      readonly jobId: string;
      readonly leaseOwner: string;
      readonly status: 'pending' | 'succeeded' | 'partial' | 'failed';
      readonly succeeded: number;
      readonly failed: number;
      readonly skipped: number;
      readonly nextAttemptAt: Date | null;
      readonly updatedAt: Date;
    }) {
      return leasedUpdate(`
        UPDATE favicon_jobs
        SET status = $3,
            succeeded = $4,
            failed = $5,
            skipped = $6,
            next_attempt_at = $7,
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = $8
        WHERE id = $1 AND lease_owner = $2 AND lease_until > current_timestamp
          AND status IN ('pending', 'running')
        RETURNING id
      `, [input.jobId, input.leaseOwner, input.status, input.succeeded, input.failed,
        input.skipped, input.nextAttemptAt, input.updatedAt]);
    },
  });

  return Object.freeze({
    claimDue(input) {
      return claim({ ...input, overdueOnly: false });
    },
    expireOverdue(input) {
      return claim({ ...input, overdueOnly: true });
    },
    worker,
  });
}

/** Worker unit of work: verify/CAS ports over one READ COMMITTED transaction. */
export function createPostgresFaviconJobWorkerUnitOfWork(
  db: Kysely<DatabaseSchema>,
  observeRestoreRead?: FaviconRestoreReadObserver,
): { run<T>(work: (ports: FaviconBatchCasPorts) => Promise<T>): Promise<T> } {
  return Object.freeze({
    run<T>(work: (ports: FaviconBatchCasPorts) => Promise<T>): Promise<T> {
      return createUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => work({
          jobs: createPostgresFaviconJobWritePort(transaction),
          gc: createPostgresFaviconGcWritePort(transaction),
          collections: createPostgresCollectionWritePort(transaction),
          nodes: createPostgresNodeWritePort(transaction),
          sources: createPostgresFaviconSourcePort(transaction),
          policies: createPostgresFaviconPolicyPort(transaction),
          bookmarkIcons: createPostgresBookmarkIconWritePort(transaction),
          items: createPostgresFaviconBatchItemPort(transaction, observeRestoreRead),
          restores: createPostgresFaviconRestoreWritePort(transaction),
        }));
    },
  });
}