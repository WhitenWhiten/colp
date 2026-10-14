import { sql, type Kysely } from 'kysely';
import type { Rule } from '@know-n/colp/automation';
import type { DatabaseSchema } from '../database/runtime.js';
import type { AutomationActor } from '../../modules/automation/index.js';
import { automationUsageView, type AutomationObservation } from '../telemetry/automation-metrics.js';

/** Fixed-size, Owner/current-collection-authorized aggregates. No private ledger rows escape. */
export async function readAutomationUsage(db: Kysely<DatabaseSchema>, actor: AutomationActor, ruleId: string, runId?: string,eventsEnabled = false): Promise<NonNullable<Rule['usage']>> {
  const runFilter = runId ? sql`AND r.id=${runId}` : sql``;
  const row = (await sql<AutomationObservation>`WITH visible_runs AS (
    SELECT r.*,v.definition_json FROM automation_runs r JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
    JOIN collections c ON c.id=r.explanation_json->>'collectionId'
    WHERE r.owner_id=${actor.accountId} AND v.rule_id=${ruleId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL ${runFilter}
  ), jobs AS (
    SELECT j.*,CASE WHEN r.state='cancelled' AND j.state<>'succeeded' THEN 'cancelled' ELSE j.state END AS effective_state,
      r.held OR coalesce(s.paused,false) AS is_held FROM automation_jobs j JOIN visible_runs r ON r.id=j.run_id
    LEFT JOIN automation_settings s ON s.owner_id=r.owner_id
  ), attempts AS (
    SELECT a.* FROM automation_job_attempts a JOIN jobs j ON j.id=a.job_id
  ) SELECT
    coalesce((SELECT min(created_at) FROM visible_runs),date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS period_start,
    ${eventsEnabled ? sql`(SELECT count(*)::int FROM automation_event_deliveries d JOIN visible_runs r ON r.id=d.run_id WHERE d.state='accepted')` : sql`NULL`} AS accepted_deliveries,
    CURRENT_TIMESTAMP AS period_end,to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC','YYYY-MM-DD') AS budget_day,
    (SELECT count(*)::int FROM visible_runs) AS admitted,
    count(*) FILTER(WHERE effective_state='ready')::int AS ready,count(*) FILTER(WHERE effective_state='succeeded')::int AS succeeded,
    count(*) FILTER(WHERE is_held AND effective_state IN ('pending','ready','leased','committing','awaitingApproval','uncertain'))::int AS held,
    count(*) FILTER(WHERE effective_state='pending')::int AS pending,count(*) FILTER(WHERE effective_state='leased')::int AS leased,
    count(*) FILTER(WHERE effective_state='committing')::int AS committing,count(*) FILTER(WHERE effective_state='blocked')::int AS blocked,
    count(*) FILTER(WHERE effective_state='blocked' AND budget_block_reason IS NOT NULL)::int AS budget_blocked,
    count(*) FILTER(WHERE effective_state='awaitingApproval')::int AS approval,count(*) FILTER(WHERE effective_state='uncertain')::int AS uncertain,
    (SELECT count(*)::int FROM attempts) AS calls,
    (SELECT count(*)::int FROM attempts WHERE reported_cost_micros IS NULL) AS unknown,
    (SELECT coalesce(sum(reported_cost_micros),0)::text FROM attempts) AS reported,
    coalesce(${runId ? sql`(SELECT (definition_json->'policy'->>'maxRunsPerDay')::int FROM visible_runs LIMIT 1)` : sql`(SELECT (v.definition_json->'policy'->>'maxRunsPerDay')::int FROM automation_rules r JOIN automation_rule_revisions v ON v.id=r.current_revision_id WHERE r.id=${ruleId} AND r.owner_id=${actor.accountId})`},0) AS daily_limit,
    (SELECT count(DISTINCT u.run_id)::int FROM automation_usage_reservations u
      WHERE u.owner_id=${actor.accountId} AND u.rule_id=${ruleId} AND u.day=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date) AS reserved
    FROM jobs`.execute(db)).rows[0]!;
  return automationUsageView(row);
}
