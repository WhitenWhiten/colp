import type { Run } from '@know-n/colp/automation';
import { sql } from 'kysely';
import type { AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { automationUsageView, type AutomationObservation } from '../telemetry/automation-metrics.js';

/** Aggregate a page once, including daily reservations shared by runs of a rule. */
export async function readRunUsageBatch(tx: DatabaseTransaction, actor: AutomationActor, ids: string[], eventsEnabled: boolean): Promise<Map<string, NonNullable<Run['usage']>>> {
  if (!ids.length) return new Map();
  const rows = (await sql<AutomationObservation & { id: string }>`WITH visible AS (
    SELECT r.id,r.owner_id,r.state,r.held,r.created_at,v.rule_id,
      (v.definition_json#>>'{policy,maxRunsPerDay}')::int AS daily_limit FROM automation_runs r JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
    JOIN collections c ON c.id=r.explanation_json->>'collectionId'
    WHERE r.id IN (${sql.join(ids)}) AND r.owner_id=${actor.accountId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL
  ), jobs AS (
    SELECT j.id,j.run_id,j.budget_block_reason,CASE WHEN r.state='cancelled' AND j.state<>'succeeded' THEN 'cancelled' ELSE j.state END AS effective_state,
      r.held OR coalesce(s.paused,false) AS is_held FROM automation_jobs j JOIN visible r ON r.id=j.run_id
      LEFT JOIN automation_settings s ON s.owner_id=r.owner_id
  ), counts AS (
    SELECT run_id,count(*) FILTER(WHERE effective_state='ready')::int AS ready,
      count(*) FILTER(WHERE effective_state='succeeded')::int AS succeeded,
      count(*) FILTER(WHERE is_held AND effective_state IN ('pending','ready','leased','committing','awaitingApproval','uncertain'))::int AS held,
      count(*) FILTER(WHERE effective_state='pending')::int AS pending,
      count(*) FILTER(WHERE effective_state='leased')::int AS leased,
      count(*) FILTER(WHERE effective_state='committing')::int AS committing,
      count(*) FILTER(WHERE effective_state='blocked')::int AS blocked,
      count(*) FILTER(WHERE effective_state='blocked' AND budget_block_reason IS NOT NULL)::int AS budget_blocked,
      count(*) FILTER(WHERE effective_state='awaitingApproval')::int AS approval,
      count(*) FILTER(WHERE effective_state='uncertain')::int AS uncertain FROM jobs GROUP BY run_id
  ), attempts AS (
    SELECT j.run_id,count(*)::int AS calls,count(*) FILTER(WHERE a.reported_cost_micros IS NULL)::int AS unknown,
      coalesce(sum(a.reported_cost_micros),0)::text AS reported FROM jobs j JOIN automation_job_attempts a ON a.job_id=j.id GROUP BY j.run_id
  ), reservations AS (
    SELECT rule_id,count(DISTINCT run_id)::int AS reserved FROM automation_usage_reservations
    WHERE owner_id=${actor.accountId} AND rule_id IN (SELECT rule_id FROM visible)
    AND day=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date GROUP BY rule_id
  ), deliveries AS (
    ${eventsEnabled ? sql`SELECT d.run_id,count(*)::int AS accepted FROM automation_event_deliveries d
      JOIN visible r ON r.id=d.run_id WHERE d.state='accepted' GROUP BY d.run_id`
      : sql`SELECT NULL::text AS run_id,0::int AS accepted WHERE false`}
  ) SELECT r.id,r.created_at AS period_start,CURRENT_TIMESTAMP AS period_end,
    to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC','YYYY-MM-DD') AS budget_day,1::int AS admitted,
    coalesce(c.ready,0) AS ready,coalesce(c.succeeded,0) AS succeeded,coalesce(c.held,0) AS held,
    coalesce(c.pending,0) AS pending,coalesce(c.leased,0) AS leased,coalesce(c.committing,0) AS committing,
    coalesce(c.blocked,0) AS blocked,coalesce(c.budget_blocked,0) AS budget_blocked,
    coalesce(c.approval,0) AS approval,coalesce(c.uncertain,0) AS uncertain,
    coalesce(a.calls,0) AS calls,coalesce(a.unknown,0) AS unknown,coalesce(a.reported,'0') AS reported,
    r.daily_limit,coalesce(u.reserved,0) AS reserved,
    ${eventsEnabled ? sql`coalesce(d.accepted,0)` : sql`NULL::int`} AS accepted_deliveries
    FROM visible r LEFT JOIN counts c ON c.run_id=r.id LEFT JOIN attempts a ON a.run_id=r.id
    LEFT JOIN reservations u ON u.rule_id=r.rule_id LEFT JOIN deliveries d ON d.run_id=r.id`.execute(tx)).rows;
  return new Map(rows.map(row => [row.id, automationUsageView(row)]));
}
