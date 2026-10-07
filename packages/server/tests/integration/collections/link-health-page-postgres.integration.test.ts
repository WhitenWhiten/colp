import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresLinkHealthEnqueueUnitOfWork,
  createPostgresLinkHealthReadPort,
} from '../../../src/infrastructure/collections/index.js';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createProductLinkHealthCursorSigner,
  enqueueMyLinkHealthChecks,
  getMyLinkHealthPage,
  materializeCollectionPayload,
  materializeNodePayload,
  type CanonicalMutationInput,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-08-22T08:00:00.000Z');
const OWNER = 'lh-owner-subject';
const EDITOR = 'lh-editor-subject';
const VIEWER = 'lh-viewer-subject';
const STRANGER = 'lh-stranger-subject';
const OUTSIDER = 'lh-outsider-subject';
const COLLECTION_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ROOT_ID = 'lh-canonical-root';
const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';
const BOOKMARK_A = 'lh-bookmark-a';
const BOOKMARK_B = 'lh-bookmark-b';
const FOLDER_ID = 'lh-folder';
const OUTSIDER_COLLECTION = 'lh-collection-outsider';
const OUTSIDER_ROOT = 'lh-outsider-root';
const OUTSIDER_NODE = 'lh-outsider-bookmark';

describeWithPostgres('LH-01 PostgreSQL link-health page and mutation hooks', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('lh01_link_health', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  async function resetOwnedLibrary(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, outbox_events, audit_events, operations,
          policy_revisions, content_revisions, children_revisions, resource_revisions,
          collection_policies, collection_members, collection_link_health, nodes, collections,
          resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ('lh-owner-account', $1, 'active', 0), ('lh-outsider-account', $2, 'active', 0),
                ('lh-editor-account', $3, 'active', 0), ('lh-viewer-account', $4, 'active', 0),
                ('lh-stranger-account', $5, 'active', 0)`,
        [OWNER, OUTSIDER, EDITOR, VIEWER, STRANGER],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ('lh-owner-account', 'Link health owner', null),
                ('lh-outsider-account', 'Link health outsider', null),
                ('lh-editor-account', 'Link health editor', null),
                ('lh-viewer-account', 'Link health viewer', null),
                ('lh-stranger-account', 'Link health stranger', null)`,
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node'), ($4, 'node'), ($5, 'node'),
         ($6, 'collection'), ($7, 'node'), ($8, 'node')`,
        [COLLECTION_ID, ROOT_ID, BOOKMARK_A, BOOKMARK_B, FOLDER_ID,
          OUTSIDER_COLLECTION, OUTSIDER_ROOT, OUTSIDER_NODE],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values
         ($1, $2, 'Owned library', null, 'bookmarks', 'private', $3, 'col-r1', 'col-c1', 'col-p1', 1),
         ($4, $5, 'Outsider library', null, 'bookmarks', 'private', $6, 'out-r1', 'out-c1', 'out-p1', 1)`,
        [COLLECTION_ID, OWNER, ROOT_ID, OUTSIDER_COLLECTION, OUTSIDER, OUTSIDER_ROOT],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision, created_at
         ) values
         ($1, $3, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit', null, 'root-r1', 'root-cr1', $9),
         ($2, $3, $1, 'bookmark', false, 'Alpha', 'https://example.com/shared', null, '[]'::jsonb,
          'inherit', 'A', 'node-a-r1', 'node-a-cr1', '2026-08-22T07:00:00.000Z'),
         ($4, $3, $1, 'bookmark', false, 'Beta', 'https://EXAMPLE.com/shared', null, '[]'::jsonb,
          'inherit', 'B', 'node-b-r1', 'node-b-cr1', '2026-08-22T07:01:00.000Z'),
         ($5, $3, $1, 'folder', false, 'Folder', null, null, '[]'::jsonb, 'inherit', 'C', 'folder-r1', 'folder-cr1', $9),
         ($6, $8, null, 'folder', true, 'Outsider root', null, null, '[]'::jsonb, 'inherit', null, 'out-root-r1', 'out-root-cr1', $9),
         ($7, $8, $6, 'bookmark', false, 'Secret', 'https://example.com/secret', null, '[]'::jsonb,
          'inherit', 'A', 'out-node-r1', 'out-node-cr1', $9)`,
        [ROOT_ID, BOOKMARK_A, COLLECTION_ID, BOOKMARK_B, FOLDER_ID, OUTSIDER_ROOT, OUTSIDER_NODE, OUTSIDER_COLLECTION, NOW],
      );
      await client.query(
        `insert into collection_link_health (node_id, collection_id, status)
         values ($1, $3, 'pending'), ($2, $3, 'pending'), ($4, $5, 'pending')`,
        [BOOKMARK_A, BOOKMARK_B, COLLECTION_ID, OUTSIDER_NODE, OUTSIDER_COLLECTION],
      );
      await client.query(
        `insert into collection_members (collection_id, subject_id, role)
         values ($1, $2, 'editor'), ($1, $3, 'viewer'), ($4, $5, 'editor')`,
        [COLLECTION_ID, EDITOR, VIEWER, OUTSIDER_COLLECTION, OWNER],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  test('lists owned live bookmarks, computes duplicates, and omits folders and other owners', async () => {
    await resetOwnedLibrary();
    const signer = createProductLinkHealthCursorSigner({
      current: { id: 'lh-pg-v1', key: 'link-health-pg-cursor-secret-material' },
    });
    try {
      const page = await getMyLinkHealthPage({
        reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER } });
      const ids = page.items.map((item) => item.nodeId);
      assert.equal(ids.includes(FOLDER_ID), false);
      assert.equal(ids.includes(OUTSIDER_NODE), false);
      const alpha = page.items.find((item) => item.nodeId === BOOKMARK_A);
      const beta = page.items.find((item) => item.nodeId === BOOKMARK_B);
      assert.ok(alpha && beta);
      assert.equal(alpha.duplicateOfNodeId, null);
      assert.equal(beta.duplicateOfNodeId, BOOKMARK_A);
      assert.equal(alpha.status, 'pending');
      assert.equal(alpha.etag, '"node-a-r1"');
      assert.equal(alpha.host, 'example.com');
    } finally {
      signer.destroy();
    }
  });

  test('signed continuation explicitly encodes a null checked_at bound', async () => {
    await resetOwnedLibrary();
    await isolated.runtime.pool.query(
      `update collection_link_health set status = 'healthy', checked_at = $2 where node_id = $1`,
      [BOOKMARK_B, '2026-08-22T07:30:00.000Z'],
    );
    const signer = createProductLinkHealthCursorSigner({
      current: { id: 'lh-pg-cur-v1', key: 'link-health-pg-cursor-secret-material' },
    });
    try {
      const first = await getMyLinkHealthPage({
        reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER }, limit: 1 });
      assert.equal(first.items.length, 1);
      assert.equal(first.items[0]?.nodeId, BOOKMARK_A);
      assert.ok(first.nextCursor);
      const payload = signer.verify(first.nextCursor!, NOW);
      assert.equal(payload.after.checkedAt, null);
      assert.equal(payload.after.nodeId, BOOKMARK_A);
      assert.equal(payload.filters.scope, 'owned');
      const second = await getMyLinkHealthPage({
        reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER }, cursor: first.nextCursor! });
      assert.equal(second.items[0]?.nodeId, BOOKMARK_B);
    } finally {
      signer.destroy();
    }
  });

  test('shared scope lists editor bookmarks, excludes owned-only, and does not leak to strangers', async () => {
    await resetOwnedLibrary();
    const signer = createProductLinkHealthCursorSigner({
      current: { id: 'lh-pg-shared-v1', key: 'link-health-pg-shared-cursor-secret-material' },
    });
    const ports = {
      reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
      cursors: signer,
      clock: { now: async () => NOW },
    };
    try {
      const editorShared = await getMyLinkHealthPage(ports, {
        actor: { subjectId: EDITOR }, scope: 'shared',
      });
      assert.equal(editorShared.items.some((item) => item.nodeId === BOOKMARK_A), true);
      assert.equal(editorShared.items.every((item) => item.membership === 'editor'), true);
      const strangerShared = await getMyLinkHealthPage(ports, {
        actor: { subjectId: STRANGER }, scope: 'shared',
      });
      assert.deepEqual(strangerShared.items, []);
      const ownerOwned = await getMyLinkHealthPage(ports, { actor: { subjectId: OWNER } });
      assert.equal(ownerOwned.items.some((item) => item.nodeId === OUTSIDER_NODE), false);
      assert.equal(ownerOwned.items.some((item) => item.nodeId === BOOKMARK_A), true);
      const ownerShared = await getMyLinkHealthPage(ports, {
        actor: { subjectId: OWNER }, scope: 'shared',
      });
      assert.equal(ownerShared.items.some((item) => item.nodeId === BOOKMARK_A), false);
      assert.equal(ownerShared.items.some((item) => item.nodeId === OUTSIDER_NODE), true);
      assert.equal(ownerShared.items.find((item) => item.nodeId === OUTSIDER_NODE)?.membership, 'editor');
      const ownerAll = await getMyLinkHealthPage(ports, {
        actor: { subjectId: OWNER }, scope: 'all',
      });
      const allIds = ownerAll.items.map((item) => item.nodeId);
      assert.equal(allIds.includes(BOOKMARK_A), true);
      assert.equal(allIds.includes(OUTSIDER_NODE), true);
      assert.equal(new Set(allIds).size, allIds.length);
    } finally {
      signer.destroy();
    }
  });

  test('viewer POST with shared collectionId skips; editor POST marks pending', async () => {
    await resetOwnedLibrary();
    await isolated.runtime.pool.query(
      `update collection_link_health set status = 'healthy', checked_at = $2 where node_id = any($1::text[])`,
      [[BOOKMARK_A, BOOKMARK_B], NOW],
    );
    const uow = createPostgresLinkHealthEnqueueUnitOfWork(isolated.runtime.db);
    const viewer = await uow.execute((ports) => enqueueMyLinkHealthChecks(ports, {
      actor: { principalId: 'lh-viewer-account', subjectId: VIEWER },
      commandId: randomUUID(),
      filter: { collectionId: COLLECTION_ID },
    }));
    assert.equal(viewer.kind, 'succeeded');
    if (viewer.kind === 'succeeded') assert.equal(viewer.queued, 0);
    const afterViewer = await isolated.runtime.pool.query<{ status: string }>(
      `select status from collection_link_health where node_id = $1`,
      [BOOKMARK_A],
    );
    assert.equal(afterViewer.rows[0]?.status, 'healthy');
    const editor = await uow.execute((ports) => enqueueMyLinkHealthChecks(ports, {
      actor: { principalId: 'lh-editor-account', subjectId: EDITOR },
      commandId: randomUUID(),
      filter: { collectionId: COLLECTION_ID },
    }));
    assert.equal(editor.kind, 'succeeded');
    if (editor.kind === 'succeeded') assert.equal(editor.queued, 2);
    const afterEditor = await isolated.runtime.pool.query<{ status: string }>(
      `select status from collection_link_health where collection_id = $1`,
      [COLLECTION_ID],
    );
    assert.equal(afterEditor.rows.every((row) => row.status === 'pending'), true);
  });

  test('shared first page continuation with only cursor stays on the shared set', async () => {
    await resetOwnedLibrary();
    const signer = createProductLinkHealthCursorSigner({
      current: { id: 'lh-pg-shared-cur-v1', key: 'link-health-pg-shared-cont-secret-material' },
    });
    try {
      const first = await getMyLinkHealthPage({
        reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: EDITOR }, scope: 'shared', limit: 1 });
      assert.equal(first.items.length, 1);
      assert.ok(first.nextCursor);
      const payload = signer.verify(first.nextCursor!, NOW);
      assert.equal(payload.filters.scope, 'shared');
      const second = await getMyLinkHealthPage({
        reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: EDITOR }, cursor: first.nextCursor! });
      assert.equal(second.items.length, 1);
      assert.notEqual(second.items[0]?.nodeId, first.items[0]?.nodeId);
      assert.equal(second.items[0]?.membership, 'editor');
    } finally {
      signer.destroy();
    }
  });

  test('legacy three-key cursor continuation without query.scope remains the owned set', async () => {
    await resetOwnedLibrary();
    const signer = createProductLinkHealthCursorSigner({
      current: { id: 'lh-pg-legacy-v1', key: 'link-health-pg-legacy-cursor-secret-material' },
    });
    try {
      const token = signer.sign({
        v: 1,
        purpose: 'link_health_v1',
        subjectId: OWNER,
        filters: { status: null, collectionId: null, duplicate: false },
        limit: 1,
        sort: 'checked_at:asc_nulls_first,node_id:asc',
        comparatorVersion: 'checked-at-nulls-first-node-id-v1',
        after: { checkedAt: null, nodeId: BOOKMARK_A },
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      });
      const page = await getMyLinkHealthPage({
        reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER }, cursor: token });
      assert.equal(page.items[0]?.nodeId, BOOKMARK_B);
      assert.equal(page.items[0]?.membership, 'owner');
    } finally {
      signer.destroy();
    }
  });

  test('canonical bookmark create upserts pending health; url update returns pending; soft-delete removes the row', async () => {
    await resetCanonicalFixture();
    const createdId = 'lh-created-bookmark';
    const created = await executeMutation(nodeMutation(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'create', createdId, ROOT_ID,
      {
        kindFields: {
          kind: 'bookmark', title: 'Created', url: 'https://example.test/created',
          description: null, tags: [], visibility: 'inherit',
        },
      },
    ));
    const afterCreate = await isolated.runtime.pool.query(
      `select status, http_status, final_url, checked_at, lease_owner, lease_until
       from collection_link_health where node_id = $1`,
      [createdId],
    );
    assert.equal(afterCreate.rowCount, 1);
    assert.equal(afterCreate.rows[0]?.status, 'pending');
    assert.equal(afterCreate.rows[0]?.http_status, null);
    assert.equal(afterCreate.rows[0]?.final_url, null);
    assert.equal(afterCreate.rows[0]?.checked_at, null);

    await isolated.runtime.pool.query(
      `update collection_link_health
          set status = 'healthy', http_status = 200, final_url = 'https://example.test/created',
              checked_at = $2, lease_owner = 'worker-1', lease_until = $2
        where node_id = $1`,
      [createdId, NOW],
    );
    await executeMutation({
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      collectionId: COLLECTION_ID,
      actor: { principalId: PRINCIPAL_ID, principalType: 'account' },
      mutation: {
        action: 'update',
        target: { collectionId: COLLECTION_ID, resourceId: createdId, resourceKind: 'node' },
        parentId: ROOT_ID,
        expectedResourceRevision: created.allocation.resourceRevision,
        fields: {
          kindFields: {
            kind: 'bookmark', title: 'Created', url: 'https://example.test/updated',
            description: null, tags: [], visibility: 'inherit',
          },
          extensions: {},
        },
      },
    });
    const afterUpdate = await isolated.runtime.pool.query(
      `select status, http_status, final_url, checked_at, lease_owner, lease_until
       from collection_link_health where node_id = $1`,
      [createdId],
    );
    assert.equal(afterUpdate.rows[0]?.status, 'pending');
    assert.equal(afterUpdate.rows[0]?.http_status, null);
    assert.equal(afterUpdate.rows[0]?.final_url, null);
    assert.equal(afterUpdate.rows[0]?.checked_at, null);
    assert.equal(afterUpdate.rows[0]?.lease_owner, null);
    assert.equal(afterUpdate.rows[0]?.lease_until, null);

    const current = await isolated.runtime.pool.query<{ resource_revision: string }>(
      'select resource_revision from nodes where id = $1',
      [createdId],
    );
    await executeMutation(nodeMutation(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'delete', createdId, ROOT_ID,
      { expectedResourceRevision: current.rows[0]!.resource_revision },
    ));
    const afterDelete = await isolated.runtime.pool.query(
      'select 1 from collection_link_health where node_id = $1',
      [createdId],
    );
    assert.equal(afterDelete.rowCount, 0);
    const tombstone = await isolated.runtime.pool.query(
      'select deleted_at is not null as deleted from nodes where id = $1',
      [createdId],
    );
    assert.equal(tombstone.rows[0]?.deleted, true);
  });

  function nodeMutation(
    operationId: string,
    action: 'create' | 'delete',
    resourceId: string,
    parentId: string,
    options: {
      readonly expectedResourceRevision?: string;
      readonly kindFields?: Record<string, unknown>;
    } = {},
  ): CanonicalMutationInput {
    return {
      operationId,
      collectionId: COLLECTION_ID,
      actor: { principalId: PRINCIPAL_ID, principalType: 'account' },
      mutation: {
        action,
        target: { collectionId: COLLECTION_ID, resourceId, resourceKind: 'node' },
        parentId,
        ...(options.expectedResourceRevision ? { expectedResourceRevision: options.expectedResourceRevision } : {}),
        ...(action === 'delete' && options.kindFields === undefined ? {} : {
          fields: {
            kindFields: options.kindFields ?? {
              kind: 'folder', title: 'Folder', url: null, description: null, tags: [], visibility: 'inherit',
            },
            extensions: {},
          },
        }),
        ...(action === 'delete' ? { deleteIntent: { scope: 'single' } } : {}),
      },
    };
  }

  async function executeMutation(input: CanonicalMutationInput) {
    const binding = {
      principalId: PRINCIPAL_ID,
      commandScope: `canonical:${input.mutation.action}`,
      commandId: input.operationId,
    };
    const fingerprint = `fp-${input.operationId}`;
    return createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db).execute(async (ports) => {
      assert.deepEqual(await ports.receipts.claim(binding, fingerprint), { kind: 'claimed' });
      const result = await ports.canonical.execute(input);
      await ports.receipts.complete(binding, fingerprint, {
        status: 200,
        body: Buffer.from(JSON.stringify({ operationId: input.operationId })),
        stableHeaders: { 'content-type': 'application/json' },
        mediaType: 'application/json',
        contractVersion: '1.0.0',
        targetIdentity: input.mutation.target.resourceId,
      });
      return result;
    });
  }

  async function resetCanonicalFixture(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, outbox_events, audit_events, operations,
          policy_revisions, content_revisions, children_revisions, resource_revisions,
          collection_policies, collection_members, collection_link_health, nodes, collections,
          resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $1, 'active', 0)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'Link health owner', null)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [COLLECTION_ID, ROOT_ID],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'Canonical', null, 'bookmarks', 'private', $3, 'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [COLLECTION_ID, PRINCIPAL_ID, ROOT_ID],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         ) values
         ($1, $2, null, 'folder', true, 'Canonical', null, null, '[]'::jsonb,
          'inherit', null, 'root-r1', 'root-children-r1')`,
        [ROOT_ID, COLLECTION_ID],
      );
      const fixtureCollection = (await client.query('select * from collections where id = $1', [COLLECTION_ID])).rows[0];
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
        `update collections set payload_json = $2::jsonb, payload_schema_version = 1,
            payload_authority_status = 'backfilled' where id = $1`,
        [COLLECTION_ID, JSON.stringify(materializedCollection.payload)],
      );
      const root = (await client.query('select * from nodes where id = $1', [ROOT_ID])).rows[0];
      const materialized = materializeNodePayload({
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
      assert.equal(materialized.ok, true);
      if (!materialized.ok) throw new Error(materialized.reason);
      await client.query(
        `update nodes set payload_json = $2::jsonb, payload_schema_version = 1,
            payload_authority_status = 'backfilled' where id = $1`,
        [ROOT_ID, JSON.stringify(materialized.payload)],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
});
