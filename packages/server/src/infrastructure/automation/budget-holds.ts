import { sql } from 'kysely';
import { PREDECESSOR_FAILED, type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
/** Caller holds the account lock. Ready work keeps its original pins and competes for today's cap at claim. */
export async function resumeDailyBudgetJobs(tx: DatabaseTransaction, actor: AutomationActor, targetId: string): Promise<number> {
    const resumed = (await sql<{
        run_id: string;
    }> `WITH due AS (
    SELECT j.id FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
    JOIN collections c ON c.id=r.explanation_json->>'collectionId'
    WHERE r.owner_id=${actor.accountId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL
      AND j.target_partition=${targetId} AND j.state='blocked' AND j.budget_block_reason='daily'
      AND j.budget_retry_after<=CURRENT_TIMESTAMP
      AND NOT EXISTS(SELECT 1 FROM automation_settings s WHERE s.owner_id=r.owner_id AND s.paused) AND NOT r.held AND r.state<>'cancelled'
    ORDER BY j.budget_retry_after,j.id LIMIT 100 FOR UPDATE OF j,r
  ) UPDATE automation_jobs j SET state='ready',budget_block_reason=NULL,budget_retry_after=NULL,revision=revision+1,
      explanation='Daily capacity will be rechecked against the original input and policy.'
    FROM due WHERE j.id=due.id RETURNING j.run_id`.execute(tx)).rows;
    for (const runId of new Set(resumed.map(row => row.run_id))) {
        // Repair dependent tasks stranded by the former terminal-budget behavior. No ready pins are rebased.
        await sql `UPDATE automation_jobs SET state='pending',reason_code=NULL,revision=revision+1,explanation='Waiting for the retained predecessor.'
      WHERE run_id=${runId} AND state='blocked' AND input_json IS NULL
        AND reason_code=${PREDECESSOR_FAILED}`.execute(tx);
        await sql `UPDATE automation_runs SET state='running',revision=revision+1,updated_at=clock_timestamp()
      WHERE id=${runId} AND state<>'running'`.execute(tx);
    }
    return resumed.length;
}
