import { sql } from 'kysely';
import { AutomationError, type WorkPrincipal } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

export interface WorkJob {
  id: string; run_id: string; owner_id: string; rule_id: string; target_id: string; state: string; active_generation: string;
  input_digest: string; input_revision: string; delivery_handle: string; max_calls: number; collection_id: string; node_id: string; rule_daily_cap: number; policy_privacy: 'standard' | 'restricted';
}
export type TargetAuthority = (tx: DatabaseTransaction, actor: WorkPrincipal, targetId: string,privacy?: 'standard' | 'restricted') => Promise<void>;
export async function lockWorkJob(tx: DatabaseTransaction, actor: WorkPrincipal, jobId: string, authorize: TargetAuthority, allowPaused = false): Promise<WorkJob> {
  const account = await tx.selectFrom('accounts').select(['subject_id','status','deleted_at']).where('id','=',actor.accountId).forUpdate().executeTakeFirst();
  if (!account || account.subject_id !== actor.subjectId || account.status !== 'active' || account.deleted_at || !actor.scopes.includes('automation:work'))
    throw new AutomationError('resource_not_found','Worker authority is unavailable.');
  const row = (await sql<WorkJob>`SELECT j.*,j.active_generation::text,r.owner_id,v.rule_id,
    r.explanation_json->>'collectionId' AS collection_id,r.explanation_json->>'nodeId' AS node_id,v.definition_json->'policy'->>'privacy' AS policy_privacy,(v.definition_json->'policy'->>'maxRunsPerDay')::int AS rule_daily_cap
    FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
    JOIN collections c ON c.id=r.explanation_json->>'collectionId'
    WHERE j.id=${jobId} AND r.owner_id=${actor.accountId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL
      AND r.state<>'cancelled' AND NOT r.held FOR UPDATE OF j,r`.execute(tx)).rows[0];
  if (!row || !row.target_id) throw new AutomationError('resource_not_found','Job is unavailable.');
  await authorize(tx,actor,row.target_id,row.policy_privacy);
  if (!allowPaused) await requireWorkRunning(tx,actor.accountId);
  return row;
}
export async function requireWorkRunning(tx: DatabaseTransaction, ownerId: string): Promise<void> {
  const paused = await tx.selectFrom('automation_settings').select('paused').where('owner_id','=',ownerId).executeTakeFirst();
  if (paused?.paused) throw new AutomationError('automation_paused','Automation is paused; retry after 30 seconds.');
}
