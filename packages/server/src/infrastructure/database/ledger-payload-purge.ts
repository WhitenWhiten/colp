import { sql } from 'kysely';

import { evaluateLedgerArchivePolicyFromLinear } from './ledger-archive-policy.js';
import type { DatabaseTransaction } from './unit-of-work.js';
import { createPostgresAuditPayloadArchiveCapability } from './audit-event-payload.js';
import type {
  LedgerPayloadPurgeFamily,
  LedgerPayloadPurgeStatus,
} from './ledger-payload-purge-tables.js';

export interface LedgerPayloadPurgeClaim {
  readonly jobId: string;
  readonly segmentId: string;
  readonly family: LedgerPayloadPurgeFamily;
  readonly leaseOwner: string;
  readonly leaseToken: bigint;
}

export interface ApplyLedgerPayloadPurgeInput {
  readonly claim: LedgerPayloadPurgeClaim;
  readonly confirmedSegmentId: string;
  readonly nodeEnvironment: string;
  readonly destructiveMode: string;
  readonly batchSize?: number;
}

export interface LedgerPayloadPurgeBatchResult {
  readonly jobId: string;
  readonly segmentId: string;
  readonly family: LedgerPayloadPurgeFamily;
  readonly deletedThisBatch: bigint;
  readonly deletedTotal: bigint;
  readonly status: 'retryable' | 'succeeded';
}

export type LedgerPayloadPurgeErrorCode =
  | 'destructive_mode_disabled'
  | 'segment_confirmation_mismatch'
  | 'invalid_batch_size'
  | 'lease_fenced'
  | 'job_binding_mismatch'
  | 'purge_invariant_failed';

export class LedgerPayloadPurgeError extends Error {
  constructor(readonly stableCode: LedgerPayloadPurgeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LedgerPayloadPurgeError';
  }
}

interface LockedJobRow {
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
  lease_owner: string | null;
  lease_token: string;
  lease_expires_at: Date | null;
  deleted_row_count: string;
}

interface LockedArchiveSegmentRow {
  state: string;
  legal_hold: boolean;
  verified_at_present: boolean;
  reader_cutover_at_present: boolean;
  verified_evidence: boolean;
  reader_evidence: boolean;
  lower_bound: string;
  upper_bound: string;
  ledger_family: string;
  source_relation: string;
  source_scope: string;
}

/**
 * Executes one bounded database-only batch. The caller owns the transaction;
 * crashes roll the header cutover and source deletion back together.
 *
 * Lock order is the purge job row, then its archive segment — the same order
 * claim uses. The segment lock is held until the caller ends the transaction.
 * A legal hold committed before that lock deletes nothing. A later hold does
 * not restore hot rows a batch has already committed.
 */
export async function applyLedgerPayloadPurgeBatch(
  transaction: DatabaseTransaction,
  input: ApplyLedgerPayloadPurgeInput,
): Promise<LedgerPayloadPurgeBatchResult> {
  assertDevelopmentAuthorization(input);
  const batchSize = input.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw purgeError('invalid_batch_size', 'Payload purge batch size must be between 1 and 10000.');
  }

  await sql`SELECT
    set_config('known.ledger_payload_purge_job', ${input.claim.jobId}, true),
    set_config('known.ledger_payload_purge_lease_token', ${input.claim.leaseToken.toString()}, true),
    set_config('known.ledger_payload_purge_transaction', pg_current_xact_id()::text, true)
  `.execute(transaction);

  const locked = await sql<LockedJobRow>`
    SELECT job_id::text, segment_id::text, family, scope_key,
           lower_bound::text, upper_bound::text,
           floor_commit_ordinal::text, floor_tie_breaker, floor_revision::text,
           status, lease_owner, lease_token::text, lease_expires_at,
           deleted_row_count::text
      FROM ledger_payload_purge_jobs
     WHERE job_id=${input.claim.jobId}::uuid
     FOR UPDATE
  `.execute(transaction);
  const job = locked.rows[0];
  if (!job || job.status !== 'running' || job.segment_id !== input.claim.segmentId
      || job.family !== input.claim.family || job.lease_owner !== input.claim.leaseOwner
      || BigInt(job.lease_token) !== input.claim.leaseToken
      || job.lease_expires_at === null || job.lease_expires_at <= new Date()) {
    throw purgeError('lease_fenced', 'Payload purge lease is absent, expired, or fenced.');
  }
  await lockArchiveSegmentForBatch(transaction, job);

  const deletedThisBatch = await deleteFamilyBatch(transaction, job, batchSize);
  const progress = await sql<{ deleted_row_count: string }>`
    UPDATE ledger_payload_purge_jobs
       SET deleted_row_count=deleted_row_count + ${deletedThisBatch}
     WHERE job_id=${job.job_id}::uuid AND status='running'
       AND lease_owner=${input.claim.leaseOwner} AND lease_token=${input.claim.leaseToken}
       AND lease_expires_at > current_timestamp
    RETURNING deleted_row_count::text
  `.execute(transaction);
  const totalText = progress.rows[0]?.deleted_row_count;
  if (totalText === undefined) throw purgeError('lease_fenced', 'Payload purge lease was fenced.');
  const deletedTotal = BigInt(totalText);

  if (await hasRemainingRows(transaction, job)) {
    const released = await sql<{ status: 'retryable' }>`
      UPDATE ledger_payload_purge_jobs
         SET status='retryable', lease_owner=NULL, lease_expires_at=NULL,
             available_at=current_timestamp, last_error_class=NULL, completed_at=NULL
       WHERE job_id=${job.job_id}::uuid AND status='running'
         AND lease_owner=${input.claim.leaseOwner} AND lease_token=${input.claim.leaseToken}
         AND lease_expires_at > current_timestamp
      RETURNING status
    `.execute(transaction);
    if (!released.rows[0]) throw purgeError('lease_fenced', 'Payload purge lease was fenced.');
    return result(job, deletedThisBatch, deletedTotal, 'retryable');
  }

  await detachSegment(transaction, job, deletedTotal);
  const completed = await sql<{ status: 'succeeded' }>`
    UPDATE ledger_payload_purge_jobs
       SET status='succeeded', lease_owner=NULL, lease_expires_at=NULL,
           last_error_class=NULL, completed_at=current_timestamp
     WHERE job_id=${job.job_id}::uuid AND status='running'
       AND lease_owner=${input.claim.leaseOwner} AND lease_token=${input.claim.leaseToken}
       AND lease_expires_at > current_timestamp
    RETURNING status
  `.execute(transaction);
  if (!completed.rows[0]) throw purgeError('lease_fenced', 'Payload purge lease was fenced.');
  return result(job, deletedThisBatch, deletedTotal, 'succeeded');
}

function assertDevelopmentAuthorization(input: ApplyLedgerPayloadPurgeInput): void {
  if (input.nodeEnvironment === 'production'
      || input.destructiveMode !== 'development') {
    throw purgeError(
      'destructive_mode_disabled',
      'Physical ledger payload purge is enabled only in explicit development destructive mode.',
    );
  }
  if (input.confirmedSegmentId !== input.claim.segmentId) {
    throw purgeError(
      'segment_confirmation_mismatch',
      'The explicitly confirmed archive segment does not match the leased purge job.',
    );
  }
}

/**
 * Reads and locks the job's archive segment after the job row. Keep this
 * predicate aligned with validate_ledger_payload_purge_binding. Claim and the
 * final detach check stay in place; detach still rechecks the hold.
 */
async function lockArchiveSegmentForBatch(
  transaction: DatabaseTransaction,
  job: LockedJobRow,
): Promise<void> {
  const locked = await sql<LockedArchiveSegmentRow>`
    SELECT state, legal_hold,
           verified_at IS NOT NULL AS verified_at_present,
           reader_cutover_at IS NOT NULL AS reader_cutover_at_present,
           (stage_evidence ? 'verified') AS verified_evidence,
           (stage_evidence ? 'reader_cutover') AS reader_evidence,
           lower(source_key_bounds)::text AS lower_bound,
           upper(source_key_bounds)::text AS upper_bound,
           ledger_family, source_relation, source_scope
      FROM ledger_archive_segments
     WHERE segment_id=${job.segment_id}::uuid
     FOR UPDATE
  `.execute(transaction);
  const segment = locked.rows[0];
  if (!segment
      || !evaluateLedgerArchivePolicyFromLinear(segment.state, segment.legal_hold).canPurgeHot
      || !segment.verified_at_present || !segment.reader_cutover_at_present
      || !segment.verified_evidence || !segment.reader_evidence
      || segment.lower_bound !== job.lower_bound || segment.upper_bound !== job.upper_bound
      || !await archiveSegmentBindingMatches(transaction, job, segment)) {
    throw purgeError(
      'job_binding_mismatch',
      'Archive segment is no longer a hold-free reader-cutover binding for this purge job.',
    );
  }
}

async function archiveSegmentBindingMatches(
  transaction: DatabaseTransaction,
  job: LockedJobRow,
  segment: LockedArchiveSegmentRow,
): Promise<boolean> {
  if (job.family === 'audit_payload') {
    return segment.ledger_family === 'audit_payload'
      && segment.source_relation === 'public.audit_event_payloads'
      && segment.source_scope === job.scope_key;
  }
  if (job.family === 'operation') return operationSegmentBindingMatches(transaction, job, segment);
  return outboxSegmentBindingMatches(transaction, job, segment);
}

async function operationSegmentBindingMatches(
  transaction: DatabaseTransaction,
  job: LockedJobRow,
  segment: LockedArchiveSegmentRow,
): Promise<boolean> {
  if (segment.ledger_family !== 'operation'
      || segment.source_relation !== 'public.operation_payloads'
      || segment.source_scope !== `collection:${job.scope_key}`
      || job.lower_bound !== '1'
      || job.floor_commit_ordinal === null
      || job.floor_tie_breaker === null
      || job.floor_revision === null) {
    return false;
  }
  const floorOrdinal = BigInt(job.floor_commit_ordinal);
  const floorRevision = BigInt(job.floor_revision);
  const result = await sql<{ ready: boolean }>`
    SELECT (
      EXISTS (
        SELECT 1 FROM sync_history_floors floor
         WHERE floor.collection_id=${job.scope_key}
           AND floor.archive_segment_id=${job.segment_id}::uuid
           AND floor.state_revision=${floorRevision}
           AND floor.floor_commit_ordinal>=${floorOrdinal}
           AND floor.floor_stable_id=${job.floor_tie_breaker}
      )
      AND NOT EXISTS (
        SELECT 1 FROM sync_replicas replica
         WHERE replica.collection_id=${job.scope_key} AND replica.status='active'
           AND (replica.checkpoint_commit_ordinal IS NULL
             OR replica.checkpoint_stream_kind IS NULL
             OR replica.checkpoint_stable_id IS NULL
             OR (replica.checkpoint_commit_ordinal, replica.checkpoint_stream_kind,
                 replica.checkpoint_stable_id COLLATE "C")
                < (${floorOrdinal}, 0, ${job.floor_tie_breaker} COLLATE "C"))
      )
    ) AS ready
  `.execute(transaction);
  return result.rows[0]?.ready === true;
}

async function outboxSegmentBindingMatches(
  transaction: DatabaseTransaction,
  job: LockedJobRow,
  segment: LockedArchiveSegmentRow,
): Promise<boolean> {
  if (segment.ledger_family !== 'outbox_social'
      || segment.source_relation !== 'public.outbox_events'
      || segment.source_scope !== job.scope_key
      || job.lower_bound !== '1'
      || job.floor_commit_ordinal === null
      || job.floor_tie_breaker === null
      || job.floor_revision === null) {
    return false;
  }
  const floorOrdinal = BigInt(job.floor_commit_ordinal);
  const floorRevision = BigInt(job.floor_revision);
  const result = await sql<{ ready: boolean }>`
    SELECT (
      EXISTS (
        SELECT 1 FROM outbox_retention_floors floor
         WHERE floor.handler_name='social.publish-collection-change'
           AND floor.event_type='social.collection-change'
           AND floor.aggregate_scope=${job.scope_key}
           AND floor.state_revision=${floorRevision}
           AND (floor.floor_commit_ordinal, floor.floor_domain_event_id)
               >= (${floorOrdinal}, ${job.floor_tie_breaker})
      )
      AND NOT EXISTS (
        SELECT 1 FROM outbox_events source
         WHERE source.handler_name='social.publish-collection-change'
           AND source.event_type='social.collection-change'
           AND source.aggregate_scope=${job.scope_key}
           AND source.commit_ordinal>=${BigInt(job.lower_bound)}
           AND source.commit_ordinal<${BigInt(job.upper_bound)}
           AND (source.commit_ordinal, source.domain_event_id)
               > (${floorOrdinal}, ${job.floor_tie_breaker})
      )
    ) AS ready
  `.execute(transaction);
  return result.rows[0]?.ready === true;
}

async function deleteFamilyBatch(
  transaction: DatabaseTransaction,
  job: LockedJobRow,
  batchSize: number,
): Promise<bigint> {
  switch (job.family) {
    case 'operation': return deleteOperationBatch(transaction, job, batchSize);
    case 'audit_payload': return deleteAuditBatch(transaction, job, batchSize);
    case 'outbox_social': return deleteOutboxBatch(transaction, job, batchSize);
  }
}

async function deleteOperationBatch(
  transaction: DatabaseTransaction,
  job: LockedJobRow,
  batchSize: number,
): Promise<bigint> {
  await sql`SELECT
    set_config('known.operation_payload_archive', 'enabled', true),
    set_config('known.operation_payload_archive_transaction', pg_current_xact_id()::text, true)
  `.execute(transaction);
  const result = await sql<{ moved_count: string; deleted_count: string }>`
    WITH candidate AS MATERIALIZED (
      SELECT payload.operation_id
        FROM operation_payloads payload
       WHERE payload.collection_id=${job.scope_key}
         AND payload.commit_ordinal>=${BigInt(job.lower_bound)}
         AND payload.commit_ordinal<${BigInt(job.upper_bound)}
       ORDER BY payload.commit_ordinal, payload.operation_id COLLATE "C"
       LIMIT ${batchSize}
    ), moved AS (
      UPDATE operations operation
         SET payload_source='archive',
             payload_locator='archive://ledger-segment/' || ${job.segment_id}::text
               || '/operation/' || operation.operation_id
        FROM candidate WHERE operation.operation_id=candidate.operation_id
          AND operation.payload_source='hot'
      RETURNING operation.operation_id
    ), removed AS (
      DELETE FROM operation_payloads payload USING moved
       WHERE payload.operation_id=moved.operation_id
      RETURNING payload.operation_id
    )
    SELECT (SELECT count(*)::text FROM moved) AS moved_count,
           (SELECT count(*)::text FROM removed) AS deleted_count
  `.execute(transaction);
  const row = result.rows[0];
  if (!row || row.moved_count !== row.deleted_count) {
    throw purgeError('purge_invariant_failed', 'Operation header cutover did not match payload deletion.');
  }
  return BigInt(row.deleted_count);
}

async function deleteAuditBatch(
  transaction: DatabaseTransaction,
  job: LockedJobRow,
  batchSize: number,
): Promise<bigint> {
  const candidates = await sql<{ id: string }>`
    SELECT event.id::text
      FROM audit_events event
     WHERE event.id>=${BigInt(job.lower_bound)} AND event.id<${BigInt(job.upper_bound)}
       AND event.hot_payload_id=event.id
     ORDER BY event.id FOR UPDATE SKIP LOCKED LIMIT ${batchSize}
  `.execute(transaction);
  const capability = createPostgresAuditPayloadArchiveCapability(transaction);
  await capability.cutoverMany({ eventIds: candidates.rows.map(candidate => BigInt(candidate.id)),
    archiveSegmentId: job.segment_id });
  return BigInt(candidates.rows.length);
}

async function deleteOutboxBatch(
  transaction: DatabaseTransaction,
  job: LockedJobRow,
  batchSize: number,
): Promise<bigint> {
  const result = await sql<{ count: string }>`
    WITH candidate AS MATERIALIZED (
      SELECT source.outbox_id
        FROM outbox_events source
       WHERE source.handler_name='social.publish-collection-change'
         AND source.event_type='social.collection-change'
         AND source.aggregate_scope=${job.scope_key}
         AND source.commit_ordinal>=${BigInt(job.lower_bound)}
         AND source.commit_ordinal<${BigInt(job.upper_bound)}
       ORDER BY source.commit_ordinal, source.domain_event_id COLLATE "C"
       LIMIT ${batchSize}
    ), removed AS (
      DELETE FROM outbox_events source USING candidate
       WHERE source.outbox_id=candidate.outbox_id
      RETURNING source.outbox_id
    )
    SELECT count(*)::text AS count FROM removed
  `.execute(transaction);
  return BigInt(result.rows[0]?.count ?? '0');
}

async function hasRemainingRows(
  transaction: DatabaseTransaction,
  job: LockedJobRow,
): Promise<boolean> {
  let query;
  if (job.family === 'operation') {
    query = sql<{ remaining: boolean }>`SELECT EXISTS(
      SELECT 1 FROM operation_payloads payload
       WHERE payload.collection_id=${job.scope_key}
         AND payload.commit_ordinal>=${BigInt(job.lower_bound)}
         AND payload.commit_ordinal<${BigInt(job.upper_bound)}) AS remaining`;
  } else if (job.family === 'audit_payload') {
    query = sql<{ remaining: boolean }>`SELECT EXISTS(
      SELECT 1 FROM audit_event_payloads payload
       WHERE payload.event_id>=${BigInt(job.lower_bound)}
         AND payload.event_id<${BigInt(job.upper_bound)}) AS remaining`;
  } else {
    query = sql<{ remaining: boolean }>`SELECT EXISTS(
      SELECT 1 FROM outbox_events source
       WHERE source.handler_name='social.publish-collection-change'
         AND source.event_type='social.collection-change'
         AND source.aggregate_scope=${job.scope_key}
         AND source.commit_ordinal>=${BigInt(job.lower_bound)}
         AND source.commit_ordinal<${BigInt(job.upper_bound)}) AS remaining`;
  }
  const remaining = await query.execute(transaction);
  return remaining.rows[0]?.remaining ?? true;
}

async function detachSegment(
  transaction: DatabaseTransaction,
  job: LockedJobRow,
  deletedTotal: bigint,
): Promise<void> {
  const segment = await sql<{ state: string; state_revision: string; legal_hold: boolean }>`
    SELECT state, state_revision::text, legal_hold FROM ledger_archive_segments
     WHERE segment_id=${job.segment_id}::uuid
     FOR UPDATE
  `.execute(transaction);
  const current = segment.rows[0];
  if (!current || !evaluateLedgerArchivePolicyFromLinear(current.state, current.legal_hold).canDetachHot) {
    throw purgeError('job_binding_mismatch', 'Archive segment is no longer reader-cutover ready.');
  }
  const revision = current.state_revision;
  const detached = await sql<{ segment_id: string }>`
    UPDATE ledger_archive_segments
       SET state='detached', state_revision=state_revision+1,
           stage_evidence=stage_evidence || jsonb_build_object('detached', jsonb_build_object(
             'purgeJobId', ${job.job_id}::text,
             'authorizationMode', 'development',
             'sourceRowsDeleted', ${deletedTotal}::bigint,
             'hotSourceEmpty', true
           ))
     WHERE segment_id=${job.segment_id}::uuid AND state='reader_cutover'
       AND state_revision=${BigInt(revision)} AND legal_hold=false
    RETURNING segment_id::text
  `.execute(transaction);
  if (!detached.rows[0]) {
    throw purgeError('job_binding_mismatch', 'Archive segment detach CAS was fenced.');
  }
}

function result(
  job: LockedJobRow,
  deletedThisBatch: bigint,
  deletedTotal: bigint,
  status: 'retryable' | 'succeeded',
): LedgerPayloadPurgeBatchResult {
  return Object.freeze({
    jobId: job.job_id, segmentId: job.segment_id, family: job.family,
    deletedThisBatch, deletedTotal, status,
  });
}

function purgeError(
  stableCode: LedgerPayloadPurgeErrorCode,
  message: string,
  cause?: unknown,
): LedgerPayloadPurgeError {
  return new LedgerPayloadPurgeError(stableCode, message, cause);
}
