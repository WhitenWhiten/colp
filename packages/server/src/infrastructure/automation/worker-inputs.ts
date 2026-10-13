import { sql } from 'kysely';
import type { TaskSpec,TaskInput,FolderRef,RuleDefinition,RoleBindings } from '@know-n/colp/automation';
import { AutomationError,resolveBindings,type WorkPrincipal } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { lockWorkJob,type TargetAuthority } from './work-authority.js';
import { createBindingReadPort } from './bindings.js';

export interface InputPins { task_json: TaskSpec; input_json: TaskInput[]; allowed_folders: FolderRef[]; authority_digest: string;
  input_revisions_json: Record<string,string>; definition_json: RuleDefinition; values_json: RoleBindings; execution_context_json: { placementAllowed?: boolean } }
/** Read, claim, submit and the canonical commit guard share the same current input authority. */
export async function currentWorkInputs(tx: DatabaseTransaction,actor: WorkPrincipal,jobId: string,serverUuid: string,authorize: TargetAuthority) {
  const job = await lockWorkJob(tx,actor,jobId,authorize);
  const pin = (await sql<InputPins>`SELECT j.*,v.definition_json,b.values_json FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
    JOIN automation_rule_revisions v ON v.id=r.rule_revision_id JOIN automation_binding_revisions b ON b.binding_set_id=r.binding_set_id AND b.revision=r.binding_revision
    WHERE j.id=${jobId}`.execute(tx)).rows[0]!;
  const node = await tx.selectFrom('nodes').select(['resource_revision','parent_id','payload_json','deleted_at']).where('id','=',job.node_id).where('collection_id','=',job.collection_id).executeTakeFirst();
  if (!node || node.deleted_at || !pin.input_json || node.resource_revision !== job.input_revision) throw new AutomationError('automation_stale_input','A canonical edit invalidated the pinned job input.');
  for (const [id,revision] of Object.entries(pin.input_revisions_json)) {
    const note = await tx.selectFrom('annotations').select('resource_revision').where('id','=',id).where('collection_id','=',job.collection_id)
      .where('creator_principal_id','=',actor.accountId).where('visibility','=','private').where('deleted_at','is',null).executeTakeFirst();
    if (!note || note.resource_revision !== revision) throw new AutomationError('automation_stale_input','An allowlisted note changed after inputs were pinned.');
  }
  const reads = createBindingReadPort(tx,serverUuid),resolutions = await resolveBindings(reads,actor,pin.definition_json,pin.values_json);
  for (const folder of pin.allowed_folders) {
    const current = await reads.readFolder(actor,folder);
    if (current.status !== 'valid' || (pin.task_json.folderRole && resolutions[pin.task_json.folderRole]?.status !== 'valid'))
      throw new AutomationError('automation_binding_unavailable','Pinned folder authority or constraints are no longer available.');
  }
  return { job,pin,node };
}

export async function expireOwnerLeases(tx: DatabaseTransaction,ownerId: string): Promise<void> {
  await sql`WITH expired AS (
    SELECT j.id,j.active_generation FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
    JOIN automation_job_attempts a ON a.job_id=j.id AND a.generation=j.active_generation
    WHERE r.owner_id=${ownerId} AND j.state='leased' AND a.outcome='leased' AND a.lease_until<=clock_timestamp()
    ORDER BY j.id LIMIT 100 FOR UPDATE OF j
  ), attempts AS (
    UPDATE automation_job_attempts a SET outcome='unknownOutcome' FROM expired e WHERE a.job_id=e.id AND a.generation=e.active_generation RETURNING a.job_id
  ) UPDATE automation_jobs j SET state='uncertain',revision=revision+1,explanation='Lease expired with unknown external outcome; explicit reconciliation is required.'
    FROM attempts a WHERE j.id=a.job_id`.execute(tx);
}
