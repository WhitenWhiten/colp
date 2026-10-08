import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresProfileSitemapReadPort } from '../../../src/infrastructure/publication/index.js';
import { composeProfileSitemapQuery } from '../../../src/bootstrap/public-profile-projection.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('M-10 profiles sitemap PostgreSQL indexability', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('profiles_sitemap');
    await runMigrations(isolated.runtime.db, 'latest');
    await seed(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('only active public profiles with a published public collection and usable root are listed', async () => {
    const read = composeProfileSitemapQuery({
      candidates: createPostgresProfileSitemapReadPort(isolated.runtime),
    });
    const rows = await read.listIndexable();
    assert.deepEqual(rows, [
      { canonicalHandle: 'ada_curator', updatedAt: '2026-08-30T12:00:00.000Z' },
      { canonicalHandle: 'bea_curator', updatedAt: '2026-08-29T12:00:00.000Z' },
    ], 'seed_only (newest, public, but seed-registered) must not be listed');
  });
});

async function seed(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    const profiles = [
      ['01PROFILEMAP00000001A', 'owner-ada', 'active', 'ada_curator'],
      ['01PROFILEMAP00000002A', 'owner-bea', 'active', 'bea_curator'],
      ['01PROFILEMAP00000003A', 'owner-unlisted', 'active', 'unlisted_only'],
      ['01PROFILEMAP00000004A', 'owner-private', 'active', 'private_only'],
      ['01PROFILEMAP00000005A', 'owner-withdrawn', 'active', 'withdrawn_only'],
      ['01PROFILEMAP00000006A', 'owner-inactive', 'disabled', 'inactive_owner'],
      ['01PROFILEMAP00000007A', 'owner-no-root', 'active', 'missing_root'],
      ['01PROFILEMAP00000008A', 'owner-deleted-root', 'active', 'deleted_root'],
      ['01PROFILEMAP00000009A', 'owner-seed', 'active', 'seed_only'],
    ] as const;
    for (const [accountId, subjectId, status, handle] of profiles) {
      await client.query('insert into accounts(id, subject_id, status) values ($1, $2, $3)', [accountId, subjectId, status]);
      await client.query('insert into profiles(account_id, display_name) values ($1, $2)', [accountId, handle]);
      await client.query('insert into profile_handles(handle, account_id) values ($1, $2)', [handle, accountId]);
    }

    const collections = [
      ['ps-ada-old', 'owner-ada', 'public', 'ps-ada-old', '2026-08-28T12:00:00Z', null],
      ['ps-ada-new', 'owner-ada', 'public', 'ps-ada-new', '2026-08-30T12:00:00Z', null],
      ['ps-bea', 'owner-bea', 'public', 'ps-bea', '2026-08-29T12:00:00Z', null],
      ['ps-unlisted', 'owner-unlisted', 'unlisted', 'ps-unlisted', '2026-08-31T12:00:00Z', null],
      ['ps-private', 'owner-private', 'private', null, '2026-08-31T12:00:00Z', null],
      ['ps-withdrawn', 'owner-withdrawn', 'public', 'ps-withdrawn', '2026-08-31T12:00:00Z', '2026-08-31T13:00:00Z'],
      ['ps-inactive', 'owner-inactive', 'public', 'ps-inactive', '2026-08-31T12:00:00Z', null],
      ['ps-deleted-root', 'owner-deleted-root', 'public', 'ps-deleted-root', '2026-08-31T12:00:00Z', '2026-08-31T13:00:00Z'],
      // Public and healthy, but registered in seed_rows: demo fixtures never make a Profile indexable.
      ['col-u99-seed', 'owner-seed', 'public', 'ps-seed-only', '2026-09-01T12:00:00Z', null],
    ] as const;
    for (const [id, owner, visibility, slug, updatedAt, deletedAt] of collections) {
      const root = `${id}-root`;
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [id, root],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, updated_at, deleted_at)
         values ($1, $2, $1, 'bookmarks', $3, $4, 'r1', 'c1', 'p1', $5,
                 case when $5::text is null then null else '2026-08-01T00:00:00Z'::timestamptz end,
                 $6, $7)`,
        [id, owner, visibility, root, slug, updatedAt, deletedAt],
      );
      await client.query(
        `insert into nodes
          (id, collection_id, kind, is_root, title, visibility, resource_revision, children_revision, deleted_at)
         values ($1, $2, 'folder', true, $2, 'inherit', 'r1', 'ch1', $3)`,
        [root, id, id === 'ps-deleted-root' || id === 'ps-withdrawn' ? '2026-08-31T13:00:00Z' : null],
      );
    }
    await client.query(
      `insert into seed_rows(seed_key, version, table_name, pk)
       values ('demo', 'integration-fixture', 'collections', jsonb_build_array('col-u99-seed'))`,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
