import { recordDeterministicCompletion } from './deterministic-completion.js';
import { persistReusedRunOutput } from './reused-run-output.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationDigest,taskInputDigest,type RuleDefinition,type RoleBindings,type TaskSpec,type Job,type Run } from '@know-n/colp/automation';
import { compatibleAcceptedResult,resolveBindings,assessIntakeBindings,bindingResolutionSignature,taskExecutionAssignment,type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createExecutionPolicyStore } from './execution-policy-store.js';
import { createTargetStore } from './target-store.js';
import { createBindingReadPort } from './bindings.js';
import { prepareRunInputs } from './task-inputs.js';

interface RunPin { id: string; rule_id: string; definition_json: RuleDefinition; values_json: RoleBindings; execution_policy_id: string | null;
  policy_revision: string | null; state: string; member_ids: string[]; explanation_json: { collectionId: string; nodeId: string; sourceRevision: string; memberSources?: {eventId:string;nodeId:string;revision:string}[]; plan: { kind: string; satisfiedTasks?: string[] } } }
interface TaskContext { executorId: string | null; placementAllowed: boolean; intakeSatisfied: boolean }
interface PendingJob { id: string; task_json: TaskSpec; state: Job['status']; input_revision: string | null; execution_context_json: TaskContext; target_id: string | null; budget_block_reason: 'daily' | 'calls' | null }
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
  // Every iteration consumes a pending task or returns. The declared task count bounds this loop.
  for (;;) {
    const jobs = (await sql<PendingJob>`SELECT * FROM automation_jobs WHERE run_id=${runId} ORDER BY created_at,id FOR UPDATE`.execute(tx)).rows;
    if (jobs.some(j => ['ready','leased','committing','awaitingApproval','uncertain'].includes(j.state)
      || (j.state === 'blocked' && j.budget_block_reason === 'daily'))) return;
    const byTask = new Map(jobs.map(job => [job.task_json.id,job]));
    const chosen = run.definition_json.tasks.map(task => byTask.get(task.id))
      .find(job => job?.state === 'pending' && job.task_json.after.every(id => byTask.get(id)?.state === 'succeeded'));
    if (!chosen) {
      const pending = jobs.filter(job => job.state === 'pending');
      if (pending.length) {
        await sql`UPDATE automation_jobs SET state='blocked',revision=revision+1,explanation='A predecessor did not succeed; no automatic retry or fallback.'
          WHERE run_id=${runId} AND state='pending'`.execute(tx);
        for (const job of pending) job.state='blocked';
      }
      const state: Run['status'] = jobs.every(job => job.state === 'succeeded') ? 'completed'
        : jobs.some(job => job.state === 'succeeded') ? 'partial'
        : jobs.some(job => job.state === 'blocked') ? 'blocked'
        : jobs.every(job => job.state === 'failed') ? 'failed' : 'review';
      await updateRun(state);
      return;
    }
    if (paused?.paused) return;
    const hold = async (state: 'stale' | 'blocked' | 'review',reason: string) => {
      await sql`UPDATE automation_jobs SET state=${state},explanation=${reason},revision=revision+1 WHERE id=${chosen.id}`.execute(tx);
    };
    const { collectionId,nodeId } = run.explanation_json;
    const node = await tx.selectFrom('nodes').select(['resource_revision','payload_json','parent_id'])
      .where('id','=',nodeId).where('collection_id','=',collectionId).where('deleted_at','is',null).executeTakeFirst();
    const last = (await sql<{ after_revision: string }>`SELECT e.after_revision FROM automation_effect_receipts e
      LEFT JOIN automation_proposals p ON p.job_id=e.job_id WHERE e.run_id=${runId}
      AND (e.step_id='intake' OR p.operations_json->0->>'type' IN ('move_node','update_node')) ORDER BY e.created_at DESC,e.id DESC LIMIT 1`.execute(tx)).rows[0];
    if (!node || node.resource_revision !== (last?.after_revision ?? run.explanation_json.sourceRevision)) {
      await hold('stale','A canonical edit invalidated the source before task inputs were pinned.');
      continue;
    }
    const resolutions = await resolveBindings(createBindingReadPort(tx,serverUuid),actor,run.definition_json,run.values_json);
    if (!assessIntakeBindings(run.definition_json,resolutions).available) {
      await hold('blocked','Required rule scope or intake constraints are no longer available.');
      continue;
    }
    if (chosen.execution_context_json.intakeSatisfied) {
      const role = run.definition_json.intake?.folderRole,root = role ? resolutions[role] : undefined;
      // Admission is only intent. Both a real move and the already-in-destination no-op must
      // still have the live pinned destination and source revision before satisfying a task.
      if (root?.status !== 'valid' || node.parent_id !== root.snapshot.folder.nodeId) {
        await hold('blocked','Deterministic intake has no verified current placement; admission alone cannot satisfy this task.');
      } else {
        await recordDeterministicCompletion(tx, { jobId: chosen.id, runId, nodeId, revision: node.resource_revision,
          parentId: node.parent_id!, sourceEventId: run.member_ids[0]! });
        await sql`UPDATE automation_jobs SET state='succeeded',explanation='Satisfied by verified deterministic intake; no optional call.',revision=revision+1 WHERE id=${chosen.id}`.execute(tx);
      }
      continue;
    }
    const task = chosen.task_json,root = task.folderRole ? resolutions[task.folderRole] : undefined;
    if (task.folderRole && root?.status !== 'valid') {
      await hold('blocked','Pinned folder constraints are unavailable.');
      continue;
    }
    const allowedFolders = root?.status === 'valid' ? [root.snapshot.folder] : [];
    const prepared = await prepareRunInputs(tx,task,{ ownerId: actor.accountId,serverUuid,collectionId,nodeId,runId,
      sourceEventId: run.member_ids[0]!,payload: node.payload_json ?? {} },run.explanation_json.memberSources);
    if (prepared.kind === 'blocked') {
      await hold(run.explanation_json.memberSources ? 'review' : 'blocked',prepared.reason);
      continue;
    }
    const { input,inputs,revisions,predecessors,memberRevisions } = prepared;
    const policy = run.execution_policy_id && run.policy_revision
      ? await createExecutionPolicyStore(tx,actor.accountId).load(run.execution_policy_id,run.policy_revision) : null;
    if (!policy || !taskExecutionAssignment(policy,task).available) {
      await hold('blocked','Pinned execution data policy is unavailable.');
      continue;
    }
    const authority = automationDigest({ ownerId: actor.accountId,executor: chosen.execution_context_json.executorId,target: chosen.target_id,
      binding: run.values_json,policy: policy.configuration,privacy: run.definition_json.policy.privacy,resolutions: bindingResolutionSignature(resolutions) });
    const singleDigest = taskInputDigest({ serverUuid,collectionId,nodeId,taskId: task.id,outputContract: task.outputContract,inputFields: task.inputFields,
      revisions: { node: node.resource_revision,policy: run.policy_revision,task: automationDigest(task),...revisions },acceptedPredecessors: predecessors },{ ...input });
    const digest=run.explanation_json.memberSources ? automationDigest({singleDigest,members:inputs,revisions:memberRevisions}) : singleDigest;
    const reuse = (await sql<{ id: string; owner_id: string; input_digest: string; contract_id: string; authority_digest: string; status: 'accepted' }>`SELECT * FROM automation_results
      WHERE owner_id=${actor.accountId} AND input_digest=${digest} AND contract_id=${task.outputContract} AND authority_digest=${authority} AND status='accepted' ORDER BY created_at LIMIT 1`.execute(tx)).rows[0];
    const accepted = !!reuse && compatibleAcceptedResult({ ownerId: actor.accountId,inputDigest: digest,contractId: task.outputContract,authorityDigest: authority },
      { ownerId: reuse.owner_id,inputDigest: reuse.input_digest,contractId: reuse.contract_id,authorityDigest: reuse.authority_digest,status: reuse.status });
    await sql`UPDATE automation_jobs SET input_json=${JSON.stringify(inputs)}::jsonb,input_revision=${node.resource_revision},input_digest=${digest},authority_digest=${authority},
      member_revisions_json=${JSON.stringify(memberRevisions)}::jsonb,input_revisions_json=${JSON.stringify(revisions)}::jsonb,allowed_folders=${JSON.stringify(allowedFolders)}::jsonb,state=${accepted ? 'succeeded' : 'ready'},reused_result_id=${accepted ? reuse!.id : null},revision=revision+1,
      explanation=${accepted ? 'Reused a compatible accepted typed result; no new provider call or effect.' : 'Ready with immutable allowlisted input pins.'} WHERE id=${chosen.id}`.execute(tx);
    if(accepted)await persistReusedRunOutput(tx,reuse!.id,chosen.id);
    if (!accepted) {
      await updateRun('running');
      return;
    }
  }
  async function updateRun(state: Run['status']) {
    await sql`UPDATE automation_runs SET state=${state},revision=revision+1,updated_at=clock_timestamp() WHERE id=${runId} AND state<>${state}`.execute(tx);
  }
}
