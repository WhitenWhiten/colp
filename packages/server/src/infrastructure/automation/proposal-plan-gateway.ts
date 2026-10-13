import { createChangePlanService, McpChangePlanError, type McpAuthenticatedAuthorizationBinding, type McpChangePlanServiceOptions } from '@know-n/colp/mcp';
import type { Kysely } from 'kysely';
import { createPostgresAutoApproveTrustedPlan } from '../collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { buildAutomationStoredPlan, runWithMcpAccountSubjectId, runWithMcpGrantedScopes, type Phase4bMcpPlannedChange, type AutomationPlanOperation } from '../../modules/mcp/index.js';
import { AutomationError, type WorkPrincipal } from '../../modules/automation/index.js';
export interface PinnedProposal {
    job_id: string;
    result_id: string;
    plan_id: string;
    command_id: string;
    binding_json: McpAuthenticatedAuthorizationBinding;
    operations_json: AutomationPlanOperation[];
    base_revisions_json: Record<string, string>;
    allow_automatic_writes: boolean;
    created_at: Date;
}
export interface ProposalPlanGateway {
    advance(actor: WorkPrincipal, proposal: PinnedProposal): Promise<'committing' | 'awaitingApproval' | 'committed' | 'review'>;
}
/** Uses the existing durable Plan/Approval stores and the SAME host commit coordinator. */
export function createProposalPlanGateway(db: Kysely<DatabaseSchema>, options: McpChangePlanServiceOptions): ProposalPlanGateway {
    const service = createChangePlanService(options), autoApprove = createPostgresAutoApproveTrustedPlan(db);
    return { advance: (actor, p) => runWithMcpAccountSubjectId(actor.subjectId, () => runWithMcpGrantedScopes(actor.scopes, async () => {
            try {
                let stored = await options.planStore.get(p.plan_id);
                if (!stored) {
                    if (p.operations_json.length !== 1)
                        throw new TypeError('Automation plan must contain exactly one pinned operation');
                    const stamped = buildAutomationStoredPlan({ planId: p.plan_id, jobId: p.job_id, operation: p.operations_json[0]!,
                        binding: p.binding_json, revisions: p.base_revisions_json, createdAt: p.created_at, approvalBaseUri: options.approvalBaseUri });
                    // Concurrent orchestrators use the same stable ID. Only duplicate-key errors are recoverable here.
                    try {
                        await options.planStore.save(stamped);
                    }
                    catch (error) {
                        if ((error as {
                            code?: string;
                        }).code !== '23505')
                            throw error;
                    }
                    stored = await options.planStore.get(p.plan_id);
                }
                if (!stored)
                    return 'committing';
                if (stored.status === 'consumed')
                    return 'committed';
                if (stored.status === 'cancelled' || stored.status === 'expired' || Date.parse(stored.expiresAt) <= Date.now())
                    return 'review';
                if (stored.status === 'approved') {
                    await service.commit(p.plan_id, p.binding_json, p.command_id);
                    return 'committed';
                }
                if (p.allow_automatic_writes) {
                    const planned: Phase4bMcpPlannedChange = { ...stored, status: 'pending', mode: 'awaiting_approval', target: { kind: 'node', serverUuid: 'host', collectionId: p.operations_json[0]!.collectionId, nodeId: p.operations_json[0]!.nodeId } };
                    const advanced = await autoApprove(planned, p.binding_json, { canCommit: actor.scopes.includes('automation:work'),
                        approve: service.recordOutOfBandApproval, commit: (id, binding) => service.commit(id, binding, p.command_id) });
                    if (advanced.status === 'consumed')
                        return 'committed';
                }
                return 'awaitingApproval';
            }
            catch (error) {
                if (!(error instanceof McpChangePlanError))
                    throw error;
                if (error.code === 'revision_drift')
                    throw new AutomationError('automation_stale_input', 'The approved plan revisions changed; the original proposal is retained for review.');
                if (error.code === 'plan_expired' || error.code === 'plan_cancelled')
                    return 'review';
                if (error.code === 'rate_limited')
                    throw new AutomationError('rate_limited', 'Plan commit is temporarily rate limited.', [], null, 30);
                if (error.code === 'scope_invalid' || error.code === 'plan_binding_mismatch')
                    throw new AutomationError('insufficient_permission', 'Current plan authority is unavailable.');
                // Unknown commit outcomes must retry the same plan, never be declared failed or replaced.
                if (error.code === 'commit_failed')
                    throw new AutomationError('feature_temporarily_unavailable', 'The original plan must be reconciled before any retry.', [], null, 30);
                throw error;
            }
        })) };
}
