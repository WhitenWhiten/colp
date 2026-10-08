import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresCollectionVersionUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  CollectionVersionRestoreReceiptConflictError,
  createCollectionVersion,
  materializeCollectionPayload,
  materializeNodePayload,
  restoreCollectionVersion,
  strongEntityTag,
  type RestoreCollectionVersionPorts,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-08-24T08:00:00.000Z');
const OWNER = 'EYlqOvhchEb8eII7YxCk_A';
const PRINCIPAL = 'EYlqOvhchEb8eII7YxCk_A';
const COL = '9Ti8hgm164j6ZUz3-ZNwQg';
const ROOT = 'hv02-root-a';
const UNSORTED = 'hv02-unsorted';
const BM_EARLY = 'hv02-bm-early';
const BM_LATE = 'hv02-bm-late';
const EXTRA = 'hv02-extra-folder';
const SEPARATOR = 'hv02-separator';
const SLUG = 'hv02-published';

describeWithPostgres('HV-02 PostgreSQL collection version restore', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('hv02_collection_restore', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  async function backfillCanonicalPayloads(
    client: Awaited<ReturnType<IsolatedPostgresRuntime['runtime']['pool']['connect']>>,
  ): Promise<void> {
    const fixtureCollection = (await client.query('select * from collections where id = $1', [COL])).rows[0];
    const materializedCollection = materializeCollectionPayload({
      id: fixtureCollection.id,
      ownerSubjectId: fixtureCollection.owner_subject_id,
      title: fixtureCollection.title,
      summary: fixtureCollection.summary,
      kind: fixtureCollection.kind,
      visibility: fixtureCollection.visibility,
      rootNodeId: fixtureCollection.root_node_id,
      resourceRevision: fixtureCollection.resource_revision,
      contentRevision: fixtureCollection.content_revision,
      policyRevision: fixtureCollection.policy_revision,
      commitOrdinal: fixtureCollection.commit_ordinal,
      createdAt: fixtureCollection.created_at,
      updatedAt: fixtureCollection.updated_at,
      deletedAt: fixtureCollection.deleted_at,
    });
    assert.equal(materializedCollection.ok, true);
    if (!materializedCollection.ok) throw new Error(materializedCollection.reason);
    await client.query(
      `update collections
        set payload_json = $2::jsonb, payload_schema_version = 1,
            payload_authority_status = 'backfilled'
        where id = $1`,
      [COL, JSON.stringify(materializedCollection.payload)],
    );
    const fixtureNodes = await client.query('select * from nodes where collection_id = $1', [COL]);
    for (const row of fixtureNodes.rows) {
      if (row.kind === 'separator') continue;
      const materialized = materializeNodePayload({
        id: row.id,
        collectionId: row.collection_id,
        parentId: row.parent_id,
        kind: row.kind,
        isRoot: row.is_root,
        title: row.title,
        url: row.url,
        description: row.description,
        tags: row.tags,
        visibility: row.visibility,
        positionToken: row.position_token,
        resourceRevision: row.resource_revision,
        childrenRevision: row.children_revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
        deletedCommitOrdinal: row.deleted_commit_ordinal,
      });
      assert.equal(materialized.ok, true);
      if (!materialized.ok) throw new Error(`${row.id}: ${materialized.reason}`);
      await client.query(
        `update nodes
          set payload_json = $2::jsonb, payload_schema_version = 1, payload_authority_status = 'backfilled'
          where id = $1`,
        [row.id, JSON.stringify(materialized.payload)],
      );
    }
  }

  async function resetLibrary(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, collection_version_restore_receipts, collection_tree_versions,
          collection_organize_plans, collection_invites, collection_members, nodes, collections,
          resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch) values ($1, $2, 'active', 0)`,
        [PRINCIPAL, OWNER],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url) values ($1, 'Restore owner', null)`,
        [PRINCIPAL],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'),
         ($2, 'node'), ($3, 'node'), ($4, 'node'), ($5, 'node'), ($6, 'node'), ($7, 'node')`,
        [COL, ROOT, UNSORTED, BM_LATE, BM_EARLY, EXTRA, SEPARATOR],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal,
           publication_slug, published_at, deleted_at
         ) values
         ($1, $2, 'Restore library', null, 'bookmarks', 'private', $3,
          'a-r1', 'a-c1', 'a-p1', 1, $4, $5, null)`,
        [COL, OWNER, ROOT, SLUG, NOW],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision, created_at, deleted_at
         ) values
         ($1, $6, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit', null, 'r-r1', 'r-cr1', $7, null),
         ($2, $6, $1, 'folder', false, 'Unsorted', null, null, '[]'::jsonb, 'inherit', 'm', 'u-r1', 'u-cr1', $7, null),
         ($3, $6, $2, 'bookmark', false, 'Late', 'https://example.test/late', null, '[]'::jsonb,
          'inherit', 'z', 'bl-r1', 'bl-cr1', $7, null),
         ($4, $6, $2, 'bookmark', false, 'Early', 'https://example.test/early', null, '[]'::jsonb,
          'inherit', 'a', 'be-r1', 'be-cr1', $7, null),
         ($5, $6, $1, 'separator', false, null, null, null, '[]'::jsonb,
          'inherit', 's', 'sp-r1', 'sp-cr1', $7, null)`,
        [ROOT, UNSORTED, BM_LATE, BM_EARLY, SEPARATOR, COL, NOW],
      );
      await backfillCanonicalPayloads(client);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  test.each([10, 100])('BECORE-02 restores %i titles with two full-tree measurements', async (count) => {
    await resetLibrary();
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query(`insert into resource_id_ledger(resource_id,resource_type)
        select 'capacity-node-'||i,'node' from generate_series(1,$1) i`, [count]);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,
        position_token,resource_revision,children_revision)
        select 'capacity-node-'||i,$1,$2,'folder',false,'Original',
        'A'||lpad(i::text,5,'0'),'r1','ch1' from generate_series(1,$3) i`, [COL, ROOT, count]);
      await backfillCanonicalPayloads(client);
    } finally { client.release(); }
    let scans = 0;
    const db = isolated.runtime.db.withPlugin({
      transformQuery({ node }) {
        if (node.kind === 'RawNode' && 'sqlFragments' in node
          && (node.sqlFragments as readonly string[]).join('').includes('row_to_json(c) AS collection')) scans++;
        return node;
      },
      async transformResult({ result }) { return result; },
    });
    const unit = createPostgresCollectionVersionUnitOfWork(db);
    const actor = { principalId: PRINCIPAL, subjectId: OWNER };
    const created = await unit.execute(ports => createCollectionVersion(ports, {
      actor, commandId: randomUUID(), collectionId: COL, ifMatch: strongEntityTag('a-c1'),
    }));
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;
    await isolated.runtime.pool.query(`update nodes set title='Changed',
      payload_json=jsonb_set(payload_json,'{title}','"Changed"'::jsonb)
      where collection_id=$1 and id like 'capacity-node-%'`, [COL]);
    scans = 0;
    const restored = await unit.execute(ports => restoreCollectionVersion(ports as RestoreCollectionVersionPorts, {
      actor, commandId: randomUUID(), collectionId: COL, versionId: created.version.versionId,
      ifMatch: strongEntityTag('a-c1'),
    }));
    assert.equal(restored.kind, 'succeeded');
    if (restored.kind === 'succeeded') assert.equal(restored.receipt.updatedNodeIds.length, count);
    assert.equal(scans, 2);
  });

  test('BECORE-03 identical concurrent restore replays before stale If-Match', async () => {
    await resetLibrary();
    const unit = createPostgresCollectionVersionUnitOfWork(isolated.runtime.db);
    const actor = { principalId: PRINCIPAL, subjectId: OWNER };
    const created = await unit.execute(ports => createCollectionVersion(ports, {
      actor, commandId: randomUUID(), collectionId: COL, ifMatch: strongEntityTag('a-c1'),
    }));
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;
    await isolated.runtime.pool.query(`update nodes set title='Changed',
      payload_json=jsonb_set(payload_json,'{title}','"Changed"'::jsonb) where id=$1`, [BM_EARLY]);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const commandId = randomUUID();
    const input = { actor, commandId, collectionId: COL, versionId: created.version.versionId,
      ifMatch: strongEntityTag('a-c1') };
    const attempt = () => unit.execute(raw => {
      const ports = raw as RestoreCollectionVersionPorts;
      let initial = true;
      return restoreCollectionVersion({ ...ports, restoreReceipts: {
        ...ports.restoreReceipts,
        async getByCommandId(...args) {
          const found = await ports.restoreReceipts.getByCommandId(...args);
          if (initial) {
            initial = false;
            assert.equal(found, null);
            if (++arrivals === 2) release();
            await gate;
          }
          return found;
        },
      } }, input);
    });
    const outcomes = await Promise.all([attempt(), attempt()]);
    assert.deepEqual(outcomes.map(result => result.kind).sort(), ['replay', 'succeeded']);
    const durable = await isolated.runtime.pool.query(
      'select count(*)::int as count from collection_version_restore_receipts where command_id=$1', [commandId]);
    assert.equal(durable.rows[0].count, 1);
    const changed = await unit.execute(ports => restoreCollectionVersion(ports as RestoreCollectionVersionPorts,
      { ...input, ifMatch: strongEntityTag('different') }));
    assert.equal(changed.kind, 'reused');
    await assert.rejects(unit.execute(ports => restoreCollectionVersion(ports as RestoreCollectionVersionPorts,
      { ...input, commandId: randomUUID() })), { code: 'precondition_failed' });

    // The receipt is bound to a specific (collection, version). Re-reading it
    // under the same command id with another target must fail closed instead of
    // answering `reused` for work this command never performed.
    const currentRevision = await isolated.runtime.pool.query<{ content_revision: string }>(
      'select content_revision from collections where id=$1', [COL]);
    const secondVersion = await unit.execute(ports => createCollectionVersion({
      ...ports,
      // Clear the create-version cooldown without sleeping the suite.
      clock: { now: () => new Date(Date.now() + 11_000) },
    }, {
      actor, commandId: randomUUID(), collectionId: COL,
      ifMatch: strongEntityTag(currentRevision.rows[0]!.content_revision),
    }));
    assert.equal(secondVersion.kind, 'succeeded');
    if (secondVersion.kind !== 'succeeded') return;
    await assert.rejects(
      unit.execute(ports => restoreCollectionVersion(ports as RestoreCollectionVersionPorts, {
        ...input, versionId: secondVersion.version.versionId,
      })),
      (error: unknown) => error instanceof CollectionVersionRestoreReceiptConflictError,
    );
    const stillBound = await isolated.runtime.pool.query<{ version_id: string }>(
      'select version_id from collection_version_restore_receipts where command_id=$1', [commandId]);
    assert.deepEqual(stillBound.rows.map(row => row.version_id), [created.version.versionId]);
  });

  test('restore returns parents/order to the snapshot and drops the extra folder', async () => {
    await resetLibrary();
    const unit = createPostgresCollectionVersionUnitOfWork(isolated.runtime.db);
    const created = await unit.execute((ports) => createCollectionVersion({
      ...ports,
      clock: { now: () => NOW },
    }, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: randomUUID(),
      collectionId: COL,
      ifMatch: strongEntityTag('a-c1'),
    }));
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;
    const versionId = created.version.versionId;

    const client = await isolated.runtime.pool.connect();
    try {
      await client.query(`update nodes set parent_id = $1, position_token = 'b' where id = $2`, [ROOT, BM_EARLY]);
      await client.query(`update nodes set parent_id = $1, position_token = 'c' where id = $2`, [ROOT, BM_LATE]);
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision, created_at, deleted_at
         ) values
         ($1, $2, $3, 'folder', false, 'Extra', null, null, '[]'::jsonb, 'inherit', 'x', 'ex-r1', 'ex-cr1', $4, null)`,
        [EXTRA, COL, ROOT, NOW],
      );
      await client.query(
        `update collections set content_revision = 'a-c2', commit_ordinal = commit_ordinal + 1 where id = $1`,
        [COL],
      );
      await backfillCanonicalPayloads(client);
    } finally {
      client.release();
    }

    const before = await isolated.runtime.pool.query(
      `select content_revision, publication_slug, published_at from collections where id = $1`,
      [COL],
    );
    assert.equal(before.rows[0]?.content_revision, 'a-c2');
    assert.equal(before.rows[0]?.publication_slug, SLUG);

    const restored = await unit.execute((ports) => restoreCollectionVersion({
      ...(ports as RestoreCollectionVersionPorts),
      clock: { now: () => new Date(NOW.getTime() + 1000) },
    }, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: randomUUID(),
      collectionId: COL,
      versionId,
      ifMatch: strongEntityTag('a-c2'),
    }));
    assert.equal(restored.kind, 'succeeded');
    if (restored.kind !== 'succeeded') return;
    assert.equal(restored.receipt.noop, false);
    assert.equal(restored.receipt.deletedNodeIds.includes(EXTRA), true);

    const after = await isolated.runtime.pool.query(
      `select id, parent_id, deleted_at from nodes where id = any($1::text[])`,
      [[BM_EARLY, BM_LATE, EXTRA, ROOT, SEPARATOR]],
    );
    const byId = new Map(after.rows.map((row) => [row.id as string, row]));
    assert.equal(byId.get(BM_EARLY)?.parent_id, UNSORTED);
    assert.equal(byId.get(BM_LATE)?.parent_id, UNSORTED);
    assert.ok(byId.get(EXTRA)?.deleted_at);
    assert.equal(byId.get(ROOT)?.deleted_at, null);
    assert.equal(byId.get(SEPARATOR)?.deleted_at, null);

    const order = await isolated.runtime.pool.query(
      `select id from nodes
       where collection_id = $1 and parent_id = $2 and deleted_at is null
         and kind in ('folder', 'bookmark')
       order by coalesce(position_token, '') COLLATE "C", id COLLATE "C"`,
      [COL, UNSORTED],
    );
    assert.deepEqual(order.rows.map((row) => row.id), [BM_EARLY, BM_LATE]);

    const collection = await isolated.runtime.pool.query(
      `select content_revision, publication_slug, published_at from collections where id = $1`,
      [COL],
    );
    assert.notEqual(collection.rows[0]?.content_revision, 'a-c2');
    assert.equal(collection.rows[0]?.publication_slug, SLUG);
    assert.equal(String(collection.rows[0]?.published_at), String(before.rows[0]?.published_at));
  });
});
