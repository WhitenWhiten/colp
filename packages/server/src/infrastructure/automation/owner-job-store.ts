import { sql } from 'kysely';
import { AutomationError,parseContract,requireEtag,decideAutomationProposal,type AutomationActor,type OwnerJobStore } from '../../modules/automation/index.js';
import { createPhase4bMcpWriteApprovalApi,WriteApprovalApiError } from '../../modules/mcp/index.js';
import { createPostgresMcpWriteApprovalPorts } from '../database/mcp-write-approval-port.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { workerJobView } from './worker-read-store.js';
import { expireOwnerLeases } from './worker-inputs.js';
import { reconcileCommittedPlanEffect } from './reconcile-plan-effect.js';
import { advanceRunTasks } from './task-scheduler.js';

export function createOwnerJobStore(tx: DatabaseTransaction,actor: AutomationActor,serverUuid: string): OwnerJobStore {
  const approval = createPhase4bMcpWriteApprovalApi(createPostgresMcpWriteApprovalPorts(tx));
  const inspect = async (id: string) => {
    const row = (await sql<Parameters<typeof workerJobView>[0] & { result_id: string | null; proposal_digest: string | null; plan_id: string | null; input_revision: string; node_id: string; max_calls: number }>`SELECT j.*,j.revision::text,j.active_generation::text,a.proposal_digest,p.plan_id,r.explanation_json->>'nodeId' AS node_id
      FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id JOIN collections c ON c.id=r.explanation_json->>'collectionId'
      LEFT JOIN automation_results a ON a.id=j.result_id LEFT JOIN automation_proposals p ON p.job_id=j.id
      WHERE j.id=${id} AND r.owner_id=${actor.accountId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL FOR UPDATE OF j,r`.execute(tx)).rows[0];
    if (!row) throw new AutomationError('resource_not_found','Job is unavailable under current Owner authority.');return row;
  };
  const get: OwnerJobStore['get'] = async id => {
    await expireOwnerLeases(tx,actor.accountId);await reconcileCommittedPlanEffect(tx,actor,id,serverUuid);
    const row = await inspect(id);
    return { ...workerJobView(row,false),...(row.proposal_digest ? { proposalDigest: row.proposal_digest,resultId: row.result_id!,...(row.plan_id ? { planId: row.plan_id } : {}) } : {}) };
  };
  return { get,
    async decide(id,body,ifMatch,commandId) {
      const row = await inspect(id);
      try {
        await decideAutomationProposal({ inspect: async () => {
          const plan = row.plan_id ? await approval.get({ id: actor.accountId },row.plan_id) : undefined;
          return plan && row.proposal_digest ? { revision: row.revision,proposalDigest: row.proposal_digest,planId: plan.planId,planEtag: plan.etag } : null;
        },decide: async input => {
          const result = await approval.decide({ account: { id: actor.accountId },...input,commandScope: 'automation-owner-plan-decision',fingerprint: `automation:${id}:${row.proposal_digest}:${input.decision}` });
          if (result.kind !== 'succeeded') throw new AutomationError('automation_command_conflict','Existing approval command is unavailable.');
          return result;
        } },id,body,ifMatch,commandId);
      } catch (error) {
        if (error instanceof WriteApprovalApiError) throw new AutomationError(error.code === 'precondition_failed' ? 'precondition_failed' : error.code === 'plan_not_found' ? 'resource_not_found' : 'automation_command_conflict',error.message,[],error.currentEtag);
        throw error;
      }
      const rejected = parseContract('DecisionInput',body).decision === 'reject';
      if (rejected) {
        await sql`UPDATE automation_results SET status='rejected' WHERE id=${row.result_id}`.execute(tx);
        await sql`UPDATE automation_jobs SET state='review',revision=revision+1,explanation='Owner rejected the exact proposal.' WHERE id=${id}`.execute(tx);
        await advanceRunTasks(tx,actor,serverUuid,row.run_id);
      }
      return { jobId: id,resultId: row.result_id!,proposalDigest: row.proposal_digest!,status: rejected ? 'review' : 'awaitingApproval',effectReceiptIds: [],diagnostics: [] };
    },
    async retry(id,body,ifMatch) {
      parseContract('CommandReason',body);await expireOwnerLeases(tx,actor.accountId);const row = await inspect(id);requireEtag(row.revision,ifMatch);
      const run = (await sql<{ held: boolean; state: string }>`SELECT held,state FROM automation_runs WHERE id=${row.run_id}`.execute(tx)).rows[0]!;
      if (run.held || run.state === 'cancelled' || row.state !== 'uncertain' || row.result_id || row.plan_id)
        throw new AutomationError('automation_claim_conflict','Only uncertain work without a durable proposal can be explicitly retried. Existing proposals must reconcile their same plan.');
      const node = await tx.selectFrom('nodes').select('resource_revision').where('id','=',row.node_id).where('deleted_at','is',null).executeTakeFirst();
      if (!node || node.resource_revision !== row.input_revision) throw new AutomationError('automation_stale_input','Pinned source changed; this job cannot be rebound.');
      const count = (await sql<{ count: number }>`SELECT count(*)::int AS count FROM automation_job_attempts WHERE job_id=${id}`.execute(tx)).rows[0]!.count;
      if (count>=row.max_calls) throw new AutomationError('automation_budget_exceeded','Pinned maxCalls is exhausted; retry does not silently upgrade the execution policy.');
      await sql`UPDATE automation_jobs SET state='ready',revision=revision+1,explanation='Owner explicitly authorized retry after an unknown external outcome; original pins and unknown cost are retained.' WHERE id=${id}`.execute(tx);
      return get(id);
    },
  };
}
