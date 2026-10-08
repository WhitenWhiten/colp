import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { Pool } from 'pg';
import { runMigrations, createDatabaseRuntime, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  EventEnvelopeRegistry,
  OutboxContinuationRequested,
  OutboxDeliveryError,
  OutboxRouter,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
  createExponentialRetryPolicy,
  defineClosedPayloadValidator,
  type OutboxWorkerLogger,
} from '../../../src/infrastructure/outbox/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  configuredTestDatabaseUrl,
  describeWithPostgres,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL outbox continuation control flow', () => {
  const databaseUrl = configuredTestDatabaseUrl();
  const schema = `outbox_cont_${randomUUID().replaceAll('-', '_')}`;
  let admin: Pool;
  let runtime: DatabaseRuntime;
  let repository: PostgresOutboxRepository;

  beforeAll(async () => {
    assert.ok(databaseUrl, 'KNOWN_TEST_DATABASE_URL or DATABASE_URL is required');
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`create schema ${schema}`);
    const isolated = new URL(databaseUrl);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    const migrationRuntime = createDatabaseRuntime(isolated.toString(), {
      maxConnections: 1,
      applicationName: 'known-outbox-continuation-migration-test',
    });
    await runMigrations(migrationRuntime.db, 'latest');
    await migrationRuntime.close();
    runtime = createDatabaseRuntime(isolated.toString(), {
      maxConnections: 4,
      applicationName: 'known-outbox-continuation-integration-test',
    });
    repository = new PostgresOutboxRepository(runtime.pool);
  });

  afterAll(async () => {
    await runtime?.close();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  // claim() is global FIFO; park leftovers so each test owns the only claimable row.
  beforeEach(async () => {
    await runtime.pool.query(`
      update outbox_events
         set state = 'completed',
             locked_until = null,
             completed_at = coalesce(completed_at, current_timestamp)
       where state in ('pending', 'retryable', 'leased')
    `);
  });

  async function insertOutbox(
    outboxId: string,
    eventId: string,
    options: {
      readonly handlerName?: string;
      readonly handlerMode?: 'projection_latest_only' | 'delivery_each_event';
      readonly aggregateId?: string;
      readonly aggregateScope?: string | null;
      readonly commitOrdinal?: number | null;
      readonly availableAt?: string;
      readonly attemptCount?: number;
    } = {},
  ): Promise<void> {
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ($1, 'outbox'), ($2, 'domain-event')
       on conflict (resource_id) do nothing`,
      [outboxId, eventId],
    );
    await runtime.pool.query(
      `insert into outbox_events(
         outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
         aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
         occurred_at, payload_json, available_at, attempt_count
       ) values ($1, $2, 'resource.updated', 1, $3, $4, 'note', $5, $6, 'r-1', $7,
                 current_timestamp, $8::jsonb, $9::timestamptz, $10)`,
      [
        outboxId,
        eventId,
        options.handlerName ?? 'search-projection',
        options.handlerMode ?? 'projection_latest_only',
        options.aggregateId ?? `resource-${eventId}`,
        options.aggregateScope === undefined ? 'collection-1' : options.aggregateScope,
        options.commitOrdinal === undefined ? 1 : options.commitOrdinal,
        JSON.stringify({ resource_id: `resource-${eventId}`, title: 'Updated' }),
        options.availableAt ?? '2026-01-01T00:00:00.000Z',
        options.attemptCount ?? 0,
      ],
    );
  }

  async function rowState(outboxId: string): Promise<{
    state: string;
    attempt_count: number;
    lease_generation: string;
    locked_until: Date | null;
    last_error: string | null;
    available_at: Date;
    dead_lettered_at: Date | null;
  }> {
    const result = await runtime.pool.query<{
      state: string;
      attempt_count: number;
      lease_generation: string;
      locked_until: Date | null;
      last_error: string | null;
      available_at: Date;
      dead_lettered_at: Date | null;
    }>(
      `select state, attempt_count, lease_generation, locked_until, last_error,
              available_at, dead_lettered_at
         from outbox_events where outbox_id = $1`,
      [outboxId],
    );
    assert.ok(result.rows[0]);
    return result.rows[0];
  }

  const envelopes = new EventEnvelopeRegistry([{
    eventType: 'resource.updated',
    eventVersion: 1,
    validatePayload: defineClosedPayloadValidator({
      resource_id: (value) => typeof value === 'string',
      title: (value) => typeof value === 'string',
    }),
  }]);
  const logger: OutboxWorkerLogger = { info() {}, warn() {}, error() {} };

  test('continue CAS returns leased work to pending and preserves available_at', async () => {
    await insertOutbox('outbox-cont-ok', 'event-cont-ok', {
      availableAt: '2026-01-01T00:00:00.000Z',
    });
    const claim = await repository.claim(10_000);
    assert.ok(claim);
    assert.equal(claim.outboxId, 'outbox-cont-ok');
    await runtime.pool.query(
      "update outbox_events set last_error = 'stale-error' where outbox_id = $1",
      [claim.outboxId],
    );
    const before = await rowState(claim.outboxId);
    assert.equal(before.state, 'leased');
    assert.equal(before.last_error, 'stale-error');

    assert.equal(await repository.continue(claim), true);
    const after = await rowState(claim.outboxId);
    assert.equal(after.state, 'pending');
    assert.equal(after.locked_until, null);
    assert.equal(after.last_error, null);
    assert.equal(after.attempt_count, before.attempt_count);
    assert.equal(after.lease_generation, before.lease_generation);
    assert.equal(after.available_at.toISOString(), before.available_at.toISOString());
    assert.equal(after.dead_lettered_at, null);

    // The row is no longer leased: the same claim must not continue a second time.
    assert.equal(await repository.continue(claim), false);

    const reclaim = await repository.claim(10_000);
    assert.ok(reclaim);
    assert.equal(reclaim.outboxId, 'outbox-cont-ok');
    assert.equal(reclaim.attemptCount, before.attempt_count + 1);
    assert.equal(await repository.complete(reclaim), true);
  });

  test('continue rejects expired lease and foreign generation after takeover', async () => {
    await insertOutbox('outbox-cont-takeover', 'event-cont-takeover');
    const first = await repository.claim(10_000);
    assert.ok(first);
    await runtime.pool.query(
      "update outbox_events set locked_until = current_timestamp - interval '1 second' where outbox_id = $1",
      [first.outboxId],
    );
    assert.equal(await repository.continue(first), false);
    assert.equal((await rowState(first.outboxId)).state, 'leased');

    const second = await repository.claim(10_000);
    assert.ok(second);
    assert.equal(second.leaseGeneration, '2');
    assert.equal(await repository.continue(first), false);
    assert.equal(await repository.continue(second), true);
    assert.equal((await rowState(first.outboxId)).state, 'pending');
  });

  test('high attempt count continuation never dead-letters or writes last_error', async () => {
    await insertOutbox('outbox-cont-hot', 'event-cont-hot', { attemptCount: 99 });
    const claim = await repository.claim(10_000);
    assert.ok(claim);
    assert.equal(claim.attemptCount, 100);
    assert.equal(await repository.continue(claim), true);
    const after = await rowState(claim.outboxId);
    assert.equal(after.state, 'pending');
    assert.equal(after.attempt_count, 100);
    assert.equal(after.last_error, null);
    assert.equal(after.dead_lettered_at, null);
  });

  test('worker continuation path records outbox.continued and skips fail()', async () => {
    await insertOutbox('outbox-cont-worker', 'event-cont-worker', { attemptCount: 40 });
    const metrics = new InMemoryMetrics();
    const effects = new Set<string>();
    const worker = new VersionedOutboxWorker({
      repository: new PostgresOutboxRepository(runtime.pool),
      router: new OutboxRouter([{
        handlerName: 'search-projection',
        handlerMode: 'projection_latest_only',
        sideEffectDurability: 'durable',
        eventType: 'resource.updated',
        eventVersion: 1,
        async handle({ idempotencyKey }) {
          effects.add(idempotencyKey);
          throw new OutboxContinuationRequested();
        },
      }]),
      envelopes,
      logger,
      metrics,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 3, jitterRatio: 0,
      }),
    });

    assert.equal(await worker.runOnce(), true);
    assert.deepEqual([...effects], ['event-cont-worker']);
    assert.equal(metrics.get('outbox.continued'), 1);
    assert.equal(metrics.get('outbox.retryable') ?? 0, 0);
    assert.equal(metrics.get('outbox.dead_letter') ?? 0, 0);
    const after = await rowState('outbox-cont-worker');
    assert.equal(after.state, 'pending');
    assert.equal(after.last_error, null);
    assert.equal(after.attempt_count, 41);
  });

  test('continue CAS lost after takeover leaves the new owner exclusive', async () => {
    await insertOutbox('outbox-cont-cas-lost', 'event-cont-cas-lost');
    const late = await repository.claim(10_000);
    assert.ok(late);
    await runtime.pool.query(
      "update outbox_events set locked_until = current_timestamp - interval '1 second' where outbox_id = $1",
      [late.outboxId],
    );
    const owner = await repository.claim(10_000);
    assert.ok(owner);
    assert.equal(await repository.continue(late), false);
    assert.equal((await rowState(late.outboxId)).state, 'leased');
    assert.equal(await repository.complete(owner), true);
  });

  test('heartbeat and continue race settle to pending without last_error', async () => {
    await insertOutbox('outbox-cont-race', 'event-cont-race');
    const claim = await repository.claim(10_000);
    assert.ok(claim);
    const [heartbeatOk, continued] = await Promise.all([
      repository.heartbeat(claim, 10_000),
      repository.continue(claim),
    ]);
    assert.equal(heartbeatOk || continued, true);
    const after = await rowState(claim.outboxId);
    if (continued) {
      assert.equal(after.state, 'pending');
      assert.equal(after.locked_until, null);
      assert.equal(after.last_error, null);
      assert.equal(await repository.heartbeat(claim, 10_000), false);
    } else {
      // Heartbeat won the serialization window before continue observed the row; continue lost.
      assert.equal(after.state, 'leased');
      assert.equal(await repository.continue(claim), true);
      assert.equal((await rowState(claim.outboxId)).state, 'pending');
    }
  });

  test('concurrent claim on one due row leases it exactly once', async () => {
    await insertOutbox('outbox-cont-claim-race', 'event-cont-claim-race');
    const [first, second] = await Promise.all([
      repository.claim(10_000),
      repository.claim(10_000),
    ]);
    const winners = [first, second].filter((claim) => claim !== null);
    assert.equal(winners.length, 1, 'concurrent claims must not double-lease one row');
    assert.equal(winners[0]?.outboxId, 'outbox-cont-claim-race');
    assert.equal(winners[0]?.leaseGeneration, '1');
    assert.equal(winners[0]?.attemptCount, 1);
    const row = await rowState('outbox-cont-claim-race');
    assert.equal(row.state, 'leased');
    assert.equal(row.lease_generation, '1');
    assert.equal(await repository.continue(winners[0]!), true);
  });

  test('concurrent continue CAS on one lease settles exactly once', async () => {
    await insertOutbox('outbox-cont-concurrent', 'event-cont-concurrent');
    const claim = await repository.claim(10_000);
    assert.ok(claim);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repository.continue(claim)),
    );
    assert.equal(
      results.filter((won) => won).length,
      1,
      'exactly one concurrent continue may win the lease fence',
    );
    const after = await rowState(claim.outboxId);
    assert.equal(after.state, 'pending');
    assert.equal(after.locked_until, null);
    assert.equal(after.last_error, null);
    assert.equal(after.attempt_count, claim.attemptCount);
    assert.equal(after.lease_generation, claim.leaseGeneration);
    assert.equal(after.available_at.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(after.dead_lettered_at, null);
  });

  test('concurrent continue and fail on one lease settle to a single fenced outcome', async () => {
    await insertOutbox('outbox-cont-cas-race', 'event-cont-cas-race');
    const claim = await repository.claim(10_000);
    assert.ok(claim);
    const [continued, failed] = await Promise.all([
      repository.continue(claim),
      repository.fail(claim, 'racing failure', 60_000, 3),
    ]);
    const after = await rowState(claim.outboxId);
    if (continued) {
      assert.equal(failed, 'lease_lost');
      assert.equal(after.state, 'pending');
      assert.equal(after.locked_until, null);
      assert.equal(after.last_error, null);
      assert.equal(after.attempt_count, claim.attemptCount);
      assert.equal(after.available_at.toISOString(), '2026-01-01T00:00:00.000Z');
      assert.equal(after.dead_lettered_at, null);
    } else {
      assert.equal(failed, 'retryable');
      assert.equal(after.state, 'retryable');
      assert.equal(after.locked_until, null);
      assert.equal(after.last_error, 'racing failure');
      assert.equal(after.attempt_count, claim.attemptCount);
      assert.equal(after.dead_lettered_at, null);
    }
  });

  test('ordinary retry, permanent dead-letter, complete, and transient refusal regressions hold', async () => {
    await insertOutbox('outbox-cont-retry', 'event-cont-retry');
    const retryClaim = await repository.claim(10_000);
    assert.ok(retryClaim);
    assert.equal(await repository.fail(retryClaim, 'temporary outage', 60_000, 3), 'retryable');
    assert.equal((await rowState(retryClaim.outboxId)).state, 'retryable');
    assert.equal((await rowState(retryClaim.outboxId)).last_error, 'temporary outage');

    await insertOutbox('outbox-cont-dead', 'event-cont-dead', { attemptCount: 2 });
    const deadClaim = await repository.claim(10_000);
    assert.ok(deadClaim);
    assert.equal(await repository.fail(deadClaim, 'permanent outage', 250, 3), 'dead_letter');
    assert.equal((await rowState(deadClaim.outboxId)).state, 'dead_letter');

    await insertOutbox('outbox-cont-complete', 'event-cont-complete');
    const done = await repository.claim(10_000);
    assert.ok(done);
    assert.equal(await repository.complete(done), true);
    assert.equal((await rowState(done.outboxId)).state, 'completed');

    await insertOutbox('outbox-cont-transient', 'event-cont-transient', {
      handlerMode: 'delivery_each_event',
      aggregateScope: null,
      commitOrdinal: null,
    });
    const metrics = new InMemoryMetrics();
    const worker = new VersionedOutboxWorker({
      repository: new PostgresOutboxRepository(runtime.pool),
      router: new OutboxRouter([{
        handlerName: 'search-projection',
        handlerMode: 'delivery_each_event',
        sideEffectDurability: 'transient',
        eventType: 'resource.updated',
        eventVersion: 1,
        async handle() {},
      }]),
      envelopes,
      logger,
      metrics,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 3, jitterRatio: 0,
      }),
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(metrics.get('outbox.transient_completion_refused'), 1);
    assert.equal(metrics.get('outbox.continued') ?? 0, 0);
    assert.equal((await rowState('outbox-cont-transient')).state, 'retryable');

    await insertOutbox('outbox-cont-permanent-err', 'event-cont-permanent-err', {
      handlerMode: 'delivery_each_event',
      aggregateScope: null,
      commitOrdinal: null,
    });
    const permanentWorker = new VersionedOutboxWorker({
      repository: new PostgresOutboxRepository(runtime.pool),
      router: new OutboxRouter([{
        handlerName: 'search-projection',
        handlerMode: 'delivery_each_event',
        sideEffectDurability: 'durable',
        eventType: 'resource.updated',
        eventVersion: 1,
        async handle() { throw new OutboxDeliveryError('permanent', 'bad payload'); },
      }]),
      envelopes,
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 5, jitterRatio: 0,
      }),
    });
    assert.equal(await permanentWorker.runOnce(), true);
    assert.equal((await rowState('outbox-cont-permanent-err')).state, 'dead_letter');
  });

  test('side effect committed then process loss before continue recovers on reclaim', async () => {
    await insertOutbox('outbox-cont-crash', 'event-cont-crash', {
      handlerMode: 'delivery_each_event',
      aggregateScope: null,
      commitOrdinal: null,
    });
    const effects = new Set<string>();
    let calls = 0;
    let crashFirst = true;
    const workerOptions = {
      envelopes,
      logger,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      handlerTimeoutMs: 1_000,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 10, jitterRatio: 0,
      }),
    } as const;
    const route = {
      handlerName: 'search-projection' as const,
      handlerMode: 'delivery_each_event' as const,
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated',
      eventVersion: 1,
      async handle({ idempotencyKey }: { idempotencyKey: string }) {
        calls += 1;
        if (!effects.has(idempotencyKey)) effects.add(idempotencyKey);
        if (crashFirst) {
          crashFirst = false;
          throw new Error('crash after side effect before continuation');
        }
        throw new OutboxContinuationRequested();
      },
    };

    const firstWorker = new VersionedOutboxWorker({
      ...workerOptions,
      repository: new PostgresOutboxRepository(runtime.pool),
      router: new OutboxRouter([route]),
    });
    assert.equal(await firstWorker.runOnce(), true);
    assert.equal((await rowState('outbox-cont-crash')).state, 'retryable');

    await runtime.pool.query(
      "update outbox_events set available_at = current_timestamp - interval '1 second' where outbox_id = $1",
      ['outbox-cont-crash'],
    );
    const secondWorker = new VersionedOutboxWorker({
      ...workerOptions,
      repository: new PostgresOutboxRepository(runtime.pool),
      router: new OutboxRouter([route]),
    });
    assert.equal(await secondWorker.runOnce(), true);
    assert.equal(calls, 2);
    assert.deepEqual([...effects], ['event-cont-crash']);
    const after = await rowState('outbox-cont-crash');
    assert.equal(after.state, 'pending');
    assert.equal(after.last_error, null);
  });

  test('projection claim is ordinal-serialized: higher ordinals wait for the minimum unfinished ordinal', async () => {
    await insertOutbox('outbox-ordinal-a', 'event-ordinal-a', {
      aggregateId: 'resource-ordinal', commitOrdinal: 10,
    });
    await insertOutbox('outbox-ordinal-b', 'event-ordinal-b', {
      aggregateId: 'resource-ordinal', commitOrdinal: 11,
    });
    // A(n) is claimed first, then fails transiently into a long backoff.
    const low = await repository.claim(10_000);
    assert.equal(low?.outboxId, 'outbox-ordinal-a');
    assert.equal(await repository.fail(low!, 'temporary backoff', 60_000, 5), 'retryable');

    // B(n+1) is due, but A remains the minimum unfinished ordinal: B must stay unclaimed.
    assert.equal(await repository.claim(10_000), null);

    // A different aggregate stays claimable in parallel (multi-aggregate progress).
    await insertOutbox('outbox-ordinal-c', 'event-ordinal-c', {
      aggregateId: 'resource-other', commitOrdinal: 5,
    });
    const parallel = await repository.claim(10_000);
    assert.equal(parallel?.outboxId, 'outbox-ordinal-c');
    assert.equal(await repository.complete(parallel!), true);

    // Backoff expiry recovers A; only then may B be claimed, and neither is obsolete.
    await runtime.pool.query(
      "update outbox_events set available_at = current_timestamp - interval '1 second' where outbox_id = 'outbox-ordinal-a'",
    );
    const recovered = await repository.claim(10_000);
    assert.equal(recovered?.outboxId, 'outbox-ordinal-a');
    assert.equal(await repository.isObsoleteProjection(recovered!), false,
      'recovered lower ordinal must not be obsolete while the watermark is behind it');
    assert.equal(await repository.complete(recovered!), true);

    const next = await repository.claim(10_000);
    assert.equal(next?.outboxId, 'outbox-ordinal-b');
    assert.equal(await repository.isObsoleteProjection(next!), false);
    assert.equal(await repository.complete(next!), true);

    const watermark = await runtime.pool.query<{ commit_ordinal: string }>(
      `select commit_ordinal from outbox_projection_watermarks
       where handler_name = 'search-projection' and aggregate_id = 'resource-ordinal'`,
    );
    assert.equal(watermark.rows[0]?.commit_ordinal, '11');
  });

  test('claim UPDATE re-checks the ordinal fence when a lower ordinal becomes unfinished mid-claim', async () => {
    await insertOutbox('outbox-ordinal-race-a', 'event-ordinal-race-a', {
      aggregateId: 'resource-ordinal-race', commitOrdinal: 10,
    });
    await insertOutbox('outbox-ordinal-race-b', 'event-ordinal-race-b', {
      aggregateId: 'resource-ordinal-race', commitOrdinal: 11,
    });
    const low = await repository.claim(10_000);
    assert.equal(low?.outboxId, 'outbox-ordinal-race-a');
    assert.equal(await repository.complete(low!), true);

    // Simulate a replay decision re-opening the lower ordinal while a concurrent claim for
    // B(n+1) has already passed candidate selection: hold the per-aggregate advisory lock,
    // start the concurrent claim (its SELECT sees A completed, so B is a candidate), then
    // re-open A as pending before committing. The claim's UPDATE must re-check the ordinal
    // fence and refuse B even though its candidate SELECT already picked it.
    const holder = await runtime.pool.connect();
    try {
      await holder.query('begin');
      await holder.query(
        "select pg_advisory_xact_lock(hashtext('search-projection'), hashtext('resource-ordinal-race'))",
      );
      const racing = repository.claim(10_000);
      // Wait until the racing claim is blocked on the advisory lock: it must already have
      // completed candidate selection (B locked, A still completed in its snapshot).
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const blocked = await holder.query<{ blocked: string }>(
          `select count(*)::text as blocked from pg_locks
            where locktype = 'advisory' and granted = false
              and pid <> pg_backend_pid()`,
        );
        if (Number(blocked.rows[0]?.blocked ?? 0) > 0) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await holder.query(
        "update outbox_events set state = 'pending', available_at = current_timestamp - interval '1 second' where outbox_id = $1",
        ['outbox-ordinal-race-a'],
      );
      await holder.query('commit');
      assert.equal(await racing, null,
        'claim must refuse a higher ordinal once a lower ordinal became unfinished mid-claim');
    } finally {
      await holder.release();
    }
    assert.equal((await rowState('outbox-ordinal-race-b')).state, 'pending');
  });

  test('dead-lettered low ordinals are terminal and do not block higher ordinal claims', async () => {
    await insertOutbox('outbox-ordinal-dead', 'event-ordinal-dead', {
      aggregateId: 'resource-ordinal-dl', commitOrdinal: 20,
    });
    await insertOutbox('outbox-ordinal-live', 'event-ordinal-live', {
      aggregateId: 'resource-ordinal-dl', commitOrdinal: 21,
    });
    const low = await repository.claim(10_000);
    assert.equal(low?.outboxId, 'outbox-ordinal-dead');
    assert.equal(await repository.fail(low!, 'permanent failure', 1, 1), 'dead_letter');
    // The dead-lettered row is no longer unfinished; an explicit ops replay/rebuild
    // decision owns it, so the higher ordinal proceeds without being marked obsolete.
    const high = await repository.claim(10_000);
    assert.equal(high?.outboxId, 'outbox-ordinal-live');
    assert.equal(await repository.isObsoleteProjection(high!), false);
    assert.equal(await repository.complete(high!), true);
  });
});
