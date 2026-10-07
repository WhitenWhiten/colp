import { assertOwnedKeysetPlan, type KeysetPlanNode } from '../../support/postgres-keyset-plan.js';
import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresOwnedCollectionsReadPort, createPostgresCollectionBookmarkCountReadPort } from '../../../src/infrastructure/collections/index.js';
import { createMigrator, createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  bookmarkCountFor,
  createProductOwnedCollectionsCursorSigner,
  getOwnedCollectionsPage,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('LM-01 PostgreSQL owned Collections query evidence', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('lm01_owned_collections', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedTenThousand(isolated);
  }, 180_000);
  afterAll(async () => isolated?.close());

  test('builds empty schema and upgrades the stable previous migration with the production index', async () => {
    const indexes = await isolated.runtime.pool.query<{ indexdef: string }>(`
      select indexdef from pg_indexes
       where schemaname=current_schema() and indexname='collections_owned_live_updated_id_idx'`);
    assert.equal(indexes.rows.length, 1);
    assert.match(indexes.rows[0]!.indexdef, /owner_subject_id, updated_at DESC, id COLLATE "C"/i);
    assert.match(indexes.rows[0]!.indexdef, /WHERE \(deleted_at IS NULL\)/i);

    const upgrade = await createIsolatedPostgresRuntime('lm01_owned_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202607260100_owned_collections_keyset');
      const previous = await migrator.migrateTo('202607252000_sync_conflicts');
      if (previous.error) throw previous.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.collections_owned_live_updated_id_idx') is not null present`,
      )).rows[0]?.present, false);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.collections_owned_live_updated_id_idx') is not null present`,
      )).rows[0]?.present, true);
      const down = await migrator.migrateTo('202607252000_sync_conflicts');
      if (down.error) throw down.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.collections_owned_live_updated_id_idx') is not null present`,
      )).rows[0]?.present, false);
      const upAgain = await migrator.migrateToLatest();
      if (upAgain.error) throw upAgain.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.collections_owned_live_updated_id_idx') is not null present`,
      )).rows[0]?.present, true);
      await migrator.upgradeToCurrentLatest();
    } finally { await upgrade.close(); }
  }, 180_000);

  test('returns only live rows for the authoritative owner with all kind and visibility filters', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const execute = <T>(work: Parameters<typeof unit.execute<T>>[0]) => unit.execute(work);
    const owner = await execute(({ transaction }) => createPostgresOwnedCollectionsReadPort(transaction)
      .listOwnedCollections({ ownerSubjectId: 'subject-owner', limit: 100 }));
    assert.equal(owner.some((row) => row.id === 'outsider-only'), false);
    assert.equal(owner.some((row) => row.id === 'deleted-only'), false);
    for (const kind of ['bookmarks', 'reading_path', 'knowledge_collection', 'mixed'] as const) {
      const rows = await execute(({ transaction }) => createPostgresOwnedCollectionsReadPort(transaction)
        .listOwnedCollections({ ownerSubjectId: 'filter-owner', kind, limit: 20 }));
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row) => row.kind === kind));
    }
    for (const visibility of ['private', 'protected', 'unlisted', 'public'] as const) {
      const rows = await execute(({ transaction }) => createPostgresOwnedCollectionsReadPort(transaction)
        .listOwnedCollections({ ownerSubjectId: 'filter-owner', visibility, limit: 20 }));
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row) => row.visibility === visibility));
    }
  });

  test('pages through the real PostgreSQL adapter via the application query and its scoped cursor', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const cursors = createProductOwnedCollectionsCursorSigner({
      current: { id: 'lm01-v1', key: 'lm01-owned-collections-test-secret-material' },
    });
    const clock = { now: async () => new Date('2026-07-26T01:00:00.000Z') };
    const readPage = (input: { actor: { subjectId: string }; limit?: number; cursor?: string }) =>
      unit.execute(({ transaction }) => getOwnedCollectionsPage({
        reads: createPostgresOwnedCollectionsReadPort(transaction), cursors, clock,
      }, input));

    const first = await readPage({ actor: { subjectId: 'subject-owner' }, limit: 30 });
    const second = await readPage({ actor: { subjectId: 'subject-owner' }, cursor: first.page.nextCursor! });
    assert.equal(first.items.length, 30);
    assert.equal(second.items.length, 30);
    assert.equal(first.page.hasMore, true);
    assert.equal(new Set([...first.items, ...second.items].map((row) => row.id)).size, 60);
    assert.ok([...first.items, ...second.items].every((row) => row.title.startsWith('Owner fixture')));
  });

  test('uses the owner/live/order partial index for first, middle and final pages over 10k rows', async () => {
    const environment = await isolated.runtime.pool.query<{ server_version: string }>('show server_version');
    const fixture = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*) from collections where owner_subject_id='subject-owner' and deleted_at is null`,
    );
    assert.equal(fixture.rows[0]?.count, '10000');
    const positions = [
      ['first', null],
      ['middle', ['2026-07-25T22:36:40.000Z', 'fixture-005000']],
      ['final', ['2026-07-25T21:13:22.000Z', 'fixture-009998']],
    ] as const;
    for (const [position, after] of positions) {
      const predicate = after === null ? '' : `and updated_at <= $2::timestamptz
        and (updated_at < $2::timestamptz or
        (updated_at = $2::timestamptz and id collate "C" > $3::text collate "C"))`;
      const params = after === null ? ['subject-owner'] : ['subject-owner', after[0], after[1]];
      const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': { Plan: KeysetPlanNode }[] }>(
        `explain (analyze, buffers, format json)
         select id, updated_at from collections
          where owner_subject_id=$1 and deleted_at is null ${predicate}
          order by updated_at desc, id collate "C" asc limit 31`, params);
      const root = plan.rows[0]!['QUERY PLAN'][0]!.Plan;
      assertOwnedKeysetPlan(root, after !== null);
      assert.equal(root['Actual Rows'], position === 'final' ? 2 : 31);
      const rows = await isolated.runtime.pool.query<{ id: string }>(`select id from collections
        where owner_subject_id=$1 and deleted_at is null ${predicate}
        order by updated_at desc,id collate "C" asc limit 31`, params);
      const first = position === 'first' ? 1 : position === 'middle' ? 5001 : 9999;
      assert.deepEqual(rows.rows.map(row => row.id), Array.from({ length: position === 'final' ? 2 : 31 },
        (_, index) => `fixture-${String(first + index).padStart(6, '0')}`));
      console.info(`[LM-01 plan] PostgreSQL ${environment.rows[0]?.server_version}; rows=10000; page=${position}`, root);

    }
  }, 120_000);

  test('keyset plan survives pinned MVCC versions and rejects missing seeks or indexes', async () => {
    const reader = await isolated.runtime.pool.connect();
    const query = `select id,updated_at from collections where owner_subject_id='subject-owner'
      and deleted_at is null and updated_at <= '2026-07-25T22:36:40Z'::timestamptz
      and (updated_at < '2026-07-25T22:36:40Z'::timestamptz
        or (updated_at='2026-07-25T22:36:40Z'::timestamptz and id collate "C" > 'fixture-005000'))
      order by updated_at desc,id collate "C" asc limit 31`;
    async function explain(statement: string) {
      return (await isolated.runtime.pool.query<{ 'QUERY PLAN': { Plan: KeysetPlanNode }[] }>(
        `explain (analyze,buffers,format json) ${statement}`)).rows[0]!['QUERY PLAN'][0]!.Plan;
    }
    try {
      await reader.query('begin isolation level repeatable read');
      await reader.query("select count(*) from collections where owner_subject_id='subject-owner'");
      await isolated.runtime.pool.query("update collections set title=title || ' MVCC' where id between 'fixture-004999' and 'fixture-005100'");
      await isolated.runtime.pool.query('vacuum analyze collections');
      assert.doesNotMatch((await reader.query("select title from collections where id='fixture-005001'")).rows[0].title, /MVCC/);
      assert.match((await isolated.runtime.pool.query("select title from collections where id='fixture-005001'")).rows[0].title, /MVCC/);
      const mvccPlan = await explain(query);
      assertOwnedKeysetPlan(mvccPlan, true);
      console.info('[LM-01 pinned MVCC plan]', mvccPlan);
      // The owner index remains usable with no timestamp seek, but that is not
      // a valid continuation plan even when LIMIT returns only 31 rows.
      const noBoundary = query.replace(/ and updated_at <= '2026-07-25T22:36:40Z'::timestamptz/, '')
        .replace(/and \(updated_at <[\s\S]*?\)\)\n/, '');
      const missingSeek = await explain(noBoundary);
      assert.throws(() => assertOwnedKeysetPlan(missingSeek, true), /timestamp boundary/);
      const disabled = await isolated.runtime.pool.connect();
      try {
        await disabled.query('begin');
        await disabled.query('set local enable_indexscan=off');
        await disabled.query('set local enable_bitmapscan=off');
        const plan = (await disabled.query<{ 'QUERY PLAN': { Plan: KeysetPlanNode }[] }>(
          `explain (analyze,buffers,format json) ${query}`)).rows[0]!['QUERY PLAN'][0]!.Plan;
        assert.throws(() => assertOwnedKeysetPlan(plan, true), /full scans and sorts/);
      } finally { await disabled.query('rollback'); disabled.release(); }
    } finally { await reader.query('rollback'); reader.release(); }
  });

  test('fully traverses the 10k production fixture without duplicate or omitted IDs', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const seen = new Set<string>();
    let after: { updatedAt: Date; id: string } | undefined;
    do {
      const rows = await unit.execute(({ transaction }) => createPostgresOwnedCollectionsReadPort(transaction)
        .listOwnedCollections({ ownerSubjectId: 'subject-owner', limit: 100, ...(after ? { after } : {}) }));
      const page = rows.slice(0, 100);
      for (const row of page) {
        assert.equal(seen.has(row.id), false, `duplicate ${row.id}`);
        seen.add(row.id);
      }
      const last = page.at(-1);
      after = rows.length > 100 && last ? { updatedAt: last.updatedAt, id: last.id } : undefined;
    } while (after);
    assert.equal(seen.size, 10_000);
    assert.ok(seen.has('fixture-000001'));
    assert.ok(seen.has('fixture-010000'));
  }, 120_000);

  test('counts nested live bookmarks once per authorized page and ignores folders, separators, and deletes', async () => {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    const count = (ids: readonly string[]) => unit.execute(({ transaction }) =>
      createPostgresCollectionBookmarkCountReadPort(transaction).countBookmarks(ids));

    const nested = await count(['count-nested']);
    assert.equal(bookmarkCountFor(nested, 'count-nested'), 5);

    const foldersOnly = await count(['count-folders-only']);
    assert.equal(bookmarkCountFor(foldersOnly, 'count-folders-only'), 0);

    const softDeleted = await count(['count-soft-deleted']);
    assert.equal(bookmarkCountFor(softDeleted, 'count-soft-deleted'), 1);

    const empty = await count(['count-empty']);
    assert.equal(empty.has('count-empty'), false);
    assert.equal(bookmarkCountFor(empty, 'count-empty'), 0);

    const isolatedCount = await count(['count-nested']);
    assert.equal(bookmarkCountFor(isolatedCount, 'count-nested'), 5);
    assert.equal(isolatedCount.has('count-other'), false);
    assert.equal(isolatedCount.has('outsider-only'), false);

    const tree = await isolated.runtime.pool.query<{
      id: string; parent_id: string | null; kind: string; deleted_at: Date | null;
    }>(
      `select id, parent_id, kind, deleted_at from nodes where collection_id = 'count-nested'`,
    );
    assert.equal(
      bookmarkCountFor(nested, 'count-nested'),
      flattenLiveBookmarkLength('root-count-nested', tree.rows),
    );

    const cursors = createProductOwnedCollectionsCursorSigner({
      current: { id: 'lm01-count-v1', key: 'lm01-owned-count-test-secret-material' },
    });
    const clock = { now: async () => new Date('2026-07-26T01:00:00.000Z') };
    const page = await unit.execute(({ transaction }) => getOwnedCollectionsPage({
      reads: createPostgresOwnedCollectionsReadPort(transaction), cursors, clock,
    }, { actor: { subjectId: 'count-owner' }, limit: 100 }));
    const pageCounts = await count(page.items.map((row) => row.id));
    assert.deepEqual(page.items.map((row) => row.id).sort(), [
      'count-empty', 'count-folders-only', 'count-nested', 'count-other', 'count-soft-deleted',
    ]);
    assert.equal(bookmarkCountFor(pageCounts, 'count-nested'), 5);
    assert.equal(bookmarkCountFor(pageCounts, 'count-folders-only'), 0);
    assert.equal(bookmarkCountFor(pageCounts, 'count-soft-deleted'), 1);
    assert.equal(bookmarkCountFor(pageCounts, 'count-empty'), 0);
    assert.equal(bookmarkCountFor(pageCounts, 'count-other'), 3);
  });
});

async function seedTenThousand(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`insert into accounts(id,subject_id,status) values
      ('account-owner','subject-owner','active'),
      ('account-outsider','subject-outsider','active')`);
    await client.query(`insert into account_identities(id,account_id,issuer,subject) values
      ('identity-owner','account-owner','https://issuer.lm01.test','oidc-owner'),
      ('identity-outsider','account-outsider','https://issuer.lm01.test','oidc-outsider')`);
    await client.query(`insert into profile_handles(handle,account_id) values
      ('lm01_owner','account-owner'),
      ('lm01_outsider','account-outsider')`);
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      select 'fixture-' || lpad(value::text,6,'0'),'collection' from generate_series(1,10000) value
      union all select 'root-' || lpad(value::text,6,'0'),'node' from generate_series(1,10000) value`);
    await client.query(`insert into collections
      (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,
       content_revision,policy_revision,commit_ordinal,created_at,updated_at)
      select 'fixture-' || lpad(value::text,6,'0'), 'subject-owner', 'Owner fixture ' || value,
       'bookmarks','private','root-' || lpad(value::text,6,'0'),'r1','c1','p1',1,
       '2026-07-25T00:00:00Z'::timestamptz,
       '2026-07-26T00:00:00Z'::timestamptz - value * interval '1 second'
      from generate_series(1,10000) value`);
    await client.query(`insert into nodes
      (id,collection_id,kind,is_root,title,visibility,resource_revision,children_revision)
      select 'root-' || lpad(value::text,6,'0'),'fixture-' || lpad(value::text,6,'0'),
       'folder',true,'Root','inherit','rr','cr' from generate_series(1,10000) value`);
    for (const [id, owner, kind, visibility, deleted] of [
      ['outsider-only','subject-outsider','bookmarks','private',false],
      ['deleted-only','subject-owner','bookmarks','private',true],
      ...(['bookmarks','reading_path','knowledge_collection','mixed'] as const).flatMap((kind) =>
        (['private','protected','unlisted','public'] as const).map((visibility) =>
          [`filter-${kind}-${visibility}`,'filter-owner',kind,visibility,false] as const)),
    ] as const) {
      const root = `root-${id}`;
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')`, [id, root]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,deleted_at,publication_slug,published_at)
         values ($1,$2,$1,$3,$4,$5,'r','c','p',1,$6,$7,$8)`,
      [id, owner, kind, visibility, root, deleted ? '2026-07-26T00:00:00Z' : null,
        visibility === 'public' || visibility === 'unlisted' ? `lm01-${id.replaceAll('_', '-')}` : null,
        visibility === 'public' || visibility === 'unlisted' ? '2026-07-25T00:00:00Z' : null]);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,visibility,resource_revision,children_revision,deleted_at)
        values ($1,$2,'folder',true,'Root','inherit','r','c',$3)`, [root, id, deleted ? '2026-07-26T00:00:00Z' : null]);
    }
    await seedBookmarkCountFixtures(client);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
  await isolated.runtime.pool.query('vacuum (analyze) collections');
}

async function seedBookmarkCountFixtures(
  client: { query: (sqlText: string, values?: readonly unknown[]) => Promise<unknown> },
): Promise<void> {
  for (const [id, updatedAt] of [
    ['count-nested', '2026-07-27T00:00:05Z'],
    ['count-folders-only', '2026-07-27T00:00:04Z'],
    ['count-soft-deleted', '2026-07-27T00:00:03Z'],
    ['count-empty', '2026-07-27T00:00:02Z'],
    ['count-other', '2026-07-27T00:00:01Z'],
  ] as const) {
    const root = `root-${id}`;
    await client.query(
      `insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')`,
      [id, root],
    );
    await client.query(
      `insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,created_at,updated_at)
       values ($1,'count-owner',$1,'bookmarks','private',$2,'r','c','p',1,
         timestamptz '2026-07-25T00:00:00Z',$3)`,
      [id, root, updatedAt],
    );
    await client.query(
      `insert into nodes
        (id,collection_id,kind,is_root,title,visibility,resource_revision,children_revision)
       values ($1,$2,'folder',true,'Root','inherit','r','c')`,
      [root, id],
    );
  }

  await insertCountNode(client, {
    id: 'bm-count-nested-r1', collectionId: 'count-nested', parentId: 'root-count-nested',
    kind: 'bookmark', title: 'Root one', url: 'https://example.test/n1', positionToken: 'A',
  });
  await insertCountNode(client, {
    id: 'bm-count-nested-r2', collectionId: 'count-nested', parentId: 'root-count-nested',
    kind: 'bookmark', title: 'Root two', url: 'https://example.test/n2', positionToken: 'B',
  });
  await insertCountNode(client, {
    id: 'folder-count-nested', collectionId: 'count-nested', parentId: 'root-count-nested',
    kind: 'folder', title: 'Child folder', positionToken: 'C',
  });
  await insertCountNode(client, {
    id: 'bm-count-nested-f1', collectionId: 'count-nested', parentId: 'folder-count-nested',
    kind: 'bookmark', title: 'Nested one', url: 'https://example.test/n3', positionToken: 'A',
  });
  await insertCountNode(client, {
    id: 'bm-count-nested-f2', collectionId: 'count-nested', parentId: 'folder-count-nested',
    kind: 'bookmark', title: 'Nested two', url: 'https://example.test/n4', positionToken: 'B',
  });
  await insertCountNode(client, {
    id: 'bm-count-nested-f3', collectionId: 'count-nested', parentId: 'folder-count-nested',
    kind: 'bookmark', title: 'Nested three', url: 'https://example.test/n5', positionToken: 'C',
  });

  await insertCountNode(client, {
    id: 'folder-count-folders', collectionId: 'count-folders-only', parentId: 'root-count-folders-only',
    kind: 'folder', title: 'Only folder', positionToken: 'A',
  });
  await insertCountNode(client, {
    id: 'sep-count-folders', collectionId: 'count-folders-only', parentId: 'root-count-folders-only',
    kind: 'separator', title: null, positionToken: 'B',
  });

  await insertCountNode(client, {
    id: 'bm-count-soft-live', collectionId: 'count-soft-deleted', parentId: 'root-count-soft-deleted',
    kind: 'bookmark', title: 'Live', url: 'https://example.test/live', positionToken: 'A',
  });
  await insertCountNode(client, {
    id: 'bm-count-soft-dead', collectionId: 'count-soft-deleted', parentId: 'root-count-soft-deleted',
    kind: 'bookmark', title: 'Deleted', url: 'https://example.test/dead', positionToken: 'B',
    deletedAt: '2026-07-26T00:00:00Z',
  });

  await insertCountNode(client, {
    id: 'bm-count-other-1', collectionId: 'count-other', parentId: 'root-count-other',
    kind: 'bookmark', title: 'Other 1', url: 'https://example.test/o1', positionToken: 'A',
  });
  await insertCountNode(client, {
    id: 'bm-count-other-2', collectionId: 'count-other', parentId: 'root-count-other',
    kind: 'bookmark', title: 'Other 2', url: 'https://example.test/o2', positionToken: 'B',
  });
  await insertCountNode(client, {
    id: 'bm-count-other-3', collectionId: 'count-other', parentId: 'root-count-other',
    kind: 'bookmark', title: 'Other 3', url: 'https://example.test/o3', positionToken: 'C',
  });

  await insertCountNode(client, {
    id: 'bm-outsider-1', collectionId: 'outsider-only', parentId: 'root-outsider-only',
    kind: 'bookmark', title: 'Outsider 1', url: 'https://example.test/x1', positionToken: 'A',
  });
  await insertCountNode(client, {
    id: 'bm-outsider-2', collectionId: 'outsider-only', parentId: 'root-outsider-only',
    kind: 'bookmark', title: 'Outsider 2', url: 'https://example.test/x2', positionToken: 'B',
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
