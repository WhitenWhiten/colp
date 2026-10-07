/**
 * LP-05: the link preview command unit of work against PostgreSQL — real
 * access facts, receipts, bookmark loading, the mode CAS and the enqueue.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresLinkPreviewCommandUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  getBookmarkPreviewMode,
  linkPreviewTargetIdentity,
  requestCollectionLinkPreviews,
  setBookmarkPreviewMode,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const OWNER = 'lp05-owner';
const VIEWER = 'lp05-viewer';
const COLLECTION = 'lp05col01lp05col01lp05';
const OTHER = 'lp05col02lp05col02lp05';
const ORIGIN = 'https://known.example';
const owner = { principalId: 'lp05-owner-account', subjectId: OWNER };
const viewer = { principalId: 'lp05-viewer-account', subjectId: VIEWER };

describeWithPostgres('LP-05 link preview commands on PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('lp05_link_preview_commands', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seed(isolated);
  }, 180_000);
  afterAll(async () => isolated?.close());

  const unit = () => createPostgresLinkPreviewCommandUnitOfWork(isolated.runtime.db, { productOrigin: ORIGIN });
  const targets = async () => (await isolated.runtime.pool.query('SELECT normalized_url FROM link_preview_targets ORDER BY 1')).rows
    .map((row) => row.normalized_url);

  test('a request enqueues only live, visible-to-the-owner bookmarks of this collection', async () => {
    const outcome = await unit().execute((ports) => requestCollectionLinkPreviews(ports, {
      actor: owner, commandId: randomUUID(), collectionId: COLLECTION,
      nodeIds: ['lp05-a', 'lp05-deleted', 'lp05-folder', 'lp05-foreign', 'lp05-hidden', 'lp05-missing'],
    }));
    assert.deepEqual(outcome, { kind: 'succeeded', enqueued: 1 });
    assert.deepEqual(await targets(), ['https://a.example.com/x']);
  });

  test('viewers are denied and outsiders concealed by the real access facts', async () => {
    await assert.rejects(
      unit().execute((ports) => getBookmarkPreviewMode(ports, { actor: viewer, collectionId: COLLECTION, nodeId: 'lp05-a' })),
      (error: unknown) => error instanceof CollectionAuthorizationError && error.outcome === 'deny',
    );
    await assert.rejects(
      unit().execute((ports) => getBookmarkPreviewMode(ports, { actor: viewer, collectionId: OTHER, nodeId: 'lp05-foreign' })),
      (error: unknown) => error instanceof CollectionAuthorizationError && error.outcome === 'conceal',
    );
  });

  test('the mode CAS inserts at revision 2, rejects stale tags and advances by one', async () => {
    const set = (mode: 'auto' | 'none', etag: string) => unit().execute((ports) => setBookmarkPreviewMode(ports, {
      actor: owner, commandId: randomUUID(), collectionId: COLLECTION, nodeId: 'lp05-b', mode, expectedEtag: etag,
    }));
    const initial = await unit().execute((ports) => getBookmarkPreviewMode(ports, { actor: owner, collectionId: COLLECTION, nodeId: 'lp05-b' }));
    assert.equal(initial.etag, '"preview-mode:1"');
    const hidden = await set('none', '"preview-mode:1"');
    assert.equal(hidden.kind, 'succeeded');
    assert.equal(hidden.kind === 'succeeded' && hidden.view.etag, '"preview-mode:2"');
    await assert.rejects(set('auto', '"preview-mode:1"'), (error: unknown) =>
      error instanceof CollectionPreconditionError && error.currentEtag === '"preview-mode:2"');
    const restored = await set('auto', '"preview-mode:2"');
    assert.equal(restored.kind === 'succeeded' && restored.view.etag, '"preview-mode:3"');
    const stored = await isolated.runtime.pool.query('SELECT mode, revision FROM bookmark_preview_prefs WHERE node_id = $1', ['lp05-b']);
    assert.deepEqual(stored.rows[0], { mode: 'auto', revision: '3' });
  });

  test('the view reports the cached image unless the bookmark is hidden', async () => {
    const identity = linkPreviewTargetIdentity('https://a.example.com/x')!;
    const objectId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    await isolated.runtime.pool.query(`
      UPDATE link_preview_targets SET status = 'ready', object_id = $2, width = 640, height = 320, mime = 'image/png',
        digest = 'd', source = 'og' WHERE url_key = $1
    `, [identity.urlKey, objectId]);
    const view = await unit().execute((ports) => getBookmarkPreviewMode(ports, { actor: owner, collectionId: COLLECTION, nodeId: 'lp05-a' }));
    assert.deepEqual(view.previewImage, { url: `${ORIGIN}/api/v1/link-preview/${objectId}`, width: 640, height: 320 });
    const hidden = await unit().execute((ports) => getBookmarkPreviewMode(ports, { actor: owner, collectionId: COLLECTION, nodeId: 'lp05-hidden' }));
    assert.equal(hidden.mode, 'none');
    assert.equal(hidden.previewImage, null);
  });
});

async function seed(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`insert into accounts(id, subject_id) values ('lp05-owner-account', $1), ('lp05-viewer-account', $2)`, [OWNER, VIEWER]);
    const nodes: ReadonlyArray<readonly [string, string, string | null, 'folder' | 'bookmark', string | null, boolean]> = [
      ['lp05-root', COLLECTION, null, 'folder', null, false],
      ['lp05-folder', COLLECTION, 'lp05-root', 'folder', null, false],
      ['lp05-a', COLLECTION, 'lp05-root', 'bookmark', 'https://a.example.com/x', false],
      ['lp05-b', COLLECTION, 'lp05-root', 'bookmark', 'https://b.example.com/y', false],
      ['lp05-hidden', COLLECTION, 'lp05-root', 'bookmark', 'https://hidden.example.com/', false],
      ['lp05-deleted', COLLECTION, 'lp05-root', 'bookmark', 'https://deleted.example.com/', true],
      ['lp05-root-2', OTHER, null, 'folder', null, false],
      ['lp05-foreign', OTHER, 'lp05-root-2', 'bookmark', 'https://foreign.example.com/', false],
    ];
    await client.query(`insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'collection')`, [COLLECTION, OTHER]);
    await client.query(`insert into resource_id_ledger(resource_id, resource_type) select unnest($1::text[]), 'node'`, [nodes.map(([id]) => id)]);
    await client.query(`
      insert into collections (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision, content_revision, policy_revision)
      values ($1, $3, 'Mine', 'bookmarks', 'private', 'lp05-root', 'r1', 'c1', 'p1'),
             ($2, 'someone-else', 'Theirs', 'bookmarks', 'private', 'lp05-root-2', 'r1', 'c1', 'p1')
    `, [COLLECTION, OTHER, OWNER]);
    for (const [index, [id, collection, parent, kind, url, deleted]] of nodes.entries()) {
      await client.query(`
        insert into nodes (id, collection_id, parent_id, kind, is_root, title, url, visibility, position_token,
          resource_revision, children_revision, deleted_at)
        values ($1, $2, $3, $4, $5, $1, $6, 'inherit', $7, 'r1', 'ch1', $8)
      `, [id, collection, parent, kind, parent === null, url, parent === null ? null : String(index).padStart(12, '0'), deleted ? new Date() : null]);
    }
    await client.query(`insert into collection_members (collection_id, subject_id, role) values ($1, $2, 'viewer')`, [COLLECTION, VIEWER]);
    await client.query(`insert into bookmark_preview_prefs (node_id, collection_id, mode, revision) values ('lp05-hidden', $1, 'none', 2)`, [COLLECTION]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
