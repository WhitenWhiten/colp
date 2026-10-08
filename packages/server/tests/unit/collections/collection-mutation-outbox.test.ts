/**
 * P1-12: versioned collection/node mutation outbox — closed payloads, N/N-1 consumer,
 * unknown version fail-closed, static routes, retry/dead-letter, idempotent redelivery.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ANNOTATION_CREATED_EVENT_TYPE,
  ANNOTATION_CREATED_HANDLER_NAME,
  ANNOTATION_DELETED_EVENT_TYPE,
  ANNOTATION_DELETED_HANDLER_NAME,
  ANNOTATION_UPDATED_EVENT_TYPE,
  ANNOTATION_UPDATED_HANDLER_NAME,
  RELATION_CREATED_EVENT_TYPE,
  RELATION_CREATED_HANDLER_NAME,
  RELATION_UPDATED_EVENT_TYPE,
  RELATION_UPDATED_HANDLER_NAME,
  RELATION_DELETED_EVENT_TYPE,
  RELATION_DELETED_HANDLER_NAME,
  assertAnnotationDeletedPayload,
  assertCollectionCreatedPayload,
  assertCollectionUpdatedPayload,
  assertNodeCreatedPayload,
  assertNodeDeletedPayload,
  assertNodeMovedPayload,
  assertNodeUpdatedPayload,
  COLLECTION_CREATED_EVENT_TYPE,
  COLLECTION_CREATED_HANDLER_NAME,
  NODE_CREATED_EVENT_TYPE,
  NODE_CREATED_HANDLER_NAME,
} from '../../../src/modules/collections/index.js';
import {
  COLLECTION_CREATED_EVENT_VERSION_N,
  COLLECTION_CREATED_EVENT_VERSION_N_PLUS,
  InvalidEventEnvelopeError,
  MemoryCollectionMutationProjectionSink,
  OutboxRouter,
  PHASE1_PRODUCER_EVENT_VERSIONS,
  RecordingDurableProjectionSink,
  TransientProjectionCompositionError,
  TransientSideEffectCompletionError,
  UnsupportedEventVersionError,
  VersionedOutboxWorker,
  assertProductionOutboxRouteDurability,
  collectionMutationEventSpecs,
  createCollectionMutationEnvelopeRegistry,
  createCollectionMutationEnvelopeRegistryNMinus1,
  createCollectionMutationOutboxRoutes,
  createExponentialRetryPolicy,
  createProductionCollectionMutationOutboxRouter,
  validateCollectionCreatedV1,
  validateCollectionCreatedV2,
  type CollectionMutationProjectionSink,
  type FailureDisposition,
  type OutboxClaim,
  type OutboxRepository,
  type OutboxWorkerLogger,
} from '../../../src/infrastructure/outbox/index.js';
import {
  buildWorker,
  composeProductionOutboxProjectionRoutes,
} from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

function collectionCreatedPayloadV1() {
  return {
    collectionId: 'col-1',
    kind: 'bookmarks',
    ownerSubjectId: 'subject-1',
    rootNodeId: 'root-1',
  };
}

function collectionCreatedPayloadV2() {
  return {
    ...collectionCreatedPayloadV1(),
    title: 'My List',
  };
}

function annotationCreatedPayload() {
  return {
    annotationId: 'annotation-1',
    collectionId: 'col-1',
    contentRevision: 'content-2',
    resourceRevision: 'annotation-revision-1',
    subjectId: 'node-1',
    subjectType: 'node',
    visibility: 'protected',
  };
}

function annotationUpdatedPayload() {
  return {
    annotationId: 'annotation-1',
    collectionId: 'col-1',
    contentRevision: 'content-3',
    previousVisibility: 'private',
    publicRepresentationChanged: true,
    resourceRevision: 'annotation-revision-2',
    subjectId: 'node-1',
    subjectType: 'node',
    visibility: 'protected',
  };
}

function relationCreatedPayload() {
  return {
    collectionId: 'col-1',
    contentRevision: 'content-relation-2',
    fromNodeId: 'node-from',
    relationId: 'relation-1',
    resourceRevision: 'relation-revision-1',
    toNodeId: 'node-to',
    type: 'supports',
    visibility: 'protected',
  };
}

function relationUpdatedPayload() {
  return { ...relationCreatedPayload(), resourceRevision: 'relation-revision-2',
    previousVisibility: 'protected', publicRepresentationChanged: true };
}

function relationDeletedPayload() {
  return { affectedCount: 1, collectionId: 'col-1', contentRevision: 'content-relation-3',
    deletedAt: '2026-07-25T05:00:00Z', deleteRevision: 'relation-revision-3',
    fromNodeId: 'node-from', operationId: 'operation-relation-delete-1',
    relationId: 'relation-1', toNodeId: 'node-to', visibility: 'protected' };
}

function annotationDeletedPayload() {
  return {
    affectedCount: 1,
    annotationId: 'annotation-1',
    collectionId: 'col-1',
    contentRevision: 'content-4',
    deletedAt: '2026-07-25T02:00:00Z',
    deleteRevision: 'annotation-revision-3',
    operationId: 'operation-annotation-delete-1',
    subjectId: 'node-1',
    subjectType: 'node',
    visibility: 'protected',
  };
}

function envelope(
  eventType: string,
  eventVersion: number,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    event_id: 'event-col-1',
    event_type: eventType,
    event_version: eventVersion,
    aggregate_identity: {
      aggregate_type: 'collection',
      aggregate_id: 'col-1',
      aggregate_scope: 'col-1',
    },
    aggregate_revision: 'rev-1',
    commit_ordinal: '1',
    occurred_at: '2026-07-22T12:00:00.000Z',
    payload,
    ...overrides,
  };
}

function claim(overrides: Partial<OutboxClaim> = {}): OutboxClaim {
  return {
    outboxId: 'outbox-1',
    eventId: 'event-col-1',
    eventType: COLLECTION_CREATED_EVENT_TYPE,
    eventVersion: COLLECTION_CREATED_EVENT_VERSION_N,
    handlerName: COLLECTION_CREATED_HANDLER_NAME,
    handlerMode: 'projection_latest_only',
    aggregateType: 'collection',
    aggregateId: 'col-1',
    aggregateScope: 'col-1',
    aggregateRevision: 'rev-1',
    commitOrdinal: '1',
    occurredAt: new Date('2026-07-22T12:00:00.000Z'),
    payload: collectionCreatedPayloadV1(),
    attemptCount: 1,
    leaseGeneration: '1',
    ...overrides,
  };
}

class FakeRepository implements OutboxRepository {
  readonly events: string[] = [];
  readonly completed: OutboxClaim[] = [];
  readonly failures: Array<{
    claim: OutboxClaim;
    error: string;
    retryDelayMs: number;
    maxAttempts: number;
  }> = [];
  obsoleteProjection = false;
  deliveryReceipt = false;
  completeResult = true;
  failureDisposition: FailureDisposition = 'retryable';
  backlog = { count: 1, oldestAgeMs: 10 };

  constructor(readonly claims: OutboxClaim[]) {}

  async claim(): Promise<OutboxClaim | null> {
    this.events.push('claim');
    return this.claims.shift() ?? null;
  }

  async inspectBacklog() { return this.backlog; }
  async heartbeat(): Promise<boolean> { return true; }
  async isObsoleteProjection(): Promise<boolean> { return this.obsoleteProjection; }
  async hasDeliveryReceipt(): Promise<boolean> { return this.deliveryReceipt; }

  async complete(seen: OutboxClaim): Promise<boolean> {
    this.completed.push(seen);
    this.events.push('complete');
    return this.completeResult;
  }

  async continue(_seen: OutboxClaim): Promise<boolean> {
    this.events.push('continue');
    return true;
  }

  async fail(
    seen: OutboxClaim,
    error: string,
    retryDelayMs: number,
    maxAttempts: number,
  ): Promise<FailureDisposition> {
    this.failures.push({ claim: seen, error, retryDelayMs, maxAttempts });
    this.events.push(`fail:${this.failureDisposition}`);
    return this.failureDisposition;
  }
}

const logger: OutboxWorkerLogger = {
  info() {},
  warn() {},
  error() {},
};

type RecordingSink = RecordingDurableProjectionSink | MemoryCollectionMutationProjectionSink;

function makeWorker(
  repository: FakeRepository,
  options: {
    nMinus1Only?: boolean;
    sink?: RecordingSink;
    failHandler?: boolean;
    /** Explicit harness opt-in when using a transient sink (default durable recording sink). */
    allowTransientProjectionSink?: boolean;
    acknowledgeTransientSideEffects?: boolean;
  } = {},
) {
  const sink: RecordingSink = options.sink ?? new RecordingDurableProjectionSink();
  let routes = [...createCollectionMutationOutboxRoutes({
    sink,
    nMinus1Only: options.nMinus1Only,
    allowTransientProjectionSink: options.allowTransientProjectionSink
      ?? sink.durability === 'transient',
  })];
  if (options.failHandler) {
    routes = routes.map((route) => ({
      ...route,
      async handle() {
        throw new Error('projected side effect failed');
      },
    }));
  }
  const envelopes = options.nMinus1Only
    ? createCollectionMutationEnvelopeRegistryNMinus1()
    : createCollectionMutationEnvelopeRegistry();
  return {
    sink,
    outbox: new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter(routes),
      envelopes,
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 50,
        maxDelayMs: 200,
        maxAttempts: 3,
        jitterRatio: 0,
      }),
      acknowledgeTransientSideEffects: options.acknowledgeTransientSideEffects,
    }),
  };
}

describe('producer closed payload validation (collection/node mutations)', () => {
  test('accepts closed collection.created@1 and rejects extra/missing fields', () => {
    assert.doesNotThrow(() => assertCollectionCreatedPayload(collectionCreatedPayloadV1()));
    assert.throws(() => assertCollectionCreatedPayload({
      ...collectionCreatedPayloadV1(),
      title: 'extra',
    }));
    assert.throws(() => assertCollectionCreatedPayload({
      collectionId: 'c',
      kind: 'bookmarks',
      ownerSubjectId: 's',
    }));
  });

  test('accepts closed payloads for updated/created/moved/deleted node events', () => {
    assert.doesNotThrow(() => assertCollectionUpdatedPayload({
      collectionId: 'c',
      resourceRevision: 'r',
      contentRevision: 'cr',
      title: 't',
      summary: null,
    }));
    assert.doesNotThrow(() => assertNodeCreatedPayload({
      collectionId: 'c',
      nodeId: 'n',
      parentId: 'p',
      kind: 'bookmark',
      resourceRevision: 'r',
      contentRevision: 'cr',
      policyRevision: 'pr',
      parentChildrenRevision: 'pcr',
    }));
    assert.doesNotThrow(() => assertNodeUpdatedPayload({
      collectionId: 'c',
      nodeId: 'n',
      kind: 'bookmark',
      resourceRevision: 'r',
      contentRevision: 'cr',
      policyRevision: 'pr',
    }));
    assert.doesNotThrow(() => assertNodeMovedPayload({
      collectionId: 'c',
      nodeId: 'n',
      kind: 'bookmark',
      sourceParentId: 's',
      targetParentId: 't',
      resourceRevision: 'r',
      contentRevision: 'cr',
      policyRevision: 'pr',
      sourceChildrenRevision: 'scr',
      targetChildrenRevision: 'tcr',
    }));
    assert.doesNotThrow(() => assertNodeDeletedPayload({
      collectionId: 'c',
      nodeId: 'n',
      kind: 'bookmark',
      parentId: 'p',
      scope: 'single',
      affectedCount: 1,
      contentRevision: 'cr',
      policyRevision: 'pr',
      parentChildrenRevision: 'pcr',
    }));
    assert.throws(() => assertNodeDeletedPayload({
      collectionId: 'c',
      nodeId: 'n',
      kind: 'bookmark',
      parentId: 'p',
      scope: 'single',
      affectedCount: 1,
      contentRevision: 'cr',
      policyRevision: 'pr',
      parentChildrenRevision: 'pcr',
      extra: true,
    }));
  });

  test('producer catalog stays on N for collection.created (expand consumer first)', () => {
    assert.equal(PHASE1_PRODUCER_EVENT_VERSIONS[COLLECTION_CREATED_EVENT_TYPE], 1);
    assert.equal(COLLECTION_CREATED_EVENT_VERSION_N, 1);
    assert.equal(COLLECTION_CREATED_EVENT_VERSION_N_PLUS, 2);
  });
});

describe('consumer envelope N/N-1 and fail-closed unknown versions', () => {
  test('full consumer accepts collection.created@1 and @2 closed payloads', () => {
    const registry = createCollectionMutationEnvelopeRegistry();
    const v1 = registry.validate(envelope(
      COLLECTION_CREATED_EVENT_TYPE,
      COLLECTION_CREATED_EVENT_VERSION_N,
      collectionCreatedPayloadV1(),
    ));
    assert.equal(v1.event_version, 1);
    const v2 = registry.validate(envelope(
      COLLECTION_CREATED_EVENT_TYPE,
      COLLECTION_CREATED_EVENT_VERSION_N_PLUS,
      collectionCreatedPayloadV2(),
    ));
    assert.equal(v2.event_version, 2);
  });

  test('v1 consumer rejects v2 payload shape and unknown version fails closed', () => {
    assert.equal(validateCollectionCreatedV1(collectionCreatedPayloadV2()), false);
    assert.equal(validateCollectionCreatedV2(collectionCreatedPayloadV1()), false);

    const registry = createCollectionMutationEnvelopeRegistry();
    assert.throws(
      () => registry.validate(envelope(COLLECTION_CREATED_EVENT_TYPE, 99, collectionCreatedPayloadV1())),
      (error: unknown) => error instanceof UnsupportedEventVersionError
        && error.eventType === COLLECTION_CREATED_EVENT_TYPE
        && error.eventVersion === 99,
    );
  });

  test('malformed envelope is rejected without cast fallback', () => {
    const registry = createCollectionMutationEnvelopeRegistry();
    assert.throws(
      () => registry.validate(envelope(
        COLLECTION_CREATED_EVENT_TYPE,
        1,
        collectionCreatedPayloadV1(),
        { unexpected: true },
      )),
      InvalidEventEnvelopeError,
    );
    assert.throws(
      () => registry.validate(envelope(
        COLLECTION_CREATED_EVENT_TYPE,
        1,
        { ...collectionCreatedPayloadV1(), extra: 'x' },
      )),
      InvalidEventEnvelopeError,
    );
  });

  test('N-1 worker registry rejects collection.created@2 (mixed deploy window)', () => {
    const oldRegistry = createCollectionMutationEnvelopeRegistryNMinus1();
    assert.doesNotThrow(() => oldRegistry.validate(envelope(
      COLLECTION_CREATED_EVENT_TYPE,
      1,
      collectionCreatedPayloadV1(),
    )));
    assert.throws(
      () => oldRegistry.validate(envelope(
        COLLECTION_CREATED_EVENT_TYPE,
        2,
        collectionCreatedPayloadV2(),
      )),
      UnsupportedEventVersionError,
    );
  });
});

describe('static routes and worker delivery for collection mutations', () => {
  test('catalog covers Phase 1 mutation families plus Annotation and Relation writes', () => {
    const types = new Set(collectionMutationEventSpecs().map((s) => `${s.eventType}@${s.eventVersion}`));
    assert.deepEqual([...types].sort(), [
      'annotation.created@1',
      'annotation.deleted@1',
      'annotation.updated@1',
      'collection.created@1',
      'collection.created@2',
      'collection.updated@1',
      'node.created@1',
      'node.deleted@1',
      'node.moved@1',
      'node.restored@1',
      'node.updated@1',
      'relation.created@1',
      'relation.deleted@1',
      'relation.updated@1',
    ]);
  });

  test('relation.created@1 is closed, current-only, rejects owner leakage and routes durably', async () => {
    const current = createCollectionMutationEnvelopeRegistry();
    const previous = createCollectionMutationEnvelopeRegistryNMinus1();
    const wire = envelope(RELATION_CREATED_EVENT_TYPE, 1, relationCreatedPayload(), {
      aggregate_identity: { aggregate_type: 'relation', aggregate_id: 'relation-1', aggregate_scope: 'col-1' },
    });
    assert.doesNotThrow(() => current.validate(wire));
    for (const forbidden of [{ ownerPrincipalId: 'principal-private' }, { label: 'not projection metadata' },
      { futureField: true }]) {
      assert.throws(() => current.validate({ ...wire, payload: { ...relationCreatedPayload(), ...forbidden } }),
        InvalidEventEnvelopeError);
    }
    assert.throws(() => current.validate({ ...wire, payload: {
      ...relationCreatedPayload(), type: new String('supports'),
    } }), InvalidEventEnvelopeError);
    assert.throws(() => current.validate({ ...wire, event_version: 2 }), UnsupportedEventVersionError);
    assert.throws(() => previous.validate(wire), UnsupportedEventVersionError);

    const repository = new FakeRepository([claim({
      outboxId: 'outbox-relation', eventId: 'event-relation-1',
      eventType: RELATION_CREATED_EVENT_TYPE, eventVersion: 1,
      handlerName: RELATION_CREATED_HANDLER_NAME,
      aggregateType: 'relation', aggregateId: 'relation-1', payload: relationCreatedPayload(),
    })]);
    const { sink, outbox } = makeWorker(repository);
    assert.equal(await outbox.runOnce(), true);
    assert.equal(sink.deliveries[0]?.eventType, RELATION_CREATED_EVENT_TYPE);
    assert.equal(sink.deliveries[0]?.handlerName, RELATION_CREATED_HANDLER_NAME);
  });

  test('relation.updated/deleted@1 are closed, current-only and route to durable projections', async () => {
    const current = createCollectionMutationEnvelopeRegistry();
    const previous = createCollectionMutationEnvelopeRegistryNMinus1();
    for (const [eventType, handlerName, payload] of [
      [RELATION_UPDATED_EVENT_TYPE, RELATION_UPDATED_HANDLER_NAME, relationUpdatedPayload()],
      [RELATION_DELETED_EVENT_TYPE, RELATION_DELETED_HANDLER_NAME, relationDeletedPayload()],
    ] as const) {
      const wire = envelope(eventType, 1, payload, { aggregate_identity: {
        aggregate_type: 'relation', aggregate_id: 'relation-1', aggregate_scope: 'col-1',
      } });
      assert.doesNotThrow(() => current.validate(wire));
      assert.throws(() => current.validate({ ...wire, payload: { ...payload, label: 'private metadata' } }),
        InvalidEventEnvelopeError);
      assert.throws(() => previous.validate(wire), UnsupportedEventVersionError);
      const repository = new FakeRepository([claim({ outboxId: `outbox-${eventType}`,
        eventId: `event-${eventType}`, eventType, eventVersion: 1, handlerName,
        aggregateType: 'relation', aggregateId: 'relation-1', payload })]);
      const { sink, outbox } = makeWorker(repository);
      assert.equal(await outbox.runOnce(), true);
      assert.equal(sink.deliveries[0]?.eventType, eventType);
    }
  });

  test('annotation.created@1 is closed, current-only and routed through the durable projection sink', async () => {
    const current = createCollectionMutationEnvelopeRegistry();
    const previous = createCollectionMutationEnvelopeRegistryNMinus1();
    const wire = envelope(ANNOTATION_CREATED_EVENT_TYPE, 1, annotationCreatedPayload(), {
      aggregate_identity: {
        aggregate_type: 'annotation',
        aggregate_id: 'annotation-1',
        aggregate_scope: 'col-1',
      },
    });
    assert.doesNotThrow(() => current.validate(wire));
    assert.throws(() => current.validate({ ...wire, payload: {
      ...annotationCreatedPayload(), value: 'must-not-enter-outbox',
    } }), InvalidEventEnvelopeError);
    assert.throws(() => previous.validate(wire), UnsupportedEventVersionError);

    const repository = new FakeRepository([claim({
      outboxId: 'outbox-annotation', eventId: 'event-annotation-1',
      eventType: ANNOTATION_CREATED_EVENT_TYPE, eventVersion: 1,
      handlerName: ANNOTATION_CREATED_HANDLER_NAME,
      aggregateType: 'annotation', aggregateId: 'annotation-1',
      payload: annotationCreatedPayload(),
    })]);
    const { sink, outbox } = makeWorker(repository);
    assert.equal(await outbox.runOnce(), true);
    assert.equal(sink.deliveries[0]?.eventType, ANNOTATION_CREATED_EVENT_TYPE);
    assert.equal(sink.deliveries[0]?.handlerName, ANNOTATION_CREATED_HANDLER_NAME);
  });

  test('annotation.updated@1 is closed, N-1/unknown fail closed and routes without Annotation value', async () => {
    const current = createCollectionMutationEnvelopeRegistry();
    const previous = createCollectionMutationEnvelopeRegistryNMinus1();
    const wire = envelope(ANNOTATION_UPDATED_EVENT_TYPE, 1, annotationUpdatedPayload(), {
      aggregate_identity: {
        aggregate_type: 'annotation', aggregate_id: 'annotation-1', aggregate_scope: 'col-1',
      },
    });
    assert.doesNotThrow(() => current.validate(wire));
    assert.throws(() => current.validate({ ...wire, payload: {
      ...annotationUpdatedPayload(), value: 'private-content-must-not-enter-outbox',
    } }), InvalidEventEnvelopeError);
    assert.throws(() => current.validate({ ...wire, payload: {
      ...annotationUpdatedPayload(), publicRepresentationChanged: false,
    } }), InvalidEventEnvelopeError);
    assert.throws(() => current.validate({ ...wire, event_version: 2 }), UnsupportedEventVersionError);
    assert.throws(() => previous.validate(wire), UnsupportedEventVersionError);

    const repository = new FakeRepository([claim({
      outboxId: 'outbox-annotation-update', eventId: 'event-annotation-update-1',
      eventType: ANNOTATION_UPDATED_EVENT_TYPE, eventVersion: 1,
      handlerName: ANNOTATION_UPDATED_HANDLER_NAME,
      aggregateType: 'annotation', aggregateId: 'annotation-1',
      payload: annotationUpdatedPayload(),
    })]);
    const { sink, outbox } = makeWorker(repository);
    assert.equal(await outbox.runOnce(), true);
    assert.equal(sink.deliveries[0]?.eventType, ANNOTATION_UPDATED_EVENT_TYPE);
    assert.equal(sink.deliveries[0]?.handlerName, ANNOTATION_UPDATED_HANDLER_NAME);
  });

  test('annotation.deleted@1 is closed, current-only and projects only tombstone facts', async () => {
    const current = createCollectionMutationEnvelopeRegistry();
    const previous = createCollectionMutationEnvelopeRegistryNMinus1();
    assert.doesNotThrow(() => assertAnnotationDeletedPayload(annotationDeletedPayload()));
    const wire = envelope(ANNOTATION_DELETED_EVENT_TYPE, 1, annotationDeletedPayload(), {
      aggregate_identity: {
        aggregate_type: 'annotation', aggregate_id: 'annotation-1', aggregate_scope: 'col-1',
      },
    });
    assert.doesNotThrow(() => current.validate(wire));
    for (const forbidden of [{ value: 'private' }, { creatorPrincipalId: 'principal-private' },
      { futureField: true }]) {
      assert.throws(() => current.validate({ ...wire, payload: {
        ...annotationDeletedPayload(), ...forbidden,
      } }), InvalidEventEnvelopeError);
    }
    assert.throws(() => current.validate({ ...wire, event_version: 2 }), UnsupportedEventVersionError);
    assert.throws(() => previous.validate(wire), UnsupportedEventVersionError);

    const repository = new FakeRepository([claim({
      outboxId: 'outbox-annotation-delete', eventId: 'event-annotation-delete-1',
      eventType: ANNOTATION_DELETED_EVENT_TYPE, eventVersion: 1,
      handlerName: ANNOTATION_DELETED_HANDLER_NAME,
      aggregateType: 'annotation', aggregateId: 'annotation-1',
      payload: annotationDeletedPayload(),
    })]);
    const { sink, outbox } = makeWorker(repository);
    assert.equal(await outbox.runOnce(), true);
    assert.equal(sink.deliveries[0]?.eventType, ANNOTATION_DELETED_EVENT_TYPE);
    assert.equal(sink.deliveries[0]?.handlerName, ANNOTATION_DELETED_HANDLER_NAME);
  });

  test('delivers collection.created@1 and records event_id idempotency key', async () => {
    const repository = new FakeRepository([claim()]);
    const { sink, outbox } = makeWorker(repository);
    assert.equal(await outbox.runOnce(), true);
    assert.equal(repository.completed.length, 1);
    assert.equal(sink.deliveries.length, 1);
    assert.equal(sink.deliveries[0]?.eventId, 'event-col-1');
    assert.equal(sink.deliveries[0]?.idempotencyKey, 'event-col-1');
    assert.equal(sink.deliveries[0]?.handlerName, COLLECTION_CREATED_HANDLER_NAME);
  });

  test('new worker accepts collection.created@2 while producer still on N', async () => {
    const repository = new FakeRepository([claim({
      eventVersion: COLLECTION_CREATED_EVENT_VERSION_N_PLUS,
      payload: collectionCreatedPayloadV2(),
    })]);
    const { sink, outbox } = makeWorker(repository);
    assert.equal(await outbox.runOnce(), true);
    assert.equal(sink.deliveries[0]?.eventVersion, 2);
  });

  test('old worker (N-1 routes) fails closed on @2 and keeps row retriable', async () => {
    const repository = new FakeRepository([claim({
      eventVersion: COLLECTION_CREATED_EVENT_VERSION_N_PLUS,
      payload: collectionCreatedPayloadV2(),
    })]);
    const { sink, outbox } = makeWorker(repository, { nMinus1Only: true });
    assert.equal(await outbox.runOnce(), true);
    assert.equal(sink.deliveries.length, 0);
    assert.equal(repository.completed.length, 0);
    assert.equal(repository.failures.length, 1);
    assert.match(repository.failures[0]!.error, /unsupported outbox event|unknown outbox route/i);
    assert.equal(repository.events.includes('fail:retryable'), true);
  });

  test('unknown event type on claim is fail-closed (retryable), never completed', async () => {
    const repository = new FakeRepository([claim({
      eventType: 'resource.updated',
      handlerName: 'search-projection',
      payload: { resource_id: 'r', title: 't' },
    })]);
    const { outbox } = makeWorker(repository);
    assert.equal(await outbox.runOnce(), true);
    assert.equal(repository.completed.length, 0);
    assert.equal(repository.failures.length, 1);
  });

  test('handler failure records retryable failure; dead-letter disposition path', async () => {
    const repository = new FakeRepository([claim()]);
    repository.failureDisposition = 'retryable';
    const { outbox } = makeWorker(repository, { failHandler: true });
    assert.equal(await outbox.runOnce(), true);
    assert.equal(repository.failures[0]?.error.includes('projected side effect failed'), true);
    assert.equal(repository.completed.length, 0);

    const dead = new FakeRepository([claim({ attemptCount: 3 })]);
    dead.failureDisposition = 'dead_letter';
    const second = makeWorker(dead, { failHandler: true });
    assert.equal(await second.outbox.runOnce(), true);
    assert.equal(dead.events.includes('fail:dead_letter'), true);
  });

  test('crash-after-side-effect: redelivery is idempotent on event_id', async () => {
    const sink = new RecordingDurableProjectionSink();
    await sink.apply({
      eventId: 'event-col-1',
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      eventVersion: 1,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      idempotencyKey: 'event-col-1',
      aggregateId: 'col-1',
      aggregateScope: 'col-1',
      commitOrdinal: '1',
    });
    const repository = new FakeRepository([claim()]);
    const { outbox } = makeWorker(repository, { sink });
    assert.equal(await outbox.runOnce(), true);
    assert.equal(sink.deliveries.length, 1);
    assert.equal(repository.completed.length, 1);
  });

  test('node.created@1 route dispatches independently of collection events', async () => {
    const repository = new FakeRepository([claim({
      outboxId: 'outbox-node',
      eventId: 'event-node-1',
      eventType: NODE_CREATED_EVENT_TYPE,
      eventVersion: 1,
      handlerName: NODE_CREATED_HANDLER_NAME,
      aggregateType: 'node',
      aggregateId: 'node-1',
      payload: {
        collectionId: 'c',
        nodeId: 'n',
        parentId: 'p',
        kind: 'bookmark',
        resourceRevision: 'r',
        contentRevision: 'cr',
        policyRevision: 'pr',
        parentChildrenRevision: 'pcr',
      },
    })]);
    const { sink, outbox } = makeWorker(repository);
    assert.equal(await outbox.runOnce(), true);
    assert.equal(sink.deliveries[0]?.eventType, NODE_CREATED_EVENT_TYPE);
    assert.equal(sink.deliveries[0]?.handlerName, NODE_CREATED_HANDLER_NAME);
  });  test('node.restored@1 route dispatches independently of collection events', async () => {
    const repository = new FakeRepository([claim({
      outboxId: 'outbox-node',
      eventId: 'event-node-1',
      eventType: 'node.restored',
      eventVersion: 1,
      handlerName: 'node_restored_projection',
      aggregateType: 'node',
      aggregateId: 'node-1',
      payload: {
        collectionId: 'c',
        nodeId: 'n',
        parentId: 'p',
        kind: 'bookmark',
        resourceRevision: 'r',
        contentRevision: 'cr',
        policyRevision: 'pr',
        parentChildrenRevision: 'pcr',
      },
    })]);
    const { sink, outbox } = makeWorker(repository);
    assert.equal(await outbox.runOnce(), true);
    assert.equal(sink.deliveries[0]?.eventType, 'node.restored');
    assert.equal(sink.deliveries[0]?.handlerName, 'node_restored_projection');
  });
});

describe('projection sink durability (Task 11)', () => {
  test('production composition rejects a transient memory projection sink', () => {
    const memory = new MemoryCollectionMutationProjectionSink();
    assert.equal(memory.durability, 'transient');
    assert.throws(
      () => createProductionCollectionMutationOutboxRouter({ sink: memory }),
      TransientProjectionCompositionError,
    );
    assert.throws(
      () => createCollectionMutationOutboxRoutes({ sink: memory }),
      TransientProjectionCompositionError,
    );
    assert.throws(
      () => createCollectionMutationOutboxRoutes({}),
      TransientProjectionCompositionError,
    );
    // Explicit harness memory mode remains available.
    const harnessRoutes = createCollectionMutationOutboxRoutes({
      allowTransientProjectionSink: true,
    });
    assert.ok(harnessRoutes.length > 0);
    assert.equal(harnessRoutes[0]?.sideEffectDurability, 'transient');
    assert.throws(
      () => assertProductionOutboxRouteDurability(harnessRoutes),
      TransientProjectionCompositionError,
    );
  });

  test('production bootstrap refuses transient sinks and never defaults to memory completion', () => {
    assert.deepEqual(composeProductionOutboxProjectionRoutes({}), []);
    assert.throws(
      () => composeProductionOutboxProjectionRoutes({
        projectionSink: new MemoryCollectionMutationProjectionSink(),
      }),
      TransientProjectionCompositionError,
    );

    const durable = new RecordingDurableProjectionSink();
    const routes = composeProductionOutboxProjectionRoutes({ projectionSink: durable });
    assert.ok(routes.length > 0);
    assert.equal(assertProductionOutboxRouteDurability(routes).allDurable, true);

    const metrics = new InMemoryMetrics();
    // Without a database, routes stay empty unless an explicit durable sink is injected.
    const workerWithoutDb = buildWorker(
      loadConfig({ DATABASE_URL: 'postgres://localhost/known',
        OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' }),
      undefined,
      metrics,
    );
    assert.equal(workerWithoutDb.outbox, undefined);
    assert.equal(workerWithoutDb.projectionSink, undefined);
    assert.equal(metrics.get('outbox.projection_routes'), 0);

    const metricsWithSink = new InMemoryMetrics();
    const workerRuntime = buildWorker(
      loadConfig({ DATABASE_URL: 'postgres://localhost/known',
        OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' }),
      undefined,
      metricsWithSink,
      { projectionSink: durable },
    );
    assert.equal(metricsWithSink.get('outbox.projection_all_durable'), 1);
    assert.equal(metricsWithSink.get('outbox.projection_transient_routes'), 0);
    assert.equal(workerRuntime.outbox, undefined);
    assert.equal(workerRuntime.projectionSink, durable);
  });

  test('transient handler is refused before side effects or completion', async () => {
    const repository = new FakeRepository([claim()]);
    const sink = new MemoryCollectionMutationProjectionSink();
    const metrics = new InMemoryMetrics();
    const routes = createCollectionMutationOutboxRoutes({
      sink,
      allowTransientProjectionSink: true,
    });
    const outbox = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter(routes),
      envelopes: createCollectionMutationEnvelopeRegistry(),
      logger,
      metrics,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 50, maxDelayMs: 200, maxAttempts: 3, jitterRatio: 0,
      }),
      // Production default: do not acknowledge transient side effects.
      acknowledgeTransientSideEffects: false,
    });

    assert.equal(await outbox.runOnce(), true);
    assert.equal(sink.deliveries.length, 0);
    assert.equal(repository.completed.length, 0);
    assert.equal(repository.failures.length, 1);
    assert.match(repository.failures[0]!.error, /transient projection side effect/i);
    assert.equal(metrics.get('outbox.transient_completion_refused'), 1);
    assert.equal(outbox.projectionReadiness().allDurable, false);
  });

  test('durable handler completes only after apply resolves (post-commit)', async () => {
    const repository = new FakeRepository([claim()]);
    const order: string[] = [];
    const sink = new RecordingDurableProjectionSink();
    const apply = sink.apply.bind(sink);
    sink.apply = async (delivery) => {
      order.push('apply:begin');
      await apply(delivery);
      order.push(`apply:commit:${delivery.eventId}`);
    };
    const originalComplete = repository.complete.bind(repository);
    repository.complete = async (seen) => {
      order.push('complete');
      return originalComplete(seen);
    };
    const { outbox } = makeWorker(repository, { sink });
    assert.equal(await outbox.runOnce(), true);
    assert.deepEqual(order, [
      'apply:begin',
      'apply:commit:event-col-1',
      'complete',
    ]);
    assert.equal(repository.completed.length, 1);
  });

  test('crash after durable apply leaves row for replay; redelivery is idempotent', async () => {
    const sink = new RecordingDurableProjectionSink();
    sink.failAfterApply = new Error('crash after durable projection commit');
    const firstRepo = new FakeRepository([claim({ attemptCount: 1, leaseGeneration: '1' })]);
    const first = makeWorker(firstRepo, { sink });
    assert.equal(await first.outbox.runOnce(), true);
    assert.equal(firstRepo.completed.length, 0);
    assert.equal(firstRepo.failures.length, 1);
    assert.equal(sink.deliveries.length, 1);

    // Restart / redelivery: apply is idempotent; success completes only after apply returns.
    sink.failAfterApply = undefined;
    const secondRepo = new FakeRepository([claim({ attemptCount: 2, leaseGeneration: '2' })]);
    const second = makeWorker(secondRepo, { sink });
    assert.equal(await second.outbox.runOnce(), true);
    assert.equal(sink.deliveries.length, 1);
    assert.equal(secondRepo.completed.length, 1);
    assert.equal(secondRepo.failures.length, 0);
  });

  test('durability is not inferred from class names', () => {
    class LooksDurableButIsNot implements CollectionMutationProjectionSink {
      readonly durability = 'transient' as const;
      async apply(): Promise<void> {}
    }
    class MemoryNamedButDurable implements CollectionMutationProjectionSink {
      readonly durability = 'durable' as const;
      async apply(): Promise<void> {}
    }
    assert.throws(
      () => createProductionCollectionMutationOutboxRouter({
        sink: new LooksDurableButIsNot(),
      }),
      TransientProjectionCompositionError,
    );
    assert.doesNotThrow(() => createProductionCollectionMutationOutboxRouter({
      sink: new MemoryNamedButDurable(),
    }));
  });

  test('TransientSideEffectCompletionError is the closed failure signal', () => {
    const error = new TransientSideEffectCompletionError('refusing completion');
    assert.equal(error.name, 'TransientSideEffectCompletionError');
  });
});
