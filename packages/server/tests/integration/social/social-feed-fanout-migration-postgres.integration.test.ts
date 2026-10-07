import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PREVIOUS_STABLE_MIGRATION = '202607310100_sync_tombstone_retention_config';
const FANOUT_MIGRATION = '202607311000_social_feed_fanout_continuation';

const FANOUT_COLUMNS = [
  'fanout_source_event_id',
  'fanout_commit_ordinal',
  'fanout_after_recipient_profile_id',
  'fanout_candidate_count',
  'fanout_started_at',
] as const;

describeWithPostgres('R5-02 Feed fan-out continuation expand migration', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_fanout_migration');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('migrates an empty database with fan-out columns, tuple check and fanout index', async () => {
    const columns = await watermarkColumns(isolated);
    for (const column of FANOUT_COLUMNS) {
      assert.ok(columns.has(column), `missing column ${column}`);
    }

    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select conname name from pg_constraint
       where conrelid = 'social_feed_watermarks'::regclass
      union all
      select indexname from pg_indexes
       where schemaname = current_schema()
         and tablename in ('social_feed_watermarks', 'follows')
      union all
      select tgname from pg_trigger
       where tgrelid = 'social_feed_watermarks'::regclass
         and not tgisinternal`);
    const names = new Set(catalog.rows.map((row) => row.name));
    for (const expected of [
      'social_feed_watermarks_fanout_tuple',
      'follows_target_actor_fanout_idx',
      'follows_actor_page_idx',
      'follows_target_page_idx',
      'social_feed_watermarks_pkey',
      'social_feed_watermarks_state_shape',
      'social_feed_watermarks_transition_guard',
    ]) {
      assert.ok(names.has(expected), `missing ${expected}`);
    }

    const index = await isolated.runtime.pool.query<{ indexdef: string }>(`
      select indexdef from pg_indexes
       where schemaname = current_schema()
         and indexname = 'follows_target_actor_fanout_idx'`);
    const indexdef = index.rows[0]?.indexdef ?? '';
    assert.match(indexdef, /target_profile_id,\s*actor_profile_id/i);
    assert.match(indexdef, /INCLUDE\s*\(\s*followed_at\s*\)/i);
    assert.doesNotMatch(indexdef, /followed_at\s+DESC/i);

    await isolated.runtime.pool.query(
      `insert into social_feed_watermarks(aggregate_scope) values('empty-idle')`,
    );
    const idle = await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_watermarks
       where aggregate_scope = 'empty-idle'
         and fanout_source_event_id is null
         and fanout_commit_ordinal is null
         and fanout_after_recipient_profile_id is null
         and fanout_candidate_count is null
         and fanout_started_at is null`);
    assert.equal(idle.rows[0]?.count, 1);
  });

  test('rejects illegal idle/running fan-out tuples, non-finite time and overlong identities', async () => {
    const scope = 'fanout-tuple-scope';
    await isolated.runtime.pool.query(
      `insert into social_feed_watermarks(aggregate_scope) values($1)`, [scope],
    );
    await advanceWatermark(isolated, scope, 10, 'seed-event');

    await rejectsConstraint(setFanout(isolated, scope, {
      fanout_candidate_count: 1,
    }), 'social_feed_watermarks_fanout_tuple');

    await rejectsConstraint(setFanout(isolated, scope, {
      fanout_commit_ordinal: 11,
      fanout_candidate_count: 1,
      fanout_started_at: 'current_timestamp',
    }), 'social_feed_watermarks_fanout_tuple');

    await rejectsConstraint(setFanout(isolated, scope, {
      fanout_source_event_id: 'running-event',
      fanout_candidate_count: 1,
      fanout_started_at: 'current_timestamp',
    }), 'social_feed_watermarks_fanout_tuple');

    await rejectsConstraint(setFanout(isolated, scope, {
      fanout_source_event_id: 'running-event',
      fanout_commit_ordinal: 11,
      fanout_candidate_count: 1,
    }), 'social_feed_watermarks_fanout_tuple');

    await rejectsConstraint(setFanout(isolated, scope, {
      fanout_source_event_id: 'running-event',
      fanout_commit_ordinal: 10,
      fanout_candidate_count: 1,
      fanout_started_at: 'current_timestamp',
    }), 'social_feed_watermarks_fanout_tuple');

    await rejectsConstraint(setFanout(isolated, scope, {
      fanout_source_event_id: 'running-event',
      fanout_commit_ordinal: 5,
      fanout_candidate_count: 1,
      fanout_started_at: 'current_timestamp',
    }), 'social_feed_watermarks_fanout_tuple');

    await rejectsConstraint(setFanout(isolated, scope, {
      fanout_source_event_id: 'running-event',
      fanout_commit_ordinal: 11,
      fanout_candidate_count: -1,
      fanout_started_at: 'current_timestamp',
    }), 'social_feed_watermarks_fanout_tuple');

    await rejectsConstraint(setFanout(isolated, scope, {
      fanout_source_event_id: 'running-event',
      fanout_commit_ordinal: 11,
      fanout_candidate_count: 1,
      fanout_started_at: "'infinity'::timestamptz",
    }), 'social_feed_watermarks_fanout_tuple');

    await rejectsConstraint(setFanout(isolated, scope, {
      fanout_source_event_id: 'x'.repeat(129),
      fanout_commit_ordinal: 11,
      fanout_candidate_count: 1,
      fanout_started_at: 'current_timestamp',
    }), 'social_feed_watermarks_fanout_tuple');

    await rejectsConstraint(setFanout(isolated, scope, {
      fanout_source_event_id: 'running-event',
      fanout_commit_ordinal: 11,
      fanout_after_recipient_profile_id: 'y'.repeat(257),
      fanout_candidate_count: 1,
      fanout_started_at: 'current_timestamp',
    }), 'social_feed_watermarks_fanout_tuple');

    await setFanout(isolated, scope, {
      fanout_source_event_id: 'running-event',
      fanout_commit_ordinal: 11,
      fanout_after_recipient_profile_id: 'cursor-recipient',
      fanout_candidate_count: 0,
      fanout_started_at: 'current_timestamp',
    });
    const running = await isolated.runtime.pool.query<{
      fanout_source_event_id: string;
      fanout_commit_ordinal: string;
      fanout_after_recipient_profile_id: string;
      fanout_candidate_count: string;
    }>(`
      select fanout_source_event_id,
             fanout_commit_ordinal::text,
             fanout_after_recipient_profile_id,
             fanout_candidate_count::text
        from social_feed_watermarks where aggregate_scope = $1`, [scope]);
    assert.deepEqual(running.rows[0], {
      fanout_source_event_id: 'running-event',
      fanout_commit_ordinal: '11',
      fanout_after_recipient_profile_id: 'cursor-recipient',
      fanout_candidate_count: '0',
    });

    await setFanout(isolated, scope, {});
    const cleared = await isolated.runtime.pool.query<{ present: number }>(`
      select count(*)::int present from social_feed_watermarks
       where aggregate_scope = $1
         and fanout_source_event_id is null
         and fanout_commit_ordinal is null
         and fanout_after_recipient_profile_id is null
         and fanout_candidate_count is null
         and fanout_started_at is null`, [scope]);
    assert.equal(cleared.rows[0]?.present, 1);
  });

  test('upgrades from tombstone retention head and recovers down/forward expand-only', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase5_fanout_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;

      assert.equal(await tablePresent(upgrade, 'social_feed_watermarks'), true);
      assert.equal(await tablePresent(upgrade, 'follows'), true);
      assert.equal(await columnPresent(upgrade, 'fanout_source_event_id'), false);
      assert.equal(await indexPresent(upgrade, 'follows_target_actor_fanout_idx'), false);
      assert.equal(await indexPresent(upgrade, 'follows_actor_page_idx'), true);
      assert.equal(await indexPresent(upgrade, 'follows_target_page_idx'), true);

      await upgrade.runtime.pool.query(
        `insert into social_feed_watermarks(aggregate_scope) values('upgrade-scope')`,
      );

      const latest = await migrator.migrateTo(FANOUT_MIGRATION);
      if (latest.error) throw latest.error;

      assert.equal(await columnPresent(upgrade, 'fanout_source_event_id'), true);
      assert.equal(await columnPresent(upgrade, 'fanout_commit_ordinal'), true);
      assert.equal(await columnPresent(upgrade, 'fanout_after_recipient_profile_id'), true);
      assert.equal(await columnPresent(upgrade, 'fanout_candidate_count'), true);
      assert.equal(await columnPresent(upgrade, 'fanout_started_at'), true);
      assert.equal(await indexPresent(upgrade, 'follows_target_actor_fanout_idx'), true);
      assert.equal(await indexPresent(upgrade, 'follows_actor_page_idx'), true);
      assert.equal(await indexPresent(upgrade, 'follows_target_page_idx'), true);

      const preserved = await upgrade.runtime.pool.query<{ aggregate_scope: string }>(`
        select aggregate_scope from social_feed_watermarks
         where aggregate_scope = 'upgrade-scope'
           and fanout_source_event_id is null`);
      assert.equal(preserved.rowCount, 1);

      const index = await upgrade.runtime.pool.query<{ indexdef: string }>(`
        select indexdef from pg_indexes
         where schemaname = current_schema()
           and indexname = 'follows_target_actor_fanout_idx'`);
      assert.match(index.rows[0]?.indexdef ?? '', /target_profile_id,\s*actor_profile_id/i);
      assert.match(index.rows[0]?.indexdef ?? '', /INCLUDE\s*\(\s*followed_at\s*\)/i);

      const down = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (down.error) throw down.error;
      assert.equal(await columnPresent(upgrade, 'fanout_source_event_id'), false);
      assert.equal(await indexPresent(upgrade, 'follows_target_actor_fanout_idx'), false);
      assert.equal(await indexPresent(upgrade, 'follows_actor_page_idx'), true);
      assert.equal(await indexPresent(upgrade, 'follows_target_page_idx'), true);
      assert.equal(await tablePresent(upgrade, 'social_feed_watermarks'), true);
      assert.equal(await tablePresent(upgrade, 'follows'), true);

      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      assert.equal(await columnPresent(upgrade, 'fanout_started_at'), true);
      assert.equal(await indexPresent(upgrade, 'follows_target_actor_fanout_idx'), true);
      assert.equal(await indexPresent(upgrade, 'follows_actor_page_idx'), true);
      assert.equal(await indexPresent(upgrade, 'follows_target_page_idx'), true);
    } finally {
      await upgrade.close();
    }
  }, 120_000);
});

async function watermarkColumns(runtime: IsolatedPostgresRuntime): Promise<Set<string>> {
  const columns = await runtime.runtime.pool.query<{ column_name: string }>(`
    select column_name from information_schema.columns
     where table_schema = current_schema() and table_name = 'social_feed_watermarks'`);
  return new Set(columns.rows.map((row) => row.column_name));
}

async function columnPresent(
  runtime: IsolatedPostgresRuntime,
  column: string,
): Promise<boolean> {
  return (await watermarkColumns(runtime)).has(column);
}

async function indexPresent(
  runtime: IsolatedPostgresRuntime,
  indexName: string,
): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(`
    select exists(
      select 1 from pg_indexes
       where schemaname = current_schema() and indexname = $1
    ) present`, [indexName])).rows[0]?.present ?? false;
}

async function tablePresent(runtime: IsolatedPostgresRuntime, table: string): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(
    `select to_regclass(current_schema() || '.' || $1) is not null present`, [table],
  )).rows[0]?.present ?? false;
}

async function advanceWatermark(
  runtime: IsolatedPostgresRuntime,
  scope: string,
  ordinal: number,
  eventId: string,
): Promise<void> {
  await runtime.runtime.pool.query(`
    update social_feed_watermarks
       set last_commit_ordinal = $2,
           last_source_event_id = $3,
           state_revision = state_revision + 1,
           state_updated_at = current_timestamp
     where aggregate_scope = $1`, [scope, ordinal, eventId]);
}

type FanoutPatch = {
  fanout_source_event_id?: string;
  fanout_commit_ordinal?: number;
  fanout_after_recipient_profile_id?: string;
  fanout_candidate_count?: number;
  fanout_started_at?: string;
};

function setFanout(
  runtime: IsolatedPostgresRuntime,
  scope: string,
  patch: FanoutPatch,
): Promise<unknown> {
  const startedAtSql = patch.fanout_started_at ?? 'null';
  return runtime.runtime.pool.query(`
    update social_feed_watermarks
       set fanout_source_event_id = $2,
           fanout_commit_ordinal = $3,
           fanout_after_recipient_profile_id = $4,
           fanout_candidate_count = $5,
           fanout_started_at = ${startedAtSql},
           state_revision = state_revision + 1,
           state_updated_at = current_timestamp
     where aggregate_scope = $1`, [
    scope,
    patch.fanout_source_event_id ?? null,
    patch.fanout_commit_ordinal ?? null,
    patch.fanout_after_recipient_profile_id ?? null,
    patch.fanout_candidate_count ?? null,
  ]);
}

async function rejectsConstraint(promise: Promise<unknown>, constraint: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { constraint?: unknown }).constraint, constraint);
    return true;
  });
}
