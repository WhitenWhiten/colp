/**
 * T-03 follow-up: denormalized Know-N subject copies follow the mapped
 * Better Auth user.id. Recovers the Explore/public-collection break after
 * `202609230200` rewrote `accounts.subject_id` alone. Re-entry is a no-op.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { up as cascadeSubjectIds } from '../../../migrations/202609230300_subject_id_reference_cascade.js';
import { up as repairPayloadOwner } from '../../../migrations/202609230400_collection_payload_owner_subject_id.js';
import { up as repairCatalogAndNodes } from '../../../migrations/202609230500_collection_catalog_and_node_payloads.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('subject_id reference cascade', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('t03_subject_cascade', {
      maxConnections: 4,
      applicationName: 'known-t03-subject-cascade',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('rewrites leftover collection owners after accounts.subject_id already matches BA user.id', async () => {
    await resetTables();
    await seedAuthUser('ba-mapped', 'Mapped', 'mapped@example.test');
    await seedAccount('acct-mapped', 'ba-mapped', 'mapped@example.test');
    await seedAccount('acct-unmapped', 'subj-unmapped', 'unmapped@example.test');
    await seedMapping('ba-mapped', 'acct-mapped');
    await seedIdentity('ident-mapped', 'acct-mapped', 'subj-mapped');
    await seedCollection('col-leftover', 'subj-mapped', 'root-leftover');
    await seedCollection('col-unmapped-copy', 'subj-unmapped', 'root-unmapped-copy');
    await seedMember('col-leftover', 'subj-mapped', 'owner');
    await seedMember('col-unmapped-copy', 'subj-unmapped', 'owner');

    await cascadeSubjectIds(isolated.runtime.db);

    assert.equal(await accountSubject('acct-mapped'), 'ba-mapped');
    assert.equal(await accountSubject('acct-unmapped'), 'subj-unmapped');
    assert.equal(await collectionOwner('col-leftover'), 'ba-mapped');
    assert.equal(await collectionOwner('col-unmapped-copy'), 'subj-unmapped');
    assert.equal(await memberSubject('col-leftover'), 'ba-mapped');
    assert.equal(await memberSubject('col-unmapped-copy'), 'subj-unmapped');
    assert.equal(await identitySubject('ident-mapped'), 'subj-mapped');

    await cascadeSubjectIds(isolated.runtime.db);
    assert.equal(await collectionOwner('col-leftover'), 'ba-mapped');
    assert.equal(await accountSubject('acct-mapped'), 'ba-mapped');
    assert.equal(await identitySubject('ident-mapped'), 'subj-mapped');
  });

  test('rewrites a mapped account that seed restored onto the old subject_id', async () => {
    await resetTables();
    await seedAuthUser('seed-auser-u01', 'Lin', 'lin.yichen@example.test');
    await seedAccount('acct-seeded', 'sub-u01', 'lin.yichen@example.test');
    await seedMapping('seed-auser-u01', 'acct-seeded');
    await seedCollection('col-seeded', 'sub-u01', 'root-seeded');
    await seedMember('col-seeded', 'sub-u01', 'owner');

    await cascadeSubjectIds(isolated.runtime.db);

    assert.equal(await accountSubject('acct-seeded'), 'seed-auser-u01');
    assert.equal(await collectionOwner('col-seeded'), 'seed-auser-u01');
    assert.equal(await memberSubject('col-seeded'), 'seed-auser-u01');

    await cascadeSubjectIds(isolated.runtime.db);
    assert.equal(await accountSubject('acct-seeded'), 'seed-auser-u01');
  });

  test('rewrites digest series owners and members onto the mapped BA user.id', async () => {
    await resetTables();
    await seedAuthUser('seed-auser-u01', 'Lin', 'lin.yichen@example.test');
    await seedAccount('acct-seeded', 'sub-u01', 'lin.yichen@example.test');
    await seedMapping('seed-auser-u01', 'acct-seeded');
    await seedDigestSeries('series-seeded', 'sub-u01');

    await cascadeSubjectIds(isolated.runtime.db);

    assert.equal(await accountSubject('acct-seeded'), 'seed-auser-u01');
    assert.equal(await digestOwner('series-seeded'), 'seed-auser-u01');
    assert.equal(await digestMemberRole('series-seeded', 'seed-auser-u01'), 'owner');

    await cascadeSubjectIds(isolated.runtime.db);
    assert.equal(await digestOwner('series-seeded'), 'seed-auser-u01');
    assert.equal(await digestMemberRole('series-seeded', 'seed-auser-u01'), 'owner');
  });

  test('rewrites payload_json.ownerSubjectId with the remapped owner', async () => {
    await resetTables();
    await seedAuthUser('ba-mapped', 'Mapped', 'mapped@example.test');
    await seedAccount('acct-mapped', 'ba-mapped', 'mapped@example.test');
    await seedMapping('ba-mapped', 'acct-mapped');
    await seedIdentity('ident-mapped', 'acct-mapped', 'subj-mapped');
    await seedCollection('col-payload', 'subj-mapped', 'root-payload');
    await seedCollectionPayload('col-payload', 'subj-mapped');

    await cascadeSubjectIds(isolated.runtime.db);

    assert.equal(await collectionOwner('col-payload'), 'ba-mapped');
    assert.equal(await collectionPayloadOwner('col-payload'), 'ba-mapped');
  });

  test('repairs a leftover payload owner after the column remap already landed', async () => {
    await resetTables();
    await seedAuthUser('ba-mapped', 'Mapped', 'mapped@example.test');
    await seedAccount('acct-mapped', 'ba-mapped', 'mapped@example.test');
    await seedMapping('ba-mapped', 'acct-mapped');
    await seedCollection('col-stale-payload', 'ba-mapped', 'root-stale-payload');
    await seedCollectionPayload('col-stale-payload', 'subj-mapped');

    await repairPayloadOwner(isolated.runtime.db);

    assert.equal(await collectionOwner('col-stale-payload'), 'ba-mapped');
    assert.equal(await collectionPayloadOwner('col-stale-payload'), 'ba-mapped');

    await repairPayloadOwner(isolated.runtime.db);
    assert.equal(await collectionPayloadOwner('col-stale-payload'), 'ba-mapped');
  });

  test('moves catalog extras into extensions and backfills a missing root payload', async () => {
    await resetTables();
    await seedAuthUser('ba-mapped', 'Mapped', 'mapped@example.test');
    await seedAccount('acct-mapped', 'ba-mapped', 'mapped@example.test');
    await seedMapping('ba-mapped', 'acct-mapped');
    await seedCollection('col-catalog', 'ba-mapped', 'root-catalog');
    await isolated.runtime.pool.query(
      `update collections
          set payload_json = jsonb_build_object(
                'ownerSubjectId', 'ba-mapped',
                'resourceType', 'collection',
                'tags', '["ai"]'::jsonb,
                'language', 'zh',
                'extensions', '{}'::jsonb
              ),
              payload_schema_version = 1,
              payload_authority_status = 'backfilled'
        where id = 'col-catalog'`,
    );

    await repairCatalogAndNodes(isolated.runtime.db);

    const collection = await isolated.runtime.pool.query<{
      tags: unknown;
      language: unknown;
      ext_tags: unknown;
    }>(
      `select payload_json->'tags' as tags,
              payload_json->'language' as language,
              payload_json->'extensions'->'tags' as ext_tags
         from collections where id = 'col-catalog'`,
    );
    assert.equal(collection.rows[0]?.tags, null);
    assert.equal(collection.rows[0]?.language, null);
    assert.deepEqual(collection.rows[0]?.ext_tags, ['ai']);

    const root = await isolated.runtime.pool.query<{ resource_type: string | null }>(
      `select payload_json->>'resourceType' as resource_type from nodes where id = 'root-catalog'`,
    );
    assert.equal(root.rows[0]?.resource_type, 'node');
  });

  test('aligns accounts and collection copies when T-03 has not rewritten accounts yet', async () => {
    await resetTables();
    await seedAuthUser('ba-mapped', 'Mapped', 'mapped@example.test');
    await seedAccount('acct-mapped', 'subj-mapped', 'mapped@example.test');
    await seedMapping('ba-mapped', 'acct-mapped');
    await seedCollection('col-align', 'subj-mapped', 'root-align');
    await seedCollectionPayload('col-align', 'subj-mapped');
    await seedMember('col-align', 'subj-mapped', 'owner');

    await cascadeSubjectIds(isolated.runtime.db);

    assert.equal(await accountSubject('acct-mapped'), 'ba-mapped');
    assert.equal(await collectionOwner('col-align'), 'ba-mapped');
    assert.equal(await collectionPayloadOwner('col-align'), 'ba-mapped');
    assert.equal(await memberSubject('col-align'), 'ba-mapped');
  });

  test('collision on a pre-inserted target subject_id fail-closes and applies nothing', async () => {
    await resetTables();
    await seedAuthUser('ba-mapped', 'Mapped', 'mapped@example.test');
    await seedAccount('acct-mapped', 'subj-mapped', 'mapped@example.test');
    await seedAccount('acct-holder', 'ba-mapped', 'holder@example.test');
    await seedMapping('ba-mapped', 'acct-mapped');
    await seedCollection('col-collide', 'subj-mapped', 'root-collide');

    await assert.rejects(
      () => cascadeSubjectIds(isolated.runtime.db),
      (error: unknown) => {
        assert.match(String(error), /subject_id_reference_cascade refused/);
        return true;
      },
    );

    assert.equal(await accountSubject('acct-mapped'), 'subj-mapped');
    assert.equal(await collectionOwner('col-collide'), 'subj-mapped');
    assert.equal(await accountSubject('acct-holder'), 'ba-mapped');
  });

  test('an orphan collection owner with no remap source fail-closes', async () => {
    await resetTables();
    await seedAuthUser('ba-mapped', 'Mapped', 'mapped@example.test');
    await seedAccount('acct-mapped', 'ba-mapped', 'mapped@example.test');
    await seedMapping('ba-mapped', 'acct-mapped');
    await seedCollection('col-orphan', 'ghost-subj', 'root-orphan');

    await assert.rejects(
      () => cascadeSubjectIds(isolated.runtime.db),
      (error: unknown) => {
        assert.match(String(error), /owner_subject_id that matches no account/);
        return true;
      },
    );

    assert.equal(await collectionOwner('col-orphan'), 'ghost-subj');
    assert.equal(await accountSubject('acct-mapped'), 'ba-mapped');
  });

  async function resetTables(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await truncateGuardedTablesInTransaction(client, `
        truncate table
          digest_members,
          digest_editions,
          digest_series,
          collection_members,
          collection_invites,
          nodes,
          collections,
          account_identities,
          auth_user_account_map,
          profile_handles,
          profiles,
          accounts,
          sync_collection_purge_state,
          sync_collection_effect_cutovers,
          resource_id_ledger,
          "auth_users"
        cascade
      `);
      await client.query('commit');
    } catch (error) {
      try { await client.query('rollback'); } catch { /* already failed */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedAuthUser(id: string, name: string, email: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into "auth_users" ("id","name","email","emailVerified") values ($1, $2, $3, true)`,
      [id, name, email],
    );
  }

  async function seedAccount(id: string, subjectId: string, email: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into accounts (id, subject_id, status, email) values ($1, $2, 'active', $3)`,
      [id, subjectId, email],
    );
    await isolated.runtime.pool.query(
      `insert into profiles (account_id, display_name) values ($1, $2)`,
      [id, `Name ${id}`],
    );
    await isolated.runtime.pool.query(
      `insert into profile_handles (handle, account_id) values ($1, $2)`,
      [`handle-${id}`, id],
    );
  }

  async function seedMapping(authUserId: string, accountId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into auth_user_account_map (auth_user_id, account_id) values ($1, $2)`,
      [authUserId, accountId],
    );
  }

  async function seedIdentity(id: string, accountId: string, subject: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into account_identities (id, account_id, issuer, subject) values ($1, $2, $3, $4)`,
      [id, accountId, 'https://accounts.example.com', subject],
    );
  }

  async function seedCollection(id: string, ownerSubjectId: string, rootId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
      [id, rootId],
    );
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into collections (id, owner_subject_id, title, kind, root_node_id, resource_revision, content_revision, policy_revision)
         values ($1, $2, $3, 'bookmarks', $4, 'r1', 'c1', 'p1')`,
        [id, ownerSubjectId, `Collection ${id}`, rootId],
      );
      await client.query(
        `insert into nodes (id, collection_id, kind, is_root, title, resource_revision, children_revision)
         values ($1, $2, 'folder', true, 'Root', 'r1', 'c1')`,
        [rootId, id],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedCollectionPayload(id: string, ownerSubjectId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `update collections
          set payload_json = jsonb_build_object(
                'ownerSubjectId', $2::text,
                'extensions', '{}'::jsonb
              ),
              payload_schema_version = 1,
              payload_authority_status = 'backfilled'
        where id = $1`,
      [id, ownerSubjectId],
    );
  }

  async function collectionPayloadOwner(id: string): Promise<string | null> {
    const result = await isolated.runtime.pool.query<{ owner: string | null }>(
      `select payload_json->>'ownerSubjectId' as owner from collections where id = $1`,
      [id],
    );
    assert.equal(result.rows.length, 1, `expected one collection payload ${id}`);
    return result.rows[0]!.owner;
  }

  async function seedDigestSeries(id: string, ownerSubjectId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'digest_series')`,
      [id],
    );
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(
        `insert into digest_series (
           id, owner_subject_id, title, visibility, allow_search_indexing,
           state, resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, $3, 'private', false, 'active', 'r1', 'c1', 'p1', 1)`,
        [id, ownerSubjectId, `Series ${id}`],
      );
      await client.query(
        `insert into digest_members (series_id, subject_id, role) values ($1, $2, 'owner')`,
        [id, ownerSubjectId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function digestOwner(id: string): Promise<string> {
    const result = await isolated.runtime.pool.query<{ owner_subject_id: string }>(
      `select owner_subject_id from digest_series where id = $1`,
      [id],
    );
    assert.equal(result.rows.length, 1, `expected one digest series ${id}`);
    return result.rows[0]!.owner_subject_id;
  }

  async function digestMemberRole(seriesId: string, subjectId: string): Promise<string> {
    const result = await isolated.runtime.pool.query<{ role: string }>(
      `select role from digest_members where series_id = $1 and subject_id = $2`,
      [seriesId, subjectId],
    );
    assert.equal(result.rows.length, 1, `expected one digest member ${seriesId}/${subjectId}`);
    return result.rows[0]!.role;
  }

  async function seedMember(collectionId: string, subjectId: string, role: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into collection_members (collection_id, subject_id, role) values ($1, $2, $3)`,
      [collectionId, subjectId, role],
    );
  }

  async function accountSubject(id: string): Promise<string> {
    const result = await isolated.runtime.pool.query<{ subject_id: string }>(
      `select subject_id from accounts where id = $1`,
      [id],
    );
    assert.equal(result.rows.length, 1, `expected one account ${id}`);
    return result.rows[0]!.subject_id;
  }

  async function collectionOwner(id: string): Promise<string> {
    const result = await isolated.runtime.pool.query<{ owner_subject_id: string }>(
      `select owner_subject_id from collections where id = $1`,
      [id],
    );
    assert.equal(result.rows.length, 1, `expected one collection ${id}`);
    return result.rows[0]!.owner_subject_id;
  }

  async function memberSubject(collectionId: string): Promise<string> {
    const result = await isolated.runtime.pool.query<{ subject_id: string }>(
      `select subject_id from collection_members where collection_id = $1`,
      [collectionId],
    );
    assert.equal(result.rows.length, 1, `expected one member for ${collectionId}`);
    return result.rows[0]!.subject_id;
  }

  async function identitySubject(id: string): Promise<string> {
    const result = await isolated.runtime.pool.query<{ subject: string }>(
      `select subject from account_identities where id = $1`,
      [id],
    );
    assert.equal(result.rows.length, 1, `expected one identity ${id}`);
    return result.rows[0]!.subject;
  }
});
