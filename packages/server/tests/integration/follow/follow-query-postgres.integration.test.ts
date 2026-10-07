import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  buildFollowPageStatement,
  createPostgresFollowPageReadPort,
} from '../../../src/infrastructure/social/index.js';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createFollowCursorKeyring, queryFollowRelations } from '../../../src/modules/social/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-04 PostgreSQL Follow relation queries', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('phase5_follow_query', { maxConnections: 4,
    statementTimeoutMs: 120_000 }); await runMigrations(isolated.runtime.db, 'latest'); await seed(); }, 180_000);
  afterAll(async () => isolated?.close());

  test('returns only safe current Profile projections and follows handle/lifecycle changes', async () => {
    const page = await read('followers', 'hub', 100);
    assert.ok(page && page.items.length > 0);
    assert.deepEqual(Object.keys(page.items[0]!).sort(), ['avatarUrl', 'displayName', 'handle', 'profileId']);
    assert.equal(JSON.stringify(page).includes('email'), false);
    const beforeRename = await application('followers', 'hub', 2);
    assert.ok(beforeRename?.nextCursor);
    await isolated.runtime.pool.query(`update profiles set avatar_url='javascript:secret-marker' where account_id='p09995'`);
    assert.equal((await read('followers', 'hub', 100))?.items.find((row) => row.profileId === 'p09995')?.avatarUrl, null);
    await isolated.runtime.pool.query(`update profile_handles set handle='renamed_09994' where account_id='p09994'`);
    const afterRename = await application('followers', 'hub', 2, beforeRename.nextCursor);
    assert.equal(afterRename?.items[0]?.profileId, 'p09994');
    assert.equal(afterRename.items[0]?.handle, 'renamed_09994');
    await isolated.runtime.pool.query(`update accounts set status='disabled' where id='p09993'`);
    assert.equal((await read('followers', 'hub', 100))?.items.some((row) => row.profileId === 'p09993'), false);
    await isolated.runtime.pool.query(`delete from profile_handles where account_id='p09992'`);
    assert.equal((await read('followers', 'hub', 100))?.items.some((row) => row.profileId === 'p09992'), false);
    await isolated.runtime.pool.query(`delete from profiles where account_id='p09991'`);
    assert.equal((await read('followers', 'hub', 100))?.items.some((row) => row.profileId === 'p09991'), false);
    await isolated.runtime.pool.query(`delete from profile_handles where account_id='target-deleted'`);
    assert.equal(await read('followers', 'target-deleted', 10), null);
    await isolated.runtime.pool.query(`insert into profile_handles(handle,account_id) values ('handle_target-deleted','target-deleted');
      update accounts set status='deleted',deleted_at=now() where id='target-deleted'`);
    assert.equal(await read('followers', 'target-deleted', 10), null);
    await isolated.runtime.pool.query(`delete from profiles where account_id='target-profile-deleted'`);
    assert.equal(await read('following', 'target-profile-deleted', 10), null);
    await isolated.runtime.pool.query(`update accounts set status='active' where id='p09993';
      insert into profiles(account_id,display_name) values ('p09991','Display p09991');
      insert into profiles(account_id,display_name) values ('target-profile-deleted','Display target-profile-deleted');
      insert into profile_handles(handle,account_id) values ('handle_p09992','p09992');
      insert into follows(actor_profile_id,target_profile_id,followed_at) values
        ('p09993','hub','2026-07-01'::timestamptz+9993*interval '1 second'),
        ('hub','p09993','2026-07-02'::timestamptz+9993*interval '1 second'),
        ('p09991','hub','2026-07-01'::timestamptz+9991*interval '1 second'),
        ('hub','p09991','2026-07-02'::timestamptz+9991*interval '1 second')`);
  });

  test('traverses first, middle and final pages without duplicate or omission', async () => {
    for (const direction of ['followers', 'following'] as const) {
      const seen: string[] = []; let cursor: string | undefined; let pages = 0;
      do { const page = await application(direction, 'hub', 73, cursor); assert.ok(page); pages += 1;
        seen.push(...page.items.map((row) => row.profileId)); cursor = page.nextCursor ?? undefined; } while (cursor);
      assert.equal(seen.length, 9_996); assert.equal(new Set(seen).size, seen.length); assert.ok(pages > 3);
      const id = direction === 'followers' ? 'actor_profile_id' : 'target_profile_id';
      const fixed = direction === 'followers' ? 'target_profile_id' : 'actor_profile_id';
      const expected = (await isolated.runtime.pool.query<{ profile_id: string }>(
        `select ${id} profile_id from follows where ${fixed}='hub' order by followed_at desc,${id} desc`,
      )).rows.map((row) => row.profile_id);
      assert.deepEqual(seen, expected);
    }
  }, 120_000);

  test('live PostgreSQL pages exclude post-fence insertions and tolerate deletions', async () => {
    for (const direction of ['followers', 'following'] as const) {
      const actor = direction === 'followers' ? (id: string) => id : () => 'spare';
      const target = direction === 'followers' ? () => 'spare' : (id: string) => id;
      const ids = direction === 'followers'
        ? ['p00010', 'p00011', 'p00012', 'p00013', 'p00014']
        : ['p00020', 'p00021', 'p00022', 'p00023', 'p00024'];
      for (let index = 0; index < 4; index += 1) {
        await isolated.runtime.pool.query(
          `insert into follows(actor_profile_id,target_profile_id,followed_at) values ($1,$2,$3)`,
          [actor(ids[index]!), target(ids[index]!), new Date(Date.UTC(2026, 6, 20, 0, 0, 4 - index))],
        );
      }
      const first = await application(direction, 'spare', 2);
      assert.ok(first);
      await isolated.runtime.pool.query(
        `insert into follows(actor_profile_id,target_profile_id,followed_at) values ($1,$2,$3)`,
        [actor(ids[4]!), target(ids[4]!), new Date(Date.UTC(2026, 6, 20, 0, 0, 10))],
      );
      await isolated.runtime.pool.query(
        `delete from follows where actor_profile_id=$1 and target_profile_id=$2`,
        [actor(ids[2]!), target(ids[2]!)],
      );
      const final = await application(direction, 'spare', 2, first.nextCursor!);
      assert.ok(final);
      assert.deepEqual(first.items.map((row) => row.profileId), ids.slice(0, 2));
      assert.deepEqual(final.items.map((row) => row.profileId), [ids[3]]);
      assert.equal([...first.items, ...final.items].some((row) => row.profileId === ids[4]), false);
      await isolated.runtime.pool.query(
        `delete from follows where actor_profile_id=$1 or target_profile_id=$1`, ['spare'],
      );
    }
  });

  test('first/middle/final plans use Follow tuple indexes without Sort/Follow Seq Scan and stay in budget', async () => {
    for (const direction of ['followers', 'following'] as const) {
      const id = direction === 'followers' ? 'actor_profile_id' : 'target_profile_id';
      const fixed = direction === 'followers' ? 'target_profile_id' : 'actor_profile_id';
      const index = direction === 'followers' ? 'follows_target_page_idx' : 'follows_actor_page_idx';
      for (const offset of [null, 5_000, 9_900] as const) {
        const boundary = offset === null ? null : (await isolated.runtime.pool.query<{ followed_at: Date; profile_id: string }>(
          `select followed_at,${id} profile_id from follows where ${fixed}='hub' order by followed_at desc,${id} desc offset $1 limit 1`, [offset])).rows[0]!;
        const statement = buildFollowPageStatement({ targetProfileId: 'hub', limit: 100,
          ...(boundary ? { after: { followedAt: boundary.followed_at, profileId: boundary.profile_id } } : {}) }, direction);
        const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': string }>(`explain (analyze,buffers,format text)
          ${statement.text}`, [...statement.values]);
        const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
        assert.match(text, new RegExp(index)); assert.doesNotMatch(text, /Seq Scan on follows/i);
        assert.doesNotMatch(text, /^\s*Sort\s/m); const ms = Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1]);
        assert.ok(ms <= 250, `${direction}/${offset ?? 'first'} ${ms}ms\n${text}`);
        console.info(`[P5-04 plan] ${direction}/${offset ?? 'first'}; profiles>=10000; follows>=100000\n${text}`);
      }
    }
  }, 120_000);

  async function application(direction: 'followers'|'following', targetProfileId: string, limit: number, cursor?: string) {
    const unit = createUnitOfWork(isolated.runtime.db, { isolationLevel: 'read committed' });
    return unit.execute(async ({ transaction }) => {
      const cursors = createFollowCursorKeyring({
        active: { id: 'test', secret: Buffer.alloc(32, 4).toString('base64') }, retained: [],
      });
      try {
        return await queryFollowRelations({ reads: createPostgresFollowPageReadPort(transaction), cursors,
          clock: { now: async () => new Date('2026-07-29T00:00:00Z') } }, { principalId: 'viewer', targetProfileId,
          direction, limit, ...(cursor ? { cursor } : {}) });
      } finally { cursors.destroy(); }
    });
  }
  async function read(direction: 'followers'|'following', target: string, limit: number) { return application(direction, target, limit); }

  async function seed() {
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status,email)
      select 'p'||lpad(i::text,5,'0'),'s'||i,'active','secret-'||i||'@example.test' from generate_series(1,9996) i
      union all values ('hub','s-hub','active','hub-secret@example.test'),
        ('target-deleted','s-del','active','del@example.test'),
        ('target-profile-deleted','s-profile-del','active','profile-del@example.test'),
        ('spare','s-spare','active','spare@example.test')`);
    await isolated.runtime.pool.query(`insert into profiles(account_id,display_name,avatar_url)
      select id,'Display '||id,case when id='p00001' then 'https://cdn.example.test/a.png' else null end from accounts`);
    await isolated.runtime.pool.query(`insert into profile_handles(handle,account_id) select 'handle_'||id,id from accounts`);
    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
      select id,'hub','2026-07-01'::timestamptz+(substring(id from 2)::int||' seconds')::interval from accounts where id like 'p%';
      insert into follows(actor_profile_id,target_profile_id,followed_at)
      select 'hub',id,'2026-07-02'::timestamptz+(substring(id from 2)::int||' seconds')::interval from accounts where id like 'p%';
      insert into follows(actor_profile_id,target_profile_id,followed_at)
      select 'p'||lpad(actor::text,5,'0'),'p'||lpad((((actor+distance-1)%9996)+1)::text,5,'0'),
        '2026-06-01'::timestamptz+(actor*10+distance)*interval '1 second'
      from generate_series(1,9996) actor cross join generate_series(1,10) distance;
      analyze follows; analyze accounts; analyze profiles; analyze profile_handles`);
    const size = (await isolated.runtime.pool.query<{ profiles: number; follows: number }>(
      `select (select count(*)::int from profiles) profiles,(select count(*)::int from follows) follows`,
    )).rows[0]!;
    assert.ok(size.profiles >= 10_000); assert.ok(size.follows >= 100_000);
  }
});
