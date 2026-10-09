import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import {
  buildPublicationDirectoryStatement,
  createPostgresPublicationDirectoryReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createCollectionNode,
  deleteCollectionNode,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const OWNER = 'live-count-owner';
const COLLECTION_A = 'live-count-a';
const COLLECTION_B = 'live-count-b';
const ROOT_A = 'live-count-a-root';
const ROOT_B = 'live-count-b-root';
const CHILD = 'live-count-child';
const DELETED_INSERT = 'live-count-already-deleted';
const CANONICAL_OWNER = Buffer.alloc(16, 11).toString('base64url');
const CANONICAL_COLLECTION = Buffer.alloc(16, 12).toString('base64url');
const CANONICAL_ROOT = Buffer.alloc(16, 13).toString('base64url');
const CANONICAL_CREATED = Buffer.alloc(16, 14).toString('base64url');
const CANONICAL_CREATE_COMMAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CANONICAL_DELETE_COMMAND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describeWithPostgres('collections live_node_count trigger (P-04)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('collections_live_node_count', {
      maxConnections: 4,
      applicationName: 'known-live-node-count',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCollections(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('insert live node increments; soft-delete decrements; move updates both collections', async () => {
    assert.equal(await liveCount(isolated, COLLECTION_A), 1);
    assert.equal(await liveCount(isolated, COLLECTION_B), 1);
    assert.equal(await directoryNodeCount(isolated, COLLECTION_A), 1);

    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
      [CHILD],
    );
    await isolated.runtime.pool.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, position_token,
         resource_revision, children_revision)
       values ($1, $2, $3, 'folder', false, 'Child', 'A001', 'r1', 'ch1')`,
      [CHILD, COLLECTION_A, ROOT_A],
    );
    assert.equal(await liveCount(isolated, COLLECTION_A), 2);
    assert.equal(await directoryNodeCount(isolated, COLLECTION_A), 2);

    await isolated.runtime.pool.query(
      `update nodes set deleted_at = $2, deleted_commit_ordinal = 1 where id = $1`,
      [CHILD, '2026-08-19T00:00:00Z'],
    );
    assert.equal(await liveCount(isolated, COLLECTION_A), 1);
    assert.equal(await directoryNodeCount(isolated, COLLECTION_A), 1);

    await isolated.runtime.pool.query(
      `update nodes set deleted_at = null, deleted_commit_ordinal = null where id = $1`,
      [CHILD],
    );
    assert.equal(await liveCount(isolated, COLLECTION_A), 2);

    await isolated.runtime.pool.query(
      `update nodes set collection_id = $2, parent_id = $3 where id = $1`,
      [CHILD, COLLECTION_B, ROOT_B],
    );
    assert.equal(await liveCount(isolated, COLLECTION_A), 1);
    assert.equal(await liveCount(isolated, COLLECTION_B), 2);
    assert.equal(await directoryNodeCount(isolated, COLLECTION_B), 2);

    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
      [DELETED_INSERT],
    );
    await isolated.runtime.pool.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, position_token,
         resource_revision, children_revision, deleted_at, deleted_commit_ordinal)
       values ($1, $2, $3, 'folder', false, 'Gone', 'A002', 'r1', 'ch1', $4, 1)`,
      [DELETED_INSERT, COLLECTION_A, ROOT_A, '2026-08-19T00:00:00Z'],
    );
    assert.equal(await liveCount(isolated, COLLECTION_A), 1);
  });

  test('directory SQL counts only live publicly visible nodes', () => {
    const statement = buildPublicationDirectoryStatement({
      principal: 'anonymous', filter: {}, limit: 10,
    });
    assert.match(statement.text, /select count\(\*\)::int/u);
    assert.match(statement.text, /n\.visibility = 'inherit'/u);
    assert.match(statement.text, /target_ancestors/u);
    assert.match(statement.text, /n\.deleted_at is null/u);
    assert.doesNotMatch(statement.text, /GREATEST\s*\(/u);
  });

  test('canonical create then soft-delete updates live_node_count and directory', async () => {
    await seedCanonicalCollection(isolated);
    assert.equal(await liveCount(isolated, CANONICAL_COLLECTION), 1);
    assert.equal(await directoryNodeCount(isolated, CANONICAL_COLLECTION, 'live-count-canonical'), 1);

    const unitOfWork = createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db);
    const actor = {
      principalId: CANONICAL_OWNER,
      principalType: 'account' as const,
      subjectId: CANONICAL_OWNER,
    };
    const created = await unitOfWork.execute((ports) => createCollectionNode(ports, {
      actor,
      command: { commandId: CANONICAL_CREATE_COMMAND, fingerprint: 'fp-live-count-create' },
      operationId: Buffer.alloc(16, 15).toString('base64url'),
      collectionId: CANONICAL_COLLECTION,
      parentId: CANONICAL_ROOT,
      afterId: null,
      beforeId: null,
      nodeId: CANONICAL_CREATED,
      node: {
        kind: 'bookmark',
        title: 'Canonical live count',
        url: 'https://example.test/live-count',
        description: null,
        tags: [],
        visibility: 'inherit',
      },
    }));
    assert.equal(created.kind, 'created');
    if (created.kind !== 'created') throw new Error('createCollectionNode must create');
    assert.equal(await liveCount(isolated, CANONICAL_COLLECTION), 2);
    assert.equal(await directoryNodeCount(isolated, CANONICAL_COLLECTION, 'live-count-canonical'), 2);

    const deleted = await unitOfWork.execute((ports) => deleteCollectionNode(ports, {
      actor,
      command: { commandId: CANONICAL_DELETE_COMMAND, fingerprint: 'fp-live-count-delete' },
      collectionId: CANONICAL_COLLECTION,
      nodeId: CANONICAL_CREATED,
      ifMatch: created.node.etag,
      recursive: false,
      operationId: Buffer.alloc(16, 16).toString('base64url'),
    }));
    assert.equal(deleted.kind, 'deleted');
    assert.equal(await liveCount(isolated, CANONICAL_COLLECTION), 1);
    assert.equal(await directoryNodeCount(isolated, CANONICAL_COLLECTION, 'live-count-canonical'), 1);
  });
});

async function liveCount(isolated: IsolatedPostgresRuntime, id: string): Promise<number> {
  const result = await isolated.runtime.pool.query<{ live_node_count: number }>(
    `select live_node_count from collections where id = $1`,
    [id],
  );
  return result.rows[0]!.live_node_count;
}

async function directoryNodeCount(
  isolated: IsolatedPostgresRuntime,
  id: string,
  search = id,
): Promise<number> {
  const rows = await createPostgresPublicationDirectoryReadPort(isolated.runtime).loadPage({
    principal: 'anonymous',
    filter: { q: search },
    limit: 10,
  });
  const match = rows.find((row) => row.id === id);
  assert.ok(match, `directory row ${id} must be visible`);
  return match.nodeCount;
}

async function seedCollections(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    for (const [id, rootId, updatedAt] of [
      [COLLECTION_A, ROOT_A, '2026-08-19T00:00:02Z'],
      [COLLECTION_B, ROOT_B, '2026-08-19T00:00:01Z'],
    ] as const) {
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [id, rootId],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, updated_at)
         values ($1, $2, $1, 'bookmarks', 'public', $3, 'r1', 'c1', 'p1', $1, $4::timestamptz, $4::timestamptz)`,
        [id, OWNER, rootId, updatedAt],
      );
      await client.query(
        `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
         values ($1, $2, 'folder', true, $2, 'r1', 'ch1')`,
        [rootId, id],
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

async function seedCanonicalCollection(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into accounts(id, subject_id, status) values ($1, $1, 'active')`,
      [CANONICAL_OWNER],
    );
    await client.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'Live count canonical owner', null)`,
      [CANONICAL_OWNER],
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
      [CANONICAL_COLLECTION, CANONICAL_ROOT],
    );
    await client.query(
      `insert into collections
         (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
          content_revision, policy_revision, commit_ordinal, publication_slug, published_at, updated_at)
       values ($1, $2, 'live-count-canonical', 'bookmarks', 'public', $3, 'r1', 'c1', 'p1', 1,
               'live-count-canonical', $4::timestamptz, $4::timestamptz)`,
      [CANONICAL_COLLECTION, CANONICAL_OWNER, CANONICAL_ROOT, '2026-08-19T00:00:03Z'],
    );
    await client.query(
      `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
       values ($1, $2, 'folder', true, $2, 'r1', 'ch1')`,
      [CANONICAL_ROOT, CANONICAL_COLLECTION],
    );
    await client.query(
      `insert into collection_members(collection_id, subject_id, role) values ($1, $2, 'owner')`,
      [CANONICAL_COLLECTION, CANONICAL_OWNER],
    );
    const collection = (await client.query(
      'select * from collections where id = $1',
      [CANONICAL_COLLECTION],
    )).rows[0]!;
    const collectionPayload = materializeCollectionPayload({
      id: collection.id,
      ownerSubjectId: collection.owner_subject_id,
      title: collection.title,
      summary: collection.summary,
      kind: collection.kind,
      visibility: collection.visibility,
      rootNodeId: collection.root_node_id,
      resourceRevision: collection.resource_revision,
      contentRevision: collection.content_revision,
      policyRevision: collection.policy_revision,
      commitOrdinal: collection.commit_ordinal,
      createdAt: collection.created_at,
      updatedAt: collection.updated_at,
      deletedAt: collection.deleted_at,
    });
    if (!collectionPayload.ok) throw new Error(collectionPayload.reason);
    await client.query(
      `update collections
         set payload_json = $2::jsonb, payload_schema_version = 1,
             payload_authority_status = 'backfilled'
       where id = $1`,
      [CANONICAL_COLLECTION, JSON.stringify(collectionPayload.payload)],
    );
    const root = (await client.query(
      'select * from nodes where id = $1',
      [CANONICAL_ROOT],
    )).rows[0]!;
    const rootPayload = materializeNodePayload({
      id: root.id,
      collectionId: root.collection_id,
      parentId: root.parent_id,
      kind: root.kind,
      isRoot: root.is_root,
      title: root.title,
      url: root.url,
      description: root.description,
      tags: root.tags,
      visibility: root.visibility,
      positionToken: root.position_token,
      resourceRevision: root.resource_revision,
      childrenRevision: root.children_revision,
      createdAt: root.created_at,
      updatedAt: root.updated_at,
      deletedAt: root.deleted_at,
      deletedCommitOrdinal: root.deleted_commit_ordinal,
    });
    if (!rootPayload.ok) throw new Error(rootPayload.reason);
    await client.query(
      `update nodes
         set payload_json = $2::jsonb, payload_schema_version = 1,
             payload_authority_status = 'backfilled'
       where id = $1`,
      [CANONICAL_ROOT, JSON.stringify(rootPayload.payload)],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
