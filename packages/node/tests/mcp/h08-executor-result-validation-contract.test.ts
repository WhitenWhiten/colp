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
  principalId: 'user-executor-result',
  clientId: 'client-executor-result',
});

const operation = Object.freeze({
  type: 'set_visibility' as const,
  collectionId: 'collection-executor-result',
  baseRevision: 'acl_17',
  input: Object.freeze({ visibility: 'public' as const }),
});

type Approval = Readonly<{
  binding: McpAuthenticatedAuthorizationBinding;
  operationsDigest: string;
  consumed: boolean;
}>;

type Transaction = {
  readonly context: McpChangePlanTransactionBeginContext;
  plan: McpStoredPlan | undefined;
  stagedPlan: McpStoredPlan | undefined;
  approval: Approval | undefined;
  stagedApproval: Approval | undefined;
  stagedResult: McpPlanCommitResult | undefined;
};

type ExecutorOutputFactory = () => unknown;

function canonicalResult(sequence: number): OperationResult {
  return Object.freeze({
    opId: `op-h08-${sequence}`,
    sequence,
    status: 'applied' as const,
    revision: `revision-${sequence}`,
    cursor: `cursor-${sequence}`,
    warnings: [] as [],
  });
}

function createHarness(outputs: readonly ExecutorOutputFactory[]) {
  const plans = new Map<string, McpStoredPlan>();
  const approvals = new Map<string, Approval>();
  const results = new Map<string, McpPlanCommitResult>();
  let outputIndex = 0;
  let executeCallCount = 0;
  let locked = false;

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
      throw new Error('Approval must use the transaction-bound approval port.');
    }),
    beginCommit: vi.fn(async () => {
      throw new Error('Commit must use the transaction-bound approval port.');
    }),
    finalizeCommit: vi.fn(async () => {
      throw new Error('Commit must use the transaction-bound approval port.');
    }),
    abortCommit: vi.fn(async () => {
      throw new Error('Commit must use coordinator rollback.');
    }),
  };

  const begin: McpChangePlanCommitCoordinatorPort<Transaction>['begin'] = vi.fn(async (
    context: McpChangePlanTransactionBeginContext,
  ) => {
    if (locked) throw new Error('Commit transaction lock was not released.');
    locked = true;
    return {
      context,
      plan: undefined,
      stagedPlan: undefined,
      approval: undefined,
      stagedApproval: undefined,
      stagedResult: undefined,
    } satisfies Transaction;
  });

  const lock = vi.fn(async (transaction: Transaction, planId: string) => {
    transaction.plan = plans.get(planId);
    return transaction.plan;
  });

  const update = vi.fn(async (transaction: Transaction, plan: McpStoredPlan) => {
    transaction.stagedPlan = plan;
  });

  const markApproved = vi.fn(async (
    transaction: Transaction,
    input: Readonly<{
      planId: string;
      binding: McpAuthenticatedAuthorizationBinding;
      operationsDigest: string;
    }>,
  ) => {
    transaction.stagedApproval = Object.freeze({
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
    const replay = results.get(`${input.planId}::${input.idempotencyKey}`);
    if (replay !== undefined) {
      return Object.freeze({ status: 'already_consumed' as const, firstResult: replay });
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
    const approval = transaction.approval;
    if (approval === undefined) throw new Error('Approval was not locked.');
    transaction.stagedApproval = Object.freeze({ ...approval, consumed: true });
    transaction.stagedResult = input.result;
  });

  const execute = (
    _transaction: Transaction,
    _operations: readonly ChangePlanOperation[],
    _binding: McpAuthenticatedAuthorizationBinding,
  ): readonly OperationResult[] | Promise<readonly OperationResult[]> => {
    executeCallCount += 1;
    const factory = outputs[outputIndex];
    outputIndex += 1;
    if (factory === undefined) throw new Error('No executor output configured for this attempt.');
    return factory() as readonly OperationResult[];
  };

  const transactionCommit = vi.fn(async (transaction: Transaction) => {
    const plan = transaction.stagedPlan;
    if (plan !== undefined) plans.set(plan.planId, plan);
    const stagedApproval = transaction.stagedApproval;
    const stagedResult = transaction.stagedResult;
    if (stagedApproval !== undefined) {
      approvals.set(transaction.context.planId, stagedApproval);
    }
    if (
      stagedApproval !== undefined
      && stagedResult !== undefined
      && 'idempotencyKey' in transaction.context
    ) {
      results.set(
        `${transaction.context.planId}::${transaction.context.idempotencyKey}`,
        stagedResult,
      );
    }
  });

  const rollback = vi.fn(async (_transaction: Transaction, _cause: unknown) => undefined);
  const release = vi.fn(async (_transaction: Transaction) => {
    locked = false;
  });

  const commitCoordinator = Object.freeze({
    begin,
    planStore: Object.freeze({ lock, update }),
    approvalStore: Object.freeze({ markApproved, beginCommit, finalizeCommit }),
    executor: Object.freeze({ execute }),
    commit: transactionCommit,
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
      currentRevisions: async (_transaction, base) => ({ ...base }),
    },
    scopes: { hasScopes: async () => true },
    authorizationPolicy: { requiredScopesForOperation: async () => [] },
    rateLimit: { allow: async () => true },
    commitCoordinator,
    approvalBaseUri: 'https://host.example/approvals',
    uriPolicy: { allow: () => true },
    ids: { nextPlanId: () => 'plan_executor_result' },
    clock: { now: () => new Date('2026-07-24T08:00:00.000Z') },
  });

  const prepare = async () => {
    const plan = await service.plan({
      operations: [operation],
      reason: 'validate the executor result boundary',
      dryRun: true,
    }, binding);
    await service.recordOutOfBandApproval(plan.planId, binding);
    vi.clearAllMocks();
    return plan;
  };

  return {
    service,
    prepare,
    spies: { finalizeCommit, transactionCommit, rollback, release },
    state: {
      get executeCallCount() { return executeCallCount; },
      get approval() { return approvals.get('plan_executor_result'); },
      get plan() { return plans.get('plan_executor_result'); },
      get locked() { return locked; },
    },
  };
}

async function expectMalformedResultThenSameKeyRetry(factory: ExecutorOutputFactory) {
  const expectedRetryResult = canonicalResult(1);
  const harness = createHarness([factory, () => [expectedRetryResult]]);
  const plan = await harness.prepare();

  await expect(
    harness.service.commit(plan.planId, binding, 'idem-executor-result'),
  ).rejects.toMatchObject({ code: 'commit_failed' });

  expect(harness.spies.transactionCommit).not.toHaveBeenCalled();
  expect(harness.spies.finalizeCommit).not.toHaveBeenCalled();
  expect(harness.spies.rollback).toHaveBeenCalledTimes(1);
  expect(harness.spies.release).toHaveBeenCalledTimes(1);
  expect(harness.state.approval?.consumed).toBe(false);
  expect(harness.state.plan?.status).toBe('approved');
  expect(harness.state.locked).toBe(false);

  const retry = await harness.service.commit(plan.planId, binding, 'idem-executor-result');
  expect(retry.operations).toEqual([expectedRetryResult]);
  expect(harness.state.executeCallCount).toBe(2);
  expect(harness.spies.finalizeCommit).toHaveBeenCalledTimes(1);
  expect(harness.spies.transactionCommit).toHaveBeenCalledTimes(1);
  expect(harness.spies.release).toHaveBeenCalledTimes(2);
  expect(harness.state.approval?.consumed).toBe(true);
  expect(harness.state.plan?.status).toBe('consumed');
  expect(harness.state.locked).toBe(false);

  return harness;
}

describe('H-08 MCP Commit executor result validation contract', () => {
  it.each<readonly [string, ExecutorOutputFactory]>([
    ['undefined', () => undefined],
    ['null', () => null],
    ['a plain object instead of an array', () => ({})],
    ['a sparse result array', () => {
      const sparse = new Array<OperationResult>(2);
      sparse[1] = canonicalResult(1);
      return sparse;
    }],
    ['a Symbol value', () => [Symbol('not-json')]],
    ['a non-finite nested number', () => [{
      ...canonicalResult(1),
      transform: { score: Number.POSITIVE_INFINITY },
    }]],
    ['a cyclic value', () => {
      const transform: Record<string, unknown> = {};
      transform.self = transform;
      return [{ ...canonicalResult(1), transform }];
    }],
    ['a value beyond the snapshot depth budget', () => {
      const transform: Record<string, unknown> = {};
      let cursor = transform;
      for (let depth = 0; depth < 40; depth += 1) {
        const next: Record<string, unknown> = {};
        cursor.next = next;
        cursor = next;
      }
      return [{ ...canonicalResult(1), transform }];
    }],
    ['an operationResult that violates the canonical schema', () => [{
      opId: 'op-h08-invalid',
      sequence: 1,
      status: 'applied',
      warnings: [],
    }]],
  ])('rolls back %s, preserves Approval and approved Plan, and permits same-key retry', async (
    _label,
    factory,
  ) => {
    await expectMalformedResultThenSameKeyRetry(factory);
  });

  it('rejects accessor-backed arrays and objects without invoking getters', async () => {
    const arrayGetter = vi.fn(() => canonicalResult(1));
    const accessorArray: unknown[] = [canonicalResult(1)];
    Object.defineProperty(accessorArray, '0', {
      configurable: true,
      enumerable: true,
      get: arrayGetter,
    });
    await expectMalformedResultThenSameKeyRetry(() => accessorArray);
    expect(arrayGetter).not.toHaveBeenCalled();

    const fieldGetter = vi.fn(() => 'op-h08-accessor');
    const accessorResult = { ...canonicalResult(1) };
    Object.defineProperty(accessorResult, 'opId', {
      configurable: true,
      enumerable: true,
      get: fieldGetter,
    });
    await expectMalformedResultThenSameKeyRetry(() => [accessorResult]);
    expect(fieldGetter).not.toHaveBeenCalled();
  });

  it('rejects Proxy arrays and Proxy items without invoking traps', async () => {
    const arrayTrap = vi.fn(() => {
      throw new Error('executor result array Proxy trap executed');
    });
    const proxyArray = new Proxy([canonicalResult(1)], {
      get: arrayTrap,
      getOwnPropertyDescriptor: arrayTrap,
      getPrototypeOf: arrayTrap,
      ownKeys: arrayTrap,
    });
    await expectMalformedResultThenSameKeyRetry(() => proxyArray);
    expect(arrayTrap).not.toHaveBeenCalled();

    const itemTrap = vi.fn(() => {
      throw new Error('executor operationResult Proxy trap executed');
    });
    const proxyItem = new Proxy(canonicalResult(1), {
      get: itemTrap,
      getOwnPropertyDescriptor: itemTrap,
      getPrototypeOf: itemTrap,
      ownKeys: itemTrap,
    });
    await expectMalformedResultThenSameKeyRetry(() => [proxyItem]);
    expect(itemTrap).not.toHaveBeenCalled();
  });

  it('settles a native Promise without reading a hostile overridden then property', async () => {
    const thenGetter = vi.fn(() => {
      throw new Error('executor Promise then getter executed');
    });
    const promised = Promise.resolve([canonicalResult(1)]);
    Object.defineProperty(promised, 'then', {
      configurable: true,
      get: thenGetter,
    });
    const harness = createHarness([() => promised]);
    const plan = await harness.prepare();

    const committed = await harness.service.commit(plan.planId, binding, 'idem-native-promise');

    expect(committed.operations).toEqual([canonicalResult(1)]);
    expect(thenGetter).not.toHaveBeenCalled();
  });

  it('rejects hostile Promise constructor accessors and Proxy Promises without invoking them', async () => {
    const constructorGetter = vi.fn(() => {
      throw new Error('executor Promise constructor getter executed');
    });
    const promised = Promise.resolve([canonicalResult(1)]);
    Object.defineProperty(promised, 'constructor', {
      configurable: true,
      get: constructorGetter,
    });
    await expectMalformedResultThenSameKeyRetry(() => promised);
    expect(constructorGetter).not.toHaveBeenCalled();

    const promiseTrap = vi.fn(() => {
      throw new Error('executor Promise Proxy trap executed');
    });
    const proxyPromise = new Proxy(Promise.resolve([canonicalResult(1)]), {
      get: promiseTrap,
      getOwnPropertyDescriptor: promiseTrap,
      getPrototypeOf: promiseTrap,
    });
    await expectMalformedResultThenSameKeyRetry(() => proxyPromise);
    expect(promiseTrap).not.toHaveBeenCalled();
  });

  it('accepts an explicit empty dense array without inventing a result-count requirement', async () => {
    const harness = createHarness([() => []]);
    const plan = await harness.prepare();

    const committed = await harness.service.commit(
      plan.planId,
      binding,
      'idem-empty-executor-result',
    );

    expect(committed.operations).toEqual([]);
    expect(harness.spies.finalizeCommit).toHaveBeenCalledTimes(1);
    expect(harness.spies.transactionCommit).toHaveBeenCalledTimes(1);
    expect(harness.spies.rollback).not.toHaveBeenCalled();
    expect(harness.spies.release).toHaveBeenCalledTimes(1);
    expect(harness.state.approval?.consumed).toBe(true);
    expect(harness.state.plan?.status).toBe('consumed');
  });

  it('accepts multiple canonical operationResults without requiring one result per Plan operation', async () => {
    const first = canonicalResult(1);
    const second: OperationResult = Object.freeze({
      opId: 'op-h08-2',
      sequence: 2,
      status: 'rejected' as const,
      code: 'policy-denied',
      warnings: [] as [],
    });
    const harness = createHarness([() => [first, second]]);
    const plan = await harness.prepare();

    const committed = await harness.service.commit(
      plan.planId,
      binding,
      'idem-multiple-executor-results',
    );

    expect(committed.operations).toEqual([first, second]);
    expect(harness.state.executeCallCount).toBe(1);
    expect(harness.spies.finalizeCommit).toHaveBeenCalledTimes(1);
    expect(harness.spies.transactionCommit).toHaveBeenCalledTimes(1);
    expect(harness.spies.rollback).not.toHaveBeenCalled();
    expect(harness.spies.release).toHaveBeenCalledTimes(1);
  });
});
