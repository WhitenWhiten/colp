import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { readExportProjectionRows } from './export-projection-cursor.js';
import { sql, type Kysely } from 'kysely';
import {
  assertCanonicalCommandId,
  type ProductCommandBinding,
  type ProductCommandClaim,
} from '../../modules/commands/index.js';
import {
  EXPORT_JOB_MAX_BYTES,
  ExportJobCapacityError,
  ExportJobConflictError,
  type CreateMyExportJobPorts,
  type ExportCollection,
  type ExportJobClaim,
  type ExportJobReadPort,
  type ExportJobReceiptPort,
  type ExportJobRecord,
  type ExportJobStatus,
  type ExportJobWorkerPort,
  type ExportJobWritePort,
  type ExportLibraryProjectionPort,
  type ExportNode,
} from '../../modules/collections/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { DatabaseOperationError, isPostgresErrorCode } from '../database/errors.js';
import { type DatabaseTransaction } from '../database/unit-of-work.js';
import { createRequestUnitOfWork } from '../database/request-unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

export const EXPORT_JOB_ACTIVE_UNIQUE_INDEX = 'collection_export_jobs_owner_active_uidx';

interface JobRow {
  job_id: string;
  owner_subject_id: string;
  status: ExportJobStatus;
  object_key: string | null;
  byte_size: number | null;
  created_at: Date;
  ready_at: Date | null;
  expires_at: Date;
  error_class: string | null;
}

interface CollectionRow {
  id: string;
  title: string;
  visibility: 'private' | 'protected' | 'public' | 'unlisted';
  publication_slug: string | null;
}

interface NodeRow {
  id: string;
  collection_id: string;
  parent_id: string | null;
  kind: 'folder' | 'bookmark' | 'separator';
  is_root: boolean;
  title: string | null;
  url: string | null;
  description: string | null;
  tags: unknown;
  visibility: 'inherit' | 'protected' | 'private';
}

function constraintName(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const named = (current as { constraint?: unknown }).constraint;
    if (typeof named === 'string' && named.length > 0) return named;
    const message = current instanceof Error ? current.message : '';
    if (message.includes(EXPORT_JOB_ACTIVE_UNIQUE_INDEX)) return EXPORT_JOB_ACTIVE_UNIQUE_INDEX;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof DatabaseOperationError) return error.kind === 'unique_violation';
  if (isPostgresErrorCode(error, '23505')) return true;
  const cause = error instanceof Error ? error.cause : undefined;
  return cause !== undefined && isUniqueViolation(cause);
}

function isActiveOwnerUniqueViolation(error: unknown): boolean {
  return isUniqueViolation(error) && constraintName(error) === EXPORT_JOB_ACTIVE_UNIQUE_INDEX;
}

function mapRow(row: JobRow): ExportJobRecord {
  return Object.freeze({
    jobId: row.job_id,
    ownerSubjectId: row.owner_subject_id,
    status: row.status,
    objectKey: row.object_key,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    expiresAt: row.expires_at,
    errorClass: row.error_class,
  });
}

function asStringTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.filter((item): item is string => typeof item === 'string'));
}

export function createPostgresExportJobWritePort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): ExportJobWritePort {
  return Object.freeze({
    async findActive(ownerSubjectId: string) {
      const row = await transaction.selectFrom('collection_export_jobs')
        .selectAll()
        .where('owner_subject_id', '=', ownerSubjectId)
        .where('status', 'in', ['pending', 'running'])
        .executeTakeFirst();
      return row ? mapRow(row) : null;
    },
    async insertPending(input: {
      readonly jobId: string;
      readonly ownerSubjectId: string;
      readonly createdAt: Date;
      readonly expiresAt: Date;
    }) {
      try {
        await transaction.insertInto('collection_export_jobs').values({
          job_id: input.jobId,
          owner_subject_id: input.ownerSubjectId,
          status: 'pending',
          object_key: null,
          byte_size: null,
          expires_at: input.expiresAt,
          ready_at: null,
          lease_owner: null,
          lease_until: null,
          error_class: null,
          created_at: input.createdAt,
        }).execute();
      } catch (error: unknown) {
        if (isActiveOwnerUniqueViolation(error)) throw new ExportJobConflictError();
        throw error;
      }
    },
  });
}

export function createPostgresExportJobReadPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): ExportJobReadPort {
  return Object.freeze({
    async listByOwner(ownerSubjectId: string, limit: number) {
      const rows = await transaction.selectFrom('collection_export_jobs')
        .selectAll()
        .where('owner_subject_id', '=', ownerSubjectId)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute();
      return Object.freeze(rows.map(mapRow));
    },
    async getById(jobId: string) {
      const row = await transaction.selectFrom('collection_export_jobs')
        .selectAll()
        .where('job_id', '=', jobId)
        .executeTakeFirst();
      return row ? mapRow(row) : null;
    },
  });
}

export function createPostgresExportLibraryProjectionPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): ExportLibraryProjectionPort {
  return Object.freeze({
    async loadOwnedLiveTree(ownerSubjectId: string, maxBytes = EXPORT_JOB_MAX_BYTES) {
      if (!transaction.isTransaction) {
        return transaction.transaction().setIsolationLevel('repeatable read').execute(tx =>
          createPostgresExportLibraryProjectionPort(tx).loadOwnedLiveTree(ownerSubjectId, maxBytes));
      }
      let bytes = 2; // collections array delimiters; the worker checks the final envelope too.
      const charge = (value: unknown, comma: boolean) => {
        bytes += Buffer.byteLength(JSON.stringify(value), 'utf8') + Number(comma);
        if (bytes > maxBytes) throw new ExportJobCapacityError();
      };
      const collections: CollectionRow[] = [];
      for await (const row of readExportProjectionRows(transaction, 'export_collections', sql<CollectionRow>`
        SELECT id, title, visibility, publication_slug FROM collections
        WHERE owner_subject_id = ${ownerSubjectId} AND deleted_at IS NULL
        ORDER BY created_at ASC, id COLLATE "C" ASC
      `)) {
        charge({ id: row.id, title: row.title, visibility: row.visibility,
          publicationSlug: row.publication_slug, nodes: [] }, collections.length > 0);
        collections.push(row);
      }
      if (collections.length === 0) return Object.freeze([]);
      const collectionIds = collections.map(row => row.id);
      const nodesByCollection = new Map<string, ExportNode[]>();
      for await (const row of readExportProjectionRows(transaction, 'export_nodes', sql<NodeRow>`
        SELECT id, collection_id, parent_id, kind, is_root, title, url, description, tags, visibility
        FROM nodes WHERE collection_id = ANY(${sql.val(collectionIds)}::text[])
          AND deleted_at IS NULL AND (is_root = true OR kind IN ('folder', 'bookmark'))
        ORDER BY is_root DESC, parent_id ASC NULLS FIRST, position_token ASC NULLS FIRST, id COLLATE "C" ASC
      `)) {
        if (row.kind !== 'folder' && row.kind !== 'bookmark') continue;
        const list = nodesByCollection.get(row.collection_id) ?? [];
        const node: ExportNode = Object.freeze({ id: row.id, parentId: row.parent_id,
          kind: row.kind, isRoot: row.is_root, title: row.title, url: row.url,
          description: row.description, tags: asStringTags(row.tags), visibility: row.visibility });
        charge(node, list.length > 0);
        list.push(node);
        nodesByCollection.set(row.collection_id, list);
      }
      return Object.freeze(collections.map((row): ExportCollection => Object.freeze({
        id: row.id, title: row.title, visibility: row.visibility, publicationSlug: row.publication_slug,
        nodes: Object.freeze(nodesByCollection.get(row.id) ?? []),
      })));
    },
  });
}

export function createPostgresExportJobEnqueueUnitOfWork(
  db: Kysely<DatabaseSchema>,
): {
  execute<Result>(
    work: (ports: CreateMyExportJobPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
} {
  return Object.freeze({
    execute<Result>(
      work: (ports: CreateMyExportJobPorts) => Promise<Result>,
      request: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      return createRequestUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => work({
          receipts: createExportJobReceiptPort(transaction),
          jobs: createPostgresExportJobWritePort(transaction),
          clock: { now: () => new Date() },
        }), request);
    },
  });
}

function createExportJobReceiptPort(transaction: DatabaseTransaction): ExportJobReceiptPort {
  const base = createPostgresProductCommandReceiptPort(transaction);
  return Object.freeze({
    claim: (binding: ProductCommandBinding, fingerprint: string) =>
      base.claim(binding, fingerprint),
    complete: (
      binding: ProductCommandBinding,
      fingerprint: string,
      result: Parameters<ExportJobReceiptPort['complete']>[2],
    ) => base.complete(binding, fingerprint, result),
    lookup: (binding: ProductCommandBinding, fingerprint: string) =>
      lookupExportJobReceipt(transaction, binding, fingerprint),
  });
}

async function lookupExportJobReceipt(
  transaction: DatabaseTransaction,
  binding: ProductCommandBinding,
  fingerprint: string,
): Promise<
  | { readonly kind: 'absent' }
  | Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>
> {
  assertCanonicalCommandId(binding.commandId);
  const row = await transaction.selectFrom('product_command_receipts').selectAll()
    .where('principal_id', '=', binding.principalId)
    .where('command_scope', '=', binding.commandScope)
    .where('command_id', '=', binding.commandId)
    .executeTakeFirst();
  if (!row) return { kind: 'absent' };
  if (row.request_fingerprint !== fingerprint) return { kind: 'reused' };
  if ((row.compact_claim || row.result_purged_at !== null || row.result_bytes === null)
      && row.completed_at !== null) {
    return { kind: 'expired', resultDigest: row.result_digest };
  }
  if (row.completed_at === null) return { kind: 'in_progress', retryAfterSeconds: 1 };
  return {
    kind: 'replay',
    result: {
      status: row.result_status!,
      body: row.result_bytes!,
      stableHeaders: row.result_headers ?? {},
      mediaType: row.result_media_type!,
      contractVersion: row.contract_version,
      targetIdentity: row.target_identity ?? undefined,
    },
  };
}

export interface ExportJobWorkerRepository {
  claimDue(input: {
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseDurationMs: number;
  }): Promise<readonly ExportJobClaim[]>;
  expireOverdue(input: {
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseDurationMs: number;
  }): Promise<readonly ExportJobClaim[]>;
  readonly worker: ExportJobWorkerPort;
}

interface ClaimRow {
  job_id: string;
  owner_subject_id: string;
  status: ExportJobStatus;
  object_key: string | null;
  expires_at: Date;
  lease_owner: string;
}

export function createPostgresExportJobWorkerRepository(pool: Pool): ExportJobWorkerRepository {
  const worker: ExportJobWorkerPort = Object.freeze({
    async renewLease(input: { readonly jobId: string; readonly leaseOwner: string; readonly leaseDurationMs: number }) {
      const result = await pool.query(`UPDATE collection_export_jobs
        SET lease_until = current_timestamp + ($3 * interval '1 millisecond')
        WHERE job_id = $1 AND lease_owner = $2 AND lease_until > current_timestamp
          AND expires_at > current_timestamp AND status IN ('pending','running')
        RETURNING job_id`, [input.jobId, input.leaseOwner, input.leaseDurationMs]);
      return result.rowCount === 1;
    },
    async markExpired(input: {
      readonly jobId: string;
      readonly leaseOwner: string;
    }) {
      const result = await pool.query(`
        UPDATE collection_export_jobs
        SET status = 'expired', lease_owner = NULL, lease_until = NULL
        WHERE job_id = $1
          AND lease_owner = $2
          AND lease_until IS NOT NULL
          AND lease_until > current_timestamp
          AND status IN ('pending','running','ready')
        RETURNING job_id
      `, [input.jobId, input.leaseOwner]);
      return result.rowCount === 1;
    },
    async markRunning(input: {
      readonly jobId: string;
      readonly leaseOwner: string;
      readonly objectKey?: string;
    }) {
      const result = await pool.query(`
        UPDATE collection_export_jobs
        SET status = 'running', object_key = COALESCE($3, object_key)
        WHERE job_id = $1
          AND lease_owner = $2
          AND lease_until IS NOT NULL
          AND lease_until > current_timestamp
          AND status IN ('pending','running')
        RETURNING job_id
      `, [input.jobId, input.leaseOwner, input.objectKey ?? null]);
      return result.rowCount === 1;
    },
    async markFailed(input: {
      readonly jobId: string;
      readonly leaseOwner: string;
      readonly errorClass: string;
    }) {
      const result = await pool.query(`
        UPDATE collection_export_jobs
        SET status = 'failed',
            error_class = $3,
            lease_owner = NULL,
            lease_until = NULL
        WHERE job_id = $1
          AND lease_owner = $2
          AND lease_until IS NOT NULL
          AND lease_until > current_timestamp
          AND status IN ('pending','running')
        RETURNING job_id
      `, [input.jobId, input.leaseOwner, input.errorClass]);
      return result.rowCount === 1;
    },
    async markReady(input: {
      readonly jobId: string;
      readonly leaseOwner: string;
      readonly objectKey: string;
      readonly byteSize: number;
      readonly readyAt: Date;
    }) {
      const result = await pool.query(`
        UPDATE collection_export_jobs
        SET status = 'ready',
            object_key = $3,
            byte_size = $4,
            ready_at = $5,
            error_class = NULL,
            lease_owner = NULL,
            lease_until = NULL
        WHERE job_id = $1
          AND lease_owner = $2
          AND lease_until IS NOT NULL
          AND lease_until > current_timestamp
          AND status = 'running'
        RETURNING job_id
      `, [input.jobId, input.leaseOwner, input.objectKey, input.byteSize, input.readyAt]);
      return result.rowCount === 1;
    },
  });

  async function claim(input: {
    readonly limit: number;
    readonly leaseOwner: string;
    readonly leaseDurationMs: number;
    readonly overdueOnly: boolean;
  }): Promise<readonly ExportJobClaim[]> {
    const predicate = input.overdueOnly
      ? `status IN ('pending','running','ready') AND expires_at <= current_timestamp`
      : `status IN ('pending','running') AND expires_at > current_timestamp`;
    const result = await pool.query<ClaimRow>(`
      WITH candidates AS (
        SELECT job_id
        FROM collection_export_jobs
        WHERE ${predicate}
          AND (lease_until IS NULL OR lease_until < current_timestamp)
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE collection_export_jobs AS job
      SET lease_owner = $2,
          lease_until = current_timestamp + ($3 * interval '1 millisecond')
      FROM candidates
      WHERE job.job_id = candidates.job_id
        AND (job.lease_until IS NULL OR job.lease_until < current_timestamp)
      RETURNING job.job_id, job.owner_subject_id, job.status, job.object_key, job.expires_at, job.lease_owner
    `, [input.limit, `${input.leaseOwner}:${randomUUID()}`, input.leaseDurationMs]);
    return Object.freeze(result.rows.map((row) => Object.freeze({
      jobId: row.job_id,
      ownerSubjectId: row.owner_subject_id,
      status: row.status,
      objectKey: row.object_key,
      expiresAt: row.expires_at,
      leaseOwner: row.lease_owner,
    })));
  }

  return Object.freeze({
    claimDue(input: {
      readonly limit: number;
      readonly leaseOwner: string;
      readonly leaseDurationMs: number;
    }) {
      return claim({ ...input, overdueOnly: false });
    },
    expireOverdue(input: {
      readonly limit: number;
      readonly leaseOwner: string;
      readonly leaseDurationMs: number;
    }) {
      return claim({ ...input, overdueOnly: true });
    },
    worker,
  });
}
