import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicationSnapshotReadPort } from '../../../src/infrastructure/publication/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL Publication scoped Snapshot reads', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('publication_scoped_snapshot');
    await runMigrations(isolated.runtime.db, 'latest');
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type)
       values ('scope-collection', 'collection'), ('scope-root', 'node'),
              ('scope-private', 'node'), ('scope-subtree', 'node'), ('scope-child', 'node')`,
    );
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into collections
         (id, owner_subject_id, title, kind, root_node_id, visibility, publication_slug, published_at,
          resource_revision, content_revision, policy_revision)
       values ('scope-collection', 'scope-owner', 'Scoped', 'bookmarks', 'scope-root', 'public',
               'scoped', now(), 'r1', 'c1', 'p1')`,
      );
      await client.query(
        `insert into nodes
         (id, collection_id, parent_id, kind, is_root, title, url, visibility, position_token,
          resource_revision, children_revision)
       values
         ('scope-root', 'scope-collection', null, 'folder', true, 'Root', null, 'inherit', null, 'r1', 'ch1'),
         ('scope-private', 'scope-collection', 'scope-root', 'folder', false, 'Private', null, 'private', 'A', 'r1', 'ch1'),
         ('scope-subtree', 'scope-collection', 'scope-private', 'folder', false, 'Subtree', null, 'inherit', 'A', 'r1', 'ch1'),
         ('scope-child', 'scope-collection', 'scope-subtree', 'bookmark', false, 'Child',
          'https://example.test/child', 'inherit', 'A', 'r1', 'ch1')`,
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('inherits restrictions above the requested scope root in real SQL execution', async () => {
    const page = await createPostgresPublicationSnapshotReadPort(isolated.runtime).loadPage({
      collectionId: 'scope-collection', rootId: 'scope-subtree', depth: 1, limit: 10,
    });
    assert.equal(page.root?.ancestorRestricted, true);
    assert.deepEqual(page.candidates.map((candidate) => ({
      id: candidate.id,
      ancestorRestricted: candidate.ancestorRestricted,
    })), [{ id: 'scope-child', ancestorRestricted: true }]);
  });
  test('public continuation ordinals exclude hidden siblings in both scoped and whole-collection reads', async () => {
    await isolated.runtime.pool.query(`insert into resource_id_ledger (resource_id, resource_type)
      values ('visible-a', 'node'), ('visible-b', 'node')`);
    await isolated.runtime.pool.query(`insert into nodes
      (id, collection_id, parent_id, kind, is_root, title, url, visibility, position_token,
       resource_revision, children_revision)
      values ('visible-a', 'scope-collection', 'scope-root', 'bookmark', false, 'A',
        'https://example.test/a', 'inherit', 'B', 'r1', 'ch1'),
      ('visible-b', 'scope-collection', 'scope-root', 'bookmark', false, 'B',
        'https://example.test/b', 'inherit', 'C', 'r1', 'ch1')`);
    const reads = createPostgresPublicationSnapshotReadPort(isolated.runtime);
    for (const scope of [{}, { rootId: 'scope-root', depth: 1 }]) {
      const first = await reads.loadPage({ collectionId: 'scope-collection', limit: 1,
        projection: 'public', ...scope });
      assert.equal(first.candidates[0]?.id, 'visible-a');
      assert.equal(first.candidates[0]?.publicationPosition, '00000000000000000000');
      const next = await reads.loadPage({ collectionId: 'scope-collection', limit: 1,
        projection: 'public', ...scope,
        after: { parentId: 'scope-root', position: 'B', nodeId: 'visible-a' } });
      assert.equal(next.candidates[0]?.id, 'visible-b');
      assert.equal(next.candidates[0]?.publicationPosition, '00000000000000000001');
    }
  });

});
