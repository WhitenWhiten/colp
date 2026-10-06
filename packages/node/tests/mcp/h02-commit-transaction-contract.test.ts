import { describe, expect, it, vi } from 'vitest';

import {
  createChangePlanService,
  type McpApprovalBeginResult,
  type McpChangePlanCommitCoordinatorPort,
  type McpChangePlanTransactionBeginContext,
  type McpPlanCommitResult,
  type McpStoredPlan,
} from '../../src/mcp/change-plan.js';
import type { ChangePlanOperation, OperationResult } from '../../src/types/generated.js';
import { resolveFixtureBaseRevisions } from './commit-coordinator-fixture.js';
import { authenticatedBinding, type McpAuthenticatedAuthorizationBinding } from './authenticated-binding-fixture.js';

const binding = authenticatedBinding({
  principalId: 'user-transaction',
  clientId: 'client-transaction',
});

const operation = Object.freeze({
  type: 'set_visibility' as const,
  collectionId: 'collection-transaction',
  baseRevision: 'acl_17',
  input: Object.freeze({ visibility: 'public' as const }),
});

type FaultPoint = 'execute' | 'finalize' | 'plan-update' | 'commit' | 'release';

type Approval = Readonly<{
  binding: McpAuthenticatedAuthorizationBinding;
  operationsDigest: string;
  consumed: boolean;
}>;

type Transaction = {
  readonly marker: symbol;
  readonly kind: 'approval' | 'commit' | 'cancel';
  plan: McpStoredPlan | undefined;
  approval: Approval | undefined;
  firstResult: McpPlanCommitResult | undefined;
  resultKey: string | undefined;
  businessRevision: number;
};

function commitResult(revision: number): readonly OperationResult[] {
  return Object.freeze([
    Object.freeze({
      opId: 'op-transaction',
      sequence: 1,
      status: 'applied' as const,
      revision: `r_${revision}`,
      cursor: `cur_${revision}`,
      warnings: [] as [],
    }),
  ]);
}

function createHarness(initialFault?: FaultPoint) {
  const plans = new Map<string, McpStoredPlan>();
  const approvals = new Map<string, Approval>();
  const results = new Map<string, McpPlanCommitResult>();
  let businessRevision = 0;
  let locked = false;
  let fault = initialFault;
  const transactionCalls: Array<Readonly<{ participant: string; transaction: Transaction }>> = [];

  const failOnce = (point: FaultPoint): void => {
    if (fault === point) {
      fault = undefined;
      throw new Error(`injected-${point}`);
    }
  };

  const planStore = {
    save: vi.fn(async (plan: McpStoredPlan) => {
      plans.set(plan.planId, plan);
    }),
    get: vi.fn(async (planId: string) => plans.get(planId)),
    update: vi.fn(async (plan: McpStoredPlan) => {
      plans.set(plan.planId, plan);
    }),
  };

  const approvalStore = {
    markApproved: vi.fn(async () => {
      throw new Error('approval must use the transaction-bound approval port');
    }),
    beginCommit: vi.fn(async () => {
      throw new Error('commit must use the transaction-bound approval port');
    }),
    finalizeCommit: vi.fn(async () => {
      throw new Error('commit must use the transaction-bound approval port');
    }),
    abortCommit: vi.fn(async () => {
      throw new Error('commit must use coordinator rollback');
    }),
  };

  const begin = vi.fn(async (context: McpChangePlanTransactionBeginContext) => {
    if (locked) throw new Error('commit lock is still held');
    locked = true;
    return {
      marker: Symbol('commit-transaction'),
      kind: 'idempotencyKey' in context
        ? 'commit' as const
        : 'approval' in context
          ? 'approval' as const
          : 'cancel' as const,
      plan: undefined,
      approval: undefined,
      firstResult: undefined,
      resultKey: undefined,
      businessRevision,
    } satisfies Transaction;
  });

  const lock = vi.fn(async (transaction: Transaction, planId: string) => {
    transactionCalls.push({ participant: 'plan.lock', transaction });
    transaction.plan = plans.get(planId);
    return transaction.plan;
  });

  const update = vi.fn(async (transaction: Transaction, plan: McpStoredPlan) => {
    transactionCalls.push({ participant: 'plan.update', transaction });
    if (plan.status === 'consumed') failOnce('plan-update');
    transaction.plan = plan;
  });

  const markApproved = vi.fn(async (
    transaction: Transaction,
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
    }>,
  ) => {
    transactionCalls.push({ participant: 'approval.mark', transaction });
    transaction.approval = Object.freeze({
      binding: input.binding,
      operationsDigest: input.operationsDigest,
      consumed: false,
    });
  });

  const beginCommit = vi.fn(async (
    transaction: Transaction,
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
      idempotencyKey: string;
    }>,
  ): Promise<McpApprovalBeginResult> => {
    transactionCalls.push({ participant: 'approval.begin', transaction });
    const replayKey = `${input.planId}::${input.idempotencyKey}`;
    const prior = results.get(replayKey);
    if (prior !== undefined) {
      return Object.freeze({ status: 'already_consumed' as const, firstResult: prior });
    }
    const approval = approvals.get(input.planId);
    if (approval === undefined) {
      return Object.freeze({ status: 'rejected' as const, reason: 'missing' as const });
    }
    if (
      approval.binding.principalId !== input.binding.principalId
      || approval.binding.clientId !== input.binding.clientId
      || approval.binding.credentialBindingId !== input.binding.credentialBindingId
      || approval.binding.resourceAudience !== input.binding.resourceAudience
      || approval.binding.securityEpoch !== input.binding.securityEpoch
    ) {
      return Object.freeze({ status: 'rejected' as const, reason: 'binding_mismatch' as const });
    }
    if (approval.operationsDigest !== input.operationsDigest) {
      return Object.freeze({ status: 'rejected' as const, reason: 'digest_mismatch' as const });
    }
    if (approval.consumed) {
      return Object.freeze({ status: 'rejected' as const, reason: 'concurrent_lost' as const });
    }
    transaction.approval = approval;
    return Object.freeze({ status: 'ready' as const });
  });

  const finalizeCommit = vi.fn(async (
    transaction: Transaction,
    input: Readonly<{
      planId: string;
      idempotencyKey: string;
      result: McpPlanCommitResult;
    }>,
  ) => {
    transactionCalls.push({ participant: 'approval.finalize', transaction });
    failOnce('finalize');
    const approval = transaction.approval;
    if (approval === undefined) throw new Error('approval was not locked');
    transaction.approval = Object.freeze({ ...approval, consumed: true });
    transaction.firstResult = input.result;
    transaction.resultKey = `${input.planId}::${input.idempotencyKey}`;
  });

  const execute = vi.fn(async (
    transaction: Transaction,
    _operations: readonly ChangePlanOperation[],
    _binding: McpAuthenticatedAuthorizationBinding,
  ) => {
    transactionCalls.push({ participant: 'executor', transaction });
    transaction.businessRevision += 1;
    failOnce('execute');
    return commitResult(transaction.businessRevision);
  });

  const currentRevisions = vi.fn(async (
    transaction: Transaction,
    base: Readonly<Record<string, string>>,
  ) => {
    transactionCalls.push({ participant: 'revision.current', transaction });
    return Object.freeze({ ...base });
  });

  const commit = vi.fn(async (transaction: Transaction) => {
    transactionCalls.push({ participant: 'coordinator.commit', transaction });
    if (transaction.kind === 'commit') failOnce('commit');
    const plan = transaction.plan;
    if (plan === undefined) throw new Error('plan was not locked');
    if (transaction.kind === 'approval') {
      const approval = transaction.approval;
      if (approval === undefined) throw new Error('approval was not staged');
      plans.set(plan.planId, plan);
      approvals.set(plan.planId, approval);
      return;
    }
    // A matching replay is a read-only transaction: beginCommit returned the
    // already-published first result, so there is nothing new to stage.
    if (transaction.firstResult === undefined) return;
    const approval = transaction.approval;
    if (approval === undefined) throw new Error('approval was not locked');
    plans.set(plan.planId, plan);
    approvals.set(plan.planId, approval);
    const resultKey = transaction.resultKey;
    if (resultKey === undefined) throw new Error('first result has no idempotency key');
    results.set(resultKey, transaction.firstResult);
    businessRevision = transaction.businessRevision;
  });

  const rollback = vi.fn(async (transaction: Transaction) => {
    transactionCalls.push({ participant: 'coordinator.rollback', transaction });
  });

  const release = vi.fn(async (transaction: Transaction) => {
    transactionCalls.push({ participant: 'coordinator.release', transaction });
    locked = false;
    if (transaction.kind === 'commit') failOnce('release');
  });

  const commitCoordinator = Object.freeze({
    begin,
    planStore: Object.freeze({ lock, update }),
    approvalStore: Object.freeze({ markApproved, beginCommit, finalizeCommit }),
    executor: Object.freeze({ execute }),
    commit,
    rollback,
    release,
  } satisfies McpChangePlanCommitCoordinatorPort<Transaction>);

  const service = createChangePlanService({
    planStore,
    approvalStore,
    impact: { assessImpact: async () => ({
      collections: 1,
      nodes: 0,
      annotations: 0,
      attachments: 0,
      relations: 0,
      privateFieldsExcluded: [],
    }) },
    revisions: {
      resolveBaseRevisions: async (candidate) => resolveFixtureBaseRevisions(candidate),
      currentRevisions,
    },
    scopes: { hasScopes: async () => true },
    authorizationPolicy: { requiredScopesForOperation: async () => [] },
    rateLimit: { allow: async () => true },
    commitCoordinator,
    approvalBaseUri: 'https://alice.example/collections/approvals',
    uriPolicy: { allow: () => true },
    ids: { nextPlanId: () => 'plan_transaction' },
    clock: { now: () => new Date('2026-07-24T08:00:00.000Z') },
  });

  const prepare = async () => {
    const plan = await service.plan({
      operations: [operation],
      reason: 'exercise transaction boundary',
      dryRun: true,
    }, binding);
    await service.recordOutOfBandApproval(plan.planId, binding);
    vi.clearAllMocks();
    transactionCalls.length = 0;
    return plan;
  };

  return {
    service,
    prepare,
    transactionCalls,
    spies: {
      begin,
      lock,
      beginCommit,
      currentRevisions,
      execute,
      finalizeCommit,
      update,
      commit,
      rollback,
      release,
    },
    state: {
      get businessRevision() { return businessRevision; },
      get locked() { return locked; },
      get plan() { return plans.get('plan_transaction'); },
      get approval() { return approvals.get('plan_transaction'); },
      get firstResult() { return results.get('plan_transaction::idem-transaction'); },
    },
  };
}

async function expectFailureThenRetry(point: FaultPoint) {
  const harness = createHarness(point);
  const plan = await harness.prepare();

  await expect(
    harness.service.commit(plan.planId, binding, 'idem-transaction'),
  ).rejects.toMatchObject({ code: 'commit_failed' });

  expect(harness.state.businessRevision).toBe(0);
  expect(harness.state.firstResult).toBeUndefined();
  expect(harness.state.approval?.consumed).toBe(false);
  expect(harness.state.plan?.status).toBe('approved');
  expect(harness.state.locked).toBe(false);

  const retried = await harness.service.commit(plan.planId, binding, 'idem-transaction');
  expect(retried.operations[0]?.revision).toBe('r_1');
  expect(harness.state.businessRevision).toBe(1);
  expect(harness.state.firstResult).toEqual(retried);
  expect(harness.state.approval?.consumed).toBe(true);
  expect(harness.state.plan?.status).toBe('consumed');
  expect(harness.state.locked).toBe(false);
  return harness;
}

describe('H-02 MCP Commit transaction contract', () => {
  it('passes one transaction handle to the locked plan, approval, executor, result, and plan update ports', async () => {
    const harness = createHarness();
    const plan = await harness.prepare();

    await harness.service.commit(plan.planId, binding, 'idem-transaction');

    const calls = harness.transactionCalls;
    expect(calls.map(({ participant }) => participant)).toEqual([
      'plan.lock',
      'approval.begin',
      'plan.update',
      'revision.current',
      'executor',
      'approval.finalize',
      'plan.update',
      'coordinator.commit',
      'coordinator.release',
    ]);
    const transaction = calls[0]?.transaction;
    expect(transaction).toBeDefined();
    for (const call of calls) expect(call.transaction).toBe(transaction);
  });

  it('publishes the business state and first result together, then replays without executing again', async () => {
    const harness = createHarness();
    const plan = await harness.prepare();

    const first = await harness.service.commit(plan.planId, binding, 'idem-transaction');
    expect(harness.state.businessRevision).toBe(1);
    expect(harness.state.firstResult).toEqual(first);
    expect(harness.state.approval?.consumed).toBe(true);
    expect(harness.state.plan?.status).toBe('consumed');

    const replay = await harness.service.commit(plan.planId, binding, 'idem-transaction');
    expect(replay).toEqual(first);
    expect(harness.spies.execute).toHaveBeenCalledTimes(1);
    expect(harness.state.businessRevision).toBe(1);
  });

  it('rolls back an executed business change when transaction-bound approval finalization fails and permits retry', async () => {
    const harness = await expectFailureThenRetry('finalize');
    expect(harness.spies.execute).toHaveBeenCalledTimes(2);
    expect(harness.spies.rollback).toHaveBeenCalledTimes(1);
    expect(harness.spies.release).toHaveBeenCalledTimes(2);
  });

  it('rolls back staged approval and first result when the transaction-bound plan update fails and permits retry', async () => {
    const harness = await expectFailureThenRetry('plan-update');
    expect(harness.spies.finalizeCommit).toHaveBeenCalledTimes(2);
    expect(harness.spies.rollback).toHaveBeenCalledTimes(1);
    expect(harness.spies.release).toHaveBeenCalledTimes(2);
  });

  it('does not publish staged business or first-result state when transaction commit rejects and permits retry', async () => {
    const harness = await expectFailureThenRetry('commit');
    expect(harness.spies.commit).toHaveBeenCalledTimes(2);
    expect(harness.spies.rollback).toHaveBeenCalledTimes(1);
    expect(harness.spies.release).toHaveBeenCalledTimes(2);
  });

  it('releases the commit lock even when rollback rejects, so a later attempt can compete', async () => {
    const harness = createHarness('execute');
    const plan = await harness.prepare();
    // Make rollback itself fail after execute has failed.
    const rollback = harness.spies.rollback;
    rollback.mockImplementationOnce(async (transaction: Transaction) => {
      harness.transactionCalls.push({ participant: 'coordinator.rollback', transaction });
      throw new Error('injected-rollback');
    });

    await expect(
      harness.service.commit(plan.planId, binding, 'idem-transaction'),
    ).rejects.toMatchObject({ code: 'commit_failed' });
    expect(harness.state.businessRevision).toBe(0);
    expect(harness.state.firstResult).toBeUndefined();
    expect(harness.state.locked).toBe(false);

    const retried = await harness.service.commit(plan.planId, binding, 'idem-transaction');
    expect(retried.operations[0]?.revision).toBe('r_1');
    expect(harness.state.businessRevision).toBe(1);
    expect(harness.spies.release).toHaveBeenCalledTimes(2);
  });

  it('fails closed when release reports an error, while a same-key retry replays the committed result', async () => {
    const harness = createHarness('release');
    const plan = await harness.prepare();

    await expect(
      harness.service.commit(plan.planId, binding, 'idem-transaction'),
    ).rejects.toMatchObject({ code: 'commit_failed' });
    expect(harness.state.locked).toBe(false);
    expect(harness.state.businessRevision).toBe(1);
    expect(harness.state.firstResult).toBeDefined();

    const replay = await harness.service.commit(plan.planId, binding, 'idem-transaction');
    expect(replay).toEqual(harness.state.firstResult);
    expect(harness.spies.execute).toHaveBeenCalledTimes(1);
    expect(harness.spies.release).toHaveBeenCalledTimes(2);
  });
});
