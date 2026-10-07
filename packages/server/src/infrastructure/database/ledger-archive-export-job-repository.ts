import { sql, type Kysely } from 'kysely';

import type { DatabaseSchema } from './runtime.js';
import type { LedgerArchiveExportJobStatus } from './ledger-archive-export-job-tables.js';

export interface LedgerArchiveExportJob {
  readonly jobId: string;
  readonly segmentId: string;
  readonly status: LedgerArchiveExportJobStatus;
  readonly attemptCount: number;
  readonly leaseOwner: string | null;
  readonly leaseToken: bigint;
  readonly leaseExpiresAt: Date | null;
  readonly availableAt: Date;
  readonly lastErrorClass: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
}

export interface LedgerArchiveExportClaim extends LedgerArchiveExportJob {
  readonly status: 'running';
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
}

export interface LedgerArchiveExportJobRepository {
  readonly enqueue: (input: { jobId: string; segmentId: string; availableAt?: Date }) => Promise<LedgerArchiveExportJob>;
  readonly get: (jobId: string) => Promise<LedgerArchiveExportJob | undefined>;
  readonly getBySegment: (segmentId: string) => Promise<LedgerArchiveExportJob | undefined>;
  readonly list: (limit?: number) => Promise<readonly LedgerArchiveExportJob[]>;
  readonly claimDue: (input: {
    leaseOwner: string; leaseDurationMs: number; limit?: number;
  }) => Promise<readonly LedgerArchiveExportClaim[]>;
  readonly succeed: (claim: LedgerArchiveExportClaim) => Promise<LedgerArchiveExportJob>;
  readonly retry: (claim: LedgerArchiveExportClaim, errorClass: string, delayMs: number) => Promise<LedgerArchiveExportJob>;
  readonly fail: (claim: LedgerArchiveExportClaim, errorClass: string) => Promise<LedgerArchiveExportJob>;
}

export class LedgerArchiveExportJobError extends Error {
  constructor(readonly stableCode: 'job_not_found' | 'lease_fenced' | 'job_conflict' | 'invalid_job' | 'segment_not_verified', message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LedgerArchiveExportJobError';
  }
}

interface JobRow {
  job_id: string;
  segment_id: string;
  status: LedgerArchiveExportJobStatus;
  attempt_count: number;
  lease_owner: string | null;
  lease_token: string;
  lease_expires_at: Date | null;
  available_at: Date;
  last_error_class: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

const SELECT_JOB = sql.raw(`
  job_id::text, segment_id::text, status, attempt_count,
  lease_owner, lease_token::text, lease_expires_at, available_at,
  last_error_class, created_at, started_at, completed_at, updated_at
`);
const SELECT_UPDATED_JOB = sql.raw(`
  jobs.job_id::text, jobs.segment_id::text, jobs.status, jobs.attempt_count,
  jobs.lease_owner, jobs.lease_token::text, jobs.lease_expires_at, jobs.available_at,
  jobs.last_error_class, jobs.created_at, jobs.started_at, jobs.completed_at, jobs.updated_at
`);

export function createPostgresLedgerArchiveExportJobRepository(
  db: Kysely<DatabaseSchema>,
): LedgerArchiveExportJobRepository {
  async function get(jobId: string): Promise<LedgerArchiveExportJob | undefined> {
    try {
      const result = await sql<JobRow>`
        SELECT ${SELECT_JOB} FROM ledger_archive_export_jobs WHERE job_id=${jobId}::uuid
      `.execute(db);
      return result.rows[0] === undefined ? undefined : mapJob(result.rows[0]);
    } catch (error) {
      throw invalidJob(error);
    }
  }

  const repository: LedgerArchiveExportJobRepository = {
    async enqueue(input) {
      try {
        const result = await sql<JobRow>`
          INSERT INTO ledger_archive_export_jobs (job_id, segment_id, available_at)
          VALUES (${input.jobId}::uuid, ${input.segmentId}::uuid, ${input.availableAt ?? new Date()})
          ON CONFLICT (segment_id) DO NOTHING
          RETURNING ${SELECT_JOB}
        `.execute(db);
        const created = result.rows[0];
        if (created) return mapJob(created);
        const existing = await sql<JobRow>`
          SELECT ${SELECT_JOB} FROM ledger_archive_export_jobs WHERE segment_id=${input.segmentId}::uuid
        `.execute(db);
        if (!existing.rows[0]) throw new LedgerArchiveExportJobError('job_conflict', 'Archive export job conflict.');
        return mapJob(existing.rows[0]);
      } catch (error) {
        if (error instanceof LedgerArchiveExportJobError) throw error;
        throw invalidJob(error);
      }
    },
    get,
    async getBySegment(segmentId) {
      try {
        const result = await sql<JobRow>`
          SELECT ${SELECT_JOB} FROM ledger_archive_export_jobs WHERE segment_id=${segmentId}::uuid
        `.execute(db);
        return result.rows[0] === undefined ? undefined : mapJob(result.rows[0]);
      } catch (error) {
        throw invalidJob(error);
      }
    },
    async list(limit = 100) {
      assertLimit(limit);
      try {
        const result = await sql<JobRow>`
          SELECT ${SELECT_JOB} FROM ledger_archive_export_jobs
          ORDER BY created_at DESC, job_id DESC LIMIT ${limit}
        `.execute(db);
        return Object.freeze(result.rows.map(mapJob));
      } catch (error) {
        throw stableDatabaseError(error);
      }
    },
    async claimDue(input) {
      const limit = input.limit ?? 1;
      assertLimit(limit);
      if (!validOwner(input.leaseOwner) || !Number.isSafeInteger(input.leaseDurationMs)
          || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 3_600_000) {
        throw invalidJob();
      }
      try {
        const result = await sql<JobRow>`
          WITH due AS (
          SELECT job_id
          FROM ledger_archive_export_jobs
          WHERE (
            status IN ('pending', 'retryable') AND available_at <= current_timestamp
          ) OR (
            status = 'running' AND lease_expires_at <= current_timestamp
          )
          ORDER BY available_at ASC, created_at ASC, job_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE ledger_archive_export_jobs AS jobs
        SET status='running', lease_owner=${input.leaseOwner},
            lease_token=jobs.lease_token+1,
            lease_expires_at=current_timestamp + (${input.leaseDurationMs} * interval '1 millisecond'),
            attempt_count=jobs.attempt_count+1,
            started_at=jobs.started_at,
            completed_at=NULL
        FROM due WHERE jobs.job_id=due.job_id
        RETURNING ${SELECT_UPDATED_JOB}
        `.execute(db);
        return Object.freeze(result.rows.map((row) => asClaim(mapJob(row))));
      } catch (error) {
        throw stableDatabaseError(error);
      }
    },
    succeed: (claim) => finishClaim(db, claim, 'succeeded', null, 0),
    retry: (claim, errorClass, delayMs) => finishClaim(db, claim, 'retryable', errorClass, delayMs),
    fail: (claim, errorClass) => finishClaim(db, claim, 'failed', errorClass, 0),
  };
  return Object.freeze(repository);
}

async function finishClaim(
  db: Kysely<DatabaseSchema>,
  claim: LedgerArchiveExportClaim,
  status: 'succeeded' | 'retryable' | 'failed',
  errorClass: string | null,
  delayMs: number,
): Promise<LedgerArchiveExportJob> {
  if ((errorClass !== null && !/^[a-z][a-z0-9_]{0,95}$/u.test(errorClass))
      || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 86_400_000) {
    throw invalidJob();
  }
  let result;
  try {
    result = await sql<JobRow>`
      UPDATE ledger_archive_export_jobs
      SET status=${status}, lease_owner=NULL, lease_expires_at=NULL,
          available_at=CASE WHEN ${status}='retryable'
            THEN current_timestamp + (${delayMs} * interval '1 millisecond') ELSE available_at END,
          last_error_class=${errorClass}, completed_at=NULL
      WHERE job_id=${claim.jobId}::uuid AND status='running'
        AND lease_owner=${claim.leaseOwner} AND lease_token=${claim.leaseToken}
        AND lease_expires_at > current_timestamp
      RETURNING ${SELECT_JOB}
    `.execute(db);
  } catch (error) {
    throw stableDatabaseError(error);
  }
  if (result.rows[0]) return mapJob(result.rows[0]);
  try {
    if (!await getExists(db, claim.jobId)) {
      throw new LedgerArchiveExportJobError('job_not_found', 'Archive export job was not found.');
    }
  } catch (error) {
    throw stableDatabaseError(error);
  }
  throw new LedgerArchiveExportJobError('lease_fenced', 'Archive export job lease was fenced.');
}

async function getExists(db: Kysely<DatabaseSchema>, jobId: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS(SELECT 1 FROM ledger_archive_export_jobs WHERE job_id=${jobId}::uuid) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

function mapJob(row: JobRow): LedgerArchiveExportJob {
  return Object.freeze({
    jobId: row.job_id, segmentId: row.segment_id, status: row.status,
    attemptCount: row.attempt_count, leaseOwner: row.lease_owner,
    leaseToken: BigInt(row.lease_token), leaseExpiresAt: row.lease_expires_at,
    availableAt: row.available_at, lastErrorClass: row.last_error_class,
    createdAt: row.created_at, startedAt: row.started_at,
    completedAt: row.completed_at, updatedAt: row.updated_at,
  });
}

function asClaim(job: LedgerArchiveExportJob): LedgerArchiveExportClaim {
  if (job.status !== 'running' || job.leaseOwner === null || job.leaseExpiresAt === null) {
    throw invalidJob();
  }
  return job as LedgerArchiveExportClaim;
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidJob();
}

function validOwner(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f]/u.test(value);
}

function invalidJob(cause?: unknown): LedgerArchiveExportJobError {
  return new LedgerArchiveExportJobError('invalid_job', 'Archive export job input was invalid.', cause);
}

function stableDatabaseError(error: unknown): LedgerArchiveExportJobError {
  if (error instanceof LedgerArchiveExportJobError) return error;
  const constraint = (error as { constraint?: unknown }).constraint;
  if (constraint === 'ledger_archive_export_jobs_verified_gate') {
    return new LedgerArchiveExportJobError(
      'segment_not_verified', 'Archive export job cannot succeed before segment verification.', error,
    );
  }
  if (constraint === 'ledger_archive_export_jobs_lease_guard'
      || constraint === 'ledger_archive_export_jobs_transition_guard') {
    return new LedgerArchiveExportJobError('job_conflict', 'Archive export job state conflicted.', error);
  }
  return invalidJob(error);
}
