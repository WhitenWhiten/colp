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
  principalId: 'user-cancel-race',
  clientId: 'client-cancel-race',
});

const operation = Object.freeze({
  type: 'set_visibility' as const,
  collectionId: 'collection-cancel-race',
  baseRevision: 'acl_17',
  input: Object.freeze({ visibility: 'public' as const }),
});

type PausePoint = 'scopes' | 'revisions' | 'impact' | 'rate-limit';

type Approval = Readonly<{
  binding: McpAuthenticatedAuthorizationBinding;
  operationsDigest: string;
  consumed: boolean;
}>;

type Transaction = {
  readonly kind: 'approval' | 'commit' | 'cancel';
  plan: McpStoredPlan | undefined;
  approval: Approval | undefined;
  approvalDirty: boolean;
  firstResult: McpPlanCommitResult | undefined;
  resultKey: string | undefined;
  businessRevision: number;
};

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return Object.freeze({ promise, resolve });
}

function commitResult(revision: number): readonly OperationResult[] {
  return Object.freeze([
    Object.freeze({
      opId: 'op-cancel-race',
      sequence: 1,
      status: 'applied' as const,
      revision: `r_${revision}`,
      cursor: `cur_${revision}`,
      warnings: [] as [],
    }),
  ]);
}

function createHarness(options: Readonly<{
  pauseCommitAt?: PausePoint;
  pauseApprovalAfterLock?: boolean;
  pauseCancelAfterLock?: boolean;
  failApprovalCommitOnce?: boolean;
  failApprovalRollbackOnce?: boolean;
  failApprovalReleaseOnce?: boolean;
  failExecuteOnce?: boolean;
}> = {}) {
  const plans = new Map<string, McpStoredPlan>();
  const approvals = new Map<string, Approval>();
  const results = new Map<string, McpPlanCommitResult>();
  const pauseEntered = deferred();
  const resumePause = deferred();
  const commitAttempted = deferred();
  const cancelAttempted = deferred();
  const transactionUpdates: Array<Readonly<{
    transaction: Transaction;
    status: McpStoredPlan['status'];
  }>> = [];
  const waiters: Array<() => void> = [];
  let locked = false;
  let activeTransaction: Transaction | undefined;
  let businessRevision = 0;
  let impactCalls = 0;
  let shouldFailExecute = options.failExecuteOnce === true;
  let shouldFailApprovalCommit = options.failApprovalCommitOnce === true;
  let shouldFailApprovalRollback = options.failApprovalRollbackOnce === true;
  let shouldFailApprovalRelease = options.failApprovalReleaseOnce === true;

  const acquire = async (): Promise<void> => {
    if (!locked) {
      locked = true;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };

  const releaseMutex = (): void => {
    const next = waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    locked = false;
  };

  const pause = async (point: PausePoint): Promise<void> => {
    if (options.pauseCommitAt !== point) return;
    pauseEntered.resolve();
    await resumePause.promise;
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
    const kind = 'idempotencyKey' in context
      ? 'commit'
      : 'approval' in context
        ? 'approval'
        : 'cancel';
    if (kind === 'commit') commitAttempted.resolve();
    else if (kind === 'cancel') cancelAttempted.resolve();
    await acquire();
    const transaction: Transaction = {
      kind,
      plan: undefined,
      approval: undefined,
      approvalDirty: false,
      firstResult: undefined,
      resultKey: undefined,
      businessRevision,
    };
    activeTransaction = transaction;
    return transaction;
  });

  const lock = vi.fn(async (transaction: Transaction, planId: string) => {
    if (
      (transaction.kind === 'approval' && options.pauseApprovalAfterLock === true)
      || (transaction.kind === 'cancel' && options.pauseCancelAfterLock === true)
    ) {
      pauseEntered.resolve();
      await resumePause.promise;
    }
    transaction.plan = plans.get(planId);
    return transaction.plan;
  });

  const update = vi.fn(async (transaction: Transaction, plan: McpStoredPlan) => {
    transaction.plan = plan;
    transactionUpdates.push(Object.freeze({ transaction, status: plan.status }));
  });

  const markApproved: McpChangePlanCommitCoordinatorPort<Transaction>['approvalStore']['markApproved'] =
    vi.fn(async (transaction, input) => {
      transaction.approval = Object.freeze({
        binding: input.binding,
        operationsDigest: input.operationsDigest,
        consumed: false,
      });
      transaction.approvalDirty = true;
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
    const approval = transaction.approval;
    if (approval === undefined) throw new Error('Approval was not locked.');
    transaction.approval = Object.freeze({ ...approval, consumed: true });
    transaction.approvalDirty = true;
    transaction.firstResult = input.result;
    transaction.resultKey = `${input.planId}::${input.idempotencyKey}`;
  });

  const execute = vi.fn(async (
    transaction: Transaction,
    _operations: readonly ChangePlanOperation[],
    _binding: McpAuthenticatedAuthorizationBinding,
  ) => {
    transaction.businessRevision += 1;
    if (shouldFailExecute) {
      shouldFailExecute = false;
      throw new Error('injected-execute');
    }
    return commitResult(transaction.businessRevision);
  });

  const transactionCommit = vi.fn(async (transaction: Transaction) => {
    if (transaction.kind === 'approval' && shouldFailApprovalCommit) {
      shouldFailApprovalCommit = false;
      throw new Error('injected-approval-commit');
    }
    const plan = transaction.plan;
    if (plan === undefined) throw new Error('Plan was not locked.');
    plans.set(plan.planId, plan);
    if (transaction.approvalDirty) {
      const approval = transaction.approval;
      if (approval === undefined) throw new Error('Approval was not locked.');
      approvals.set(plan.planId, approval);
      if (transaction.firstResult === undefined) return;
      const resultKey = transaction.resultKey;
      const firstResult = transaction.firstResult;
      if (resultKey === undefined || firstResult === undefined) {
        throw new Error('First result was not staged.');
      }
      results.set(resultKey, firstResult);
      businessRevision = transaction.businessRevision;
    }
  });

  const rollback = vi.fn(async (transaction: Transaction) => {
    if (transaction.kind === 'approval' && shouldFailApprovalRollback) {
      shouldFailApprovalRollback = false;
      throw new Error('injected-approval-rollback');
    }
  });
  const release = vi.fn(async (transaction: Transaction) => {
    if (activeTransaction === transaction) activeTransaction = undefined;
    releaseMutex();
    if (transaction.kind === 'approval' && shouldFailApprovalRelease) {
      shouldFailApprovalRelease = false;
      throw new Error('injected-approval-release');
    }
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
    impact: {
      assessImpact: async () => {
        impactCalls += 1;
        if (impactCalls > 1) await pause('impact');
        return {
          collections: 1,
          nodes: 0,
          annotations: 0,
          attachments: 0,
          relations: 0,
          privateFieldsExcluded: [],
        };
      },
    },
    revisions: {
      resolveBaseRevisions: async (candidate) => resolveFixtureBaseRevisions(candidate),
      currentRevisions: async (_transaction, base) => {
        await pause('revisions');
        return { ...base };
      },
    },
    scopes: {
      hasScopes: async () => {
        await pause('scopes');
        return true;
      },
    },
    authorizationPolicy: { requiredScopesForOperation: async () => [] },
    rateLimit: {
      allowPlan: async () => true,
      allow: async () => {
        await pause('rate-limit');
        return true;
      },
    },
    commitCoordinator,
    approvalBaseUri: 'https://alice.example/collections/approvals',
    uriPolicy: { allow: () => true },
    ids: { nextPlanId: () => 'plan_cancel_race' },
    clock: { now: () => new Date('2026-07-24T08:00:00.000Z') },
  });

  const prepare = async () => {
    const plan = await preparePending();
    await service.recordOutOfBandApproval(plan.planId, binding);
    vi.clearAllMocks();
    transactionUpdates.length = 0;
    return plan;
  };

  const preparePending = async () => {
    return service.plan({
      operations: [operation],
      reason: 'exercise Commit and Cancel transaction race',
      dryRun: true,
    }, binding);
  };

  const setStatus = (status: McpStoredPlan['status']): void => {
    const plan = plans.get('plan_cancel_race');
    if (plan === undefined) throw new Error('Plan is not prepared.');
    plans.set(plan.planId, Object.freeze({ ...plan, status }));
  };

  return {
    service,
    prepare,
    preparePending,
    setStatus,
    controls: {
      pauseEntered: pauseEntered.promise,
      resumePause: resumePause.resolve,
      commitAttempted: commitAttempted.promise,
      cancelAttempted: cancelAttempted.promise,
    },
    spies: {
      begin,
      lock,
      update,
      markApproved,
      beginCommit,
      execute,
      transactionCommit,
      rollback,
      release,
    },
    state: {
      get plan() { return plans.get('plan_cancel_race'); },
      get approval() { return approvals.get('plan_cancel_race'); },
      get activePlanStatus() { return activeTransaction?.plan?.status; },
      get businessRevision() { return businessRevision; },
      get locked() { return locked; },
      get transactionUpdates() { return [...transactionUpdates]; },
    },
  };
}

describe('H-03 MCP Commit and Cancel transaction state machine', () => {
  it('lets Approval win the transaction lock before a queued Cancel transitions approved to cancelled', async () => {
    const harness = createHarness({ pauseApprovalAfterLock: true });
    const plan = await harness.preparePending();

    const approving = harness.service.recordOutOfBandApproval(plan.planId, binding);
    await harness.controls.pauseEntered;
    const cancelling = harness.service.cancel(plan.planId, binding);
    await harness.controls.cancelAttempted;

    expect(harness.state.plan?.status).toBe('pending');
    expect(harness.spies.markApproved).not.toHaveBeenCalled();
    harness.controls.resumePause();
    await expect(approving).resolves.toBeUndefined();
    await expect(cancelling).resolves.toEqual({
      planId: plan.planId,
      status: 'cancelled',
    });

    expect(harness.spies.markApproved).toHaveBeenCalledOnce();
    expect(harness.state.plan?.status).toBe('cancelled');
    expect(harness.spies.execute).not.toHaveBeenCalled();
    expect(harness.state.businessRevision).toBe(0);
    expect(harness.state.locked).toBe(false);
  });

  it('lets a lock-owning Cancel reject a queued Approval without reviving the cancelled Plan', async () => {
    const harness = createHarness({ pauseCancelAfterLock: true });
    const plan = await harness.preparePending();

    const cancelling = harness.service.cancel(plan.planId, binding);
    await harness.controls.pauseEntered;
    let approvalSettled = false;
    const approving = harness.service.recordOutOfBandApproval(plan.planId, binding).then(
      () => Object.freeze({ status: 'fulfilled' as const }),
      (error: unknown) => Object.freeze({ status: 'rejected' as const, error }),
    ).finally(() => {
      approvalSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const approvalSettledBeforeCancel = approvalSettled;
    const statusBeforeCancel = harness.state.plan?.status;
    harness.controls.resumePause();
    await expect(cancelling).resolves.toEqual({
      planId: plan.planId,
      status: 'cancelled',
    });
    const approvalOutcome = await approving;

    expect(approvalSettledBeforeCancel).toBe(false);
    expect(statusBeforeCancel).toBe('pending');
    expect(approvalOutcome).toMatchObject({
      status: 'rejected',
      error: { code: 'plan_cancelled' },
    });
    expect(harness.state.plan?.status).toBe('cancelled');
    expect(harness.spies.execute).not.toHaveBeenCalled();
    expect(harness.state.businessRevision).toBe(0);
    expect(harness.state.locked).toBe(false);
  });

  it.each([
    ['cancelled', 'plan_cancelled'],
    ['committing', 'plan_already_consumed'],
    ['consumed', 'plan_already_consumed'],
    ['expired', 'plan_expired'],
  ] as const)(
    'rejects Approval for a %s Plan before staging any Approval or Plan update',
    async (status, code) => {
      const harness = createHarness();
      const plan = await harness.prepare();
      harness.setStatus(status);

      await expect(
        harness.service.recordOutOfBandApproval(plan.planId, binding),
      ).rejects.toMatchObject({ code });

      expect(harness.state.plan?.status).toBe(status);
      expect(harness.spies.markApproved).not.toHaveBeenCalled();
      expect(harness.spies.update).not.toHaveBeenCalled();
      expect(harness.spies.transactionCommit).not.toHaveBeenCalled();
      expect(harness.spies.rollback).toHaveBeenCalledOnce();
      expect(harness.spies.release).toHaveBeenCalledOnce();
      expect(harness.state.locked).toBe(false);
    },
  );

  it('rejects duplicate Approval because only pending to approved is permitted', async () => {
    const harness = createHarness();
    const plan = await harness.prepare();

    await expect(
      harness.service.recordOutOfBandApproval(plan.planId, binding),
    ).rejects.toMatchObject({ code: 'commit_failed' });

    expect(harness.state.plan?.status).toBe('approved');
    expect(harness.spies.markApproved).not.toHaveBeenCalled();
    expect(harness.spies.update).not.toHaveBeenCalled();
    expect(harness.spies.transactionCommit).not.toHaveBeenCalled();
    expect(harness.spies.rollback).toHaveBeenCalledOnce();
    expect(harness.spies.release).toHaveBeenCalledOnce();
    expect(harness.state.locked).toBe(false);
  });

  it('rolls back Approval and the Plan transition together when transaction commit fails', async () => {
    const harness = createHarness({ failApprovalCommitOnce: true });
    const plan = await harness.preparePending();

    await expect(
      harness.service.recordOutOfBandApproval(plan.planId, binding),
    ).rejects.toMatchObject({ code: 'commit_failed' });
    expect(harness.state.plan?.status).toBe('pending');
    expect(harness.state.approval).toBeUndefined();
    expect(harness.spies.rollback).toHaveBeenCalledOnce();
    expect(harness.spies.release).toHaveBeenCalledOnce();
    expect(harness.state.locked).toBe(false);

    await expect(
      harness.service.recordOutOfBandApproval(plan.planId, binding),
    ).resolves.toBeUndefined();
    expect(harness.state.plan?.status).toBe('approved');
    expect(harness.state.approval?.consumed).toBe(false);
    expect(harness.state.locked).toBe(false);
  });

  it.each([
    ['rollback', { failApprovalCommitOnce: true, failApprovalRollbackOnce: true }, 'pending'],
    ['release', { failApprovalReleaseOnce: true }, 'approved'],
  ] as const)(
    'fails Approval closed when transaction %s fails',
    async (_failure, options, expectedStatus) => {
      const harness = createHarness(options);
      const plan = await harness.preparePending();

      await expect(
        harness.service.recordOutOfBandApproval(plan.planId, binding),
      ).rejects.toMatchObject({ code: 'commit_failed' });

      expect(harness.state.plan?.status).toBe(expectedStatus);
      expect(harness.spies.release).toHaveBeenCalledOnce();
      expect(harness.state.locked).toBe(false);
    },
  );

  it.each([
    'scopes',
    'revisions',
    'impact',
    'rate-limit',
  ] as const)(
    'rejects Cancel while Commit is paused at the %s await inside the committing transaction',
    async (pausePoint) => {
      const harness = createHarness({ pauseCommitAt: pausePoint });
      const plan = await harness.prepare();

      const committing = harness.service.commit(plan.planId, binding, 'idem-cancel-race');
      await harness.controls.pauseEntered;
      expect(harness.state.activePlanStatus).toBe('committing');

      let cancelSettled = false;
      const cancelling = harness.service.cancel(plan.planId, binding).finally(() => {
        cancelSettled = true;
      });
      const firstCancelEvent = await Promise.race([
        harness.controls.cancelAttempted.then(() => 'transaction-attempted' as const),
        cancelling.then(
          () => 'cancel-settled' as const,
          () => 'cancel-settled' as const,
        ),
      ]);
      await Promise.resolve();

      expect(firstCancelEvent).toBe('transaction-attempted');
      expect(cancelSettled).toBe(false);
      expect(harness.state.plan?.status).toBe('approved');
      expect(harness.spies.execute).not.toHaveBeenCalled();

      const cancellationExpectation = expect(cancelling).rejects.toMatchObject({
        code: 'plan_already_consumed',
      });
      harness.controls.resumePause();
      await expect(committing).resolves.toMatchObject({ planId: plan.planId });
      await cancellationExpectation;

      expect(harness.state.plan?.status).toBe('consumed');
      expect(harness.state.businessRevision).toBe(1);
      expect(harness.spies.execute).toHaveBeenCalledTimes(1);
      const updates = harness.state.transactionUpdates;
      expect(updates.map(({ status }) => status)).toEqual([
        'committing',
        'consumed',
      ]);
      expect(updates[0]?.transaction).toBe(updates[1]?.transaction);
      expect(harness.spies.begin).toHaveBeenCalledTimes(2);
      expect(harness.spies.lock).toHaveBeenCalledTimes(2);
      expect(harness.spies.transactionCommit).toHaveBeenCalledTimes(1);
      expect(harness.state.locked).toBe(false);
    },
  );

  it('lets Cancel win the transaction lock and prevents the queued Commit from executing', async () => {
    const harness = createHarness({ pauseCancelAfterLock: true });
    const plan = await harness.prepare();

    const cancelling = harness.service.cancel(plan.planId, binding);
    await harness.controls.pauseEntered;
    const committing = harness.service.commit(plan.planId, binding, 'idem-cancel-first');
    await harness.controls.commitAttempted;

    expect(harness.state.locked).toBe(true);
    expect(harness.spies.execute).not.toHaveBeenCalled();

    const commitExpectation = expect(committing).rejects.toMatchObject({ code: 'plan_cancelled' });
    harness.controls.resumePause();
    await expect(cancelling).resolves.toEqual({ planId: plan.planId, status: 'cancelled' });
    await commitExpectation;

    expect(harness.state.plan?.status).toBe('cancelled');
    expect(harness.state.businessRevision).toBe(0);
    expect(harness.spies.execute).not.toHaveBeenCalled();
    expect(harness.state.transactionUpdates.map(({ status }) => status)).toEqual(['cancelled']);
    expect(harness.spies.begin).toHaveBeenCalledTimes(2);
    expect(harness.spies.lock).toHaveBeenCalledTimes(2);
    expect(harness.spies.transactionCommit).toHaveBeenCalledTimes(1);
    expect(harness.state.locked).toBe(false);
  });

  it.each(['committing', 'consumed'] as const)(
    'does not overwrite a %s Plan with cancelled',
    async (status) => {
      const harness = createHarness();
      const plan = await harness.prepare();
      harness.setStatus(status);

      await expect(harness.service.cancel(plan.planId, binding)).rejects.toMatchObject({
        code: 'plan_already_consumed',
      });

      expect(harness.state.plan?.status).toBe(status);
      expect(harness.spies.update).not.toHaveBeenCalled();
      expect(harness.spies.transactionCommit).not.toHaveBeenCalled();
      expect(harness.spies.rollback).toHaveBeenCalledTimes(1);
      expect(harness.spies.release).toHaveBeenCalledTimes(1);
      expect(harness.state.locked).toBe(false);
    },
  );

  it('rolls committing back to approved after execute failure, then permits Cancel', async () => {
    const harness = createHarness({ failExecuteOnce: true });
    const plan = await harness.prepare();

    await expect(
      harness.service.commit(plan.planId, binding, 'idem-fail-then-cancel'),
    ).rejects.toMatchObject({ code: 'commit_failed' });
    expect(harness.state.plan?.status).toBe('approved');
    expect(harness.state.businessRevision).toBe(0);

    await expect(harness.service.cancel(plan.planId, binding)).resolves.toEqual({
      planId: plan.planId,
      status: 'cancelled',
    });
    expect(harness.state.plan?.status).toBe('cancelled');
    expect(harness.spies.rollback).toHaveBeenCalledTimes(1);
    expect(harness.state.locked).toBe(false);
  });

  it('rolls committing back to approved after execute failure, then permits Commit retry', async () => {
    const harness = createHarness({ failExecuteOnce: true });
    const plan = await harness.prepare();

    await expect(
      harness.service.commit(plan.planId, binding, 'idem-fail-then-retry'),
    ).rejects.toMatchObject({ code: 'commit_failed' });
    expect(harness.state.plan?.status).toBe('approved');

    await expect(
      harness.service.commit(plan.planId, binding, 'idem-fail-then-retry'),
    ).resolves.toMatchObject({ planId: plan.planId });
    expect(harness.state.plan?.status).toBe('consumed');
    expect(harness.state.businessRevision).toBe(1);
    expect(harness.spies.execute).toHaveBeenCalledTimes(2);
    expect(harness.spies.rollback).toHaveBeenCalledTimes(1);
    expect(harness.state.locked).toBe(false);
  });
});
