import type { UnitOfWork } from './unit-of-work.js';
import {
  applyLedgerPayloadPurgeBatch,
  LedgerPayloadPurgeError,
} from './ledger-payload-purge.js';
import type {
  LedgerPayloadPurgeJob,
  LedgerPayloadPurgeJobRepository,
} from './ledger-payload-purge-job-repository.js';

export interface RunLedgerPayloadPurgeWorkerOnceInput {
  readonly jobs: LedgerPayloadPurgeJobRepository;
  readonly unitOfWork: UnitOfWork;
  readonly segmentId: string;
  readonly confirmedSegmentId: string;
  readonly leaseOwner: string;
  readonly leaseDurationMs?: number;
  readonly batchSize?: number;
  readonly nodeEnvironment: string;
  readonly destructiveMode: string;
  readonly retryDelayMs?: number;
}

export type LedgerPayloadPurgeWorkerOutcome =
  | Readonly<{ kind: 'not_due'; segmentId: string }>
  | Readonly<{
    kind: 'applied'; segmentId: string; jobId: string;
    status: 'retryable' | 'succeeded'; deletedThisBatch: bigint; deletedTotal: bigint;
  }>
  | Readonly<{ kind: 'retryable'; segmentId: string; jobId: string; errorClass: string }>;

/** Claims and applies exactly one bounded batch; schedulers decide cadence. */
export async function runLedgerPayloadPurgeWorkerOnce(
  input: RunLedgerPayloadPurgeWorkerOnceInput,
): Promise<LedgerPayloadPurgeWorkerOutcome> {
  const claim = await input.jobs.claimSegment({
    segmentId: input.segmentId, leaseOwner: input.leaseOwner,
    leaseDurationMs: input.leaseDurationMs ?? 300_000,
  });
  if (!claim) return Object.freeze({ kind: 'not_due', segmentId: input.segmentId });
  try {
    const applied = await input.unitOfWork.execute(({ transaction }) =>
      applyLedgerPayloadPurgeBatch(transaction, {
        claim, confirmedSegmentId: input.confirmedSegmentId,
        nodeEnvironment: input.nodeEnvironment, destructiveMode: input.destructiveMode,
        batchSize: input.batchSize,
      }));
    return Object.freeze({
      kind: 'applied', segmentId: applied.segmentId, jobId: applied.jobId,
      status: applied.status, deletedThisBatch: applied.deletedThisBatch,
      deletedTotal: applied.deletedTotal,
    });
  } catch (error) {
    const errorClass = classifyPurgeError(error);
    await input.jobs.retry(claim, errorClass, input.retryDelayMs ?? 30_000);
    return Object.freeze({
      kind: 'retryable', segmentId: claim.segmentId, jobId: claim.jobId, errorClass,
    });
  }
}

export function serializeLedgerPayloadPurgeJob(job: LedgerPayloadPurgeJob) {
  return Object.freeze({
    jobId: job.jobId, segmentId: job.segmentId, family: job.family,
    scopeKey: job.scopeKey, lowerBound: job.lowerBound.toString(),
    upperBound: job.upperBound.toString(), status: job.status,
    attemptCount: job.attemptCount, leaseToken: job.leaseToken.toString(),
    leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
    deletedRowCount: job.deletedRowCount.toString(),
    availableAt: job.availableAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    lastErrorClass: job.lastErrorClass,
  });
}

function classifyPurgeError(error: unknown): string {
  if (error instanceof LedgerPayloadPurgeError) return error.stableCode;
  const stableCode = (error as { stableCode?: unknown })?.stableCode;
  if (typeof stableCode === 'string' && /^[a-z][a-z0-9_]{0,95}$/u.test(stableCode)) {
    return stableCode;
  }
  return 'unexpected_failure';
}
