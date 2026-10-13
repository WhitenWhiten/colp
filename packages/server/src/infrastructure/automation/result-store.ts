import { advanceRunTasks } from './task-scheduler.js';
import { currentWorkInputs } from './worker-inputs.js';
import { reconcileCommittedPlanEffect } from './reconcile-plan-effect.js';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { type TaskSpec, type TaskInput, type SubmissionResult } from '@know-n/colp/automation';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import { AutomationError, assessTypedEffect, type ResultSubmissionPort, type WorkPrincipal } from '../../modules/automation/index.js';
import type { AutomationPlanOperation } from '../../modules/mcp/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { lockWorkJob, type TargetAuthority } from './work-authority.js';
import { claimTokenHash, workBinding, requireJobLease } from './lease-store.js';
import { rejectedInput, storeTypedResult } from './result-lifecycle.js';

import type { PinnedProposal, ProposalPlanGateway } from './proposal-plan-gateway.js';

interface ResultRow { id: string; proposal_digest: string; status: string }
export function createResultSubmissionPort(db: Kysely<DatabaseSchema>,serverUuid: string,authorize: TargetAuthority,gateway: ProposalPlanGateway,
  options: { afterCanonicalCommit?: () => Promise<void> } = {}): ResultSubmissionPort & { guard(tx: DatabaseTransaction,planId: string): Promise<void> } {
  const proposal = async (tx: Kysely<DatabaseSchema>,jobId: string) => (await sql<PinnedProposal>`SELECT * FROM automation_proposals WHERE job_id=${jobId}`.execute(tx)).rows[0];
  const currentInputs = (tx: DatabaseTransaction,actor: WorkPrincipal,jobId: string,allowPaused = false) => currentWorkInputs(tx,actor,jobId,serverUuid,authorize,allowPaused);
  return {
    task: (actor,id) => db.transaction().execute(async tx => {
      await lockWorkJob(tx,actor,id,authorize,true);
      const row = (await sql<{ task_json: TaskSpec | null; input_json: TaskInput[] | null }>`SELECT task_json,input_json
        FROM automation_jobs WHERE id=${id}`.execute(tx)).rows[0];
      if (!row?.task_json || !row.input_json) throw new AutomationError('automation_claim_conflict','Job has no ready input pins to submit against.');
      return { task: row.task_json,sourceReferences: row.input_json.map(input => input.sourceEventId) };
    }),
    prepare: (actor,id,input,digest) => db.transaction().execute(async tx => {
      const job = await lockWorkJob(tx,actor,id,authorize,true);
      const existing = (await sql<ResultRow>`SELECT * FROM automation_results WHERE job_id=${id}`.execute(tx)).rows[0];
      if (existing) {
        const attempt = (await sql<{ claim_token_hash: string; principal_binding: string }>`SELECT claim_token_hash,principal_binding FROM automation_job_attempts
          WHERE job_id=${id} AND generation=${input.generation}`.execute(tx)).rows[0];
        if (!attempt || attempt.principal_binding !== workBinding(actor) || attempt.claim_token_hash !== claimTokenHash(input.claimToken)
          || String(job.active_generation) !== String(input.generation)) throw new AutomationError('automation_lease_lost','Submission belongs to another claim.');
        if (existing.proposal_digest !== digest) throw new AutomationError('automation_command_conflict','A different proposal already owns this job/input.');
        return;
      }
      await requireJobLease(tx,actor,job,input);
      if (input.inputDigest !== job.input_digest) throw new AutomationError('automation_stale_input','Input digest changed.');
      let current: Awaited<ReturnType<typeof currentInputs>>;
      try { current = await currentInputs(tx,actor,id,true); }
      catch (error) {
        const rejected = rejectedInput(error);
        if (!rejected) throw error;
        const pin = (await sql<{ authority_digest: string }>`SELECT authority_digest FROM automation_jobs WHERE id=${id}`.execute(tx)).rows[0]!;
        await storeTypedResult(tx,job,input,digest,pin.authority_digest,rejected.state,rejected.reason);
        await advanceRunTasks(tx,actor,serverUuid,job.run_id);
        return;
      }
      const { pin,node } = current;
      let allowed = pin.allowed_folders;
      if (input.output.kind === 'placement' && input.output.destination) {
        if (pin.execution_context_json.placementAllowed === false) throw new AutomationError('automation_stale_input','Explicit placement intent is preserved.');
        const { createBindingReadPort } = await import('./bindings.js');
        const destination = await createBindingReadPort(tx,serverUuid).readFolder(actor,input.output.destination);
        if (destination.status === 'valid' && pin.allowed_folders.some(root => [destination.snapshot.folder,...destination.snapshot.ancestors].some(f => f.serverUuid===root.serverUuid && f.collectionId===root.collectionId && f.nodeId===root.nodeId))) allowed=[...allowed,input.output.destination];
      }
      const kind = assessTypedEffect(input.output,allowed);
      const policy = (await sql<{ configuration_json: { allowAutomaticWrites: boolean } }>`SELECT p.configuration_json FROM automation_runs r
        JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
        JOIN automation_execution_policy_revisions p ON p.policy_id=v.execution_policy_id AND p.revision::text=r.policy_revision
        WHERE r.id=${job.run_id}`.execute(tx)).rows[0];
      if (!policy) throw new AutomationError('automation_unsupported_capability','Pinned execution policy is unavailable.');
      const state = kind === 'review' ? 'review' : kind === 'none' ? 'succeeded' : 'committing';
      const resultId = await storeTypedResult(tx,job,input,digest,pin.authority_digest,state);
      if (kind === 'none' || kind === 'review') return;
      if (!actor.resourceAudience || !actor.securityEpoch) throw new AutomationError('insufficient_permission','Verified credential binding is required.');
      const planId = `automation-${id}`, commandId = randomUUID(), operationId = `automation-op-${id}`;
      const binding: McpAuthenticatedAuthorizationBinding = { kind: 'authenticated',principalId: actor.accountId,clientId: actor.clientId,
        credentialBindingId: actor.credentialBindingId,resourceAudience: actor.resourceAudience,securityEpoch: actor.securityEpoch };
      const operation: AutomationPlanOperation = { type: kind === 'tags' ? 'update_node' : kind === 'move' ? 'move_node' : 'create_annotation',
        collectionId: job.collection_id,nodeId: job.node_id,ruleId: job.rule_id,jobId: id,runId: job.run_id,commandId,operationId };
      const collection = await tx.selectFrom('collections').select(['content_revision','policy_revision']).where('id','=',job.collection_id).executeTakeFirstOrThrow();
      const revisions: Record<string,string> = { ['content.'+job.collection_id]: collection.content_revision,['policy.'+job.collection_id]: collection.policy_revision,['node.'+job.node_id]: node.resource_revision };
      if (input.output.kind === 'tags') {
        const rejected = new Set((await sql<{ tag_key: string }>`SELECT tag_key FROM automation_tag_rejections WHERE owner_id=${actor.accountId} AND rule_id=${job.rule_id}`.execute(tx)).rows.map(r => r.tag_key));
        operation.tags = [...new Set([...(node.payload_json?.tags as string[] ?? []),...input.output.add.map(tag => tag.key.normalize('NFC')).filter(tag => !rejected.has(tag))])];
      }
      if (input.output.kind === 'placement' && input.output.destination) {
        operation.parentId = input.output.destination.nodeId; operation.sourceParentId = node.parent_id!;
        for (const parentId of new Set([operation.parentId,operation.sourceParentId])) {
          const parent = await tx.selectFrom('nodes').select('children_revision').where('id','=',parentId).where('collection_id','=',job.collection_id).where('deleted_at','is',null).executeTakeFirstOrThrow();
          revisions['children.'+parentId] = parent.children_revision;
        }
      }
      if (input.output.kind === 'text') {
        operation.annotationId = `automation-note-${id}`;
        operation.text = `${input.output.text}\n\nAutomation ${job.rule_id} / ${id}${input.modelLabel ? ` (${input.modelLabel})` : ''}`;
        const existingNote = await tx.selectFrom('annotations').select(['id','resource_revision','payload_json'])
          .where('collection_id','=',job.collection_id).where('subject_id','=',job.node_id).where('subject_type','=','node')
          .where('creator_principal_id','=',actor.accountId).where('visibility','=','private').where('deleted_at','is',null)
          .where(sql<string>`payload_json->>'type'`,'=','note').orderBy('id').limit(2).execute();
        if (existingNote.length > 1) throw new AutomationError('automation_unsupported_capability','Multiple notes require explicit review; no arbitrary note is selected.');
        if (existingNote[0]) {
          const note = existingNote[0], payload = note.payload_json;
          if (typeof payload.value !== 'string' || !['plain','markdown'].includes(String(payload.format)))
            throw new AutomationError('automation_unsupported_capability','This note format cannot be safely appended.');
          operation.type='update_annotation';operation.annotationId=note.id;operation.annotationRevision=note.resource_revision;
          operation.text=payload.value+'\n\n'+operation.text;
          if (Buffer.byteLength(operation.text,'utf8')>65_536) throw new AutomationError('payload_too_large','Appended note exceeds the canonical note size bound.');
        }
        operation.creator = { id: `urn:colp:account:${actor.accountId}`,name: 'Automation' };
      }
      await sql`INSERT INTO automation_proposals(job_id,result_id,plan_id,command_id,binding_json,operations_json,base_revisions_json,allow_automatic_writes)
        VALUES(${id},${resultId},${planId},${commandId},${JSON.stringify(binding)}::jsonb,${JSON.stringify([operation])}::jsonb,${JSON.stringify(revisions)}::jsonb,${policy.configuration_json.allowAutomaticWrites})`.execute(tx);
    }),
    async reconcile(actor,id) {
      // Authorization is checked before attempting new effects; a committed plan is only linked, never reexecuted.
      const p = await proposal(db,id);
      let advanced: Awaited<ReturnType<ProposalPlanGateway['advance']>> | undefined;
      let rejected: { state: 'stale' | 'review'; reason: string } | undefined;
      if (p) {
        const consumed = (await sql<{ status: string }>`SELECT status FROM mcp_change_plans WHERE plan_id=${p.plan_id}`.execute(db)).rows[0]?.status === 'consumed';
        if (consumed) advanced = 'committed';
        else try {
          const mayCommit = await db.transaction().execute(async tx => {
            const job = await lockWorkJob(tx,actor,id,authorize,true);
            if (!['committing','awaitingApproval'].includes(job.state)) return false;
            const paused = await tx.selectFrom('automation_settings').select('paused').where('owner_id','=',actor.accountId).executeTakeFirst();
            if (paused?.paused) return false;
            await currentInputs(tx,actor,id);
            return true;
          });
          if (mayCommit) advanced = await gateway.advance(actor,p);
        } catch (error) {
          rejected = rejectedInput(error);
          // Pause can win the race at the commit guard after the preflight. Keep the proposal.
          if (!rejected && !(error instanceof AutomationError && error.code === 'automation_paused')) throw error;
        }
        if (advanced === 'committed') await options.afterCanonicalCommit?.();
      }
      return db.transaction().execute(async tx => {
        const job = await lockWorkJob(tx,actor,id,authorize,true), result = (await sql<ResultRow>`SELECT * FROM automation_results WHERE job_id=${id}`.execute(tx)).rows[0];
        if (!result) throw new AutomationError('resource_not_found','Result is unavailable.');
        // A concurrent reconciler may have committed before our failure was recorded.
        const committed = p && await reconcileCommittedPlanEffect(tx,actor,id,serverUuid);
        if (!committed) {
          if (advanced === 'committed') throw new AutomationError('feature_temporarily_unavailable','Committed plan is not yet reconcilable.');
          if (rejected) await sql`UPDATE automation_jobs SET state=${rejected.state},explanation=${rejected.reason},revision=revision+1
            WHERE id=${id} AND state IN ('committing','awaitingApproval')`.execute(tx);
          else if (advanced) await sql`UPDATE automation_jobs SET state=${advanced},revision=revision+1,
            explanation=${advanced === 'review' ? 'The original plan expired or was cancelled; the proposal is retained for review.'
              : advanced === 'awaitingApproval' ? 'Waiting for Owner approval of the exact proposal.' : 'The original plan is still committing.'}
            WHERE id=${id} AND state IN ('committing','awaitingApproval') AND state<>${advanced}`.execute(tx);
        }
        await advanceRunTasks(tx,actor,serverUuid,job.run_id);
        const row = (await sql<{ state: SubmissionResult['status']; explanation: string | null }>`SELECT state,explanation FROM automation_jobs WHERE id=${id}`.execute(tx)).rows[0]!;
        const effects = (await sql<{ id: string }>`SELECT id FROM automation_effect_receipts WHERE job_id=${id}`.execute(tx)).rows;
        return { jobId: id,resultId: result.id,proposalDigest: result.proposal_digest,status: row.state,effectReceiptIds: effects.map(e => e.id),
          diagnostics: ['stale','review'].includes(row.state) && row.explanation
            ? [{ code: row.state === 'stale' ? 'automation_stale_input' : 'reviewRequired',severity: 'warning' as const,location: '/output',message: row.explanation }] : [] };
      });
    },
    async guard(tx,planId) {
      const p = (await sql<PinnedProposal>`SELECT * FROM automation_proposals WHERE plan_id=${planId}`.execute(tx)).rows[0];
      if (!p) return;
      const account = await tx.selectFrom('accounts').select('subject_id').where('id','=',p.binding_json.principalId).executeTakeFirstOrThrow();
      const actor: WorkPrincipal = { accountId: p.binding_json.principalId,subjectId: account.subject_id,clientId: p.binding_json.clientId,
        credentialBindingId: p.binding_json.credentialBindingId,scopes: ['automation:work'],resourceAudience: p.binding_json.resourceAudience,securityEpoch: p.binding_json.securityEpoch };
      const { pin,job } = await currentInputs(tx,actor,p.job_id);
      if (!['committing','awaitingApproval'].includes(job.state))
        throw new AutomationError('automation_stale_input','The proposal is no longer eligible for canonical effects.');
      const operation = p.operations_json[0];
      if (operation?.type === 'move_node' && operation.parentId) {
        const { createBindingReadPort } = await import('./bindings.js');
        const destination = await createBindingReadPort(tx,serverUuid).readFolder(actor,{ serverUuid,collectionId: operation.collectionId,nodeId: operation.parentId });
        if (destination.status !== 'valid' || !pin.allowed_folders.some(root => [destination.snapshot.folder,...destination.snapshot.ancestors].some(f => f.nodeId===root.nodeId && f.collectionId===root.collectionId && f.serverUuid===root.serverUuid)))
          throw new AutomationError('automation_binding_unavailable','Proposed destination no longer belongs to the pinned subtree.');
      }
    },
  };
}
