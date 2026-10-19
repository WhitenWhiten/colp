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
      // A second collection isolates cycle / soft-deleted-ancestor / normal-parent fixtures
      // from the public sibling-ordinal assertions above.
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type)
         values ('ancestor-collection', 'collection'), ('ancestor-root', 'node'),
                ('cycle-a', 'node'), ('cycle-b', 'node'),
                ('deleted-parent', 'node'), ('deleted-child', 'node'), ('normal-bookmark', 'node')`,
      );
      await client.query(
        `insert into collections
         (id, owner_subject_id, title, kind, root_node_id, visibility, publication_slug, published_at,
          resource_revision, content_revision, policy_revision)
       values ('ancestor-collection', 'scope-owner', 'Ancestors', 'bookmarks', 'ancestor-root', 'public',
               'ancestors', now(), 'r1', 'c1', 'p1')`,
      );
      await client.query(
        `insert into nodes
         (id, collection_id, parent_id, kind, is_root, title, url, visibility, position_token,
          resource_revision, children_revision)
       values
         ('ancestor-root', 'ancestor-collection', null, 'folder', true, 'Root', null, 'inherit', null, 'r1', 'ch1'),
         ('cycle-a', 'ancestor-collection', 'ancestor-root', 'folder', false, 'Cycle A', null, 'inherit', 'A', 'r1', 'ch1'),
         ('cycle-b', 'ancestor-collection', 'cycle-a', 'folder', false, 'Cycle B', null, 'inherit', 'A', 'r1', 'ch1'),
         ('deleted-parent', 'ancestor-collection', 'ancestor-root', 'folder', false, 'Deleted parent', null, 'inherit', 'B', 'r1', 'ch1'),
         ('normal-bookmark', 'ancestor-collection', 'ancestor-root', 'bookmark', false, 'Normal',
          'https://example.test/normal', 'inherit', 'C', 'r1', 'ch1')`,
      );
      // Both states are rejected by the live-tree trigger; simulate stale/legacy rows
      // to prove readers still fail closed on them.
      await client.query(`update nodes set parent_id = 'cycle-b' where id = 'cycle-a'`);
      await client.query(`set local session_replication_role = 'replica'`);
      // Insert the live child only after triggers are disabled so no deferred
      // parent-integrity event is queued for this deliberately stale fixture.
      await client.query(
        `insert into nodes
         (id, collection_id, parent_id, kind, is_root, title, url, visibility, position_token,
          resource_revision, children_revision)
         values ('deleted-child', 'ancestor-collection', 'deleted-parent', 'bookmark', false, 'Deleted child',
                 'https://example.test/deleted-child', 'inherit', 'A', 'r1', 'ch1')`,
      );
      await client.query(`update nodes set deleted_at = now() where id = 'deleted-parent'`);
      // Keep replica mode through COMMIT: the deferred live-tree trigger must not
      // revalidate the deliberately stale fixture row when the transaction ends.
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
  test('public reads hide cycles and soft-deleted ancestors while member reads report them', async () => {
    const reads = createPostgresPublicationSnapshotReadPort(isolated.runtime);
    const publicPage = await reads.loadPage({
      collectionId: 'ancestor-collection', limit: 500, projection: 'public',
    });
    const publicIds = publicPage.candidates.map((candidate) => candidate.id);
    assert.ok(publicIds.includes('normal-bookmark'), 'a normal parent chain stays public');
    assert.equal(publicIds.includes('cycle-a'), false);
    assert.equal(publicIds.includes('cycle-b'), false);
    assert.equal(publicIds.includes('deleted-child'), false);

    const memberPage = await reads.loadPage({ collectionId: 'ancestor-collection', limit: 500 });
    const byId = new Map(memberPage.candidates.map((candidate) => [candidate.id, candidate]));
    assert.equal(byId.get('cycle-a')?.ancestorRestricted, true);
    assert.equal(byId.get('cycle-b')?.ancestorRestricted, true);
    assert.equal(byId.get('deleted-child')?.ancestorRestricted, true);
    assert.equal(byId.get('normal-bookmark')?.ancestorRestricted, false);
  });

  test('scoped public reads hide a private scope root and every descendant', async () => {
    const page = await createPostgresPublicationSnapshotReadPort(isolated.runtime).loadPage({
      collectionId: 'scope-collection', rootId: 'scope-private', depth: 4, limit: 50, projection: 'public',
    });
    assert.equal(page.root?.id, 'scope-private');
    assert.equal(page.root?.ancestorRestricted, true);
    assert.deepEqual(page.candidates, []);
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
