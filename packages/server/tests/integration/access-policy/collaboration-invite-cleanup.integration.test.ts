/**
 * P-06 overdue invite worker: bounded expire, suppress unsent deliveries,
 * GET list does not UPDATE status.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Kysely, KyselyPlugin } from 'kysely';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import { expireOverdueInvitesBatch } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresCollaborationQueryPort } from '../../../src/infrastructure/access-policy/index.js';
import {
  COLLABORATION_MY_INVITES_LIST_LIMIT,
  COLLABORATION_PENDING_INVITES_LIST_LIMIT,
  listCollectionMembers,
  listMyCollaborationInvites,
} from '../../../src/modules/access-policy/index.js';
import { createTestCollaborationListCursors } from '../../support/collaboration-list-cursors.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-08-19T12:00:00.000Z');
const PAST = new Date('2026-08-01T00:00:00.000Z');
const FUTURE = new Date('2026-08-26T00:00:00.000Z');
const COLLECTION_ID = 'col-cleanup';
const ROOT_ID = 'root-cleanup';
const OWNER_SUBJECT = 'owner-cleanup';

describeWithPostgres('collaboration invite cleanup (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p06_invite_cleanup');
    const migrator = createMigrator(isolated.runtime.db, 'migrations', isolated.schema);
    const result = await migrator.migrateToLatest();
    if (result.error) throw result.error;
    await seedCollection(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('bounded expire marks overdue pending rows and suppresses unsent deliveries', async () => {
    await isolated.runtime.pool.query(
      `insert into collection_invites (
         id, collection_id, role, email_normalized, invited_by_subject_id, status, expires_at, created_at,
         collection_title_snapshot
       ) values
         ('inv-overdue-a', $1, 'editor', 'a@example.test', $2, 'pending', $3, $3, 'Cleanup'),
         ('inv-overdue-b', $1, 'viewer', 'b@example.test', $2, 'pending', $3, $3, 'Cleanup'),
         ('inv-live', $1, 'viewer', 'live@example.test', $2, 'pending', $4, $5, 'Cleanup')`,
      [COLLECTION_ID, OWNER_SUBJECT, PAST, FUTURE, NOW],
    );
    await isolated.runtime.pool.query(
      `insert into collection_invite_deliveries (
         delivery_id, invite_id, state, attempt_count, state_revision, next_attempt_at, created_at, updated_at
       ) values
         ('del-a', 'inv-overdue-a', 'pending', 0, 1, $1, $1, $1),
         ('del-live', 'inv-live', 'pending', 0, 1, $1, $1, $1)`,
      [NOW],
    );

    const first = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => (
      expireOverdueInvitesBatch(transaction, NOW, 1)
    ));
    assert.equal(first, 1);
    const afterFirst = await statuses(isolated, ['inv-overdue-a', 'inv-overdue-b', 'inv-live']);
    const expiredCount = afterFirst.filter((row) => row.status === 'expired').length;
    assert.equal(expiredCount, 1);
    assert.equal(afterFirst.find((row) => row.id === 'inv-live')?.status, 'pending');

    const second = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => (
      expireOverdueInvitesBatch(transaction, NOW, 10)
    ));
    assert.equal(second, 1);
    const afterSecond = await statuses(isolated, ['inv-overdue-a', 'inv-overdue-b', 'inv-live']);
    assert.equal(afterSecond.find((row) => row.id === 'inv-overdue-a')?.status, 'expired');
    assert.equal(afterSecond.find((row) => row.id === 'inv-overdue-b')?.status, 'expired');
    assert.equal(afterSecond.find((row) => row.id === 'inv-live')?.status, 'pending');

    const deliveries = await isolated.runtime.pool.query<{ invite_id: string; state: string }>(
      `select invite_id, state from collection_invite_deliveries where invite_id = any($1::text[])`,
      [['inv-overdue-a', 'inv-live']],
    );
    const byId = Object.fromEntries(deliveries.rows.map((row) => [row.invite_id, row.state]));
    assert.equal(byId['inv-overdue-a'], 'suppressed');
    assert.equal(byId['inv-live'], 'pending');
  });

  test('GET members list does not UPDATE overdue pending status', async () => {
    await isolated.runtime.pool.query(
      `insert into collection_invites (
         id, collection_id, role, email_normalized, invited_by_subject_id, status, expires_at, created_at,
         collection_title_snapshot
       ) values ('inv-get-ro', $1, 'viewer', 'get-ro@example.test', $2, 'pending', $3, $3, 'Cleanup')`,
      [COLLECTION_ID, OWNER_SUBJECT, PAST],
    );
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const query = createPostgresCollaborationQueryPort(transaction);
      await listCollectionMembers({
        facts: {
          async loadCollectionFacts() {
            return {
              collectionId: COLLECTION_ID,
              ownerSubjectId: OWNER_SUBJECT,
              visibility: 'private',
              policyRevision: 'policy-cleanup-1',
              membershipRole: 'owner',
              deleted: false,
            };
          },
        },
        query,
        cursors: createTestCollaborationListCursors().members,
      }, {
        actor: { principalId: 'p-owner', subjectId: OWNER_SUBJECT, kind: 'account' },
        collectionId: COLLECTION_ID,
        now: NOW,
      });
    });
    const row = await isolated.runtime.pool.query<{ status: string }>(
      `select status from collection_invites where id = 'inv-get-ro'`,
    );
    assert.equal(row.rows[0]?.status, 'pending');
  });

  test('hard LIMIT advertises hasMore instead of silently dropping the tail', async () => {
    await isolated.runtime.pool.query(
      `insert into collection_invites (
         id, collection_id, role, email_normalized, invited_by_subject_id, status, expires_at, created_at,
         collection_title_snapshot
       )
       select 'inv-cap-' || lpad(value::text, 3, '0'), $1, 'viewer',
              'cap-' || lpad(value::text, 3, '0') || '@example.test', $2, 'pending', $3, $3, 'Cleanup'
         from generate_series(1, $4) value`,
      [COLLECTION_ID, OWNER_SUBJECT, FUTURE, COLLABORATION_PENDING_INVITES_LIST_LIMIT + 1],
    );
    await seedInviteeCollections(isolated, COLLABORATION_MY_INVITES_LIST_LIMIT + 1);
    const cursors = createTestCollaborationListCursors();
    const membersPage = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => (
      listCollectionMembers({
        facts: {
          async loadCollectionFacts() {
            return {
              collectionId: COLLECTION_ID,
              ownerSubjectId: OWNER_SUBJECT,
              visibility: 'private',
              policyRevision: 'policy-cleanup-1',
              membershipRole: 'owner',
              deleted: false,
            };
          },
        },
        query: createPostgresCollaborationQueryPort(transaction),
        cursors: cursors.members,
      }, {
        actor: { principalId: 'p-owner', subjectId: OWNER_SUBJECT, kind: 'account' },
        collectionId: COLLECTION_ID,
        now: NOW,
      })
    ));
    assert.equal(membersPage.invites.length, COLLABORATION_PENDING_INVITES_LIST_LIMIT);
    assert.equal(membersPage.page.hasMore, true);
    assert.equal(typeof membersPage.page.nextCursor, 'string');
    const second = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => (
      listCollectionMembers({
        facts: {
          async loadCollectionFacts() {
            return {
              collectionId: COLLECTION_ID,
              ownerSubjectId: OWNER_SUBJECT,
              visibility: 'private',
              policyRevision: 'policy-cleanup-1',
              membershipRole: 'owner',
              deleted: false,
            };
          },
        },
        query: createPostgresCollaborationQueryPort(transaction),
        cursors: cursors.members,
      }, {
        actor: { principalId: 'p-owner', subjectId: OWNER_SUBJECT, kind: 'account' },
        collectionId: COLLECTION_ID,
        now: NOW,
        cursor: membersPage.page.nextCursor!,
      })
    ));
    const firstInviteIds = membersPage.invites.map((row) => row.inviteId);
    const secondInviteIds = second.invites.map((row) => row.inviteId);
    for (const id of secondInviteIds) {
      assert.equal(firstInviteIds.includes(id), false);
    }
    const capInviteIds = new Set(
      [...firstInviteIds, ...secondInviteIds].filter((id) => id.startsWith('inv-cap-')),
    );
    assert.equal(capInviteIds.size, COLLABORATION_PENDING_INVITES_LIST_LIMIT + 1);
    const mine = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => (
      listMyCollaborationInvites({
        query: createPostgresCollaborationQueryPort(transaction),
        cursors: cursors.myInvites,
      }, {
        actor: { subjectId: 'invitee-cap', email: 'invitee-cap@example.test' },
        now: NOW,
      })
    ));
    assert.equal(mine.items.length, COLLABORATION_MY_INVITES_LIST_LIMIT);
    assert.equal(mine.page.hasMore, true);
    assert.equal(typeof mine.page.nextCursor, 'string');
  });

  test('listMyPendingInvites compiles a bounded pending-email lookup', async () => {
    await isolated.runtime.pool.query(
      `insert into collection_invites (
         id, collection_id, role, email_normalized, invited_by_subject_id, status, expires_at, created_at,
         collection_title_snapshot
       )
       select 'inv-noise-' || lpad(value::text, 4, '0'),
              'col-cap-' || lpad((1 + ((value - 1) % $1))::text, 3, '0'),
              'viewer', 'noise-' || lpad(value::text, 4, '0') || '@example.test',
              $2, 'pending', $3, $3, 'Noise'
         from generate_series(1, 4000) value`,
      [COLLABORATION_MY_INVITES_LIST_LIMIT + 1, OWNER_SUBJECT, FUTURE],
    );
    const compiled = await compileListMyPendingInvites(
      isolated.runtime.db,
      { subjectId: 'invitee-cap', email: 'invitee-cap@example.test', now: NOW },
    );
    assert.match(compiled.sql, /collection_invites/i);
    assert.match(compiled.sql, /email_normalized/i);
    assert.match(compiled.sql, /limit/i);
    const indexes = await isolated.runtime.pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = current_schema()
          and indexname = 'collection_invites_pending_email_idx'`,
    );
    assert.equal(indexes.rows.length, 1);
    await isolated.runtime.pool.query('analyze collection_invites');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `explain (analyze, buffers, format text) ${compiled.sql}`,
        [...compiled.parameters],
      );
      await client.query('commit');
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.match(text, /collection_invites_pending_email_idx/i);
      assert.match(text, /actual time=/i);
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
});

async function statuses(
  runtime: IsolatedPostgresRuntime,
  ids: readonly string[],
): Promise<ReadonlyArray<{ id: string; status: string }>> {
  const result = await runtime.runtime.pool.query<{ id: string; status: string }>(
    `select id, status from collection_invites where id = any($1::text[]) order by id`,
    [ids],
  );
  return result.rows;
}

async function seedCollection(runtime: IsolatedPostgresRuntime): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values ($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
      [COLLECTION_ID, ROOT_ID],
    );
    await client.query(
      `insert into collections(
         id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
         root_node_id, root_node_is_root, resource_revision, content_revision, policy_revision,
         commit_ordinal, created_at, updated_at)
       values ($1,$2,'Cleanup fixture','bookmarks','private',null,null,
         $3,true,'r1','c1','policy-cleanup-1',1,current_timestamp,current_timestamp)`,
      [COLLECTION_ID, OWNER_SUBJECT, ROOT_ID],
    );
    await client.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at)
       values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',current_timestamp,current_timestamp)`,
      [ROOT_ID, COLLECTION_ID],
    );
    await client.query(
      `insert into collection_members(collection_id, subject_id, role, granted_at)
       values ($1,$2,'owner',current_timestamp)`,
      [COLLECTION_ID, OWNER_SUBJECT],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedInviteeCollections(
  runtime: IsolatedPostgresRuntime,
  count: number,
): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       select 'col-cap-' || lpad(value::text, 3, '0'), 'collection', current_timestamp
         from generate_series(1, $1) value
       union all
       select 'root-cap-' || lpad(value::text, 3, '0'), 'node', current_timestamp
         from generate_series(1, $1) value`,
      [count],
    );
    await client.query(
      `insert into collections(
         id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
         root_node_id, root_node_is_root, resource_revision, content_revision, policy_revision,
         commit_ordinal, created_at, updated_at)
       select 'col-cap-' || lpad(value::text, 3, '0'), $1, 'Cap ' || value, 'bookmarks', 'private',
              null, null, 'root-cap-' || lpad(value::text, 3, '0'), true, 'r1', 'c1', 'policy-cap',
              1, current_timestamp, current_timestamp
         from generate_series(1, $2) value`,
      [OWNER_SUBJECT, count],
    );
    await client.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at)
       select 'root-cap-' || lpad(value::text, 3, '0'), 'col-cap-' || lpad(value::text, 3, '0'),
              null, 'folder', true, 'Root', null, null, 'r1', 'ch1', current_timestamp, current_timestamp
         from generate_series(1, $1) value`,
      [count],
    );
    await client.query(
      `insert into collection_invites (
         id, collection_id, role, email_normalized, invited_by_subject_id, status, expires_at, created_at,
         collection_title_snapshot
       )
       select 'inv-mine-' || lpad(value::text, 3, '0'),
              'col-cap-' || lpad(value::text, 3, '0'),
              'viewer', 'invitee-cap@example.test', $1, 'pending', $2, $2, 'Cap'
         from generate_series(1, $3) value`,
      [OWNER_SUBJECT, FUTURE, count],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function compileListMyPendingInvites(
  db: Kysely<DatabaseSchema>,
  input: { readonly subjectId: string; readonly email: string; readonly now: Date },
): Promise<{ sql: string; parameters: readonly unknown[] }> {
  const executor = db.getExecutor();
  let compiled: { sql: string; parameters: readonly unknown[] } | undefined;
  const capturing = db.withPlugin({
    transformQuery(args) {
      const next = executor.compileQuery(args.node, args.queryId);
      if (next.sql.includes('collection_invites')) compiled = next;
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  } satisfies KyselyPlugin);
  await createPostgresCollaborationQueryPort(capturing as never).listMyPendingInvites({
    ...input,
    limit: COLLABORATION_MY_INVITES_LIST_LIMIT,
  });
  assert.ok(compiled, 'expected listMyPendingInvites SELECT compilation');
  return compiled;
}
