/**
 * SEC-M-04 / T-C5: editor GET FOR SHARE serializes behind collection FOR UPDATE.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresCollectionWritePort,
  createPostgresIdLedgerPort,
  createPostgresNodeWritePort,
} from '../../../src/infrastructure/collections/index.js';
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
    });
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
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
});
