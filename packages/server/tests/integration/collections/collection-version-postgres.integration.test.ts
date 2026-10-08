import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresCollectionVersionUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  COLLECTION_TREE_VERSION_FIFO_LIMIT,
  createCollectionVersion,
  strongEntityTag,
  type CollectionTreeSnapshotNode,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-08-24T08:00:00.000Z');
const OWNER = 'hv-owner-subject';
const PRINCIPAL = 'hv-owner-account';
const COL = 'hv-col-a';
const ROOT = 'hv-root-a';
const UNSORTED = 'hv-unsorted';
const BM_LATE = 'hv-bm-late';
const BM_EARLY = 'hv-bm-early';

describeWithPostgres('HV-01 PostgreSQL collection tree versions', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('hv01_collection_versions', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  async function resetLibrary(input: { readonly empty?: boolean } = {}): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, collection_tree_versions, collection_organize_plans,
          collection_invites, collection_members, nodes, collections, resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $2, 'active', 0)`,
        [PRINCIPAL, OWNER],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'History owner', null)`,
        [PRINCIPAL],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'),
         ($2, 'node'), ($3, 'node'), ($4, 'node'), ($5, 'node')`,
        [COL, ROOT, UNSORTED, BM_LATE, BM_EARLY],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal, deleted_at
         ) values
         ($1, $2, 'History library', null, 'bookmarks', 'private', $3, 'a-r1', 'a-c1', 'a-p1', 1, null)`,
        [COL, OWNER, ROOT],
      );
      if (input.empty === true) {
        await client.query(
          `insert into nodes (
             id, collection_id, parent_id, kind, is_root, title, url, description, tags,
             visibility, position_token, resource_revision, children_revision, created_at, deleted_at
           ) values
           ($1, $2, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit', null, 'r-r1', 'r-cr1', $3, null)`,
          [ROOT, COL, NOW],
        );
      } else {
        await client.query(
          `insert into nodes (
             id, collection_id, parent_id, kind, is_root, title, url, description, tags,
             visibility, position_token, resource_revision, children_revision, created_at, deleted_at
           ) values
           ($1, $5, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit', null, 'r-r1', 'r-cr1', $6, null),
           ($2, $5, $1, 'folder', false, 'Unsorted', null, null, '[]'::jsonb, 'inherit', 'm', 'u-r1', 'u-cr1', $6, null),
           ($3, $5, $2, 'bookmark', false, 'Late', 'https://example.test/late', null, '[]'::jsonb,
            'inherit', 'z', 'bl-r1', 'bl-cr1', $6, null),
           ($4, $5, $2, 'bookmark', false, 'Early', 'https://example.test/early', null, '[]'::jsonb,
            'inherit', 'a', 'be-r1', 'be-cr1', $6, null)`,
          [ROOT, UNSORTED, BM_LATE, BM_EARLY, COL, NOW],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function create(ifMatch = strongEntityTag('a-c1'), now = NOW) {
    const unit = createPostgresCollectionVersionUnitOfWork(isolated.runtime.db);
    return unit.execute((ports) => createCollectionVersion({
      ...ports,
      clock: { now: () => now },
    }, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: randomUUID(),
      collectionId: COL,
      ifMatch,
    }));
  }

  test('create inserts one row; same revision second create is 200 and unique', async () => {
    await resetLibrary();
    const first = await create();
    assert.equal(first.kind, 'succeeded');
    if (first.kind !== 'succeeded') return;
    assert.equal(first.status, 201);
    assert.equal(first.version.nodeCount, 3);
    const second = await create();
    assert.equal(second.kind, 'succeeded');
    if (second.kind !== 'succeeded') return;
    assert.equal(second.status, 200);
    assert.equal(second.version.versionId, first.version.versionId);
    const count = await isolated.runtime.pool.query(
      'select count(*)::int as n from collection_tree_versions where collection_id = $1',
      [COL],
    );
    assert.equal(count.rows[0]?.n, 1);
  });

  test('empty tree create is 201 nodeCount 0', async () => {
    await resetLibrary({ empty: true });
    const created = await create();
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;
    assert.equal(created.status, 201);
    assert.equal(created.version.nodeCount, 0);
  });

  test('childIds follow editor C-collation position tokens, not insert order', async () => {
    await resetLibrary();
    const created = await create();
    assert.equal(created.kind, 'succeeded');
    const loaded = await isolated.runtime.pool.query(
      'select tree_json from collection_tree_versions where collection_id = $1',
      [COL],
    );
    const tree = loaded.rows[0]?.tree_json as CollectionTreeSnapshotNode[];
    const unsorted = tree.find((node) => node.id === UNSORTED);
    assert.deepEqual(unsorted?.childIds, [BM_EARLY, BM_LATE]);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query(`update nodes set position_token = 'tmp' where id = $1`, [BM_LATE]);
      await client.query(`update nodes set position_token = 'z' where id = $1`, [BM_EARLY]);
      await client.query(`update nodes set position_token = 'a' where id = $1`, [BM_LATE]);
      await client.query(`update collections set content_revision = 'a-c2' where id = $1`, [COL]);
    } finally {
      client.release();
    }
    const swapped = await create(strongEntityTag('a-c2'), new Date(NOW.getTime() + 11_000));
    assert.equal(swapped.kind, 'succeeded');
    const after = await isolated.runtime.pool.query(
      'select tree_json from collection_tree_versions where content_revision = $1',
      ['a-c2'],
    );
    const next = (after.rows[0]?.tree_json as CollectionTreeSnapshotNode[])
      .find((node) => node.id === UNSORTED);
    assert.deepEqual(next?.childIds, [BM_LATE, BM_EARLY]);
  });

  test('FIFO 50 deletes the oldest row before inserting the 51st', async () => {
    await resetLibrary({ empty: true });
    const client = await isolated.runtime.pool.connect();
    try {
      for (let index = 0; index < COLLECTION_TREE_VERSION_FIFO_LIMIT; index += 1) {
        await client.query(
          `insert into collection_tree_versions (
             version_id, account_id, collection_id, content_revision, kind, label, etag,
             node_count, tree_json, created_at
           ) values ($1, $2, $3, $4, 'manual', $5, $6, 0, '[]'::jsonb, $7)`,
          [
            `ver-${String(index).padStart(2, '0')}`,
            PRINCIPAL,
            COL,
            `rev-${index}`,
            `v${index}`,
            `"ver-${index}"`,
            new Date(NOW.getTime() + index * 1000),
          ],
        );
      }
      await client.query(`update collections set content_revision = 'rev-51' where id = $1`, [COL]);
    } finally {
      client.release();
    }
    const created = await create(strongEntityTag('rev-51'), new Date(NOW.getTime() + 60_000));
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;
    assert.equal(created.status, 201);
    const rows = await isolated.runtime.pool.query(
      'select version_id from collection_tree_versions where collection_id = $1 order by created_at asc',
      [COL],
    );
    assert.equal(rows.rowCount, 50);
    assert.equal(rows.rows.some((row: { version_id: string }) => row.version_id === 'ver-00'), false);
    assert.equal(rows.rows.some((row: { version_id: string }) => row.version_id === created.version.versionId), true);
  });
});
