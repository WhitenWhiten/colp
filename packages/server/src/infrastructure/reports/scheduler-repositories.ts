import { randomBytes } from 'node:crypto';
import { CompiledQuery, sql } from 'kysely';
import { claimDigestRun, type DigestClaimQuery } from './scheduler-store.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type {
  DigestRun,
  DigestSchedule,
  ReportRunLedgerPort,
  ReportScheduleWritePort,
} from '../../modules/reports/index.js';
import type {
  DigestRunTable,
  DigestScheduleTable,
} from '../database/reports-tables.js';

const opaque = () => randomBytes(16).toString('base64url');

function schedule(row: DigestScheduleTable): DigestSchedule {
  return {
    id: row.id,
    seriesId: row.series_id,
    enabled: row.enabled,
    rrule: row.rrule,
    dtstart: new Date(row.dtstart).toISOString(),
    timeZone: row.time_zone,
    catchUpPolicy: row.catch_up_policy,
    maxCatchUp: row.max_catch_up,
    nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    resourceRevision: row.resource_revision,
  };
}

/** PostgreSQL write port for the single durable schedule row per series. */
export function createPostgresReportScheduleWritePort(
  tx: DatabaseTransaction,
  revisionGenerator: () => string = opaque,
): ReportScheduleWritePort {
  return {
    async get(seriesId) {
      const row = await tx.selectFrom('digest_schedules')
        .selectAll()
        .where('series_id', '=', seriesId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return row ? schedule(row) : null;
    },
    async upsert(value) {
      const row = await tx.insertInto('digest_schedules').values({
        id: value.id,
        series_id: value.seriesId,
        enabled: value.enabled,
        rrule: value.rrule,
        dtstart: new Date(value.dtstart),
        time_zone: value.timeZone,
        catch_up_policy: value.catchUpPolicy,
        max_catch_up: value.maxCatchUp,
        next_run_at: value.nextRunAt ? new Date(value.nextRunAt) : null,
        resource_revision: value.resourceRevision,
        created_at: sql<Date>`current_timestamp`,
        updated_at: sql<Date>`current_timestamp`,
        deleted_at: null,
      }).onConflict((oc) => oc.column('series_id').doUpdateSet({
        enabled: value.enabled,
        rrule: value.rrule,
        dtstart: new Date(value.dtstart),
        time_zone: value.timeZone,
        catch_up_policy: value.catchUpPolicy,
        max_catch_up: value.maxCatchUp,
        next_run_at: value.nextRunAt ? new Date(value.nextRunAt) : null,
        resource_revision: value.resourceRevision,
        updated_at: sql<Date>`current_timestamp`,
        deleted_at: null,
      })).returningAll().executeTakeFirstOrThrow();
      return schedule(row);
    },
    async disable(seriesId, resourceRevision) {
      await tx.updateTable('digest_schedules').set({
        enabled: false,
        next_run_at: null,
        resource_revision: resourceRevision ?? revisionGenerator(),
        deleted_at: sql<Date>`current_timestamp`,
        updated_at: sql<Date>`current_timestamp`,
      }).where('series_id', '=', seriesId).execute();
    },
  };
}

function mapRun(row: DigestRunTable): DigestRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleRevision: row.schedule_revision,
    occurrenceKey: row.occurrence_key,
    scheduledFor: new Date(row.scheduled_for).toISOString(),
    state: row.state,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until ? new Date(row.lease_until).toISOString() : null,
    leaseGeneration: Number(row.lease_generation),
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
    lastErrorClass: row.last_error_class,
    issueKey: row.issue_key,
    commandId: row.command_id,
    editionId: row.edition_id,
  };
}

/** Legacy transaction-bound run ledger retained for application compatibility. */
export function createPostgresReportRunLedgerPort(
  tx: DatabaseTransaction,
  idGenerator: () => string = opaque,
): ReportRunLedgerPort {
  return {
    async upsertOccurrence(value) {
      const row = await tx.insertInto('digest_runs').values({
        id: idGenerator(),
        schedule_id: value.scheduleId,
        schedule_revision: value.scheduleRevision,
        occurrence_key: value.occurrenceKey,
        scheduled_for: new Date(value.scheduledFor),
        state: value.state,
        lease_owner: null,
        lease_until: null,
        lease_generation: 0n,
        attempt_count: value.attemptCount,
        next_attempt_at: value.nextAttemptAt ? new Date(value.nextAttemptAt) : null,
        last_error_class: value.lastErrorClass,
        issue_key: value.issueKey,
        command_id: value.commandId,
        edition_id: value.editionId,
        created_at: sql<Date>`current_timestamp`,
        updated_at: sql<Date>`current_timestamp`,
      }).onConflict((oc) => oc.columns(['schedule_id', 'occurrence_key'])
        .doUpdateSet({ updated_at: sql<Date>`current_timestamp` }))
        .returningAll()
        .executeTakeFirstOrThrow();
      if (row.issue_key !== value.issueKey || row.command_id !== value.commandId) {
        throw new Error('digest run occurrence identity conflict');
      }
      return mapRun(row);
    },
    async claimDue(now, owner, leaseMs, limit) {
      const rows = await tx.selectFrom('digest_runs').select(['id', 'lease_generation'])
        // A run is not claimable merely because its retry backoff elapsed: its
        // declared occurrence must also be in the past. Keep the owner and
        // series lifecycle fence in the same predicate.
        .where(sql<boolean>`digest_runs.scheduled_for <= ${now}`)
        .where(sql<boolean>`EXISTS (
          SELECT 1
            FROM digest_schedules s
            JOIN digest_series rs ON rs.id = s.series_id
            JOIN accounts owner_account ON owner_account.subject_id = rs.owner_subject_id
           WHERE s.id = digest_runs.schedule_id
             AND s.enabled = true AND s.deleted_at IS NULL
             AND rs.state = 'active'
             AND owner_account.status = 'active'
             AND owner_account.deleted_at IS NULL
        )`)
        .where((eb) => eb.or([
          eb.and([eb('state', '=', 'pending'), eb.or([
            eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now),
          ])]),
          eb.and([eb('state', '=', 'retryable'), eb.or([
            eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now),
          ])]),
          eb.and([eb('state', '=', 'leased'), eb('lease_until', '<=', now)]),
        ]))
        .orderBy('scheduled_for', 'asc')
        .limit(limit)
        .execute();
      const query: DigestClaimQuery = <Row extends object>(statement: string, parameters: unknown[]) =>
        tx.executeQuery<Row>(CompiledQuery.raw(statement, parameters));
      const out: DigestRun[] = [];
      for (const row of rows) {
        const claimed = await claimDigestRun(query, row.id, owner, leaseMs, now, Number(row.lease_generation));
        if (claimed) out.push(claimed);
      }
      return out;
    },
    async complete(run, owner) {
      const updated = await tx.updateTable('digest_runs')
        .set({
          state: 'succeeded',
          lease_owner: null,
          lease_until: null,
          next_attempt_at: null,
          last_error_class: null,
          updated_at: sql<Date>`current_timestamp`,
        })
        .where('id', '=', run.id)
        .where('state', '=', 'leased')
        .where('lease_owner', '=', owner)
        .where('lease_generation', '=', BigInt(run.leaseGeneration))
        .where('lease_until', '>', sql<Date>`current_timestamp`)
        .executeTakeFirst();
      return Number(updated.numUpdatedRows) > 0 ? 'succeeded' : 'lease_lost';
    },
    async retry(run, owner, errorClass, nextAttemptAt) {
      const safeClass = /^[A-Za-z0-9_.-]{1,128}$/u.test(errorClass)
        ? errorClass : 'connector_error';
      const updated = await tx.updateTable('digest_runs')
        .set({
          state: 'retryable',
          lease_owner: null,
          lease_until: null,
          last_error_class: safeClass,
          next_attempt_at: nextAttemptAt,
          updated_at: sql<Date>`current_timestamp`,
        })
        .where('id', '=', run.id)
        .where('state', '=', 'leased')
        .where('lease_owner', '=', owner)
        .where('lease_generation', '=', BigInt(run.leaseGeneration))
        .where('lease_until', '>', sql<Date>`current_timestamp`)
        .executeTakeFirst();
      return Number(updated.numUpdatedRows) > 0 ? 'retryable' : 'lease_lost';
    },
  };
}

