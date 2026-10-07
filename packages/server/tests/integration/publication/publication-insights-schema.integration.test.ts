import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PREVIOUS_HEAD = '202609060100_identity_profile_about';
const INSIGHTS_MIGRATION = '202609070100_publication_insights';
const EVENT_TABLE = 'publication_insight_events';
const DAILY_TABLE = 'publication_insight_daily';
const HASH = Buffer.alloc(32, 9);

describeWithPostgres('publication insight schema (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('pi01_insight_schema');
    const migrator = createMigrator(isolated.runtime.db, 'migrations', isolated.schema);
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('empty database full migrate creates insight tables, checks, and indexes', async () => {
    assert.equal(await tablePresent(isolated, EVENT_TABLE), true);
    assert.equal(await tablePresent(isolated, DAILY_TABLE), true);

    const eventColumns = await columnLayout(isolated, EVENT_TABLE);
    assert.deepEqual(eventColumns.map((column) => column.column_name), [
      'id', 'collection_id', 'event_type', 'node_id', 'visitor_hash', 'occurred_at',
    ]);
    const eventByName = Object.fromEntries(eventColumns.map((column) => [column.column_name, column]));
    assert.equal(eventByName.visitor_hash?.data_type, 'bytea');
    assert.equal(eventByName.visitor_hash?.is_nullable, 'NO');
    assert.equal(eventByName.node_id?.is_nullable, 'YES');
    assert.equal(eventByName.occurred_at?.data_type, 'timestamp with time zone');

    const dailyColumns = await columnLayout(isolated, DAILY_TABLE);
    assert.deepEqual(dailyColumns.map((column) => column.column_name), [
      'collection_id', 'day', 'event_type', 'node_id', 'count',
    ]);
    const dailyByName = Object.fromEntries(dailyColumns.map((column) => [column.column_name, column]));
    assert.equal(dailyByName.day?.data_type, 'date');
    assert.equal(dailyByName.node_id?.is_nullable, 'NO');
    assert.equal(dailyByName.count?.data_type, 'bigint');

    const constraints = await isolated.runtime.pool.query<{ conname: string }>(
      `select conname from pg_constraint
        where connamespace = current_schema()::regnamespace
          and conname = any($1::text[])`,
      [[
        'publication_insight_events_pkey',
        'publication_insight_events_node_ck',
        'publication_insight_daily_pkey',
      ]],
    );
    assert.deepEqual(
      new Set(constraints.rows.map((row) => row.conname)),
      new Set([
        'publication_insight_events_pkey',
        'publication_insight_events_node_ck',
        'publication_insight_daily_pkey',
      ]),
    );

    // T-09 (202609260500) drops publication_insight_daily_owner_window_idx:
    // its (collection_id, day) key is a strict prefix of the composite PK.
    // The T-01 purge index publication_insight_daily_day_idx remains.
    const indexes = await isolated.runtime.pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = current_schema()
          and indexname = any($1::text[])`,
      [[
        'publication_insight_events_collection_time_idx',
        'publication_insight_daily_day_idx',
        'publication_insight_daily_owner_window_idx',
      ]],
    );
    assert.deepEqual(
      new Set(indexes.rows.map((row) => row.indexname)),
      new Set([
        'publication_insight_events_collection_time_idx',
        'publication_insight_daily_day_idx',
      ]),
    );
  });

  test('upgrade from identity_profile_about installs insight tables', async () => {
    const upgrade = await createIsolatedPostgresRuntime('pi01_insight_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202609070100_publication_insights');
      const previous = await migrator.migrateTo(PREVIOUS_HEAD);
      if (previous.error) throw previous.error;

      assert.equal(await tablePresent(upgrade, EVENT_TABLE), false);
      assert.equal(await tablePresent(upgrade, DAILY_TABLE), false);

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const names = await upgrade.runtime.pool.query<{ name: string }>(
        `select name from kysely_migration where name = $1`,
        [INSIGHTS_MIGRATION],
      );
      assert.equal(names.rows[0]?.name, INSIGHTS_MIGRATION);
      assert.equal(await tablePresent(upgrade, EVENT_TABLE), true);
      assert.equal(await tablePresent(upgrade, DAILY_TABLE), true);

      const down = await migrator.migrateTo(PREVIOUS_HEAD);
      if (down.error) throw down.error;
      assert.equal(await tablePresent(upgrade, EVENT_TABLE), false);
      assert.equal(await tablePresent(upgrade, DAILY_TABLE), false);
      assert.equal(await tablePresent(upgrade, 'collections'), true);

      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      assert.equal(await tablePresent(upgrade, EVENT_TABLE), true);
      assert.equal(await tablePresent(upgrade, DAILY_TABLE), true);
      await migrator.upgradeToCurrentLatest();
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('CHECK rejects illegal event_type on both tables', async () => {
    const fixture = await bootstrapCollection(isolated, 'schema-event-type');
    await expectPgError(
      isolated,
      `insert into publication_insight_events
         (id, collection_id, event_type, node_id, visitor_hash, occurred_at)
       values ('evt-bad-type', $1, 'click', null, $2, timestamptz '2026-08-18T00:00:00Z')`,
      [fixture.collectionId, HASH],
      '23514',
      'illegal event_type must fail the events CHECK',
    );
    await expectPgError(
      isolated,
      `insert into publication_insight_daily
         (collection_id, day, event_type, node_id, count)
       values ($1, date '2026-08-18', 'page_view', '', 1)`,
      [fixture.collectionId],
      '23514',
      'illegal event_type must fail the daily CHECK',
    );
  });

  test('resource_open without node_id fails insert', async () => {
    const fixture = await bootstrapCollection(isolated, 'schema-resource-open');
    await expectPgError(
      isolated,
      `insert into publication_insight_events
         (id, collection_id, event_type, node_id, visitor_hash, occurred_at)
       values ('evt-resource-null', $1, 'resource_open', null, $2, timestamptz '2026-08-18T00:00:00Z')`,
      [fixture.collectionId, HASH],
      '23514',
      'resource_open without node_id must fail publication_insight_events_node_ck',
    );
  });

  test('collection_view and preview_open with node_id fail insert', async () => {
    const fixture = await bootstrapCollection(isolated, 'schema-view-node');
    for (const eventType of ['collection_view', 'preview_open'] as const) {
      await expectPgError(
        isolated,
        `insert into publication_insight_events
           (id, collection_id, event_type, node_id, visitor_hash, occurred_at)
         values ($1, $2, $3, $4, $5, timestamptz '2026-08-18T00:00:00Z')`,
        [`evt-${eventType}-node`, fixture.collectionId, eventType, fixture.bookmarkId, HASH],
        '23514',
        `${eventType} with node_id must fail publication_insight_events_node_ck`,
      );
    }
  });

  test('events id is a primary key and daily composite key is unique', async () => {
    const fixture = await bootstrapCollection(isolated, 'schema-pk');
    await isolated.runtime.pool.query(
      `insert into publication_insight_events
         (id, collection_id, event_type, node_id, visitor_hash, occurred_at)
       values ('evt-pk', $1, 'collection_view', null, $2, timestamptz '2026-08-18T00:00:00Z')`,
      [fixture.collectionId, HASH],
    );
    await expectPgError(
      isolated,
      `insert into publication_insight_events
         (id, collection_id, event_type, node_id, visitor_hash, occurred_at)
       values ('evt-pk', $1, 'preview_open', null, $2, timestamptz '2026-08-18T01:00:00Z')`,
      [fixture.collectionId, HASH],
      '23505',
      'duplicate event id must violate the primary key',
    );

    await isolated.runtime.pool.query(
      `insert into publication_insight_daily
         (collection_id, day, event_type, node_id, count)
       values ($1, date '2026-08-18', 'collection_view', '', 1)`,
      [fixture.collectionId],
    );
    await expectPgError(
      isolated,
      `insert into publication_insight_daily
         (collection_id, day, event_type, node_id, count)
       values ($1, date '2026-08-18', 'collection_view', '', 2)`,
      [fixture.collectionId],
      '23505',
      'duplicate daily (collection_id, day, event_type, node_id) must violate the composite PK',
    );
  });
});

async function tablePresent(runtime: IsolatedPostgresRuntime, table: string): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(
    `select to_regclass(current_schema() || '.' || $1) is not null present`,
    [table],
  )).rows[0]?.present ?? false;
}

async function columnLayout(
  runtime: IsolatedPostgresRuntime,
  table: string,
): Promise<ReadonlyArray<{ column_name: string; data_type: string; is_nullable: string }>> {
  const result = await runtime.runtime.pool.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `select column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = current_schema() and table_name = $1
      order by ordinal_position`,
    [table],
  );
  return result.rows;
}

async function expectPgError(
  runtime: IsolatedPostgresRuntime,
  sqlText: string,
  values: readonly unknown[],
  code: string,
  reason: string,
): Promise<void> {
  await assert.rejects(
    () => runtime.runtime.pool.query(sqlText, [...values]),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, code, `${reason} (expected SQLSTATE ${code})`);
      return true;
    },
  );
}

async function bootstrapCollection(
  runtime: IsolatedPostgresRuntime,
  suffix: string,
): Promise<{ collectionId: string; bookmarkId: string }> {
  const collectionId = `col-${suffix}`;
  const rootId = `root-${suffix}`;
  const bookmarkId = `bm-${suffix}`;
  const slug = `schema-${suffix.toLowerCase().replaceAll('_', '-')}`;
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values ($1,'collection',current_timestamp),($2,'node',current_timestamp),($3,'node',current_timestamp)`,
      [collectionId, rootId, bookmarkId],
    );
    await client.query(
      `insert into collections(
         id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
         root_node_id, root_node_is_root, resource_revision, content_revision, policy_revision,
         commit_ordinal, created_at, updated_at)
       values ($1,'owner-schema','Schema fixture','bookmarks','public',$2,current_timestamp,
         $3,true,'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, slug, rootId],
    );
    await client.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at)
       values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',current_timestamp,current_timestamp)`,
      [rootId, collectionId],
    );
    await client.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at)
       values ($1,$2,$3,'bookmark',false,'Bookmark','https://example.test/schema','A',
         'r1','ch1',current_timestamp,current_timestamp)`,
      [bookmarkId, collectionId, rootId],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { collectionId, bookmarkId };
}
