import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PREVIOUS_HEAD = '202609070100_publication_insights';
const INVITES_MIGRATION = '202609080100_collection_invites';
const INVITE_TABLE = 'collection_invites';
const SHARED_LIST_INDEX = 'collection_members_shared_list_idx';
const PENDING_EMAIL_UNIQUE = 'collection_invites_pending_email_unique';
const SUBJECT_PENDING_INDEX = 'collection_invites_subject_pending_idx';
const PENDING_EMAIL_INDEX = 'collection_invites_pending_email_idx';
const DELIVERIES_TABLE = 'collection_invite_deliveries';
const DUE_INDEX = 'collection_invite_deliveries_due_idx';
const LEASED_INDEX = 'collection_invite_deliveries_leased_until_idx';
const INVITE_INDEXES = [
  PENDING_EMAIL_UNIQUE,
  SUBJECT_PENDING_INDEX,
  SHARED_LIST_INDEX,
  PENDING_EMAIL_INDEX,
  DUE_INDEX,
  LEASED_INDEX,
] as const;

describeWithPostgres('collection invite schema (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sc01_invite_schema');
    const migrator = createMigrator(isolated.runtime.db, 'migrations', isolated.schema);
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('empty database full migrate creates collection_invites, checks, and indexes', async () => {
    assert.equal(await tablePresent(isolated, INVITE_TABLE), true);
    assert.equal(await tablePresent(isolated, DELIVERIES_TABLE), true);

    const columns = await columnLayout(isolated, INVITE_TABLE);
    assert.deepEqual(columns.map((column) => column.column_name), [
      'id',
      'collection_id',
      'role',
      'email_normalized',
      'invited_subject_id',
      'invited_by_subject_id',
      'status',
      'expires_at',
      'created_at',
      'resolved_at',
      'accepted_subject_id',
      'collection_title_snapshot',
    ]);
    const byName = Object.fromEntries(columns.map((column) => [column.column_name, column]));
    assert.equal(byName.invited_subject_id?.is_nullable, 'YES');
    assert.equal(byName.accepted_subject_id?.is_nullable, 'YES');
    assert.equal(byName.resolved_at?.is_nullable, 'YES');
    assert.equal(byName.email_normalized?.is_nullable, 'NO');
    assert.equal(byName.expires_at?.data_type, 'timestamp with time zone');

    const indexes = await isolated.runtime.pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = current_schema()
          and indexname = any($1::text[])`,
      [[...INVITE_INDEXES]],
    );
    assert.deepEqual(new Set(indexes.rows.map((row) => row.indexname)), new Set(INVITE_INDEXES));
  });

  test('upgrade from publication_insights installs invite tables and indexes', async () => {
    const upgrade = await createIsolatedPostgresRuntime('sc01_invite_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202609130100_collection_invite_deliveries_leased_idx');
      const previous = await migrator.migrateTo(PREVIOUS_HEAD);
      if (previous.error) throw previous.error;

      assert.equal(await tablePresent(upgrade, INVITE_TABLE), false);
      assert.equal(await tablePresent(upgrade, DELIVERIES_TABLE), false);
      for (const index of INVITE_INDEXES) {
        assert.equal(await indexPresent(upgrade, index), false, index);
      }

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const names = await upgrade.runtime.pool.query<{ name: string }>(
        `select name from kysely_migration where name = $1`,
        [INVITES_MIGRATION],
      );
      assert.equal(names.rows[0]?.name, INVITES_MIGRATION);
      await assertInviteSchema(upgrade, true);

      const down = await migrator.migrateTo(PREVIOUS_HEAD);
      if (down.error) throw down.error;
      await assertInviteSchema(upgrade, false);
      assert.equal(await tablePresent(upgrade, 'collections'), true);
      assert.equal(await tablePresent(upgrade, 'collection_members'), true);
      assert.equal(await tablePresent(upgrade, 'publication_insight_events'), true);

      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      await assertInviteSchema(upgrade, true);
      await migrator.upgradeToCurrentLatest();
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('pending (collection_id, email_normalized) unique — second pending insert fails', async () => {
    const fixture = await bootstrapCollection(isolated, 'schema-pending-unique');
    await isolated.runtime.pool.query(
      `insert into collection_invites (
         id, collection_id, role, email_normalized, invited_by_subject_id, status, expires_at
       ) values ('inv-pending-a', $1, 'editor', 'same@example.test', 'owner-schema', 'pending',
         timestamptz '2026-08-26T00:00:00Z')`,
      [fixture.collectionId],
    );
    await expectPgError(
      isolated,
      `insert into collection_invites (
         id, collection_id, role, email_normalized, invited_by_subject_id, status, expires_at
       ) values ('inv-pending-b', $1, 'viewer', 'same@example.test', 'owner-schema', 'pending',
         timestamptz '2026-08-27T00:00:00Z')`,
      [fixture.collectionId],
      '23505',
      'second pending invite for the same collection email must violate pending unique',
    );
  });

  test('rolling back to publication_insights drops invite tables and indexes', async () => {
    const isolatedDown = await createIsolatedPostgresRuntime('sc01_invite_down');
    try {
      const migrator = createHistoricalMigrator(isolatedDown, '202609130100_collection_invite_deliveries_leased_idx');
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      await assertInviteSchema(isolatedDown, true);

      const down = await migrator.migrateTo(PREVIOUS_HEAD);
      if (down.error) throw down.error;
      await assertInviteSchema(isolatedDown, false);
      assert.equal(await tablePresent(isolatedDown, 'collections'), true);
      assert.equal(await tablePresent(isolatedDown, 'collection_members'), true);
      assert.equal(await tablePresent(isolatedDown, 'publication_insight_daily'), true);
      await migrator.upgradeToCurrentLatest();
    } finally {
      await isolatedDown.close();
    }
  }, 120_000);
});

async function tablePresent(runtime: IsolatedPostgresRuntime, table: string): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(
    `select to_regclass(current_schema() || '.' || $1) is not null present`,
    [table],
  )).rows[0]?.present ?? false;
}

async function indexPresent(runtime: IsolatedPostgresRuntime, index: string): Promise<boolean> {
  return (await runtime.runtime.pool.query<{ present: boolean }>(
    `select exists(
       select 1 from pg_indexes
        where schemaname = current_schema() and indexname = $1
     ) present`,
    [index],
  )).rows[0]?.present ?? false;
}

async function assertInviteSchema(
  runtime: IsolatedPostgresRuntime,
  present: boolean,
): Promise<void> {
  assert.equal(await tablePresent(runtime, INVITE_TABLE), present);
  assert.equal(await tablePresent(runtime, DELIVERIES_TABLE), present);
  for (const index of INVITE_INDEXES) {
    assert.equal(await indexPresent(runtime, index), present, index);
  }
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
): Promise<{ collectionId: string }> {
  const collectionId = `col-${suffix}`;
  const rootId = `root-${suffix}`;
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values ($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
      [collectionId, rootId],
    );
    await client.query(
      `insert into collections(
         id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
         root_node_id, root_node_is_root, resource_revision, content_revision, policy_revision,
         commit_ordinal, created_at, updated_at)
       values ($1,'owner-schema','Schema fixture','bookmarks','private',null,null,
         $2,true,'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, rootId],
    );
    await client.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at)
       values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',current_timestamp,current_timestamp)`,
      [rootId, collectionId],
    );
    await client.query(
      `insert into collection_members(collection_id, subject_id, role, granted_at)
       values ($1,'owner-schema','owner',current_timestamp)`,
      [collectionId],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { collectionId };
}
