import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  EventEnvelopeRegistry,
  OutboxContinuationRequested,
  OutboxDeliveryError,
  OutboxRouter,
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

function baseClaim(overrides: Partial<OutboxClaim> = {}): OutboxClaim {
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

interface MemoryRow {
  outboxId: string;
  eventId: string;
  eventType: string;
  eventVersion: number;
  handlerName: string;
  handlerMode: OutboxClaim['handlerMode'];
  aggregateType: string;
  aggregateId: string;
  aggregateScope: string | null;
  aggregateRevision: string | null;
  commitOrdinal: string | null;
  occurredAt: Date;
  payload: unknown;
  attemptCount: number;
  leaseGeneration: number;
  state: 'pending' | 'leased' | 'retryable' | 'completed' | 'dead_letter';
  availableAtMs: number;
  lockedUntilMs: number | null;
  lastError: string | null;
  deadLetteredAtMs: number | null;
}

/** Lease-aware in-memory Outbox repository for continuation CAS unit evidence. */
class MemoryOutboxRepository implements OutboxRepository {
  readonly rows = new Map<string, MemoryRow>();
  readonly events: string[] = [];
  nowMs = Date.parse('2026-07-22T00:00:00.000Z');

  seed(row: Partial<MemoryRow> & Pick<MemoryRow, 'outboxId' | 'eventId'>): void {
    this.rows.set(row.outboxId, {
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
      attemptCount: 0,
      leaseGeneration: 0,
      state: 'pending',
      availableAtMs: this.nowMs,
      lockedUntilMs: null,
      lastError: null,
      deadLetteredAtMs: null,
      ...row,
    });
  }

  private toClaim(row: MemoryRow): OutboxClaim {
    return Object.freeze({
      outboxId: row.outboxId,
      eventId: row.eventId,
      eventType: row.eventType,
      eventVersion: row.eventVersion,
      handlerName: row.handlerName,
      handlerMode: row.handlerMode,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      aggregateScope: row.aggregateScope,
      aggregateRevision: row.aggregateRevision,
      commitOrdinal: row.commitOrdinal,
      occurredAt: row.occurredAt,
      payload: row.payload,
      attemptCount: row.attemptCount,
      leaseGeneration: String(row.leaseGeneration),
    });
  }

  async claim(leaseDurationMs: number): Promise<OutboxClaim | null> {
    this.events.push('claim');
    for (const row of this.rows.values()) {
      const available = (row.state === 'pending' || row.state === 'retryable')
        && row.availableAtMs <= this.nowMs;
      const expiredLease = row.state === 'leased'
        && row.lockedUntilMs !== null
        && row.lockedUntilMs <= this.nowMs;
      if (!available && !expiredLease) continue;
      row.state = 'leased';
      row.attemptCount += 1;
      row.leaseGeneration += 1;
      row.lockedUntilMs = this.nowMs + leaseDurationMs;
      row.lastError = null;
      return this.toClaim(row);
    }
    return null;
  }

  async inspectBacklog() {
    let count = 0;
    let oldest = 0;
    for (const row of this.rows.values()) {
      if (row.state === 'pending' || row.state === 'retryable' || row.state === 'leased') {
        count += 1;
        oldest = Math.max(oldest, this.nowMs - row.occurredAt.getTime());
      }
    }
    return { count, oldestAgeMs: oldest };
  }

  async heartbeat(claim: OutboxClaim, leaseDurationMs: number): Promise<boolean> {
    const row = this.rows.get(claim.outboxId);
    if (!row) return false;
    if (row.state !== 'leased') return false;
    if (String(row.leaseGeneration) !== claim.leaseGeneration) return false;
    if (row.lockedUntilMs === null || row.lockedUntilMs <= this.nowMs) return false;
    row.lockedUntilMs = this.nowMs + leaseDurationMs;
    this.events.push('heartbeat');
    return true;
  }

  async isObsoleteProjection(): Promise<boolean> { return false; }
  async hasDeliveryReceipt(): Promise<boolean> { return false; }

  async complete(claim: OutboxClaim): Promise<boolean> {
    const row = this.rows.get(claim.outboxId);
    if (!row) return false;
    if (row.state !== 'leased') return false;
    if (String(row.leaseGeneration) !== claim.leaseGeneration) return false;
    if (row.lockedUntilMs === null || row.lockedUntilMs <= this.nowMs) return false;
    row.state = 'completed';
    row.lockedUntilMs = null;
    this.events.push('complete');
    return true;
  }

  async continue(claim: OutboxClaim): Promise<boolean> {
    const row = this.rows.get(claim.outboxId);
    if (!row) return false;
    if (row.state !== 'leased') return false;
    if (String(row.leaseGeneration) !== claim.leaseGeneration) return false;
    if (row.lockedUntilMs === null || row.lockedUntilMs <= this.nowMs) return false;
    const preservedAvailableAt = row.availableAtMs;
    const preservedAttempts = row.attemptCount;
    row.state = 'pending';
    row.lockedUntilMs = null;
    row.lastError = null;
    row.availableAtMs = preservedAvailableAt;
    row.attemptCount = preservedAttempts;
    this.events.push('continue');
    return true;
  }

  async fail(
    claim: OutboxClaim,
    error: string,
    retryDelayMs: number,
    maxAttempts: number,
  ): Promise<FailureDisposition> {
    const row = this.rows.get(claim.outboxId);
    if (!row) return 'lease_lost';
    if (row.state !== 'leased') return 'lease_lost';
    if (String(row.leaseGeneration) !== claim.leaseGeneration) return 'lease_lost';
    if (row.lockedUntilMs === null || row.lockedUntilMs <= this.nowMs) return 'lease_lost';
    const deadLetter = claim.attemptCount >= maxAttempts;
    row.state = deadLetter ? 'dead_letter' : 'retryable';
    row.lockedUntilMs = null;
    row.lastError = error;
    if (!deadLetter) row.availableAtMs = this.nowMs + retryDelayMs;
    if (deadLetter) row.deadLetteredAtMs = this.nowMs;
    this.events.push(deadLetter ? 'fail:dead_letter' : 'fail:retryable');
    return deadLetter ? 'dead_letter' : 'retryable';
  }

  snapshot(outboxId: string): MemoryRow {
    const row = this.rows.get(outboxId);
    assert.ok(row);
    return { ...row };
  }
}

class SpyRepository implements OutboxRepository {
  readonly events: string[] = [];
  readonly continued: OutboxClaim[] = [];
  readonly completed: OutboxClaim[] = [];
  readonly failures: Array<{
    claim: OutboxClaim;
    error: string;
    retryDelayMs: number;
    maxAttempts: number;
  }> = [];
  continueResult = true;
  completeResult = true;
  failureDisposition: FailureDisposition = 'retryable';

  constructor(readonly claims: OutboxClaim[]) {}

  async claim(): Promise<OutboxClaim | null> {
    this.events.push('claim');
    return this.claims.shift() ?? null;
  }

  async inspectBacklog() { return { count: 0, oldestAgeMs: 0 }; }
  async heartbeat(): Promise<boolean> { return true; }
  async isObsoleteProjection(): Promise<boolean> { return false; }
  async hasDeliveryReceipt(): Promise<boolean> { return false; }

  async complete(seen: OutboxClaim): Promise<boolean> {
    this.completed.push(seen);
    this.events.push('complete');
    return this.completeResult;
  }

  async continue(seen: OutboxClaim): Promise<boolean> {
    this.continued.push(seen);
    this.events.push(this.continueResult ? 'continue' : 'continue:lease_lost');
    return this.continueResult;
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

const durableRoute = {
  handlerName: 'search-projection' as const,
  handlerMode: 'projection_latest_only' as const,
  sideEffectDurability: 'durable' as const,
  eventType: 'resource.updated',
  eventVersion: 1,
};

describe('memory OutboxRepository.continue CAS', () => {
  test('continue returns leased work to pending, preserves available_at and attempt_count, clears lease/error', async () => {
    const repository = new MemoryOutboxRepository();
    repository.seed({
      outboxId: 'outbox-continue',
      eventId: 'event-continue',
      availableAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      lastError: 'stale',
    });
    const claim = await repository.claim(10_000);
    assert.ok(claim);
    assert.equal(claim.attemptCount, 1);
    const before = repository.snapshot('outbox-continue');
    assert.equal(before.state, 'leased');
    assert.equal(before.availableAtMs, Date.parse('2026-01-01T00:00:00.000Z'));

    assert.equal(await repository.continue(claim), true);
    const after = repository.snapshot('outbox-continue');
    assert.equal(after.state, 'pending');
    assert.equal(after.lockedUntilMs, null);
    assert.equal(after.lastError, null);
    assert.equal(after.availableAtMs, before.availableAtMs);
    assert.equal(after.attemptCount, before.attemptCount);
    assert.equal(after.leaseGeneration, before.leaseGeneration);
    assert.deepEqual(repository.events, ['claim', 'continue']);
  });

  test('continue rejects foreign lease generation (takeover) and expired leases', async () => {
    const takeover = new MemoryOutboxRepository();
    takeover.seed({ outboxId: 'outbox-takeover', eventId: 'event-takeover' });
    const first = await takeover.claim(10_000);
    assert.ok(first);
    takeover.nowMs += 11_000;
    const second = await takeover.claim(10_000);
    assert.ok(second);
    assert.equal(second.leaseGeneration, '2');
    assert.equal(await takeover.continue(first), false);
    assert.equal(takeover.snapshot('outbox-takeover').state, 'leased');
    assert.equal(await takeover.continue(second), true);
    assert.equal(takeover.snapshot('outbox-takeover').state, 'pending');

    const expiredRepo = new MemoryOutboxRepository();
    expiredRepo.seed({ outboxId: 'outbox-expired', eventId: 'event-expired' });
    const expired = await expiredRepo.claim(1_000);
    assert.ok(expired);
    expiredRepo.nowMs += 2_000;
    assert.equal(await expiredRepo.continue(expired), false);
    assert.equal(expiredRepo.snapshot('outbox-expired').state, 'leased');
  });

  test('high attempt counts continue without dead-letter or last_error', async () => {
    const repository = new MemoryOutboxRepository();
    repository.seed({
      outboxId: 'outbox-hot',
      eventId: 'event-hot',
      attemptCount: 99,
    });
    const claim = await repository.claim(10_000);
    assert.ok(claim);
    assert.equal(claim.attemptCount, 100);
    assert.equal(await repository.continue(claim), true);
    const after = repository.snapshot('outbox-hot');
    assert.equal(after.state, 'pending');
    assert.equal(after.attemptCount, 100);
    assert.equal(after.lastError, null);
    assert.equal(after.deadLetteredAtMs, null);
  });

  test('ordinary retry, permanent dead-letter, and complete stay distinct from continue', async () => {
    const repository = new MemoryOutboxRepository();
    repository.seed({ outboxId: 'outbox-retry', eventId: 'event-retry' });
    const retryClaim = await repository.claim(10_000);
    assert.ok(retryClaim);
    assert.equal(await repository.fail(retryClaim, 'temporary', 5_000, 3), 'retryable');
    assert.equal(repository.snapshot('outbox-retry').state, 'retryable');
    assert.equal(repository.snapshot('outbox-retry').lastError, 'temporary');

    repository.seed({ outboxId: 'outbox-dead', eventId: 'event-dead', attemptCount: 2 });
    const deadClaim = await repository.claim(10_000);
    assert.ok(deadClaim);
    assert.equal(deadClaim.attemptCount, 3);
    assert.equal(await repository.fail(deadClaim, 'permanent', 5_000, 3), 'dead_letter');
    assert.equal(repository.snapshot('outbox-dead').state, 'dead_letter');

    repository.seed({ outboxId: 'outbox-done', eventId: 'event-done' });
    const done = await repository.claim(10_000);
    assert.ok(done);
    assert.equal(await repository.complete(done), true);
    assert.equal(repository.snapshot('outbox-done').state, 'completed');
    assert.equal(repository.events.includes('continue'), false);
  });

  test('heartbeat after continue loses the lease; continue after heartbeat still succeeds while leased', async () => {
    const repository = new MemoryOutboxRepository();
    repository.seed({ outboxId: 'outbox-race', eventId: 'event-race' });
    const claim = await repository.claim(10_000);
    assert.ok(claim);
    assert.equal(await repository.heartbeat(claim, 10_000), true);
    assert.equal(await repository.continue(claim), true);
    assert.equal(await repository.heartbeat(claim, 10_000), false);
    assert.equal(repository.snapshot('outbox-race').state, 'pending');
  });
});

describe('versioned outbox worker continuation control flow', () => {
  test('captures OutboxContinuationRequested, calls continue only, and records outbox.continued', async () => {
    const repository = new SpyRepository([baseClaim({ attemptCount: 50 })]);
    const metrics = new InMemoryMetrics();
    const effects = new Set<string>();
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        ...durableRoute,
        async handle({ idempotencyKey }) {
          effects.add(idempotencyKey);
          throw new OutboxContinuationRequested();
        },
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
    assert.deepEqual([...effects], ['event-1']);
    assert.equal(repository.continued.length, 1);
    assert.equal(repository.failures.length, 0);
    assert.equal(repository.completed.length, 0);
    assert.deepEqual(repository.events, ['claim', 'continue']);
    assert.equal(metrics.get('outbox.continued'), 1);
    assert.equal(metrics.get('outbox.retryable') ?? 0, 0);
    assert.equal(metrics.get('outbox.dead_letter') ?? 0, 0);
  });

  test('continuation CAS loss records lease_lost without fail()', async () => {
    const repository = new SpyRepository([baseClaim()]);
    repository.continueResult = false;
    const metrics = new InMemoryMetrics();
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        ...durableRoute,
        async handle() { throw new OutboxContinuationRequested(); },
      }]),
      envelopes: registry(),
      logger,
      metrics,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
    });

    assert.equal(await outboxWorker.runOnce(), true);
    assert.equal(repository.failures.length, 0);
    assert.equal(metrics.get('outbox.lease_lost'), 1);
    assert.equal(metrics.get('outbox.continued') ?? 0, 0);
  });

  test('side effect committed then crash before continue still replays via ordinary reclaim', async () => {
    const repository = new MemoryOutboxRepository();
    repository.seed({ outboxId: 'outbox-crash', eventId: 'event-crash' });
    const effects = new Set<string>();
    let calls = 0;
    const route = {
      ...durableRoute,
      async handle({ idempotencyKey }: { idempotencyKey: string }) {
        calls += 1;
        if (!effects.has(idempotencyKey)) {
          effects.add(idempotencyKey);
          // Simulate crash after side effect and before worker can call continue().
          throw new Error('crash after side effect before continuation');
        }
        throw new OutboxContinuationRequested();
      },
    };
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([route]),
      envelopes: registry(),
      logger,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 10, jitterRatio: 0,
      }),
    });

    assert.equal(await outboxWorker.runOnce(), true);
    assert.equal(repository.snapshot('outbox-crash').state, 'retryable');
    repository.nowMs += 2;
    assert.equal(await outboxWorker.runOnce(), true);
    assert.equal(calls, 2);
    assert.deepEqual([...effects], ['event-crash']);
    assert.equal(repository.snapshot('outbox-crash').state, 'pending');
    assert.equal(repository.snapshot('outbox-crash').lastError, null);
    assert.ok(repository.events.includes('continue'));
  });

  test('OutboxDeliveryError permanent and retryable paths remain unchanged', async () => {
    const permanentRepo = new SpyRepository([baseClaim({ attemptCount: 1 })]);
    await new VersionedOutboxWorker({
      repository: permanentRepo,
      router: new OutboxRouter([{
        ...durableRoute,
        async handle() { throw new OutboxDeliveryError('permanent', 'bad payload'); },
      }]),
      envelopes: registry(),
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 5, jitterRatio: 0,
      }),
    }).runOnce();
    assert.equal(permanentRepo.failures[0]?.maxAttempts, 1);
    assert.equal(permanentRepo.continued.length, 0);

    const retryRepo = new SpyRepository([baseClaim({ attemptCount: 1 })]);
    await new VersionedOutboxWorker({
      repository: retryRepo,
      router: new OutboxRouter([{
        ...durableRoute,
        async handle() { throw new OutboxDeliveryError('retryable', 'later'); },
      }]),
      envelopes: registry(),
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 5, jitterRatio: 0,
      }),
    }).runOnce();
    assert.equal(retryRepo.failures[0]?.maxAttempts, 5);
    assert.equal(retryRepo.continued.length, 0);
  });

  test('transient routes still refuse completion and do not use continuation by default', async () => {
    const repository = new SpyRepository([baseClaim()]);
    const metrics = new InMemoryMetrics();
    const outboxWorker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([{
        ...durableRoute,
        sideEffectDurability: 'transient',
        async handle() {},
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
    assert.equal(repository.completed.length, 0);
    assert.equal(repository.continued.length, 0);
    assert.equal(repository.failures.length, 1);
    assert.equal(metrics.get('outbox.transient_completion_refused'), 1);
  });

  test('OutboxContinuationRequested is not an OutboxDeliveryError', () => {
    const signal = new OutboxContinuationRequested();
    assert.equal(signal instanceof Error, true);
    assert.equal(signal instanceof OutboxDeliveryError, false);
    assert.equal(signal.name, 'OutboxContinuationRequested');
  });
});
