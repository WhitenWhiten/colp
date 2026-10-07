import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  EventEnvelopeRegistry,
  OutboxContinuationRequested,
  OutboxRouter,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
} from '../../../src/infrastructure/outbox/index.js';
import {
  createPostgresSocialFeedWorkerRepository,
  createSocialFeedWorkerRoutes,
  socialCollectionChangeEnvelopeRegistrations,
} from '../../../src/infrastructure/social/index.js';
import { rebuildSocialFeedProjection } from '../../../src/modules/social/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

const PAGE_SIZE = 500;
const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
const COLLECTION = 'Dw8PDw8PDw8PDw8PDw8PDw';
const BOUNDARY_COUNTS = Object.freeze([0, 1, 499, 500, 501, 1000, 1001, 10007] as const);

describeWithPostgres('R5-04 durable live Feed fan-out continuation', () => {
  let isolated: IsolatedPostgresRuntime;
  let outbox: PostgresOutboxRepository;
  const logger = { info() {}, warn() {}, error() {} };

  beforeAll(async () => {
    // 10007-follower seed/fan-out exceeds the default 15s statement timeout.
    isolated = await createIsolatedPostgresRuntime('phase5_fanout_cont', {
      maxConnections: 8,
      statementTimeoutMs: 120_000,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, 'seed-recipient', ACTOR, COLLECTION);
    await isolated.runtime.pool.query(
      `delete from profiles where account_id='seed-recipient'`,
    );
    await isolated.runtime.pool.query(
      `delete from accounts where id='seed-recipient'`,
    );
    outbox = new PostgresOutboxRepository(isolated.runtime.pool);
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  function worker(pageSize = PAGE_SIZE) {
    const routes = createSocialFeedWorkerRoutes({
      repository: createPostgresSocialFeedWorkerRepository(isolated.runtime.pool, {
        emitNotificationIntents: false,
      }),
      maxRecipientsPerEvent: pageSize,
    });
    return new VersionedOutboxWorker({
      repository: outbox,
      router: new OutboxRouter(routes),
      envelopes: new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations),
      logger,
      metrics: new InMemoryMetrics(),
      leaseDurationMs: 120_000,
      heartbeatIntervalMs: 5_000,
      handlerTimeoutMs: 90_000,
      retryPolicy: { maxAttempts: 8, retryDelayMs: () => 1 },
    });
  }

  function productionWorker(metrics = new InMemoryMetrics()) {
    const runtime = buildWorker(loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      WORKER_CONCURRENCY: '1',
      WORKER_BATCH_SIZE: '1',
      FEED_FANOUT_PAGE_SIZE: String(PAGE_SIZE),
    }), isolated.runtime, metrics);
    assert.ok(runtime.outbox);
    return runtime.outbox;
  }

  async function resetProjectionState(): Promise<void> {
    // resource_id_ledger is immutable (FOR EACH ROW); never DELETE/UPDATE it.
    // Tests use unique outbox/event ids, so leftover ledger rows are harmless.
    await executeWithoutPermanenceGuards(isolated.runtime.pool, `
      delete from outbox_events
       where handler_name in ('social.publish-collection-change','social_feed_item_notification')`);
    await isolated.runtime.pool.query('delete from social_feed_items');
    await isolated.runtime.pool.query('delete from social_feed_watermarks');
    await isolated.runtime.pool.query('delete from outbox_projection_watermarks');
    await isolated.runtime.pool.query('delete from follows');
    // Keep reusable account/profile fixtures. Follows and projections are the per-case
    // authority state; repeatedly cascading 10k identities obscures worker performance.
    await isolated.runtime.pool.query(`
      update collections
         set visibility='public', deleted_at=null, publication_slug='feed-collection',
             published_at=coalesce(published_at, current_timestamp),
             policy_revision='p-live', commit_ordinal=1
       where id=$1`, [COLLECTION]);
    await isolated.runtime.pool.query(`
      update accounts set status='active', deleted_at=null where id=$1`, [ACTOR]);
  }

  async function seedFollowers(count: number, at = '2026-07-29T09:00:00Z'): Promise<string[]> {
    if (count === 0) return [];
    const client = await isolated.runtime.pool.connect();
    try {
      // Large boundary seeds (esp. 10007) exceed the pool's default statement timeout on
      // Docker Desktop; keep the exemption transaction-local.
      await client.query('begin');
      await client.query('set local statement_timeout = 0');
      await client.query('set local idle_in_transaction_session_timeout = 0');
      await client.query(`
        insert into accounts(id, subject_id, status)
        select 'r' || lpad(value::text, 5, '0'),
               'subject-r' || lpad(value::text, 5, '0'),
               'active'
          from generate_series(1, $1) value
        on conflict (id) do nothing`, [count]);
      await client.query(`
        insert into profiles(account_id, display_name)
        select 'r' || lpad(value::text, 5, '0'), 'r' || lpad(value::text, 5, '0')
          from generate_series(1, $1) value
        on conflict (account_id) do nothing`, [count]);
      await client.query(`
        insert into follows(actor_profile_id, target_profile_id, followed_at)
        select 'r' || lpad(value::text, 5, '0'), $2, $3::timestamptz
          from generate_series(1, $1) value`, [count, ACTOR, at]);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const rows = await isolated.runtime.pool.query<{ actor_profile_id: string }>(`
      select actor_profile_id from follows
       where target_profile_id=$1
       order by actor_profile_id`, [ACTOR]);
    return rows.rows.map((row) => row.actor_profile_id);
  }

  async function enqueue(eventId: string, ordinal: number, options: {
    readonly version?: number;
    readonly occurredAt?: string;
    readonly disposition?: 'public_candidate' | 'remove';
  } = {}): Promise<void> {
    const version = options.version ?? 2;
    const occurredAt = options.occurredAt ?? '2026-07-29T10:00:00.000Z';
    const payload: Record<string, unknown> = {
      collectionId: COLLECTION,
      ownerProfileId: ACTOR,
      publicationRevision: `c${ordinal}.p${ordinal}`,
      discoverabilityRecheckKey: `publication.collection:${COLLECTION}`,
    };
    if (version === 2) {
      payload.producerDiscoverability = options.disposition ?? 'public_candidate';
    }
    await isolated.runtime.pool.query(`
      insert into resource_id_ledger(resource_id, resource_type, committed_at)
      values ($1, 'outbox', current_timestamp)
      on conflict (resource_id) do nothing`, [eventId]);
    await isolated.runtime.pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
        occurred_at, payload_json, state, attempt_count, available_at, lease_generation)
      values ($1, $1, 'social.collection-change', $2, 'social.publish-collection-change',
        'projection_latest_only', 'collection', $3, $3, $4, $5, $6, $7,
        'pending', 0, current_timestamp, 0)`,
    [eventId, version, COLLECTION, `c${ordinal}.p${ordinal}`, ordinal, occurredAt, payload]);
  }

  async function drainUntilCompleted(
    eventId: string,
    pageSize = PAGE_SIZE,
    maxRuns = 64,
  ): Promise<{ readonly runs: number; readonly sliceItemCounts: number[] }> {
    const sliceItemCounts: number[] = [];
    let runs = 0;
    let idleDeadline = Date.now() + 10_000;
    while (runs < maxRuns) {
      const before = await itemCount(eventId);
      const progressed = await worker(pageSize).runOnce();
      if (!progressed) {
        const state = await outboxState(eventId);
        if (state === 'completed') return { runs, sliceItemCounts };
        if (Date.now() < idleDeadline
            && (state === 'pending' || state === 'retryable' || state === 'leased')) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        break;
      }
      runs += 1;
      idleDeadline = Date.now() + 10_000;
      const after = await itemCount(eventId);
      sliceItemCounts.push(after - before);
      const state = await outboxState(eventId);
      if (state === 'completed') {
        return { runs, sliceItemCounts };
      }
      if (state === 'dead_letter' || state === 'retryable') {
        await isolated.runtime.pool.query(`
          update outbox_events set available_at=current_timestamp where outbox_id=$1`, [eventId]);
      }
    }
    throw new Error(`event ${eventId} did not complete after ${runs} runs (state=${await outboxState(eventId)})`);
  }

  async function itemCount(eventId: string): Promise<number> {
    const rows = await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int as count from social_feed_items where source_event_id=$1`, [eventId]);
    return rows.rows[0]!.count;
  }

  async function projectionStateCounts(): Promise<{ visible: number; withdrawn: number }> {
    const rows = await isolated.runtime.pool.query<{ state: string; count: number }>(`
      select state, count(*)::int as count
        from social_feed_items
       where collection_id=$1
       group by state`, [COLLECTION]);
    return {
      visible: rows.rows.find((row) => row.state === 'visible')?.count ?? 0,
      withdrawn: rows.rows.find((row) => row.state === 'withdrawn')?.count ?? 0,
    };
  }

  async function recipients(eventId: string): Promise<string[]> {
    const rows = await isolated.runtime.pool.query<{ recipient_profile_id: string }>(`
      select recipient_profile_id from social_feed_items
       where source_event_id=$1
       order by recipient_profile_id`, [eventId]);
    return rows.rows.map((row) => row.recipient_profile_id);
  }

  async function outboxState(eventId: string): Promise<string | undefined> {
    const rows = await isolated.runtime.pool.query<{ state: string }>(`
      select state from outbox_events where outbox_id=$1`, [eventId]);
    return rows.rows[0]?.state;
  }

  async function watermark(): Promise<{
    last_commit_ordinal: string;
    fanout_source_event_id: string | null;
    fanout_after_recipient_profile_id: string | null;
    fanout_candidate_count: string | null;
  }> {
    const rows = await isolated.runtime.pool.query<{
      last_commit_ordinal: string;
      fanout_source_event_id: string | null;
      fanout_after_recipient_profile_id: string | null;
      fanout_candidate_count: string | null;
    }>(`
      select last_commit_ordinal::text,
             fanout_source_event_id,
             fanout_after_recipient_profile_id,
             fanout_candidate_count::text
        from social_feed_watermarks
       where aggregate_scope=$1`, [COLLECTION]);
    return rows.rows[0] ?? {
      last_commit_ordinal: '0',
      fanout_source_event_id: null,
      fanout_after_recipient_profile_id: null,
      fanout_candidate_count: null,
    };
  }

  test('recipient boundary matrix keeps full ordered exact-once fan-out with page caps', async () => {
    for (const count of BOUNDARY_COUNTS) {
      await resetProjectionState();
      const expected = await seedFollowers(count);
      const eventId = `boundary-${count}`;
      const ordinal = 100 + count;
      await enqueue(eventId, ordinal);

      const expectedSlices = count === 0 ? 1 : Math.ceil(count / PAGE_SIZE);
      const { runs, sliceItemCounts } = await drainUntilCompleted(eventId, PAGE_SIZE, expectedSlices + 4);

      assert.equal(await outboxState(eventId), 'completed', `count=${count}`);
      const actual = await recipients(eventId);
      assert.deepEqual(actual, expected, `full set count=${count}`);
      assert.equal(new Set(actual).size, actual.length, `no duplicates count=${count}`);
      assert.ok(runs >= expectedSlices, `runs for count=${count}`);
      assert.ok(
        sliceItemCounts.every((slice) => slice <= PAGE_SIZE),
        `each slice <= pageSize for count=${count}: ${sliceItemCounts.join(',')}`,
      );
      if (count > PAGE_SIZE) {
        assert.ok(
          sliceItemCounts.some((slice) => slice === PAGE_SIZE),
          `at least one full page for count=${count}`,
        );
      }
      const mark = await watermark();
      assert.equal(mark.last_commit_ordinal, String(ordinal), `watermark advanced count=${count}`);
      assert.equal(mark.fanout_source_event_id, null, `fanout idle count=${count}`);
      assert.equal(mark.fanout_after_recipient_profile_id, null, `cursor cleared count=${count}`);
    }
  }, 900_000);

  test('watermark advances only on the final slice while intermediate slices continue', async () => {
    await resetProjectionState();
    await seedFollowers(501);
    await enqueue('slice-watermark', 200);
    assert.equal(await worker().runOnce(), true);
    assert.equal(await outboxState('slice-watermark'), 'pending');
    let mark = await watermark();
    assert.equal(mark.last_commit_ordinal, '0');
    assert.equal(mark.fanout_source_event_id, 'slice-watermark');
    assert.ok(mark.fanout_after_recipient_profile_id);
    assert.equal(await itemCount('slice-watermark'), PAGE_SIZE);

    assert.equal(await worker().runOnce(), true);
    assert.equal(await outboxState('slice-watermark'), 'completed');
    mark = await watermark();
    assert.equal(mark.last_commit_ordinal, '200');
    assert.equal(mark.fanout_source_event_id, null);
    assert.equal(await itemCount('slice-watermark'), 501);
  }, 120_000);

  test('source withdrawal is durably continued and never exceeds the configured slice', async () => {
    await resetProjectionState();
    await seedFollowers(1001);
    await enqueue('withdraw-seed', 205);
    await drainUntilCompleted('withdraw-seed', PAGE_SIZE, 8);
    assert.deepEqual(await projectionStateCounts(), { visible: 1001, withdrawn: 0 });

    await enqueue('withdraw-source', 206, { disposition: 'remove' });
    const withdrawalDeltas: number[] = [];
    for (let run = 0; run < 6; run += 1) {
      const before = (await projectionStateCounts()).withdrawn;
      assert.equal(await worker(PAGE_SIZE).runOnce(), true);
      const after = (await projectionStateCounts()).withdrawn;
      withdrawalDeltas.push(after - before);
      assert.ok(after - before <= PAGE_SIZE, `withdrawal slice ${run + 1} exceeded page size`);

      const state = await outboxState('withdraw-source');
      const mark = await watermark();
      if (state === 'completed') {
        assert.equal(mark.last_commit_ordinal, '206');
        assert.equal(mark.fanout_source_event_id, null);
        break;
      }
      assert.equal(state, 'pending');
      assert.equal(mark.last_commit_ordinal, '205');
      assert.equal(mark.fanout_source_event_id, 'withdraw-source');
      assert.equal(mark.fanout_candidate_count, '0');
    }

    assert.equal(await outboxState('withdraw-source'), 'completed');
    assert.deepEqual(withdrawalDeltas, [500, 500, 1]);
    assert.deepEqual(await projectionStateCounts(), { visible: 0, withdrawn: 1001 });
  }, 180_000);

  test('corner: whole-page conflicts still continue and finish without duplicates', async () => {
    await resetProjectionState();
    const expected = await seedFollowers(3);
    await enqueue('conflict-page', 210);
    const pageSize = 2;
    // Pre-insert the first page to force ON CONFLICT DO NOTHING for an entire slice.
    for (const recipient of expected.slice(0, 2)) {
      await isolated.runtime.pool.query(`
        insert into social_feed_items(
          feed_item_id, source_event_id, kind, recipient_profile_id, actor_profile_id,
          collection_id, source_event_version, source_commit_ordinal, publication_revision,
          discoverability_recheck_key, published_at, retain_until)
        values ($1, 'conflict-page', 'collection_change', $2, $3, $4, 2, 210,
          'c210.p210', $5, '2026-07-29T10:00:00Z',
          '2026-07-29T10:00:00Z'::timestamptz + interval '90 days')`,
      [`pre-${recipient}`, recipient, ACTOR, COLLECTION,
        `publication.collection:${COLLECTION}`]);
    }
    await drainUntilCompleted('conflict-page', pageSize, 8);
    assert.deepEqual(await recipients('conflict-page'), expected);
    assert.equal((await watermark()).last_commit_ordinal, '210');
  }, 60_000);

  test('corner: Follow after event time is excluded; mid-fanout unfollow/refollow and visibility tighten', async () => {
    await resetProjectionState();
    const early = await seedFollowers(4, '2026-07-29T09:00:00Z');
    await isolated.runtime.pool.query(`
      insert into accounts(id, subject_id, status) values ('late-follow', 'subject-late', 'active')`);
    await isolated.runtime.pool.query(
      `insert into profiles(account_id, display_name) values ('late-follow', 'late-follow')`,
    );
    await isolated.runtime.pool.query(`
      insert into follows(actor_profile_id, target_profile_id, followed_at)
      values ('late-follow', $1, '2026-07-29T11:00:00Z')`, [ACTOR]);
    await enqueue('authority-corners', 220, { occurredAt: '2026-07-29T10:00:00.000Z' });

    const pageSize = 1;
    assert.equal(await worker(pageSize).runOnce(), true);
    assert.equal(await outboxState('authority-corners'), 'pending');
    assert.equal(await itemCount('authority-corners'), 1);
    const removed = early[2]!;
    await isolated.runtime.pool.query(`
      delete from follows where actor_profile_id=$1 and target_profile_id=$2`,
    [removed, ACTOR]);
    assert.equal(await worker(pageSize).runOnce(), true);
    assert.equal(await outboxState('authority-corners'), 'pending');
    assert.equal(
      (await recipients('authority-corners')).includes(removed),
      false,
      'mid-fanout unfollow must drop later candidates',
    );
    await isolated.runtime.pool.query(`
      insert into follows(actor_profile_id, target_profile_id, followed_at)
      values ($1, $2, '2026-07-29T09:30:00Z')`, [removed, ACTOR]);
    await isolated.runtime.pool.query(`
      update collections set visibility='private', policy_revision='p221', commit_ordinal=221
       where id=$1`, [COLLECTION]);
    assert.equal(await worker(pageSize).runOnce(), true);
    assert.equal(await outboxState('authority-corners'), 'pending');
    assert.equal((await watermark()).last_commit_ordinal, '0');
    await drainUntilCompleted('authority-corners', pageSize, 8);
    const mark = await watermark();
    assert.equal(mark.last_commit_ordinal, '220');
    assert.equal(mark.fanout_source_event_id, null);
    const visible = await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int as count from social_feed_items
       where source_event_id='authority-corners' and state='visible'`);
    assert.equal(visible.rows[0]?.count, 0);
    assert.equal(
      (await recipients('authority-corners')).includes('late-follow'),
      false,
    );
  }, 60_000);

  test('corner: newer same-collection event, late/duplicate/unknown version, rebuild concurrency', async () => {
    await resetProjectionState();
    await seedFollowers(4);
    await enqueue('older-event', 230);
    const pageSize = 2;
    assert.equal(await worker(pageSize).runOnce(), true);
    assert.equal(await outboxState('older-event'), 'pending');
    await enqueue('newer-event', 231);
    await drainUntilCompleted('older-event', pageSize, 8);
    await drainUntilCompleted('newer-event', pageSize, 8);
    assert.equal((await watermark()).last_commit_ordinal, '231');
    assert.equal(await itemCount('older-event'), 4);
    assert.equal(await itemCount('newer-event'), 4);

    await enqueue('duplicate-event', 231);
    assert.equal(await worker(pageSize).runOnce(), true);
    assert.equal(await outboxState('duplicate-event'), 'completed');
    assert.equal(await itemCount('duplicate-event'), 0);

    await enqueue('late-event', 229, { version: 1 });
    assert.equal(await worker(pageSize).runOnce(), true);
    assert.equal(await itemCount('late-event'), 0);

    await enqueue('unknown-version', 232, { version: 3,
      occurredAt: new Date(Date.now() - 91 * 86_400_000).toISOString() });
    // Unknown envelope versions are non-OutboxDeliveryError failures; dead-letter only
    // after retryPolicy.maxAttempts (8 here). Match the production worker path.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if ((await outboxState('unknown-version')) === 'dead_letter') break;
      await isolated.runtime.pool.query(`
        update outbox_events set available_at=current_timestamp where outbox_id='unknown-version'`);
      assert.equal(await worker(pageSize).runOnce(), true);
    }
    assert.equal(await outboxState('unknown-version'), 'dead_letter');
    await enqueue('rebuild-concurrent', 233);
    assert.equal(await worker(pageSize).runOnce(), true);
    const repository = createPostgresSocialFeedWorkerRepository(isolated.runtime.pool, {
      emitNotificationIntents: false,
    });
    // In-flight continuation leaves a non-completed retained row; rebuild must refuse it.
    await assert.rejects(
      rebuildSocialFeedProjection({
        repository,
        aggregateScope: COLLECTION,
        maxEvents: 40,
        maxRecipientsPerEvent: pageSize,
      }),
      /retained source row is unresolved/u,
    );
    await drainUntilCompleted('rebuild-concurrent', pageSize, 8);
    const rebuilt = await rebuildSocialFeedProjection({
      repository,
      aggregateScope: COLLECTION,
      maxEvents: 40,
      maxRecipientsPerEvent: pageSize,
    });
    assert.ok(rebuilt.eventCount >= 1);
    assert.equal(await outboxState('rebuild-concurrent'), 'completed');
  }, 120_000);

  test('fault: crash before slice commit leaves no durable cursor progress', async () => {
    await resetProjectionState();
    await seedFollowers(3);
    await enqueue('fault-before-commit', 240);
    await isolated.runtime.pool.query(`
      drop trigger if exists r504_fail_before_commit on social_feed_items;
      drop function if exists r504_fail_before_commit();
      create function r504_fail_before_commit() returns trigger language plpgsql as $$
      begin
        raise exception 'injected before slice commit';
      end $$`);
    await isolated.runtime.pool.query(`
      create trigger r504_fail_before_commit
        before insert on social_feed_items for each row
        execute function r504_fail_before_commit()`);
    try {
      assert.equal(await worker(2).runOnce(), true);
      assert.equal(await itemCount('fault-before-commit'), 0);
      const mark = await watermark();
      assert.equal(mark.last_commit_ordinal, '0');
      assert.equal(mark.fanout_source_event_id, null);
    } finally {
      await isolated.runtime.pool.query(
        'drop trigger if exists r504_fail_before_commit on social_feed_items',
      );
      await isolated.runtime.pool.query('drop function if exists r504_fail_before_commit()');
    }
    await isolated.runtime.pool.query(`
      update outbox_events set available_at=current_timestamp where outbox_id='fault-before-commit'`);
    await drainUntilCompleted('fault-before-commit', 2, 8);
    assert.equal(await itemCount('fault-before-commit'), 3);
  }, 60_000);

  test('fault: commit then crash before continue still resumes from durable cursor', async () => {
    await resetProjectionState();
    await seedFollowers(3);
    await enqueue('fault-before-continue', 241);
    const repository = createPostgresSocialFeedWorkerRepository(isolated.runtime.pool, {
      emitNotificationIntents: false,
    });
    const routes = createSocialFeedWorkerRoutes({
      repository,
      maxRecipientsPerEvent: 2,
    });
    const claim = await outbox.claim(10_000);
    assert.equal(claim?.outboxId, 'fault-before-continue');
    const validated = new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations)
      .validate({
        event_id: claim!.eventId,
        event_type: claim!.eventType,
        event_version: claim!.eventVersion,
        aggregate_identity: {
          aggregate_type: claim!.aggregateType,
          aggregate_id: claim!.aggregateId,
          aggregate_scope: claim!.aggregateScope,
        },
        aggregate_revision: claim!.aggregateRevision,
        commit_ordinal: claim!.commitOrdinal,
        occurred_at: claim!.occurredAt.toISOString(),
        payload: claim!.payload,
      });
    await assert.rejects(
      routes[1]!.handle({
        envelope: validated,
        idempotencyKey: validated.event_id,
        attempt: { outboxId: claim!.outboxId, leaseGeneration: claim!.leaseGeneration },
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof OutboxContinuationRequested,
    );
    // Simulate crash after durable slice commit and before worker.continue().
    await isolated.runtime.pool.query(`
      update outbox_events
         set state='retryable', locked_until=null, available_at=current_timestamp,
             last_error='crash after commit before continue'
       where outbox_id='fault-before-continue'`);
    assert.equal(await itemCount('fault-before-continue'), 2);
    assert.ok((await watermark()).fanout_after_recipient_profile_id);
    await drainUntilCompleted('fault-before-continue', 2, 8);
    assert.equal(await itemCount('fault-before-continue'), 3);
    assert.equal((await watermark()).fanout_source_event_id, null);
  }, 60_000);

  test('fault: final watermark CAS then lost complete/lease/takeover/abort paths recover', async () => {
    await resetProjectionState();
    await seedFollowers(2);
    await enqueue('fault-final', 250);
    await drainUntilCompleted('fault-final', 10, 4);
    assert.equal((await watermark()).last_commit_ordinal, '250');

    await enqueue('fault-lease-expire', 251);
    const oldClaim = await outbox.claim(100);
    assert.equal(oldClaim?.outboxId, 'fault-lease-expire');
    await isolated.runtime.pool.query(`
      update outbox_events set locked_until=current_timestamp - interval '1 second'
       where outbox_id='fault-lease-expire'`);
    const repository = createPostgresSocialFeedWorkerRepository(isolated.runtime.pool, {
      emitNotificationIntents: false,
    });
    const route = createSocialFeedWorkerRoutes({
      repository,
      maxRecipientsPerEvent: 10,
    })[1]!;
    const validated = new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations)
      .validate({
        event_id: oldClaim!.eventId,
        event_type: oldClaim!.eventType,
        event_version: oldClaim!.eventVersion,
        aggregate_identity: {
          aggregate_type: oldClaim!.aggregateType,
          aggregate_id: oldClaim!.aggregateId,
          aggregate_scope: oldClaim!.aggregateScope,
        },
        aggregate_revision: oldClaim!.aggregateRevision,
        commit_ordinal: oldClaim!.commitOrdinal,
        occurred_at: oldClaim!.occurredAt.toISOString(),
        payload: oldClaim!.payload,
      });
    await assert.rejects(
      route.handle({
        envelope: validated,
        idempotencyKey: validated.event_id,
        attempt: { outboxId: oldClaim!.outboxId, leaseGeneration: oldClaim!.leaseGeneration },
        signal: new AbortController().signal,
      }),
      /lease was lost/u,
    );
    const takeover = await outbox.claim(10_000);
    assert.equal(takeover?.outboxId, 'fault-lease-expire');
    assert.notEqual(takeover?.leaseGeneration, oldClaim?.leaseGeneration);
    await route.handle({
      envelope: validated,
      idempotencyKey: validated.event_id,
      attempt: { outboxId: takeover!.outboxId, leaseGeneration: takeover!.leaseGeneration },
      signal: new AbortController().signal,
    });
    assert.equal(await outbox.complete(takeover!), true);
    assert.equal(await itemCount('fault-lease-expire'), 2);

    await enqueue('fault-abort', 252);
    const abortClaim = await outbox.claim(10_000);
    const abortEnvelope = new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations)
      .validate({
        event_id: abortClaim!.eventId,
        event_type: abortClaim!.eventType,
        event_version: abortClaim!.eventVersion,
        aggregate_identity: {
          aggregate_type: abortClaim!.aggregateType,
          aggregate_id: abortClaim!.aggregateId,
          aggregate_scope: abortClaim!.aggregateScope,
        },
        aggregate_revision: abortClaim!.aggregateRevision,
        commit_ordinal: abortClaim!.commitOrdinal,
        occurred_at: abortClaim!.occurredAt.toISOString(),
        payload: abortClaim!.payload,
      });
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      route.handle({
        envelope: abortEnvelope,
        idempotencyKey: abortEnvelope.event_id,
        attempt: { outboxId: abortClaim!.outboxId, leaseGeneration: abortClaim!.leaseGeneration },
        signal: abort.signal,
      }),
      /abort/iu,
    );
    await isolated.runtime.pool.query(`
      update outbox_events
         set state='pending', locked_until=null, available_at=current_timestamp
       where outbox_id='fault-abort'`);
    await drainUntilCompleted('fault-abort', 10, 4);

    await enqueue('fault-final-cas', 253);
    await isolated.runtime.pool.query(`
      drop trigger if exists r504_fail_final_watermark_cas on social_feed_watermarks;
      drop function if exists r504_fail_final_watermark_cas();
      create function r504_fail_final_watermark_cas() returns trigger language plpgsql as $$
      begin
        if new.last_source_event_id = 'fault-final-cas'
          and new.last_commit_ordinal is distinct from old.last_commit_ordinal then
          raise exception 'injected final watermark cas loss';
        end if;
        return new;
      end $$`);
    await isolated.runtime.pool.query(`
      create trigger r504_fail_final_watermark_cas
        before update on social_feed_watermarks for each row
        execute function r504_fail_final_watermark_cas()`);
    try {
      assert.equal(await worker(10).runOnce(), true);
      assert.notEqual(await outboxState('fault-final-cas'), 'completed');
    } finally {
      await isolated.runtime.pool.query(
        'drop trigger if exists r504_fail_final_watermark_cas on social_feed_watermarks',
      );
      await isolated.runtime.pool.query('drop function if exists r504_fail_final_watermark_cas()');
    }
    await isolated.runtime.pool.query(`
      update outbox_events set available_at=current_timestamp where outbox_id='fault-final-cas'`);
    await drainUntilCompleted('fault-final-cas', 10, 8);
    assert.equal((await watermark()).last_commit_ordinal, '253');

    // Final CAS succeeded but complete() never ran: reclaim must finish without duplicating.
    await enqueue('fault-after-final-cas', 254);
    const afterCasClaim = await outbox.claim(10_000);
    assert.equal(afterCasClaim?.outboxId, 'fault-after-final-cas');
    const afterCasEnvelope = new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations)
      .validate({
        event_id: afterCasClaim!.eventId,
        event_type: afterCasClaim!.eventType,
        event_version: afterCasClaim!.eventVersion,
        aggregate_identity: {
          aggregate_type: afterCasClaim!.aggregateType,
          aggregate_id: afterCasClaim!.aggregateId,
          aggregate_scope: afterCasClaim!.aggregateScope,
        },
        aggregate_revision: afterCasClaim!.aggregateRevision,
        commit_ordinal: afterCasClaim!.commitOrdinal,
        occurred_at: afterCasClaim!.occurredAt.toISOString(),
        payload: afterCasClaim!.payload,
      });
    await route.handle({
      envelope: afterCasEnvelope,
      idempotencyKey: afterCasEnvelope.event_id,
      attempt: {
        outboxId: afterCasClaim!.outboxId,
        leaseGeneration: afterCasClaim!.leaseGeneration,
      },
      signal: new AbortController().signal,
    });
    assert.equal((await watermark()).last_commit_ordinal, '254');
    await isolated.runtime.pool.query(`
      update outbox_events
         set state='pending', locked_until=null, available_at=current_timestamp
       where outbox_id='fault-after-final-cas'`);
    assert.equal(await worker(10).runOnce(), true);
    assert.equal(await outboxState('fault-after-final-cas'), 'completed');
    assert.equal(await itemCount('fault-after-final-cas'), 2);
  }, 120_000);

  test('production composition uses configured FEED_FANOUT_PAGE_SIZE and records continuation metrics', async () => {
    await resetProjectionState();
    await seedFollowers(501);
    await enqueue('production-page-size', 260);
    const metrics = new InMemoryMetrics();
    const runtime = productionWorker(metrics);
    let guard = 0;
    while (guard < 1_200 && await outboxState('production-page-size') !== 'completed') {
      const progressed = await runtime.runOnce();
      if (!progressed) {
        await isolated.runtime.pool.query(`
          update outbox_events set available_at=current_timestamp
           where state in ('pending','retryable')`);
      }
      guard += 1;
    }
    assert.equal(await outboxState('production-page-size'), 'completed');
    assert.equal(await itemCount('production-page-size'), 501);
    assert.equal((await watermark()).fanout_source_event_id, null);
    assert.equal(metrics.get('feed.fanout.slice_applied'), 2);
    assert.equal(metrics.get('feed.fanout.continued'), 1);
    assert.equal(metrics.get('feed.fanout.completed'), 1);
  }, 180_000);

  test('fault: A(n) backoff blocks B(n+1) claim; A recovery projects both in ordinal order', async () => {
    await resetProjectionState();
    await seedFollowers(3);
    const metrics = new InMemoryMetrics();
    const routes = createSocialFeedWorkerRoutes({
      repository: createPostgresSocialFeedWorkerRepository(isolated.runtime.pool, {
        emitNotificationIntents: false,
      }),
      maxRecipientsPerEvent: 10,
      metrics,
    });
    const blockedWorker = new VersionedOutboxWorker({
      repository: outbox,
      router: new OutboxRouter(routes),
      envelopes: new EventEnvelopeRegistry(socialCollectionChangeEnvelopeRegistrations),
      logger,
      metrics,
      leaseDurationMs: 120_000,
      heartbeatIntervalMs: 5_000,
      handlerTimeoutMs: 90_000,
      retryPolicy: { maxAttempts: 8, retryDelayMs: () => 60_000 },
    });

    await enqueue('ordinal-blocked-a', 300);
    await isolated.runtime.pool.query(`
      drop trigger if exists r504_fail_ordinal_a on social_feed_items;
      drop function if exists r504_fail_ordinal_a();
      create function r504_fail_ordinal_a() returns trigger language plpgsql as $$
      begin
        if new.source_event_id = 'ordinal-blocked-a' then
          raise exception 'injected ordinal A transient failure';
        end if;
        return new;
      end $$`);
    await isolated.runtime.pool.query(`
      create trigger r504_fail_ordinal_a
        before insert on social_feed_items for each row
        execute function r504_fail_ordinal_a()`);

    try {
      // A(n) is claimed and fails transiently into a long backoff with zero projection.
      assert.equal(await blockedWorker.runOnce(), true);
      assert.equal(await outboxState('ordinal-blocked-a'), 'retryable');
      assert.equal(await itemCount('ordinal-blocked-a'), 0);
      assert.equal((await watermark()).last_commit_ordinal, '0');

      // B(n+1) is due, but A is the minimum unfinished ordinal: the claim attempt must
      // be blocked and B must stay pending with no items and no watermark advance.
      await enqueue('ordinal-blocked-b', 301);
      assert.equal(await blockedWorker.runOnce(), false);
      assert.equal(await outboxState('ordinal-blocked-b'), 'pending');
      assert.equal(await itemCount('ordinal-blocked-b'), 0);
      assert.equal(await outboxState('ordinal-blocked-a'), 'retryable');
      assert.equal((await watermark()).last_commit_ordinal, '0');
    } finally {
      // A recovers after backoff; both events project in ordinal order.
      await isolated.runtime.pool.query(
        'drop trigger if exists r504_fail_ordinal_a on social_feed_items',
      );
      await isolated.runtime.pool.query('drop function if exists r504_fail_ordinal_a()');
    }
    await isolated.runtime.pool.query(`
      update outbox_events set available_at=current_timestamp
       where outbox_id='ordinal-blocked-a'`);
    assert.equal(await blockedWorker.runOnce(), true);
    assert.equal(await outboxState('ordinal-blocked-a'), 'completed');
    assert.equal(await itemCount('ordinal-blocked-a'), 3);
    assert.equal((await watermark()).last_commit_ordinal, '300');

    assert.equal(await blockedWorker.runOnce(), true);
    assert.equal(await outboxState('ordinal-blocked-b'), 'completed');
    assert.equal(await itemCount('ordinal-blocked-b'), 3);
    assert.equal((await watermark()).last_commit_ordinal, '301');
    assert.equal((await watermark()).fanout_source_event_id, null);

    // Metrics: A's transient failure, then exactly two in-order completions and zero
    // obsolete skips — the lower-ordinal retry was never silently dropped.
    assert.equal(metrics.get('outbox.claimed'), 3);
    assert.equal(metrics.get('outbox.retryable'), 1);
    assert.equal(metrics.get('outbox.completed'), 2);
    assert.equal(metrics.get('outbox.obsolete_skipped'), 0);
    assert.equal(metrics.get('feed.fanout.completed'), 2);
    assert.equal(metrics.get('feed.fanout.slice_applied'), 2);
  }, 120_000);
});
