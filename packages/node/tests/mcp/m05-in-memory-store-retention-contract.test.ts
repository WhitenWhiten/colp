import { describe, expect, it } from 'vitest';

import {
  MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_IDEMPOTENCY_RETENTION_MS,
  MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_APPROVALS,
  MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_COMMIT_RESULTS,
  MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_INFLIGHT,
  MCP_IN_MEMORY_PLAN_STORE_DEFAULT_MAX_PLANS,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
  McpInMemoryStoreCapacityError,
  type McpPlanCommitResult,
  type McpStoredPlan,
} from '../../src/mcp/change-plan.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

function mutableClock(initial = '2026-07-24T12:00:00.000Z') {
  let now = new Date(initial);
  return Object.freeze({
    clock: Object.freeze({ now: () => new Date(now) }),
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  });
}

function storedPlan(
  planId: string,
  expiresAt: string,
  status: McpStoredPlan['status'] = 'pending',
): McpStoredPlan {
  const plan: McpStoredPlan = {
    planId,
    expiresAt,
    risk: 'high',
    requiresApproval: true,
    approvalMethod: 'out_of_band',
    approvalUri: `https://host.example/approvals/${planId}`,
    summary: 'set_visibility affecting 1 collection',
    impact: Object.freeze({
      collections: 1,
      nodes: 0,
      annotations: 0,
      attachments: 0,
      relations: 0,
      privateFieldsExcluded: [],
    }),
    requiredScopes: Object.freeze(['access:write']),
    baseRevisions: Object.freeze({ [`access.${planId}`]: 'acl_1' }),
    operations: Object.freeze([Object.freeze({
      type: 'set_visibility',
      collectionId: planId,
      baseRevision: 'acl_1',
      input: Object.freeze({ visibility: 'public' }),
    })]),
    operationsDigest: `sha-256:digest-${planId}`,
    binding: authenticatedBinding({
      principalId: 'subject-m05',
      clientId: 'client-m05',
    }),
    untrustedNote: 'M-05 retention test',
    createdAt: '2026-07-24T12:00:00.000Z',
    status,
  };
  return Object.freeze(plan);
}

function approvalInput(planId: string) {
  return Object.freeze({
    planId,
    binding: authenticatedBinding({ principalId: 'subject-m05', clientId: 'client-m05' }),
    operationsDigest: `sha-256:digest-${planId}`,
  });
}

function beginInput(planId: string, idempotencyKey = `idem-${planId}`) {
  return Object.freeze({ ...approvalInput(planId), idempotencyKey });
}

function commitResult(planId: string, committedAt = '2026-07-24T12:00:00.000Z'): McpPlanCommitResult {
  return Object.freeze({
    planId,
    committedAt,
    operations: Object.freeze([]),
  });
}

describe('M-05 bounded in-memory Change Plan stores', () => {
  it('exposes the bounded store defaults and the observable capacity error', () => {
    expect(MCP_IN_MEMORY_PLAN_STORE_DEFAULT_MAX_PLANS).toBe(1_000);
    expect(MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_APPROVALS).toBe(1_000);
    expect(MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_COMMIT_RESULTS).toBe(1_000);
    expect(MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_MAX_INFLIGHT).toBe(100);
    expect(MCP_IN_MEMORY_APPROVAL_STORE_DEFAULT_IDEMPOTENCY_RETENTION_MS).toBe(86_400_000);
  });

  it('cleans expired Plans using the injected clock and exposes explicit deletion', async () => {
    const time = mutableClock();
    const store = createInMemoryPlanStore({ clock: time.clock, maxPlans: 2 });
    store.save(storedPlan('first', '2026-07-24T12:00:00.001Z'));
    store.save(storedPlan('second', '2026-07-24T12:00:00.002Z'));

    expect(store.stats()).toEqual({ plans: 2 });
    expect(Object.isFrozen(store.stats())).toBe(true);
    time.advance(1);
    expect(store.cleanup()).toEqual({ plans: 1 });
    expect(await store.get('first')).toBeUndefined();
    expect((await store.get('second'))?.planId).toBe('second');

    time.advance(1);
    expect(store.cleanup()).toEqual({ plans: 1 });
    expect(store.stats()).toEqual({ plans: 0 });
    expect(store.deletePlan('second')).toBe(false);

    store.save(storedPlan('deleted', '2026-07-25T12:00:00.000Z'));
    expect(store.deletePlan('deleted')).toBe(true);
    expect(store.deletePlan('deleted')).toBe(false);
  });

  it('rejects a full Plan store without silently evicting an unexpired Plan', () => {
    const time = mutableClock();
    const store = createInMemoryPlanStore({ clock: time.clock, maxPlans: 1 });
    const retained = storedPlan('retained', '2026-07-25T12:00:00.000Z');
    store.save(retained);

    expect(() => store.save(storedPlan('rejected', '2026-07-25T12:00:00.000Z')))
      .toThrowError(McpInMemoryStoreCapacityError);
    expect(() => store.save(storedPlan('rejected', '2026-07-25T12:00:00.000Z')))
      .toThrow(expect.objectContaining({
        code: 'in_memory_store_capacity_exceeded',
        store: 'plans',
        capacity: 1,
      }));
    expect(store.get('retained')).toBe(retained);
    expect(store.get('rejected')).toBeUndefined();
    expect(store.stats()).toEqual({ plans: 1 });
  });

  it('reclaims expired Plans under capacity pressure before rejecting a save', async () => {
    const time = mutableClock();
    const store = createInMemoryPlanStore({ clock: time.clock, maxPlans: 1 });
    store.save(storedPlan('expired', '2026-07-24T12:00:00.001Z'));
    time.advance(1);

    const replacement = storedPlan('replacement', '2026-07-25T12:00:00.000Z');
    expect(() => store.save(replacement)).not.toThrow();
    expect(await store.get('expired')).toBeUndefined();
    expect(await store.get('replacement')).toBe(replacement);
    expect(store.stats()).toEqual({ plans: 1 });
  });

  it('rejects a full Approval store without evicting active approval state', async () => {
    const time = mutableClock();
    const store = createInMemoryApprovalStore({
      clock: time.clock,
      maxApprovals: 1,
      maxCommitResults: 2,
      maxInflight: 2,
      idempotencyRetentionMs: 100,
    });
    store.markApproved(approvalInput('retained'));

    expect(() => store.markApproved(approvalInput('rejected')))
      .toThrow(expect.objectContaining({ store: 'approvals', capacity: 1 }));
    expect(store.stats()).toEqual({ approvals: 1, commitResults: 0, inflight: 0 });
    await expect(store.beginCommit(beginInput('retained'))).resolves.toEqual({ status: 'ready' });
    await expect(store.beginCommit(beginInput('rejected'))).resolves.toEqual({
      status: 'rejected',
      reason: 'missing',
    });
    store.abortCommit({ planId: 'retained', idempotencyKey: 'idem-retained' });
  });

  it('retains the immutable first result for replay until the configured deadline', async () => {
    const time = mutableClock();
    const store = createInMemoryApprovalStore({
      clock: time.clock,
      maxApprovals: 2,
      maxCommitResults: 1,
      maxInflight: 2,
      idempotencyRetentionMs: 100,
    });
    store.markApproved(approvalInput('first'));
    store.markApproved(approvalInput('second'));
    expect(await store.beginCommit(beginInput('first'))).toEqual({ status: 'ready' });

    const firstResult = commitResult('first');
    store.finalizeCommit({
      planId: 'first',
      idempotencyKey: 'idem-first',
      result: firstResult,
    });

    time.advance(99);
    expect(store.cleanup()).toEqual({ approvals: 0, commitResults: 0, inflight: 0 });
    const replay = await store.beginCommit(beginInput('first'));
    expect(replay).toEqual({ status: 'already_consumed', firstResult });
    expect((replay as { firstResult?: unknown }).firstResult).toBe(firstResult);

    await expect(store.beginCommit(beginInput('second')))
      .rejects.toMatchObject({ store: 'commit_results', capacity: 1 });
    expect(store.stats()).toEqual({ approvals: 2, commitResults: 1, inflight: 0 });

    time.advance(1);
    expect(store.cleanup()).toEqual({ approvals: 1, commitResults: 1, inflight: 0 });
    expect(store.stats()).toEqual({ approvals: 1, commitResults: 0, inflight: 0 });
    expect(await store.beginCommit(beginInput('first'))).toEqual({
      status: 'rejected',
      reason: 'missing',
    });
    expect(await store.beginCommit(beginInput('second'))).toEqual({ status: 'ready' });
    store.abortCommit({ planId: 'second', idempotencyKey: 'idem-second' });
  });

  it('bounds inflight claims, preserves the active leader, and reclaims aborted claims', async () => {
    const store = createInMemoryApprovalStore({
      maxApprovals: 2,
      maxCommitResults: 2,
      maxInflight: 1,
    });
    store.markApproved(approvalInput('leader'));
    store.markApproved(approvalInput('waiter'));
    expect(await store.beginCommit(beginInput('leader'))).toEqual({ status: 'ready' });

    await expect(store.beginCommit(beginInput('waiter')))
      .rejects.toMatchObject({ store: 'inflight', capacity: 1 });
    expect(store.stats()).toEqual({ approvals: 2, commitResults: 0, inflight: 1 });
    expect(await store.beginCommit(beginInput('leader', 'different-key'))).toEqual({
      status: 'rejected',
      reason: 'concurrent_lost',
    });

    store.abortCommit({ planId: 'leader', idempotencyKey: 'idem-leader' });
    expect(store.stats()).toEqual({ approvals: 2, commitResults: 0, inflight: 0 });
    expect(await store.beginCommit(beginInput('waiter'))).toEqual({ status: 'ready' });
    store.abortCommit({ planId: 'waiter', idempotencyKey: 'idem-waiter' });
    expect(store.stats().inflight).toBe(0);
  });

  it('keeps a same-key single-flight join attached to the leader at capacity', async () => {
    const store = createInMemoryApprovalStore({
      maxApprovals: 2,
      maxCommitResults: 2,
      maxInflight: 1,
    });
    store.markApproved(approvalInput('leader'));
    store.markApproved(approvalInput('other'));
    expect(await store.beginCommit(beginInput('leader'))).toEqual({ status: 'ready' });

    const joined = store.beginCommit(beginInput('leader'));
    await expect(store.beginCommit(beginInput('other')))
      .rejects.toMatchObject({ store: 'inflight', capacity: 1 });
    const firstResult = commitResult('leader');
    store.finalizeCommit({
      planId: 'leader',
      idempotencyKey: 'idem-leader',
      result: firstResult,
    });

    await expect(joined).resolves.toEqual({ status: 'already_consumed', firstResult });
    expect(store.stats()).toEqual({ approvals: 2, commitResults: 1, inflight: 0 });
  });

  it('scopes retained results to the exact Plan and idempotency key pair', async () => {
    const store = createInMemoryApprovalStore({
      maxApprovals: 2,
      maxCommitResults: 2,
      maxInflight: 2,
    });
    store.markApproved(approvalInput('plan::segment'));
    store.markApproved(approvalInput('plan'));

    expect(await store.beginCommit(beginInput('plan::segment', 'key')))
      .toEqual({ status: 'ready' });
    const firstResult = commitResult('plan::segment');
    store.finalizeCommit({
      planId: 'plan::segment',
      idempotencyKey: 'key',
      result: firstResult,
    });

    expect(await store.beginCommit(beginInput('plan', 'segment::key')))
      .toEqual({ status: 'ready' });
    store.abortCommit({ planId: 'plan', idempotencyKey: 'segment::key' });
    expect(await store.beginCommit(beginInput('plan::segment', 'key')))
      .toEqual({ status: 'already_consumed', firstResult });
  });

  it('does not leak inflight capacity when execution failure is followed by abort', async () => {
    const store = createInMemoryApprovalStore({
      maxApprovals: 1,
      maxCommitResults: 1,
      maxInflight: 1,
    });
    store.markApproved(approvalInput('failed'));
    expect(await store.beginCommit(beginInput('failed'))).toEqual({ status: 'ready' });

    const execute = async () => {
      throw new Error('injected execution failure');
    };
    await expect(execute()).rejects.toThrow('injected execution failure');
    store.abortCommit({ planId: 'failed', idempotencyKey: 'idem-failed' });

    expect(store.stats().inflight).toBe(0);
    expect(await store.beginCommit(beginInput('failed', 'idem-retry'))).toEqual({ status: 'ready' });
    store.abortCommit({ planId: 'failed', idempotencyKey: 'idem-retry' });
  });

  it('releases reserved inflight capacity when finalization itself fails', async () => {
    let failNextClockRead = false;
    const store = createInMemoryApprovalStore({
      clock: {
        now: () => {
          if (failNextClockRead) {
            failNextClockRead = false;
            throw new Error('injected finalization clock failure');
          }
          return new Date('2026-07-24T12:00:00.000Z');
        },
      },
      maxApprovals: 1,
      maxCommitResults: 1,
      maxInflight: 1,
    });
    store.markApproved(approvalInput('finalize-failure'));
    expect(await store.beginCommit(beginInput('finalize-failure'))).toEqual({ status: 'ready' });
    const joined = store.beginCommit(beginInput('finalize-failure'));

    failNextClockRead = true;
    expect(() => store.finalizeCommit({
      planId: 'finalize-failure',
      idempotencyKey: 'idem-finalize-failure',
      result: commitResult('finalize-failure'),
    })).toThrow('injected finalization clock failure');

    await expect(joined).resolves.toEqual({ status: 'ready' });
    expect(store.stats()).toEqual({ approvals: 1, commitResults: 0, inflight: 1 });
    store.abortCommit({ planId: 'finalize-failure', idempotencyKey: 'idem-finalize-failure' });
    expect(store.stats().inflight).toBe(0);
  });

  it('wakes same-key waiters after abort so exactly one can re-compete', async () => {
    const store = createInMemoryApprovalStore({
      maxApprovals: 1,
      maxCommitResults: 1,
      maxInflight: 1,
    });
    store.markApproved(approvalInput('abort-waiter'));
    expect(await store.beginCommit(beginInput('abort-waiter'))).toEqual({ status: 'ready' });
    const joined = store.beginCommit(beginInput('abort-waiter'));

    store.abortCommit({ planId: 'abort-waiter', idempotencyKey: 'idem-abort-waiter' });

    await expect(joined).resolves.toEqual({ status: 'ready' });
    expect(store.stats().inflight).toBe(1);
    store.abortCommit({ planId: 'abort-waiter', idempotencyKey: 'idem-abort-waiter' });
    expect(store.stats().inflight).toBe(0);
  });

  it('supports explicit Approval cleanup/deletion without deleting an inflight Plan', async () => {
    const store = createInMemoryApprovalStore({
      maxApprovals: 2,
      maxCommitResults: 2,
      maxInflight: 1,
    });
    store.markApproved(approvalInput('active'));
    store.markApproved(approvalInput('deleted'));
    expect(await store.beginCommit(beginInput('active'))).toEqual({ status: 'ready' });

    expect(store.deletePlan('active')).toBe(false);
    expect(await store.beginCommit(beginInput('active', 'different-key'))).toEqual({
      status: 'rejected',
      reason: 'concurrent_lost',
    });

    store.abortCommit({ planId: 'active', idempotencyKey: 'idem-active' });
    expect(await store.beginCommit(beginInput('deleted'))).toEqual({ status: 'ready' });
    store.finalizeCommit({
      planId: 'deleted',
      idempotencyKey: 'idem-deleted',
      result: commitResult('deleted'),
    });
    expect(store.stats()).toEqual({ approvals: 2, commitResults: 1, inflight: 0 });

    expect(store.deletePlan('deleted')).toBe(true);
    expect(store.deletePlan('deleted')).toBe(false);
    expect(store.stats()).toEqual({ approvals: 1, commitResults: 0, inflight: 0 });
    expect(await store.beginCommit(beginInput('deleted'))).toEqual({
      status: 'rejected',
      reason: 'missing',
    });
  });

  it('uses bounded defaults for both public in-memory stores', async () => {
    const plans = createInMemoryPlanStore();
    for (let index = 0; index < 1_000; index += 1) {
      plans.save(storedPlan(`default-plan-${index}`, '2099-01-01T00:00:00.000Z'));
    }
    expect(() => plans.save(storedPlan('default-plan-overflow', '2099-01-01T00:00:00.000Z')))
      .toThrow(expect.objectContaining({ store: 'plans', capacity: 1_000 }));
    expect(plans.stats()).toEqual({ plans: 1_000 });

    const approvals = createInMemoryApprovalStore();
    for (let index = 0; index < 1_000; index += 1) {
      approvals.markApproved(approvalInput(`default-approval-${index}`));
    }
    expect(() => approvals.markApproved(approvalInput('default-approval-overflow')))
      .toThrow(expect.objectContaining({ store: 'approvals', capacity: 1_000 }));
    expect(approvals.stats()).toEqual({ approvals: 1_000, commitResults: 0, inflight: 0 });
  });

  it('rejects option accessors and Proxies without invoking user code', () => {
    let getterCalls = 0;
    const accessorOptions = Object.defineProperty({}, 'maxPlans', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    expect(() => createInMemoryPlanStore(
      accessorOptions as Parameters<typeof createInMemoryPlanStore>[0],
    )).toThrow();
    expect(getterCalls).toBe(0);

    const optionsProxy = new Proxy({ maxPlans: 1 }, {});
    expect(() => createInMemoryPlanStore(optionsProxy)).toThrow(TypeError);
    const clockProxy = new Proxy({ now: () => new Date() }, {});
    expect(() => createInMemoryApprovalStore({ clock: clockProxy })).toThrow(TypeError);
  });

  it.each([
    ['maxPlans', () => createInMemoryPlanStore({ maxPlans: 0 })],
    ['maxApprovals', () => createInMemoryApprovalStore({ maxApprovals: -1 })],
    ['maxCommitResults', () => createInMemoryApprovalStore({ maxCommitResults: 1.5 })],
    ['maxInflight', () => createInMemoryApprovalStore({ maxInflight: Number.POSITIVE_INFINITY })],
    ['idempotencyRetentionMs', () => createInMemoryApprovalStore({ idempotencyRetentionMs: -1 })],
  ])('rejects invalid %s rather than falling back to a default', (_name, construct) => {
    expect(construct).toThrow(RangeError);
  });

  it.each([
    ['a non-Date value', { now: () => '2026-07-24T12:00:00Z' as never }, TypeError],
    ['an invalid Date', { now: () => new Date(Number.NaN) }, RangeError],
  ] as const)('fails closed when the store clock returns %s', (_case, clock, errorType) => {
    const store = createInMemoryPlanStore({ clock });
    expect(() => store.cleanup()).toThrow(errorType);
  });
});
