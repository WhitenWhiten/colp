/**
 * U-5 restore generation: one node_id keyset page plus one gap page.
 *
 * The scan checkpoint moves only forward. Gap insertion is `NOT EXISTS` ordered
 * by node_id with a LIMIT and no stored cursor, so a restore row that lands
 * behind the checkpoint after force-off is still inserted. Client results of
 * the scan, gap, and aggregate statements are single summary rows; page
 * cardinality is the SQL count, not a fetched item list.
 */
import { sql } from 'kysely';
import type { FaviconBatchAggregate, FaviconRestoreGenerationPage } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { Kysely } from 'kysely';

export const FAVICON_RESTORE_SCAN_LIMIT = 512;

type SqlExecutor = DatabaseTransaction | Kysely<DatabaseSchema>;

/** Optional observation owned by the caller; production keeps no per-step samples. */
export type FaviconRestoreReadObserver = (sample:
  | { readonly kind: 'scan' | 'gap'; readonly summaryRows: number; readonly readCount: number }
  | { readonly kind: 'aggregate'; readonly summaryRows: number }
) => void;

function asCount(value: unknown, label: string): number {
  const count = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`favicon restore ${label} is invalid: ${String(value)}`);
  }
  return count;
}

function asNodeIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.map((entry) => String(entry)));
}

function inactivePage(): FaviconRestoreGenerationPage {
  return Object.freeze({
    readCount: 0,
    gapReadCount: 0,
    scanComplete: false,
    gapCaughtUp: true,
    cursorNodeId: null,
    inactive: true,
  });
}

async function writeRestoreJobTotal(transaction: SqlExecutor, jobId: string, now: Date): Promise<void> {
  await sql`
    update favicon_jobs
    set total = (select count(*)::int from favicon_job_items where job_id = ${jobId}),
        updated_at = ${now}
    where id = ${jobId}
  `.execute(transaction);
}

interface ScanSummary {
  read_count: number;
  last_node_id: string | null;
  inserted_count: number;
}

async function readScanPage(
  transaction: SqlExecutor,
  input: { readonly accountId: string; readonly jobId: string; readonly cursor: string | null; readonly now: Date },
  observe?: FaviconRestoreReadObserver,
): Promise<ScanSummary> {
  const cursorPredicate = input.cursor === null ? sql`` : sql`and node_id > ${input.cursor}`;
  const result = await sql<ScanSummary>`
    with page as (
      select node_id, collection_id, source_revision
      from favicon_source_restores
      where account_id = ${input.accountId}
      ${cursorPredicate}
      order by node_id
      limit ${FAVICON_RESTORE_SCAN_LIMIT}
    ),
    inserted as (
      insert into favicon_job_items (
        job_id, node_id, collection_id, source_url, source_revision,
        node_resource_revision, status, error_reason, attempts, next_attempt_at,
        object_id, object_content_type, object_byte_size, object_digest_sha256,
        created_at, updated_at
      )
      select ${input.jobId}, node_id, collection_id, '', source_revision,
             '', 'pending', null, 0, null,
             null, null, null, null,
             ${input.now}, ${input.now}
      from page
      on conflict (job_id, node_id) do nothing
      returning node_id
    )
    select (select count(*)::int from page) as read_count,
           (select max(node_id) from page) as last_node_id,
           (select count(*)::int from inserted) as inserted_count
  `.execute(transaction);
  const row = result.rows[0];
  if (row === undefined) throw new Error('favicon restore scan summary returned no row');
  const readCount = asCount(row.read_count, 'scan read count');
  const insertedCount = asCount(row.inserted_count, 'scan inserted count');
  if (insertedCount > readCount) {
    throw new Error('favicon restore scan inserted more rows than it read');
  }
  observe?.({ kind: 'scan', summaryRows: result.rows.length, readCount });
  return row;
}

interface GapSummary {
  gap_count: number;
  node_ids: string[] | null;
}

export async function insertFaviconRestoreGapPage(
  transaction: SqlExecutor,
  input: { readonly jobId: string; readonly accountId: string; readonly now: Date },
  observe?: FaviconRestoreReadObserver,
): Promise<readonly string[]> {
  const result = await sql<GapSummary>`
    with inserted as (
      insert into favicon_job_items (
        job_id, node_id, collection_id, source_url, source_revision,
        node_resource_revision, status, error_reason, attempts, next_attempt_at,
        object_id, object_content_type, object_byte_size, object_digest_sha256,
        created_at, updated_at
      )
      select ${input.jobId}, r.node_id, r.collection_id, '', r.source_revision,
             '', 'pending', null, 0, null,
             null, null, null, null,
             ${input.now}, ${input.now}
      from favicon_source_restores r
      where r.account_id = ${input.accountId}
        and not exists (
          select 1 from favicon_job_items it
          where it.job_id = ${input.jobId} and it.node_id = r.node_id
        )
      order by r.node_id
      limit ${FAVICON_RESTORE_SCAN_LIMIT}
      on conflict (job_id, node_id) do nothing
      returning node_id
    )
    select count(*)::int as gap_count,
           coalesce(array_agg(node_id order by node_id), array[]::text[]) as node_ids
    from inserted
  `.execute(transaction);
  const row = result.rows[0];
  if (row === undefined) throw new Error('favicon restore gap summary returned no row');
  const gapCount = asCount(row.gap_count, 'gap count');
  const nodeIds = asNodeIds(row.node_ids);
  if (nodeIds.length !== gapCount) {
    throw new Error(`favicon restore gap count ${gapCount} does not match ${nodeIds.length} ids`);
  }
  observe?.({ kind: 'gap', summaryRows: result.rows.length, readCount: gapCount });
  return nodeIds;
}

export async function extendFaviconRestoreGeneration(
  transaction: SqlExecutor,
  input: {
    readonly jobId: string;
    readonly accountId: string;
    readonly now: Date;
    readonly leaseOwner: string | null;
  },
  observe?: FaviconRestoreReadObserver,
): Promise<FaviconRestoreGenerationPage> {
  const locked = (await sql<{ status: string; lease_owner: string | null; account_id: string }>`
    select status, lease_owner, account_id from favicon_jobs where id = ${input.jobId} for update
  `.execute(transaction)).rows[0];
  if (locked === undefined) return inactivePage();
  if (locked.account_id !== input.accountId) {
    throw new Error('favicon restore scan account does not match the job');
  }
  const active = locked.status === 'pending' || locked.status === 'running';
  const leaseOk = input.leaseOwner === null
    ? locked.lease_owner === null && locked.status === 'pending'
    : locked.lease_owner === input.leaseOwner && active;
  if (!leaseOk) return inactivePage();

  await sql`
    insert into favicon_restore_scans (job_id, account_id, cursor_node_id, scan_complete, updated_at)
    values (${input.jobId}, ${input.accountId}, null, false, ${input.now})
    on conflict (job_id) do nothing
  `.execute(transaction);
  const scan = (await sql<{ cursor_node_id: string | null; scan_complete: boolean }>`
    select cursor_node_id, scan_complete from favicon_restore_scans
    where job_id = ${input.jobId}
    for update
  `.execute(transaction)).rows[0];
  if (scan === undefined) throw new Error('favicon restore scan row missing');

  let cursor = scan.cursor_node_id;
  let scanComplete = scan.scan_complete;
  let readCount = 0;
  if (!scanComplete) {
    const summary = await readScanPage(transaction, {
      accountId: input.accountId,
      jobId: input.jobId,
      cursor,
      now: input.now,
    }, observe);
    readCount = asCount(summary.read_count, 'scan read count');
    if (readCount > FAVICON_RESTORE_SCAN_LIMIT) {
      throw new Error(`favicon restore scan read ${readCount} rows, limit is ${FAVICON_RESTORE_SCAN_LIMIT}`);
    }
    if (readCount > 0) {
      if (typeof summary.last_node_id !== 'string' || (cursor !== null && summary.last_node_id <= cursor)) {
        throw new Error('favicon restore scan cursor did not advance');
      }
      cursor = summary.last_node_id;
    }
    scanComplete = readCount < FAVICON_RESTORE_SCAN_LIMIT;
    await sql`
      update favicon_restore_scans
      set cursor_node_id = ${cursor}, scan_complete = ${scanComplete}, updated_at = ${input.now}
      where job_id = ${input.jobId}
    `.execute(transaction);
  }

  const gapIds = await insertFaviconRestoreGapPage(transaction, input, observe);
  await writeRestoreJobTotal(transaction, input.jobId, input.now);
  return Object.freeze({
    readCount,
    gapReadCount: gapIds.length,
    scanComplete,
    gapCaughtUp: gapIds.length < FAVICON_RESTORE_SCAN_LIMIT,
    cursorNodeId: cursor,
    inactive: false,
  });
}

interface AggregateSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  pending_count: number;
  next_attempt_at: Date | null;
}

export async function aggregateFaviconJobItems(
  transaction: SqlExecutor,
  jobId: string,
  observe?: FaviconRestoreReadObserver,
): Promise<FaviconBatchAggregate> {
  const result = await sql<AggregateSummary>`
    select count(*)::int as total,
           count(*) filter (where status = 'succeeded')::int as succeeded,
           count(*) filter (where status = 'failed')::int as failed,
           count(*) filter (where status = 'skipped')::int as skipped,
           count(*) filter (where status in ('pending', 'running'))::int as pending_count,
           min(next_attempt_at) filter (
             where status in ('pending', 'running') and next_attempt_at is not null
           ) as next_attempt_at
    from favicon_job_items
    where job_id = ${jobId}
  `.execute(transaction);
  const row = result.rows[0];
  if (row === undefined) throw new Error('favicon job aggregate returned no row');
  observe?.({ kind: 'aggregate', summaryRows: result.rows.length });
  const nextAttemptAt = row.next_attempt_at === null || row.next_attempt_at === undefined
    ? null
    : new Date(row.next_attempt_at);
  return Object.freeze({
    total: asCount(row.total, 'aggregate total'),
    succeeded: asCount(row.succeeded, 'aggregate succeeded'),
    failed: asCount(row.failed, 'aggregate failed'),
    skipped: asCount(row.skipped, 'aggregate skipped'),
    pendingCount: asCount(row.pending_count, 'aggregate pending'),
    nextAttemptAt,
  });
}
