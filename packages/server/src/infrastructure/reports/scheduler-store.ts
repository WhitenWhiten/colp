import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { DigestRun, DigestSchedule } from '../../modules/reports/index.js';
import type { DigestSchedulerStore } from '../../modules/reports/index.js';
import { occurrences } from '../../modules/reports/index.js';

/** Small query seam keeps the durable store easy to exercise without a live DB. */
export type ReportsSchedulerQueryPool = Pick<Pool, 'connect' | 'query'>;

interface ScheduleRow {
  id: string;
  series_id: string;
  enabled: boolean;
  rrule: string;
  dtstart: Date | string;
  time_zone: string;
  catch_up_policy: 'skip' | 'one';
  max_catch_up: number;
  next_run_at: Date | string | null;
  resource_revision: string;
}

interface RunRow {
  id: string;
  schedule_id: string;
  schedule_revision: string | null;
  occurrence_key: string;
  scheduled_for: Date | string;
  state: DigestRun['state'];
  lease_owner: string | null;
  lease_until: Date | string | null;
  lease_generation: number | string | bigint;
  attempt_count: number;
  next_attempt_at: Date | string | null;
  last_error_class: string | null;
  issue_key: string | null;
  command_id: string | null;
  edition_id: string | null;
}

const RUN_COLUMNS = `id, schedule_id, schedule_revision, occurrence_key, scheduled_for, state,
  lease_owner, lease_until, lease_generation, attempt_count, next_attempt_at,
  last_error_class, issue_key, command_id, edition_id`;

function asDate(value: Date | string | null, label: string): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid ${label} in reports scheduler store`);
  return date;
}

function asGeneration(value: number | string | bigint): number {
  const generation = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid run lease generation');
  return generation;
}

function mapSchedule(row: ScheduleRow): DigestSchedule {
  const dtstart = asDate(row.dtstart, 'dtstart');
  if (!dtstart) throw new Error('schedule dtstart is null');
  return Object.freeze({
    id: row.id,
    seriesId: row.series_id,
    enabled: row.enabled,
    rrule: row.rrule,
    dtstart: dtstart.toISOString(),
    timeZone: row.time_zone,
    catchUpPolicy: row.catch_up_policy,
    maxCatchUp: Number(row.max_catch_up),
    nextRunAt: asDate(row.next_run_at, 'next_run_at')?.toISOString() ?? null,
    resourceRevision: row.resource_revision,
  });
}

function mapRun(row: RunRow): DigestRun {
  const scheduledFor = asDate(row.scheduled_for, 'scheduled_for');
  if (!scheduledFor) throw new Error('run scheduled_for is null');
  return Object.freeze({
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleRevision: row.schedule_revision,
    occurrenceKey: row.occurrence_key,
    scheduledFor: scheduledFor.toISOString(),
    state: row.state,
    leaseOwner: row.lease_owner,
    leaseUntil: asDate(row.lease_until, 'lease_until')?.toISOString() ?? null,
    leaseGeneration: asGeneration(row.lease_generation),
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: asDate(row.next_attempt_at, 'next_attempt_at')?.toISOString() ?? null,
    lastErrorClass: row.last_error_class,
    issueKey: row.issue_key,
    commandId: row.command_id,
    editionId: row.edition_id,
  } as DigestRun);
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`);
}

async function withTransaction<T>(pool: ReportsSchedulerQueryPool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

function rows<T extends QueryResultRow>(result: QueryResult<T>): T[] {
  return result.rows;
}

/** PostgreSQL-backed schedule/run ledger adapter used by the worker. */
export function createPostgresDigestSchedulerStore(
  pool: ReportsSchedulerQueryPool,
  options: { readonly idGenerator?: () => string } = {},
): DigestSchedulerStore {
  const idGenerator = options.idGenerator ?? (() => cryptoRandomId());

  return {
    async listDue(now, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('scheduler batch size is out of range');
      const result = await pool.query<ScheduleRow>(`
        SELECT s.id, s.series_id, s.enabled, s.rrule, s.dtstart, s.time_zone,
               s.catch_up_policy, s.max_catch_up, s.next_run_at, s.resource_revision
          FROM digest_schedules s
          JOIN digest_series rs ON rs.id = s.series_id
          JOIN accounts owner ON owner.subject_id = rs.owner_subject_id
         WHERE s.enabled = true
           AND s.deleted_at IS NULL
           AND rs.state = 'active'
           AND owner.status = 'active'
           AND owner.deleted_at IS NULL
           AND ((s.next_run_at IS NULL AND s.dtstart <= $1) OR s.next_run_at <= $1
             OR EXISTS (
                SELECT 1 FROM digest_runs pending
                WHERE pending.schedule_id = s.id
                  AND pending.scheduled_for <= $1
                  AND pending.state IN ('pending', 'retryable', 'leased')
             ))
         ORDER BY COALESCE(s.next_run_at, s.dtstart), s.id
         LIMIT $2`, [now, limit]);
      return Object.freeze(rows(result).map(mapSchedule));
    },

    async getSchedule(scheduleId) {
      assertIdentifier(scheduleId, 'schedule id');
      const result = await pool.query<ScheduleRow>(`
        SELECT s.id, s.series_id, s.enabled, s.rrule, s.dtstart, s.time_zone,
               s.catch_up_policy, s.max_catch_up, s.next_run_at, s.resource_revision
          FROM digest_schedules s
          JOIN digest_series rs ON rs.id = s.series_id
          JOIN accounts owner ON owner.subject_id = rs.owner_subject_id
         WHERE s.id = $1 AND s.enabled = true AND s.deleted_at IS NULL
           AND rs.state = 'active' AND owner.status = 'active' AND owner.deleted_at IS NULL`, [scheduleId]);
      return result.rows[0] ? mapSchedule(result.rows[0]) : null;
    },

    async listDueRuns(now, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('scheduler batch size is out of range');
      const result = await pool.query<RunRow>(`
        SELECT r.id, r.schedule_id, r.schedule_revision, r.occurrence_key, r.scheduled_for, r.state,
               r.lease_owner, r.lease_until, r.lease_generation, r.attempt_count, r.next_attempt_at,
               r.last_error_class, r.issue_key, r.command_id, r.edition_id
          FROM digest_runs r
          JOIN digest_schedules s ON s.id = r.schedule_id
          JOIN digest_series rs ON rs.id = s.series_id
          JOIN accounts owner ON owner.subject_id = rs.owner_subject_id
         WHERE s.enabled = true
           AND s.deleted_at IS NULL
           AND rs.state = 'active'
           AND owner.status = 'active'
           AND owner.deleted_at IS NULL
           AND r.scheduled_for <= $1
           AND (
             (r.state IN ('pending', 'retryable')
               AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= $1))
             OR (r.state = 'leased' AND r.lease_until IS NOT NULL AND r.lease_until <= $1)
           )
         ORDER BY r.scheduled_for, r.id
         LIMIT $2`, [now, limit]);
      return Object.freeze(rows(result).map(mapRun));
    },

    async upsertRun(value) {
      assertIdentifier(value.scheduleId, 'schedule id');
      assertIdentifier(value.occurrenceKey, 'occurrence key');
      assertIdentifier(value.scheduleRevision, 'schedule revision');
      const result = await pool.query<RunRow>(`
        INSERT INTO digest_runs (
          id, schedule_id, occurrence_key, scheduled_for, state, lease_owner,
          lease_until, lease_generation, attempt_count, next_attempt_at,
          last_error_class, issue_key, command_id, edition_id, schedule_revision, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, 0, $6, $7, $8, $9, $10, $11, $12,
                  current_timestamp, current_timestamp)
        ON CONFLICT (schedule_id, occurrence_key) DO UPDATE
          SET updated_at = current_timestamp
        RETURNING ${RUN_COLUMNS}`, [
          idGenerator(), value.scheduleId, value.occurrenceKey,
          new Date(value.scheduledFor), value.state, value.attemptCount,
          value.nextAttemptAt ? new Date(value.nextAttemptAt) : null,
          value.lastErrorClass, value.issueKey, value.commandId, value.editionId, value.scheduleRevision,
        ]);
      const row = result.rows[0];
      if (!row) throw new Error('scheduler run upsert returned no row');
      // A deterministic occurrence can never be rebound to a different Agent
      // command or issue key, even if a stale caller races the insert.
      if (row.issue_key !== value.issueKey || row.command_id !== value.commandId) {
        throw new Error('scheduler occurrence identity conflict');
      }
      return mapRun(row);
    },

    async claimRun(runId, owner, leaseMs, now, expectedGeneration) {
      return withTransaction(pool, client => claimDigestRun(
        (statement, parameters) => client.query(statement, parameters), runId, owner, leaseMs, now, expectedGeneration));
    },

    async completeRun(runId, owner, generation) {
      const params: (string | number)[] = [runId, owner];
      const generationClause = generation === undefined ? '' : ' AND lease_generation = $3';
      if (generation !== undefined) params.push(generation);
      const result = await pool.query(`
        UPDATE digest_runs
           SET state = 'succeeded', lease_owner = NULL, lease_until = NULL,
               next_attempt_at = NULL, last_error_class = NULL,
               updated_at = current_timestamp
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2
           AND lease_until > current_timestamp${generationClause}`,
      params);
      return result.rowCount === 1;
    },

    async retryRun(runId, owner, errorClass, nextAttemptAt, generation) {
      const safeClass = typeof errorClass === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(errorClass)
        ? errorClass : 'connector_error';
      const params: (string | number | Date)[] = [runId, owner, safeClass, nextAttemptAt];
      const generationClause = generation === undefined ? '' : ' AND lease_generation = $5';
      if (generation !== undefined) params.push(generation);
      const result = await pool.query(`
        UPDATE digest_runs
         SET state = 'retryable', lease_owner = NULL, lease_until = NULL,
               last_error_class = $3, next_attempt_at = $4,
               updated_at = current_timestamp
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2
           AND lease_until > current_timestamp${generationClause}`,
      params);
      return result.rowCount === 1;
    },

    async failRun(runId, owner, errorClass, generation) {
      const safeClass = typeof errorClass === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(errorClass)
        ? errorClass : 'connector_error';
      const params: (string | number)[] = [runId, owner, safeClass];
      const generationClause = generation === undefined ? '' : ' AND lease_generation = $4';
      if (generation !== undefined) params.push(generation);
      const result = await pool.query(`
        UPDATE digest_runs
         SET state = 'failed', lease_owner = NULL, lease_until = NULL,
               last_error_class = $3, next_attempt_at = NULL,
               updated_at = current_timestamp
         WHERE id = $1 AND state = 'leased' AND lease_owner = $2
           AND lease_until > current_timestamp${generationClause}`,
      params);
      return result.rowCount === 1;
    },

    async advanceSchedule(scheduleId, nextRunAt, expectedRevision) {
      assertIdentifier(scheduleId, 'schedule id');
      await pool.query(`
        UPDATE digest_schedules
           SET next_run_at = $2, updated_at = current_timestamp
         WHERE id = $1 AND enabled = true AND deleted_at IS NULL
           AND ($3::text IS NULL OR resource_revision = $3)
           AND NOT EXISTS (
             SELECT 1 FROM digest_runs pending
              WHERE pending.schedule_id = digest_schedules.id
                AND pending.scheduled_for <= current_timestamp
                AND pending.state IN ('pending', 'retryable', 'leased')
           )`,
      [scheduleId, nextRunAt, expectedRevision ?? null]);
    },
  };
}

function cryptoRandomId(): string {
  return randomUUID();
}

/** Query adapter for a caller-owned transaction (pg or Kysely). */
export type DigestClaimQuery = <Row extends object>(statement: string, parameters: unknown[])
  => Promise<{ rows: Row[] }>;

/** Both ledger entry points share owner -> series -> schedule -> run locks. */
export async function claimDigestRun(query: DigestClaimQuery, runId: string, owner: string,
  leaseMs: number, now: Date, expectedGeneration?: number): Promise<DigestRun | null> {
  assertIdentifier(runId, 'run id');
  assertIdentifier(owner, 'lease owner');
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new RangeError('invalid lease duration');
  // Archive/attach operations lock series before schedule. Keep this
  // exact order here to avoid a scheduler/archive deadlock.
  const identity = await query<{ schedule_id: string }>(
    'SELECT schedule_id FROM digest_runs WHERE id = $1', [runId]);
  const scheduleId = identity.rows[0]?.schedule_id;
  if (!scheduleId) return null;
  const scheduleIdentity = await query<{ series_id: string }>(
    'SELECT series_id FROM digest_schedules WHERE id = $1', [scheduleId]);
  const seriesId = scheduleIdentity.rows[0]?.series_id;
  if (!seriesId) return null;
  // Account lifecycle writes lock the account before discovering and
  // invalidating owned report surfaces. Acquire that same owner lock
  // first, then the series lock, so a delete cannot race this claim and
  // leave a run for a no-longer-active owner.
  const ownerIdentity = await query<{ owner_subject_id: string }>(
    'SELECT owner_subject_id FROM digest_series WHERE id = $1', [seriesId]);
  const ownerSubjectId = ownerIdentity.rows[0]?.owner_subject_id;
  if (!ownerSubjectId) return null;
  const ownerResult = await query<{ subject_id: string }>(
    `SELECT subject_id FROM accounts
       WHERE subject_id = $1 AND status = 'active' AND deleted_at IS NULL
       FOR UPDATE`, [ownerSubjectId]);
  if (!ownerResult.rows[0]) return null;
  const seriesResult = await query<{ id: string; state: string; owner_subject_id: string }>(
    `SELECT id, state, owner_subject_id
       FROM digest_series
      WHERE id = $1
      FOR UPDATE`, [seriesId]);
  const series = seriesResult.rows[0];
  if (!series || series.state !== 'active' || series.owner_subject_id !== ownerSubjectId) return null;
  const scheduleResult = await query<ScheduleRow & { deleted_at: Date | null }>(
    'SELECT * FROM digest_schedules WHERE id = $1 FOR UPDATE', [scheduleId]);
  const schedule = scheduleResult.rows[0];
  if (!schedule || schedule.series_id !== seriesId || !schedule.enabled || schedule.deleted_at !== null) return null;
  const runResult = await query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM digest_runs
      WHERE id = $1 FOR UPDATE`, [runId]);
  const run = runResult.rows[0];
  if (!run) return null;
  const currentGeneration = asGeneration(run.lease_generation);
  if (expectedGeneration !== undefined && expectedGeneration !== currentGeneration) return null;
  const scheduledFor = new Date(run.scheduled_for);
  if (!Number.isFinite(scheduledFor.getTime()) || scheduledFor.getTime() > now.getTime()) return null;
  const revisionChanged = run.schedule_revision !== schedule.resource_revision;
  // A later rule may admit an occurrence previously cancelled by a schedule
  // edit. Reuse its identity rather than creating a second command for it.
  const reconsiderCancelled = run.state === 'cancelled'
    && run.last_error_class === 'schedule_revision_changed' && revisionChanged;
  const due = reconsiderCancelled || (run.state === 'pending' || run.state === 'retryable'
    ? run.next_attempt_at === null || new Date(run.next_attempt_at).getTime() <= now.getTime()
    : run.state === 'leased' && run.lease_until !== null && new Date(run.lease_until).getTime() <= now.getTime());
  if (!due) return null;
  // NULL is a historical run, never proof that the current rule authorized it.
  // Re-evaluate while holding the same schedule lock used by rule updates.
  if (revisionChanged && occurrences(mapSchedule(schedule), scheduledFor, scheduledFor, 1).length === 0) {
    await query(`UPDATE digest_runs
      SET state = 'cancelled', schedule_revision = $2, lease_owner = NULL,
          lease_until = NULL, next_attempt_at = NULL,
          last_error_class = 'schedule_revision_changed', updated_at = current_timestamp
      WHERE id = $1`, [runId, schedule.resource_revision]);
    return null;
  }
  const updated = await query<RunRow>(`
    UPDATE digest_runs
       SET state = 'leased', lease_owner = $2, schedule_revision = $5,
           lease_until = current_timestamp + ($3 * interval '1 millisecond'),
           lease_generation = lease_generation + 1,
           last_error_class = NULL, next_attempt_at = NULL,
           attempt_count = attempt_count + 1,
           updated_at = current_timestamp
     WHERE id = $1
       AND lease_generation = $4
     RETURNING ${RUN_COLUMNS}`, [runId, owner, leaseMs, currentGeneration, schedule.resource_revision]);
  return updated.rows[0] ? mapRun(updated.rows[0]) : null;
}
