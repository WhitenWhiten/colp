import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  EventEnvelopeRegistry,
  InvalidEventEnvelopeError,
  OutboxRouter,
  UnknownOutboxRouteError,
  UnsupportedEventVersionError,
  VersionedOutboxWorker,
  createExponentialRetryPolicy,
  defineClosedPayloadValidator,
  type FailureDisposition,
  type OutboxClaim,
  type OutboxRepository,
  type OutboxWorkerLogger,
} from '../../../src/infrastructure/outbox/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

const payloadValidator = defineClosedPayloadValidator({
  resource_id: (value) => typeof value === 'string' && value.length > 0,
  title: (value) => typeof value === 'string',
});

function registry() {
  return new EventEnvelopeRegistry([
    { eventType: 'resource.updated', eventVersion: 1, validatePayload: payloadValidator },
  ]);
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'event-1',
    event_type: 'resource.updated',
    event_version: 1,
    aggregate_identity: {
      aggregate_type: 'note',
      aggregate_id: 'resource-1',
      aggregate_scope: 'collection-1',
    },
    aggregate_revision: 'r-5',
    commit_ordinal: '5',
    occurred_at: '2026-07-22T00:00:00.000Z',
    payload: { resource_id: 'resource-1', title: 'Updated' },
    ...overrides,
  };
}

function claim(overrides: Partial<OutboxClaim> = {}): OutboxClaim {
  return {
    outboxId: 'outbox-1',
    eventId: 'event-1',
    eventType: 'resource.updated',
    eventVersion: 1,
    handlerName: 'search-projection',
    handlerMode: 'projection_latest_only',
    aggregateType: 'note',
    aggregateId: 'resource-1',
    aggregateScope: 'collection-1',
    aggregateRevision: 'r-5',
    commitOrdinal: '5',
    occurredAt: new Date('2026-07-22T00:00:00.000Z'),
    payload: { resource_id: 'resource-1', title: 'Updated' },
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
  lockHeld = false;
  backlog = { count: 2, oldestAgeMs: 750 };
  backlogInspections = 0;
  private heartbeatWaiters: Array<() => void> = [];

  constructor(readonly claims: OutboxClaim[]) {}

  async claim(): Promise<OutboxClaim | null> {
    this.events.push('claim:begin');
    this.lockHeld = true;
    const next = this.claims.shift() ?? null;
    this.lockHeld = false;
    this.events.push('claim:committed');
    return next;
  }

  async inspectBacklog() {
    this.backlogInspections += 1;
    return this.backlog;
  }

  async heartbeat(): Promise<boolean> {
    this.heartbeatWaiters.shift()?.();
    return true;
  }

  nextHeartbeat(): Promise<void> {
    return new Promise((resolve) => { this.heartbeatWaiters.push(resolve); });
  }
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

function worker(
  repository: FakeRepository,
  routes: ConstructorParameters<typeof OutboxRouter>[0],
  envelopes = registry(),
) {
  return new VersionedOutboxWorker({
    repository,
    router: new OutboxRouter(routes),
    envelopes,
    logger,
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 5_000,
    retryPolicy: createExponentialRetryPolicy({
      baseDelayMs: 100,
      maxDelayMs: 400,
      maxAttempts: 3,
      jitterRatio: 0,
    }),
  });
}

describe('versioned event envelope', () => {
  test('accepts the registered event version and preserves decimal commit ordinals', () => {
    const validated = registry().validate(envelope());
    assert.equal(validated.event_version, 1);
    assert.equal(validated.commit_ordinal, '5');
    assert.deepEqual(Object.keys(validated).sort(), [
      'aggregate_identity', 'aggregate_revision', 'commit_ordinal', 'event_id',
      'event_type', 'event_version', 'occurred_at', 'payload',
    ]);
  });

  test('accepts generated base64url and explicit event ids containing underscores', () => {
    const generatedBase64urlIds = [255, 248].map((firstByte) => (
      Buffer.from([firstByte, ...Array<number>(15).fill(0)]).toString('base64url')
    ));
    assert.match(generatedBase64urlIds[0]!, /^_/);
    assert.match(generatedBase64urlIds[1]!, /^-/);
    for (const eventId of generatedBase64urlIds) {
      assert.equal(registry().validate(envelope({ event_id: eventId })).event_id, eventId);
    }
    assert.equal(registry().validate(envelope({ event_id: 'explicit_event_id' })).event_id, 'explicit_event_id');
    assert.throws(
      () => registry().validate(envelope({ event_id: 'event/id' })),
      InvalidEventEnvelopeError,
    );
  });

  test('rejects unknown event versions without casting or fallback', () => {
    assert.throws(
      () => registry().validate(envelope({ event_version: 2 })),
      (error: unknown) => error instanceof UnsupportedEventVersionError
        && error.eventType === 'resource.updated'
        && error.eventVersion === 2,
    );
  });

  test('enforces closed envelope, aggregate identity, and versioned payload objects', () => {
    assert.throws(
      () => registry().validate(envelope({ unexpected: true })),
      InvalidEventEnvelopeError,
    );
    assert.throws(
      () => registry().validate(envelope({
        aggregate_identity: {
          aggregate_type: 'note', aggregate_id: 'resource-1', aggregate_scope: null, extra: true,
        },
      })),
      InvalidEventEnvelopeError,
    );
    assert.throws(
      () => registry().validate(envelope({
        payload: { resource_id: 'resource-1', title: 'Updated', handler_name: 'must-not-leak' },
      })),
      InvalidEventEnvelopeError,
    );
  });
});

describe('static outbox routing', () => {
  test('requires an exact handler, mode, event type, and event version match', () => {
    const route = {
      handlerName: 'search-projection',
      handlerMode: 'projection_latest_only' as const,
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated',
      eventVersion: 1,
      async handle() {},
    };
    const router = new OutboxRouter([route]);
    const resolved = router.resolve(claim());
    assert.equal(resolved.handlerName, route.handlerName);
    assert.equal(resolved.handlerMode, route.handlerMode);
    assert.equal(resolved.handle, route.handle);
    assert.throws(() => router.resolve(claim({ eventVersion: 2 })), UnknownOutboxRouteError);
    assert.throws(
      () => router.resolve(claim({ handlerMode: 'delivery_each_event' })),
      UnknownOutboxRouteError,
    );
  });

  test('rejects duplicate static routes at composition time', () => {
    const route = {
      handlerName: 'search-projection',
      handlerMode: 'projection_latest_only' as const,
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated',
      eventVersion: 1,
      async handle() {},
    };
    assert.throws(() => new OutboxRouter([route, route]), /duplicate outbox route/);
  });

  test('dispatches one claimed row to exactly one configured handler', async () => {
    const repository = new FakeRepository([claim()]);
    const handled: string[] = [];
    const routes = [
      {
        handlerName: 'search-projection', handlerMode: 'projection_latest_only' as const,
      sideEffectDurability: 'durable' as const,
        eventType: 'resource.updated', eventVersion: 1,
        async handle() { handled.push('search-projection'); },
      },
      {
        handlerName: 'another-handler', handlerMode: 'delivery_each_event' as const,
      sideEffectDurability: 'durable' as const,
        eventType: 'resource.updated', eventVersion: 1,
        async handle() { handled.push('another-handler'); },
      },
    ];
    await worker(repository, routes).runOnce();
    assert.deepEqual(handled, ['search-projection']);
    assert.equal(repository.completed.length, 1);
  });
});

describe('outbox worker delivery semantics', () => {
  test('does not claim when the route or envelope registry is empty', async () => {
    const noRoutes = new FakeRepository([claim()]);
    assert.equal(await worker(noRoutes, []).runOnce(), false);
    assert.deepEqual(noRoutes.events, []);

    const noEnvelopes = new FakeRepository([claim()]);
    assert.equal(await worker(noEnvelopes, [{
      handlerName: 'search-projection', handlerMode: 'projection_latest_only',
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated', eventVersion: 1,
      async handle() {},
    }], new EventEnvelopeRegistry([])).runOnce(), false);
    assert.deepEqual(noEnvelopes.events, []);
  });

  test('records claim latency, heartbeat, handler duration, and retry metrics without scanning backlog per claim', async () => {
    const repository = new FakeRepository([
      claim({ outboxId: 'metrics-success' }),
      claim({ outboxId: 'metrics-retry', attemptCount: 1 }),
    ]);
    const metrics = new InMemoryMetrics();
    let calls = 0;
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        handlerName: 'search-projection', handlerMode: 'projection_latest_only',
      sideEffectDurability: 'durable' as const,
        eventType: 'resource.updated', eventVersion: 1,
        async handle() {
          calls += 1;
          await repository.nextHeartbeat();
          if (calls === 2) throw new Error('retryable');
        },
      }]),
      envelopes: registry(), logger, metrics,
      leaseDurationMs: 100, heartbeatIntervalMs: 5,
      retryPolicy: createExponentialRetryPolicy({ baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 3, jitterRatio: 0 }),
    });

    await outboxWorker.runOnce();
    await outboxWorker.runOnce();
    assert.equal(repository.backlogInspections, 0);
    assert.equal(metrics.get('outbox.heartbeat') > 0, true);
    assert.equal(metrics.get('outbox.retryable'), 1);
    assert.equal(metrics.observations('outbox.claim_latency_ms').length, 2);
    assert.equal(metrics.observations('outbox.heartbeat_duration_ms').length > 0, true);
    assert.equal(metrics.observations('outbox.handler_duration_ms').length, 2);
  });

  test('samples backlog on an independent cadence when the worker loop is started', async () => {
    const repository = new FakeRepository([]);
    const metrics = new InMemoryMetrics();
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        handlerName: 'search-projection', handlerMode: 'projection_latest_only',
        sideEffectDurability: 'durable', eventType: 'resource.updated', eventVersion: 1,
        async handle() {},
      }]),
      envelopes: registry(), logger, metrics,
      leaseDurationMs: 100, heartbeatIntervalMs: 50,
      pollIntervalMs: 10, backlogSampleIntervalMs: 60_000,
    });

    outboxWorker.start();
    while (repository.backlogInspections === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await outboxWorker.stop();

    assert.equal(repository.backlogInspections, 1);
    assert.equal(metrics.get('outbox.backlog'), 2);
    assert.equal(metrics.get('outbox.oldest_age_ms'), 750);
  });

  test('redacts handler errors consistently in persistence and logs', async () => {
    const repository = new FakeRepository([claim()]);
    const logged: object[] = [];
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        handlerName: 'search-projection', handlerMode: 'projection_latest_only',
      sideEffectDurability: 'durable' as const,
        eventType: 'resource.updated', eventVersion: 1,
        async handle() { throw new Error('Authorization: Bearer handler-secret'); },
      }]),
      envelopes: registry(),
      logger: { info() {}, warn(bindings) { logged.push(bindings); }, error(bindings) { logged.push(bindings); } },
      leaseDurationMs: 100, heartbeatIntervalMs: 50,
    });

    await outboxWorker.runOnce();
    assert.doesNotMatch(repository.failures[0]?.error ?? '', /handler-secret/);
    assert.doesNotMatch(JSON.stringify(logged), /handler-secret/);
  });

  test('keeps an abort-ignoring timed-out handler in the concurrency budget until it settles', async () => {
    const repository = new FakeRepository([
      claim({ outboxId: 'outbox-timeout', eventId: 'event-timeout' }),
      claim({ outboxId: 'outbox-recovery', eventId: 'event-recovery' }),
    ]);
    let calls = 0;
    let releaseTimedOutHandler: (() => void) | undefined;
    const timedOutHandlerGate = new Promise<void>((resolve) => { releaseTimedOutHandler = resolve; });
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        handlerName: 'search-projection', handlerMode: 'projection_latest_only',
      sideEffectDurability: 'durable' as const,
        eventType: 'resource.updated', eventVersion: 1,
        async handle() {
          calls += 1;
          if (calls === 1) await timedOutHandlerGate;
        },
      }]),
      envelopes: registry(),
      logger,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      handlerTimeoutMs: 20,
      maxConcurrentHandlers: 1,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 3, jitterRatio: 0,
      }),
    });

    assert.equal(await outboxWorker.runOnce(), true);
    assert.match(repository.failures[0]?.error ?? '', /exceeded 20ms deadline/);
    assert.equal(outboxWorker.concurrencyReadiness().activeHandlers, 1);
    assert.equal(await outboxWorker.runOnce(), false);
    assert.equal(repository.claims.length, 1, 'must not claim while the timed-out handler still runs');

    releaseTimedOutHandler?.();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (outboxWorker.concurrencyReadiness().activeHandlers === 0) resolve();
        else setImmediate(check);
      };
      check();
    });
    assert.equal(await outboxWorker.runOnce(), true);
    assert.equal(calls, 2);
    assert.equal(repository.completed.at(-1)?.outboxId, 'outbox-recovery');
  });

  test('suppresses concurrent runOnce calls when the handler slot is occupied', async () => {
    const repository = new FakeRepository([
      claim({ outboxId: 'outbox-active' }),
      claim({ outboxId: 'outbox-waiting' }),
    ]);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        handlerName: 'search-projection', handlerMode: 'projection_latest_only',
      sideEffectDurability: 'durable' as const,
        eventType: 'resource.updated', eventVersion: 1,
        async handle() { entered?.(); await gate; },
      }]),
      envelopes: registry(),
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      maxConcurrentHandlers: 1,
    });

    const first = outboxWorker.runOnce();
    await started;
    assert.equal(await outboxWorker.runOnce(), false);
    assert.equal(repository.claims.length, 1);
    release?.();
    assert.equal(await first, true);
  });

  test('fails an unknown version closed and leaves it in retry/dead-letter handling', async () => {
    const repository = new FakeRepository([claim({ eventVersion: 99 })]);
    const handled: string[] = [];
    await worker(repository, [{
      handlerName: 'search-projection', handlerMode: 'projection_latest_only',
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated', eventVersion: 99,
      async handle() { handled.push('called'); },
    }]).runOnce();

    assert.deepEqual(handled, []);
    assert.equal(repository.completed.length, 0);
    assert.equal(repository.failures.length, 1);
    assert.match(repository.failures[0]?.error ?? '', /UnsupportedEventVersionError/);
  });

  test('does not hold the claim transaction lock during handler network work', async () => {
    const repository = new FakeRepository([claim()]);
    await worker(repository, [{
      handlerName: 'search-projection', handlerMode: 'projection_latest_only',
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated', eventVersion: 1,
      async handle() {
        assert.equal(repository.lockHeld, false);
        repository.events.push('handler:network');
      },
    }]).runOnce();

    assert.deepEqual(repository.events, [
      'claim:begin', 'claim:committed', 'handler:network', 'complete',
    ]);
  });

  test.each([
    ['projection_latest_only', true, false],
    ['delivery_each_event', false, true],
  ] as const)('skips an already applied %s row without calling the handler', async (
    handlerMode,
    obsoleteProjection,
    deliveryReceipt,
  ) => {
    const repository = new FakeRepository([claim({ handlerMode })]);
    repository.obsoleteProjection = obsoleteProjection;
    repository.deliveryReceipt = deliveryReceipt;
    let handled = 0;
    await worker(repository, [{
      handlerName: 'search-projection', handlerMode,
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated', eventVersion: 1,
      async handle() { handled += 1; },
    }]).runOnce();

    assert.equal(handled, 0);
    assert.equal(repository.completed.length, 1);
  });

  test('uses capped exponential backoff and dead-letters at the configured attempt limit', async () => {
    const retry = createExponentialRetryPolicy({
      baseDelayMs: 100, maxDelayMs: 400, maxAttempts: 3, jitterRatio: 0,
    });
    assert.deepEqual([1, 2, 3, 4].map((attempt) => retry.retryDelayMs(attempt)), [100, 200, 400, 400]);

    const repository = new FakeRepository([claim({ attemptCount: 3 })]);
    repository.failureDisposition = 'dead_letter';
    await worker(repository, [{
      handlerName: 'search-projection', handlerMode: 'projection_latest_only',
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated', eventVersion: 1,
      async handle() { throw new Error('permanent after retries'); },
    }]).runOnce();

    assert.equal(repository.failures[0]?.retryDelayMs, 400);
    assert.equal(repository.failures[0]?.maxAttempts, 3);
    assert.equal(repository.events.at(-1), 'fail:dead_letter');
  });

  test('reuses event_id as the idempotency key after a handler crashes post-side-effect', async () => {
    const first = claim({ attemptCount: 1, leaseGeneration: '1' });
    const retry = claim({ attemptCount: 2, leaseGeneration: '2' });
    const repository = new FakeRepository([first, retry]);
    const effects = new Set<string>();
    let handlerCalls = 0;
    const routes = [{
      handlerName: 'search-projection', handlerMode: 'projection_latest_only' as const,
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated', eventVersion: 1,
      async handle({ idempotencyKey }: { idempotencyKey: string }) {
        handlerCalls += 1;
        if (effects.has(idempotencyKey)) return;
        effects.add(idempotencyKey);
        throw new Error('crash after external side effect');
      },
    }];

    await worker(repository, routes).runOnce();
    await worker(repository, routes).runOnce();

    assert.equal(handlerCalls, 2);
    assert.deepEqual([...effects], ['event-1']);
    assert.equal(repository.failures.length, 1);
    assert.equal(repository.completed.length, 1);
    assert.equal(repository.failures[0]?.claim.eventId, repository.completed[0]?.eventId);
  });

  test('refuses transient routes before calling their side effects', async () => {
    const repository = new FakeRepository([claim()]);
    const metrics = new InMemoryMetrics();
    let handled = 0;
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        handlerName: 'search-projection',
        handlerMode: 'projection_latest_only',
        sideEffectDurability: 'transient',
        eventType: 'resource.updated',
        eventVersion: 1,
        async handle() { handled += 1; },
      }]),
      envelopes: registry(),
      logger,
      metrics,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 3, jitterRatio: 0,
      }),
    });

    assert.equal(await outboxWorker.runOnce(), true);
    assert.equal(handled, 0);
    assert.equal(repository.completed.length, 0);
    assert.equal(repository.failures.length, 1);
    assert.match(repository.failures[0]?.error ?? '', /transient projection side effect/i);
    assert.equal(metrics.get('outbox.transient_completion_refused'), 1);
    assert.equal(outboxWorker.projectionReadiness().allDurable, false);
  });

  test('completes durable side effects and exposes durability readiness telemetry', async () => {
    const repository = new FakeRepository([claim()]);
    const metrics = new InMemoryMetrics();
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        handlerName: 'search-projection',
        handlerMode: 'projection_latest_only',
        sideEffectDurability: 'durable',
        eventType: 'resource.updated',
        eventVersion: 1,
        async handle() {},
      }]),
      envelopes: registry(),
      logger,
      metrics,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
    });

    assert.equal(outboxWorker.projectionReadiness().allDurable, true);
    assert.equal(metrics.get('outbox.projection_all_durable'), 1);
    assert.equal(await outboxWorker.runOnce(), true);
    assert.equal(repository.completed.length, 1);
  });
});

describe('outbox worker bounded concurrency', () => {
  test('rejects invalid batch/concurrency timing combinations', () => {
    const repository = new FakeRepository([]);
    const route = {
      handlerName: 'search-projection',
      handlerMode: 'projection_latest_only' as const,
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated',
      eventVersion: 1,
      async handle() {},
    };
    assert.throws(
      () => new VersionedOutboxWorker({
        repository,
        router: new OutboxRouter([route]),
        envelopes: registry(),
        logger,
        maxConcurrentHandlers: 1,
        batchSize: 2,
      }),
      RangeError,
    );
    assert.throws(
      () => new VersionedOutboxWorker({
        repository,
        router: new OutboxRouter([route]),
        envelopes: registry(),
        logger,
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 500,
        handlerTimeoutMs: 2_000,
      }),
      RangeError,
    );
  });

  test('exposes concurrency readiness without secrets and caps concurrent runOnce', async () => {
    const repository = new FakeRepository([
      claim({ outboxId: 'a', eventId: 'event-a', aggregateScope: 'scope-a' }),
      claim({ outboxId: 'b', eventId: 'event-b', aggregateScope: 'scope-b' }),
      claim({ outboxId: 'c', eventId: 'event-c', aggregateScope: 'scope-c' }),
    ]);
    let inFlight = 0;
    let peak = 0;
    const releaseGates: Array<() => void> = [];
    const entered: Array<() => void> = [];
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        handlerName: 'search-projection',
        handlerMode: 'projection_latest_only',
        sideEffectDurability: 'durable',
        eventType: 'resource.updated',
        eventVersion: 1,
        async handle() {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => {
            releaseGates.push(resolve);
            entered.push(() => undefined);
          });
          inFlight -= 1;
        },
      }]),
      envelopes: registry(),
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      maxConcurrentHandlers: 2,
      batchSize: 2,
      pollIntervalMs: 20,
    });

    assert.deepEqual(outboxWorker.concurrencyReadiness(), {
      batchSize: 2,
      pollIntervalMs: 20,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      handlerTimeoutMs: 10_000,
      maxConcurrentHandlers: 2,
      activeHandlers: 0,
      running: false,
    });

    const first = outboxWorker.runOnce();
    const second = outboxWorker.runOnce();
    // Wait until both handlers are inside the gate.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (inFlight >= 2) resolve();
        else setImmediate(check);
      };
      check();
    });
    assert.equal(await outboxWorker.runOnce(), false);
    assert.equal(outboxWorker.concurrencyReadiness().activeHandlers, 2);
    assert.equal(peak, 2);

    for (const release of releaseGates.splice(0)) release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(outboxWorker.concurrencyReadiness().activeHandlers, 0);
  });

  test('start/stop drains in-flight handlers without leaving the loop hung', async () => {
    const repository = new FakeRepository([
      claim({ outboxId: 'drain-1', eventId: 'event-drain-1', aggregateScope: 'scope-1' }),
      claim({ outboxId: 'drain-2', eventId: 'event-drain-2', aggregateScope: 'scope-2' }),
    ]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        handlerName: 'search-projection',
        handlerMode: 'projection_latest_only',
        sideEffectDurability: 'durable',
        eventType: 'resource.updated',
        eventVersion: 1,
        async handle({ signal }) {
          entered += 1;
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(new Error('aborted'));
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            void gate.then(() => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            });
          });
        },
      }]),
      envelopes: registry(),
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      maxConcurrentHandlers: 2,
      batchSize: 2,
      pollIntervalMs: 15,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 3, jitterRatio: 0,
      }),
    });

    outboxWorker.start();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (entered >= 1) resolve();
        else setImmediate(check);
      };
      check();
    });
    assert.equal(outboxWorker.concurrencyReadiness().running, true);

    const stopPromise = outboxWorker.stop();
    // Handlers are aborted on stop; release the gate too so any non-abort path can finish.
    release?.();
    await stopPromise;
    assert.equal(outboxWorker.concurrencyReadiness().running, false);
    assert.equal(outboxWorker.concurrencyReadiness().activeHandlers, 0);
  });

  test('ordering-sensitive projection scopes never run concurrently for the same scope', async () => {
    /**
     * Fake repository mirrors production SKIP LOCKED + active-lease fence:
     * only one leased projection_latest_only claim per handler/scope at a time.
     */
    class ScopeAwareRepository implements OutboxRepository {
      readonly completed: OutboxClaim[] = [];
      private readonly queue: OutboxClaim[];
      private readonly leasedScopes = new Set<string>();

      constructor(claims: OutboxClaim[]) {
        this.queue = [...claims];
      }

      async claim(): Promise<OutboxClaim | null> {
        const index = this.queue.findIndex((item) => {
          if (item.handlerMode !== 'projection_latest_only' || item.aggregateScope === null) {
            return true;
          }
          return !this.leasedScopes.has(`${item.handlerName}:${item.aggregateScope}`);
        });
        if (index < 0) return null;
        const next = this.queue.splice(index, 1)[0]!;
        if (next.aggregateScope !== null) {
          this.leasedScopes.add(`${next.handlerName}:${next.aggregateScope}`);
        }
        return next;
      }

      async inspectBacklog() { return { count: this.queue.length, oldestAgeMs: 0 }; }
      async heartbeat() { return true; }
      async isObsoleteProjection() { return false; }
      async hasDeliveryReceipt() { return false; }

      async complete(seen: OutboxClaim): Promise<boolean> {
        if (seen.aggregateScope !== null) {
          this.leasedScopes.delete(`${seen.handlerName}:${seen.aggregateScope}`);
        }
        this.completed.push(seen);
        return true;
      }

      async continue(seen: OutboxClaim): Promise<boolean> {
        if (seen.aggregateScope !== null) {
          this.leasedScopes.delete(`${seen.handlerName}:${seen.aggregateScope}`);
        }
        return true;
      }

      async fail(
        seen: OutboxClaim,
        _error: string,
        _retryDelayMs: number,
        _maxAttempts: number,
      ): Promise<FailureDisposition> {
        if (seen.aggregateScope !== null) {
          this.leasedScopes.delete(`${seen.handlerName}:${seen.aggregateScope}`);
        }
        return 'retryable';
      }
    }

    const route = {
      handlerName: 'search-projection',
      handlerMode: 'projection_latest_only' as const,
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated',
      eventVersion: 1,
      async handle() {},
    };

    // Same scope: second concurrent claim must be fenced while the first is leased.
    const sameScopeRepo = new ScopeAwareRepository([
      claim({
        outboxId: 'same-1', eventId: 'event-same-1', aggregateScope: 'shared-scope',
        commitOrdinal: '1', aggregateRevision: 'r-1',
      }),
      claim({
        outboxId: 'same-2', eventId: 'event-same-2', aggregateScope: 'shared-scope',
        commitOrdinal: '2', aggregateRevision: 'r-2',
      }),
    ]);
    let releaseSame: (() => void) | undefined;
    let sameEntered: (() => void) | undefined;
    const sameStarted = new Promise<void>((resolve) => { sameEntered = resolve; });
    const sameGate = new Promise<void>((resolve) => { releaseSame = resolve; });
    let sameInFlight = 0;
    let samePeak = 0;
    const sameWorker = new VersionedOutboxWorker({
      repository: sameScopeRepo,
      router: new OutboxRouter([{
        ...route,
        async handle() {
          sameInFlight += 1;
          samePeak = Math.max(samePeak, sameInFlight);
          sameEntered?.();
          await sameGate;
          sameInFlight -= 1;
        },
      }]),
      envelopes: registry(),
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      maxConcurrentHandlers: 2,
      batchSize: 2,
    });

    const firstSame = sameWorker.runOnce();
    await sameStarted;
    assert.equal(await sameWorker.runOnce(), false, 'second same-scope claim must be fenced');
    assert.equal(samePeak, 1);
    releaseSame?.();
    assert.equal(await firstSame, true);
    assert.equal(await sameWorker.runOnce(), true, 'second same-scope event is claimable after release');
    assert.equal(sameScopeRepo.completed.length, 2);
    assert.equal(samePeak, 1);

    // Distinct scopes: concurrency > 1 may process them in parallel.
    const crossRepo = new ScopeAwareRepository([
      claim({
        outboxId: 'scope-a', eventId: 'event-a', aggregateScope: 'scope-a',
        commitOrdinal: '1', aggregateRevision: 'r-1',
      }),
      claim({
        outboxId: 'scope-b', eventId: 'event-b', aggregateScope: 'scope-b',
        commitOrdinal: '1', aggregateRevision: 'r-1',
      }),
    ]);
    let crossInFlight = 0;
    let crossPeak = 0;
    const crossReleases: Array<() => void> = [];
    const crossWorker = new VersionedOutboxWorker({
      repository: crossRepo,
      router: new OutboxRouter([{
        ...route,
        async handle() {
          crossInFlight += 1;
          crossPeak = Math.max(crossPeak, crossInFlight);
          await new Promise<void>((resolve) => { crossReleases.push(resolve); });
          crossInFlight -= 1;
        },
      }]),
      envelopes: registry(),
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      maxConcurrentHandlers: 2,
      batchSize: 2,
    });

    const crossBatch = Promise.all([crossWorker.runOnce(), crossWorker.runOnce()]);
    await new Promise<void>((resolve) => {
      const check = () => {
        if (crossReleases.length >= 2) resolve();
        else setImmediate(check);
      };
      check();
    });
    assert.equal(crossPeak, 2, 'distinct scopes should run in parallel under concurrency=2');
    for (const release of crossReleases) release();
    assert.deepEqual(await crossBatch, [true, true]);
    assert.equal(crossRepo.completed.length, 2);
  });
});
