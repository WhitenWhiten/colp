import { describe, expect, it } from 'vitest';

import type {
  McpChangePlanService,
  McpPlanCommitResult,
} from '../../src/mcp/change-plan.js';
import type { McpAuthenticatedAuthorizationBinding } from '../../src/mcp/shared/authorization.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

export const durableCommitBinding: McpAuthenticatedAuthorizationBinding = authenticatedBinding({
  principalId: 'user-durable-host',
  clientId: 'client-durable-host',
});

export const durableCommitOperation = Object.freeze({
  type: 'set_visibility' as const,
  collectionId: 'collection-durable-host',
  baseRevision: 'acl_17',
  input: Object.freeze({ visibility: 'public' as const }),
});

export type DurableCommitHostFault =
  | 'commit_before_publish'
  | 'connection_interrupted_after_commit'
  | 'rollback';

export type DurableCommitHostObservation = Readonly<{
  planStatus: 'pending' | 'approved' | 'committing' | 'consumed' | 'cancelled' | 'expired';
  approvalConsumed: boolean;
  businessState: Readonly<{ visibility: string; revision: string }>;
  firstResult: McpPlanCommitResult | undefined;
  lockHeld: boolean;
}>;

export type DurableCommitHostInstance = Readonly<{
  service: McpChangePlanService;
  /** Identity of this process/connection's ordinary Plan store handle. */
  planStoreHandle: object;
  /** Identity of this process/connection's ordinary Approval store handle. */
  approvalStoreHandle: object;
  /** Identity of this process/connection's transaction coordinator handle. */
  coordinatorHandle: object;
}>;

export interface DurableCommitHostDriver {
  createHost(): DurableCommitHostInstance | PromiseLike<DurableCommitHostInstance>;
  injectFaults(...faults: readonly DurableCommitHostFault[]): void;
  observe(
    planId: string,
    idempotencyKey: string,
  ): DurableCommitHostObservation | PromiseLike<DurableCommitHostObservation>;
  readonly executeAttempts: number;
  readonly rollbackAttempts: number;
}

export type DurableCommitHostConformanceFactory = Readonly<{
  name: string;
  createDriver(): DurableCommitHostDriver | PromiseLike<DurableCommitHostDriver>;
}>;

async function prepare(host: DurableCommitHostInstance): Promise<string> {
  const plan = await host.service.plan({
    operations: [durableCommitOperation],
    reason: 'exercise the durable host adapter transaction boundary',
    dryRun: true,
  }, durableCommitBinding);
  await host.service.recordOutOfBandApproval(plan.planId, durableCommitBinding);
  return plan.planId;
}

function expectUncommitted(observation: DurableCommitHostObservation): void {
  expect(observation).toMatchObject({
    planStatus: 'approved',
    approvalConsumed: false,
    businessState: { visibility: 'private', revision: 'acl_17' },
    lockHeld: false,
  });
  expect(observation.firstResult).toBeUndefined();
}

function expectCommitted(
  observation: DurableCommitHostObservation,
  result: McpPlanCommitResult,
): void {
  expect(observation).toMatchObject({
    planStatus: 'consumed',
    approvalConsumed: true,
    businessState: { visibility: 'public', revision: 'acl_18' },
    lockHeld: false,
  });
  expect(observation.firstResult).toEqual(result);
}

/**
 * Registers the durable Change Plan Commit host-adapter contract.
 *
 * A real database/coordinator adapter is expected to invoke this same suite
 * from its integration-test package. Passing it with the shared-persistence
 * simulator in this repository demonstrates the required black-box behavior
 * and provides an executable host contract; it is not evidence that a
 * production adapter or physical storage engine is durable.
 */
export function defineDurableCommitHostConformance(
  factory: DurableCommitHostConformanceFactory,
): void {
  describe(`T-03 durable Commit host conformance: ${factory.name}`, () => {
    it('atomically recovers business state, Approval, Plan, and firstResult after rebuilding every host handle', async () => {
      const driver = await factory.createDriver();
      const firstHost = await driver.createHost();
      const planId = await prepare(firstHost);
      const firstResult = await firstHost.service.commit(planId, durableCommitBinding, 'idem-durable');

      expectCommitted(await driver.observe(planId, 'idem-durable'), firstResult);
      expect(driver.executeAttempts).toBe(1);

      const rebuiltHost = await driver.createHost();
      expect(rebuiltHost.service).not.toBe(firstHost.service);
      expect(rebuiltHost.planStoreHandle).not.toBe(firstHost.planStoreHandle);
      expect(rebuiltHost.approvalStoreHandle).not.toBe(firstHost.approvalStoreHandle);
      expect(rebuiltHost.coordinatorHandle).not.toBe(firstHost.coordinatorHandle);

      await expect(
        rebuiltHost.service.commit(planId, durableCommitBinding, 'idem-durable'),
      ).resolves.toEqual(firstResult);
      expect(driver.executeAttempts).toBe(1);
      await expect(
        rebuiltHost.service.commit(planId, durableCommitBinding, 'idem-other'),
      ).rejects.toMatchObject({ code: 'plan_already_consumed' });
      expect(driver.executeAttempts).toBe(1);
      expectCommitted(await driver.observe(planId, 'idem-durable'), firstResult);
    });

    it('serializes two independent store/service instances competing with the same key', async () => {
      const driver = await factory.createDriver();
      const firstHost = await driver.createHost();
      const secondHost = await driver.createHost();
      expect(secondHost.service).not.toBe(firstHost.service);
      expect(secondHost.planStoreHandle).not.toBe(firstHost.planStoreHandle);
      expect(secondHost.approvalStoreHandle).not.toBe(firstHost.approvalStoreHandle);
      expect(secondHost.coordinatorHandle).not.toBe(firstHost.coordinatorHandle);
      const planId = await prepare(firstHost);

      const results = await Promise.all([
        firstHost.service.commit(planId, durableCommitBinding, 'idem-shared'),
        secondHost.service.commit(planId, durableCommitBinding, 'idem-shared'),
      ]);

      expect(results[1]).toEqual(results[0]);
      expect(driver.executeAttempts).toBe(1);
      expectCommitted(await driver.observe(planId, 'idem-shared'), results[0]!);
    });

    it('allows one winner when two independent instances compete with different keys', async () => {
      const driver = await factory.createDriver();
      const firstHost = await driver.createHost();
      const secondHost = await driver.createHost();
      const planId = await prepare(firstHost);

      const outcomes = await Promise.allSettled([
        firstHost.service.commit(planId, durableCommitBinding, 'idem-first'),
        secondHost.service.commit(planId, durableCommitBinding, 'idem-second'),
      ]);

      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<McpPlanCommitResult> => outcome.status === 'fulfilled',
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: 'plan_already_consumed' });
      expect(driver.executeAttempts).toBe(1);

      const winningKey = outcomes[0]?.status === 'fulfilled' ? 'idem-first' : 'idem-second';
      const losingKey = winningKey === 'idem-first' ? 'idem-second' : 'idem-first';
      expectCommitted(await driver.observe(planId, winningKey), fulfilled[0]!.value);
      expect((await driver.observe(planId, losingKey)).firstResult).toBeUndefined();
    });

    it('publishes nothing when execute succeeds but transaction commit fails, then permits a rebuilt retry', async () => {
      const driver = await factory.createDriver();
      const firstHost = await driver.createHost();
      const planId = await prepare(firstHost);
      driver.injectFaults('commit_before_publish');

      await expect(
        firstHost.service.commit(planId, durableCommitBinding, 'idem-commit-failure'),
      ).rejects.toMatchObject({ code: 'commit_failed' });
      expect(driver.executeAttempts).toBe(1);
      expectUncommitted(await driver.observe(planId, 'idem-commit-failure'));

      const rebuiltHost = await driver.createHost();
      const retried = await rebuiltHost.service.commit(
        planId,
        durableCommitBinding,
        'idem-commit-failure',
      );
      expect(driver.executeAttempts).toBe(2);
      expectCommitted(await driver.observe(planId, 'idem-commit-failure'), retried);
    });

    it('recovers the committed first result after the connection is interrupted before acknowledgement', async () => {
      const driver = await factory.createDriver();
      const firstHost = await driver.createHost();
      const planId = await prepare(firstHost);
      driver.injectFaults('connection_interrupted_after_commit');

      await expect(
        firstHost.service.commit(planId, durableCommitBinding, 'idem-unknown-outcome'),
      ).rejects.toMatchObject({ code: 'commit_failed' });
      const recovered = await driver.observe(planId, 'idem-unknown-outcome');
      expect(recovered.firstResult).toBeDefined();
      expectCommitted(recovered, recovered.firstResult!);
      expect(driver.executeAttempts).toBe(1);

      const rebuiltHost = await driver.createHost();
      await expect(
        rebuiltHost.service.commit(planId, durableCommitBinding, 'idem-unknown-outcome'),
      ).resolves.toEqual(recovered.firstResult);
      await expect(
        rebuiltHost.service.commit(planId, durableCommitBinding, 'idem-unknown-other'),
      ).rejects.toMatchObject({ code: 'plan_already_consumed' });
      expect(driver.executeAttempts).toBe(1);
      expect((await driver.observe(planId, 'idem-unknown-outcome')).lockHeld).toBe(false);
    });

    it('releases the shared lock even when transaction commit and rollback both fail', async () => {
      const driver = await factory.createDriver();
      const firstHost = await driver.createHost();
      const planId = await prepare(firstHost);
      driver.injectFaults('commit_before_publish', 'rollback');

      await expect(
        firstHost.service.commit(planId, durableCommitBinding, 'idem-rollback-failure'),
      ).rejects.toMatchObject({ code: 'commit_failed' });
      expect(driver.rollbackAttempts).toBe(1);
      expectUncommitted(await driver.observe(planId, 'idem-rollback-failure'));

      const rebuiltHost = await driver.createHost();
      const retried = await rebuiltHost.service.commit(
        planId,
        durableCommitBinding,
        'idem-rollback-failure',
      );
      expect(driver.executeAttempts).toBe(2);
      expectCommitted(await driver.observe(planId, 'idem-rollback-failure'), retried);
    });
  });
}
