import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresOrganizePlanMutationUnitOfWork,
  createPostgresOrganizePlanReadPort,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  applyCollectionOrganizePlan,
  createCollectionOrganizePlan,
  createOrganizePlanner,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-08-23T08:00:00.000Z');
const PRINCIPAL = 'EYlqOvhchEb8eII7YxCk_A';
const OWNER = PRINCIPAL;
const COL = '9Ti8hgm164j6ZUz3-ZNwQg';
const ROOT = 'ogp-apply-root-a';
const UNSORTED = 'ogp-apply-unsorted';
const ARCHIVES = 'ogp-apply-archives';
const BM_INBOX_A = 'ogp-apply-bm-a';
const BM_INBOX_B = 'ogp-apply-bm-b';
const BM_INBOX_C = 'ogp-apply-bm-c';
const BM_ROOT = 'ogp-apply-bm-root';
const BM_ARCH = 'ogp-apply-bm-arch';

describeWithPostgres('OG-02 PostgreSQL organize-plan apply', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('og02_organize_plan_apply', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  async function backfillCanonicalPayloads(
    client: Awaited<ReturnType<IsolatedPostgresRuntime['runtime']['pool']['connect']>>,
  ): Promise<void> {
    const fixtureCollection = (await client.query(
      'select * from collections where id = $1',
      [COL],
    )).rows[0];
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
    const fixtureNodes = await client.query(
      'select * from nodes where collection_id = $1',
      [COL],
    );
    for (const row of fixtureNodes.rows) {
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
        truncate table product_command_receipts, collection_organize_plans, collection_tree_versions,
          collection_invites, collection_members, nodes, collections, resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $2, 'active', 0)`,
        [PRINCIPAL, OWNER],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'Organize apply owner', null)`,
        [PRINCIPAL],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'),
         ($2, 'node'), ($3, 'node'), ($4, 'node'),
         ($5, 'node'), ($6, 'node'), ($7, 'node'), ($8, 'node'), ($9, 'node')`,
        [COL, ROOT, UNSORTED, ARCHIVES, BM_INBOX_A, BM_INBOX_B, BM_INBOX_C, BM_ROOT, BM_ARCH],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal, deleted_at
         ) values
         ($1, $2, 'Organize apply library', null, 'bookmarks', 'private', $3, 'a-r1', 'a-c1', 'a-p1', 1, null)`,
        [COL, OWNER, ROOT],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision, created_at, deleted_at
         ) values
         ($1, $9, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit', null, 'r-r1', 'r-cr1', $10, null),
         ($2, $9, $1, 'folder', false, 'Unsorted', null, null, '[]'::jsonb, 'inherit', 'A', 'u-r1', 'u-cr1', $10, null),
         ($3, $9, $1, 'folder', false, 'Archives', null, null, '[]'::jsonb, 'inherit', 'B', 's-r1', 's-cr1', $10, null),
         ($4, $9, $2, 'bookmark', false, 'Repo A', 'https://github.com/acme/a', null, '[]'::jsonb,
          'inherit', 'A', 'ba-r1', 'ba-cr1', $10, null),
         ($5, $9, $2, 'bookmark', false, 'Repo B', 'https://github.com/acme/b', null, '[]'::jsonb,
          'inherit', 'B', 'bb-r1', 'bb-cr1', $10, null),
         ($6, $9, $2, 'bookmark', false, 'Lonely tab', 'https://example.net/unique', null, '[]'::jsonb,
          'inherit', 'C', 'bc-r1', 'bc-cr1', $10, null),
         ($7, $9, $1, 'bookmark', false, 'Root tab', 'https://github.com/acme/root', null, '[]'::jsonb,
          'inherit', 'D', 'br-r1', 'br-cr1', $10, null),
         ($8, $9, $3, 'bookmark', false, 'Archived', 'https://github.com/acme/arch', null, '[]'::jsonb,
          'inherit', 'E', 'bs-r1', 'bs-cr1', $10, null)`,
        [ROOT, UNSORTED, ARCHIVES, BM_INBOX_A, BM_INBOX_B, BM_INBOX_C, BM_ROOT, BM_ARCH, COL, NOW],
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

  test('select one create_folder + two moves; unselected bookmark stays in Unsorted', async () => {
    await resetLibrary();
    const mutations = createPostgresOrganizePlanMutationUnitOfWork(isolated.runtime.db);
    const planner = createOrganizePlanner(undefined);
    const created = await mutations.execute((ports) => createCollectionOrganizePlan({
      ...ports,
      planner,
      clock: { now: () => NOW },
    }, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: randomUUID(),
      collectionId: COL,
    }));
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;
    const createFolder = created.plan.actions.find((action) =>
      action.target.type === 'create_folder'
      && action.nodeIds.includes(BM_INBOX_A)
      && action.nodeIds.includes(BM_INBOX_B));
    assert.ok(createFolder, 'expected a create_folder action covering the two github bookmarks');
    assert.equal(createFolder.nodeIds.includes(BM_INBOX_C), false);

    const applied = await mutations.execute((ports) => applyCollectionOrganizePlan({
      ...ports,
      clock: { now: () => NOW },
    }, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: randomUUID(),
      collectionId: COL,
      planId: created.plan.planId,
      ifMatch: created.plan.etag,
      actionIds: [createFolder.id],
    }));
    assert.equal(applied.kind, 'succeeded');
    if (applied.kind !== 'succeeded') return;
    assert.equal(applied.receipt.createdFolderIds.length, 1);
    const folderId = applied.receipt.createdFolderIds[0]!;
    assert.deepEqual([...applied.receipt.movedNodeIds].sort(), [BM_INBOX_A, BM_INBOX_B].sort());

    const client = await isolated.runtime.pool.connect();
    try {
      const folder = await client.query(
        `select id, kind, parent_id, deleted_at from nodes where id = $1`,
        [folderId],
      );
      assert.equal(folder.rows[0]?.kind, 'folder');
      assert.equal(folder.rows[0]?.parent_id, ROOT);
      assert.equal(folder.rows[0]?.deleted_at, null);
      const moved = await client.query(
        `select id, parent_id from nodes where id = any($1::text[]) order by id`,
        [[BM_INBOX_A, BM_INBOX_B]],
      );
      assert.equal(moved.rows.length, 2);
      assert.equal(moved.rows.every((row) => row.parent_id === folderId), true);
      const leftover = await client.query(
        `select parent_id from nodes where id = $1`,
        [BM_INBOX_C],
      );
      assert.equal(leftover.rows[0]?.parent_id, UNSORTED);
      const plan = await client.query(
        `select status, applied_action_ids from collection_organize_plans where plan_id = $1`,
        [created.plan.planId],
      );
      assert.equal(plan.rows[0]?.status, 'applied');
      assert.deepEqual(plan.rows[0]?.applied_action_ids, [createFolder.id]);
      const versions = await client.query(
        `select kind from collection_tree_versions where collection_id = $1`,
        [COL],
      );
      assert.equal(versions.rows.length, 0);
    } finally {
      client.release();
    }

    const reads = createPostgresOrganizePlanReadPort(isolated.runtime.db);
    const fetched = await reads.getById(PRINCIPAL, COL, created.plan.planId);
    assert.equal(fetched?.status, 'applied');
  });

  async function createGithubPlanAndApply(
    mutations: ReturnType<typeof createPostgresOrganizePlanMutationUnitOfWork>,
  ) {
    const planner = createOrganizePlanner(undefined);
    const created = await mutations.execute((ports) => createCollectionOrganizePlan({
      ...ports,
      planner,
      clock: { now: () => NOW },
    }, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: randomUUID(),
      collectionId: COL,
    }));
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') throw new Error('create failed');
    const createFolder = created.plan.actions.find((action) =>
      action.target.type === 'create_folder'
      && action.nodeIds.includes(BM_INBOX_A)
      && action.nodeIds.includes(BM_INBOX_B));
    assert.ok(createFolder, 'expected a create_folder action covering the two github bookmarks');
    const applied = await mutations.execute((ports) => applyCollectionOrganizePlan({
      ...ports,
      clock: { now: () => NOW },
    }, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: randomUUID(),
      collectionId: COL,
      planId: created.plan.planId,
      ifMatch: created.plan.etag,
      actionIds: [createFolder.id],
    }));
    assert.equal(applied.kind, 'succeeded');
    if (applied.kind !== 'succeeded') throw new Error('apply failed');
    return applied;
  }

  test('HV-HOOK writes pre_mutation only when collectionHistoryEnabled', async () => {
    for (const enabled of [true, false]) {
      await resetLibrary();
      const mutations = createPostgresOrganizePlanMutationUnitOfWork(isolated.runtime.db, {
        collectionHistoryEnabled: enabled,
      });
      const applied = await createGithubPlanAndApply(mutations);
      const folderId = applied.receipt.createdFolderIds[0]!;
      const client = await isolated.runtime.pool.connect();
      try {
        const versions = await client.query(
          `select kind, label from collection_tree_versions where collection_id = $1`,
          [COL],
        );
        if (enabled) {
          assert.equal(versions.rows.length, 1);
          assert.equal(versions.rows[0]?.kind, 'pre_mutation');
          assert.equal(versions.rows[0]?.label, 'Before organize');
        } else {
          assert.equal(versions.rows.length, 0);
        }
        const moved = await client.query(
          `select parent_id from nodes where id = any($1::text[])`,
          [[BM_INBOX_A, BM_INBOX_B]],
        );
        assert.equal(moved.rows.every((row) => row.parent_id === folderId), true);
      } finally {
        client.release();
      }
    }
  });
});
