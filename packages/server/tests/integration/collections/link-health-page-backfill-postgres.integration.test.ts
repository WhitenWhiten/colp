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

describeWithPostgres('LH-01 PostgreSQL link-health backfill onto existing nodes', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('lh01_link_health', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('backfill inserts pending rows for live bookmarks when expanding onto existing nodes', async () => {
    const upgrade = await createIsolatedPostgresRuntime('lh01_link_health_backfill');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo('202609160100_social_public_activity');
      if (previous.error) throw previous.error;
      const client = await upgrade.runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query('set constraints all deferred');
        await client.query(
          `insert into accounts(id, subject_id, status, security_epoch)
           values ('bf-account', 'bf-subject', 'active', 0)`,
        );
        await client.query(
          `insert into profiles(account_id, display_name) values ('bf-account', 'Backfill')`,
        );
        await client.query(
          `insert into resource_id_ledger(resource_id, resource_type)
           values ('bf-collection', 'collection'), ('bf-root', 'node'), ('bf-node', 'node')`,
        );
        await client.query(
          `insert into collections (
             id, owner_subject_id, title, kind, visibility, root_node_id,
             resource_revision, content_revision, policy_revision, commit_ordinal
           ) values ('bf-collection', 'bf-subject', 'Backfill', 'bookmarks', 'private', 'bf-root', 'r', 'c', 'p', 1)`,
        );
        await client.query(
          `insert into nodes (
             id, collection_id, parent_id, kind, is_root, title, url, tags, visibility,
             position_token, resource_revision, children_revision
           ) values
           ('bf-root', 'bf-collection', null, 'folder', true, 'Root', null, '[]'::jsonb, 'inherit', null, 'r', 'c'),
           ('bf-node', 'bf-collection', 'bf-root', 'bookmark', false, 'Live', 'https://example.com/live', '[]'::jsonb, 'inherit', 'A', 'r', 'c')`,
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      assert.equal((await upgrade.runtime.pool.query(
        `select to_regclass(current_schema() || '.collection_link_health') is not null present`,
      )).rows[0]?.present, false);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const row = await upgrade.runtime.pool.query<{ status: string }>(
        'select status from collection_link_health where node_id = $1',
        ['bf-node'],
      );
      assert.equal(row.rows[0]?.status, 'pending');
    } finally {
      await upgrade.close();
    }
  }, 180_000);

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

});
