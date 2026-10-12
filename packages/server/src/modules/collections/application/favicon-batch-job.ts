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
  FaviconJobOperation,
  FaviconJobRecord,
} from './favicon-job.js';
import type {
  FaviconPolicyReadPort,
  FaviconPolicyRow,
} from './favicon-policy.js';
import type {
  FaviconBatchJobOperation,
  FaviconBatchJobReadPort,
  FaviconBatchJobWritePort,
  FaviconBatchCandidatePort,
  FaviconJobItemInsert,
  FaviconSourceRestoreReadPort,
  IconJobDto,
} from './favicon-batch-policy.js';
import {
  FAVICON_BATCH_ERRORS_PAGE_SIZE,
  FAVICON_BATCH_JOB_COMMAND_CONTRACT_VERSION,
  FAVICON_BATCH_JOB_ROUTE,
  FaviconBatchJobCommandError,
  buildFaviconBatchJobItems,
  buildFaviconRestoreItems,
  toIconJobDto,
} from './favicon-batch-policy.js';
// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface FaviconBatchJobCommandPorts {
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly clock: CollectionsClock;
  readonly policies: FaviconPolicyReadPort;
  readonly jobs: FaviconBatchJobWritePort;
  readonly items: FaviconBatchJobReadPort;
  readonly candidates: FaviconBatchCandidatePort;
  readonly restores: FaviconSourceRestoreReadPort;
}

/** Policy-update job insertion ports (shared transaction with the PATCH). */
export interface FaviconPolicyBatchJobCommandPorts {
  readonly jobs: FaviconBatchJobWritePort;
  readonly candidates: FaviconBatchCandidatePort;
  readonly restores: FaviconSourceRestoreReadPort;
}

/**
 * Insert the durable batch job triggered by a policy change inside the same
 * transaction as the policy write ("更新策略、作业记录和 receipt 同事务").
 * An active job of the same operation on the same revision is returned
 * instead of enqueueing the same jobId twice; older active jobs of the
 * account are superseded before the new job is inserted.
 */
export async function insertPolicyBatchJob(
  ports: FaviconPolicyBatchJobCommandPorts,
  input: {
    readonly accountId: string;
    readonly subjectId: string;
    readonly policy: FaviconPolicyRow;
    readonly operation: FaviconBatchJobOperation;
    readonly now: Date;
  },
): Promise<string> {
  const active = await ports.jobs.findActiveBatchJob(input.accountId, input.operation);
  if (active !== null && active.policyRevision === input.policy.revision) return active.jobId;
  // Supersede the older active jobs BEFORE selecting candidates: the candidate
  // selector excludes every node held by a pending/running job (so two jobs
  // never work one node), and enqueueing the replacement first would therefore
  // read an empty candidate set from the very job this one replaces.
  // FO-08: a capture-oriented strategy change (refresh/fill) never retires an
  // ACTIVE restore_sources job — force-off already happened, the restore is
  // the durable undo of the force window, and superseding it would strand the
  // force icon plus a dangling restore snapshot forever. Re-enabling force
  // (apply_force_online) DOES supersede the pending restore: the force window
  // is open again, so the undo is void and its row must survive untouched for
  // the eventual second force-off.
  if (input.operation === 'refresh_online' || input.operation === 'fill_missing') {
    await ports.jobs.supersedeActiveBatchJobs(input.accountId, { keepOperation: 'restore_sources' });
  } else {
    await ports.jobs.supersedeActiveBatchJobs(input.accountId);
  }
  const jobId = randomUUID();
  if (input.operation === 'restore_sources') {
    await ports.jobs.insertJob({
      jobId,
      accountId: input.accountId,
      ownerSubjectId: input.subjectId,
      operation: input.operation,
      policyRevision: input.policy.revision,
      total: 0,
      createdAt: input.now,
      updatedAt: input.now,
    });
    // Checkpoint and the first page commit with policy revision and supersede.
    // A short page finishes the scan; a full page leaves the cursor for the worker.
    await ports.jobs.extendRestoreGeneration({
      jobId,
      accountId: input.accountId,
      now: input.now,
      leaseOwner: null,
    });
    return jobId;
  }
  const candidates = await ports.candidates.listCandidates({
    accountId: input.accountId,
    accountSubjectId: input.subjectId,
    operation: input.operation as 'fill_missing' | 'refresh_online' | 'apply_force_online',
    onlineDefault: input.policy.newDefault === 'online',
  });
  const items = buildFaviconBatchJobItems({ jobId, candidates, policy: input.policy, now: input.now });
  await ports.jobs.insertJob({
    jobId,
    accountId: input.accountId,
    ownerSubjectId: input.subjectId,
    operation: input.operation,
    policyRevision: input.policy.revision,
    total: items.length,
    createdAt: input.now,
    updatedAt: input.now,
  });
  if (items.length > 0) await ports.jobs.insertItems(items);
  return jobId;
}

export function faviconBatchJobCommandScope(operation: FaviconBatchJobOperation | undefined, jobId?: string): string {
  return jobId === undefined
    ? `me:favicon:job:create:${operation ?? 'batch'}`
    : `me:favicon:job:${jobId}:retry`;
}

export interface CreateMyFaviconJobInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly operation: 'fill_missing' | 'refresh_online';
  readonly policyRevision: string;
}

export type FaviconBatchJobReceiptOutcome =
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export type FaviconBatchJobResult =
  | { readonly kind: 'accepted'; readonly jobId: string }
  | FaviconBatchJobReceiptOutcome;

/**
 * POST /api/v1/me/favicon-jobs — create a durable batch job for the current
 * policy revision. Re-verifies ownership, policy and candidate liveness before
 * persisting ("落库前重查"); an active job of the same operation on the same
 * revision is returned instead of enqueueing the same jobId twice.
 */
export async function createMyFaviconJob(
  ports: FaviconBatchJobCommandPorts,
  input: CreateMyFaviconJobInput,
): Promise<FaviconBatchJobResult> {
  const commandId = canonicalJobCommandId(input.commandId);
  const requestedRevision = parseJobPolicyRevision(input.policyRevision);
  const binding = {
    principalId: input.actor.principalId,
    commandScope: faviconBatchJobCommandScope(input.operation),
    commandId,
  };
  const fingerprint = faviconBatchJobFingerprint({ operation: input.operation, policyRevision: input.policyRevision });
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapBatchClaim(claim);

  const policy = await loadCurrentPolicy(ports, input.actor.principalId, requestedRevision);
  const operation: FaviconBatchJobOperation = input.operation;
  const now = await ports.clock.now();
  const active = await ports.jobs.findActiveBatchJob(input.actor.principalId, operation);
  if (active !== null && active.policyRevision === requestedRevision) {
    await ports.receipts.complete(binding, fingerprint, batchAcceptedResult(active.jobId));
    return { kind: 'accepted', jobId: active.jobId };
  }
  // Supersede the older active jobs BEFORE selecting candidates (see
  // insertPolicyBatchJob): the candidate selector never returns a node held by
  // a pending/running job, so the replacement must retire the previous job
  // first or it would find nothing to work on. An active restore_sources job
  // is kept (FO-08): createMyFaviconJob only enqueues fill/refresh, which must
  // not strand a pending restore.
  await ports.jobs.supersedeActiveBatchJobs(input.actor.principalId, { keepOperation: 'restore_sources' });
  const candidates = await ports.candidates.listCandidates({
    accountId: input.actor.principalId,
    accountSubjectId: input.actor.subjectId,
    operation,
    onlineDefault: policy.newDefault === 'online',
  });
  const jobId = randomUUID();
  const items = buildFaviconBatchJobItems({ jobId, candidates, policy, now });
  await ports.jobs.insertJob({
    jobId,
    accountId: input.actor.principalId,
    ownerSubjectId: input.actor.subjectId,
    operation,
    policyRevision: requestedRevision,
    total: items.length,
    createdAt: now,
    updatedAt: now,
  });
  if (items.length > 0) await ports.jobs.insertItems(items);
  await ports.receipts.complete(binding, fingerprint, batchAcceptedResult(jobId));
  return { kind: 'accepted', jobId };
}

/**
 * GET /api/v1/me/favicon-jobs/{jobId} — owner-only read of one durable job.
 * Errors are the first 100 failed items in stable node-ID order (refresh_one
 * reads its single-item row; batch jobs read the item ledger).
 */
export async function getMyFaviconJob(
  ports: FaviconBatchJobCommandPorts,
  input: { readonly actor: { readonly principalId: string }; readonly jobId: string },
): Promise<IconJobDto | null> {
  const job = await ports.jobs.findJobForAccount(input.jobId, input.actor.principalId);
  if (job === null) return null;
  const errors = job.operation === 'refresh_one'
    ? (job.errorNodeId !== null && job.errorReason !== null
      ? [{ nodeId: job.errorNodeId, reason: job.errorReason }]
      : [])
    : await ports.items.listFailedItems(input.jobId, FAVICON_BATCH_ERRORS_PAGE_SIZE);
  return toIconJobDto(job, errors);
}

export interface RetryMyFaviconJobInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly commandId: string;
  readonly jobId: string;
}

/**
 * POST /api/v1/me/favicon-jobs/{jobId}/retry — rebuild a job from the failed
 * items of a terminal failed/partial job under the CURRENT policy. Never
 * re-runs succeeded/skipped items; a policy change since the failed job is a
 * 409 revision_conflict; an active job of the same operation is returned so
 * retries never pile up. Exact replay returns the same new jobId.
 */
export async function retryMyFaviconJob(
  ports: FaviconBatchJobCommandPorts,
  input: RetryMyFaviconJobInput,
): Promise<FaviconBatchJobResult> {
  const commandId = canonicalJobCommandId(input.commandId);
  const binding = {
    principalId: input.actor.principalId,
    commandScope: faviconBatchJobCommandScope(undefined, input.jobId),
    commandId,
  };
  const fingerprint = faviconBatchJobRetryFingerprint(input.jobId);
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapBatchClaim(claim);

  const oldJob = await ports.jobs.findJobForAccount(input.jobId, input.actor.principalId);
  if (oldJob === null) {
    // Missing/foreign jobs conceal as 404; never reveal whether the job exists.
    throw new FaviconBatchJobCommandError('not_found', 'The favicon job was not found for this account.');
  }
  if (oldJob.status !== 'failed' && oldJob.status !== 'partial') {
    throw new FaviconBatchJobCommandError(
      'invalid_request',
      'Only a terminal failed or partial favicon job can be retried.',
    );
  }
  const operation: FaviconBatchJobOperation = oldJob.operation === 'refresh_one'
    ? 'refresh_online'
    : oldJob.operation;
  const policy = await loadCurrentPolicy(ports, input.actor.principalId, oldJob.policyRevision);
  const active = await ports.jobs.findActiveBatchJob(input.actor.principalId, operation);
  if (active !== null) {
    await ports.receipts.complete(binding, fingerprint, batchAcceptedResult(active.jobId));
    return { kind: 'accepted', jobId: active.jobId };
  }
  const failedNodes = oldJob.operation === 'refresh_one'
    ? (oldJob.status === 'failed' && oldJob.nodeId !== null ? [oldJob.nodeId] : [])
    : (await ports.items.listFailedItems(input.jobId, 10_000)).map((entry) => entry.nodeId);
  if (failedNodes.length === 0) {
    throw new FaviconBatchJobCommandError(
      'invalid_request',
      'The favicon job has no failed items to retry.',
    );
  }
  const now = await ports.clock.now();
  const jobId = randomUUID();
  let items: FaviconJobItemInsert[];
  if (oldJob.operation === 'restore_sources') {
    const rows = await ports.restores.listByAccountId(input.actor.principalId, failedNodes);
    items = buildFaviconRestoreItems({ jobId, rows, now });
  } else {
    const candidates = await ports.candidates.listCandidates({
      accountId: input.actor.principalId,
      accountSubjectId: input.actor.subjectId,
      operation: operation as 'fill_missing' | 'refresh_online' | 'apply_force_online',
      onlineDefault: policy.newDefault === 'online',
      nodeIds: failedNodes,
    });
    items = buildFaviconBatchJobItems({ jobId, candidates, policy, now });
  }
  if (items.length === 0) {
    throw new FaviconBatchJobCommandError(
      'invalid_request',
      'None of the failed items can be retried under the current policy.',
    );
  }
  // FO-08: a capture retry (refresh/fill) keeps an active restore_sources job
  // so the force-off undo is never stranded; retrying a restore or force job
  // supersedes everything (the newest intent wins).
  const keepOperation = operation === 'refresh_online' || operation === 'fill_missing'
    ? { keepOperation: 'restore_sources' as const }
    : undefined;
  await ports.jobs.supersedeActiveBatchJobs(input.actor.principalId, keepOperation);
  await ports.jobs.insertJob({
    jobId,
    accountId: input.actor.principalId,
    ownerSubjectId: input.actor.subjectId,
    operation,
    policyRevision: oldJob.policyRevision,
    total: items.length,
    createdAt: now,
    updatedAt: now,
  });
  await ports.jobs.insertItems(items);
  await ports.receipts.complete(binding, fingerprint, batchAcceptedResult(jobId));
  return { kind: 'accepted', jobId };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function faviconBatchJobFingerprint(body: { operation: string; policyRevision: string }): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: FAVICON_BATCH_JOB_ROUTE,
    mediaType: 'application/json',
    body: JSON.stringify({ operation: body.operation, policyRevision: body.policyRevision }),
  });
}

export function faviconBatchJobRetryFingerprint(jobId: string): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: `${FAVICON_BATCH_JOB_ROUTE}/${jobId}/retry`,
    mediaType: '',
    body: '',
  });
}

function canonicalJobCommandId(commandId: string): string {
  try {
    return assertCanonicalCommandId(commandId);
  } catch {
    throw new FaviconBatchJobCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
}

function parseJobPolicyRevision(value: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value)) {
    throw new FaviconBatchJobCommandError(
      'invalid_request',
      'policyRevision must be a positive decimal revision string.',
    );
  }
  return BigInt(value);
}

async function loadCurrentPolicy(
  ports: FaviconBatchJobCommandPorts,
  accountId: string,
  requestedRevision: bigint,
): Promise<FaviconPolicyRow> {
  const stored = await ports.policies.findByAccountId(accountId);
  const policy: FaviconPolicyRow = stored ?? {
    accountId,
    newDefault: 'capture',
    providerTemplate: 'https://favicone.com/{hostname}',
    fillMissing: false,
    forceAllOnline: false,
    revision: 1n,
    updatedAt: new Date(0),
  };
  if (policy.revision !== requestedRevision) {
    throw new FaviconBatchJobCommandError(
      'revision_conflict',
      'The favicon policy revision does not match the current policy.',
    );
  }
  return policy;
}

function batchAcceptedResult(jobId: string): ProductCommandResult {
  const body = JSON.stringify({ jobId });
  return {
    status: 202,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: FAVICON_BATCH_JOB_COMMAND_CONTRACT_VERSION,
    targetIdentity: jobId,
  };
}

function mapBatchClaim(
  claim: Exclude<ProductCommandClaim, { kind: 'claimed' }>,
): FaviconBatchJobReceiptOutcome {
  if (claim.kind === 'replay') {
    return {
      kind: 'replay',
      status: claim.result.status,
      body: claim.result.body,
      stableHeaders: claim.result.stableHeaders,
      mediaType: claim.result.mediaType,
    };
  }
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}