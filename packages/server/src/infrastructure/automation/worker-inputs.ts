import { sql } from 'kysely';
import type { ExecutionPolicyInput,TaskSpec,TaskInput,FolderRef,RuleDefinition,RoleBindings } from '@know-n/colp/automation';
import { AutomationError,resolveBindings,assessIntakeBindings,hasUnsupportedCostLimit,type WorkPrincipal,type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { lockWorkJob,type TargetAuthority,type WorkJob } from './work-authority.js';
import { advanceRunTasks } from './task-scheduler.js';
import { readWorkerNotes } from './worker-notes.js';
import { createBindingReadPort } from './bindings.js';

export interface InputPins { task_json: TaskSpec; input_json: TaskInput[]; allowed_folders: FolderRef[]; authority_digest: string;
  member_revisions_json: Record<string,string>;input_revisions_json: Record<string,string>; definition_json: RuleDefinition; values_json: RoleBindings; execution_context_json: { placementAllowed?: boolean } }
/** Read, claim, submit and the canonical commit guard share the same current input authority. */
export async function currentWorkInputs(tx: DatabaseTransaction,actor: WorkPrincipal,jobId: string,serverUuid: string,authorize: TargetAuthority,allowPaused = false) {
  const job = await lockWorkJob(tx,actor,jobId,authorize,allowPaused);
  return readPinnedWorkInputs(tx,actor,job,serverUuid);
}

export type InputJob = Pick<WorkJob,'id' | 'run_id' | 'collection_id' | 'node_id' | 'input_revision' | 'state'>;
/** Owner maintenance uses the same pin validation without impersonating a worker. */
async function readPinnedWorkInputs<T extends InputJob>(tx: DatabaseTransaction,actor: AutomationActor,job: T,serverUuid: string) {
  const jobId = job.id;
  const pin = (await sql<InputPins>`SELECT j.*,v.definition_json,b.values_json FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
    JOIN automation_rule_revisions v ON v.id=r.rule_revision_id JOIN automation_binding_revisions b ON b.binding_set_id=r.binding_set_id AND b.revision=r.binding_revision
    WHERE j.id=${jobId}`.execute(tx)).rows[0]!;
  const policy=(await sql<{configuration_json:ExecutionPolicyInput}>`SELECT p.configuration_json FROM automation_runs r
    JOIN automation_rule_revisions v ON v.id=r.rule_revision_id JOIN automation_execution_policy_revisions p
    ON p.policy_id=v.execution_policy_id AND p.revision::text=r.policy_revision WHERE r.id=${job.run_id}`.execute(tx)).rows[0];
  if (policy && hasUnsupportedCostLimit(policy.configuration_json))
    throw new AutomationError('automation_binding_unavailable','Pinned monetary limits are unsupported; review this work under an explicit supported policy.');
  const node = await tx.selectFrom('nodes').select(['resource_revision','parent_id','payload_json','deleted_at']).where('id','=',job.node_id).where('collection_id','=',job.collection_id).executeTakeFirst();
  if (!node || node.deleted_at || !pin.input_json || node.resource_revision !== job.input_revision) throw new AutomationError('automation_stale_input','A canonical edit invalidated the pinned job input.');
  for(const [nodeId,revision] of Object.entries(pin.member_revisions_json ?? {})){
    const member=await tx.selectFrom('nodes').select('resource_revision').where('collection_id','=',job.collection_id).where('id','=',nodeId).where('deleted_at','is',null).executeTakeFirst();
    if(!member || member.resource_revision!==revision)throw new AutomationError('automation_stale_input','An immutable batch member changed or became unavailable; no replacement is permitted.');
  }
  if (pin.task_json.inputFields.includes('note')) {
    const notes=(await Promise.all(pin.input_json.map(input=>readWorkerNotes(tx,actor.accountId,job.collection_id,input.node.nodeId)))).flat();
    const expected = pin.input_revisions_json;
    if (notes.length !== Object.keys(expected).length || notes.some(note => expected[note.id] !== note.resource_revision))
      throw new AutomationError('automation_stale_input','The allowlisted note set changed after inputs were pinned.');
  }
  const reads = createBindingReadPort(tx,serverUuid),resolutions = await resolveBindings(reads,actor,pin.definition_json,pin.values_json);
  if (!assessIntakeBindings(pin.definition_json,resolutions).available)
    throw new AutomationError('automation_binding_unavailable','Required rule scope or intake constraints are no longer available.');
  for (const folder of pin.allowed_folders) {
    const current = await reads.readFolder(actor,folder);
    if (current.status !== 'valid' || (pin.task_json.folderRole && resolutions[pin.task_json.folderRole]?.status !== 'valid'))
      throw new AutomationError('automation_binding_unavailable','Pinned folder authority or constraints are no longer available.');
  }
  return { job,pin,node };
}

/** Return validation errors as data so the caller can commit convergence before reporting failure. */
export async function checkWorkInputs<T extends InputJob>(tx: DatabaseTransaction,actor: AutomationActor,job: T,serverUuid: string) {
  try {
    return { value: await readPinnedWorkInputs(tx,actor,job,serverUuid) };
  } catch (error) {
    if (!(error instanceof AutomationError) || !['automation_stale_input','automation_binding_unavailable'].includes(error.code)) throw error;
    if (job.state === 'ready') {
      await sql`UPDATE automation_jobs SET state='stale',revision=revision+1,explanation=${error.message} WHERE id=${job.id} AND state='ready'`.execute(tx);
      await advanceRunTasks(tx,actor,serverUuid,job.run_id);
    }
    return { error };
  }
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
