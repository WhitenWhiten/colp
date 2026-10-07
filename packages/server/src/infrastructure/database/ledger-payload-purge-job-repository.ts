import { sql, type Kysely } from 'kysely';

import type { DatabaseSchema } from './runtime.js';
import type { DatabaseTransaction } from './unit-of-work.js';
import type {
  LedgerPayloadPurgeFamily,
  LedgerPayloadPurgeStatus,
} from './ledger-payload-purge-tables.js';

export interface LedgerPayloadPurgeJob {
  readonly jobId: string;
  readonly segmentId: string;
  readonly family: LedgerPayloadPurgeFamily;
  readonly scopeKey: string;
  readonly lowerBound: bigint;
  readonly upperBound: bigint;
  readonly floorCommitOrdinal: bigint | null;
  readonly floorTieBreaker: string | null;
  readonly floorRevision: bigint | null;
  readonly status: LedgerPayloadPurgeStatus;
  readonly attemptCount: number;
  readonly leaseOwner: string | null;
  readonly leaseToken: bigint;
  readonly leaseExpiresAt: Date | null;
  readonly availableAt: Date;
  readonly lastErrorClass: string | null;
  readonly deletedRowCount: bigint;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
}

export interface LedgerPayloadPurgeJobClaim extends LedgerPayloadPurgeJob {
  readonly status: 'running';
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
}

export interface EnqueueLedgerPayloadPurgeJobInput {
  readonly jobId: string;
  readonly segmentId: string;
  readonly family: LedgerPayloadPurgeFamily;
  readonly scopeKey: string;
  readonly lowerBound: bigint;
  readonly upperBound: bigint;
  readonly floorCommitOrdinal?: bigint | null;
  readonly floorTieBreaker?: string | null;
  readonly floorRevision?: bigint | null;
  readonly authorizationReference: string;
  readonly authorizationEvidence: Readonly<Record<string, unknown>>;
  readonly availableAt?: Date;
}

export interface LedgerPayloadPurgeJobRepository {
  enqueue(input: EnqueueLedgerPayloadPurgeJobInput): Promise<LedgerPayloadPurgeJob>;
  get(jobId: string): Promise<LedgerPayloadPurgeJob | undefined>;
  getBySegment(segmentId: string): Promise<LedgerPayloadPurgeJob | undefined>;
  list(limit?: number): Promise<readonly LedgerPayloadPurgeJob[]>;
  claimSegment(input: {
    readonly segmentId: string;
    readonly leaseOwner: string;
    readonly leaseDurationMs: number;
  }): Promise<LedgerPayloadPurgeJobClaim | undefined>;
  /** Completes only inside the executor transaction after its segment detach CAS. */
  succeed(
    transaction: DatabaseTransaction,
    claim: LedgerPayloadPurgeJobClaim,
  ): Promise<LedgerPayloadPurgeJob>;
  retry(claim: LedgerPayloadPurgeJobClaim, errorClass: string, delayMs: number): Promise<LedgerPayloadPurgeJob>;
  fail(claim: LedgerPayloadPurgeJobClaim, errorClass: string): Promise<LedgerPayloadPurgeJob>;
}

export class LedgerPayloadPurgeJobError extends Error {
  constructor(
    readonly stableCode: 'job_not_found' | 'job_conflict' | 'lease_fenced' | 'invalid_job',
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LedgerPayloadPurgeJobError';
  }
}

interface JobRow {
  job_id: string;
  segment_id: string;
  family: LedgerPayloadPurgeFamily;
  scope_key: string;
  lower_bound: string;
  upper_bound: string;
  floor_commit_ordinal: string | null;
  floor_tie_breaker: string | null;
  floor_revision: string | null;
  status: LedgerPayloadPurgeStatus;
  attempt_count: number;
  lease_owner: string | null;
  lease_token: string;
  lease_expires_at: Date | null;
  available_at: Date;
  last_error_class: string | null;
  deleted_row_count: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

const JOB_COLUMNS = sql.raw(`
  job_id::text,segment_id::text,family,scope_key,lower_bound::text,upper_bound::text,
  floor_commit_ordinal::text,floor_tie_breaker,floor_revision::text,status,attempt_count,
  lease_owner,lease_token::text,lease_expires_at,available_at,last_error_class,
  deleted_row_count::text,created_at,started_at,completed_at,updated_at
`);
const UPDATED_JOB_COLUMNS = sql.raw(`
  job.job_id::text,job.segment_id::text,job.family,job.scope_key,
  job.lower_bound::text,job.upper_bound::text,job.floor_commit_ordinal::text,
  job.floor_tie_breaker,job.floor_revision::text,job.status,job.attempt_count,
  job.lease_owner,job.lease_token::text,job.lease_expires_at,job.available_at,
  job.last_error_class,job.deleted_row_count::text,job.created_at,job.started_at,
  job.completed_at,job.updated_at
`);

export function createPostgresLedgerPayloadPurgeJobRepository(
  database: Kysely<DatabaseSchema>,
): LedgerPayloadPurgeJobRepository {
  const repository: LedgerPayloadPurgeJobRepository = {
    async enqueue(input) {
      validateEnqueue(input);
      try {
        const result = await sql<JobRow>`INSERT INTO ledger_payload_purge_jobs(
          job_id,segment_id,family,scope_key,lower_bound,upper_bound,
          floor_commit_ordinal,floor_tie_breaker,floor_revision,
          authorization_mode,authorization_environment,authorization_reference,
          authorization_evidence,available_at
        ) VALUES (
          ${input.jobId}::uuid,${input.segmentId}::uuid,${input.family},${input.scopeKey},
          ${input.lowerBound},${input.upperBound},${input.floorCommitOrdinal ?? null},
          ${input.floorTieBreaker ?? null},${input.floorRevision ?? null},
          'development','development',${input.authorizationReference},
          ${JSON.stringify(input.authorizationEvidence)}::jsonb,${input.availableAt ?? new Date()}
        ) ON CONFLICT(segment_id) DO NOTHING RETURNING ${JOB_COLUMNS}`.execute(database);
        if (result.rows[0]) return mapJob(result.rows[0]);
        const existing = await repository.getBySegment(input.segmentId);
        if (!existing) throw jobError('job_conflict', 'Payload purge job conflict.');
        return existing;
      } catch (error) {
        if (error instanceof LedgerPayloadPurgeJobError) throw error;
        throw jobError('invalid_job', 'Payload purge job was rejected.', error);
      }
    },
    async get(jobId) {
      return selectOne(database, sql`job_id=${jobId}::uuid`);
    },
    async getBySegment(segmentId) {
      return selectOne(database, sql`segment_id=${segmentId}::uuid`);
    },
    async list(limit = 100) {
      assertLimit(limit);
      const rows = await sql<JobRow>`SELECT ${JOB_COLUMNS} FROM ledger_payload_purge_jobs
        ORDER BY created_at DESC,job_id DESC LIMIT ${limit}`.execute(database);
      return Object.freeze(rows.rows.map(mapJob));
    },
    async claimSegment(input) {
      validateLease(input.leaseOwner, input.leaseDurationMs);
      const result = await sql<JobRow>`UPDATE ledger_payload_purge_jobs job SET
          status='running',attempt_count=job.attempt_count+1,
          lease_owner=${input.leaseOwner},lease_token=job.lease_token+1,
          lease_expires_at=current_timestamp+(${input.leaseDurationMs}*interval '1 millisecond'),
          started_at=coalesce(job.started_at,current_timestamp),completed_at=NULL
        WHERE job.segment_id=${input.segmentId}::uuid AND (
          (job.status IN ('pending','retryable') AND job.available_at<=current_timestamp)
          OR (job.status='running' AND job.lease_expires_at<=current_timestamp)
        ) RETURNING ${UPDATED_JOB_COLUMNS}`.execute(database);
      return result.rows[0] === undefined ? undefined : asClaim(mapJob(result.rows[0]));
    },
    succeed: (transaction, claim) => succeedClaim(transaction, claim),
    retry: (claim, errorClass, delayMs) => finishClaim(
      database, claim, 'retryable', errorClass, delayMs,
    ),
    fail: (claim, errorClass) => finishClaim(database, claim, 'failed', errorClass, 0),
  };
  return Object.freeze(repository);
}

async function succeedClaim(
  transaction: DatabaseTransaction,
  claim: LedgerPayloadPurgeJobClaim,
): Promise<LedgerPayloadPurgeJob> {
  await setClaimCapability(transaction, claim);
  const result = await sql<JobRow>`UPDATE ledger_payload_purge_jobs job SET
      status='succeeded',lease_owner=NULL,lease_expires_at=NULL,
      last_error_class=NULL,completed_at=current_timestamp
    WHERE job.job_id=${claim.jobId}::uuid AND job.status='running'
      AND job.lease_owner=${claim.leaseOwner} AND job.lease_token=${claim.leaseToken}
      AND job.lease_expires_at>current_timestamp
    RETURNING ${UPDATED_JOB_COLUMNS}`.execute(transaction);
  if (!result.rows[0]) throw jobError('lease_fenced', 'Payload purge job lease was fenced.');
  return mapJob(result.rows[0]);
}

async function selectOne(
  database: Kysely<DatabaseSchema>,
  predicate: ReturnType<typeof sql>,
): Promise<LedgerPayloadPurgeJob | undefined> {
  try {
    const result = await sql<JobRow>`SELECT ${JOB_COLUMNS} FROM ledger_payload_purge_jobs
      WHERE ${predicate}`.execute(database);
    return result.rows[0] === undefined ? undefined : mapJob(result.rows[0]);
  } catch (error) {
    throw jobError('invalid_job', 'Payload purge job identity is invalid.', error);
  }
}

async function finishClaim(
  database: Kysely<DatabaseSchema>,
  claim: LedgerPayloadPurgeJobClaim,
  status: 'retryable' | 'failed',
  errorClass: string,
  delayMs: number,
): Promise<LedgerPayloadPurgeJob> {
  if (!/^[a-z][a-z0-9_]{0,95}$/u.test(errorClass)
      || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 86_400_000) {
    throw jobError('invalid_job', 'Payload purge outcome is invalid.');
  }
  return database.transaction().execute(async (transaction) => {
    await setClaimCapability(transaction, claim);
    const result = await sql<JobRow>`UPDATE ledger_payload_purge_jobs job SET
        status=${status},lease_owner=NULL,lease_expires_at=NULL,last_error_class=${errorClass},
        available_at=case when ${status}='retryable'
          then current_timestamp+(${delayMs}*interval '1 millisecond') else job.available_at end,
        completed_at=case when ${status}='failed' then current_timestamp else NULL end
      WHERE job.job_id=${claim.jobId}::uuid AND job.status='running'
        AND job.lease_owner=${claim.leaseOwner} AND job.lease_token=${claim.leaseToken}
        AND job.lease_expires_at>current_timestamp
      RETURNING ${UPDATED_JOB_COLUMNS}`.execute(transaction);
    if (result.rows[0]) return mapJob(result.rows[0]);
    const exists = await sql<{ exists: boolean }>`SELECT EXISTS(
      SELECT 1 FROM ledger_payload_purge_jobs WHERE job_id=${claim.jobId}::uuid) exists`
      .execute(transaction);
    if (!exists.rows[0]?.exists) throw jobError('job_not_found', 'Payload purge job was not found.');
    throw jobError('lease_fenced', 'Payload purge job lease was fenced.');
  });
}

async function setClaimCapability(
  transaction: DatabaseTransaction,
  claim: LedgerPayloadPurgeJobClaim,
): Promise<void> {
  await sql`SELECT
    set_config('known.ledger_payload_purge_job',${claim.jobId},true),
    set_config('known.ledger_payload_purge_lease_token',${claim.leaseToken.toString()},true),
    set_config('known.ledger_payload_purge_transaction',pg_current_xact_id()::text,true)
  `.execute(transaction);
}

function mapJob(row: JobRow): LedgerPayloadPurgeJob {
  return Object.freeze({
    jobId: row.job_id, segmentId: row.segment_id, family: row.family,
    scopeKey: row.scope_key, lowerBound: BigInt(row.lower_bound), upperBound: BigInt(row.upper_bound),
    floorCommitOrdinal: nullableBigint(row.floor_commit_ordinal),
    floorTieBreaker: row.floor_tie_breaker, floorRevision: nullableBigint(row.floor_revision),
    status: row.status, attemptCount: row.attempt_count, leaseOwner: row.lease_owner,
    leaseToken: BigInt(row.lease_token), leaseExpiresAt: row.lease_expires_at,
    availableAt: row.available_at, lastErrorClass: row.last_error_class,
    deletedRowCount: BigInt(row.deleted_row_count), createdAt: row.created_at,
    startedAt: row.started_at, completedAt: row.completed_at, updatedAt: row.updated_at,
  });
}

function asClaim(job: LedgerPayloadPurgeJob): LedgerPayloadPurgeJobClaim {
  if (job.status !== 'running' || job.leaseOwner === null || job.leaseExpiresAt === null) {
    throw jobError('invalid_job', 'Claimed payload purge job has no live lease.');
  }
  return job as LedgerPayloadPurgeJobClaim;
}

function validateEnqueue(input: EnqueueLedgerPayloadPurgeJobInput): void {
  if (input.lowerBound < 1n || input.upperBound <= input.lowerBound
      || input.scopeKey.length < 1 || input.scopeKey.length > 256
      || input.authorizationReference.length < 1 || input.authorizationReference.length > 256
      || input.authorizationEvidence.developmentDataLossAuthorized !== true) {
    throw jobError('invalid_job', 'Payload purge job binding or evidence is invalid.');
  }
}

function validateLease(owner: string, durationMs: number): void {
  if (owner.length < 1 || owner.length > 128 || /[\u0000-\u001f]/u.test(owner)
      || !Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 3_600_000) {
    throw jobError('invalid_job', 'Payload purge lease input is invalid.');
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw jobError('invalid_job', 'Payload purge list limit is invalid.');
  }
}

function nullableBigint(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function jobError(
  stableCode: LedgerPayloadPurgeJobError['stableCode'],
  message: string,
  cause?: unknown,
): LedgerPayloadPurgeJobError {
  return new LedgerPayloadPurgeJobError(stableCode, message, cause);
}
