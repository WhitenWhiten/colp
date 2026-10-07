import type {
  McpApprovalStorePort, McpChangePlanStorePort, McpPlanCommitResult, McpStoredPlan,
} from '@know-n/colp/mcp';

/** Test adapters for the public host ports, including single-flight commit replay. */
export function createInMemoryPlanStore(_options?: { clock: { now(): Date } }): McpChangePlanStorePort {
  const plans = new Map<string, McpStoredPlan>();
  return {
    save: (plan) => { plans.set(plan.planId, plan); },
    get: (planId) => plans.get(planId),
    update: (plan) => { plans.set(plan.planId, plan); },
  };
}

export function createInMemoryApprovalStore(_options?: { clock: { now(): Date } }):
McpApprovalStorePort & { stats(): { approvals: number } } {
  const approvals = new Map<string, Parameters<McpApprovalStorePort['markApproved']>[0]>();
  const consumed = new Set<string>();
  const results = new Map<string, McpPlanCommitResult>();
  const inflight = new Map<string, {
    key: string; gate: Promise<McpPlanCommitResult | null>;
    resolve(result: McpPlanCommitResult | null): void;
  }>();
  const beginCommit: McpApprovalStorePort['beginCommit'] = async (input) => {
    const key = JSON.stringify([input.planId, input.idempotencyKey]);
    const prior = results.get(key);
    if (prior) return { status: 'already_consumed', firstResult: prior };
    const approval = approvals.get(input.planId);
    if (!approval) return { status: 'rejected', reason: 'missing' };
    if (Object.keys(approval.binding).some((field) =>
      approval.binding[field as keyof typeof approval.binding]
      !== input.binding[field as keyof typeof input.binding])) {
      return { status: 'rejected', reason: 'binding_mismatch' };
    }
    if (approval.operationsDigest !== input.operationsDigest) {
      return { status: 'rejected', reason: 'digest_mismatch' };
    }
    if (consumed.has(input.planId)) return { status: 'rejected', reason: 'concurrent_lost' };
    const held = inflight.get(input.planId);
    if (held) {
      if (held.key !== key) return { status: 'rejected', reason: 'concurrent_lost' };
      const result = await held.gate;
      return result ? { status: 'already_consumed', firstResult: result } : beginCommit(input);
    }
    let resolve!: (result: McpPlanCommitResult | null) => void;
    const gate = new Promise<McpPlanCommitResult | null>((done) => { resolve = done; });
    inflight.set(input.planId, { key, gate, resolve });
    return { status: 'ready' };
  };
  return {
    markApproved(input) { approvals.set(input.planId, input); },
    beginCommit,
    finalizeCommit(input) {
      const key = JSON.stringify([input.planId, input.idempotencyKey]);
      results.set(key, input.result);
      consumed.add(input.planId);
      const held = inflight.get(input.planId);
      inflight.delete(input.planId);
      held?.resolve(input.result);
    },
    abortCommit(input) {
      const held = inflight.get(input.planId);
      if (held?.key === JSON.stringify([input.planId, input.idempotencyKey])) {
        inflight.delete(input.planId);
        held.resolve(null);
      }
    },
    stats: () => ({ approvals: approvals.size }),
  };
}
