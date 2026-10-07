import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresOrganizePlanMutationUnitOfWork,
  createPostgresOrganizePlanReadPort,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createCollectionOrganizePlan,
  createOrganizePlanner,
  getCollectionOrganizePlan,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-08-23T08:00:00.000Z');
const OWNER = 'ogp-owner-subject';
const PRINCIPAL = 'ogp-owner-account';
const COL = 'ogp-col-a';
const ROOT = 'ogp-root-a';
const UNSORTED = 'ogp-unsorted';
const ARCHIVES = 'ogp-archives';
const BM_INBOX_A = 'ogp-bm-inbox-a';
const BM_INBOX_B = 'ogp-bm-inbox-b';
const BM_ROOT = 'ogp-bm-root';
const BM_ARCH = 'ogp-bm-arch';

describeWithPostgres('OG-01 PostgreSQL organize plans', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('og01_organize_plans', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  async function resetLibrary(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, collection_organize_plans, collection_invites,
          collection_members, nodes, collections, resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $2, 'active', 0)`,
        [PRINCIPAL, OWNER],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'Organize owner', null)`,
        [PRINCIPAL],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'),
         ($2, 'node'), ($3, 'node'), ($4, 'node'),
         ($5, 'node'), ($6, 'node'), ($7, 'node'), ($8, 'node')`,
        [COL, ROOT, UNSORTED, ARCHIVES, BM_INBOX_A, BM_INBOX_B, BM_ROOT, BM_ARCH],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal, deleted_at
         ) values
         ($1, $2, 'Organize library', null, 'bookmarks', 'private', $3, 'a-r1', 'a-c1', 'a-p1', 1, null)`,
        [COL, OWNER, ROOT],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision, created_at, deleted_at
         ) values
         ($1, $8, null, 'folder', true, 'Root', null, null, '[]'::jsonb, 'inherit', null, 'r-r1', 'r-cr1', $9, null),
         ($2, $8, $1, 'folder', false, 'Unsorted', null, null, '[]'::jsonb, 'inherit', 'A', 'u-r1', 'u-cr1', $9, null),
         ($3, $8, $1, 'folder', false, 'Archives', null, null, '[]'::jsonb, 'inherit', 'B', 's-r1', 's-cr1', $9, null),
         ($4, $8, $2, 'bookmark', false, 'Repo A', 'https://github.com/acme/a', null, '[]'::jsonb,
          'inherit', 'A', 'ba-r1', 'ba-cr1', $9, null),
         ($5, $8, $2, 'bookmark', false, 'Repo B', 'https://github.com/acme/b', null, '[]'::jsonb,
          'inherit', 'B', 'bb-r1', 'bb-cr1', $9, null),
         ($6, $8, $1, 'bookmark', false, 'Root tab', 'https://github.com/acme/root', null, '[]'::jsonb,
          'inherit', 'C', 'br-r1', 'br-cr1', $9, null),
         ($7, $8, $3, 'bookmark', false, 'Archived', 'https://github.com/acme/arch', null, '[]'::jsonb,
          'inherit', 'D', 'bs-r1', 'bs-cr1', $9, null)`,
        [ROOT, UNSORTED, ARCHIVES, BM_INBOX_A, BM_INBOX_B, BM_ROOT, BM_ARCH, COL, NOW],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  test('create and get roundtrip keeps Unsorted bookmarks and excludes root bookmarks', async () => {
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
    const nodeIds = created.plan.actions.flatMap((action) => action.nodeIds);
    assert.equal(nodeIds.includes(BM_INBOX_A), true);
    assert.equal(nodeIds.includes(BM_INBOX_B), true);
    assert.equal(nodeIds.includes(BM_ROOT), false);
    const reads = createPostgresOrganizePlanReadPort(isolated.runtime.db);
    const fetched = await getCollectionOrganizePlan(reads, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      collectionId: COL,
      planId: created.plan.planId,
    }, { now: () => NOW });
    assert.ok(fetched);
    assert.equal(fetched?.planId, created.plan.planId);
    assert.equal(fetched?.etag, created.plan.etag);
    assert.equal(fetched?.collectionRevision, 'a-c1');
    assert.equal(fetched?.plannerId, 'heuristic.v1.host_cluster');
  });
});
