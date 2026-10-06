import {
  createChangePlanService,
  type McpApprovalBeginResult,
  type McpApprovalStorePort,
  type McpChangePlanCommitCoordinatorPort,
  type McpChangePlanService,
  type McpChangePlanStorePort,
  type McpPlanCommitResult,
  type McpStoredPlan,
} from '../../src/mcp/change-plan.js';
import type { ChangePlanOperation, OperationResult } from '../../src/types/generated.js';
import type { McpAuthenticatedAuthorizationBinding } from '../../src/mcp/shared/authorization.js';
import {
  defineDurableCommitHostConformance,
  durableCommitOperation,
  type DurableCommitHostDriver,
  type DurableCommitHostFault,
  type DurableCommitHostInstance,
  type DurableCommitHostObservation,
} from './durable-commit-host-conformance.js';

type PersistedApproval = Readonly<{
  binding: McpAuthenticatedAuthorizationBinding;
  operationsDigest: string;
  consumed: boolean;
}>;

type PersistedResource = Readonly<{
  visibility: 'private' | 'protected' | 'public';
  revision: string;
}>;

type PersistedState = {
  plans: Map<string, McpStoredPlan>;
  approvals: Map<string, PersistedApproval>;
  results: Map<string, McpPlanCommitResult>;
  resource: PersistedResource;
};

type SimulatedTransaction = {
  readonly planId: string;
  readonly draft: PersistedState;
  readonly releaseLock: () => void;
};

function cloneState(state: PersistedState): PersistedState {
  return structuredClone(state);
}

function resultKey(planId: string, idempotencyKey: string): string {
  return JSON.stringify([planId, idempotencyKey]);
}

/**
 * Serializable shared-persistence simulator used to exercise the exported host
 * conformance suite. Each host gets fresh store/coordinator objects while this
 * backend survives those reconstructions. This is intentionally not named or
 * presented as production durable-storage evidence.
 */
class SharedPersistenceSimulator {
  state: PersistedState = {
    plans: new Map(),
    approvals: new Map(),
    results: new Map(),
    resource: Object.freeze({ visibility: 'private', revision: 'acl_17' }),
  };

  executeAttempts = 0;
  rollbackAttempts = 0;
  nextPlanNumber = 0;
  private readonly faults = new Set<DurableCommitHostFault>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly heldLocks = new Set<string>();

  injectFaults(...faults: readonly DurableCommitHostFault[]): void {
    for (const fault of faults) this.faults.add(fault);
  }

  consumeFault(fault: DurableCommitHostFault): boolean {
    return this.faults.delete(fault);
  }

  isLocked(planId: string): boolean {
    return this.heldLocks.has(planId);
  }

  replaceState(state: PersistedState): void {
    this.state = cloneState(state);
  }

  async acquire(planId: string): Promise<() => void> {
    const prior = this.lockTails.get(planId) ?? Promise.resolve();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const tail = prior.then(async () => gate);
    this.lockTails.set(planId, tail);
    await prior;
    this.heldLocks.add(planId);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.heldLocks.delete(planId);
      openGate();
      void tail.then(() => {
        if (this.lockTails.get(planId) === tail) this.lockTails.delete(planId);
      });
    };
  }
}

function createOrdinaryStores(backend: SharedPersistenceSimulator): Readonly<{
  planStore: McpChangePlanStorePort;
  approvalStore: McpApprovalStorePort;
}> {
  const planStore: McpChangePlanStorePort = {
    async save(plan) {
      backend.state.plans.set(plan.planId, structuredClone(plan));
    },
    async get(planId) {
      const plan = backend.state.plans.get(planId);
      return plan === undefined ? undefined : structuredClone(plan);
    },
    async update(plan) {
      backend.state.plans.set(plan.planId, structuredClone(plan));
    },
  };

  const approvalStore: McpApprovalStorePort = {
    async markApproved() {
      throw new Error('Approval must use the transaction-bound Approval store.');
    },
    async beginCommit() {
      throw new Error('Commit must use the transaction-bound Approval store.');
    },
    async finalizeCommit() {
      throw new Error('Commit must use the transaction-bound Approval store.');
    },
    async abortCommit() {
      throw new Error('Commit rollback must use the shared coordinator.');
    },
  };

  return Object.freeze({ planStore, approvalStore });
}

function createCoordinator(
  backend: SharedPersistenceSimulator,
): McpChangePlanCommitCoordinatorPort<SimulatedTransaction> {
  const coordinator: McpChangePlanCommitCoordinatorPort<SimulatedTransaction> = {
    async begin(context) {
      const releaseLock = await backend.acquire(context.planId);
      return {
        planId: context.planId,
        draft: cloneState(backend.state),
        releaseLock,
      };
    },
    planStore: {
      async lock(transaction, planId) {
        const plan = transaction.draft.plans.get(planId);
        return plan === undefined ? undefined : structuredClone(plan);
      },
      async update(transaction, plan) {
        transaction.draft.plans.set(plan.planId, structuredClone(plan));
      },
    },
    approvalStore: {
      async markApproved(transaction, input) {
        transaction.draft.approvals.set(input.planId, structuredClone({
          binding: input.binding,
          operationsDigest: input.operationsDigest,
          consumed: false,
        }));
      },
      async beginCommit(transaction, input): Promise<McpApprovalBeginResult> {
        const prior = transaction.draft.results.get(resultKey(input.planId, input.idempotencyKey));
        if (prior !== undefined) {
          return Object.freeze({
            status: 'already_consumed' as const,
            firstResult: structuredClone(prior),
          });
        }

        const approval = transaction.draft.approvals.get(input.planId);
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
        return Object.freeze({ status: 'ready' as const });
      },
      async finalizeCommit(transaction, input) {
        const approval = transaction.draft.approvals.get(input.planId);
        if (approval === undefined || approval.consumed) {
          throw new Error('Approval was not available for compare-and-consume.');
        }
        transaction.draft.approvals.set(input.planId, Object.freeze({
          ...approval,
          consumed: true,
        }));
        transaction.draft.results.set(
          resultKey(input.planId, input.idempotencyKey),
          structuredClone(input.result),
        );
      },
    },
    executor: {
      async execute(transaction, operations): Promise<readonly OperationResult[]> {
        backend.executeAttempts += 1;
        const candidate = operations[0];
        if (
          operations.length !== 1
          || candidate?.type !== 'set_visibility'
          || candidate.collectionId !== durableCommitOperation.collectionId
          || candidate.input.visibility !== durableCommitOperation.input.visibility
        ) {
          throw new Error('Unexpected conformance operation.');
        }
        transaction.draft.resource = Object.freeze({
          visibility: candidate.input.visibility,
          revision: 'acl_18',
        });
        return Object.freeze([Object.freeze({
          opId: 'op-durable-host',
          sequence: 1,
          status: 'applied' as const,
          revision: 'acl_18',
          cursor: 'cur-durable-host',
          warnings: Object.freeze([]) as readonly [],
        })]);
      },
    },
    async commit(transaction) {
      if (backend.consumeFault('commit_before_publish')) {
        throw new Error('injected-transaction-commit-failure');
      }
      backend.replaceState(transaction.draft);
      if (backend.consumeFault('connection_interrupted_after_commit')) {
        throw new Error('injected-connection-interrupted-after-commit');
      }
    },
    async rollback() {
      backend.rollbackAttempts += 1;
      if (backend.consumeFault('rollback')) throw new Error('injected-rollback-failure');
    },
    async release(transaction) {
      transaction.releaseLock();
    },
  };
  return Object.freeze(coordinator);
}

function createService(
  backend: SharedPersistenceSimulator,
  planStore: McpChangePlanStorePort,
  approvalStore: McpApprovalStorePort,
  coordinator: McpChangePlanCommitCoordinatorPort<SimulatedTransaction>,
): McpChangePlanService {
  return createChangePlanService({
    planStore,
    approvalStore,
    impact: {
      assessImpact: async () => Object.freeze({
        collections: 1,
        nodes: 0,
        annotations: 0,
        attachments: 0,
        relations: 0,
        privateFieldsExcluded: [] as string[],
      }),
    },
    revisions: {
      resolveBaseRevisions: async (operation: ChangePlanOperation) => {
        if (operation.type !== 'set_visibility') throw new Error('Unexpected operation.');
        return Object.freeze({ [`access.${operation.collectionId}`]: operation.baseRevision });
      },
      currentRevisions: async (transaction, baseRevisions) => Object.freeze(Object.fromEntries(
        Object.keys(baseRevisions).map((namespace) => [namespace, transaction.draft.resource.revision]),
      )),
    },
    scopes: { hasScopes: async () => true },
    authorizationPolicy: { requiredScopesForOperation: async () => [] },
    commitCoordinator: coordinator,
    rateLimit: { allow: async () => true },
    approvalBaseUri: 'https://alice.example/collections/approvals',
    uriPolicy: { allow: () => true },
    ids: { nextPlanId: () => `plan_durable_${++backend.nextPlanNumber}` },
    clock: { now: () => new Date('2026-07-24T10:00:00.000Z') },
  });
}

class SharedPersistenceDriver implements DurableCommitHostDriver {
  private readonly backend = new SharedPersistenceSimulator();

  get executeAttempts(): number {
    return this.backend.executeAttempts;
  }

  get rollbackAttempts(): number {
    return this.backend.rollbackAttempts;
  }

  createHost(): DurableCommitHostInstance {
    const { planStore, approvalStore } = createOrdinaryStores(this.backend);
    const coordinator = createCoordinator(this.backend);
    return Object.freeze({
      service: createService(this.backend, planStore, approvalStore, coordinator),
      planStoreHandle: planStore,
      approvalStoreHandle: approvalStore,
      coordinatorHandle: coordinator,
    });
  }

  injectFaults(...faults: readonly DurableCommitHostFault[]): void {
    this.backend.injectFaults(...faults);
  }

  observe(planId: string, idempotencyKey: string): DurableCommitHostObservation {
    const plan = this.backend.state.plans.get(planId);
    const approval = this.backend.state.approvals.get(planId);
    if (plan === undefined || approval === undefined) {
      throw new Error(`Missing prepared durable state for ${planId}.`);
    }
    const firstResult = this.backend.state.results.get(resultKey(planId, idempotencyKey));
    return Object.freeze({
      planStatus: plan.status,
      approvalConsumed: approval.consumed,
      businessState: structuredClone(this.backend.state.resource),
      firstResult: firstResult === undefined ? undefined : structuredClone(firstResult),
      lockHeld: this.backend.isLocked(planId),
    });
  }
}

defineDurableCommitHostConformance({
  name: 'shared persistence simulator (real host adapters must invoke this suite)',
  createDriver: () => new SharedPersistenceDriver(),
});
