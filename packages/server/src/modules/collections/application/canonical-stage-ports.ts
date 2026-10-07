import type {
  AllocatedMutationState,
  CanonicalMutationInput,
  CanonicalMutationPlan,
  CanonicalMutationResult,
  CanonicalPlannedResourceMutation,
  JsonObject,
  ResourceIdentity,
} from '../domain/canonical-mutation.js';

export interface TransactionContext<Transaction> {
  /** The transaction is created and owned by the calling admission layer. */
  readonly transaction: Transaction;
}

export type CanonicalTransactionContext<Transaction> = TransactionContext<Transaction>;

export interface LockedCollectionState {
  readonly collectionId: string;
  readonly currentCommitOrdinal: bigint;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
}

export interface CollectionWriteLockPort<Transaction> {
  lockForCanonicalMutation(
    transaction: Transaction,
    collectionId: string,
  ): Promise<LockedCollectionState | null>;
}

export interface CanonicalMutationPlannerPort<Transaction, PlanFacts = unknown> {
  planCanonicalMutation(
    transaction: Transaction,
    input: CanonicalMutationInput,
    collection: LockedCollectionState,
  ): Promise<CanonicalMutationPlan<PlanFacts>>;
}

export interface MutationAllocationRequest<PlanFacts = unknown> {
  readonly plan?: CanonicalMutationPlan<PlanFacts>;
  readonly operationId: string;
  readonly collection: LockedCollectionState;
  readonly mutation: CanonicalPlannedResourceMutation;
}

export interface RevisionPositionOrdinalAllocatorPort<Transaction, PlanFacts = unknown> {
  allocate(
    transaction: Transaction,
    request: MutationAllocationRequest<PlanFacts>,
  ): Promise<AllocatedMutationState>;
}

export interface CanonicalResourceWrite<PlanFacts = unknown> {
  readonly plan?: CanonicalMutationPlan<PlanFacts>;
  readonly operationId: string;
  readonly mutation: CanonicalPlannedResourceMutation;
  readonly allocation: AllocatedMutationState;
}

export interface CanonicalResourceWritePort<Transaction, PlanFacts = unknown> {
  applyCanonicalMutation(
    transaction: Transaction,
    write: CanonicalResourceWrite<PlanFacts>,
  ): Promise<void>;
}

export interface CanonicalOperationRecord<PlanFacts = unknown> {
  readonly plan?: CanonicalMutationPlan<PlanFacts>;
  readonly operationId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly operationType: string;
  readonly actorPrincipalId: string;
  readonly target: ResourceIdentity;
  readonly canonicalPayload: JsonObject;
  readonly syncWire?: JsonObject;
}

export interface OperationWritePort<Transaction, PlanFacts = unknown> {
  appendCanonicalOperation(transaction: Transaction, record: CanonicalOperationRecord<PlanFacts>): Promise<void>;
}

export interface CanonicalAuditRecord<PlanFacts = unknown> {
  readonly plan?: CanonicalMutationPlan<PlanFacts>;
  readonly operationId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly principalId: string;
  readonly principalType: string;
  readonly eventType: string;
  readonly details: JsonObject;
}

export interface AuditWritePort<Transaction, PlanFacts = unknown> {
  appendAuditEvent(transaction: Transaction, record: CanonicalAuditRecord<PlanFacts>): Promise<void>;
}

/** Domain envelope only. P0-06 routing owns handler delivery metadata. */
export interface CanonicalDomainEvent<PlanFacts = unknown> {
  readonly plan?: CanonicalMutationPlan<PlanFacts>;
  readonly domainEventId: string;
  readonly operationId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateRevision?: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: JsonObject;
}

export interface OutboxWritePort<Transaction, PlanFacts = unknown> {
  appendDomainEvents(transaction: Transaction, events: readonly CanonicalDomainEvent<PlanFacts>[]): Promise<void>;
}

export interface CanonicalMutationPorts<Transaction, PlanFacts = unknown> {
  readonly collectionLock: CollectionWriteLockPort<Transaction>;
  readonly planner: CanonicalMutationPlannerPort<Transaction, PlanFacts>;
  readonly allocator: RevisionPositionOrdinalAllocatorPort<Transaction, PlanFacts>;
  readonly resources: CanonicalResourceWritePort<Transaction, PlanFacts>;
  readonly operations: OperationWritePort<Transaction, PlanFacts>;
  readonly audit: AuditWritePort<Transaction, PlanFacts>;
  readonly outbox: OutboxWritePort<Transaction, PlanFacts>;
}

export interface CanonicalMutationApplication<Transaction> {
  execute(
    context: TransactionContext<Transaction>,
    input: CanonicalMutationInput,
  ): Promise<import('../domain/canonical-mutation.js').CanonicalMutationResult>;
}

