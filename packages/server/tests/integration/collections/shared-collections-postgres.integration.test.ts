import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { Kysely, KyselyPlugin } from 'kysely';
import { createPostgresOwnedCollectionsReadPort, createPostgresSharedCollectionsReadPort, createPostgresCollectionBookmarkCountReadPort } from '../../../src/infrastructure/collections/index.js';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import {
  bookmarkCountFor,
  createProductOwnedCollectionsCursorSigner,
  createProductSharedCollectionsCursorSigner,
  getOwnedCollectionsPage,
  getSharedCollectionsPage,
  SharedCollectionsCursorError,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const MEMBER = 'subject-member-sc03';
const OTHER = 'subject-other-sc03';
const VIEWER = 'subject-viewer-sc03';
const COUNT_MEMBER = 'subject-count-member-sc03';
const OWNER = 'subject-owner-sc03';
const OTHER_OWNER = 'subject-owner-b-sc03';
const SHARED_LIST_INDEX = 'collection_members_shared_list_idx';
const SHARED_LIST_UPDATED_INDEX = 'collection_members_shared_list_updated_idx';
const NOW = new Date('2026-08-19T01:00:00.000Z');

describeWithPostgres('SC-03 PostgreSQL shared Collections query evidence', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sc03_shared_collections', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedFixtures(isolated);
  }, 180_000);
  afterAll(async () => isolated?.close());

  test('production migrations install collection_members_shared_list_idx', async () => {
    const indexes = await isolated.runtime.pool.query<{ indexdef: string }>(`
      select indexdef from pg_indexes
       where schemaname=current_schema() and indexname=$1`, [SHARED_LIST_INDEX]);
    assert.equal(indexes.rows.length, 1);
    assert.match(indexes.rows[0]!.indexdef, /collection_members/i);
    assert.match(indexes.rows[0]!.indexdef, /subject_id, collection_id/i);
    assert.match(indexes.rows[0]!.indexdef, /role.*editor.*viewer|role.*IN \('editor', 'viewer'\)/i);
    const updated = await isolated.runtime.pool.query<{ indexdef: string }>(`
      select indexdef from pg_indexes
       where schemaname=current_schema() and indexname=$1`, [SHARED_LIST_UPDATED_INDEX]);
    assert.equal(updated.rows.length, 1);
    assert.match(updated.rows[0]!.indexdef, /collection_updated_at/i);
    assert.match(updated.rows[0]!.indexdef, /COLLATE "C"/i);
  });

  test('cross-subject isolation: a member does not see another subject\'s shares or owned rows', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const memberRows = await unit.execute(({ transaction }) =>
      createPostgresSharedCollectionsReadPort(transaction)
        .listSharedCollections({ memberSubjectId: MEMBER, limit: 100 }));
    const otherRows = await unit.execute(({ transaction }) =>
      createPostgresSharedCollectionsReadPort(transaction)
        .listSharedCollections({ memberSubjectId: OTHER, limit: 100 }));
    assert.equal(memberRows.some((row) => row.id === 'other-only'), false);
    assert.equal(memberRows.some((row) => row.id === 'owned-by-member'), false);
    assert.equal(memberRows.some((row) => row.id === 'deleted-shared'), false);
    assert.equal(memberRows.some((row) => row.id === 'pending-only'), false);
    assert.equal(memberRows.some((row) => row.id === 'revoked-only'), false);
    assert.ok(memberRows.some((row) => row.id === 'shared-live'));
    assert.ok(otherRows.some((row) => row.id === 'other-only'));
    assert.equal(otherRows.some((row) => row.id === 'shared-live'), false);
    assert.ok(memberRows.every((row) => row.ownerSubjectId !== MEMBER));
    assert.ok(memberRows.every((row) => row.membershipRole === 'editor' || row.membershipRole === 'viewer'));
  });

  test('C-11 owned list omits collections the actor only belongs to as a member', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const owned = await unit.execute(({ transaction }) =>
      createPostgresOwnedCollectionsReadPort(transaction)
        .listOwnedCollections({ ownerSubjectId: MEMBER, limit: 100 }));
    const shared = await unit.execute(({ transaction }) =>
      createPostgresSharedCollectionsReadPort(transaction)
        .listSharedCollections({ memberSubjectId: MEMBER, limit: 100 }));
    assert.ok(owned.some((row) => row.id === 'owned-by-member'));
    assert.equal(owned.some((row) => row.id === 'shared-live'), false);
    assert.ok(shared.some((row) => row.id === 'shared-live'));
    assert.equal(shared.some((row) => row.id === 'owned-by-member'), false);
  });

  test('pages 30 then 1 across 31 live shared rows with hasMore and nextCursor', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const cursors = createProductSharedCollectionsCursorSigner({
      current: { id: 'sc03-v1', key: 'sc03-shared-collections-test-secret-material' },
    });
    const clock = { now: async () => NOW };
    const readPage = (input: { actor: { subjectId: string }; limit?: number; cursor?: string }) =>
      unit.execute(({ transaction }) => getSharedCollectionsPage({
        reads: createPostgresSharedCollectionsReadPort(transaction), cursors, clock,
      }, input));

    const first = await readPage({ actor: { subjectId: MEMBER }, limit: 30 });
    assert.equal(first.items.length, 30);
    assert.equal(first.page.returnedCount, 30);
    assert.equal(first.page.hasMore, true);
    assert.ok(first.page.nextCursor);
    const second = await readPage({ actor: { subjectId: MEMBER }, cursor: first.page.nextCursor! });
    assert.equal(second.items.length, 1);
    assert.equal(second.page.hasMore, false);
    assert.equal(second.page.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map((row) => row.id)).size, 31);
  });

  test('timestamp ties are broken by id COLLATE C ascending', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const rows = await unit.execute(({ transaction }) =>
      createPostgresSharedCollectionsReadPort(transaction)
        .listSharedCollections({ memberSubjectId: 'subject-tie-sc03', limit: 10 }));
    assert.deepEqual(rows.map((row) => row.id), ['tie-a', 'tie-b', 'tie-c']);
  });

  test('replaying an owned cursor on the shared query is invalid_cursor', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const keys = { current: { id: 'sc03-cross', key: 'sc03-shared-owned-same-key-material' } };
    const ownedSigner = createProductOwnedCollectionsCursorSigner(keys);
    const sharedSigner = createProductSharedCollectionsCursorSigner(keys);
    const clock = { now: async () => NOW };
    const owned = await unit.execute(({ transaction }) => getOwnedCollectionsPage({
      reads: {
        async listOwnedCollections() {
          return [
            {
              id: 'owned-by-member', kind: 'bookmarks', title: 'Mine', summary: null, visibility: 'private',
              publicationSlug: null, allowSearchIndexing: false, publishedAt: null,
              rootNodeId: 'root-owned-by-member', resourceRevision: 'r', contentRevision: 'c',
              policyRevision: 'p', createdAt: NOW, updatedAt: new Date('2026-08-18T12:00:00.000Z'),
            },
            {
              id: 'owned-by-member-2', kind: 'bookmarks', title: 'Mine 2', summary: null, visibility: 'private',
              publicationSlug: null, allowSearchIndexing: false, publishedAt: null,
              rootNodeId: 'root-owned-by-member-2', resourceRevision: 'r', contentRevision: 'c',
              policyRevision: 'p', createdAt: NOW, updatedAt: new Date('2026-08-18T11:00:00.000Z'),
            },
          ];
        },
      },
      cursors: ownedSigner, clock,
    }, { actor: { subjectId: MEMBER }, limit: 1 }));
    await assert.rejects(
      () => unit.execute(({ transaction }) => getSharedCollectionsPage({
        reads: createPostgresSharedCollectionsReadPort(transaction),
        cursors: sharedSigner,
        clock,
      }, { actor: { subjectId: MEMBER }, cursor: owned.page.nextCursor! })),
      SharedCollectionsCursorError,
    );
  });

  test('two identical first-page reads return the same item ids and nextCursor', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const cursors = createProductSharedCollectionsCursorSigner({
      current: { id: 'sc03-v1', key: 'sc03-shared-collections-test-secret-material' },
    });
    const clock = { now: async () => NOW };
    const readPage = () => unit.execute(({ transaction }) => getSharedCollectionsPage({
      reads: createPostgresSharedCollectionsReadPort(transaction), cursors, clock,
    }, { actor: { subjectId: MEMBER }, limit: 30 }));
    const first = await readPage();
    const second = await readPage();
    assert.equal(first.page.hasMore, true);
    assert.deepEqual(first.items.map((row) => row.id), second.items.map((row) => row.id));
    assert.equal(first.page.nextCursor, second.page.nextCursor);
  });

  test('EXPLAIN uses collection_members_shared_list_updated_idx without sorting memberships', async () => {
    await isolated.runtime.pool.query('analyze collection_members');
    await isolated.runtime.pool.query('analyze collections');
    const compiled = await compileSharedListQuery(isolated.runtime.db, 'subject-explain-sc03', 30);
    assert.match(compiled.sql, /collection_updated_at/i);
    assert.match(compiled.sql, /limit/i);
    const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': string }>(
      `explain (analyze, buffers, format text) ${compiled.sql}`,
      [...compiled.parameters],
    );
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.match(text, /collection_members_shared_list_updated_idx/i);
    assert.doesNotMatch(text, /\bSort\b/i);
    assert.match(text, /Buffers:/i);
    assert.match(text, /actual time=/i);
  });

  test('collection_updated_at copies on insert, fans out on bump, and reorders the shared list', async () => {
    const recencyOwner = 'subject-recency-owner-sc03';
    const recencyMember = 'subject-recency-member-sc03';
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(
        `insert into accounts(id,subject_id,status) values
         ('account-recency-owner-sc03',$1,'active'),
         ('account-recency-member-sc03',$2,'active')`,
        [recencyOwner, recencyMember],
      );
      await insertCollection(client, {
        id: 'recency-older', owner: recencyOwner, title: 'Older', updatedAt: '2026-08-18T10:00:00Z',
      });
      await insertCollection(client, {
        id: 'recency-newer', owner: recencyOwner, title: 'Newer', updatedAt: '2026-08-18T11:00:00Z',
      });
      await client.query(
        `insert into collection_members(collection_id,subject_id,role,granted_at) values
         ('recency-older',$1,'owner',now()),
         ('recency-older',$2,'editor',now()),
         ('recency-newer',$1,'owner',now()),
         ('recency-newer',$2,'viewer',now())`,
        [recencyOwner, recencyMember],
      );
      const copied = await client.query<{ member_at: Date; collection_at: Date }>(
        `select m.collection_updated_at as member_at, c.updated_at as collection_at
           from collection_members m
           join collections c on c.id = m.collection_id
          where m.subject_id = $1 and m.role in ('editor','viewer')`,
        [recencyMember],
      );
      assert.equal(copied.rows.length, 2);
      for (const row of copied.rows) {
        assert.equal(row.member_at.toISOString(), row.collection_at.toISOString());
      }
      await client.query(
        `update collections set updated_at = timestamptz '2026-08-19T12:00:00Z' where id = 'recency-older'`,
      );
      const fanned = await client.query<{ collection_updated_at: Date }>(
        `select collection_updated_at from collection_members
          where collection_id = 'recency-older' and subject_id = $1`,
        [recencyMember],
      );
      assert.equal(fanned.rows[0]!.collection_updated_at.toISOString(), '2026-08-19T12:00:00.000Z');
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const rows = await unit.execute(({ transaction }) =>
      createPostgresSharedCollectionsReadPort(transaction)
        .listSharedCollections({ memberSubjectId: recencyMember, limit: 10 }));
    assert.deepEqual(rows.map((row) => row.id), ['recency-older', 'recency-newer']);
    assert.equal(rows[0]?.updatedAt.toISOString(), '2026-08-19T12:00:00.000Z');
  });

  test('counts nested live bookmarks for editor and viewer equally', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const count = (ids: readonly string[]) => unit.execute(({ transaction }) =>
      createPostgresCollectionBookmarkCountReadPort(transaction).countBookmarks(ids));

    const nested = await count(['count-shared-nested']);
    assert.equal(bookmarkCountFor(nested, 'count-shared-nested'), 5);
    assert.equal(bookmarkCountFor(await count(['count-shared-folders']), 'count-shared-folders'), 0);
    assert.equal(bookmarkCountFor(await count(['count-shared-empty']), 'count-shared-empty'), 0);
    assert.equal(bookmarkCountFor(await count(['count-shared-soft']), 'count-shared-soft'), 1);
    assert.equal((await count(['count-shared-nested'])).has('other-only'), false);

    const tree = await isolated.runtime.pool.query<{
      id: string; parent_id: string | null; kind: string; deleted_at: Date | null;
    }>(
      `select id, parent_id, kind, deleted_at from nodes where collection_id = 'count-shared-nested'`,
    );
    assert.equal(
      bookmarkCountFor(nested, 'count-shared-nested'),
      flattenLiveBookmarkLength('root-count-shared-nested', tree.rows),
    );

    const cursors = createProductSharedCollectionsCursorSigner({
      current: { id: 'sc03-count-v1', key: 'sc03-shared-count-test-secret-material' },
    });
    const clock = { now: async () => NOW };
    const readPage = (subjectId: string) => unit.execute(({ transaction }) => getSharedCollectionsPage({
      reads: createPostgresSharedCollectionsReadPort(transaction), cursors, clock,
    }, { actor: { subjectId }, limit: 100 }));

    const editorPage = await readPage(COUNT_MEMBER);
    const viewerPage = await readPage(VIEWER);
    const editorCounts = await count(editorPage.items.map((row) => row.id));
    const viewerCounts = await count(viewerPage.items.map((row) => row.id));
    assert.equal(bookmarkCountFor(editorCounts, 'count-shared-nested'), 5);
    assert.equal(bookmarkCountFor(viewerCounts, 'count-shared-nested'), 5);
    assert.equal(bookmarkCountFor(editorCounts, 'count-shared-empty'), 0);
    assert.ok(viewerPage.items.some((row) => row.id === 'count-shared-nested'));
    assert.equal(viewerPage.items.some((row) => row.id === 'count-shared-empty'), false);
  });
});

async function seedFixtures(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`insert into accounts(id,subject_id,status) values
      ('account-owner-sc03',$1,'active'),
      ('account-owner-b-sc03',$2,'active'),
      ('account-member-sc03',$3,'active'),
      ('account-other-sc03',$4,'active'),
      ('account-viewer-sc03',$5,'active'),
      ('account-count-member-sc03',$6,'active'),
      ('account-tie-sc03','subject-tie-sc03','active'),
      ('account-tie-owner-sc03','subject-tie-owner','active'),
      ('account-explain-sc03','subject-explain-sc03','active')`,
    [OWNER, OTHER_OWNER, MEMBER, OTHER, VIEWER, COUNT_MEMBER]);
    await insertCollection(client, {
      id: 'owned-by-member', owner: MEMBER, title: 'Mine', updatedAt: '2026-08-18T20:00:00Z',
    });
    await client.query(
      `insert into collection_members(collection_id,subject_id,role,granted_at)
       values ('owned-by-member',$1,'owner',now())`,
      [MEMBER],
    );
    await insertCollection(client, {
      id: 'shared-live', owner: OWNER, title: 'Live shared', updatedAt: '2026-08-18T19:00:00Z',
    });
    await client.query(
      `insert into collection_members(collection_id,subject_id,role,granted_at) values
       ('shared-live',$1,'owner',now()),
       ('shared-live',$2,'editor',now())`,
      [OWNER, MEMBER],
    );
    await insertCollection(client, {
      id: 'other-only', owner: OTHER_OWNER, title: 'Other share', updatedAt: '2026-08-18T18:00:00Z',
    });
    await client.query(
      `insert into collection_members(collection_id,subject_id,role,granted_at) values
       ('other-only',$1,'owner',now()),
       ('other-only',$2,'viewer',now())`,
      [OTHER_OWNER, OTHER],
    );
    await insertCollection(client, {
      id: 'deleted-shared', owner: OWNER, title: 'Deleted', updatedAt: '2026-08-18T17:00:00Z',
      deletedAt: '2026-08-18T17:30:00Z',
    });
    await client.query(
      `insert into collection_members(collection_id,subject_id,role,granted_at) values
       ('deleted-shared',$1,'owner',now()),
       ('deleted-shared',$2,'editor',now())`,
      [OWNER, MEMBER],
    );
    await insertCollection(client, {
      id: 'pending-only', owner: OWNER, title: 'Pending', updatedAt: '2026-08-18T16:00:00Z',
    });
    await client.query(
      `insert into collection_members(collection_id,subject_id,role,granted_at)
       values ('pending-only',$1,'owner',now())`,
      [OWNER],
    );
    await client.query(
      `insert into collection_invites(
         id, collection_id, role, email_normalized, invited_subject_id, invited_by_subject_id,
         status, expires_at, collection_title_snapshot)
       values ('invite-pending-sc03','pending-only','editor','member-sc03@example.test',$1,$2,
         'pending', timestamptz '2026-08-26T00:00:00Z', 'Pending')`,
      [MEMBER, OWNER],
    );
    await insertCollection(client, {
      id: 'revoked-only', owner: OWNER, title: 'Revoked', updatedAt: '2026-08-18T15:00:00Z',
    });
    await client.query(
      `insert into collection_members(collection_id,subject_id,role,granted_at)
       values ('revoked-only',$1,'owner',now())`,
      [OWNER],
    );
    for (const [id, owner] of [
      ['tie-a', 'subject-tie-owner'],
      ['tie-b', 'subject-tie-owner'],
      ['tie-c', 'subject-tie-owner'],
    ] as const) {
      await insertCollection(client, {
        id, owner, title: `Tie ${id}`, updatedAt: '2026-08-18T12:00:00.000Z',
      });
      await client.query(
        `insert into collection_members(collection_id,subject_id,role,granted_at) values
         ($1,$2,'owner',now()),
         ($1,'subject-tie-sc03','viewer',now())`,
        [id, owner],
      );
    }
    for (let value = 1; value <= 30; value += 1) {
      const id = `page-${String(value).padStart(3, '0')}`;
      await insertCollection(client, {
        id,
        owner: OWNER,
        title: `Page ${value}`,
        updatedAt: new Date(Date.parse('2026-08-18T14:00:00.000Z') - value * 1000).toISOString(),
      });
      await client.query(
        `insert into collection_members(collection_id,subject_id,role,granted_at) values
         ($1,$2,'owner',now()),
         ($1,$3,'editor',now())`,
        [id, OWNER, MEMBER],
      );
    }
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      select 'explain-' || lpad(value::text,4,'0'),'collection' from generate_series(1,3000) value
      union all select 'root-explain-' || lpad(value::text,4,'0'),'node' from generate_series(1,3000) value`);
    await client.query(`insert into collections
      (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,
       content_revision,policy_revision,commit_ordinal,created_at,updated_at)
      select 'explain-' || lpad(value::text,4,'0'), $1, 'Explain ' || value,
       'bookmarks','private','root-explain-' || lpad(value::text,4,'0'),'r1','c1','p1',1,
       timestamptz '2026-08-01T00:00:00Z',
       timestamptz '2026-08-18T10:00:00Z' - value * interval '1 second'
      from generate_series(1,3000) value`, [OWNER]);
    await client.query(`insert into nodes
      (id,collection_id,kind,is_root,title,visibility,resource_revision,children_revision)
      select 'root-explain-' || lpad(value::text,4,'0'),'explain-' || lpad(value::text,4,'0'),
       'folder',true,'Root','inherit','rr','cr' from generate_series(1,3000) value`);
    await client.query(`insert into collection_members(collection_id,subject_id,role,granted_at)
      select 'explain-' || lpad(value::text,4,'0'), $1, 'owner', now() from generate_series(1,3000) value
      union all
      select 'explain-' || lpad(value::text,4,'0'), $2, 'editor', now() from generate_series(1,3000) value`,
    [OWNER, 'subject-explain-sc03']);
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      select 'owner-explain-' || lpad(value::text,4,'0'),'collection' from generate_series(1,5000) value
      union all select 'root-owner-explain-' || lpad(value::text,4,'0'),'node' from generate_series(1,5000) value`);
    await client.query(`insert into collections
      (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,
       content_revision,policy_revision,commit_ordinal,created_at,updated_at)
      select 'owner-explain-' || lpad(value::text,4,'0'), $1, 'Owner explain ' || value,
       'bookmarks','private','root-owner-explain-' || lpad(value::text,4,'0'),'r1','c1','p1',1,
       timestamptz '2026-08-01T00:00:00Z', timestamptz '2026-08-17T00:00:00Z'
      from generate_series(1,5000) value`, ['subject-explain-sc03']);
    await client.query(`insert into nodes
      (id,collection_id,kind,is_root,title,visibility,resource_revision,children_revision)
      select 'root-owner-explain-' || lpad(value::text,4,'0'),'owner-explain-' || lpad(value::text,4,'0'),
       'folder',true,'Root','inherit','rr','cr' from generate_series(1,5000) value`);
    await client.query(`insert into collection_members(collection_id,subject_id,role,granted_at)
      select 'owner-explain-' || lpad(value::text,4,'0'), $1, 'owner', now()
      from generate_series(1,5000) value`, ['subject-explain-sc03']);
    await seedSharedBookmarkCountFixtures(client);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertCollection(
  client: { query: (sqlText: string, values?: readonly unknown[]) => Promise<unknown> },
  input: {
    readonly id: string;
    readonly owner: string;
    readonly title: string;
    readonly updatedAt: string;
    readonly deletedAt?: string;
  },
): Promise<void> {
  const root = `root-${input.id}`;
  await client.query(
    `insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')`,
    [input.id, root],
  );
  await client.query(
    `insert into collections(
       id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
       content_revision, policy_revision, commit_ordinal, created_at, updated_at, deleted_at)
     values ($1,$2,$3,'bookmarks','private',$4,'r','c','p',1,
       timestamptz '2026-08-01T00:00:00Z',$5,$6)`,
    [input.id, input.owner, input.title, root, input.updatedAt, input.deletedAt ?? null],
  );
  await client.query(
    `insert into nodes(id,collection_id,kind,is_root,title,visibility,resource_revision,children_revision,deleted_at)
     values ($1,$2,'folder',true,'Root','inherit','rr','cr',$3)`,
    [root, input.id, input.deletedAt ?? null],
  );
}

async function seedSharedBookmarkCountFixtures(
  client: { query: (sqlText: string, values?: readonly unknown[]) => Promise<unknown> },
): Promise<void> {
  await insertCollection(client, {
    id: 'count-shared-nested', owner: OWNER, title: 'Count nested', updatedAt: '2026-08-18T21:00:05Z',
  });
  await client.query(
    `insert into collection_members(collection_id,subject_id,role,granted_at) values
     ('count-shared-nested',$1,'owner',now()),
     ('count-shared-nested',$2,'editor',now()),
     ('count-shared-nested',$3,'viewer',now())`,
    [OWNER, COUNT_MEMBER, VIEWER],
  );
  await insertCountNode(client, {
    id: 'bm-shared-nested-r1', collectionId: 'count-shared-nested', parentId: 'root-count-shared-nested',
    kind: 'bookmark', title: 'Root one', url: 'https://example.test/s1', positionToken: 'A',
  });
  await insertCountNode(client, {
    id: 'bm-shared-nested-r2', collectionId: 'count-shared-nested', parentId: 'root-count-shared-nested',
    kind: 'bookmark', title: 'Root two', url: 'https://example.test/s2', positionToken: 'B',
  });
  await insertCountNode(client, {
    id: 'folder-shared-nested', collectionId: 'count-shared-nested', parentId: 'root-count-shared-nested',
    kind: 'folder', title: 'Child folder', positionToken: 'C',
  });
  await insertCountNode(client, {
    id: 'bm-shared-nested-f1', collectionId: 'count-shared-nested', parentId: 'folder-shared-nested',
    kind: 'bookmark', title: 'Nested one', url: 'https://example.test/s3', positionToken: 'A',
  });
  await insertCountNode(client, {
    id: 'bm-shared-nested-f2', collectionId: 'count-shared-nested', parentId: 'folder-shared-nested',
    kind: 'bookmark', title: 'Nested two', url: 'https://example.test/s4', positionToken: 'B',
  });
  await insertCountNode(client, {
    id: 'bm-shared-nested-f3', collectionId: 'count-shared-nested', parentId: 'folder-shared-nested',
    kind: 'bookmark', title: 'Nested three', url: 'https://example.test/s5', positionToken: 'C',
  });

  await insertCollection(client, {
    id: 'count-shared-folders', owner: OWNER, title: 'Count folders', updatedAt: '2026-08-18T21:00:04Z',
  });
  await client.query(
    `insert into collection_members(collection_id,subject_id,role,granted_at) values
     ('count-shared-folders',$1,'owner',now()),
     ('count-shared-folders',$2,'editor',now())`,
    [OWNER, COUNT_MEMBER],
  );
  await insertCountNode(client, {
    id: 'folder-shared-folders', collectionId: 'count-shared-folders', parentId: 'root-count-shared-folders',
    kind: 'folder', title: 'Only folder', positionToken: 'A',
  });
  await insertCountNode(client, {
    id: 'sep-shared-folders', collectionId: 'count-shared-folders', parentId: 'root-count-shared-folders',
    kind: 'separator', title: null, positionToken: 'B',
  });

  await insertCollection(client, {
    id: 'count-shared-empty', owner: OWNER, title: 'Count empty', updatedAt: '2026-08-18T21:00:03Z',
  });
  await client.query(
    `insert into collection_members(collection_id,subject_id,role,granted_at) values
     ('count-shared-empty',$1,'owner',now()),
     ('count-shared-empty',$2,'editor',now())`,
    [OWNER, COUNT_MEMBER],
  );

  await insertCollection(client, {
    id: 'count-shared-soft', owner: OWNER, title: 'Count soft', updatedAt: '2026-08-18T21:00:02Z',
  });
  await client.query(
    `insert into collection_members(collection_id,subject_id,role,granted_at) values
     ('count-shared-soft',$1,'owner',now()),
     ('count-shared-soft',$2,'editor',now())`,
    [OWNER, COUNT_MEMBER],
  );
  await insertCountNode(client, {
    id: 'bm-shared-soft-live', collectionId: 'count-shared-soft', parentId: 'root-count-shared-soft',
    kind: 'bookmark', title: 'Live', url: 'https://example.test/slive', positionToken: 'A',
  });
  await insertCountNode(client, {
    id: 'bm-shared-soft-dead', collectionId: 'count-shared-soft', parentId: 'root-count-shared-soft',
    kind: 'bookmark', title: 'Deleted', url: 'https://example.test/sdead', positionToken: 'B',
    deletedAt: '2026-08-18T12:00:00Z',
  });

  await insertCountNode(client, {
    id: 'bm-other-only-1', collectionId: 'other-only', parentId: 'root-other-only',
    kind: 'bookmark', title: 'Other 1', url: 'https://example.test/oo1', positionToken: 'A',
  });
}

async function insertCountNode(
  client: { query: (sqlText: string, values?: readonly unknown[]) => Promise<unknown> },
  input: {
    readonly id: string;
    readonly collectionId: string;
    readonly parentId: string;
    readonly kind: 'folder' | 'bookmark' | 'separator';
    readonly title: string | null;
    readonly url?: string | null;
    readonly positionToken: string;
    readonly deletedAt?: string;
  },
): Promise<void> {
  await client.query(`insert into resource_id_ledger(resource_id,resource_type) values ($1,'node')`, [input.id]);
  await client.query(
    `insert into nodes
      (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,
       resource_revision,children_revision,deleted_at)
     values ($1,$2,$3,$4,false,$5,$6,'inherit',$7,'r','c',$8)`,
    [
      input.id, input.collectionId, input.parentId, input.kind, input.title,
      input.url ?? null, input.positionToken, input.deletedAt ?? null,
    ],
  );
}

async function compileSharedListQuery(
  db: Kysely<DatabaseSchema>,
  memberSubjectId: string,
  limit: number,
): Promise<{ sql: string; parameters: readonly unknown[] }> {
  const executor = db.getExecutor();
  let compiled: { sql: string; parameters: readonly unknown[] } | undefined;
  const capturing = db.withPlugin({
    transformQuery(args) {
      const next = executor.compileQuery(args.node, args.queryId);
      if (next.sql.includes('collection_members')) compiled = next;
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  } satisfies KyselyPlugin);
  await createPostgresSharedCollectionsReadPort(capturing).listSharedCollections({ memberSubjectId, limit });
  assert.ok(compiled, 'expected shared-list SELECT compilation');
  return compiled;
}

function flattenLiveBookmarkLength(
  rootId: string,
  nodes: ReadonlyArray<{
    readonly id: string;
    readonly parent_id: string | null;
    readonly kind: string;
    readonly deleted_at: Date | null;
  }>,
): number {
  const children = new Map<string, Array<(typeof nodes)[number]>>();
  for (const node of nodes) {
    if (node.deleted_at !== null || node.parent_id === null) continue;
    const list = children.get(node.parent_id) ?? [];
    list.push(node);
    children.set(node.parent_id, list);
  }
  let count = 0;
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.kind === 'bookmark') count += 1;
    stack.push(...(children.get(node.id) ?? []));
  }
  return count;
}
