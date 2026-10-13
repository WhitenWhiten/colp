import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationDigest,taskInputDigest,type RuleDefinition,type RoleBindings,type TaskSpec,type TaskInput,type TaskOutput,type FolderRef } from '@know-n/colp/automation';
import { compatibleAcceptedResult,resolveBindings,bindingResolutionSignature,taskExecutionAssignment,type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createExecutionPolicyStore } from './execution-policy-store.js';
import { createTargetStore } from './target-store.js';
import { createBindingReadPort } from './bindings.js';

interface RunPin { id: string; rule_id: string; definition_json: RuleDefinition; values_json: RoleBindings; execution_policy_id: string | null;
  policy_revision: string | null; state: string; member_ids: string[]; explanation_json: { collectionId: string; nodeId: string; sourceRevision: string; plan: { kind: string; satisfiedTasks?: string[] } } }
interface TaskContext { executorId: string | null; placementAllowed: boolean; intakeSatisfied: boolean }
interface PendingJob { id: string; task_json: TaskSpec; state: string; input_revision: string | null; execution_context_json: TaskContext; target_id: string | null }
const selectPins = sql`SELECT r.*,v.rule_id,v.definition_json,v.execution_policy_id,b.values_json FROM automation_runs r
  JOIN automation_rule_revisions v ON v.id=r.rule_revision_id JOIN automation_binding_revisions b ON b.binding_set_id=r.binding_set_id AND b.revision=r.binding_revision`;

/** Pins executor/target identities at admission, before any asynchronous worker can run. */
export async function initializeRunTasks(tx: DatabaseTransaction,actor: AutomationActor,runId: string): Promise<void> {
  const run = (await sql<RunPin>`${selectPins} WHERE r.id=${runId} AND r.owner_id=${actor.accountId}`.execute(tx)).rows[0]!;
  if (!run.definition_json.tasks.length) return;
  const policy = run.execution_policy_id && run.policy_revision ? await createExecutionPolicyStore(tx,actor.accountId).load(run.execution_policy_id,run.policy_revision) : null;
  for (const task of run.definition_json.tasks) {
    const binding = run.values_json[task.executorRole],executor = binding?.kind === 'executor' && binding.executorId
      ? await createTargetStore(tx,actor.accountId).executors.load(binding.executorId) : null;
    const assignment = taskExecutionAssignment(policy,task),targetId = executor?.configuration.targetId ?? null;
    const permitted = assignment.available && !!executor && !!targetId && executor.configuration.kind === 'mcpEventsBot'
      && (!run.definition_json.route.targetIds?.length || run.definition_json.route.targetIds.includes(targetId))
      && (assignment.assignment.destinationScope !== 'explicit' || assignment.assignment.allowedDestinations.includes(executor.id));
    const satisfied = run.explanation_json.plan.kind === 'placed' && run.explanation_json.plan.satisfiedTasks?.includes(task.type);
    const placementAllowed = !['preserved','overridden','conflict','blocked'].includes(run.explanation_json.plan.kind);
    const state = satisfied ? 'pending' : !permitted ? 'blocked' : task.type.startsWith('classify.') && !placementAllowed ? 'review' : 'pending';
    await sql`INSERT INTO automation_jobs(id,run_id,task_id,target_id,target_partition,input_digest,contract_id,state,task_json,max_calls,delivery_handle,execution_context_json,explanation)
      VALUES(${randomUUID()},${runId},${task.id},${targetId},${targetId ?? '__m1__'},${automationDigest({ kind: 'pending',runId,taskId: task.id })},${task.outputContract},${state},${JSON.stringify(task)}::jsonb,
        ${assignment.available ? assignment.assignment.maxCalls : 0},${randomUUID()},${JSON.stringify({ executorId: executor?.id ?? null,placementAllowed,intakeSatisfied: !!satisfied })}::jsonb,
        ${satisfied ? 'Satisfied by deterministic intake; no optional call.' : !permitted ? 'No pinned explicit execution policy/destination permits this task.' : state === 'review' ? 'Explicit placement intent is preserved.' : 'Waiting for intake and accepted predecessors.'})
      ON CONFLICT(run_id,task_id,target_partition) DO NOTHING`.execute(tx);
  }
}

/** Serialize effects on the same source, without inventing dependencies in the declared DAG.
 * Only pending tasks acquire their first immutable input pins; ready/leased pins are never rebased. */
export async function advanceRunTasks(tx: DatabaseTransaction,actor: AutomationActor,serverUuid: string,runId: string): Promise<void> {
  const run = (await sql<RunPin>`${selectPins} JOIN collections c ON c.id=r.explanation_json->>'collectionId'
    WHERE r.id=${runId} AND r.owner_id=${actor.accountId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL
      AND r.state<>'cancelled' AND NOT r.held FOR UPDATE OF r`.execute(tx)).rows[0];
  if (!run?.definition_json.tasks.length || run.state === 'waiting') return;
  const paused = await tx.selectFrom('automation_settings').select('paused').where('owner_id','=',actor.accountId).executeTakeFirst();
  if (paused?.paused) return;
  const jobs = (await sql<PendingJob>`SELECT * FROM automation_jobs WHERE run_id=${runId} ORDER BY created_at,id FOR UPDATE`.execute(tx)).rows;
  if (jobs.some(j => ['ready','leased','committing','awaitingApproval','uncertain'].includes(j.state))) return;
  const chosen = run.definition_json.tasks.map(t => jobs.find(j => j.task_json.id === t.id)!).find(j => j.state === 'pending'
    && j.task_json.after.every(id => jobs.some(p => p.task_json.id === id && p.state === 'succeeded')));
  if (!chosen) {
    const state = jobs.some(j => j.state === 'pending') ? 'blocked' : jobs.every(j => j.state === 'succeeded') ? 'completed' : jobs.some(j => j.state === 'succeeded') ? 'partial' : 'review';
    await updateRun(state);return;
  }
  const { collectionId,nodeId } = run.explanation_json;
  const node = await tx.selectFrom('nodes').select(['resource_revision','payload_json','parent_id']).where('id','=',nodeId).where('collection_id','=',collectionId).where('deleted_at','is',null).executeTakeFirst();
  const last = (await sql<{ after_revision: string }>`SELECT e.after_revision FROM automation_effect_receipts e LEFT JOIN automation_proposals p ON p.job_id=e.job_id WHERE e.run_id=${runId}
    AND (e.step_id='intake' OR p.operations_json->0->>'type' IN ('move_node','update_node')) ORDER BY e.created_at DESC,e.id DESC LIMIT 1`.execute(tx)).rows[0];
  const previous = jobs.filter(j => j.state === 'succeeded' && j.input_revision).at(-1);
  if (!node || node.resource_revision !== (last?.after_revision ?? previous?.input_revision ?? run.explanation_json.sourceRevision)) {
    await hold('stale','A canonical edit invalidated the source before task inputs were pinned.');return;
  }
  if (chosen.execution_context_json.intakeSatisfied) {
    await sql`UPDATE automation_jobs SET state='succeeded',explanation='Satisfied by verified deterministic intake; no optional call.',revision=revision+1 WHERE id=${chosen.id}`.execute(tx);
    await advanceRunTasks(tx,actor,serverUuid,runId);return;
  }
  const inputRevisions: Record<string,string> = {};
  const reads = createBindingReadPort(tx,serverUuid),resolutions = await resolveBindings(reads,actor,run.definition_json,run.values_json);
  const task = chosen.task_json,root = task.folderRole ? resolutions[task.folderRole] : undefined;
  if (task.folderRole && root?.status !== 'valid') { await hold('blocked','Pinned folder constraints are unavailable.');return; }
  const allowedFolders: FolderRef[] = root?.status === 'valid' ? [root.snapshot.folder] : [];
  const input: TaskInput = { node: { serverUuid,collectionId,nodeId },sourceEventId: run.member_ids[0]!,availability: 'available' },payload = node.payload_json ?? {};
  for (const field of task.inputFields) {
    if (['url','title','description'].includes(field) && typeof payload[field] === 'string') Object.assign(input,{ [field]: payload[field] });
    if (field === 'tags' && Array.isArray(payload.tags)) input.tags = payload.tags as string[];
    if (field === 'note') {
      const notes = await tx.selectFrom('annotations').select(['id','resource_revision','payload_json']).where('collection_id','=',collectionId)
        .where('subject_type','=','node').where('subject_id','=',nodeId).where('creator_principal_id','=',actor.accountId)
        .where('visibility','=','private').where('deleted_at','is',null).where(sql<string>`payload_json->>'type'`,'=','note').orderBy('id').limit(2).execute();
      if (notes.length === 1 && typeof notes[0]!.payload_json.value === 'string') { input.note=notes[0]!.payload_json.value;inputRevisions[notes[0]!.id]=notes[0]!.resource_revision; }
    }
    if (field === 'folderDefinitions') { await hold('blocked','Folder definition capability is unavailable on this host.');return; }
    if (field === 'metadata' || field === 'readableText') { await hold('blocked',`Requested ${field} is unavailable; no implicit network/model fallback.`);return; }
  }
  const predecessors: Record<string,{ resultId: string; digest: string }> = {};
  for (const id of task.after) {
    const result = (await sql<{ id: string; proposal_digest: string; output_json: TaskOutput }>`SELECT a.id,a.proposal_digest,a.output_json FROM automation_jobs j JOIN automation_results a ON a.id=coalesce(j.result_id,j.reused_result_id)
      WHERE j.run_id=${runId} AND j.task_id=${id} AND a.status='accepted'`.execute(tx)).rows[0];
    if (!result) { await hold('blocked','A declared predecessor has no accepted typed result.');return; }
    predecessors[id]={ resultId: result.id,digest: result.proposal_digest };
    (input.acceptedPredecessors ??= []).push({ taskId: id,resultId: result.id,digest: result.proposal_digest,output: result.output_json });
  }
  const policy = run.execution_policy_id && run.policy_revision ? await createExecutionPolicyStore(tx,actor.accountId).load(run.execution_policy_id,run.policy_revision) : null;
  const assignment = taskExecutionAssignment(policy,task);
  if (!assignment.available || task.inputFields.some(f => !assignment.assignment.allowedData.includes(f))) { await hold('blocked','Pinned execution data policy is unavailable.');return; }
  if (Buffer.byteLength(JSON.stringify(input),'utf8')>262_144) { await hold('blocked','Allowlisted task input exceeds the 256 KiB bound.');return; }
  const authority = automationDigest({ ownerId: actor.accountId,executor: chosen.execution_context_json.executorId,target: chosen.target_id,
    binding: run.values_json,policy: policy!.configuration,privacy: run.definition_json.policy.privacy,resolutions: bindingResolutionSignature(resolutions) });
  const digest = taskInputDigest({ serverUuid,collectionId,nodeId,taskId: task.id,outputContract: task.outputContract,inputFields: task.inputFields,
    revisions: { node: node.resource_revision,policy: run.policy_revision,task: automationDigest(task),...inputRevisions },acceptedPredecessors: predecessors },input as unknown as Record<string,unknown>);
  const reuse = (await sql<{ id: string; owner_id: string; input_digest: string; contract_id: string; authority_digest: string; status: 'accepted' }>`SELECT * FROM automation_results
    WHERE owner_id=${actor.accountId} AND input_digest=${digest} AND contract_id=${task.outputContract} AND authority_digest=${authority} AND status='accepted' ORDER BY created_at LIMIT 1`.execute(tx)).rows[0];
  const accepted = !!reuse && compatibleAcceptedResult({ ownerId: actor.accountId,inputDigest: digest,contractId: task.outputContract,authorityDigest: authority },
    { ownerId: reuse.owner_id,inputDigest: reuse.input_digest,contractId: reuse.contract_id,authorityDigest: reuse.authority_digest,status: reuse.status });
  await sql`UPDATE automation_jobs SET input_json=${JSON.stringify([input])}::jsonb,input_revision=${node.resource_revision},input_digest=${digest},authority_digest=${authority},
    input_revisions_json=${JSON.stringify(inputRevisions)}::jsonb,allowed_folders=${JSON.stringify(allowedFolders)}::jsonb,state=${accepted ? 'succeeded' : 'ready'},reused_result_id=${accepted ? reuse!.id : null},revision=revision+1,
    explanation=${accepted ? 'Reused a compatible accepted typed result; no new provider call or effect.' : 'Ready with immutable allowlisted input pins.'} WHERE id=${chosen.id}`.execute(tx);
  await updateRun('running');
  if (accepted) await advanceRunTasks(tx,actor,serverUuid,runId);
  async function hold(state: string,reason: string) { await sql`UPDATE automation_jobs SET state=${state},explanation=${reason},revision=revision+1 WHERE id=${chosen!.id}`.execute(tx);await updateRun('review'); }
  async function updateRun(state: string) { await sql`UPDATE automation_runs SET state=${state},revision=revision+1,updated_at=clock_timestamp() WHERE id=${runId} AND state<>${state}`.execute(tx); }
}
