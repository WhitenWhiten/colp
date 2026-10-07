import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCommunityRankingRefreshUnitOfWork } from '../../../src/infrastructure/community/community-ranking-postgres.js';
import { createCommunityRankRefreshWorkerRoutes } from '../../../src/infrastructure/community/community-rank-refresh-outbox.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

/**
 * RUNTIME-03: the worker route must never commit a streamed ranking rebuild
 * without owning its durable outbox attempt.
 *
 * The route is wired to the **real** `executeAttempt`, so what the assertions
 * observe is the production transaction: streamed snapshot/entry writes
 * followed by the locking outbox lease fence. The wrapper injects an
 * `afterWork` hook between the rebuild and the fence and never decides the
 * outcome itself. Pre-fix the route called a fence-less `execute`, so each
 * negative case committed `community_rank_snapshots` rows that outlive the lost
 * attempt; this oracle fails on that behavior rather than on the old method
 * signature.
 */
describeWithPostgres('RUNTIME-03 rank refresh owns its attempt through commit', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('rank_attempt_fence', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  test.each(['missing', 'wrong-generation', 'lease-lost-after-work', 'owned'] as const)('%s', async (mode) => {
    const pool = isolated.runtime.pool;
    const outboxId = randomUUID(), eventId = randomUUID();
    if (mode !== 'missing') {
      await pool.query(`insert into resource_id_ledger(resource_id,resource_type)
        values($1,'outbox'),($2,'domain-event')`, [outboxId, eventId]);
      await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
        handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
        commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,locked_until)
        values($1,$2,'community.rank-refresh',1,'community.hot-ranking-refresh','projection_latest_only',
        'community','community-ranking','hot-v1','hot-v1',7,current_timestamp,'{"reason":"scheduled"}',
        'leased',1,current_timestamp,1,current_timestamp+interval '1 minute')`, [outboxId,eventId]);
    }
    const count = async () => (await pool.query(`select
      (select count(*) from community_rank_snapshots)::int snapshots,
      (select count(*) from community_rank_entries)::int entries`)).rows[0];
    const before = await count();
    let rebuilt = false;
    const unit = createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db);
    const [route] = createCommunityRankRefreshWorkerRoutes({ refreshUnitOfWork: {
      // Composed wrapper over the production fenced transaction so the test can
      // arrange the takeover at the only honest point: after the streamed
      // rebuild, before the production fence evaluates the lease.
      executeAttempt: (work, execution) => unit.executeAttempt(async (ports) => {
        const result = await work(ports);
        rebuilt = true;
        if (mode === 'lease-lost-after-work') await pool.query(
          'update outbox_events set lease_generation=lease_generation+1 where outbox_id=$1', [outboxId]);
        return result;
      }, execution),
    } });
    const result = route!.handle({
      idempotencyKey: eventId,
      attempt: { outboxId, leaseGeneration: mode === 'wrong-generation' ? '999' : '1' },
      signal: new AbortController().signal,
      envelope: { event_id:eventId,event_type:'community.rank-refresh',event_version:1,
        aggregate_identity: { aggregate_type:'community',aggregate_id:'community-ranking',aggregate_scope:'hot-v1' },
        aggregate_revision:'hot-v1',commit_ordinal:'7',occurred_at:new Date().toISOString(),payload:{reason:'scheduled'},
      } as never,
    });
    if (mode === 'owned') {
      await result;
      assert.equal((await count()).snapshots, before.snapshots + 1);
    } else {
      await assert.rejects(result, /attempt lease was lost/u);
      // The streamed rebuild really ran before the fence, so the unchanged
      // counts below are a rollback and not a vacuous no-op.
      assert.equal(rebuilt, true, 'the rebuild ran before the production fence');
      assert.deepEqual(await count(), before, 'snapshot and entries must roll back with the attempt');
    }
  });
});
