/**
 * Phase 1 first real Collection/Node mutation Outbox contracts (P1-12 / ADR-0014).
 *
 * - Closed payload schemas per event_type + event_version
 * - Producer validators live in collections use cases; consumer re-validates here
 * - N/N-1: consumers register both current (N) and previous (N-1) versions where upgraded
 * - Static routes only — no dynamic subscription bus
 * - Handlers run after claim commit; external side effects use domain_event_id as idempotency key
 */

import {
  ANNOTATION_CREATED_EVENT_TYPE,
  ANNOTATION_CREATED_EVENT_VERSION,
  ANNOTATION_CREATED_HANDLER_NAME,
  ANNOTATION_DELETED_EVENT_TYPE,
  ANNOTATION_DELETED_EVENT_VERSION,
  ANNOTATION_DELETED_HANDLER_NAME,
  ANNOTATION_UPDATED_EVENT_TYPE,
  ANNOTATION_UPDATED_EVENT_VERSION,
  ANNOTATION_UPDATED_HANDLER_NAME,
  COLLECTION_CREATED_EVENT_TYPE,
  COLLECTION_CREATED_EVENT_VERSION,
  COLLECTION_CREATED_HANDLER_NAME,
  COLLECTION_UPDATED_EVENT_TYPE,
  COLLECTION_UPDATED_EVENT_VERSION,
  COLLECTION_UPDATED_HANDLER_NAME,
  NODE_RESTORED_EVENT_TYPE,
  NODE_RESTORED_EVENT_VERSION,
  NODE_RESTORED_HANDLER_NAME,
  NODE_CREATED_EVENT_TYPE,
  NODE_CREATED_EVENT_VERSION,
  NODE_CREATED_HANDLER_NAME,
  NODE_DELETED_EVENT_TYPE,
  NODE_DELETED_EVENT_VERSION,
  NODE_DELETED_HANDLER_NAME,
  NODE_MOVED_EVENT_TYPE,
  NODE_MOVED_EVENT_VERSION,
  NODE_MOVED_HANDLER_NAME,
  NODE_UPDATED_EVENT_TYPE,
  NODE_UPDATED_EVENT_VERSION,
  NODE_UPDATED_HANDLER_NAME,
  RELATION_CREATED_EVENT_TYPE,
  RELATION_CREATED_EVENT_VERSION,
  RELATION_CREATED_HANDLER_NAME,
  RELATION_UPDATED_EVENT_TYPE,
  RELATION_UPDATED_EVENT_VERSION,
  RELATION_UPDATED_HANDLER_NAME,
  RELATION_DELETED_EVENT_TYPE,
  RELATION_DELETED_EVENT_VERSION,
  RELATION_DELETED_HANDLER_NAME,
} from '../../modules/collections/index.js';
import {
  EventEnvelopeRegistry,
  defineClosedPayloadValidator,
  type ClosedPayload,
  type EventPayloadRegistration,
  type PayloadValidator,
} from './envelope.js';
import {
  OutboxRouter,
  TransientProjectionCompositionError,
  type OutboxHandlerContext,
  type OutboxRoute,
  type SideEffectDurability,
} from './router.js';
import {
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  publicationCachePurgeEnvelopeRegistrations,
} from './publication-cache-purge.js';

/** N = current producer default; N-1 retained during expand-contract window. */
export const COLLECTION_CREATED_EVENT_VERSION_N = COLLECTION_CREATED_EVENT_VERSION;
/** Expand-contract sibling for collection.created — consumer accepts before producer switches. */
export const COLLECTION_CREATED_EVENT_VERSION_N_PLUS = 2 as const;

export interface CollectionMutationDelivery {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly handlerName: string;
  readonly idempotencyKey: string;
  readonly aggregateId: string;
  readonly aggregateScope: string | null;
  readonly commitOrdinal: string | null;
  /** Closed payload from the versioned envelope (re-validated by the route). */
  readonly payload: unknown;
  readonly aggregateRevision: string | null;
  readonly occurredAt: string;
}

/**
 * Explicit durability of a collection/node mutation projection sink.
 * Same contract as OutboxRoute.sideEffectDurability — never inferred from class names.
 */
export type ProjectionSinkDurability = SideEffectDurability;

/**
 * Side-effect sink for collection/node mutation projections.
 * Implementations MUST be idempotent on (handlerName, eventId / idempotencyKey).
 * MUST NOT hold database locks or open the claim transaction.
 * MUST declare durability explicitly; production refuses transient sinks.
 */
export interface CollectionMutationProjectionSink {
  /**
   * Explicit durability capability.
   * - durable: apply() has committed a durable projection write before resolving
   * - transient: in-memory / no-op; must not permanently complete outbox events in production
   */
  readonly durability: ProjectionSinkDurability;
  apply(delivery: CollectionMutationDelivery): Promise<void>;
}

/**
 * In-memory projection sink for unit harnesses only.
 * Explicitly non-durable — production composition and default worker completion refuse it.
 */
export class MemoryCollectionMutationProjectionSink implements CollectionMutationProjectionSink {
  readonly durability = 'transient' as const;
  readonly deliveries: CollectionMutationDelivery[] = [];
  private readonly seen = new Set<string>();

  async apply(delivery: CollectionMutationDelivery): Promise<void> {
    const key = `${delivery.handlerName}\0${delivery.idempotencyKey}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.deliveries.push(delivery);
  }

  has(handlerName: string, eventId: string): boolean {
    return this.seen.has(`${handlerName}\0${eventId}`);
  }
}

/**
 * Recording sink that claims durable commits. Use in unit/integration harnesses that
 * need completion after apply without a real database projection.
 * Production workers use PostgresCollectionMutationProjectionSink instead.
 * Durability is explicit — not inferred from the class name.
 */
export class RecordingDurableProjectionSink implements CollectionMutationProjectionSink {
  readonly durability = 'durable' as const;
  readonly deliveries: CollectionMutationDelivery[] = [];
  private readonly seen = new Set<string>();
  /** When set, apply throws after recording so crash-after-side-effect paths can be tested. */
  failAfterApply: Error | undefined;

  async apply(delivery: CollectionMutationDelivery): Promise<void> {
    const key = `${delivery.handlerName}\0${delivery.idempotencyKey}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.deliveries.push(delivery);
    }
    if (this.failAfterApply) throw this.failAfterApply;
  }

  has(handlerName: string, eventId: string): boolean {
    return this.seen.has(`${handlerName}\0${eventId}`);
  }
}

const nonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0;

const stringOrNull = (value: unknown): boolean =>
  value === null || (typeof value === 'string');

const nonNegativeInt = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const rfc3339DateTime = (value: unknown): boolean =>
  typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
  && Number.isFinite(Date.parse(value));

const annotationSubjectType = (value: unknown): boolean =>
  value === 'collection' || value === 'node';

const annotationVisibility = (value: unknown): boolean =>
  value === 'public' || value === 'unlisted' || value === 'protected' || value === 'private';

const relationType = (value: unknown): boolean => typeof value === 'string' && [
  'related', 'precedes', 'follows', 'supports', 'contradicts',
  'duplicate_of', 'derived_from', 'mentions', 'custom',
].includes(value);

/** collection.created@1 — matches producer assertCollectionCreatedPayload */
export const validateCollectionCreatedV1: PayloadValidator = defineClosedPayloadValidator({
  collectionId: nonEmptyString,
  kind: nonEmptyString,
  ownerSubjectId: nonEmptyString,
  rootNodeId: nonEmptyString,
});

/**
 * collection.created@2 — N+ expand sibling.
 * Closed object: adds `title`; must not be treated as v1 with extra ignored fields.
 */
export const validateCollectionCreatedV2: PayloadValidator = defineClosedPayloadValidator({
  collectionId: nonEmptyString,
  kind: nonEmptyString,
  ownerSubjectId: nonEmptyString,
  rootNodeId: nonEmptyString,
  title: nonEmptyString,
});

/** collection.updated@1 */
export const validateCollectionUpdatedV1: PayloadValidator = defineClosedPayloadValidator({
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  resourceRevision: nonEmptyString,
  summary: stringOrNull,
  title: nonEmptyString,
});

/** node.created@1 */
export const validateNodeCreatedV1: PayloadValidator = defineClosedPayloadValidator({
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  kind: nonEmptyString,
  nodeId: nonEmptyString,
  parentChildrenRevision: nonEmptyString,
  parentId: nonEmptyString,
  policyRevision: nonEmptyString,
  resourceRevision: nonEmptyString,
});

/** node.updated@1 */
export const validateNodeUpdatedV1: PayloadValidator = defineClosedPayloadValidator({
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  kind: nonEmptyString,
  nodeId: nonEmptyString,
  policyRevision: nonEmptyString,
  resourceRevision: nonEmptyString,
});

/** node.moved@1 */
export const validateNodeMovedV1: PayloadValidator = defineClosedPayloadValidator({
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  kind: nonEmptyString,
  nodeId: nonEmptyString,
  policyRevision: nonEmptyString,
  resourceRevision: nonEmptyString,
  sourceChildrenRevision: nonEmptyString,
  sourceParentId: nonEmptyString,
  targetChildrenRevision: nonEmptyString,
  targetParentId: nonEmptyString,
});

/** node.deleted@1 */
export const validateNodeDeletedV1: PayloadValidator = defineClosedPayloadValidator({
  affectedCount: nonNegativeInt,
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  kind: nonEmptyString,
  nodeId: nonEmptyString,
  parentChildrenRevision: nonEmptyString,
  parentId: nonEmptyString,
  policyRevision: nonEmptyString,
  scope: nonEmptyString,
});

/** annotation.created@1 — bounded authority facts only; Annotation value never enters Outbox. */
export const validateAnnotationCreatedV1: PayloadValidator = defineClosedPayloadValidator({
  annotationId: nonEmptyString,
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  resourceRevision: nonEmptyString,
  subjectId: nonEmptyString,
  subjectType: annotationSubjectType,
  visibility: annotationVisibility,
});

/** annotation.updated@1 — no Annotation value or creator/provenance details enter Outbox. */
const validateAnnotationUpdatedV1Shape = defineClosedPayloadValidator({
  annotationId: nonEmptyString,
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  previousVisibility: annotationVisibility,
  publicRepresentationChanged: (value) => typeof value === 'boolean',
  resourceRevision: nonEmptyString,
  subjectId: nonEmptyString,
  subjectType: annotationSubjectType,
  visibility: annotationVisibility,
});
export const validateAnnotationUpdatedV1: PayloadValidator = (
  value: unknown,
): value is ClosedPayload => {
  if (!validateAnnotationUpdatedV1Shape(value)) return false;
  const payload = value as {
    readonly previousVisibility: string;
    readonly visibility: string;
    readonly publicRepresentationChanged: boolean;
  };
  return payload.publicRepresentationChanged
    === (payload.previousVisibility !== 'private' || payload.visibility !== 'private');
};

/** annotation.deleted@1 — deletion facts only; no body, creator or provenance. */
export const validateAnnotationDeletedV1: PayloadValidator = defineClosedPayloadValidator({
  affectedCount: (value) => value === 1,
  annotationId: nonEmptyString,
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  deletedAt: rfc3339DateTime,
  deleteRevision: nonEmptyString,
  operationId: nonEmptyString,
  subjectId: nonEmptyString,
  subjectType: annotationSubjectType,
  visibility: annotationVisibility,
});

/** relation.created@1 — endpoint/projection facts only; no actor principal or label. */
export const validateRelationCreatedV1: PayloadValidator = defineClosedPayloadValidator({
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  fromNodeId: nonEmptyString,
  relationId: nonEmptyString,
  resourceRevision: nonEmptyString,
  toNodeId: nonEmptyString,
  type: relationType,
  visibility: annotationVisibility,
});

const validateRelationUpdatedV1Shape: PayloadValidator = defineClosedPayloadValidator({
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  fromNodeId: nonEmptyString,
  previousVisibility: annotationVisibility,
  publicRepresentationChanged: (value) => typeof value === 'boolean',
  relationId: nonEmptyString,
  resourceRevision: nonEmptyString,
  toNodeId: nonEmptyString,
  type: relationType,
  visibility: annotationVisibility,
});
export const validateRelationUpdatedV1: PayloadValidator = (value): value is ClosedPayload => {
  if (!validateRelationUpdatedV1Shape(value)) return false;
  const payload = value as { previousVisibility: string; visibility: string;
    publicRepresentationChanged: boolean };
  return payload.publicRepresentationChanged
    === (payload.previousVisibility !== 'private' || payload.visibility !== 'private');
};

export const validateRelationDeletedV1: PayloadValidator = defineClosedPayloadValidator({
  affectedCount: (value) => value === 1,
  collectionId: nonEmptyString,
  contentRevision: nonEmptyString,
  deletedAt: rfc3339DateTime,
  deleteRevision: nonEmptyString,
  fromNodeId: nonEmptyString,
  operationId: nonEmptyString,
  relationId: nonEmptyString,
  toNodeId: nonEmptyString,
  visibility: annotationVisibility,
});

export interface CollectionMutationEventSpec {
  readonly eventType: string;
  readonly eventVersion: number;
  readonly handlerName: string;
  readonly handlerMode: 'projection_latest_only';
  readonly validatePayload: PayloadValidator;
}

/** Full Phase 1 consumer catalog (N + N-1 where upgraded). */
export function collectionMutationEventSpecs(): readonly CollectionMutationEventSpec[] {
  return Object.freeze([
    {
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      eventVersion: COLLECTION_CREATED_EVENT_VERSION_N,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateCollectionCreatedV1,
    },
    {
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      eventVersion: COLLECTION_CREATED_EVENT_VERSION_N_PLUS,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateCollectionCreatedV2,
    },
    {
      eventType: COLLECTION_UPDATED_EVENT_TYPE,
      eventVersion: COLLECTION_UPDATED_EVENT_VERSION,
      handlerName: COLLECTION_UPDATED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateCollectionUpdatedV1,
    },
    {
      eventType: NODE_RESTORED_EVENT_TYPE,
      eventVersion: NODE_RESTORED_EVENT_VERSION,
      handlerName: NODE_RESTORED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateNodeCreatedV1,
    },
    {
      eventType: NODE_CREATED_EVENT_TYPE,
      eventVersion: NODE_CREATED_EVENT_VERSION,
      handlerName: NODE_CREATED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateNodeCreatedV1,
    },
    {
      eventType: NODE_UPDATED_EVENT_TYPE,
      eventVersion: NODE_UPDATED_EVENT_VERSION,
      handlerName: NODE_UPDATED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateNodeUpdatedV1,
    },
    {
      eventType: NODE_MOVED_EVENT_TYPE,
      eventVersion: NODE_MOVED_EVENT_VERSION,
      handlerName: NODE_MOVED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateNodeMovedV1,
    },
    {
      eventType: NODE_DELETED_EVENT_TYPE,
      eventVersion: NODE_DELETED_EVENT_VERSION,
      handlerName: NODE_DELETED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateNodeDeletedV1,
    },
    {
      eventType: ANNOTATION_CREATED_EVENT_TYPE,
      eventVersion: ANNOTATION_CREATED_EVENT_VERSION,
      handlerName: ANNOTATION_CREATED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateAnnotationCreatedV1,
    },
    {
      eventType: ANNOTATION_UPDATED_EVENT_TYPE,
      eventVersion: ANNOTATION_UPDATED_EVENT_VERSION,
      handlerName: ANNOTATION_UPDATED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateAnnotationUpdatedV1,
    },
    {
      eventType: ANNOTATION_DELETED_EVENT_TYPE,
      eventVersion: ANNOTATION_DELETED_EVENT_VERSION,
      handlerName: ANNOTATION_DELETED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateAnnotationDeletedV1,
    },
    {
      eventType: RELATION_CREATED_EVENT_TYPE,
      eventVersion: RELATION_CREATED_EVENT_VERSION,
      handlerName: RELATION_CREATED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateRelationCreatedV1,
    },
    {
      eventType: RELATION_UPDATED_EVENT_TYPE,
      eventVersion: RELATION_UPDATED_EVENT_VERSION,
      handlerName: RELATION_UPDATED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateRelationUpdatedV1,
    },
    {
      eventType: RELATION_DELETED_EVENT_TYPE,
      eventVersion: RELATION_DELETED_EVENT_VERSION,
      handlerName: RELATION_DELETED_HANDLER_NAME,
      handlerMode: 'projection_latest_only' as const,
      validatePayload: validateRelationDeletedV1,
    },
  ]);
}

/** Envelope registrations for every real Phase 1 mutation event/version. */
export function createCollectionMutationEnvelopeRegistrations(): readonly EventPayloadRegistration[] {
  return Object.freeze([
    ...collectionMutationEventSpecs().map((spec) => ({
      eventType: spec.eventType,
      eventVersion: spec.eventVersion,
      validatePayload: spec.validatePayload,
    })),
    ...publicationCachePurgeEnvelopeRegistrations(),
  ]);
}

export function createCollectionMutationEnvelopeRegistry(): EventEnvelopeRegistry {
  return new EventEnvelopeRegistry(createCollectionMutationEnvelopeRegistrations());
}

/**
 * N-1 consumer registry — models the old Worker before collection.created@2 expansion.
 */
export function createCollectionMutationEnvelopeRegistryNMinus1(): EventEnvelopeRegistry {
  return new EventEnvelopeRegistry(
    createCollectionMutationEnvelopeRegistrations().filter(
      (registration) => registration.eventType !== NODE_RESTORED_EVENT_TYPE && !(
        registration.eventType === COLLECTION_CREATED_EVENT_TYPE
        && registration.eventVersion === COLLECTION_CREATED_EVENT_VERSION_N_PLUS
      ) && !(
        registration.eventType === PUBLICATION_CACHE_PURGE_EVENT_TYPE
        && registration.eventVersion === PUBLICATION_CACHE_PURGE_EVENT_VERSION
      ) && !(
        registration.eventType === ANNOTATION_CREATED_EVENT_TYPE
        && registration.eventVersion === ANNOTATION_CREATED_EVENT_VERSION
      ) && !(
        registration.eventType === ANNOTATION_UPDATED_EVENT_TYPE
        && registration.eventVersion === ANNOTATION_UPDATED_EVENT_VERSION
      ) && !(
        registration.eventType === ANNOTATION_DELETED_EVENT_TYPE
        && registration.eventVersion === ANNOTATION_DELETED_EVENT_VERSION
      ) && !(
        registration.eventType === RELATION_CREATED_EVENT_TYPE
        && registration.eventVersion === RELATION_CREATED_EVENT_VERSION
      ) && !(
        registration.eventType === RELATION_UPDATED_EVENT_TYPE
        && registration.eventVersion === RELATION_UPDATED_EVENT_VERSION
      ) && !(
        registration.eventType === RELATION_DELETED_EVENT_TYPE
        && registration.eventVersion === RELATION_DELETED_EVENT_VERSION
      ),
    ),
  );
}

function createRoute(
  spec: CollectionMutationEventSpec,
  sink: CollectionMutationProjectionSink,
  logger?: { info(bindings: object, message: string): void },
): OutboxRoute {
  return {
    handlerName: spec.handlerName,
    handlerMode: spec.handlerMode,
    eventType: spec.eventType,
    eventVersion: spec.eventVersion,
    // Propagate the sink's explicit durability capability — never infer from names.
    sideEffectDurability: sink.durability,
    routeClass: 'projection',
    async handle(context: OutboxHandlerContext): Promise<void> {
      // Envelope already re-validated by worker; re-check payload closedness fail-closed.
      if (!spec.validatePayload(context.envelope.payload)) {
        throw new Error(
          `closed payload rejected for ${spec.eventType}@${spec.eventVersion}`,
        );
      }
      const delivery: CollectionMutationDelivery = {
        eventId: context.envelope.event_id,
        eventType: context.envelope.event_type,
        eventVersion: context.envelope.event_version,
        handlerName: spec.handlerName,
        idempotencyKey: context.idempotencyKey,
        aggregateId: context.envelope.aggregate_identity.aggregate_id,
        aggregateScope: context.envelope.aggregate_identity.aggregate_scope,
        commitOrdinal: context.envelope.commit_ordinal,
        payload: context.envelope.payload,
        aggregateRevision: context.envelope.aggregate_revision,
        occurredAt: context.envelope.occurred_at,
      };
      // Side effect after claim commit — stable event id is the idempotency key.
      // For durable sinks, apply() MUST resolve only after the durable write commits.
      await sink.apply(delivery);
      logger?.info(
        {
          eventId: delivery.eventId,
          eventType: delivery.eventType,
          eventVersion: delivery.eventVersion,
          handlerName: delivery.handlerName,
          sideEffectDurability: sink.durability,
        },
        'collection mutation outbox projection applied',
      );
    },
  };
}

export interface CreateCollectionMutationOutboxRoutesOptions {
  /**
   * Projection sink. Required for production (must be durable).
   * When omitted, allowTransientProjectionSink must be true for harness default memory sink.
   */
  readonly sink?: CollectionMutationProjectionSink;
  readonly logger?: { info(bindings: object, message: string): void };
  /**
   * When true, omit collection.created@2 (old worker / N-1 surface).
   * Default false = full N/N-1 consumer.
   */
  readonly nMinus1Only?: boolean;
  /**
   * Explicit unit-harness opt-in for a transient (in-memory) projection sink.
   * Production composition must never set this. Without this flag, a missing sink
   * or a sink with durability !== "durable" fails closed at composition time.
   */
  readonly allowTransientProjectionSink?: boolean;
}

function resolveCollectionMutationProjectionSink(
  options: CreateCollectionMutationOutboxRoutesOptions,
): CollectionMutationProjectionSink {
  const sink = options.sink
    ?? (options.allowTransientProjectionSink
      ? new MemoryCollectionMutationProjectionSink()
      : undefined);
  if (!sink) {
    throw new TransientProjectionCompositionError(
      'collection mutation outbox routes require an explicit projection sink; '
      + 'the former default in-memory sink is transient and permanently completed events without a durable write. '
      + 'Pass a sink with durability: "durable", or set allowTransientProjectionSink for unit harnesses only.',
    );
  }
  if (sink.durability !== 'durable' && !options.allowTransientProjectionSink) {
    throw new TransientProjectionCompositionError(
      'refusing collection mutation outbox composition with a transient projection sink; '
      + 'pass a sink with durability: "durable", or set allowTransientProjectionSink for unit harnesses only.',
    );
  }
  if (sink.durability !== 'durable' && sink.durability !== 'transient') {
    throw new TransientProjectionCompositionError(
      'projection sink must declare durability as "durable" or "transient" (never inferred from class names)',
    );
  }
  return sink;
}

export function createCollectionMutationOutboxRoutes(
  options: CreateCollectionMutationOutboxRoutesOptions = {},
): readonly OutboxRoute[] {
  const sink = resolveCollectionMutationProjectionSink(options);
  const specs = options.nMinus1Only
    ? collectionMutationEventSpecs().filter(
      (spec) => !(
        spec.eventType === COLLECTION_CREATED_EVENT_TYPE
        && spec.eventVersion === COLLECTION_CREATED_EVENT_VERSION_N_PLUS
      ) && !(
        spec.eventType === ANNOTATION_CREATED_EVENT_TYPE
        && spec.eventVersion === ANNOTATION_CREATED_EVENT_VERSION
      ) && !(
        spec.eventType === ANNOTATION_UPDATED_EVENT_TYPE
        && spec.eventVersion === ANNOTATION_UPDATED_EVENT_VERSION
      ) && !(
        spec.eventType === ANNOTATION_DELETED_EVENT_TYPE
        && spec.eventVersion === ANNOTATION_DELETED_EVENT_VERSION
      ) && !(
        spec.eventType === RELATION_CREATED_EVENT_TYPE
        && spec.eventVersion === RELATION_CREATED_EVENT_VERSION
      ) && !(
        spec.eventType === RELATION_UPDATED_EVENT_TYPE
        && spec.eventVersion === RELATION_UPDATED_EVENT_VERSION
      ) && !(
        spec.eventType === RELATION_DELETED_EVENT_TYPE
        && spec.eventVersion === RELATION_DELETED_EVENT_VERSION
      ),
    )
    : collectionMutationEventSpecs();
  return specs.map((spec) => createRoute(spec, sink, options.logger));
}

export function createCollectionMutationOutboxRouter(
  options: CreateCollectionMutationOutboxRoutesOptions = {},
): OutboxRouter {
  return new OutboxRouter(createCollectionMutationOutboxRoutes(options));
}

/**
 * Production composition helper: builds collection mutation routes only when the sink is durable.
 * Throws TransientProjectionCompositionError for transient sinks (including memory/no-op).
 */
export function createProductionCollectionMutationOutboxRouter(options: {
  readonly sink: CollectionMutationProjectionSink;
  readonly logger?: { info(bindings: object, message: string): void };
  readonly nMinus1Only?: boolean;
}): OutboxRouter {
  if (options.sink.durability !== 'durable') {
    throw new TransientProjectionCompositionError(
      'production worker refuses a transient projection sink; '
      + 'events would be permanently completed without a durable projection write. '
      + `sink.durability=${String((options.sink as { durability?: unknown }).durability)}`,
    );
  }
  return createCollectionMutationOutboxRouter({
    sink: options.sink,
    logger: options.logger,
    nMinus1Only: options.nMinus1Only,
  });
}

export { PHASE1_PRODUCER_EVENT_VERSIONS, PHASE1_MUTATION_EVENT_COMPATIBILITY, type Phase1MutationEventCompatibility } from './collection-mutation-event-versions.js';
