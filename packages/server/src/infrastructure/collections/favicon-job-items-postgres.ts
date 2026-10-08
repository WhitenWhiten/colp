/**
 * FO-03 favicon batch job adapters: job+item+restore rows and the candidate
 * selector, all transaction-scoped over one DatabaseTransaction.
 *
 * The batch write port shares the favicon_jobs aggregate row with refresh_one
 * (see favicon-job-postgres.ts for the mapping) and owns the per-node item
 * ledger; the GC reference recheck additionally covers item object ids and
 * force-restore originals (favicon-gc-postgres.ts).
 */
import { sql, type Kysely } from 'kysely';
import type {
  FaviconBatchCandidate,
  FaviconBatchCandidatePort,
  FaviconBatchItemWritePort,
  FaviconBatchJobOperation,
  FaviconBatchJobReadPort,
  FaviconBatchJobWritePort,
  FaviconJobErrorReason,
  FaviconJobItemInsert,
  FaviconJobItemRow,
  FaviconJobRecord,
  FaviconRestoreGapWritePort,
  FaviconSourceRestoreReadPort,
  FaviconSourceRestoreRow,
  FaviconSourceRestoreWritePort,
} from '../../modules/collections/index.js';
import { insertFaviconJobRow, JOB_COLUMNS, mapJob } from './favicon-job-postgres.js';
import {
  aggregateFaviconJobItems,
  extendFaviconRestoreGeneration,
  insertFaviconRestoreGapPage,
  type FaviconRestoreReadObserver,
} from './favicon-restore-scan-postgres.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

interface ItemRow {
  job_id: string;
  node_id: string;
  collection_id: string;
  source_url: string;
  source_revision: string;
  node_resource_revision: string;
  status: FaviconJobItemRow['status'];
  error_reason: FaviconJobErrorReason | null;
  attempts: number;
  next_attempt_at: Date | null;
  object_id: string | null;
  object_content_type: string | null;
  object_byte_size: number | null;
  object_digest_sha256: Buffer | null;
  created_at: Date;
  updated_at: Date;
}

function mapItem(row: ItemRow): FaviconJobItemRow {
  return Object.freeze({
    jobId: row.job_id,
    nodeId: row.node_id,
    collectionId: row.collection_id,
    sourceUrl: row.source_url,
    sourceRevision: BigInt(row.source_revision),
    nodeResourceRevision: row.node_resource_revision,
    status: row.status,
    errorReason: row.error_reason,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    objectId: row.object_id,
    objectContentType: row.object_content_type,
    objectByteSize: row.object_byte_size,
    objectDigestSha256: row.object_digest_sha256 === null ? null : Buffer.from(row.object_digest_sha256),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies FaviconJobItemRow);
}

const ITEM_COLUMNS = sql`job_id, node_id, collection_id, source_url, source_revision,
  node_resource_revision, status, error_reason, attempts, next_attempt_at, object_id,
  object_content_type, object_byte_size, object_digest_sha256, created_at, updated_at`;

/**
 * FO-07: bounded multi-row INSERT batch for `favicon_job_items`. The enqueue
 * transaction must not issue one round trip per candidate (a 100k-node
 * library would serialize 100k statements inside the request transaction);
 * a statement is capped at 512 rows, staying far below the PostgreSQL
 * parameter budget (65535) per statement.
 */
export const FAVICON_JOB_ITEM_INSERT_BATCH = 512;

/** Account-wide enqueue cap. Remaining bookmarks are picked up on the next job via active-job exclusion. */
export const FAVICON_JOB_CANDIDATE_LIMIT = 10_000;

/** Tx-scoped batch job writes (enqueue + policy-triggered jobs). */
export function createPostgresFaviconBatchJobWritePort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
  observeRestoreRead?: FaviconRestoreReadObserver,
): FaviconBatchJobWritePort {
  return Object.freeze({
    async insertJob(input) {
      await insertFaviconJobRow(transaction, input);
    },
    async extendRestoreGeneration(input) {
      return extendFaviconRestoreGeneration(transaction, input, observeRestoreRead);
    },
    async insertItems(items) {
      if (items.length === 0) return;
      for (let offset = 0; offset < items.length; offset += FAVICON_JOB_ITEM_INSERT_BATCH) {
        await transaction.insertInto('favicon_job_items')
          .values(items.slice(offset, offset + FAVICON_JOB_ITEM_INSERT_BATCH).map((item) => ({
            job_id: item.jobId,
            node_id: item.nodeId,
            collection_id: item.collectionId,
            source_url: item.sourceUrl,
            // F-A5: source_revision is a bigint column. The old `Number(...)`
            // widening silently rounded values beyond 2^53. The exact decimal
            // TEXT is sent instead and Postgres casts it to bigint verbatim
            // (the same text-as-bigint convention every other bigint port in
            // this adapter uses); the `as unknown as number` cast only appeases
            // the Kysely schema type, which models the column as number.
            source_revision: item.sourceRevision.toString() as unknown as number,
            node_resource_revision: item.nodeResourceRevision,
            status: 'pending' as const,
            error_reason: null,
            attempts: 0,
            next_attempt_at: null,
            object_id: null,
            object_content_type: null,
            object_byte_size: null,
            object_digest_sha256: null,
            created_at: item.createdAt,
            updated_at: item.updatedAt,
          })))
          .execute();
      }
    },
    async findActiveBatchJob(accountId, operation) {
      const row = (await sql<JobQueryRow>`
        select ${JOB_COLUMNS} from favicon_jobs
        where account_id = ${accountId} and operation = ${operation}
          and status in ('pending', 'running')
        order by created_at desc, id desc
        limit 1
      `.execute(transaction)).rows[0];
      return row === undefined ? null : mapJob(row);
    },
    async supersedeActiveBatchJobs(accountId, options) {
      // FO-08: an unrelated strategy change keeps an ACTIVE restore_sources
      // job (its node items would otherwise go stale and the restore snapshot
      // would dangle forever — the original is then never restored).
      const keep = options?.keepOperation === undefined
        ? sql``
        : sql`and operation <> ${options.keepOperation}`;
      await sql`
        update favicon_jobs
        set status = 'superseded', lease_owner = null, lease_until = null,
            updated_at = current_timestamp
        where account_id = ${accountId} and status in ('pending', 'running')
          and operation <> 'refresh_one'
          ${keep}
      `.execute(transaction);
    },
    async findJobForAccount(jobId, accountId) {
      const row = (await sql<JobQueryRow>`
        select ${JOB_COLUMNS} from favicon_jobs
        where id = ${jobId} and account_id = ${accountId}
      `.execute(transaction)).rows[0];
      return row === undefined ? null : mapJob(row);
    },
  } satisfies FaviconBatchJobWritePort);
}

type JobQueryRow = {
  id: string;
  account_id: string;
  owner_subject_id: string;
  operation: FaviconJobRecord['operation'];
  policy_revision: string;
  status: FaviconJobRecord['status'];
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
};

/** Tx-scoped per-node item writes + reads (worker + read-back). */
export function createPostgresFaviconBatchItemPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
  observeRestoreRead?: FaviconRestoreReadObserver,
): FaviconBatchItemWritePort & FaviconBatchJobReadPort & FaviconRestoreGapWritePort {
  return Object.freeze({
    async findByJobAndNode(jobId, nodeId) {
      const row = (await sql<ItemRow>`
        select ${ITEM_COLUMNS} from favicon_job_items
        where job_id = ${jobId} and node_id = ${nodeId}
      `.execute(transaction)).rows[0];
      return row === undefined ? null : mapItem(row);
    },
    async markSkipped(jobId, nodeId, updatedAt) {
      await sql`
        update favicon_job_items
        set status = 'skipped', error_reason = null, next_attempt_at = null, updated_at = ${updatedAt}
        where job_id = ${jobId} and node_id = ${nodeId}
      `.execute(transaction);
    },
    async markFailed(jobId, nodeId, attempts, reason, updatedAt) {
      await sql`
        update favicon_job_items
        set status = 'failed', attempts = ${attempts}, error_reason = ${reason},
            next_attempt_at = null, updated_at = ${updatedAt}
        where job_id = ${jobId} and node_id = ${nodeId}
      `.execute(transaction);
    },
    async scheduleRetry(jobId, nodeId, attempts, nextAttemptAt, reason, updatedAt) {
      await sql`
        update favicon_job_items
        set status = 'pending', attempts = ${attempts}, error_reason = ${reason},
            next_attempt_at = ${nextAttemptAt}, updated_at = ${updatedAt}
        where job_id = ${jobId} and node_id = ${nodeId}
      `.execute(transaction);
    },
    async setObjectId(jobId, nodeId, objectId, updatedAt) {
      await sql`
        update favicon_job_items
        set object_id = ${objectId}, updated_at = ${updatedAt}
        where job_id = ${jobId} and node_id = ${nodeId}
      `.execute(transaction);
    },
    async setObjectMetadata(input) {
      await sql`
        update favicon_job_items
        set object_id = ${input.objectId},
            object_content_type = ${input.contentType}::text,
            object_byte_size = ${input.byteSize},
            object_digest_sha256 = ${input.digestSha256},
            updated_at = ${input.updatedAt}
        where job_id = ${input.jobId} and node_id = ${input.nodeId}
      `.execute(transaction);
    },
    async markSucceeded(jobId, nodeId, updatedAt) {
      await sql`
        update favicon_job_items
        set status = 'succeeded', error_reason = null, next_attempt_at = null, updated_at = ${updatedAt}
        where job_id = ${jobId} and node_id = ${nodeId}
      `.execute(transaction);
    },
    async listDueItems(input) {
      const rows = (await sql<ItemRow>`
        select ${ITEM_COLUMNS} from favicon_job_items
        where job_id = ${input.jobId}
          and status = 'pending'
          and (next_attempt_at is null or next_attempt_at <= ${input.now})
        order by node_id
        limit ${input.limit}
      `.execute(transaction)).rows;
      return Object.freeze(rows.map(mapItem));
    },
    async aggregateItems(jobId) {
      return aggregateFaviconJobItems(transaction, jobId, observeRestoreRead);
    },
    async extendRestoreGeneration(input) {
      return extendFaviconRestoreGeneration(transaction, input, observeRestoreRead);
    },
    async listAllItems(jobId) {
      const rows = (await sql<ItemRow>`
        select ${ITEM_COLUMNS} from favicon_job_items
        where job_id = ${jobId}
        order by node_id
      `.execute(transaction)).rows;
      return Object.freeze(rows.map(mapItem));
    },
    async listFailedItems(jobId, limit) {
      const rows = (await sql<{ node_id: string; error_reason: FaviconJobErrorReason }>`
        select node_id, error_reason from favicon_job_items
        where job_id = ${jobId} and status = 'failed' and error_reason is not null
        order by node_id
        limit ${limit}
      `.execute(transaction)).rows;
      return Object.freeze(rows.map((row) => ({ nodeId: row.node_id, reason: row.error_reason })));
    },
    async insertRestoreGapItems(input: {
      readonly jobId: string;
      readonly accountId: string;
      readonly now: Date;
    }) {
      const job = (await sql<{ status: string }>`
        select status from favicon_jobs where id = ${input.jobId} for update
      `.execute(transaction)).rows[0];
      if (job === undefined || (job.status !== 'pending' && job.status !== 'running')) {
        return Object.freeze([]);
      }
      const ids = await insertFaviconRestoreGapPage(transaction, input, observeRestoreRead);
      await sql`
        update favicon_jobs
        set total = (select count(*)::int from favicon_job_items where job_id = ${input.jobId}),
            updated_at = ${input.now}
        where id = ${input.jobId}
      `.execute(transaction);
      return ids;
    },
  } satisfies FaviconBatchItemWritePort & FaviconBatchJobReadPort & FaviconRestoreGapWritePort);
}

interface CandidateRow {
  node_id: string;
  collection_id: string;
  url: string;
  node_resource_revision: string;
  source_revision: string;
  has_binding: boolean;
}

function mapCandidate(row: CandidateRow & { source_mode: string | null }): FaviconBatchCandidate {
  return Object.freeze({
    nodeId: row.node_id,
    collectionId: row.collection_id,
    url: row.url,
    nodeResourceRevision: row.node_resource_revision,
    sourceMode: (row.source_mode as FaviconBatchCandidate['sourceMode']) ?? null,
    sourceRevision: BigInt(row.source_revision),
    hasBinding: row.has_binding,
  } satisfies FaviconBatchCandidate);
}

/**
 * All FO-03 batch ports over one transaction, wired into the collections
 * unit of work in a single spread line.
 */
export function createPostgresFaviconBatchWritePorts(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
  observeRestoreRead?: FaviconRestoreReadObserver,
): {
  faviconBatchJobs: FaviconBatchJobWritePort;
  faviconBatchCandidates: FaviconBatchCandidatePort;
  faviconJobItemsRead: FaviconBatchJobReadPort & FaviconBatchItemWritePort;
  faviconRestores: FaviconSourceRestoreWritePort;
  faviconRestoreRead: FaviconSourceRestoreReadPort;
} {
  return {
    faviconBatchJobs: createPostgresFaviconBatchJobWritePort(transaction, observeRestoreRead),
    faviconBatchCandidates: createPostgresFaviconCandidatePort(transaction),
    faviconJobItemsRead: createPostgresFaviconBatchItemPort(transaction, observeRestoreRead),
    faviconRestores: createPostgresFaviconRestoreWritePort(transaction),
    faviconRestoreRead: createPostgresFaviconRestoreReadPort(transaction),
  };
}

/**
 * Candidate selector for the account's own live bookmark nodes. Every row is
 * re-verified by the worker before any write; nodes with an active
 * (pending/running) job or item are never selected so the same node is never
 * worked by two jobs.
 */
export function createPostgresFaviconCandidatePort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): FaviconBatchCandidatePort {
  return Object.freeze({
    async listCandidates(input) {
      const fragments: string[] = [];
      if (input.operation === 'fill_missing') {
        fragments.push(`bi.node_id is null`);
        fragments.push(`(s.source_mode is null or s.source_mode <> 'none')`);
      } else if (input.operation === 'refresh_online') {
        // The online default is folded into the SQL text (never a mixed
        // positional placeholder inside a raw fragment, which would collide
        // with Kysely's own parameter numbering). Under an online default an
        // inherit node (explicit row or the virtual missing row) acts online
        // and must be refreshable; without it only explicit online rows are.
        fragments.push(input.onlineDefault
          ? `(s.source_mode = 'online' or s.source_mode is null or s.source_mode = 'inherit')`
          : `s.source_mode = 'online'`);
      }
      if (input.operation === 'fill_missing' || input.operation === 'refresh_online') {
        // FO-08: a favicon_source_restores row marks a node inside a force
        // window whose restore is still pending (or about to be gap-enqueued).
        // A fill/refresh must never capture such a node concurrently — the
        // refresh capture and the force-off restore would race on the same
        // binding and the fresher capture could retire the restored original.
        // (apply_force_online deliberately keeps covering restore-row nodes:
        // re-enabling force must re-capture the very nodes it displaced.)
        fragments.push(`not exists (
          select 1 from favicon_source_restores r where r.node_id = n.id
        )`);
      }
      const extra = fragments.length > 0 ? sql.raw(`and ${fragments.join(' and ')}`) : sql``;
      const idFilter = input.nodeIds !== undefined && input.nodeIds.length > 0
        ? sql`and n.id = any(${input.nodeIds}::text[])`
        : sql``;
      const result = await sql<CandidateRow & { source_mode: string | null }>`
        select n.id as node_id, n.collection_id, n.url, n.resource_revision as node_resource_revision,
               s.source_mode as source_mode, coalesce(s.revision, 1) as source_revision,
               (bi.node_id is not null) as has_binding
        from collections c
        join nodes n on n.collection_id = c.id
        left join bookmark_icon_sources s on s.node_id = n.id
        left join bookmark_icons bi on bi.node_id = n.id
        where c.owner_subject_id = ${input.accountSubjectId}
          and c.deleted_at is null
          and n.deleted_at is null
          and n.kind = 'bookmark'
          and n.url is not null and n.url <> ''
          ${idFilter}
          ${extra}
          and not exists (
            select 1 from favicon_jobs j
            where j.node_id = n.id and j.status in ('pending', 'running')
          )
          and not exists (
            select 1 from favicon_job_items it
            join favicon_jobs jj on jj.id = it.job_id
            where it.node_id = n.id and jj.status in ('pending', 'running')
          )
        order by n.id
        limit ${FAVICON_JOB_CANDIDATE_LIMIT}
      `.execute(transaction);
      return Object.freeze(result.rows.map(mapCandidate));
    },
  } satisfies FaviconBatchCandidatePort);
}

interface RestoreRow {
  node_id: string;
  collection_id: string;
  account_id: string;
  original_source_mode: FaviconSourceRestoreRow['originalSourceMode'];
  original_object_id: string | null;
  original_content_type: string | null;
  original_byte_size: number | null;
  original_digest_sha256: Buffer | null;
  source_revision: string;
  created_at: Date;
  updated_at: Date;
}

function mapRestore(row: RestoreRow): FaviconSourceRestoreRow {
  return Object.freeze({
    nodeId: row.node_id,
    collectionId: row.collection_id,
    accountId: row.account_id,
    originalSourceMode: row.original_source_mode,
    originalObjectId: row.original_object_id,
    originalContentType: row.original_content_type,
    originalByteSize: row.original_byte_size,
    originalDigestSha256: row.original_digest_sha256 === null ? null : Buffer.from(row.original_digest_sha256),
    sourceRevision: BigInt(row.source_revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

const RESTORE_COLUMNS = sql`node_id, collection_id, account_id, original_source_mode,
  original_object_id, original_content_type, original_byte_size, original_digest_sha256,
  source_revision, created_at, updated_at`;

export function createPostgresFaviconRestoreWritePort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): FaviconSourceRestoreWritePort {
  return Object.freeze({
    async findByNodeId(nodeId) {
      const row = (await sql<RestoreRow>`
        select ${RESTORE_COLUMNS} from favicon_source_restores where node_id = ${nodeId}
      `.execute(transaction)).rows[0];
      return row === undefined ? null : mapRestore(row);
    },
    async upsert(row) {
      // FO-07: the restore row is FIRST-WRITER-WINS. It is the durable record
      // of the pre-force state, written before the first force displacement.
      // Re-enabling force while a restore is still pending must never
      // overwrite it: `do update` here replaced the user's original object id
      // with the first force's capture, so the final force-off could only
      // restore the force icon and the original was lost forever. The row is
      // deleted when the restore actually applies (applyRestoreCas).
      await sql`
        insert into favicon_source_restores (
          node_id, collection_id, account_id, original_source_mode, original_object_id,
          original_content_type, original_byte_size, original_digest_sha256,
          source_revision, created_at, updated_at
        ) values (
          ${row.nodeId}, ${row.collectionId}, ${row.accountId}, ${row.originalSourceMode},
          ${row.originalObjectId}, ${row.originalContentType}, ${row.originalByteSize},
          ${row.originalDigestSha256}, ${row.sourceRevision.toString()},
          ${row.createdAt}, ${row.updatedAt}
        )
        on conflict (node_id) do nothing
      `.execute(transaction);
    },
    async deleteByNodeId(nodeId) {
      await sql`delete from favicon_source_restores where node_id = ${nodeId}`.execute(transaction);
    },
  } satisfies FaviconSourceRestoreWritePort);
}

export function createPostgresFaviconRestoreReadPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): FaviconSourceRestoreReadPort {
  return Object.freeze({
    async listByAccountId(accountId, nodeIds) {
      if (nodeIds === undefined || nodeIds.length === 0) {
        throw new Error('Account restore reads require an explicit node id set; generation uses the node_id keyset.');
      }
      const rows = (await sql<RestoreRow>`
        select ${RESTORE_COLUMNS} from favicon_source_restores
        where account_id = ${accountId} and node_id = any(${nodeIds}::text[])
        order by node_id
        limit ${nodeIds.length}
      `.execute(transaction)).rows;
      return Object.freeze(rows.map(mapRestore));
    },
  } satisfies FaviconSourceRestoreReadPort);
}