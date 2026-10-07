import type { Kysely } from 'kysely';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type {
  Phase4bMcpWriteApprovalPlanStorePorts,
  WriteApprovalAuditDecision,
  WriteApprovalListFilter,
} from '../../modules/mcp/index.js';
import { installPostgresTransactionCancellation } from './postgres-cancellation.js';
import { appendAuditEvent } from './audit-event-payload.js';
import {
  createPostgresMcpChangePlanStore,
  type PostgresMcpStoredPlan,
} from './mcp-change-plan-store.js';
import { createPostgresProductCommandReceiptPort } from './product-command-receipt.js';
import type { DatabaseSchema } from './runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from './unit-of-work.js';

/**
 * MCP-W07 PostgreSQL adapter.
 *
 * The W02 store already owns Plan/Approval authority; this port adds the
 * transaction boundary, Audit, and command-receipt ports needed for one exact decision.
 */
export function createPostgresMcpWriteApprovalPorts(
  db: Kysely<DatabaseSchema>,
): Phase4bMcpWriteApprovalPlanStorePorts<DatabaseTransaction> {
  const store = createPostgresMcpChangePlanStore(db);
  const ports: Phase4bMcpWriteApprovalPlanStorePorts<DatabaseTransaction> = Object.freeze({
    execute: <Result>(
      work: (transaction: DatabaseTransaction) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ) => {
      if (execution.signal !== undefined) {
        return executeAbortable(db, work, execution.signal);
      }
      return createUnitOfWork(db).execute(({ transaction }) => work(transaction));
    },
    lockPlan: (transaction: DatabaseTransaction, planId: string) =>
      store.commitPlanStore.lock(transaction, planId),
    updatePlan: (transaction: DatabaseTransaction, plan: PostgresMcpStoredPlan) =>
      store.commitPlanStore.update(transaction, plan),
    markApproved: (
      transaction: DatabaseTransaction,
      input: Readonly<{
        planId: string;
        binding: McpAuthenticatedAuthorizationBinding;
        operationsDigest: string;
      }>,
    ) =>
      store.commitApprovalStore.markApproved(transaction, input),
    createReceiptPort: (transaction: DatabaseTransaction) =>
      createPostgresProductCommandReceiptPort(transaction),
    appendAuditDecision: async (
      transaction: DatabaseTransaction,
      decision: WriteApprovalAuditDecision,
    ) => {
      await appendAuditEvent(transaction, {
        operationId: null,
        collectionId: null,
        principalId: decision.principalId,
        eventType: 'mcp.approval_decision',
        details: {
          planId: decision.planId,
          commandId: decision.commandId,
          decision: decision.decision,
          status: decision.status,
          risk: decision.risk,
          operationsDigest: decision.operationsDigest,
        },
      });
    },
    listPlans: (filter: WriteApprovalListFilter) => store.listByPrincipalIds(filter),
    getPlan: (planId: string) => store.planStore.get(planId),
  });
  return ports;
}

async function executeAbortable<Result>(
  db: Kysely<DatabaseSchema>,
  work: (transaction: DatabaseTransaction) => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  if (signal.aborted) throw signal.reason;
  return db.transaction().setIsolationLevel('read committed').execute(async (transaction) => {
    const disposeCancellation = await installPostgresTransactionCancellation(transaction, signal);
    try {
      if (signal.aborted) throw signal.reason;
      const result = await work(transaction);
      if (signal.aborted) throw signal.reason;
      return result;
    } finally {
      await disposeCancellation();
    }
  });
}
