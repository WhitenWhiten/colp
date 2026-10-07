import { afterAll, beforeAll } from 'vitest';
import {
  createPostgresBookmarkIconWritePort,
} from '../../../src/infrastructure/collections/index.js';
import {
  createUnitOfWork,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import type { BookmarkIconWritePort } from '../../../src/modules/collections/index.js';
import {
  BOOKMARK_ICON_CONTRACT_FIXTURE,
  defineBookmarkIconWritePortContract,
} from '../../contracts/bookmark-icon-write-port.contract.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL bookmark icon write adapter', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('bookmark_icon_contract', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  async function resetFixtures(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    const { collectionA, collectionB, nodeA, nodeB, nodeC } = BOOKMARK_ICON_CONTRACT_FIXTURE;
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client,
        `truncate table bookmark_icons, nodes, collections, resource_id_ledger, accounts cascade`);
      await client.query(
        `insert into accounts(id, subject_id) values ('IiIiIiIiIiIiIiIiIiIiIg', 'contract-icon-owner')`,
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
          ($1, 'collection'), ($2, 'collection'),
          ($3, 'node'), ($4, 'node'), ($5, 'node'), ($6, 'node'), ($7, 'node')`,
        [collectionA, collectionB, `${collectionA}-root`, `${collectionB}-root`, nodeA, nodeB, nodeC],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision)
         values
          ($1, 'contract-icon-owner', 'Contract A', 'bookmarks', 'private', $2, 'ra', 'ca', 'pa'),
          ($3, 'contract-icon-owner', 'Contract B', 'bookmarks', 'private', $4, 'rb', 'cb', 'pb')`,
        [collectionA, `${collectionA}-root`, collectionB, `${collectionB}-root`],
      );
      await client.query(
        `insert into nodes
          (id, collection_id, parent_id, kind, is_root, title, url, visibility,
           position_token, resource_revision, children_revision)
         values
          ($1, $2, null, 'folder', true, 'Root A', null, 'inherit', null, 'r1', 'c1'),
          ($3, $4, null, 'folder', true, 'Root B', null, 'inherit', null, 'r2', 'c2'),
          ($5, $2, $1, 'bookmark', false, 'A', 'https://example.test/a', 'inherit', 'a', 'r3', 'c3'),
          ($6, $2, $1, 'bookmark', false, 'B', 'https://example.test/b', 'inherit', 'b', 'r4', 'c4'),
          ($7, $4, $3, 'bookmark', false, 'C', 'https://example.test/c', 'inherit', 'c', 'r5', 'c5')`,
        [`${collectionA}-root`, collectionA, `${collectionB}-root`, collectionB, nodeA, nodeB, nodeC],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  function createPort(): BookmarkIconWritePort {
    return {
      findByNodeId: (nodeId) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresBookmarkIconWritePort(transaction).findByNodeId(nodeId)),
      findObjectIdsByNodeIds: (nodeIds) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresBookmarkIconWritePort(transaction)
          .findObjectIdsByNodeIds(nodeIds)),
      upsert: (row) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresBookmarkIconWritePort(transaction).upsert(row)),
      deleteByNodeId: (nodeId) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresBookmarkIconWritePort(transaction).deleteByNodeId(nodeId)),
      deleteByNodeIds: (nodeIds) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresBookmarkIconWritePort(transaction).deleteByNodeIds(nodeIds)),
      deleteByCollectionId: (collectionId) => createUnitOfWork(isolated.runtime.db)
        .execute(({ transaction }) => createPostgresBookmarkIconWritePort(transaction)
          .deleteByCollectionId(collectionId)),
    };
  }

  defineBookmarkIconWritePortContract({
    name: 'shared bookmark icon behavior',
    createPort,
    reset: resetFixtures,
  });
});
