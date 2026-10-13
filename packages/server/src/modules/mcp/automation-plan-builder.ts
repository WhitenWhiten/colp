import type { McpAuthenticatedAuthorizationBinding, McpStoredPlan } from '@know-n/colp/mcp';
import { isAutomationPlanOperation, type AutomationPlanOperation } from './automation-plan-operations.js';
import { computePhase4bMcpStoredPlanDigest } from './change-plan-service.js';

interface AutomationPlanInput {
  planId: string; jobId: string; operation: AutomationPlanOperation;
  binding: McpAuthenticatedAuthorizationBinding; revisions: Readonly<Record<string, string>>;
  createdAt: Date; approvalBaseUri: string;
}

/** Closed host operation builder. Public changes.plan never admits this private
 * operation shape; the installed host executor/commit guard is its only consumer. */
export function buildAutomationStoredPlan(input: AutomationPlanInput): McpStoredPlan {
  const op = input.operation;
  if (!isAutomationPlanOperation(op) || op.jobId !== input.jobId
    || !input.revisions['content.' + op.collectionId] || !input.revisions['node.' + op.nodeId]) {
    throw new TypeError('Incomplete or mismatched pinned automation plan');
  }
  const annotation = op.type === 'create_annotation' || op.type === 'update_annotation';
  // The SDK coordinator's stored-plan type describes public protocol operations.
  // Keep the host extension adaptation at this one validated boundary; all other
  // fields are checked against the actual coordinator type at construction time.
  const host: Omit<McpStoredPlan, 'operations' | 'requiredScopes'> & {
    operations: readonly AutomationPlanOperation[]; requiredScopes: readonly string[];
  } = {
    planId: input.planId, expiresAt: new Date(input.createdAt.getTime() + 86_400_000).toISOString(),
    risk: 'medium', requiresApproval: true, approvalMethod: 'out_of_band',
    approvalUri: `${input.approvalBaseUri}/${encodeURIComponent(input.planId)}`,
    summary: `Automation: one reversible ${op.type} effect.`,
    impact: { collections: 1, nodes: annotation ? 0 : 1, annotations: annotation ? 1 : 0,
      attachments: 0, relations: 0, privateFieldsExcluded: [] },
    requiredScopes: ['automation:work'], baseRevisions: input.revisions, operations: [op],
    binding: input.binding, untrustedNote: `automation:${op.ruleId}:${input.jobId}`,
    createdAt: input.createdAt.toISOString(), status: 'pending', operationsDigest: '',
  };
  const coordinator: Omit<McpStoredPlan, 'operations' | 'requiredScopes'> & {
    operations: readonly unknown[]; requiredScopes: readonly string[];
  } = host;
  const plan = coordinator as McpStoredPlan;
  return { ...plan, operationsDigest: computePhase4bMcpStoredPlanDigest(plan) };
}
