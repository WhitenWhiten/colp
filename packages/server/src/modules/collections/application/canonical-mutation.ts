import {
  CanonicalMutationInvariantError,
  type CanonicalMutationInput,
  type CanonicalMutationPlan,
  type CanonicalMutationResult,
  type CanonicalPlannedResourceMutation,
  type JsonObject,
} from '../domain/canonical-mutation.js';
import { assertResourceFieldAuthority } from '../domain/resource-field-authority.js';
import { isValidPositionToken } from '../domain/position-allocator.js';
import { generateOpaqueId } from '../domain/ids.js';
import type {
  CanonicalDomainEvent,
  CanonicalMutationApplication,
  CanonicalMutationPorts,
  CanonicalOperationRecord,
  TransactionContext,
} from './ports.js';

export const CANONICAL_MUTATION_WRITE_ORDER = Object.freeze([
  'collection-lock',
  'canonical-plan',
  'allocation',
  'resource',
  'operation',
  'audit',
  'outbox',
] as const);

const REVISION_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new CanonicalMutationInvariantError('invalid_canonical_mutation', `${name} is required`);
  }
}

function assertRevisionToken(value: string, name: string): void {
  if (!REVISION_TOKEN_PATTERN.test(value)) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      `${name} is not a valid revision token`,
    );
  }
}

function assertPositionToken(value: string, name: string): void {
  if (!isValidPositionToken(value)) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      `${name} is not a valid position token`,
    );
  }
}

function validateInput(input: CanonicalMutationInput): void {
  assertNonEmpty(input.operationId, 'operationId');
  assertNonEmpty(input.collectionId, 'collectionId');
  assertNonEmpty(input.actor.principalId, 'actor.principalId');
  assertNonEmpty(input.actor.principalType, 'actor.principalType');
  assertNonEmpty(input.mutation.target.resourceId, 'mutation.target.resourceId');
  assertNonEmpty(input.mutation.target.resourceKind, 'mutation.target.resourceKind');

  if (input.collectionId !== input.mutation.target.collectionId) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      'one canonical mutation may affect exactly one collection',
    );
  }
  if (input.mutation.fields) assertResourceFieldAuthority(input.mutation.fields);
  if (input.mutation.action !== 'delete' && !input.mutation.fields) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      'non-delete mutations require resource-owned fields',
    );
  }
  if (input.mutation.expectedResourceRevision) {
    assertRevisionToken(
      input.mutation.expectedResourceRevision,
      'mutation.expectedResourceRevision',
    );
  }
  if (input.mutation.action === 'delete') {
    if (!input.mutation.deleteIntent) {
      throw new CanonicalMutationInvariantError('invalid_canonical_mutation', 'delete requires deleteIntent');
    }
    if (!['single', 'subtree'].includes(input.mutation.deleteIntent.scope)) {
      throw new CanonicalMutationInvariantError('invalid_canonical_mutation', 'deleteIntent.scope is invalid');
    }
    if (input.mutation.deleteIntent.expectedContentRevision) {
      assertRevisionToken(input.mutation.deleteIntent.expectedContentRevision, 'mutation.deleteIntent.expectedContentRevision');
    }
  } else if (input.mutation.deleteIntent) {
    throw new CanonicalMutationInvariantError('invalid_canonical_mutation', 'deleteIntent is only valid for delete');
  }
  if (
    input.mutation.relativePosition?.afterId
    && input.mutation.relativePosition.afterId === input.mutation.relativePosition.beforeId
  ) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      'afterId and beforeId must identify different siblings',
    );
  }
}

function validatePlan(input: CanonicalMutationInput, plan: CanonicalMutationPlan): void {
  if (
    plan.operationId !== input.operationId
    || plan.collectionId !== input.collectionId
    || plan.mutation.target.collectionId !== input.collectionId
    || plan.mutation.target.resourceId !== input.mutation.target.resourceId
    || plan.mutation.target.resourceKind !== input.mutation.target.resourceKind
    || plan.mutation.action !== input.mutation.action
  ) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      'canonical plan does not match the admitted operation and collection binding',
    );
  }

  if (plan.mutation.fields) assertResourceFieldAuthority(plan.mutation.fields);
  if (plan.mutation.action !== 'delete' && !plan.mutation.fields) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      'planned non-delete mutations require resource-owned fields',
    );
  }
  if (plan.mutation.expectedResourceRevision) {
    assertRevisionToken(
      plan.mutation.expectedResourceRevision,
      'plan.mutation.expectedResourceRevision',
    );
  }
  if (plan.mutation.action === 'delete') {
    const ids = plan.mutation.deletePlan?.orderedResourceIds;
    if (
      plan.mutation.deleteIntent?.scope !== input.mutation.deleteIntent?.scope
      || plan.mutation.deleteIntent?.expectedContentRevision !== input.mutation.deleteIntent?.expectedContentRevision
      || !ids
      || ids.length === 0
      || ids.at(-1) !== plan.mutation.target.resourceId
      || new Set(ids).size !== ids.length
    ) {
      throw new CanonicalMutationInvariantError(
        'invalid_canonical_mutation',
        'delete plan must contain unique resources with the admitted target last',
      );
    }
  } else if (plan.mutation.deletePlan) {
    throw new CanonicalMutationInvariantError('invalid_canonical_mutation', 'deletePlan is only valid for delete');
  }
  if (
    plan.mutation.relativePosition?.afterId
    && plan.mutation.relativePosition.afterId === plan.mutation.relativePosition.beforeId
  ) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      'planned afterId and beforeId must identify different siblings',
    );
  }

  const children = plan.mutation.revisionEffects.childrenOf;
  if (new Set(children).size !== children.length) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      'planned children revision effects must not contain duplicate parents',
    );
  }
}

function operationPayload(mutation: CanonicalPlannedResourceMutation): JsonObject {
  return {
    action: mutation.action,
    resourceId: mutation.target.resourceId,
    resourceKind: mutation.target.resourceKind,
    parentId: mutation.parentId,
    ...(mutation.relativePosition ? {
      relativePosition: {
        ...(mutation.relativePosition.afterId
          ? { afterId: mutation.relativePosition.afterId }
          : {}),
        ...(mutation.relativePosition.beforeId
          ? { beforeId: mutation.relativePosition.beforeId }
          : {}),
      },
    } : {}),
    ...(mutation.fields ? {
      kindFields: mutation.fields.kindFields,
      extensions: mutation.fields.extensions,
    } : {}),
    ...(mutation.expectedResourceRevision
      ? { expectedResourceRevision: mutation.expectedResourceRevision }
      : {}),
    ...(mutation.deleteIntent ? {
      deleteIntent: {
        scope: mutation.deleteIntent.scope,
        ...(mutation.deleteIntent.expectedContentRevision
          ? { expectedContentRevision: mutation.deleteIntent.expectedContentRevision }
          : {}),
      },
      affectedResourceIds: mutation.deletePlan?.orderedResourceIds ?? [],
    } : {}),
    revisionEffects: {
      resource: mutation.revisionEffects.resource,
      content: mutation.revisionEffects.content,
      policy: mutation.revisionEffects.policy,
      childrenOf: mutation.revisionEffects.childrenOf,
    },
  };
}

function validateAllocation(
  mutation: CanonicalPlannedResourceMutation,
  allocation: CanonicalMutationResult['allocation'],
): void {
  const effects = mutation.revisionEffects;
  const requiresCreatedNodeChildrenRevision = mutation.action === 'create'
    && mutation.target.resourceKind === 'node';
  const expectedChildren = [...effects.childrenOf].sort();
  const allocatedChildren = Object.keys(allocation.childrenRevisions).sort();
  const hasExactChildren = expectedChildren.length === allocatedChildren.length
    && expectedChildren.every((parentId, index) => parentId === allocatedChildren[index]);
  const plannedDeleteIds = mutation.deletePlan?.orderedResourceIds ?? [];
  const allocatedDeleteIds = Object.keys(allocation.deletedResourceRevisions ?? {}).sort();
  const hasExactDeletedResources = mutation.action === 'delete'
    ? plannedDeleteIds.length === allocatedDeleteIds.length
      && [...plannedDeleteIds].sort().every((id, index) => id === allocatedDeleteIds[index])
    : allocatedDeleteIds.length === 0;
  const targetDeleteRevision = allocation.deletedResourceRevisions?.[mutation.target.resourceId];

  if (
    allocation.commitOrdinal <= 0n
    || Boolean(allocation.resourceRevision) !== effects.resource
    || Boolean(allocation.contentRevision) !== effects.content
    || Boolean(allocation.policyRevision) !== effects.policy
    || Boolean(allocation.createdNodeChildrenRevision) !== requiresCreatedNodeChildrenRevision
    || !hasExactChildren
    || !hasExactDeletedResources
    || (mutation.action === 'delete' && targetDeleteRevision !== allocation.resourceRevision)
    || allocatedChildren.some((parentId) => allocation.childrenRevisions[parentId]?.length === 0)
    || (
      (mutation.action === 'create' || mutation.action === 'move' || mutation.action === 'restore')
      && mutation.parentId !== null
      && !allocation.positionToken
    )
  ) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      'allocator output does not match the declared revision effects',
    );
  }

  if (allocation.resourceRevision) {
    assertRevisionToken(allocation.resourceRevision, 'allocation.resourceRevision');
  }
  if (allocation.createdNodeChildrenRevision) {
    assertRevisionToken(
      allocation.createdNodeChildrenRevision,
      'allocation.createdNodeChildrenRevision',
    );
  }
  if (allocation.contentRevision) {
    assertRevisionToken(allocation.contentRevision, 'allocation.contentRevision');
  }
  if (allocation.policyRevision) {
    assertRevisionToken(allocation.policyRevision, 'allocation.policyRevision');
  }
  for (const [parentId, revision] of Object.entries(allocation.childrenRevisions)) {
    assertRevisionToken(revision, `allocation.childrenRevisions.${parentId}`);
  }
  if (allocation.positionToken) {
    assertPositionToken(allocation.positionToken, 'allocation.positionToken');
  }
  for (const [resourceId, revision] of Object.entries(allocation.deletedResourceRevisions ?? {})) {
    assertNonEmpty(resourceId, 'allocation.deletedResourceRevisions.resourceId');
    assertRevisionToken(revision, `allocation.deletedResourceRevisions.${resourceId}`);
  }
  const rebalancedIds = new Set<string>();
  const rebalancedTokens = new Set<string>();
  if (
    (allocation.rebalancedSiblings?.length ?? 0) > 0
    && mutation.action !== 'create'
    && mutation.action !== 'move'
  ) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      'only create or move allocation may rebalance siblings',
    );
  }
  for (const sibling of allocation.rebalancedSiblings ?? []) {
    assertNonEmpty(sibling.resourceId, 'allocation.rebalancedSiblings.resourceId');
    assertPositionToken(sibling.positionToken, `allocation.rebalancedSiblings.${sibling.resourceId}.positionToken`);
    assertRevisionToken(sibling.resourceRevision, `allocation.rebalancedSiblings.${sibling.resourceId}.resourceRevision`);
    if (
      sibling.resourceId === mutation.target.resourceId
      || rebalancedIds.has(sibling.resourceId)
      || rebalancedTokens.has(sibling.positionToken)
      || sibling.positionToken === allocation.positionToken
    ) {
      throw new CanonicalMutationInvariantError(
        'invalid_canonical_mutation',
        'rebalanced sibling allocation must contain unique non-target resources and positions',
      );
    }
    rebalancedIds.add(sibling.resourceId);
    rebalancedTokens.add(sibling.positionToken);
  }
}

export function createCanonicalMutationApplication<Transaction, PlanFacts = unknown>(
  ports: CanonicalMutationPorts<Transaction, PlanFacts>,
): CanonicalMutationApplication<Transaction> {
  return {
    async execute(
      context: TransactionContext<Transaction>,
      input: CanonicalMutationInput,
    ): Promise<CanonicalMutationResult> {
      validateInput(input);

      const locked = await ports.collectionLock.lockForCanonicalMutation(
        context.transaction,
        input.collectionId,
      );
      if (!locked || locked.collectionId !== input.collectionId) {
        throw new CanonicalMutationInvariantError(
          'invalid_canonical_mutation',
          'collection does not exist or the lock returned a different collection',
        );
      }

      assertRevisionToken(locked.resourceRevision, 'locked.resourceRevision');
      assertRevisionToken(locked.contentRevision, 'locked.contentRevision');
      assertRevisionToken(locked.policyRevision, 'locked.policyRevision');

      const plan = await ports.planner.planCanonicalMutation(
        context.transaction,
        input,
        locked,
      );
      validatePlan(input, plan);

      const allocation = await ports.allocator.allocate(context.transaction, {
        plan,
        operationId: input.operationId,
        collection: locked,
        mutation: plan.mutation,
      });
      if (allocation.commitOrdinal !== locked.currentCommitOrdinal + 1n) {
        throw new CanonicalMutationInvariantError(
          'invalid_canonical_mutation',
          'allocator must advance the locked collection ordinal by exactly one',
        );
      }
      validateAllocation(plan.mutation, allocation);

      await ports.resources.applyCanonicalMutation(context.transaction, {
        plan,
        operationId: input.operationId,
        mutation: plan.mutation,
        allocation,
      });

      const canonicalPayload = operationPayload(plan.mutation);
      const operation: CanonicalOperationRecord<PlanFacts> = {
        plan,
        operationId: input.operationId,
        collectionId: input.collectionId,
        commitOrdinal: allocation.commitOrdinal,
        operationType: `resource.${input.mutation.action}`,
        actorPrincipalId: input.actor.principalId,
        target: input.mutation.target,
        canonicalPayload,
        ...(input.operationSyncWire ? { syncWire: input.operationSyncWire } : {}),
      };
      await ports.operations.appendCanonicalOperation(context.transaction, operation);

      await ports.audit.appendAuditEvent(context.transaction, {
        plan,
        operationId: input.operationId,
        collectionId: input.collectionId,
        commitOrdinal: allocation.commitOrdinal,
        principalId: input.actor.principalId,
        principalType: input.actor.principalType,
        eventType: operation.operationType,
        details: canonicalPayload,
      });

      const event: CanonicalDomainEvent<PlanFacts> = {
        plan,
        domainEventId: generateOpaqueId(),
        operationId: input.operationId,
        collectionId: input.collectionId,
        commitOrdinal: allocation.commitOrdinal,
        aggregateType: input.mutation.target.resourceKind,
        aggregateId: input.mutation.target.resourceId,
        ...(allocation.resourceRevision
          ? { aggregateRevision: allocation.resourceRevision }
          : {}),
        eventType: operation.operationType,
        eventVersion: 1,
        payload: canonicalPayload,
      };
      await ports.outbox.appendDomainEvents(context.transaction, [event]);

      return Object.freeze({
        operationId: input.operationId,
        collectionId: input.collectionId,
        resourceId: input.mutation.target.resourceId,
        action: input.mutation.action,
        allocation: Object.freeze(allocation),
      });
    },
  };
}
