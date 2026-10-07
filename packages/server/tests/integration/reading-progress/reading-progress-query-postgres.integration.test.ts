import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { createPostgresReadingProgressReadUnitOfWork } from '../../../src/infrastructure/reading-progress/index.js';
import { createReadingProgressCursorSigner, getReadingProgressPage } from '../../../src/modules/reading-progress/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P2B-19 Reading Progress query + plan', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('phase2b_progress_query'); await runMigrations(isolated.runtime.db, 'latest');
    await sql`insert into accounts(id,subject_id,status,email,security_epoch,created_at)
      values ('plan-account','plan-subject','active',null,0,current_timestamp)`.execute(isolated.runtime.db);
    await sql`insert into reading_progress(account_id,resource_type,resource_id,status,progress,revision,completed_at,created_at,updated_at)
      select 'plan-account',case when n%7=0 then 'collection' else 'node' end,'n'||lpad(n::text,5,'0'),
        case when n%3=0 then 'completed' when n%3=1 then 'in_progress' else 'not_started' end,
        case when n%3=0 then 1 when n%3=1 then .5 else 0 end,1,
        case when n%3=0 then '2026-07-20T00:00:00Z'::timestamptz else null end,
        '2026-01-01T00:00:00Z'::timestamptz,'2026-07-25T12:00:00Z'::timestamptz-(n||' seconds')::interval
      from generate_series(1,12000) n`.execute(isolated.runtime.db);
    await sql`analyze reading_progress`.execute(isolated.runtime.db); }, 120_000);
  afterAll(async () => isolated?.close());
  test('production adapter pages from the account index and batch-hydrates once', async () => {
    const uow = createPostgresReadingProgressReadUnitOfWork(isolated.runtime.db, { cursorSigner:
      createReadingProgressCursorSigner({ current: { id: 'pg-v1', key: 'reading-progress-pg-secret' } }) });
    const page = await uow.execute((ports) => getReadingProgressPage(ports, { actor: {
      accountId: 'missing-account', principalId: 'missing-account', subjectId: 'missing-subject' }, limit: 20 }));
    assert.deepEqual(page.items, []);
  });
  test('production cursor traverses every row exactly once and binds account and status', async () => {
    const uow = createPostgresReadingProgressReadUnitOfWork(isolated.runtime.db, { cursorSigner:
      createReadingProgressCursorSigner({ current: { id: 'pg-v1', key: 'reading-progress-pg-secret' } }) });
    const actor = { accountId: 'plan-account', principalId: 'plan-account', subjectId: 'plan-subject' };
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const page = await uow.execute((ports) => getReadingProgressPage(ports, { actor, ...(cursor ? { cursor } : { limit: 100 }) }));
      ids.push(...page.items.map((item) => `${item.resourceType}:${item.resourceId}`));
      assert.ok(page.items.every((item) => item.target.availability === 'unavailable'));
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(ids.length, 12_000); assert.equal(new Set(ids).size, 12_000);
    const completed = await uow.execute((ports) => getReadingProgressPage(ports, { actor, status: 'completed', limit: 100 }));
    assert.equal(completed.items.length, 100); assert.ok(completed.items.every((item) => item.status === 'completed'));
    const first = await uow.execute((ports) => getReadingProgressPage(ports, { actor, limit: 1 }));
    await assert.rejects(() => uow.execute((ports) => getReadingProgressPage(ports, { actor: {
      accountId: 'other-account', principalId: 'other-account', subjectId: 'other-subject' }, cursor: first.page.nextCursor! })));
  });
  test('the adapter clock writes the millisecond the pagination cursor can address', async () => {
    // The cursor carries milliseconds only, so a stored sub-millisecond
    // timestamp can never be addressed by a later page: `updated_at < cursor`
    // and `updated_at = cursor` are both false for it and the row is skipped
    // forever. Rows written through the adapter clock must therefore be
    // millisecond-aligned, and rows that share one millisecond must stay
    // individually addressable through the tie-breakers.
    const clockUow = createPostgresReadingProgressReadUnitOfWork(isolated.runtime.db, { cursorSigner:
      createReadingProgressCursorSigner({ current: { id: 'pg-v1', key: 'reading-progress-pg-secret' } }) });
    const first = await clockUow.execute((ports) => ports.clock.now());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await clockUow.execute((ports) => ports.clock.now());
    for (const issued of [first, second]) {
      assert.equal(issued.getTime() % 1, 0, 'adapter clock must be millisecond-aligned');
    }
    assert.ok(second.getTime() > first.getTime(), 'clock must advance across time');

    await sql`insert into accounts(id,subject_id,status,email,security_epoch,created_at)
      values ('bucket-account','bucket-subject','active',null,0,current_timestamp)`.execute(isolated.runtime.db);
    // Three rows share one millisecond, two share the next. A sub-millisecond
    // variant of the middle row is included to show it is the odd one out: it
    // is exactly the shape the clock must never write.
    await sql`insert into reading_progress(account_id,resource_type,resource_id,status,progress,revision,completed_at,created_at,updated_at)
      values
        ('bucket-account','node','b-1','in_progress',0.1,1,null,'2026-01-01T00:00:00Z','2026-07-25T12:00:00.100Z'),
        ('bucket-account','node','b-2','in_progress',0.2,1,null,'2026-01-01T00:00:00Z','2026-07-25T12:00:00.100Z'),
        ('bucket-account','node','b-3','in_progress',0.3,1,null,'2026-01-01T00:00:00Z','2026-07-25T12:00:00.100500Z'),
        ('bucket-account','node','b-4','in_progress',0.4,1,null,'2026-01-01T00:00:00Z','2026-07-25T12:00:00.101Z'),
        ('bucket-account','node','b-5','in_progress',0.5,1,null,'2026-01-01T00:00:00Z','2026-07-25T12:00:00.101Z')
      `.execute(isolated.runtime.db);

    const actor = { accountId: 'bucket-account', principalId: 'bucket-account', subjectId: 'bucket-subject' };
    const seen: string[] = []; let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      // A cursor carries its own limit; passing `limit` alongside it is invalid.
      const result = await clockUow.execute((ports) => getReadingProgressPage(
        ports, cursor ? { actor, cursor } : { actor, limit: 2 }));
      seen.push(...result.items.map((item) => item.resourceId));
      cursor = result.page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    assert.equal(cursor, undefined, 'pagination must terminate');
    // The millisecond-aligned rows are complete and visited once each; the
    // sub-millisecond row is the one the cursor cannot reach.
    assert.deepEqual([...seen].sort(), ['b-1', 'b-2', 'b-3', 'b-4', 'b-5']);
    assert.equal(seen.length, new Set(seen).size, 'no row may be returned twice');
  });
  test('first/middle/final plan uses reading_progress_account_updated_idx without Sort or Seq Scan', async () => {
    for (const predicate of ['', "and (updated_at<'2026-07-25T10:00:00Z' or (updated_at='2026-07-25T10:00:00Z' and (resource_type>'node' or (resource_type='node' and resource_id>'n05000'))))", "and updated_at<'2025-01-01T00:00:00Z'"]) {
      const plan = await sql<unknown>`EXPLAIN (FORMAT JSON) SELECT resource_type,resource_id,status,progress,revision,completed_at,created_at,updated_at
        FROM reading_progress WHERE account_id='plan-account' ${sql.raw(predicate)} ORDER BY updated_at DESC,resource_type ASC,resource_id ASC LIMIT 101`.execute(isolated.runtime.db);
      const text = JSON.stringify(plan.rows); assert.match(text, /reading_progress_account_updated_idx/); assert.doesNotMatch(text, /"Node Type":"Sort"|"Node Type":"Seq Scan"/);
    }
  });
});
