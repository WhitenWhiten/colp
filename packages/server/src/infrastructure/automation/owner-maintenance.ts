import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { reconcileRunsPlanEffects } from './reconcile-plan-effect.js';
import { expireOwnerLeases,checkWorkInputs,type InputJob } from './worker-inputs.js';
import { advanceRunTasks } from './task-scheduler.js';

/**
 * Converges what Owner and run reads must not write: invalid ready inputs become stale, expired
 * worker leases become uncertain, and plans
 * that committed without their effect receipt (an interrupted reconcile) get it. It then advances those
 * runs and any pending task nothing else would schedule, such as the successor of a task that finished
 * while automation was paused. An events-mode target hears of a job only once it is ready. Bounded per sweep.
 */
export async function convergeOwnerWork(db: Kysely<DatabaseSchema>, ownerId: string, serverUuid: string): Promise<void> {
  await db.transaction().execute(async tx => {
    const account = await tx.selectFrom('accounts').select(['id', 'subject_id']).where('id', '=', ownerId).forUpdate().executeTakeFirst();
    if (!account) return;
    const actor = { accountId: ownerId, subjectId: account.subject_id };
    await expireOwnerLeases(tx, ownerId);
    // Oldest checked first: healthy ready jobs cannot starve later invalid jobs.
    const ready = (await sql<InputJob>`SELECT j.id,j.run_id,j.state,j.input_revision,
      r.explanation_json->>'collectionId' AS collection_id,r.explanation_json->>'nodeId' AS node_id
      FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
      JOIN collections c ON c.id=r.explanation_json->>'collectionId' AND c.owner_subject_id=${account.subject_id} AND c.deleted_at IS NULL
      WHERE r.owner_id=${ownerId} AND j.state='ready' AND NOT r.held AND r.state NOT IN ('cancelled','waiting')
        AND NOT EXISTS (SELECT 1 FROM automation_settings s WHERE s.owner_id=r.owner_id AND s.paused)
      ORDER BY j.inputs_checked_at NULLS FIRST,j.id LIMIT 100 FOR UPDATE OF j,r`.execute(tx)).rows;
    for (const job of ready) {
      await checkWorkInputs(tx,actor,job,serverUuid);
      await sql`UPDATE automation_jobs SET inputs_checked_at=clock_timestamp() WHERE id=${job.id}`.execute(tx);
    }
    const runs = (await sql<{ run_id: string }>`SELECT DISTINCT j.run_id FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
      JOIN automation_proposals p ON p.job_id=j.id JOIN mcp_change_plans m ON m.plan_id=p.plan_id AND m.status='consumed'
      WHERE r.owner_id=${ownerId} AND NOT EXISTS (SELECT 1 FROM automation_effect_receipts e WHERE e.job_id=j.id)
      ORDER BY j.run_id LIMIT 20`.execute(tx)).rows;
    await reconcileRunsPlanEffects(tx, actor, runs.map(run => run.run_id), serverUuid);
    // Mirrors taskBlocksSuccessors, so every selected run either readies, holds or settles a task.
    const pending = (await sql<{ run_id: string }>`SELECT DISTINCT j.run_id FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
      JOIN collections c ON c.id=r.explanation_json->>'collectionId' AND c.owner_subject_id=${account.subject_id} AND c.deleted_at IS NULL
      WHERE r.owner_id=${ownerId} AND j.state='pending' AND NOT r.held AND r.state NOT IN ('cancelled','waiting')
        AND NOT EXISTS (SELECT 1 FROM automation_settings s WHERE s.owner_id=r.owner_id AND s.paused)
        AND NOT EXISTS (SELECT 1 FROM automation_jobs busy WHERE busy.run_id=r.id
          AND (busy.state IN ('ready','leased','committing','awaitingApproval','uncertain') OR (busy.state='blocked' AND busy.budget_block_reason='daily')))
      ORDER BY j.run_id LIMIT 20`.execute(tx)).rows;
    // A reconciled run may have no pending task left but still has to settle its own state.
    for (const runId of new Set([...runs, ...pending].map(run => run.run_id))) await advanceRunTasks(tx, actor, serverUuid, runId);
  });
}
