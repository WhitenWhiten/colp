import type { FaviconJobRecord } from './favicon-job.js';
import {
  FAVICON_BATCH_ERRORS_PAGE_SIZE,
  toIconJobDto,
  type FaviconBatchJobReadPort,
  type FaviconBatchJobWritePort,
  type IconJobDto,
} from './favicon-batch-policy.js';

export interface FaviconJobActivityRecord {
  readonly activeJobs: number;
  readonly job: FaviconJobRecord | null;
}

export interface FaviconJobActivityDto {
  readonly activeJobs: number;
  /** Active batch first, otherwise the oldest individual refresh. */
  readonly job: IconJobDto | null;
}

/** Item counters are committed before the worker publishes its cycle aggregate. */
export async function readFaviconJobDto(items: FaviconBatchJobReadPort, job: FaviconJobRecord): Promise<IconJobDto> {
  if (job.operation === 'refresh_one') {
    return toIconJobDto(job, job.errorNodeId !== null && job.errorReason !== null
      ? [{ nodeId: job.errorNodeId, reason: job.errorReason }] : []);
  }
  const active = job.status === 'pending' || job.status === 'running';
  const aggregate = active ? await items.aggregateItems(job.jobId) : null;
  const errors = await items.listFailedItems(job.jobId, FAVICON_BATCH_ERRORS_PAGE_SIZE);
  return toIconJobDto(aggregate === null ? job : {
    ...job,
    total: aggregate.total,
    succeeded: aggregate.succeeded,
    failed: aggregate.failed,
    skipped: aggregate.skipped,
  }, errors);
}

export async function getMyFaviconJobActivity(
  ports: { readonly jobs: FaviconBatchJobWritePort; readonly items: FaviconBatchJobReadPort },
  accountId: string,
): Promise<FaviconJobActivityDto> {
  const { activeJobs, job } = await ports.jobs.findActiveForAccount(accountId);
  return { activeJobs, job: job === null ? null : await readFaviconJobDto(ports.items, job) };
}
