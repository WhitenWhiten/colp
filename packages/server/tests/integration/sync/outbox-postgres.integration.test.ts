import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { Pool } from 'pg';
import { runMigrations, createDatabaseRuntime, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  EventEnvelopeRegistry,
  OutboxRouter,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
  defineClosedPayloadValidator,
  type OutboxWorkerLogger,
} from '../../../src/infrastructure/outbox/index.js';
import {
  configuredTestDatabaseUrl,
  describeWithPostgres,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL outbox lease and delivery state', () => {
  const databaseUrl = configuredTestDatabaseUrl();
  const schema = `outbox_${randomUUID().replaceAll('-', '_')}`;
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
      applicationName: 'known-outbox-migration-test',
    });
    await runMigrations(migrationRuntime.db, 'latest');
    await migrationRuntime.close();
    runtime = createDatabaseRuntime(isolated.toString(), {
      maxConnections: 4,
      applicationName: 'known-outbox-integration-test',
    });
    // Bootstrap migrations may enqueue unrelated durable security events.
    await runtime.pool.query('delete from outbox_events');
    repository = new PostgresOutboxRepository(runtime.pool);
  });

  afterAll(async () => {
    await runtime?.close();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
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
         occurred_at, payload_json, available_at
       ) values ($1, $2, 'resource.updated', 1, $3, $4, 'note', $5, $6, 'r-1', $7,
                 current_timestamp, $8::jsonb, $9::timestamptz)`,
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
      ],
    );
  }

  test('uses FOR UPDATE SKIP LOCKED and commits each claim with a generation', async () => {
    await insertOutbox('outbox-skip-a', 'event-skip-a');
    await insertOutbox('outbox-skip-b', 'event-skip-b');
    const blocker = await runtime.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query("select outbox_id from outbox_events where outbox_id = 'outbox-skip-a' for update");

      const skippedToNext = await repository.claim(10_000);
      assert.equal(skippedToNext?.outboxId, 'outbox-skip-b');
      assert.equal(skippedToNext?.leaseGeneration, '1');
      assert.equal(skippedToNext?.attemptCount, 1);
      await blocker.query('commit');
      assert.equal(await repository.complete(skippedToNext!), true);

      const formerlyLocked = await repository.claim(10_000);
      assert.equal(formerlyLocked?.outboxId, 'outbox-skip-a');
      assert.equal(formerlyLocked?.leaseGeneration, '1');
      assert.equal(await repository.complete(formerlyLocked!), true);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
    }
  });

  test('serializes concurrent projection claims by handler and aggregate resource', async () => {
    await insertOutbox('outbox-scope-mutex-a', 'event-scope-mutex-a', {
      aggregateId: 'resource-scope-mutex', commitOrdinal: 10,
    });
    await insertOutbox('outbox-scope-mutex-b', 'event-scope-mutex-b', {
      aggregateId: 'resource-scope-mutex', commitOrdinal: 11,
    });
    const otherRepository = new PostgresOutboxRepository(runtime.pool);

    const [first, second] = await Promise.all([
      repository.claim(10_000),
      otherRepository.claim(10_000),
    ]);
    const owners = [first, second].filter((owner) => owner !== null);
    assert.equal(owners.length, 1);
    assert.equal(owners[0]?.aggregateScope, 'collection-1');
    assert.equal(await repository.complete(owners[0]!), true);

    const remaining = await otherRepository.claim(10_000);
    assert.ok(remaining);
    assert.equal(remaining.aggregateScope, 'collection-1');
    assert.notEqual(remaining.outboxId, owners[0]?.outboxId);
    assert.equal(await otherRepository.complete(remaining), true);
  });

  test('does not reclaim a live lease selected from an older statement snapshot', async () => {
    await insertOutbox('outbox-stale-snapshot', 'event-stale-snapshot');
    const blocker = await runtime.pool.connect();
    const gateKey = 571290;
    let delayedPid = 0;
    let delayed: Promise<Awaited<ReturnType<PostgresOutboxRepository['claim']>>> | undefined;
    try {
      await blocker.query('select pg_advisory_lock($1)', [gateKey]);
      const delayedPool = { connect: async () => {
        const client = await runtime.pool.connect();
        delayedPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
        return new Proxy(client, { get(target, property) {
          if (property === 'query') return (text: string, values?: unknown[]) => {
            if (text.includes('WITH candidates AS')) {
              // Hold this SELECT after its MVCC snapshot starts, before the
              // candidate row is locked. The other claimant can then commit.
              text = text.replace('WITH candidates AS',
                `WITH gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(${gateKey})), candidates AS`)
                .replace('FROM candidates candidate', 'FROM candidates candidate CROSS JOIN gate');
            }
            return target.query(text, values);
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      } } as unknown as Pool;
      delayed = new PostgresOutboxRepository(delayedPool).claim(10_000);
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const locks = await runtime.pool.query(`select 1 from pg_locks
          where pid = $1 and locktype = 'advisory' and not granted`, [delayedPid]);
        if (locks.rowCount) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'the delayed candidate statement must hold its old snapshot');
      const owner = await repository.claim(10_000);
      assert.equal(owner?.outboxId, 'outbox-stale-snapshot');
      await blocker.query('select pg_advisory_unlock($1)', [gateKey]);
      assert.equal(await delayed, null, 'a stale candidate cannot overwrite the committed live lease');
      assert.equal(await repository.complete(owner!), true, 'the original owner retains its generation');
    } finally {
      await blocker.query('select pg_advisory_unlock_all()');
      blocker.release();
      await delayed;
    }
  });

  test('allows distinct resources in one collection scope to be claimed concurrently', async () => {
    await insertOutbox('outbox-resource-parallel-a', 'event-resource-parallel-a', {
      aggregateId: 'resource-parallel-a', aggregateScope: 'collection-parallel',
    });
    await insertOutbox('outbox-resource-parallel-b', 'event-resource-parallel-b', {
      aggregateId: 'resource-parallel-b', aggregateScope: 'collection-parallel',
    });
    const otherRepository = new PostgresOutboxRepository(runtime.pool);

    const [first, second] = await Promise.all([
      repository.claim(10_000),
      otherRepository.claim(10_000),
    ]);
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.aggregateId, second.aggregateId);
    assert.equal(first.aggregateScope, 'collection-parallel');
    assert.equal(second.aggregateScope, 'collection-parallel');
    assert.equal(await repository.complete(first), true);
    assert.equal(await otherRepository.complete(second), true);
  });

  test('two workers fence a late owner after takeover and reuse event id for side effects', async () => {
    await insertOutbox('outbox-worker-takeover', 'event-worker-takeover', {
      handlerMode: 'delivery_each_event', aggregateScope: null, commitOrdinal: null,
    });
    const effects = new Set<string>();
    let releaseFirst: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const route = {
      handlerName: 'search-projection',
      handlerMode: 'delivery_each_event' as const,
      sideEffectDurability: 'durable' as const,
      eventType: 'resource.updated',
      eventVersion: 1,
      async handle({ idempotencyKey }: { idempotencyKey: string }) {
        calls += 1;
        if (!effects.has(idempotencyKey)) effects.add(idempotencyKey);
        if (calls === 1) {
          signalStarted?.();
          await firstGate;
        }
      },
    };
    const envelopes = new EventEnvelopeRegistry([{
      eventType: 'resource.updated',
      eventVersion: 1,
      validatePayload: defineClosedPayloadValidator({
        resource_id: (value) => typeof value === 'string',
        title: (value) => typeof value === 'string',
      }),
    }]);
    const logger: OutboxWorkerLogger = { info() {}, warn() {}, error() {} };
    const workerOptions = {
      envelopes,
      logger,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 900,
      handlerTimeoutMs: 1_000,
    } as const;
    const firstWorker = new VersionedOutboxWorker({
      ...workerOptions,
      repository: new PostgresOutboxRepository(runtime.pool),
      router: new OutboxRouter([route]),
    });
    const secondWorker = new VersionedOutboxWorker({
      ...workerOptions,
      repository: new PostgresOutboxRepository(runtime.pool),
      router: new OutboxRouter([route]),
    });

    const lateRun = firstWorker.runOnce();
    await firstStarted;
    await runtime.pool.query(
      "update outbox_events set locked_until = current_timestamp - interval '1 second' where outbox_id = $1",
      ['outbox-worker-takeover'],
    );
    assert.equal(await secondWorker.runOnce(), true);
    releaseFirst?.();
    assert.equal(await lateRun, true);

    const state = await runtime.pool.query<{
      state: string; lease_generation: string; attempt_count: number;
    }>(
      'select state, lease_generation, attempt_count from outbox_events where outbox_id = $1',
      ['outbox-worker-takeover'],
    );
    assert.deepEqual(state.rows[0], {
      state: 'completed', lease_generation: '2', attempt_count: 2,
    });
    assert.equal(calls, 2);
    assert.deepEqual([...effects], ['event-worker-takeover']);
  });

  test('takes over an expired lease and rejects every late generation CAS', async () => {
    await insertOutbox('outbox-takeover', 'event-takeover');
    const firstOwner = await repository.claim(10_000);
    assert.ok(firstOwner);
    await runtime.pool.query(
      "update outbox_events set locked_until = current_timestamp - interval '1 second' where outbox_id = $1",
      [firstOwner.outboxId],
    );

    const newOwner = await repository.claim(10_000);
    assert.ok(newOwner);
    assert.equal(newOwner.outboxId, firstOwner.outboxId);
    assert.equal(newOwner.leaseGeneration, '2');
    assert.equal(newOwner.attemptCount, 2);

    assert.equal(await repository.heartbeat(firstOwner, 10_000), false);
    assert.equal(await repository.complete(firstOwner), false);
    assert.equal(await repository.fail(firstOwner, 'late failure', 100, 3), 'lease_lost');
    assert.equal(await repository.complete(newOwner), true);

    const state = await runtime.pool.query<{
      state: string;
      lease_generation: string;
      last_error: string | null;
    }>('select state, lease_generation, last_error from outbox_events where outbox_id = $1', [firstOwner.outboxId]);
    assert.deepEqual(state.rows[0], {
      state: 'completed',
      lease_generation: '2',
      last_error: null,
    });
  });

  test('rejects an expired owner CAS before takeover and then permits a new owner claim', async () => {
    await insertOutbox('outbox-expired-before-takeover', 'event-expired-before-takeover');
    const expiredOwner = await repository.claim(10_000);
    assert.ok(expiredOwner);
    await runtime.pool.query(
      "update outbox_events set locked_until = current_timestamp - interval '1 second' where outbox_id = $1",
      [expiredOwner.outboxId],
    );

    assert.equal(await repository.heartbeat(expiredOwner, 10_000), false);
    assert.equal(await repository.complete(expiredOwner), false);
    assert.equal(await repository.fail(expiredOwner, 'expired owner failure', 100, 3), 'lease_lost');

    const unchanged = await runtime.pool.query<{
      state: string;
      lease_generation: string;
      last_error: string | null;
    }>('select state, lease_generation, last_error from outbox_events where outbox_id = $1', [expiredOwner.outboxId]);
    assert.deepEqual(unchanged.rows[0], {
      state: 'leased',
      lease_generation: '1',
      last_error: null,
    });

    const takeoverOwner = await repository.claim(10_000);
    assert.ok(takeoverOwner);
    assert.equal(takeoverOwner.outboxId, expiredOwner.outboxId);
    assert.equal(takeoverOwner.leaseGeneration, '2');
    assert.equal(takeoverOwner.attemptCount, 2);
    assert.equal(await repository.complete(takeoverOwner), true);
  });

  test('expands a non-empty legacy Outbox without losing rows', async () => {
    const legacySchema = `outbox_legacy_${randomUUID().replaceAll('-', '_')}`;
    await admin.query(`create schema ${legacySchema}`);
    const legacyUrl = new URL(databaseUrl!);
    legacyUrl.searchParams.set('options', `-c search_path=${legacySchema}`);
    const legacyRuntime = createDatabaseRuntime(legacyUrl.toString(), {
      maxConnections: 2,
      applicationName: 'known-outbox-legacy-migration-test',
    });

    try {
      const firstMigration = await runMigrations(legacyRuntime.db, 'up');
      assert.equal(firstMigration.results.length, 1);
      await legacyRuntime.pool.query(
        `insert into resource_id_ledger(resource_id, resource_type)
         values ('outbox-legacy-row', 'outbox'), ('event-legacy-row', 'domain-event')`,
      );
      await legacyRuntime.pool.query(
        `insert into outbox_events(
           outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode
         ) values (
           'outbox-legacy-row', 'event-legacy-row', 'resource.updated', 1,
           'legacy-handler', 'delivery_each_event'
         )`,
      );

      const upgrade = [
        ...(await runMigrations(legacyRuntime.db, 'up')).results,
        ...(await runMigrations(legacyRuntime.db, 'up')).results,
        ...(await runMigrations(legacyRuntime.db, 'up')).results,
      ];
      assert.equal(upgrade.length, 3);

      const legacyRow = await legacyRuntime.pool.query<{ count: string }>(
        "select count(*)::text as count from outbox_events where outbox_id = 'outbox-legacy-row'",
      );
      assert.equal(legacyRow.rows[0]?.count, '1');

      const newColumns = await legacyRuntime.pool.query<{ count: string }>(
        `select count(*)::text as count
           from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'outbox_events'
            and column_name in ('aggregate_type', 'aggregate_id', 'occurred_at', 'dead_lettered_at')`,
      );
      assert.equal(newColumns.rows[0]?.count, '4');
      const legacyEnvelope = await legacyRuntime.pool.query<{ aggregate_type: string; aggregate_id: string; available_at: Date; occurred_at: Date }>(
        "select aggregate_type, aggregate_id, available_at, occurred_at from outbox_events where outbox_id = 'outbox-legacy-row'",
      );
      assert.equal(legacyEnvelope.rows[0]?.aggregate_type, 'legacy');
      assert.equal(legacyEnvelope.rows[0]?.aggregate_id, 'outbox-legacy-row');
      assert.ok(legacyEnvelope.rows[0]?.available_at instanceof Date);
      assert.ok(legacyEnvelope.rows[0]?.occurred_at instanceof Date);
      assert.equal(legacyEnvelope.rows[0]?.occurred_at.toISOString(), legacyEnvelope.rows[0]?.available_at.toISOString());

      const newRelations = await legacyRuntime.pool.query<{
        projection_table: string | null;
        receipt_table: string | null;
        lease_index: string | null;
      }>(`select
            to_regclass('outbox_projection_watermarks')::text as projection_table,
            to_regclass('outbox_delivery_receipts')::text as receipt_table,
            to_regclass('outbox_expired_lease_idx')::text as lease_index`);
      assert.equal(newRelations.rows[0]?.projection_table, 'outbox_projection_watermarks');
      assert.equal(newRelations.rows[0]?.receipt_table, 'outbox_delivery_receipts');
      assert.equal(newRelations.rows[0]?.lease_index, 'outbox_expired_lease_idx');

      const appliedMigrations = await legacyRuntime.pool.query<{ count: string }>(
        'select count(*)::text as count from kysely_migration',
      );
      assert.equal(appliedMigrations.rows[0]?.count, '4');
    } finally {
      await legacyRuntime.close();
      await admin.query(`drop schema if exists ${legacySchema} cascade`);
    }
  });

  test('schedules retry with database time then dead-letters at max attempts', async () => {
    await insertOutbox('outbox-retry', 'event-retry');
    const firstAttempt = await repository.claim(10_000);
    assert.ok(firstAttempt);
    assert.equal(await repository.fail(firstAttempt, 'temporary outage', 60_000, 2), 'retryable');

    const retryState = await runtime.pool.query<{
      state: string;
      delayed: boolean;
      locked_until: Date | null;
      dead_lettered_at: Date | null;
    }>(`select state, available_at > current_timestamp as delayed, locked_until, dead_lettered_at
        from outbox_events where outbox_id = $1`, [firstAttempt.outboxId]);
    assert.equal(retryState.rows[0]?.state, 'retryable');
    assert.equal(retryState.rows[0]?.delayed, true);
    assert.equal(retryState.rows[0]?.locked_until, null);
    assert.equal(retryState.rows[0]?.dead_lettered_at, null);
    assert.equal(await repository.claim(10_000), null);

    await runtime.pool.query(
      "update outbox_events set available_at = current_timestamp - interval '1 second' where outbox_id = $1",
      [firstAttempt.outboxId],
    );
    const finalAttempt = await repository.claim(10_000);
    assert.ok(finalAttempt);
    assert.equal(finalAttempt.attemptCount, 2);
    assert.equal(await repository.fail(finalAttempt, 'permanent outage', 250, 2), 'dead_letter');

    const dead = await runtime.pool.query<{
      state: string;
      dead_lettered_at: Date | null;
      last_error: string;
    }>('select state, dead_lettered_at, last_error from outbox_events where outbox_id = $1', [firstAttempt.outboxId]);
    assert.equal(dead.rows[0]?.state, 'dead_letter');
    assert.ok(dead.rows[0]?.dead_lettered_at instanceof Date);
    assert.equal(dead.rows[0]?.last_error, 'permanent outage');
    assert.equal(await repository.claim(10_000), null);
  });

  test('maintains latest-only watermarks and per-event delivery receipts independently', async () => {
    await insertOutbox('outbox-projection-new', 'event-projection-new', {
      aggregateId: 'resource-watermark',
      commitOrdinal: 7, aggregateScope: 'collection-watermark',
    });
    const newestProjection = await repository.claim(10_000);
    assert.ok(newestProjection);
    assert.equal(await repository.isObsoleteProjection(newestProjection), false);
    assert.equal(await repository.complete(newestProjection), true);

    await insertOutbox('outbox-projection-old', 'event-projection-old', {
      aggregateId: 'resource-watermark',
      commitOrdinal: 6, aggregateScope: 'collection-watermark',
    });
    const olderProjection = await repository.claim(10_000);
    assert.ok(olderProjection);
    assert.equal(await repository.isObsoleteProjection(olderProjection), true);
    assert.equal(await repository.complete(olderProjection), true);

    const watermark = await runtime.pool.query<{ commit_ordinal: string }>(
      `select commit_ordinal from outbox_projection_watermarks
       where handler_name = 'search-projection' and aggregate_id = 'resource-watermark'`,
    );
    assert.equal(watermark.rows[0]?.commit_ordinal, '7');

    await insertOutbox('outbox-delivery', 'event-delivery', {
      handlerName: 'notification-delivery',
      handlerMode: 'delivery_each_event',
      aggregateScope: null,
      commitOrdinal: null,
    });
    const delivery = await repository.claim(10_000);
    assert.ok(delivery);
    assert.equal(await repository.hasDeliveryReceipt(delivery), false);
    assert.equal(await repository.complete(delivery), true);
    assert.equal(await repository.hasDeliveryReceipt(delivery), true);

    const receipts = await runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from outbox_delivery_receipts
       where handler_name = $1 and domain_event_id = $2`,
      [delivery.handlerName, delivery.eventId],
    );
    assert.equal(receipts.rows[0]?.count, '1');
  });

  test('enforces one row per domain event and handler while allowing independent handlers', async () => {
    await insertOutbox('outbox-handler-a', 'event-shared', {
      handlerName: 'handler-a', handlerMode: 'delivery_each_event',
    });
    await assert.rejects(
      insertOutbox('outbox-handler-a-duplicate', 'event-shared', {
        handlerName: 'handler-a', handlerMode: 'delivery_each_event',
      }),
      (error: unknown) => typeof error === 'object' && error !== null
        && (error as { code?: unknown }).code === '23505'
        && (error as { constraint?: unknown }).constraint
          === 'outbox_events_domain_event_id_handler_name_key',
    );
    await insertOutbox('outbox-handler-b', 'event-shared', {
      handlerName: 'handler-b', handlerMode: 'projection_latest_only',
    });
    const rows = await runtime.pool.query<{ handler_name: string }>(
      "select handler_name from outbox_events where domain_event_id = 'event-shared' order by handler_name",
    );
    assert.deepEqual(rows.rows.map((row) => row.handler_name), ['handler-a', 'handler-b']);
  });
});
