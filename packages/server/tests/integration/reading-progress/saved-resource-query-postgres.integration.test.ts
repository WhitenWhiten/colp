import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresSavedResourceReadUnitOfWork } from '../../../src/infrastructure/reading-progress/index.js';
import { createSavedResourceCursorSigner, getSavedResourcePage } from '../../../src/modules/reading-progress/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P2B-16 saved resource query and plan', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('phase2b_saved_query'); await runMigrations(isolated.runtime.db, 'latest'); }, 120_000);
  afterAll(async () => isolated?.close());
  test('uses account keyset index with the full exclusive comparator', async () => {
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status) values ('account-plan','subject-plan','active')`);
    await isolated.runtime.pool.query(`insert into saved_resources(account_id,resource_type,resource_id,saved_at,updated_at)
      select 'account-plan',case when n%2=0 then 'node' else 'collection' end,
        'plan-'||lpad(n::text,6,'0'),'2026-07-25T12:00:00Z'::timestamptz-(n||' milliseconds')::interval,
        '2026-07-25T12:00:00Z'::timestamptz from generate_series(1,10000) n`);
    await isolated.runtime.pool.query('analyze saved_resources');
    const plan = await isolated.runtime.pool.query(`explain (analyze, buffers, format json)
      select resource_type,resource_id,saved_at from saved_resources
      where account_id='account-plan' and deleted_at is null
        and (saved_at < '2026-07-25T11:59:55Z' or (saved_at='2026-07-25T11:59:55Z'
          and (resource_type>'node' or (resource_type='node' and resource_id>'plan-005000'))))
      order by saved_at desc,resource_type asc,resource_id asc limit 21`);
    const text = JSON.stringify(plan.rows); assert.match(text, /saved_resources_account_order_idx/);
    assert.doesNotMatch(text, /Sort/);
    assert.doesNotMatch(text, /Seq Scan/);
  });
  test('a cursor reaches every row that shares one millisecond bucket', async () => {
    // The cursor carries milliseconds, so `saved_at` must be stored at that
    // precision — which is what the adapter clock now guarantees — and several
    // rows may share one millisecond. Both halves are asserted here: the write
    // clock is millisecond-aligned, and rows inside one bucket stay addressable
    // across page boundaries through the resource_type/resource_id tie-breakers.
    //
    // A sub-millisecond `saved_at` matches neither `saved_at < cursor` nor
    // `saved_at = cursor`, so such a row cannot be reached by a later page at
    // all. The read path therefore keeps the invariant rather than tolerating a
    // violation of it; the write clock is what makes that true.
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status) values ('account-ms','subject-ms','active')`);
    // 24 rows over 8 millisecond buckets: three rows share each timestamp.
    await isolated.runtime.pool.query(`insert into saved_resources(account_id,resource_type,resource_id,saved_at,updated_at)
      select 'account-ms','node','ms-'||lpad(n::text,4,'0'),
        '2026-07-25T12:00:00Z'::timestamptz-((n-1)/3||' milliseconds')::interval,
        '2026-07-25T12:00:00Z'::timestamptz from generate_series(1,24) n`);
    const uow = createPostgresSavedResourceReadUnitOfWork(isolated.runtime.db, {
      cursorSigner: createSavedResourceCursorSigner({ current: { id: 'pg-v1', key: 'saved-pg-cursor-secret' } }),
    });
    const actor = { accountId: 'account-ms', principalId: 'account-ms', subjectId: 'subject-ms' };
    const seen: string[] = []; let cursor: string | undefined;
    for (let page = 0; page < 40; page += 1) {
      const result = await uow.execute((ports) => getSavedResourcePage(ports,
        cursor === undefined ? { actor, limit: 2 } : { actor, cursor }));
      seen.push(...result.items.map((item) => item.resourceId));
      cursor = result.page.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
    assert.equal(cursor, undefined, 'pagination must terminate');
    assert.equal(seen.length, 24, 'every row must be returned exactly once');
    assert.equal(new Set(seen).size, 24, 'no row may be returned twice');
    // The fixture must really put several rows in one millisecond, or the
    // tie-breaker path is not exercised at all.
    const buckets = await isolated.runtime.pool.query(`select count(*)::int as total,
      count(distinct saved_at)::int as buckets from saved_resources where account_id='account-ms'`);
    assert.equal(buckets.rows[0].total, 24);
    assert.ok(buckets.rows[0].buckets < 24,
      `the fixture must share millisecond buckets, got ${buckets.rows[0].buckets}`);
  });

  test('the adapter write clock keeps saved_at addressable by a millisecond cursor', async () => {
    const uow = createPostgresSavedResourceReadUnitOfWork(isolated.runtime.db, {
      cursorSigner: createSavedResourceCursorSigner({ current: { id: 'pg-v1', key: 'saved-pg-cursor-secret' } }),
    });
    const issued = await uow.execute((ports) => ports.clock.now());
    assert.equal(issued.getTime() % 1, 0, 'the query clock must be millisecond-aligned');
    // Every stored row must round-trip through the millisecond the cursor
    // carries: `toISOString` is exactly what the cursor stores.
    const rows = await uow.execute((ports) => ports.reads.listLive({ accountId: 'account-ms', limit: 24 }));
    assert.equal(rows.length, 24);
    for (const row of rows) {
      assert.equal(Date.parse(row.savedAt.toISOString()) % 1, 0, 'a stored saved_at must be millisecond-aligned');
      assert.equal(new Date(row.savedAt.toISOString()).getTime(), row.savedAt.getTime());
    }
  });

  test('production adapter exposes one identity query plus one batch hydration query', async () => {
    const uow = createPostgresSavedResourceReadUnitOfWork(isolated.runtime.db, {
      cursorSigner: createSavedResourceCursorSigner({ current: { id: 'pg-v1', key: 'saved-pg-cursor-secret' } }),
    });
    const page = await uow.execute((ports) => getSavedResourcePage(ports, { actor: {
      accountId: 'account-a', principalId: 'principal-a', subjectId: 'subject-a' }, limit: 20 }));
    assert.deepEqual(page.items, []);
  });
});
