import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PRE_PAYLOAD_MIGRATION = '202607222500_collection_mutation_projection';
const PRE_PUBLICATION_MIGRATION = '202607222900_publisher_receipt_retention';
const PUBLICATION_MIGRATION = '202607240100_publication_locators';

describeWithPostgres('publication settings PostgreSQL migration evidence', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('publication_settings_migration');
    runtime = isolated.runtime;
  });

  afterAll(async () => isolated?.close());

  test('migrates legacy public, unlisted, and private facts without eagerly validating checks', async () => {
    const migrator = createMigrator(runtime.db, undefined, isolated.schema);
    const beforePayload = await migrator.migrateTo(PRE_PAYLOAD_MIGRATION);
    if (beforePayload.error) throw beforePayload.error;

    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(`insert into resource_id_ledger (resource_id, resource_type) values
        ('legacy-public', 'collection'), ('root-public', 'node'),
        ('legacy-unlisted', 'collection'), ('root-unlisted', 'node'),
        ('legacy-private', 'collection'), ('root-private', 'node')`);
      await client.query(`insert into collections
        (id, owner_subject_id, title, kind, visibility, root_node_id,
         resource_revision, content_revision, policy_revision, updated_at)
        values
        ('legacy-public', 'owner', 'Public', 'bookmarks', 'public', 'root-public', 'r1', 'c1', 'p1', '2026-07-20T01:00:00Z'),
        ('legacy-unlisted', 'owner', 'Unlisted', 'bookmarks', 'unlisted', 'root-unlisted', 'r1', 'c1', 'p1', '2026-07-20T02:00:00Z'),
        ('legacy-private', 'owner', 'Private', 'bookmarks', 'private', 'root-private', 'r1', 'c1', 'p1', '2026-07-20T03:00:00Z')`);
      await client.query(`insert into nodes
        (id, collection_id, kind, is_root, title, resource_revision, children_revision)
        values
        ('root-public', 'legacy-public', 'folder', true, 'Root', 'r1', 'ch1'),
        ('root-unlisted', 'legacy-unlisted', 'folder', true, 'Root', 'r1', 'ch1'),
        ('root-private', 'legacy-private', 'folder', true, 'Root', 'r1', 'ch1')`);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    const beforePublication = await migrator.migrateTo(PRE_PUBLICATION_MIGRATION);
    if (beforePublication.error) throw beforePublication.error;
    const publication = await migrator.migrateTo(PUBLICATION_MIGRATION);
    if (publication.error) throw publication.error;

    const migrated = await runtime.pool.query(`select id, visibility, publication_slug,
      published_at from collections order by id`);
    const byId = Object.fromEntries(migrated.rows.map((row) => [row.id, row]));
    assert.equal(byId['legacy-public'].publication_slug, 'legacy-6c65676163792d7075626c6963');
    assert.equal(byId['legacy-public'].published_at.toISOString(), '2026-07-20T01:00:00.000Z');
    assert.equal(byId['legacy-unlisted'].publication_slug, 'legacy-6c65676163792d756e6c6973746564');
    assert.equal(byId['legacy-unlisted'].published_at.toISOString(), '2026-07-20T02:00:00.000Z');
    assert.equal(byId['legacy-private'].publication_slug, null);
    assert.equal(byId['legacy-private'].published_at, null);

    const constraints = await runtime.pool.query(`select conname, convalidated
      from pg_constraint
      where conname in ('collections_publication_slug_canonical',
        'collections_published_locator_required')
        and conrelid = 'collections'::regclass
      order by conname`);
    assert.deepEqual(constraints.rows, [
      { conname: 'collections_publication_slug_canonical', convalidated: false },
      { conname: 'collections_published_locator_required', convalidated: false },
    ]);

    await assert.rejects(
      runtime.pool.query(`update collections set publication_slug = 'Not-Canonical'
        where id = 'legacy-private'`),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'collections_publication_slug_canonical',
    );
    await assert.rejects(
      runtime.pool.query(`update collections set publication_slug = $1
        where id = 'legacy-private'`, [byId['legacy-public'].publication_slug]),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'collections_publication_slug_unique',
    );
  });
});
