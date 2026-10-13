import { sql } from 'kysely';
import type { AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { appendAutomationResume } from '../outbox/automation-ingest.js';
import { resumeDailyBudgetJobs } from './budget-holds.js';

export async function scheduleBudgetWake(tx: DatabaseTransaction, ownerId: string, collectionId: string): Promise<void> {
  const rows = (await sql<{ available_at: Date }>`INSERT INTO automation_budget_wakes(owner_id,collection_id,available_at)
    VALUES(${ownerId},${collectionId},((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC')
    ON CONFLICT DO NOTHING RETURNING available_at`.execute(tx)).rows;
  if (rows[0]) await appendAutomationResume(tx, collectionId, rows[0].available_at);
}

/** Called by the durable source/resume consumer, even when no client polls jobs. */
export async function resumeCollectionBudgets(tx: DatabaseTransaction, actor: AutomationActor, collectionId: string): Promise<boolean> {
  const targets = (await sql<{ target_id: string }>`SELECT DISTINCT j.target_id FROM automation_jobs j
    JOIN automation_runs r ON r.id=j.run_id JOIN collections c ON c.id=r.explanation_json->>'collectionId'
    LEFT JOIN automation_settings s ON s.owner_id=r.owner_id
    WHERE r.owner_id=${actor.accountId} AND c.id=${collectionId} AND c.owner_subject_id=${actor.subjectId}
    AND c.deleted_at IS NULL AND NOT coalesce(s.paused,false) AND NOT r.held AND r.state<>'cancelled'
    AND j.budget_block_reason='daily' AND j.state='blocked' AND j.budget_retry_after<=CURRENT_TIMESTAMP
    AND j.target_id IS NOT NULL ORDER BY j.target_id LIMIT 100`.execute(tx)).rows;
  let more = targets.length === 100;
  for (const target of targets) more = await resumeDailyBudgetJobs(tx, actor, target.target_id) === 100 || more;
  await sql`DELETE FROM automation_budget_wakes WHERE owner_id=${actor.accountId} AND collection_id=${collectionId}
    AND available_at<=CURRENT_TIMESTAMP`.execute(tx);
  return more;
}
