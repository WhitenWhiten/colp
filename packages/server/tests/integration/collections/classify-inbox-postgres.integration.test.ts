import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import {
  backfillResourcePayloads,
  createPostgresClassifyInboxReadPort,
  createPostgresClassifyInboxSkipUnitOfWork,
  createPostgresClassifyInboxAcceptUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createProductClassifyInboxCursorSigner,
  getMyClassifyInboxPage,
  skipClassifyInboxItem,
  acceptClassifyInboxItem,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-08-24T08:00:00.000Z');
const OWNER = 'ci-owner-subject';
const OWNER_ACCOUNT = 'BgYGBgYGBgYGBgYGBgYGBg';
const OUTSIDER_ACCOUNT = 'BwcHBwcHBwcHBwcHBwcHBw';
const OUTSIDER = 'ci-outsider-subject';
const COLLECTION_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ROOT_ID = 'ci-canonical-root';
const FOLDER_ID = 'ci-folder';
const BOOKMARK_ROOT = 'ci-bookmark-root';
const BOOKMARK_CHILD = 'ci-bookmark-child';
const BOOKMARK_SIDECAR = 'ci-bookmark-sidecar';
const OUTSIDER_COLLECTION = 'ci-collection-outsider';
const OUTSIDER_ROOT = 'ci-outsider-root';
const OUTSIDER_NODE = 'ci-outsider-bookmark';

describeWithPostgres('CL-01 PostgreSQL classify inbox page', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('cl01_classify_inbox', { maxConnections: 4 });
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
          collection_policies, collection_members, collection_classify_inbox_decision,
          collection_link_health, nodes, collections,
          resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $3, 'active', 0), ($2, $4, 'active', 0)`,
        [OWNER_ACCOUNT, OUTSIDER_ACCOUNT, OWNER, OUTSIDER],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'Classify owner', null),
                ($2, 'Classify outsider', null)`,
        [OWNER_ACCOUNT, OUTSIDER_ACCOUNT],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node'), ($4, 'node'), ($5, 'node'), ($6, 'node'),
         ($7, 'collection'), ($8, 'node'), ($9, 'node')`,
        [COLLECTION_ID, ROOT_ID, FOLDER_ID, BOOKMARK_ROOT, BOOKMARK_CHILD, BOOKMARK_SIDECAR,
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
         ($1, $3, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit', null, 'root-r1', 'root-cr1', $10),
         ($2, $3, $1, 'folder', false, 'Spacing as a system', null, null, '[]'::jsonb, 'inherit', 'A',
          'folder-r1', 'folder-cr1', $10),
         ($4, $3, $1, 'bookmark', false, 'Design systems', 'https://system.example.com/essay', null, '[]'::jsonb,
          'inherit', 'B', 'node-root-r1', 'node-root-cr1', '2026-08-24T09:00:00.000Z'),
         ($5, $3, $2, 'bookmark', false, 'Nested bookmark', 'https://system.example.com/nested', null, '[]'::jsonb,
          'inherit', 'C', 'node-child-r1', 'node-child-cr1', '2026-08-24T09:01:00.000Z'),
         ($6, $3, $1, 'bookmark', false, 'Already skipped', 'https://system.example.com/skipped', null, '[]'::jsonb,
          'inherit', 'D', 'node-side-r1', 'node-side-cr1', '2026-08-24T09:02:00.000Z'),
         ($7, $9, null, 'folder', true, 'Outsider root', null, null, '[]'::jsonb, 'inherit', null,
          'out-root-r1', 'out-root-cr1', $10),
         ($8, $9, $7, 'bookmark', false, 'Secret', 'https://example.com/secret', null, '[]'::jsonb,
          'inherit', 'A', 'out-node-r1', 'out-node-cr1', $10)`,
        [ROOT_ID, FOLDER_ID, COLLECTION_ID, BOOKMARK_ROOT, BOOKMARK_CHILD, BOOKMARK_SIDECAR,
          OUTSIDER_ROOT, OUTSIDER_NODE, OUTSIDER_COLLECTION, NOW],
      );
      await client.query(
        `insert into collection_classify_inbox_decision (
           node_id, collection_id, account_subject_id, status, suggestion_id, decided_at
         ) values ($1, $2, $3, 'skipped', null, $4)`,
        [BOOKMARK_SIDECAR, COLLECTION_ID, OWNER, NOW],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await backfillResourcePayloads(isolated.runtime.db);
  }

  test('owner root bookmark appears; folder child, sidecar, and other users never appear', async () => {
    await resetOwnedLibrary();
    const signer = createProductClassifyInboxCursorSigner({
      current: { id: 'ci-pg-v1', key: 'classify-inbox-pg-cursor-secret-material' },
    });
    try {
      const page = await getMyClassifyInboxPage({
        reads: createPostgresClassifyInboxReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER } });
      const ids = page.items.map((item) => item.nodeId);
      assert.deepEqual(ids, [BOOKMARK_ROOT]);
      assert.equal(ids.includes(FOLDER_ID), false);
      assert.equal(ids.includes(BOOKMARK_CHILD), false);
      assert.equal(ids.includes(BOOKMARK_SIDECAR), false);
      assert.equal(ids.includes(OUTSIDER_NODE), false);
      const item = page.items[0];
      assert.ok(item);
      assert.equal(item.collectionId, COLLECTION_ID);
      assert.equal(item.host, 'system.example.com');
      assert.equal(item.etag, '"node-root-r1"');
      assert.ok(item.suggestions.some((suggestion) => suggestion.folderId === FOLDER_ID));
      const outsider = await getMyClassifyInboxPage({
        reads: createPostgresClassifyInboxReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OUTSIDER } });
      assert.equal(outsider.items.some((row) => row.collectionId === COLLECTION_ID), false);
      assert.equal(outsider.items.some((row) => row.nodeId === BOOKMARK_ROOT), false);
    } finally {
      signer.destroy();
    }
  });

  test('skip then GET is empty; replay does not insert a second sidecar row', async () => {
    await resetOwnedLibrary();
    const signer = createProductClassifyInboxCursorSigner({
      current: { id: 'ci-pg-skip-v1', key: 'classify-inbox-pg-skip-cursor-secret' },
    });
    const skip = createPostgresClassifyInboxSkipUnitOfWork(isolated.runtime.db);
    const commandId = randomUUID();
    try {
      const first = await skip.execute((ports) => skipClassifyInboxItem(ports, {
        actor: { principalId: OWNER_ACCOUNT, subjectId: OWNER },
        commandId,
        nodeId: BOOKMARK_ROOT,
        body: {},
      }));
      assert.equal(first.kind, 'succeeded');
      const replay = await skip.execute((ports) => skipClassifyInboxItem(ports, {
        actor: { principalId: OWNER_ACCOUNT, subjectId: OWNER },
        commandId,
        nodeId: BOOKMARK_ROOT,
        body: {},
      }));
      assert.equal(replay.kind, 'replay');
      const already = await skip.execute((ports) => skipClassifyInboxItem(ports, {
        actor: { principalId: OWNER_ACCOUNT, subjectId: OWNER },
        commandId: randomUUID(),
        nodeId: BOOKMARK_ROOT,
        body: {},
      }));
      assert.equal(already.kind, 'succeeded');
      const client = await isolated.runtime.pool.connect();
      try {
        const sidecar = await client.query<{ n: number; status: string; suggestion_id: string | null }>(
          `select count(*)::int as n, min(status) as status, min(suggestion_id) as suggestion_id
           from collection_classify_inbox_decision where node_id = $1`,
          [BOOKMARK_ROOT],
        );
        assert.equal(sidecar.rows[0]?.n, 1);
        assert.equal(sidecar.rows[0]?.status, 'skipped');
        assert.equal(sidecar.rows[0]?.suggestion_id, null);
        const node = await client.query<{ parent_id: string | null }>(
          'select parent_id from nodes where id = $1',
          [BOOKMARK_ROOT],
        );
        assert.equal(node.rows[0]?.parent_id, ROOT_ID);
      } finally {
        client.release();
      }
      const page = await getMyClassifyInboxPage({
        reads: createPostgresClassifyInboxReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER } });
      assert.deepEqual(page.items.map((item) => item.nodeId), []);
    } finally {
      signer.destroy();
    }
  });

  test('accept then GET is empty; node parent becomes the folder; replay is one sidecar', async () => {
    await resetOwnedLibrary();
    const signer = createProductClassifyInboxCursorSigner({
      current: { id: 'ci-pg-accept-v1', key: 'classify-inbox-pg-accept-cursor-secret' },
    });
    const accept = createPostgresClassifyInboxAcceptUnitOfWork(isolated.runtime.db);
    const commandId = randomUUID();
    try {
      const first = await accept.execute((ports) => acceptClassifyInboxItem(ports, {
        actor: { principalId: OWNER_ACCOUNT, subjectId: OWNER },
        commandId,
        nodeId: BOOKMARK_ROOT,
        ifMatch: '"node-root-r1"',
        body: { suggestionId: FOLDER_ID },
      }));
      assert.equal(first.kind, 'succeeded');
      if (first.kind === 'succeeded') {
        assert.deepEqual(first.receipt, {
          nodeId: BOOKMARK_ROOT, decision: 'accepted', folderId: FOLDER_ID,
        });
      }
      const replay = await accept.execute((ports) => acceptClassifyInboxItem(ports, {
        actor: { principalId: OWNER_ACCOUNT, subjectId: OWNER },
        commandId,
        nodeId: BOOKMARK_ROOT,
        ifMatch: '"node-root-r1"',
        body: { suggestionId: FOLDER_ID },
      }));
      assert.equal(replay.kind, 'replay');
      const client = await isolated.runtime.pool.connect();
      try {
        const sidecar = await client.query<{ n: number; status: string; suggestion_id: string | null }>(
          `select count(*)::int as n, min(status) as status, min(suggestion_id) as suggestion_id
           from collection_classify_inbox_decision where node_id = $1`,
          [BOOKMARK_ROOT],
        );
        assert.equal(sidecar.rows[0]?.n, 1);
        assert.equal(sidecar.rows[0]?.status, 'accepted');
        assert.equal(sidecar.rows[0]?.suggestion_id, FOLDER_ID);
        const node = await client.query<{ parent_id: string | null }>(
          'select parent_id from nodes where id = $1',
          [BOOKMARK_ROOT],
        );
        assert.equal(node.rows[0]?.parent_id, FOLDER_ID);
      } finally {
        client.release();
      }
      const page = await getMyClassifyInboxPage({
        reads: createPostgresClassifyInboxReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER } });
      assert.deepEqual(page.items.map((item) => item.nodeId), []);
    } finally {
      signer.destroy();
    }
  });

  test('stale If-Match leaves no sidecar and does not move the node', async () => {
    await resetOwnedLibrary();
    const accept = createPostgresClassifyInboxAcceptUnitOfWork(isolated.runtime.db);
    await assert.rejects(
      () => accept.execute((ports) => acceptClassifyInboxItem(ports, {
        actor: { principalId: OWNER_ACCOUNT, subjectId: OWNER },
        commandId: randomUUID(),
        nodeId: BOOKMARK_ROOT,
        ifMatch: '"stale-revision"',
        body: { suggestionId: FOLDER_ID },
      })),
    );
    const client = await isolated.runtime.pool.connect();
    try {
      const sidecar = await client.query<{ n: number }>(
        'select count(*)::int as n from collection_classify_inbox_decision where node_id = $1',
        [BOOKMARK_ROOT],
      );
      assert.equal(sidecar.rows[0]?.n, 0);
      const node = await client.query<{ parent_id: string | null }>(
        'select parent_id from nodes where id = $1',
        [BOOKMARK_ROOT],
      );
      assert.equal(node.rows[0]?.parent_id, ROOT_ID);
    } finally {
      client.release();
    }
  });
});
