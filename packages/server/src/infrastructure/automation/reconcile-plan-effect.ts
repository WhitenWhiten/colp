import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { AutomationPlanOperation } from '../../modules/mcp/index.js';
import type { AutomationActor } from '../../modules/automation/index.js';

/** History recovery only: it can link a consumed plan, never execute or approve one. */
export async function reconcileCommittedPlanEffect(tx: DatabaseTransaction,actor: AutomationActor,jobId: string,serverUuid: string): Promise<boolean> {
  const row = (await sql<{ run_id: string; target_id: string; input_revision: string; proposal_digest: string; result_id: string; plan_id: string;
    operations_json: AutomationPlanOperation[]; collection_id: string; node_id: string }>`SELECT j.run_id,j.target_id,j.input_revision,s.proposal_digest,s.id AS result_id,p.plan_id,p.operations_json,
    r.explanation_json->>'collectionId' AS collection_id,r.explanation_json->>'nodeId' AS node_id
    FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id JOIN automation_results s ON s.id=j.result_id
    JOIN automation_proposals p ON p.job_id=j.id JOIN mcp_change_plans m ON m.plan_id=p.plan_id AND m.status='consumed'
    JOIN collections c ON c.id=r.explanation_json->>'collectionId'
    WHERE j.id=${jobId} AND r.owner_id=${actor.accountId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL
    FOR UPDATE OF j,r`.execute(tx)).rows[0];
  if (!row) return false;
  const op = row.operations_json[0];
  if (!op || row.operations_json.length !== 1 || op.jobId !== jobId || op.runId !== row.run_id || op.collectionId !== row.collection_id || op.nodeId !== row.node_id) return false;
  const facts = await tx.selectFrom('resource_revisions as r').innerJoin('operations as o',join => join.onRef('r.collection_id','=','o.collection_id').onRef('r.ordinal','=','o.commit_ordinal'))
    .select('r.revision').where('o.operation_id','=',op.operationId).where('r.resource_id','=',op.annotationId ?? op.nodeId).where('r.collection_id','=',row.collection_id).executeTakeFirst();
  const version = (await sql<{ version_id: string; content_revision: string }>`SELECT v.version_id,c.content_revision FROM mcp_plan_policy_receipts v
    JOIN mcp_plan_commit_revisions c ON c.plan_id=v.plan_id AND c.collection_id=v.collection_id WHERE v.plan_id=${row.plan_id}`.execute(tx)).rows[0];
  if (!facts || !version) return false;
  const before = op.type === 'move_node' && op.sourceParentId ? { serverUuid,collectionId: row.collection_id,nodeId: op.sourceParentId } : null;
  const inserted = (await sql`INSERT INTO automation_effect_receipts(id,run_id,job_id,step_id,target_partition,plan_id,operation_id,before_folder,
    before_revision,after_revision,effect_digest,collection_id,node_id,after_parent_id,after_content_revision,version_id)
    VALUES(${randomUUID()},${row.run_id},${jobId},${jobId},${row.target_id},${row.plan_id},${op.operationId},${before ? JSON.stringify(before) : null}::jsonb,
      ${row.input_revision},${facts.revision},${row.proposal_digest},${row.collection_id},${row.node_id},${op.parentId ?? null},${version.content_revision},${version.version_id})
    ON CONFLICT(run_id,step_id,target_partition) DO NOTHING RETURNING id`.execute(tx)).rows.length > 0;
  await sql`UPDATE automation_results SET status='accepted' WHERE id=${row.result_id} AND status<>'accepted'`.execute(tx);
  await sql`UPDATE automation_jobs SET state='succeeded',revision=revision+1 WHERE id=${jobId} AND state<>'succeeded'`.execute(tx);
  if (inserted) await sql`UPDATE automation_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE id=${row.run_id}`.execute(tx);
  return true;
}
export async function reconcileRunPlanEffects(tx: DatabaseTransaction,actor: AutomationActor,runId: string,serverUuid: string): Promise<void> {
  return reconcileRunsPlanEffects(tx,actor,[runId],serverUuid);
}
export async function reconcileRunsPlanEffects(tx: DatabaseTransaction,actor: AutomationActor,runIds: string[],serverUuid: string): Promise<void> {
  if(!runIds.length)return;
  const jobs = (await sql<{ id: string }>`SELECT j.id FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
    JOIN automation_proposals p ON p.job_id=j.id JOIN mcp_change_plans m ON m.plan_id=p.plan_id AND m.status='consumed'
    WHERE r.id IN (${sql.join(runIds)}) AND r.owner_id=${actor.accountId} AND NOT EXISTS (SELECT 1 FROM automation_effect_receipts e WHERE e.job_id=j.id)
    ORDER BY j.id LIMIT ${8*runIds.length}`.execute(tx)).rows;
  for (const job of jobs) await reconcileCommittedPlanEffect(tx,actor,job.id,serverUuid);
}
