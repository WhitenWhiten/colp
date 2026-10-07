import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  EventEnvelopeRegistry,
  OutboxRouter,
  VersionedOutboxWorker,
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
  readonly completed: OutboxClaim[] = [];
  constructor(readonly claims: OutboxClaim[]) {}
  async claim(): Promise<OutboxClaim | null> {
    return this.claims.shift() ?? null;
  }
  async inspectBacklog() { return { count: 0, oldestAgeMs: 0 }; }
  async heartbeat(): Promise<boolean> { return true; }
  async isObsoleteProjection(): Promise<boolean> { return false; }
  async hasDeliveryReceipt(): Promise<boolean> { return false; }
  async complete(seen: OutboxClaim): Promise<boolean> {
    this.completed.push(seen);
    return true;
  }
  async continue(): Promise<boolean> { return true; }
  async fail(): Promise<FailureDisposition> { return 'retryable'; }
}

const logger: OutboxWorkerLogger = {
  info() {},
  warn() {},
  error() {},
};

async function waitUntil(predicate: () => boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > 2_000) {
        reject(new Error('timed out waiting for outbox handler'));
        return;
      }
      setImmediate(check);
    };
    check();
  });
}

describe('Outbox worker shutdown deadline', () => {
  test('refuses a non-positive shutdown deadline', () => {
    assert.throws(() => new VersionedOutboxWorker({
      repository: new FakeRepository([]),
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
      shutdownDeadlineMs: 0,
    }), /invalid outbox worker timing configuration/);
  });

  test('stop returns after the shutdown deadline when a handler ignores abort', async () => {
    const metrics = new InMemoryMetrics();
    let entered = 0;
    const worker = new VersionedOutboxWorker({
      repository: new FakeRepository([claim()]),
      router: new OutboxRouter([{
        handlerName: 'search-projection',
        handlerMode: 'projection_latest_only',
        sideEffectDurability: 'durable',
        eventType: 'resource.updated',
        eventVersion: 1,
        async handle() {
          entered += 1;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 30_000).unref?.();
          });
        },
      }]),
      envelopes: registry(),
      logger,
      metrics,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      handlerTimeoutMs: 10_000,
      shutdownDeadlineMs: 80,
      maxConcurrentHandlers: 1,
      batchSize: 1,
      pollIntervalMs: 15,
    });
    worker.start();
    await waitUntil(() => entered >= 1);
    const started = Date.now();
    await worker.stop();
    assert.ok(Date.now() - started < 2_000);
    assert.equal(metrics.get('outbox.shutdown_deadline_exceeded'), 1);
  });

  test('stop does not trip the deadline when the handler honors abort', async () => {
    const metrics = new InMemoryMetrics();
    let entered = 0;
    const worker = new VersionedOutboxWorker({
      repository: new FakeRepository([claim()]),
      router: new OutboxRouter([{
        handlerName: 'search-projection',
        handlerMode: 'projection_latest_only',
        sideEffectDurability: 'durable',
        eventType: 'resource.updated',
        eventVersion: 1,
        async handle({ signal }) {
          entered += 1;
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => reject(new Error('aborted'));
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
          });
        },
      }]),
      envelopes: registry(),
      logger,
      metrics,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      handlerTimeoutMs: 10_000,
      shutdownDeadlineMs: 2_000,
      maxConcurrentHandlers: 1,
      batchSize: 1,
      pollIntervalMs: 15,
    });
    worker.start();
    await waitUntil(() => entered >= 1);
    await worker.stop();
    assert.equal(metrics.get('outbox.shutdown_deadline_exceeded'), 0);
  });
});
