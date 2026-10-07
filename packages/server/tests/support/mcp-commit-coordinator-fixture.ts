import type {
  McpApprovalStorePort,
  McpChangePlanCommitCoordinatorPort,
  McpChangePlanExecutorPort,
  McpChangePlanStorePort,
  McpStoredPlan,
} from '@know-n/colp/mcp';
import type { ChangePlanOperation } from '@know-n/colp/types';

/**
 * Host-owned revision namespace policy used by tests that are not specifically
 * exercising H-06. Dedicated H-06 tests use explicit resolver decisions.
 */
export function resolveFixtureBaseRevisions(
  operation: ChangePlanOperation,
): Readonly<Record<string, string>> {
  if (!('baseRevision' in operation)) return Object.freeze({});

  switch (operation.type) {
    case 'delete_subtree':
      return Object.freeze({ [`node.${operation.targetId}`]: operation.baseRevision });
    case 'set_visibility':
    case 'set_access_policy':
      return Object.freeze({ [`access.${operation.collectionId}`]: operation.baseRevision });
    case 'set_rate_limit':
      return Object.freeze({ [`rate-limit.${operation.targetId}`]: operation.baseRevision });
    case 'delete_collection':
    case 'publish_release':
    case 'sync_mirror':
      return Object.freeze({ [`collection.${operation.collectionId}`]: operation.baseRevision });
    default:
      return Object.freeze({});
  }
}

/**
 * Test-only bridge for contracts that do not assert Commit atomicity.
 * H-02/H-03 evidence must use a locking transaction-staging adapter instead.
 */
export function createCommitCoordinatorFixture(
  planStore: McpChangePlanStorePort,
  approvalStore: McpApprovalStorePort,
  executor: McpChangePlanExecutorPort,
): McpChangePlanCommitCoordinatorPort {
  const contexts = new WeakMap<object, Readonly<{ planId: string; idempotencyKey: string }>>();
  const stagedPlans = new WeakMap<object, McpStoredPlan>();
  const stagedApprovals = new WeakMap<
    object,
    Parameters<McpApprovalStorePort['markApproved']>[0]
  >();
  const transactionPlanStore: McpChangePlanCommitCoordinatorPort['planStore'] = {
    lock: async (_transaction, planId) => planStore.get(planId),
    update: async (transaction, plan) => {
      stagedPlans.set(transaction, plan);
    },
  };
  const transactionApprovalStore: McpChangePlanCommitCoordinatorPort['approvalStore'] = {
    markApproved: async (transaction, input) => {
      stagedApprovals.set(transaction, input);
    },
    beginCommit: async (_transaction, input) => approvalStore.beginCommit(input),
    finalizeCommit: async (_transaction, input) => {
      await approvalStore.finalizeCommit(input);
    },
  };

  const coordinator: McpChangePlanCommitCoordinatorPort = {
    begin: async (context) => {
      const transaction = {};
      if ('idempotencyKey' in context) contexts.set(transaction, context);
      return transaction;
    },
    planStore: Object.freeze(transactionPlanStore),
    approvalStore: Object.freeze(transactionApprovalStore),
    executor,
    commit: async (transaction) => {
      const stagedApproval = stagedApprovals.get(transaction);
      if (stagedApproval !== undefined) await approvalStore.markApproved(stagedApproval);
      const stagedPlan = stagedPlans.get(transaction);
      if (stagedPlan !== undefined) await planStore.update(stagedPlan);
    },
    rollback: async (transaction) => {
      const context = contexts.get(transaction);
      if (context !== undefined) await approvalStore.abortCommit(context);
    },
    release: async () => undefined,
  };

  return Object.freeze(coordinator);
}
