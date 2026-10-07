/**
 * FO-03 favicon batch policy: durable per-node records, ports and pure
 * functions (target selection, aggregate counters, wire DTO). The commands
 * that consume these ports live in favicon-batch-job.ts; the worker execution
 * in favicon-batch-execution.ts.
 */
/**
 * FO-03 durable batch favicon jobs: command layer, ports and pure functions.
 *
 * Batch jobs (fill_missing / refresh_online / apply_force_online /
 * restore_sources) share the favicon_jobs aggregate row (counters, lease,
 * retry envelope) with refresh_one but keep per-node work in
 * `favicon_job_items`. Every item carries the async identity the contract
 * requires — account (via the job), node, collection, resolved provider URL,
 * source revision and node resource revision — and the worker re-verifies all
 * of it inside a transaction before any write ("落库前重查").
 *
 * Enqueue idempotency:
 *  - an active (pending/running) job of the same operation on the same policy
 *    revision is returned instead of inserting a second row (the same jobId is
 *    never enqueued twice);
 *  - creating any new batch job supersedes older active batch jobs of the
 *    account, so the newest policy revision's intent wins.
 */
import { randomUUID } from 'node:crypto';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import type { CollectionsClock } from './ports.js';
import type {
  FaviconJobErrorReason,
  FaviconJobOperation,
  FaviconJobRecord,
  FaviconJobStatus,
  FaviconJobWritePort,
} from './favicon-job.js';
import type {
  FaviconPolicyPatch,
  FaviconPolicyReadPort,
  FaviconPolicyRow,
} from './favicon-policy.js';
import {
  faviconHostnameFromBookmarkUrl,
  resolveFaviconProviderUrl,
} from './favicon-fetch-policy.js';
import type { IconSourceMode } from './favicon-icon-source.js';

export const FAVICON_BATCH_JOB_COMMAND_CONTRACT_VERSION = '1.0.0';
export const FAVICON_BATCH_JOB_ROUTE = '/api/v1/me/favicon-jobs';
export const FAVICON_BATCH_ERRORS_PAGE_SIZE = 100;

export type FaviconBatchJobOperation = Exclude<FaviconJobOperation, 'refresh_one'>;
export type FaviconBatchItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export class FaviconBatchJobCommandError extends Error {
  constructor(readonly code: 'invalid_request' | 'revision_conflict' | 'not_found', message: string) {
    super(message);
    this.name = 'FaviconBatchJobCommandError';
  }
}

// ---------------------------------------------------------------------------
// Durable per-node item / restore records + ports
// ---------------------------------------------------------------------------

export interface FaviconJobItemRow {
  readonly jobId: string;
  readonly nodeId: string;
  readonly collectionId: string;
  readonly sourceUrl: string;
  readonly sourceRevision: bigint;
  readonly nodeResourceRevision: string;
  readonly status: FaviconBatchItemStatus;
  readonly errorReason: FaviconJobErrorReason | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly objectId: string | null;
  readonly objectContentType: string | null;
  readonly objectByteSize: number | null;
  readonly objectDigestSha256: Buffer | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FaviconJobItemInsert {
  readonly jobId: string;
  readonly nodeId: string;
  readonly collectionId: string;
  readonly sourceUrl: string;
  readonly sourceRevision: bigint;
  readonly nodeResourceRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Enqueue-time identity of one candidate node (the worker re-verifies it). */
export interface FaviconBatchCandidate {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly url: string;
  readonly nodeResourceRevision: string;
  /** Current source row mode; `null` means the virtual inherit default. */
  readonly sourceMode: IconSourceMode | null;
  /** Source row revision, or the virtual revision 1 when the row is absent. */
  readonly sourceRevision: bigint;
  readonly hasBinding: boolean;
}

export interface FaviconBatchCandidatePort {
  /**
   * Select the account's own bookmark nodes for a batch operation. `nodeIds`
   * restricts to a retry subset; nodes with an active (pending/running) job
   * or item are never selected, so the same node is never worked twice.
   */
  listCandidates(input: {
    readonly accountId: string;
    readonly accountSubjectId: string;
    readonly operation: 'fill_missing' | 'refresh_online' | 'apply_force_online';
    readonly onlineDefault: boolean;
    readonly nodeIds?: readonly string[];
  }): Promise<readonly FaviconBatchCandidate[]>;
}

/** One bounded restore-generation step. `inactive` means the lease or status fence failed. */
export interface FaviconRestoreGenerationPage {
  readonly readCount: number;
  readonly gapReadCount: number;
  readonly scanComplete: boolean;
  /** False when the gap page was full, so a later page may still hold uncovered rows. */
  readonly gapCaughtUp: boolean;
  readonly cursorNodeId: string | null;
  readonly inactive: boolean;
}

export interface FaviconRestoreGenerationInput {
  readonly jobId: string;
  readonly accountId: string;
  readonly now: Date;
  /** Null only for the enqueue transaction, which has not taken a worker lease. */
  readonly leaseOwner: string | null;
}

/** Transaction-scoped batch job + item writes (enqueue + worker item CAS). */
export interface FaviconBatchJobWritePort {
  insertJob(input: {
    readonly jobId: string;
    readonly accountId: string;
    readonly ownerSubjectId: string;
    readonly operation: FaviconBatchJobOperation;
    readonly policyRevision: bigint;
    readonly total: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  }): Promise<void>;
  /**
   * Advance one restore keyset page and one gap page, and set `total` to the
   * item count, in this transaction. A short keyset page marks the scan complete.
   */
  extendRestoreGeneration(input: FaviconRestoreGenerationInput): Promise<FaviconRestoreGenerationPage>;
  insertItems(items: readonly FaviconJobItemInsert[]): Promise<void>;
  /** Active (pending/running) batch job for the account+operation, if any. */
  findActiveBatchJob(accountId: string, operation: FaviconBatchJobOperation): Promise<FaviconJobRecord | null>;
  /**
   * Mark older active batch jobs superseded; the newest policy intent wins.
   * `keepOperation` (FO-08): a strategy change must never retire an ACTIVE
   * `restore_sources` job — force-off already happened and the restore is the
   * durable undo; superseding it would leave the force icon bound and the
   * restore snapshot dangling forever.
   */
  supersedeActiveBatchJobs(
    accountId: string,
    options?: { readonly keepOperation?: FaviconBatchJobOperation },
  ): Promise<void>;
  /** Refresh_one + batch read used by getMyFaviconJob (owner-scoped). */
  findJobForAccount(jobId: string, accountId: string): Promise<FaviconJobRecord | null>;
}

/** Tx-scoped per-node item writes (worker). */
export interface FaviconBatchItemWritePort {
  findByJobAndNode(jobId: string, nodeId: string): Promise<FaviconJobItemRow | null>;
  markSkipped(jobId: string, nodeId: string, updatedAt: Date): Promise<void>;
  markFailed(jobId: string, nodeId: string, attempts: number, reason: FaviconJobErrorReason, updatedAt: Date): Promise<void>;
  scheduleRetry(jobId: string, nodeId: string, attempts: number, nextAttemptAt: Date, reason: FaviconJobErrorReason, updatedAt: Date): Promise<void>;
  setObjectId(jobId: string, nodeId: string, objectId: string, updatedAt: Date): Promise<void>;
  setObjectMetadata(input: {
    readonly jobId: string;
    readonly nodeId: string;
    readonly objectId: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly digestSha256: Buffer;
    readonly updatedAt: Date;
  }): Promise<void>;
  markSucceeded(jobId: string, nodeId: string, updatedAt: Date): Promise<void>;
}

/** Batch job read ports (worker cycle + HTTP read-back). */
export interface FaviconBatchJobReadPort {
  listDueItems(input: { readonly jobId: string; readonly limit: number; readonly now: Date }): Promise<readonly FaviconJobItemRow[]>;
  /** SQL count/filter/sum for one job. Cycle completion must use this, not listAllItems. */
  aggregateItems(jobId: string): Promise<FaviconBatchAggregate>;
  /** Small-job read-back. Not a cycle aggregate. */
  listAllItems(jobId: string): Promise<readonly FaviconJobItemRow[]>;
  /** First `limit` failed items in stable node-ID order (wire `errors`). */
  listFailedItems(jobId: string, limit: number): Promise<readonly { readonly nodeId: string; readonly reason: FaviconJobErrorReason }[]>;
}

// ---------------------------------------------------------------------------
// Force-restore records
// ---------------------------------------------------------------------------

export interface FaviconSourceRestoreRow {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly accountId: string;
  readonly originalSourceMode: IconSourceMode;
  readonly originalObjectId: string | null;
  readonly originalContentType: string | null;
  readonly originalByteSize: number | null;
  readonly originalDigestSha256: Buffer | null;
  readonly sourceRevision: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FaviconSourceRestoreWritePort {
  findByNodeId(nodeId: string): Promise<FaviconSourceRestoreRow | null>;
  /**
   * Persist the pre-force state. Insert-only: the FIRST force window owns the
   * row until a restore consumes it, so re-enabling force while a restore is
   * still pending can never rebase the user's original icon onto the force
   * capture (FO-07 review).
   */
  upsert(row: {
    readonly nodeId: string;
    readonly collectionId: string;
    readonly accountId: string;
    readonly originalSourceMode: IconSourceMode;
    readonly originalObjectId: string | null;
    readonly originalContentType: string | null;
    readonly originalByteSize: number | null;
    readonly originalDigestSha256: Buffer | null;
    readonly sourceRevision: bigint;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  }): Promise<void>;
  deleteByNodeId(nodeId: string): Promise<void>;
}

export interface FaviconSourceRestoreReadPort {
  /**
   * Restore rows for an explicit node-id set (retry). An empty or omitted set
   * is rejected: account-wide reads go through the keyset scan.
   */
  listByAccountId(accountId: string, nodeIds?: readonly string[]): Promise<readonly FaviconSourceRestoreRow[]>;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Which durable batch job a policy patch must create (if any)? FO-03 rules:
 * enabling fillMissing → fill_missing; enabling force → apply_force_online;
 * disabling force → restore_sources; making an online provider active (new
 * default online, or a template change under an online default) → refresh_online.
 * Returns at most one job per patch, in a deterministic priority order.
 */
export function faviconPolicyBatchTrigger(
  current: FaviconPolicyRow,
  patch: FaviconPolicyPatch,
): FaviconBatchJobOperation | null {
  const forceAfter = patch.forceAllOnline ?? current.forceAllOnline;
  const newDefaultAfter = patch.newDefault ?? current.newDefault;
  if (current.forceAllOnline && patch.forceAllOnline === false) return 'restore_sources';
  if (!current.forceAllOnline && forceAfter) return 'apply_force_online';
  if (current.newDefault !== 'online' && newDefaultAfter === 'online') return 'refresh_online';
  if (newDefaultAfter === 'online' && patch.providerTemplate !== undefined
    && patch.providerTemplate !== current.providerTemplate) return 'refresh_online';
  if (!current.fillMissing && patch.fillMissing === true) return 'fill_missing';
  return null;
}

/** Resolve + build the durable item rows for a candidate set. */
export function buildFaviconBatchJobItems(
  input: {
    readonly jobId: string;
    readonly candidates: readonly FaviconBatchCandidate[];
    readonly policy: FaviconPolicyRow;
    readonly now: Date;
  },
): FaviconJobItemInsert[] {
  const items: FaviconJobItemInsert[] = [];
  for (const candidate of input.candidates) {
    const hostname = faviconHostnameFromBookmarkUrl(candidate.url);
    const sourceUrl = hostname === null
      ? null
      : resolveFaviconProviderUrl(input.policy.providerTemplate, hostname);
    if (sourceUrl === null) continue; // an unresolvable target is never queued
    items.push({
      jobId: input.jobId,
      nodeId: candidate.nodeId,
      collectionId: candidate.collectionId,
      sourceUrl,
      sourceRevision: candidate.sourceRevision,
      nodeResourceRevision: candidate.nodeResourceRevision,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  return items;
}

export function buildFaviconRestoreItems(
  input: {
    readonly jobId: string;
    readonly rows: readonly FaviconSourceRestoreRow[];
    readonly now: Date;
  },
): FaviconJobItemInsert[] {
  return input.rows.map((row) => ({
    jobId: input.jobId,
    nodeId: row.nodeId,
    collectionId: row.collectionId,
    sourceUrl: '',
    sourceRevision: row.sourceRevision,
    nodeResourceRevision: '',
    createdAt: input.now,
    updatedAt: input.now,
  }));
}

export interface FaviconBatchAggregate {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pendingCount: number;
  /** Earliest retry instant of the pending items; null when nothing is pending. */
  readonly nextAttemptAt: Date | null;
}

/** Cycle-end aggregate: counters reflect ALL items; errors list pending backoff. */
export function aggregateFaviconBatchItems(
  items: readonly Pick<FaviconJobItemRow, 'status' | 'nextAttemptAt'>[],
): FaviconBatchAggregate {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let pendingCount = 0;
  let nextAttemptAt: Date | null = null;
  for (const item of items) {
    if (item.status === 'succeeded') succeeded += 1;
    else if (item.status === 'failed') failed += 1;
    else if (item.status === 'skipped') skipped += 1;
    else {
      pendingCount += 1;
      if (item.nextAttemptAt !== null) {
        nextAttemptAt = nextAttemptAt === null || item.nextAttemptAt.getTime() < nextAttemptAt.getTime()
          ? item.nextAttemptAt
          : nextAttemptAt;
      }
    }
  }
  return {
    total: items.length,
    succeeded,
    failed,
    skipped,
    pendingCount,
    nextAttemptAt,
  };
}

/** Terminal status when no pending items remain. */
export function faviconBatchTerminalStatus(input: {
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}): 'succeeded' | 'partial' | 'failed' {
  if (input.failed === 0 && input.skipped === 0) return 'succeeded';
  if (input.succeeded === 0 && input.skipped === 0) return 'failed';
  return 'partial';
}

// ---------------------------------------------------------------------------
// IconJob wire DTO
// ---------------------------------------------------------------------------

export interface IconJobErrorDto {
  readonly nodeId: string;
  readonly reason: FaviconJobErrorReason;
}

export interface IconJobDto {
  readonly id: string;
  readonly operation: FaviconJobOperation;
  readonly policyRevision: string;
  readonly status: FaviconJobStatus;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errors: readonly IconJobErrorDto[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toIconJobDto(job: FaviconJobRecord, errors: readonly IconJobErrorDto[]): IconJobDto {
  return {
    id: job.jobId,
    operation: job.operation,
    policyRevision: job.policyRevision.toString(),
    status: job.status,
    total: job.total,
    succeeded: job.succeeded,
    failed: job.failed,
    skipped: job.skipped,
    errors,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

