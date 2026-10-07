import { createHistoricalMigrator } from '../../support/historical-migrations.js';
/**
 * BF-03: bookmark_icons migration + soft-delete hook on the shared persistence
 * path (canonical node tombstone used by Product delete and Sync Push).
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresCanonicalMutationPorts,
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresFaviconGcRepository,
  createPostgresNodeWritePort,
} from '../../../src/infrastructure/collections/index.js';
import { createMigrator, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import {
  createCanonicalMutationApplication,
  createCollectionNode,
  deleteCollectionNode,
  materializeCollectionPayload,
  materializeNodePayload,
  moveCollectionNode,
  strongEntityTag,
} from '../../../src/modules/collections/index.js';
import { processFaviconGcClaim } from '../../../src/modules/collections/application/favicon-gc.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const PREVIOUS_HEAD = '202609130100_collection_invite_deliveries_leased_idx';
const ICONS_MIGRATION = '202609140100_bookmark_icons';
const TABLE = 'bookmark_icons';
const OWNER = Buffer.alloc(16, 21).toString('base64url');
const COLLECTION = Buffer.alloc(16, 22).toString('base64url');
const ROOT = Buffer.alloc(16, 23).toString('base64url');
const FOLDER = Buffer.alloc(16, 24).toString('base64url');
const BOOKMARK_A = Buffer.alloc(16, 25).toString('base64url');
const BOOKMARK_B = Buffer.alloc(16, 26).toString('base64url');
const OBJECT_A = '123e4567-e89b-42d3-a456-426614174001';
const OBJECT_B = '123e4567-e89b-42d3-a456-426614174002';
const DIGEST = Buffer.alloc(32, 7);

describeWithPostgres('bookmark_icons schema and soft-delete hook (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('bf03_bookmark_icons');
    const migrator = createMigrator(isolated.runtime.db, 'migrations', isolated.schema);
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('empty database migrateToLatest creates bookmark_icons constraints', async () => {
    assert.equal(await tablePresent(isolated, TABLE), true);
    const columns = await columnLayout(isolated, TABLE);
    assert.deepEqual(columns.map((column) => column.column_name), [
      'node_id',
      'collection_id',
      'object_id',
      'content_type',
      'byte_size',
      'digest_sha256',
      'created_at',
      'updated_at',
    ]);
    const byName = Object.fromEntries(columns.map((column) => [column.column_name, column]));
    assert.equal(byName.node_id?.is_nullable, 'NO');
    assert.equal(byName.object_id?.is_nullable, 'NO');
    assert.equal(byName.digest_sha256?.data_type, 'bytea');
    assert.equal(byName.byte_size?.data_type, 'integer');

    const pk = await isolated.runtime.pool.query<{ attname: string }>(
      `select a.attname
         from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = to_regclass('bookmark_icons')
          and i.indisprimary`,
    );
    assert.deepEqual(pk.rows.map((row) => row.attname), ['node_id']);
  });

  test('down then up from previous head recreates bookmark_icons', async () => {
    const upgrade = await createIsolatedPostgresRuntime('bf03_bookmark_icons_updown');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202609140100_bookmark_icons');
      const previous = await migrator.migrateTo(PREVIOUS_HEAD);
      if (previous.error) throw previous.error;
      assert.equal(await tablePresent(upgrade, TABLE), false);

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const names = await upgrade.runtime.pool.query<{ name: string }>(
        `select name from kysely_migration where name = $1`,
        [ICONS_MIGRATION],
      );
      assert.equal(names.rows[0]?.name, ICONS_MIGRATION);
      assert.equal(await tablePresent(upgrade, TABLE), true);

      const down = await migrator.migrateTo(PREVIOUS_HEAD);
      if (down.error) throw down.error;
      assert.equal(await tablePresent(upgrade, TABLE), false);
      assert.equal(await tablePresent(upgrade, 'nodes'), true);

      const forward = await migrator.migrateToLatest();
      if (forward.error) throw forward.error;
      assert.equal(await tablePresent(upgrade, TABLE), true);
      await migrator.upgradeToCurrentLatest();
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('content_type, byte_size, and digest length checks reject invalid rows', async () => {
    await seedCanonicalCollection(isolated);
    await insertLiveBookmark(isolated, BOOKMARK_A, ROOT, 'A');

    await expectPgError(
      isolated,
      `insert into bookmark_icons (
         node_id, collection_id, object_id, content_type, byte_size, digest_sha256
       ) values ($1, $2, $3, 'image/gif', 16, $4)`,
      [BOOKMARK_A, COLLECTION, OBJECT_A, DIGEST],
      '23514',
    );
    await expectPgError(
      isolated,
      `insert into bookmark_icons (
         node_id, collection_id, object_id, content_type, byte_size, digest_sha256
       ) values ($1, $2, $3, 'image/png', 0, $4)`,
      [BOOKMARK_A, COLLECTION, OBJECT_A, DIGEST],
      '23514',
    );
    await expectPgError(
      isolated,
      `insert into bookmark_icons (
         node_id, collection_id, object_id, content_type, byte_size, digest_sha256
       ) values ($1, $2, $3, 'image/png', 16, $4)`,
      [BOOKMARK_A, COLLECTION, OBJECT_A, Buffer.alloc(31, 1)],
      '23514',
    );
  });

  test('Product single bookmark delete removes the icon row via canonical persistence', async () => {
    await seedCanonicalCollection(isolated);
    const created = await createBookmark(isolated, BOOKMARK_A, ROOT, 'https://example.test/a', 'fp-create-a');
    await insertIcon(isolated, BOOKMARK_A, OBJECT_A);
    assert.equal(await iconCount(isolated, BOOKMARK_A), 1);

    const unitOfWork = createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db);
    const deleted = await unitOfWork.execute((ports) => deleteCollectionNode(ports, {
      actor: { principalId: OWNER, principalType: 'account', subjectId: OWNER },
      command: { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', fingerprint: 'fp-del-single' },
      collectionId: COLLECTION,
      nodeId: BOOKMARK_A,
      ifMatch: created.node.etag,
      recursive: false,
      operationId: Buffer.alloc(16, 31).toString('base64url'),
    }));
    assert.equal(deleted.kind, 'deleted');
    assert.equal(await iconCount(isolated, BOOKMARK_A), 0);
  });

  test('Product recursive folder delete removes descendant bookmark icon rows', async () => {
    await seedCanonicalCollection(isolated);
    const folder = await createFolder(isolated, FOLDER, ROOT, 'fp-create-folder');
    const child = await createBookmark(isolated, BOOKMARK_B, FOLDER, 'https://example.test/b', 'fp-create-b');
    assert.equal(child.kind, 'created');
    await insertIcon(isolated, BOOKMARK_B, OBJECT_B);
    assert.equal(await iconCount(isolated, BOOKMARK_B), 1);

    const collection = await isolated.runtime.pool.query<{ content_revision: string }>(
      `select content_revision from collections where id = $1`,
      [COLLECTION],
    );
    const unitOfWork = createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db);
    const deleted = await unitOfWork.execute((ports) => deleteCollectionNode(ports, {
      actor: { principalId: OWNER, principalType: 'account', subjectId: OWNER },
      command: { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', fingerprint: 'fp-del-rec' },
      collectionId: COLLECTION,
      nodeId: FOLDER,
      ifMatch: folder.node.etag,
      recursive: true,
      ifContentMatch: strongEntityTag(collection.rows[0]!.content_revision),
      operationId: Buffer.alloc(16, 32).toString('base64url'),
    }));
    assert.equal(deleted.kind, 'deleted');
    assert.equal(await iconCount(isolated, BOOKMARK_B), 0);
  });

  test('Product single bookmark delete records the retired icon for GC', async () => {
    await seedCanonicalCollection(isolated);
    const created = await createBookmark(isolated, BOOKMARK_A, ROOT, 'https://example.test/gc-single', 'fp-gc-single');
    await insertIcon(isolated, BOOKMARK_A, OBJECT_A);
    assert.equal(await iconCount(isolated, BOOKMARK_A), 1);

    const unitOfWork = createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db);
    await unitOfWork.execute((ports) => deleteCollectionNode(ports, {
      actor: { principalId: OWNER, principalType: 'account', subjectId: OWNER },
      command: { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11', fingerprint: 'fp-del-gc-single' },
      collectionId: COLLECTION,
      nodeId: BOOKMARK_A,
      ifMatch: created.node.etag,
      recursive: false,
      operationId: Buffer.alloc(16, 41).toString('base64url'),
    }));
    assert.equal(await iconCount(isolated, BOOKMARK_A), 0);

    // FO-07: the binding's object must enter the durable GC ledger with the
    // full retention window instead of leaking.
    const pending = await isolated.runtime.pool.query<{
      object_id: string; node_id: string; collection_id: string; deletable_at: Date;
    }>(`select object_id, node_id, collection_id, deletable_at
        from favicon_pending_deletions where object_id = $1`, [OBJECT_A]);
    assert.equal(pending.rows.length, 1);
    assert.equal(pending.rows[0]!.node_id, BOOKMARK_A);
    assert.equal(pending.rows[0]!.collection_id, COLLECTION);
    assert.ok(
      pending.rows[0]!.deletable_at.getTime() > Date.now() + 300 * 24 * 3600 * 1000,
      `deletable_at is in the far future, was ${pending.rows[0]!.deletable_at.toISOString()}`,
    );

    // Once the window passes the object is claimable and collectable.
    await isolated.runtime.pool.query(
      `update favicon_pending_deletions
          set deletable_at = now() - interval '1 second', next_attempt_at = now() - interval '1 second'
        where object_id = $1`, [OBJECT_A]);
    const gc = createPostgresFaviconGcRepository(isolated.runtime.pool);
    const claimed = await gc.claimDue({ limit: 10, leaseOwner: 'fo07-gc', leaseDurationMs: 60_000 });
    const claim = claimed.find((candidate) => candidate.objectId === OBJECT_A);
    assert.ok(claim, 'the retired object is claimable once the window passes');
    const deleted: string[] = [];
    const result = await processFaviconGcClaim({
      store: {
        async delete(objectId: string) { deleted.push(objectId); },
      },
      repository: gc.repository,
      backoffSeconds: [1],
      now: () => new Date(),
    }, claim!);
    assert.equal(result.outcome, 'deleted');
    assert.deepEqual(deleted, [OBJECT_A]);
    assert.equal((await isolated.runtime.pool.query(
      `select 1 from favicon_pending_deletions where object_id = $1`, [OBJECT_A])).rows.length, 0);
  });

  test('Product recursive folder delete records every descendant icon for GC', async () => {
    await seedCanonicalCollection(isolated);
    const folder = await createFolder(isolated, FOLDER, ROOT, 'fp-gc-folder');
    const child = await createBookmark(isolated, BOOKMARK_B, FOLDER, 'https://example.test/gc-rec', 'fp-gc-rec');
    assert.equal(child.kind, 'created');
    await insertIcon(isolated, BOOKMARK_B, OBJECT_B);
    assert.equal(await iconCount(isolated, BOOKMARK_B), 1);

    const collection = await isolated.runtime.pool.query<{ content_revision: string }>(
      `select content_revision from collections where id = $1`, [COLLECTION]);
    const unitOfWork = createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db);
    await unitOfWork.execute((ports) => deleteCollectionNode(ports, {
      actor: { principalId: OWNER, principalType: 'account', subjectId: OWNER },
      command: { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12', fingerprint: 'fp-del-gc-rec' },
      collectionId: COLLECTION,
      nodeId: FOLDER,
      ifMatch: folder.node.etag,
      recursive: true,
      ifContentMatch: strongEntityTag(collection.rows[0]!.content_revision),
      operationId: Buffer.alloc(16, 42).toString('base64url'),
    }));
    assert.equal(await iconCount(isolated, BOOKMARK_B), 0);
    const pending = await isolated.runtime.pool.query<{ node_id: string }>(
      `select node_id from favicon_pending_deletions where object_id = $1`, [OBJECT_B]);
    assert.equal(pending.rows.length, 1);
    assert.equal(pending.rows[0]!.node_id, BOOKMARK_B);
  });

  test('collection tombstone records every icon binding for GC', async () => {
    await seedCanonicalCollection(isolated);
    const created = await createBookmark(isolated, BOOKMARK_A, ROOT, 'https://example.test/gc-coll', 'fp-gc-coll');
    await insertIcon(isolated, BOOKMARK_A, OBJECT_A);
    await createBookmark(isolated, BOOKMARK_B, ROOT, 'https://example.test/gc-coll-b', 'fp-gc-coll-b');
    await insertIcon(isolated, BOOKMARK_B, OBJECT_B);
    assert.equal(await iconCount(isolated, BOOKMARK_A), 1);

    // The sync trash path tombstones a collection bottom-up in one transaction:
    // children, root, then the collection (deferred constraints check the
    // final state at commit).
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `update nodes set deleted_at = now() where id in ($1, $2)`, [BOOKMARK_A, BOOKMARK_B]);
      await client.query(
        `update nodes set deleted_at = now() where id = $1`, [ROOT]);
      await client.query(
        `update collections set deleted_at = now()
          where id = $1`, [COLLECTION]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    assert.equal(await iconCount(isolated, BOOKMARK_A), 0);
    assert.equal(await iconCount(isolated, BOOKMARK_B), 0);
    const pending = await isolated.runtime.pool.query<{ object_id: string; node_id: string }>(
      `select object_id, node_id from favicon_pending_deletions
        where node_id = any($1::text[]) order by node_id`, [[BOOKMARK_A, BOOKMARK_B]]);
    assert.equal(pending.rows.length, 2);
    assert.deepEqual(pending.rows.map((row) => [row.object_id, row.node_id]),
      [[OBJECT_A, BOOKMARK_A], [OBJECT_B, BOOKMARK_B]]);

    // The root node's own tombstone is not required: B's record must also be
    // independent of any node-level trigger having fired (it did not — the
    // collection was tombstoned directly).
    const rootPending = await isolated.runtime.pool.query<{ object_id: string }>(
      `select object_id from favicon_pending_deletions where node_id = $1`, [ROOT]);
    assert.equal(rootPending.rows.length, 0);
    assert.equal(created.node.etag.length > 0, true);
  });

  test('Sync canonical delete_node path removes the icon row without deleteCollectionNode', async () => {
    await seedCanonicalCollection(isolated);
    const created = await createBookmark(isolated, BOOKMARK_A, ROOT, 'https://example.test/sync', 'fp-create-sync');
    await insertIcon(isolated, BOOKMARK_A, OBJECT_A);
    assert.equal(await iconCount(isolated, BOOKMARK_A), 1);

    const unit = createUnitOfWork(isolated.runtime.db);
    await unit.execute(async ({ transaction }) => {
      const canonical = createCanonicalMutationApplication(
        createPostgresCanonicalMutationPorts(transaction),
      );
      await canonical.execute({ transaction }, {
        operationId: Buffer.alloc(16, 33).toString('base64url'),
        collectionId: COLLECTION,
        actor: { principalId: OWNER, principalType: 'account' },
        mutation: {
          action: 'delete',
          target: { collectionId: COLLECTION, resourceId: BOOKMARK_A, resourceKind: 'node' },
          parentId: ROOT,
          expectedResourceRevision: created.node.revision,
          deleteIntent: { scope: 'single' },
        },
      });
    });
    assert.equal(await iconCount(isolated, BOOKMARK_A), 0);
  });

  test('same-collection move does not drop the bookmark_icons row', async () => {
    await seedCanonicalCollection(isolated);
    const folder = await createFolder(isolated, FOLDER, ROOT, 'fp-move-folder');
    const bookmark = await createBookmark(isolated, BOOKMARK_A, ROOT, 'https://example.test/move', 'fp-move-bm');
    await insertIcon(isolated, BOOKMARK_A, OBJECT_A);

    const unitOfWork = createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db);
    const moved = await unitOfWork.execute(async (ports) => {
      const root = await ports.nodes.getNode(COLLECTION, ROOT);
      return moveCollectionNode(ports, {
      actor: { principalId: OWNER, principalType: 'account', subjectId: OWNER },
      command: { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', fingerprint: 'fp-move' },
      collectionId: COLLECTION,
      nodeId: BOOKMARK_A,
      ifMatch: bookmark.node.etag,
      newParentId: FOLDER,
      afterId: null,
      beforeId: null,
      baseSourceParentRevision: root!.childrenRevision,
      baseTargetParentRevision: folder.node.kind === 'folder' ? folder.node.childrenRevision : '',
      operationId: Buffer.alloc(16, 34).toString('base64url'),
    });
    });
    assert.equal(moved.kind, 'moved');
    assert.equal(await iconCount(isolated, BOOKMARK_A), 1);
    const row = await isolated.runtime.pool.query<{ collection_id: string }>(
      `select collection_id from bookmark_icons where node_id = $1`,
      [BOOKMARK_A],
    );
    assert.equal(row.rows[0]?.collection_id, COLLECTION);
  });

  test('markDeleted on the node write port also drops the icon row', async () => {
    await seedCanonicalCollection(isolated);
    await createBookmark(isolated, BOOKMARK_A, ROOT, 'https://example.test/mark', 'fp-mark');
    await insertIcon(isolated, BOOKMARK_A, OBJECT_A);
    const unit = createUnitOfWork(isolated.runtime.db);
    await unit.execute(async ({ transaction }) => {
      const nodes = createPostgresNodeWritePort(transaction);
      await nodes.markDeleted(COLLECTION, BOOKMARK_A, {
        deletedAt: new Date('2026-08-20T00:00:00.000Z'),
        deletedCommitOrdinal: 9n,
        resourceRevision: Buffer.alloc(16, 40).toString('base64url'),
        updatedAt: new Date('2026-08-20T00:00:00.000Z'),
      });
    });
    assert.equal(await iconCount(isolated, BOOKMARK_A), 0);
  });
});

async function tablePresent(runtime: IsolatedPostgresRuntime, name: string): Promise<boolean> {
  const result = await runtime.runtime.pool.query<{ present: boolean }>(
    `select to_regclass(current_schema() || '.' || $1) is not null as present`,
    [name],
  );
  return result.rows[0]?.present === true;
}

async function columnLayout(
  runtime: IsolatedPostgresRuntime,
  table: string,
): Promise<Array<{ column_name: string; data_type: string; is_nullable: string }>> {
  const result = await runtime.runtime.pool.query<{
    column_name: string; data_type: string; is_nullable: string;
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
): Promise<void> {
  await assert.rejects(
    () => runtime.runtime.pool.query(sqlText, [...values]),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, code);
      return true;
    },
  );
}

async function iconCount(runtime: IsolatedPostgresRuntime, nodeId: string): Promise<number> {
  const result = await runtime.runtime.pool.query<{ n: string }>(
    `select count(*)::text as n from bookmark_icons where node_id = $1`,
    [nodeId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function insertIcon(
  runtime: IsolatedPostgresRuntime,
  nodeId: string,
  objectId: string,
): Promise<void> {
  await runtime.runtime.pool.query(
    `insert into bookmark_icons (
       node_id, collection_id, object_id, content_type, byte_size, digest_sha256
     ) values ($1, $2, $3, 'image/png', 16, $4)`,
    [nodeId, COLLECTION, objectId, DIGEST],
  );
}

async function insertLiveBookmark(
  runtime: IsolatedPostgresRuntime,
  nodeId: string,
  parentId: string,
  position: string,
): Promise<void> {
  await runtime.runtime.pool.query(
    `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')
     on conflict do nothing`,
    [nodeId],
  );
  await runtime.runtime.pool.query(
    `insert into nodes (
       id, collection_id, parent_id, kind, is_root, title, url, position_token,
       resource_revision, children_revision
     ) values ($1, $2, $3, 'bookmark', false, 'Fixture', 'https://example.test/fixture', $4, 'r1', 'ch1')
     on conflict (id) do nothing`,
    [nodeId, COLLECTION, parentId, position],
  );
  await backfillNodePayload(runtime, nodeId);
}

async function createBookmark(
  runtime: IsolatedPostgresRuntime,
  nodeId: string,
  parentId: string,
  url: string,
  fingerprint: string,
) {
  const unitOfWork = createPostgresCanonicalMutationUnitOfWork(runtime.runtime.db);
  const created = await unitOfWork.execute((ports) => createCollectionNode(ports, {
    actor: { principalId: OWNER, principalType: 'account', subjectId: OWNER },
    command: { commandId: commandIdFromFingerprint(fingerprint), fingerprint },
    operationId: Buffer.from(fingerprint).subarray(0, 16).toString('base64url').padEnd(22, 'A'),
    collectionId: COLLECTION,
    parentId,
    afterId: null,
    beforeId: null,
    nodeId,
    node: {
      kind: 'bookmark',
      title: `Bookmark ${nodeId}`,
      url,
      description: null,
      tags: [],
      visibility: 'inherit',
    },
  }));
  assert.equal(created.kind, 'created');
  if (created.kind !== 'created') throw new Error('expected create');
  return created;
}

async function createFolder(
  runtime: IsolatedPostgresRuntime,
  nodeId: string,
  parentId: string,
  fingerprint: string,
) {
  const unitOfWork = createPostgresCanonicalMutationUnitOfWork(runtime.runtime.db);
  const created = await unitOfWork.execute((ports) => createCollectionNode(ports, {
    actor: { principalId: OWNER, principalType: 'account', subjectId: OWNER },
    command: { commandId: commandIdFromFingerprint(fingerprint), fingerprint },
    operationId: Buffer.from(fingerprint).subarray(0, 16).toString('base64url').padEnd(22, 'A'),
    collectionId: COLLECTION,
    parentId,
    afterId: null,
    beforeId: null,
    nodeId,
    node: {
      kind: 'folder',
      title: `Folder ${nodeId}`,
      description: null,
      tags: [],
      visibility: 'inherit',
    },
  }));
  assert.equal(created.kind, 'created');
  if (created.kind !== 'created') throw new Error('expected create');
  return created;
}

function commandIdFromFingerprint(fingerprint: string): string {
  const hex = Buffer.from(fingerprint).toString('hex').padEnd(32, 'a').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function backfillNodePayload(runtime: IsolatedPostgresRuntime, nodeId: string): Promise<void> {
  const root = (await runtime.runtime.pool.query('select * from nodes where id = $1', [nodeId])).rows[0]!;
  const payload = materializeNodePayload({
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
  if (!payload.ok) throw new Error(payload.reason);
  await runtime.runtime.pool.query(
    `update nodes
        set payload_json = $2::jsonb, payload_schema_version = 1,
            payload_authority_status = 'backfilled'
      where id = $1`,
    [nodeId, JSON.stringify(payload.payload)],
  );
}

async function seedCanonicalCollection(runtime: IsolatedPostgresRuntime): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await truncateGuardedTablesInTransaction(client, `
      truncate table product_command_receipts, outbox_events, audit_events, operations,
        policy_revisions, content_revisions, children_revisions, resource_revisions,
        collection_policies, collection_members, bookmark_icons, nodes, collections,
        resource_id_ledger, profiles, accounts, sync_node_tombstones,
        sync_collection_purge_state cascade
    `);
    await client.query(
      `insert into accounts(id, subject_id, status) values ($1, $1, 'active')`,
      [OWNER],
    );
    await client.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'Favicon owner', null)`,
      [OWNER],
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
      [COLLECTION, ROOT],
    );
    await client.query(
      `insert into collections
         (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
          content_revision, policy_revision, commit_ordinal, updated_at)
       values ($1, $2, 'favicon-canonical', 'bookmarks', 'private', $3, 'r1', 'c1', 'p1', 1,
               timestamptz '2026-08-20T00:00:00Z')`,
      [COLLECTION, OWNER, ROOT],
    );
    await client.query(
      `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
       values ($1, $2, 'folder', true, $2, 'r1', 'ch1')`,
      [ROOT, COLLECTION],
    );
    await client.query(
      `insert into collection_members(collection_id, subject_id, role) values ($1, $2, 'owner')`,
      [COLLECTION, OWNER],
    );
    const collection = (await client.query('select * from collections where id = $1', [COLLECTION])).rows[0]!;
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
      [COLLECTION, JSON.stringify(collectionPayload.payload)],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  await backfillNodePayload(runtime, ROOT);
}
