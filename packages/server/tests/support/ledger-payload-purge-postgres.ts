import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  applyLedgerPayloadPurgeBatch,
  type LedgerPayloadPurgeClaim,
} from '../../src/infrastructure/database/ledger-payload-purge.js';
import { createPostgresLedgerPayloadPurgeJobRepository } from '../../src/infrastructure/database/ledger-payload-purge-job-repository.js';
import { createPostgresLedgerArchiveSegmentRepository } from '../../src/infrastructure/database/index.js';
import type { IsolatedPostgresRuntime } from './postgres-test-runtime.js';

export interface JobBinding {
  segmentId: string;
  family: 'operation' | 'audit_payload' | 'outbox_social';
  scopeKey: string;
  lower: bigint;
  upper: bigint;
  floorOrdinal?: bigint;
  floorTieBreaker?: string;
  floorRevision?: bigint;
}

export class SimulatedCrash extends Error {}

export async function enqueueAndClaim(
  isolated: IsolatedPostgresRuntime,
  role: string,
  binding: JobBinding,
): Promise<LedgerPayloadPurgeClaim> {
  const jobId = randomUUID();
  const jobs = createPostgresLedgerPayloadPurgeJobRepository(isolated.runtime.db);
  await jobs.enqueue({
    jobId, segmentId: binding.segmentId, family: binding.family,
    scopeKey: binding.scopeKey, lowerBound: binding.lower, upperBound: binding.upper,
    floorCommitOrdinal: binding.floorOrdinal, floorTieBreaker: binding.floorTieBreaker,
    floorRevision: binding.floorRevision, authorizationReference: 'integration-test',
    authorizationEvidence: { developmentDataLossAuthorized: true, test: true },
  });
  const claimed = await jobs.claimSegment({
    segmentId: binding.segmentId, leaseOwner: role, leaseDurationMs: 300_000,
  });
  assert.ok(claimed);
  return claimed;
}

export async function applyAsExecutor(
  isolated: IsolatedPostgresRuntime,
  role: string,
  claim: LedgerPayloadPurgeClaim,
) {
  return isolated.runtime.db.transaction().execute(async (transaction) => {
    await sql.raw(`set local session authorization ${role}`).execute(transaction);
    return applyLedgerPayloadPurgeBatch(transaction, {
      claim, confirmedSegmentId: claim.segmentId, nodeEnvironment: 'test',
      destructiveMode: 'development', batchSize: 1,
    });
  });
}

export async function provisionRoles(
  isolated: IsolatedPostgresRuntime,
  executorRole: string,
  ordinaryRole: string,
): Promise<void> {
  await isolated.runtime.pool.query(`DO $block$ BEGIN
    IF to_regrole('known_ledger_payload_purger') IS NULL THEN
      CREATE ROLE known_ledger_payload_purger NOLOGIN;
    END IF;
    IF to_regrole('known_operation_payload_archiver') IS NULL THEN
      CREATE ROLE known_operation_payload_archiver NOLOGIN;
    END IF;
    IF to_regrole('known_audit_payload_archiver') IS NULL THEN
      CREATE ROLE known_audit_payload_archiver NOLOGIN;
    END IF;
    IF to_regrole('known_outbox_payload_archiver') IS NULL THEN
      CREATE ROLE known_outbox_payload_archiver NOLOGIN;
    END IF;
  END $block$`);
  await isolated.runtime.pool.query(`CREATE ROLE ${executorRole} NOLOGIN`);
  await isolated.runtime.pool.query(`CREATE ROLE ${ordinaryRole} NOLOGIN`);
  await isolated.runtime.pool.query(`GRANT known_ledger_payload_purger,
    known_operation_payload_archiver,known_audit_payload_archiver,
    known_outbox_payload_archiver TO ${executorRole}`);
  await isolated.runtime.pool.query(`GRANT USAGE ON SCHEMA ${isolated.schema}
    TO ${executorRole},${ordinaryRole}`);
  await isolated.runtime.pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${isolated.schema}
    TO ${executorRole},${ordinaryRole}`);
  await isolated.runtime.pool.query(`GRANT INSERT,UPDATE ON ledger_payload_purge_jobs TO ${executorRole}`);
  await isolated.runtime.pool.query(`GRANT INSERT ON ledger_payload_purge_receipts TO ${executorRole}`);
  await isolated.runtime.pool.query(`GRANT UPDATE ON ledger_archive_segments,operations,audit_events
    TO ${executorRole}`);
  await isolated.runtime.pool.query(`GRANT DELETE ON operation_payloads,audit_event_payloads,outbox_events
    TO ${executorRole},${ordinaryRole}`);
}

export async function readySegment(
  isolated: IsolatedPostgresRuntime,
  input: { family: string; relation: string; scope: string; lower: bigint; upper: bigint },
  target: 'verified' | 'reader_cutover' = 'reader_cutover',
): Promise<string> {
  const repository = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
  const segmentId = randomUUID();
  let segment = await repository.create({
    segmentId, ledgerFamily: input.family, sourceRelation: input.relation,
    sourceScope: input.scope, sourceKeyKind: 'bigint',
    sourceKeyComparator: 'signed-bigint-ascending-v1',
    sourceKeyBounds: { lowerInclusive: input.lower, upperExclusive: input.upper },
    rowCount: input.upper - input.lower, sourceBytes: 128n,
    contentDigest: `sha256:${'a'.repeat(64)}`,
    archiveObjectUri: `s3://known-purge/${segmentId}`,
    archiveObjectEtag: `etag-${segmentId}`, archiveSchemaVersion: 1,
    kmsKeyId: 'kms:known:payload-purge-v1', deleteAfter: null,
  });
  for (const state of ['sealed', 'exported', 'verified', 'reader_cutover'] as const) {
    segment = await repository.transition({
      segmentId, expectedState: segment.state, expectedRevision: segment.stateRevision,
      targetState: state, evidence: { integrationTest: true, state },
    });
    if (state === target) break;
  }
  return segmentId;
}

export async function transitionReaderCutover(
  isolated: IsolatedPostgresRuntime,
  segmentId: string,
): Promise<void> {
  const repository = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
  const segment = await repository.get(segmentId);
  assert.ok(segment);
  await repository.transition({
    segmentId, expectedState: 'verified', expectedRevision: segment.stateRevision,
    targetState: 'reader_cutover', evidence: { integrationTest: true, reader: 'verified' },
  });
}

export async function seedCollection(
  isolated: IsolatedPostgresRuntime,
  collectionId: string,
  rootId: string,
): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      values($1,'collection'),($2,'node')`, [collectionId, rootId]);
    await client.query(`insert into collections(id,owner_subject_id,title,kind,
      root_node_id,resource_revision,content_revision,policy_revision)
      values($1,'payload-purge-owner','Purge','bookmarks',$2,'r1','c1','p1')`,
    [collectionId, rootId]);
    await client.query(`insert into nodes(id,collection_id,kind,is_root,title,
      resource_revision,children_revision) values($1,$2,'folder',true,'Root','r1','ch1')`,
    [rootId, collectionId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function seedOutbox(
  isolated: IsolatedPostgresRuntime,
  scope: string,
  id: string,
  ordinal: bigint,
  occurredAt: string,
  state: 'completed' | 'pending',
): Promise<void> {
  await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
    values($1,'outbox')`, [id]);
  await isolated.runtime.pool.query(`insert into outbox_events(
    outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
    aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,
    occurred_at,payload_json,state,attempt_count,available_at,lease_generation,completed_at)
    values($1,$1,'social.collection-change',1,'social.publish-collection-change',
      'projection_latest_only','collection',$2,$2,'r1',$3,$4,'{}',$5,0,current_timestamp,0,
      case when $5='completed' then $4::timestamptz else null end)`,
  [id, scope, ordinal.toString(), occurredAt, state]);
}

export async function assertReceiptAndDetached(
  isolated: IsolatedPostgresRuntime,
  jobId: string,
  segmentId: string,
  count: number,
  deletedRowCount: bigint,
): Promise<void> {
  const row = (await isolated.runtime.pool.query<{
    status: string; receipt_count: number; segment_state: string; deleted_row_count: string;
  }>(`select job.status,
      (select count(*)::int from ledger_payload_purge_receipts receipt
        where receipt.job_id=job.job_id) receipt_count,
      (select state from ledger_archive_segments segment
        where segment.segment_id=job.segment_id) segment_state,
      job.deleted_row_count::text
    from ledger_payload_purge_jobs job where job.job_id=$1 and job.segment_id=$2`,
  [jobId, segmentId])).rows[0]!;
  assert.deepEqual(row, {
    status: 'succeeded', receipt_count: count,
    segment_state: 'detached', deleted_row_count: deletedRowCount.toString(),
  });
}

export function hasConstraint(constraint: string) {
  return (error: unknown): boolean => (error as { constraint?: string }).constraint === constraint;
}
