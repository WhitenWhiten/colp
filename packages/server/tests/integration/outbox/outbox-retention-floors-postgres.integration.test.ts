import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresOutboxRetentionFloorRepository,
  OutboxRetentionFloorError,
} from '../../../src/infrastructure/outbox/index.js';
import { createPostgresSocialFeedOperationsRepository,
  createPostgresSocialFeedWorkerRepository } from
  '../../../src/infrastructure/social/index.js';
import { rebuildSocialFeedProjection } from '../../../src/modules/social/index.js';
import { down as retentionDown, up as retentionUp } from
  '../../../migrations/202610010200_outbox_retention_floors.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const HANDLER = 'social.publish-collection-change';
const EVENT_TYPE = 'social.collection-change';
const DAY_MS = 86_400_000;

function agedDays(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

describeWithPostgres('Outbox permanent claims and retained-source floors', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('outbox_retention_floor', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function insertEvent(scope: string, ordinal: number, state = 'completed',
    suffix = '', occurredAt = new Date()): Promise<string> {
    const id = `${scope}-event-${ordinal}${suffix}`;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(
      resource_id,resource_type,committed_at) values($1,'outbox',current_timestamp)`, [id]);
    await isolated.runtime.pool.query(`insert into outbox_events(
      outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
      aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,
      occurred_at,payload_json,state,attempt_count,available_at,lease_generation,
      completed_at,dead_lettered_at)
      values($1,$1,$2::text,2,$3::text,'projection_latest_only','collection',$4::text,$4::text,
        $5::text,$6::bigint,$8::timestamptz,jsonb_build_object('collectionId',$4::text,
          'ownerProfileId','owner','publicationRevision',$5::text,
          'discoverabilityRecheckKey','publication.collection:' || $4::text,
          'producerDiscoverability','public_candidate'),$7::text,0,current_timestamp,0,
        case when $7::text='completed' then current_timestamp else null end,
        case when $7::text='dead_letter' then current_timestamp else null end)`,
    [id, EVENT_TYPE, HANDLER, scope, `revision-${ordinal}`, ordinal, state, occurredAt]);
    return id;
  }

  function floor(scope: string) {
    return { handlerName: HANDLER, eventType: EVENT_TYPE, aggregateScope: scope } as const;
  }

  function worker() {
    return createPostgresSocialFeedWorkerRepository(isolated.runtime.pool, {
      emitNotificationIntents: false,
    });
  }

  async function rebuild(scope: string) {
    return rebuildSocialFeedProjection({ repository: worker(), aggregateScope: scope,
      maxEvents: 1, maxRecipientsPerEvent: 10 });
  }

  test('migration backfills claims and trigger preserves immutable identity after queue deletion', async () => {
    await retentionDown(isolated.runtime.db);
    let id: string;
    try {
      id = await insertEvent('claim-backfill', 1);
    } finally {
      await retentionUp(isolated.runtime.db);
    }
    const claim = await isolated.runtime.pool.query(`select outbox_id from outbox_dispatch_claims
      where domain_event_id=$1 and handler_name=$2`, [id, HANDLER]);
    assert.equal(claim.rows[0]?.outbox_id, id);
    await assert.rejects(isolated.runtime.pool.query(`update outbox_dispatch_claims
      set outbox_id='different' where domain_event_id=$1 and handler_name=$2`, [id, HANDLER]),
    /immutable/u);
    await assert.rejects(isolated.runtime.pool.query(`delete from outbox_dispatch_claims
      where domain_event_id=$1 and handler_name=$2`, [id, HANDLER]), /immutable/u);

    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      'delete from outbox_events where outbox_id=$1', [id]);
    await assert.rejects(isolated.runtime.pool.query(`insert into outbox_events(
      outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
      aggregate_type,aggregate_id,payload_json,state,attempt_count,available_at,lease_generation,
      occurred_at)
      values($1,$1,'test.event',1,$2,'delivery_each_event','test',$1,'{}','completed',0,
        current_timestamp,0,current_timestamp)`, [id, HANDLER]), /permanently claimed/u);
    const replacement = `${id}-replacement`;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(
      resource_id,resource_type,committed_at) values($1,'outbox',current_timestamp)`, [replacement]);
    await assert.rejects(isolated.runtime.pool.query(`insert into outbox_events(
      outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
      aggregate_type,aggregate_id,payload_json,state,attempt_count,available_at,lease_generation,
      occurred_at)
      values($1,$2,'test.event',1,$3,'delivery_each_event','test',$1,'{}','completed',0,
        current_timestamp,0,current_timestamp)`, [replacement, id, HANDLER]), /permanently claimed/u);
    const alternateDomain = `${id}-alternate-domain`;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(
      resource_id,resource_type,committed_at) values($1,'outbox',current_timestamp)`,
    [alternateDomain]);
    await assert.rejects(isolated.runtime.pool.query(`insert into outbox_events(
      outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
      aggregate_type,aggregate_id,payload_json,state,attempt_count,available_at,lease_generation,
      occurred_at)
      values($1,$2,'test.event',1,'alternate-handler','delivery_each_event','test',$1,'{}',
        'completed',0,current_timestamp,0,current_timestamp)`, [id, alternateDomain]),
    /permanently claimed/u);
  });

  test('floor create/read/advance is monotonic CAS authority and rejects unresolved rows', async () => {
    const repository = createPostgresOutboxRetentionFloorRepository(isolated.runtime.pool);
    assert.deepEqual((await repository.read(floor('floor-cas'))).position,
      { commitOrdinal: '0', domainEventId: null });
    const created = await repository.create(floor('floor-cas'));
    const source = await insertEvent('floor-cas', 1, 'completed', '', agedDays(91));
    const advanced = await repository.advance({ ...floor('floor-cas'),
      position: { commitOrdinal: '1', domainEventId: source },
      expectedStateRevision: created.stateRevision });
    assert.equal(advanced.stateRevision, '1');
    await assert.rejects(isolated.runtime.pool.query(`update outbox_events
      set occurred_at=current_timestamp where outbox_id=$1`, [source]),
    /source envelope identity is immutable/u);
    await assert.rejects(isolated.runtime.pool.query(`update outbox_events set state='dead_letter'
      where outbox_id=$1`, [source]), /below retention floor must remain completed/u);
    await assert.rejects(repository.advance({ ...floor('floor-cas'),
      position: { commitOrdinal: '2', domainEventId: 'future' }, expectedStateRevision: '0' }),
    (error: unknown) => error instanceof OutboxRetentionFloorError
      && error.code === 'OUTBOX_RETENTION_FLOOR_CAS_CONFLICT');
    await assert.rejects(repository.advance({ ...floor('floor-cas'), position: advanced.position,
      expectedStateRevision: advanced.stateRevision }),
    (error: unknown) => error instanceof OutboxRetentionFloorError
      && error.code === 'OUTBOX_RETENTION_FLOOR_REGRESSION');
    const late = 'floor-cas-event-0';
    await isolated.runtime.pool.query(`insert into resource_id_ledger(
      resource_id,resource_type,committed_at) values($1,'outbox',current_timestamp)`, [late]);
    await assert.rejects(isolated.runtime.pool.query(`insert into outbox_events(
      outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
      aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,
      occurred_at,payload_json,state,attempt_count,available_at,lease_generation)
      values($1,$1,$2,1,$3,'projection_latest_only','collection',$4,$4,'late',1,
        current_timestamp,'{}','completed',0,current_timestamp,0)`,
    [late, EVENT_TYPE, HANDLER, 'floor-cas']), /at or below its retention floor/u);

    const unresolved = await insertEvent('floor-unresolved', 1, 'dead_letter', '', agedDays(91));
    const unresolvedFloor = await repository.create(floor('floor-unresolved'));
    await assert.rejects(repository.advance({ ...floor('floor-unresolved'),
      position: { commitOrdinal: '1', domainEventId: unresolved },
      expectedStateRevision: unresolvedFloor.stateRevision }),
    (error: unknown) => error instanceof OutboxRetentionFloorError
      && error.code === 'OUTBOX_RETENTION_FLOOR_UNRESOLVED_SOURCE');
  });

  test('floor policy enforces the approved Social Feed 90-day minimum only', async () => {
    const repository = createPostgresOutboxRetentionFloorRepository(isolated.runtime.pool);
    const recentScope = 'floor-policy-89-days';
    const recent = await insertEvent(recentScope, 1, 'completed', '', agedDays(89));
    const recentFloor = await repository.create(floor(recentScope));
    await assert.rejects(repository.advance({ ...floor(recentScope), position: {
      commitOrdinal: '1', domainEventId: recent },
    expectedStateRevision: recentFloor.stateRevision }),
    (error: unknown) => error instanceof OutboxRetentionFloorError
      && error.code === 'OUTBOX_RETENTION_FLOOR_POLICY_WINDOW');

    const boundaryScope = 'floor-policy-90-days';
    const boundary = await insertEvent(boundaryScope, 1, 'completed', '', agedDays(90));
    const boundaryFloor = await repository.create(floor(boundaryScope));
    const allowed = await repository.advance({ ...floor(boundaryScope), position: {
      commitOrdinal: '1', domainEventId: boundary },
    expectedStateRevision: boundaryFloor.stateRevision });
    assert.equal(allowed.position.commitOrdinal, '1');

    const unknownKey = { handlerName: 'unknown-handler', eventType: 'unknown.event',
      aggregateScope: 'floor-policy-unknown' } as const;
    const unknownId = 'floor-policy-unknown-event';
    await isolated.runtime.pool.query(`insert into resource_id_ledger(
      resource_id,resource_type,committed_at) values($1,'outbox',current_timestamp)`, [unknownId]);
    await isolated.runtime.pool.query(`insert into outbox_events(
      outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
      aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,
      occurred_at,payload_json,state,attempt_count,available_at,lease_generation,completed_at)
      values($1,$1,$2,1,$3,'delivery_each_event','test',$4,$4,'old',1,$5,'{}',
        'completed',0,current_timestamp,0,current_timestamp)`,
    [unknownId, unknownKey.eventType, unknownKey.handlerName, unknownKey.aggregateScope,
      agedDays(91)]);
    const unknownFloor = await repository.create(unknownKey);
    await assert.rejects(repository.advance({ ...unknownKey, position: {
      commitOrdinal: '1', domainEventId: unknownId },
    expectedStateRevision: unknownFloor.stateRevision }),
    (error: unknown) => error instanceof OutboxRetentionFloorError
      && error.code === 'OUTBOX_RETENTION_FLOOR_POLICY_UNSUPPORTED');
  });

  test('first floor materialization and advance serialize with a late unresolved insert', async () => {
    const scope = 'floor-first-materialize-race';
    const boundary = await insertEvent(scope, 2, 'completed', '', agedDays(91));
    const lateId = `${scope}-event-1`;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(
      resource_id,resource_type,committed_at) values($1,'outbox',current_timestamp)`, [lateId]);
    const late = await isolated.runtime.pool.connect();
    try {
      await late.query('begin');
      await late.query(`insert into outbox_events(
        outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
        aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,
        occurred_at,payload_json,state,attempt_count,available_at,lease_generation)
        values($1,$1,$2,2,$3,'projection_latest_only','collection',$4,$4,'late',1,$5,'{}',
          'pending',0,current_timestamp,0)`, [lateId, EVENT_TYPE, HANDLER, scope, agedDays(91)]);
      const repository = createPostgresOutboxRetentionFloorRepository(isolated.runtime.pool);
      const created = await repository.create(floor(scope));
      const advancing = repository.advance({ ...floor(scope), position: {
        commitOrdinal: '2', domainEventId: boundary }, expectedStateRevision: created.stateRevision });
      const advancingCheck = assert.rejects(advancing, (error: unknown) =>
        error instanceof OutboxRetentionFloorError
          && error.code === 'OUTBOX_RETENTION_FLOOR_UNRESOLVED_SOURCE');
      await waitForCondition(async () => {
        const waiting = await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int
          as count from pg_stat_activity where datname=current_database()
          and pid <> pg_backend_pid() and wait_event='advisory'
          and query like '%update outbox_retention_floors%'`);
        return (waiting.rows[0]?.count ?? 0) > 0;
      }, { timeoutMs: 2_000, pollIntervalMs: 10,
        description: 'floor advance to wait for the late source insert lock' });
      await late.query('commit');
      await advancingCheck;
    } finally {
      await late.query('rollback').catch(() => undefined);
      late.release();
    }
  });

  test('rebuild accepts deleted prefix at/below floor but rejects gaps above it', async () => {
    const repository = createPostgresOutboxRetentionFloorRepository(isolated.runtime.pool);
    const accepted = 'feed-floor-accepted';
    const acceptedIds = await Promise.all([insertEvent(accepted, 1, 'completed', '', agedDays(91)),
      insertEvent(accepted, 2, 'completed', '', agedDays(91)), insertEvent(accepted, 3)]);
    const initial = await repository.create(floor(accepted));
    await repository.advance({ ...floor(accepted), position: { commitOrdinal: '2',
      domainEventId: acceptedIds[1]! }, expectedStateRevision: initial.stateRevision });
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `delete from outbox_events where aggregate_scope=$1 and commit_ordinal <= 2`, [accepted]);
    const rebuilt = await rebuild(accepted);
    assert.equal(rebuilt.highCommitOrdinal, '3');
    assert.equal(rebuilt.eventCount, 1);

    const whole = 'feed-floor-whole-segment';
    const wholeIds = await Promise.all([1, 2, 3].map((ordinal) =>
      insertEvent(whole, ordinal, 'completed', '', agedDays(91))));
    const wholeInitial = await repository.create(floor(whole));
    await repository.advance({ ...floor(whole), position: { commitOrdinal: '3',
      domainEventId: wholeIds[2]! }, expectedStateRevision: wholeInitial.stateRevision });
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      'delete from outbox_events where aggregate_scope=$1', [whole]);
    const wholeRebuilt = await rebuild(whole);
    assert.equal(wholeRebuilt.highCommitOrdinal, '3');
    assert.equal(wholeRebuilt.eventCount, 0);

    const rejected = 'feed-floor-rejected';
    const rejectedIds = await Promise.all([insertEvent(rejected, 1, 'completed', '', agedDays(91)),
      insertEvent(rejected, 2), insertEvent(rejected, 3)]);
    const rejectedInitial = await repository.create(floor(rejected));
    await repository.advance({ ...floor(rejected), position: { commitOrdinal: '1',
      domainEventId: rejectedIds[0]! }, expectedStateRevision: rejectedInitial.stateRevision });
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `delete from outbox_events where aggregate_scope=$1 and commit_ordinal=2`, [rejected]);
    await assert.rejects(rebuild(rejected), /source gap/u);

    const noFloor = 'feed-no-floor';
    await Promise.all([1, 2, 3].map((ordinal) => insertEvent(noFloor, ordinal)));
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `delete from outbox_events where aggregate_scope=$1 and commit_ordinal=2`, [noFloor]);
    await assert.rejects(rebuild(noFloor), /source gap/u);
  });

  test('a rebuild observes a floor that advances past its whole captured remainder', async () => {
    const scope = 'feed-moving-floor';
    const crossingBoundary = new Date(Date.now() - 90 * DAY_MS + 2_000);
    const ids = await Promise.all([1, 2, 3, 4].map((ordinal) =>
      insertEvent(scope, ordinal, 'completed', '', crossingBoundary)));
    const repository = createPostgresOutboxRetentionFloorRepository(isolated.runtime.pool);
    const initial = await repository.create(floor(scope));
    await isolated.runtime.pool.query(`create function stall_moving_floor() returns trigger
      language plpgsql as $$ begin
        if new.aggregate_scope='feed-moving-floor'
           and new.rebuild_replayed_commit_ordinal=1 then perform pg_sleep(3.0); end if;
        return new;
      end $$`);
    await isolated.runtime.pool.query(`create trigger stall_moving_floor before update
      on social_feed_watermarks for each row execute function stall_moving_floor()`);
    const rebuilding = rebuild(scope);
    await waitForCondition(async () => {
      const activity = await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int
          as count from pg_stat_activity where datname=current_database()
          and pid <> pg_backend_pid() and wait_event='PgSleep'
          and query like '%social_feed_watermarks%'`);
      return (activity.rows[0]?.count ?? 0) > 0;
    }, { timeoutMs: 2_000, pollIntervalMs: 10,
      description: 'moving-floor rebuild to enter the controlled watermark stall' });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await repository.advance({ ...floor(scope), position: { commitOrdinal: '4',
      domainEventId: ids[3]! }, expectedStateRevision: initial.stateRevision });
    const result = await rebuilding;
    await isolated.runtime.pool.query(
      'drop trigger stall_moving_floor on social_feed_watermarks');
    await isolated.runtime.pool.query('drop function stall_moving_floor()');
    assert.equal(result.highCommitOrdinal, '4');
    assert.equal((await isolated.runtime.pool.query(`select projection_state,
      last_commit_ordinal::text from social_feed_watermarks where aggregate_scope=$1`, [scope]))
      .rows[0]?.projection_state, 'live');
  });

  test('captured high source identity follows the watermark rebuild state machine', async () => {
    const scope = 'feed-high-source-guard';
    await isolated.runtime.pool.query(`insert into social_feed_watermarks(aggregate_scope)
      values($1)`, [scope]);
    await assert.rejects(isolated.runtime.pool.query(`update social_feed_watermarks
      set rebuild_high_source_event_id='illegal-live',state_revision=state_revision+1,
        state_updated_at=current_timestamp where aggregate_scope=$1`, [scope]),
    /rebuild_high_source|check constraint/iu);
    await isolated.runtime.pool.query(`update social_feed_watermarks set
      projection_state='rebuilding',rebuild_generation=rebuild_generation+1,
      rebuild_high_commit_ordinal=1,rebuild_high_source_event_id='captured-event',
      rebuild_replayed_commit_ordinal=0,rebuild_started_at=current_timestamp,
      state_revision=state_revision+1,state_updated_at=current_timestamp
      where aggregate_scope=$1`, [scope]);
    await assert.rejects(isolated.runtime.pool.query(`update social_feed_watermarks set
      rebuild_high_source_event_id='tampered-event',state_revision=state_revision+1,
      state_updated_at=current_timestamp where aggregate_scope=$1`, [scope]), /immutable/u);
    await assert.rejects(isolated.runtime.pool.query(`update social_feed_watermarks set
      rebuild_high_source_event_id=null,state_revision=state_revision+1,
      state_updated_at=current_timestamp where aggregate_scope=$1`, [scope]),
    /captured high source|immutable|check constraint/iu);
    await isolated.runtime.pool.query(`update social_feed_watermarks set
      rebuild_replayed_commit_ordinal=1,state_revision=state_revision+1,
      state_updated_at=current_timestamp where aggregate_scope=$1`, [scope]);
    await isolated.runtime.pool.query(`update social_feed_watermarks set
      last_commit_ordinal=1,last_source_event_id='captured-event',projection_state='live',
      rebuild_high_commit_ordinal=null,rebuild_high_source_event_id=null,
      rebuild_replayed_commit_ordinal=null,rebuild_started_at=null,
      state_revision=state_revision+1,state_updated_at=current_timestamp
      where aggregate_scope=$1`, [scope]);
  });

  test.each(['pending', 'dead_letter'])('%s source rows remain fail-closed above floor',
    async (state) => {
      const scope = `feed-unresolved-${state}`;
      await insertEvent(scope, 1, state);
      await assert.rejects(rebuild(scope), /retained source row is unresolved/u);
      const status = await createPostgresSocialFeedOperationsRepository(isolated.runtime.pool)
        .inspectStatus();
      const progress = status.rebuilds.find((candidate) => candidate.aggregateScope === scope);
      assert.equal(progress?.retentionFloorCommitOrdinal, '0');
      assert.equal(progress?.gap, true);
    });
});
