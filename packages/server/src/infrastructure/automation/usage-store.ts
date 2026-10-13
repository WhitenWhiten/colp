import { sql } from 'kysely';
import { AutomationError } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

export interface UsageReservation { ownerId: string; ruleId: string; runId: string; jobId: string; targetId: string }
/** Account lock is held by the caller. A global lock also serializes cross-owner server caps. */
export async function reserveOptionalWork(tx: DatabaseTransaction, item: UsageReservation, serverDailyCap: number, ruleDailyCap = 100): Promise<boolean> {
  if (![serverDailyCap, ruleDailyCap].every(n => Number.isSafeInteger(n) && n >= 0)) throw new TypeError('Invalid optional-work cap');
  await sql`SELECT pg_advisory_xact_lock(582613,22)`.execute(tx);
  const existing = (await sql`SELECT job_id FROM automation_usage_reservations WHERE job_id=${item.jobId} AND owner_id=${item.ownerId} AND day=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`.execute(tx)).rows[0];
  if (existing) return true;
  const counts = (await sql<{ rule_runs: number; server_runs: number; same_run: boolean }>`SELECT
    count(DISTINCT run_id) FILTER(WHERE rule_id=${item.ruleId})::int AS rule_runs,
    count(DISTINCT run_id)::int AS server_runs,
    coalesce(bool_or(run_id=${item.runId}),false) AS same_run
    FROM automation_usage_reservations WHERE day=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`.execute(tx)).rows[0]!;
  if (!counts.same_run && (counts.rule_runs >= ruleDailyCap || counts.server_runs >= serverDailyCap)) return false;
  await sql`INSERT INTO automation_usage_reservations(job_id,owner_id,rule_id,run_id,target_id,day)
    VALUES(${item.jobId},${item.ownerId},${item.ruleId},${item.runId},${item.targetId},(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date)`.execute(tx);
  return true;
}
export async function recordOptionalCall(tx: DatabaseTransaction, item: UsageReservation): Promise<void> {
  await sql`INSERT INTO automation_usage_counters(owner_id,rule_id,target_id,day,calls,unknown_cost_calls)
    VALUES(${item.ownerId},${item.ruleId},${item.targetId},(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,1,1)
    ON CONFLICT(owner_id,rule_id,target_id,day) DO UPDATE SET calls=automation_usage_counters.calls+1,
      unknown_cost_calls=automation_usage_counters.unknown_cost_calls+1`.execute(tx);
}

/** Record once against the original call day, even if the result arrives after UTC midnight. */
export async function recordReportedCost(tx: DatabaseTransaction, jobId: string, generation: number, micros: number): Promise<void> {
  if (!Number.isSafeInteger(micros) || micros<0) throw new AutomationError('invalid_request','Reported cost must be a nonnegative safe integer in micros.');
  await sql`WITH observed AS (
    UPDATE automation_job_attempts SET reported_cost_micros=${micros}
    WHERE job_id=${jobId} AND generation=${generation} AND reported_cost_micros IS NULL
    RETURNING job_id,created_at
  ) UPDATE automation_usage_counters c SET reported_cost_micros=c.reported_cost_micros+${micros},
    unknown_cost_calls=greatest(0,c.unknown_cost_calls-1)
    FROM observed a JOIN automation_jobs j ON j.id=a.job_id JOIN automation_runs r ON r.id=j.run_id
    JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
    WHERE c.owner_id=r.owner_id AND c.rule_id=v.rule_id AND c.target_id=j.target_id
      AND c.day=(a.created_at AT TIME ZONE 'UTC')::date`.execute(tx);
}
