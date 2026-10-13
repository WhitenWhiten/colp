import { createChangePlanService, McpChangePlanError, type McpAuthenticatedAuthorizationBinding, type McpStoredPlan, type McpChangePlanServiceOptions } from '@know-n/colp/mcp';
import type { ScopeName } from '@know-n/colp/types';
import type { Kysely } from 'kysely';
import { createPostgresAutoApproveTrustedPlan } from '../collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { computePhase4bMcpStoredPlanDigest, runWithMcpAccountSubjectId, runWithMcpGrantedScopes,
  type Phase4bMcpPlannedChange, type AutomationPlanOperation } from '../../modules/mcp/index.js';
import { AutomationError, type WorkPrincipal } from '../../modules/automation/index.js';

export interface PinnedProposal {
  job_id: string; result_id: string; plan_id: string; command_id: string; binding_json: McpAuthenticatedAuthorizationBinding;
  operations_json: AutomationPlanOperation[]; base_revisions_json: Record<string,string>; allow_automatic_writes: boolean; created_at: Date;
}
export interface ProposalPlanGateway {
  advance(actor: WorkPrincipal,proposal: PinnedProposal): Promise<'committing' | 'awaitingApproval' | 'committed' | 'review'>;
}
/** Uses the existing durable Plan/Approval stores and the SAME host commit coordinator. */
export function createProposalPlanGateway(db: Kysely<DatabaseSchema>,options: McpChangePlanServiceOptions): ProposalPlanGateway {
  const service = createChangePlanService(options), autoApprove = createPostgresAutoApproveTrustedPlan(db);
  return { advance: (actor,p) => runWithMcpAccountSubjectId(actor.subjectId,() => runWithMcpGrantedScopes(actor.scopes,async () => {
    try {
      let stored = await options.planStore.get(p.plan_id);
      if (!stored) {
        const operation = p.operations_json[0]!;
        const plan = { planId: p.plan_id,expiresAt: new Date(p.created_at.getTime()+24*60*60_000).toISOString(),
          risk: 'medium',requiresApproval: true,approvalMethod: 'out_of_band',approvalUri: `${options.approvalBaseUri}/${encodeURIComponent(p.plan_id)}`,
          summary: `Automation: one reversible ${operation.type} effect.`,impact: { collections: 1,nodes: ['create_annotation','update_annotation'].includes(operation.type) ? 0 : 1,
            annotations: ['create_annotation','update_annotation'].includes(operation.type) ? 1 : 0,attachments: 0,relations: 0,privateFieldsExcluded: [] },
          requiredScopes: ['automation:work'] as unknown as ScopeName[],baseRevisions: p.base_revisions_json,operations: p.operations_json,
          binding: p.binding_json,untrustedNote: `automation:${operation.ruleId}:${p.job_id}`,createdAt: p.created_at.toISOString(),status: 'pending',operationsDigest: '' } as unknown as McpStoredPlan;
        const stamped = { ...plan,operationsDigest: computePhase4bMcpStoredPlanDigest(plan) };
        // Concurrent orchestrators use the same stable ID. Only duplicate-key errors are recoverable here.
        try { await options.planStore.save(stamped); }
        catch (error) { if ((error as { code?: string }).code !== '23505') throw error; }
        stored = await options.planStore.get(p.plan_id);
      }
      if (!stored) return 'committing';
      if (stored.status === 'consumed') return 'committed';
      if (stored.status === 'cancelled' || stored.status === 'expired' || Date.parse(stored.expiresAt) <= Date.now()) return 'review';
      if (stored.status === 'approved') { await service.commit(p.plan_id,p.binding_json,p.command_id); return 'committed'; }
      if (p.allow_automatic_writes) {
        const planned = { ...stored,mode: 'awaiting_approval',target: { kind: 'node',serverUuid: 'host',collectionId: p.operations_json[0]!.collectionId,nodeId: p.operations_json[0]!.nodeId } } as unknown as Phase4bMcpPlannedChange;
        const advanced = await autoApprove(planned,p.binding_json,{ canCommit: actor.scopes.includes('automation:work'),
          approve: service.recordOutOfBandApproval,commit: (id,binding) => service.commit(id,binding,p.command_id) });
        if (advanced.status === 'consumed') return 'committed';
      }
      return 'awaitingApproval';
    } catch (error) {
      if (!(error instanceof McpChangePlanError)) throw error;
      if (error.code === 'revision_drift') throw new AutomationError('automation_stale_input','The approved plan revisions changed; the original proposal is retained for review.');
      if (error.code === 'plan_expired' || error.code === 'plan_cancelled') return 'review';
      if (error.code === 'rate_limited') throw new AutomationError('rate_limited','Plan commit is temporarily rate limited.',[],null,30);
      if (error.code === 'scope_invalid' || error.code === 'plan_binding_mismatch') throw new AutomationError('insufficient_permission','Current plan authority is unavailable.');
      // Unknown commit outcomes must retry the same plan, never be declared failed or replaced.
      if (error.code === 'commit_failed') throw new AutomationError('feature_temporarily_unavailable','The original plan must be reconciled before any retry.',[],null,30);
      throw error;
    }
  })) };
}
