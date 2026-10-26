/**
 * SEC-M-04 / T-C5: editor GET FOR SHARE serializes behind collection FOR UPDATE.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresCollectionWritePort,
  createPostgresBookmarkIconWritePort,
  createPostgresCollectionsEditorReadUnitOfWork,
  createPostgresIdLedgerPort,
  createPostgresNodeWritePort,
} from '../../../src/infrastructure/collections/index.js';
import { createProductEditorCursorSigner, getCollectionEditorPage, getCollectionEditorReadRevision, linkPreviewTargetIdentity } from '../../../src/modules/collections/index.js';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import {
  createUnitOfWork,
  runMigrations,
  type DatabaseRuntime,
} from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const COLLECTION_ID = 'col-editor-lock-share-01';
const ROOT_ID = 'root-editor-lock-share-01';
const BOOKMARK_ID = 'bookmark-editor-lock-share-01';
const OWNER_SUBJECT = 'subject-editor-lock-share';

describeWithPostgres('editor GET lockForShare serializes with lockForUpdate', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('editor_lock_share', {
      maxConnections: 6,
      applicationName: 'known-editor-lock-share-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    const setup = createUnitOfWork(runtime.db);
    const now = new Date('2026-07-22T12:00:00.000Z');
    await setup.execute(async ({ transaction }) => {
      const ledger = createPostgresIdLedgerPort(transaction);
      const collections = createPostgresCollectionWritePort(transaction);
      const nodes = createPostgresNodeWritePort(transaction);
      await ledger.reserve([
        { resourceId: COLLECTION_ID, resourceType: 'collection' },
        { resourceId: ROOT_ID, resourceType: 'node' },
        { resourceId: BOOKMARK_ID, resourceType: 'node' },
      ]);
      await collections.insertBootstrap({
        id: COLLECTION_ID,
        ownerSubjectId: OWNER_SUBJECT,
        title: 'Editor lock share',
        summary: null,
        kind: 'bookmarks',
        visibility: 'private',
        rootNodeId: ROOT_ID,
        resourceRevision: 'resource-1',
        contentRevision: 'content-1',
        policyRevision: 'policy-1',
        commitOrdinal: 1n,
        createdAt: now,
        updatedAt: now,
      });
      await nodes.insertRoot({
        id: ROOT_ID,
        collectionId: COLLECTION_ID,
        title: 'Editor lock share',
        resourceRevision: 'root-resource-1',
        childrenRevision: 'root-children-1',
        createdAt: now,
        updatedAt: now,
      });
      await nodes.insertNode({
        id: BOOKMARK_ID, collectionId: COLLECTION_ID, parentId: ROOT_ID, kind: 'bookmark',
        title: 'Example', url: 'https://example.com/', description: null, tags: [], visibility: 'inherit',
        positionToken: 'a', resourceRevision: 'bookmark-1', childrenRevision: 'children-1', createdAt: now, updatedAt: now,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('read revisions detect worker image updates without a canonical content revision change', async () => {
    const readUnit = createPostgresCollectionsEditorReadUnitOfWork(runtime.db, {
      cursorSigner: createProductEditorCursorSigner({ current: { id: 'revision-test', key: 'editor-read-revision-test' } }),
      productOrigin: 'https://app.example.test', linkPreviews: true,
    });
    const input = { collectionId: COLLECTION_ID, actor: { principalId: 'principal-editor', subjectId: OWNER_SUBJECT } };
    const revision = () => readUnit.execute(ports => getCollectionEditorReadRevision(ports, input));
    const first = await readUnit.execute(ports => getCollectionEditorPage(ports, input));
    assert.equal(first.readRevision, await revision());
    const target = linkPreviewTargetIdentity('https://example.com/')!;
    await sql`INSERT INTO link_preview_targets (url_key, normalized_url, site, status, object_id, width, height, mime, digest)
      VALUES (${target.urlKey}, ${target.normalizedUrl}, ${target.site}, 'ready',
        '01234567-89ab-4cde-8f01-23456789abcd'::uuid, 1200, 630, 'image/png', 'preview-digest')`.execute(runtime.db);
    const withPreview = await revision();
    assert.notEqual(withPreview, first.readRevision);
    const page = await readUnit.execute(ports => getCollectionEditorPage(ports, input));
    assert.equal(page.readRevision, withPreview);
    assert.equal(page.collection.contentRevision, first.collection.contentRevision);
    assert.ok(page.nodes.some(node => node.kind === 'bookmark' && node.previewImage));
    await sql`INSERT INTO bookmark_preview_prefs (node_id, collection_id, mode)
      VALUES (${BOOKMARK_ID}, ${COLLECTION_ID}, 'none')`.execute(runtime.db);
    assert.equal(await revision(), first.readRevision, 'an owner veto removes the preview from the read projection');
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      await createPostgresBookmarkIconWritePort(transaction).upsert({
        nodeId: BOOKMARK_ID, collectionId: COLLECTION_ID, objectId: '01234567-89ab-4cde-8f01-23456789abce',
        contentType: 'image/png', byteSize: 8, digestSha256: Buffer.alloc(32, 1), createdAt: new Date(), updatedAt: new Date(),
      });
    });
    assert.notEqual(await revision(), first.readRevision, 'a favicon binding also invalidates the read projection');
  });

  test('lockForShare waits until a concurrent lockForUpdate commits', async () => {
    const unitOfWork = createUnitOfWork(runtime.db, { isolationLevel: 'repeatable read' });
    let releaseWriter!: () => void;
    const writerMayFinish = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writerLocked!: () => void;
    const writerHoldsLock = new Promise<void>((resolve) => {
      writerLocked = resolve;
    });

    const writer = unitOfWork.execute(async ({ transaction }) => {
      const collections = createPostgresCollectionWritePort(transaction);
      const locked = await collections.lockForUpdate(COLLECTION_ID);
      assert.ok(locked);
      writerLocked();
      await writerMayFinish;
      return locked.id;
    });

    await writerHoldsLock;

    let shareCompleted = false;
    const reader = unitOfWork.execute(async ({ transaction }) => {
      const collections = createPostgresCollectionWritePort(transaction);
      const locked = await collections.lockForShare(COLLECTION_ID);
      shareCompleted = true;
      return locked;
    });

    await waitForCondition(async () => {
      const result = await runtime.pool.query<{ waiting: boolean }>(`
        select exists(
          select 1 from pg_stat_activity
          where datname=current_database()
            and application_name='known-editor-lock-share-test'
            and cardinality(pg_blocking_pids(pid)) > 0
        ) waiting
      `);
      return result.rows[0]?.waiting === true;
    }, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      description: 'the FOR SHARE reader to wait behind the FOR UPDATE writer',
    });
    assert.equal(shareCompleted, false, 'FOR SHARE must wait on FOR UPDATE');

    releaseWriter();
    await writer;
    const shared = await reader;
    assert.ok(shared);
    assert.equal(shared.id, COLLECTION_ID);
    assert.equal(shared.policyRevision, 'policy-1');
  });

  test('editor page retries with a fresh snapshot when sync updates the locked collection', async () => {
    let releaseWriter!: () => void;
    const writerMayFinish = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let writerLocked!: () => void;
    const writerHoldsLock = new Promise<void>((resolve) => { writerLocked = resolve; });
    const writer = createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      await createPostgresCollectionWritePort(transaction).lockForUpdate(COLLECTION_ID);
      await transaction.updateTable('collections').set({
        content_revision: 'content-after-sync',
        payload_json: sql`jsonb_set(payload_json, '{contentRevision}', to_jsonb('content-after-sync'::text))`,
      }).where('id', '=', COLLECTION_ID).execute();
      writerLocked();
      await writerMayFinish;
    });
    let attempts = 0;
    const readUnit = createPostgresCollectionsEditorReadUnitOfWork(runtime.db, {
      cursorSigner: createProductEditorCursorSigner({ current: { id: 'retry-test', key: 'editor-retry-test-key' } }),
      faultInjector: { beforeCallback: () => { attempts += 1; } },
    });
    await writerHoldsLock;
    const reader = readUnit.execute((ports) => getCollectionEditorPage(ports, {
      collectionId: COLLECTION_ID,
      actor: { principalId: 'principal-editor-lock-share', subjectId: OWNER_SUBJECT },
      limit: 10,
    }));
    // Keep a deliberately failing pre-fix reader from becoming an unhandled rejection.
    void reader.catch(() => undefined);
    try {
      await waitForCondition(async () => {
        const result = await runtime.pool.query<{ waiting: boolean }>(`
          select exists(
            select 1 from pg_stat_activity
            where datname=current_database()
              and application_name='known-editor-lock-share-test'
              and cardinality(pg_blocking_pids(pid)) > 0
          ) waiting
        `);
        return result.rows[0]?.waiting === true;
      }, { timeoutMs: 2_000, pollIntervalMs: 5, description: 'editor page to wait behind sync update' });
      releaseWriter();
      await writer;
      const page = await reader;
      assert.equal(attempts, 2, 'the aborted read must restart in a new transaction');
      assert.equal(page.page.contentRevision, 'content-after-sync');
      assert.equal(page.collection.id, COLLECTION_ID);
    } finally {
      releaseWriter();
      await Promise.allSettled([writer, reader]);
    }
  });

  test('persistent editor transaction conflicts stop after three attempts', async () => {
    let attempts = 0;
    const unit = createPostgresCollectionsEditorReadUnitOfWork(runtime.db, {
      cursorSigner: createProductEditorCursorSigner({ current: { id: 'retry-test', key: 'editor-retry-test-key' } }),
      faultInjector: { beforeCallback: () => {
        attempts += 1;
        throw Object.assign(new Error('serialization conflict'), { code: '40001' });
      } },
    });
    await assert.rejects(unit.execute(async () => assert.fail('conflicting transaction must abort')),
      (error: unknown) => error instanceof DatabaseOperationError && error.kind === 'serialization_failure');
    assert.equal(attempts, 3);
  });

  test('editor authorization errors are not retried', async () => {
    let attempts = 0;
    const unit = createPostgresCollectionsEditorReadUnitOfWork(runtime.db, {
      cursorSigner: createProductEditorCursorSigner({ current: { id: 'retry-test', key: 'editor-retry-test-key' } }),
      faultInjector: { beforeCallback: () => { attempts += 1; } },
    });
    await assert.rejects(unit.execute((ports) => getCollectionEditorPage(ports, {
      collectionId: COLLECTION_ID,
      actor: { principalId: 'stranger-principal', subjectId: 'stranger-subject' },
    })), { name: 'EditorAuthorizationError' });
    assert.equal(attempts, 1);
  });
});
