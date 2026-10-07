import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-02 Follow authority query-plan baseline', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_follow_plan', {
      maxConnections: 4,
      statementTimeoutMs: 120_000,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedBaseline();
  }, 180_000);
  afterAll(async () => isolated?.close());

  test('uses actor and target tuple indexes without Sort or Follow Seq Scan on first/middle/final pages', async () => {
    const followingMiddle = await followingBoundary(5_000);
    const followingFinal = await followingBoundary(9_900);
    const followersMiddle = await followersBoundary(5_000);
    const followersFinal = await followersBoundary(9_900);
    const measurements = [
      { label: 'following-first', index: 'follows_actor_page_idx', sql: followingSql(null) },
      { label: 'following-middle', index: 'follows_actor_page_idx', sql: followingSql(followingMiddle) },
      { label: 'following-final', index: 'follows_actor_page_idx', sql: followingSql(followingFinal) },
      { label: 'followers-first', index: 'follows_target_page_idx', sql: followersSql(null) },
      { label: 'followers-middle', index: 'follows_target_page_idx', sql: followersSql(followersMiddle) },
      { label: 'followers-final', index: 'follows_target_page_idx', sql: followersSql(followersFinal) },
    ];
    for (const measurement of measurements) {
      const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': unknown }>(measurement.sql);
      const text = JSON.stringify(plan.rows);
      assert.match(text, new RegExp(measurement.index), `${measurement.label}: ${text}`);
      assert.doesNotMatch(text, /"Node Type":"Sort"/u, `${measurement.label}: ${text}`);
      assert.doesNotMatch(text, /"Node Type":"Seq Scan"[^}]*"Relation Name":"follows"/u,
        `${measurement.label}: ${text}`);
    }
  }, 120_000);

  function followingSql(boundary: FollowBoundary | null): string {
    const fence = boundary === null ? '' : `and (followed_at,target_profile_id) < (
      '${boundary.followedAt.toISOString()}'::timestamptz,'${boundary.profileId}')`;
    return `explain (analyze,buffers,format json)
      select target_profile_id,followed_at from follows
       where actor_profile_id='p00000' ${fence}
       order by followed_at desc,target_profile_id desc limit 100`;
  }

  function followersSql(boundary: FollowBoundary | null): string {
    const fence = boundary === null ? '' : `and (followed_at,actor_profile_id) < (
      '${boundary.followedAt.toISOString()}'::timestamptz,'${boundary.profileId}')`;
    return `explain (analyze,buffers,format json)
      select actor_profile_id,followed_at from follows
       where target_profile_id='p00000' ${fence}
       order by followed_at desc,actor_profile_id desc limit 100`;
  }

  async function followingBoundary(offset: number): Promise<FollowBoundary> {
    const row = (await isolated.runtime.pool.query<{ followed_at: Date; profile_id: string }>(`
      select followed_at,target_profile_id profile_id from follows
       where actor_profile_id='p00000'
       order by followed_at desc,target_profile_id desc offset $1 limit 1`, [offset])).rows[0];
    assert.ok(row);
    return { followedAt: row.followed_at, profileId: row.profile_id };
  }

  async function followersBoundary(offset: number): Promise<FollowBoundary> {
    const row = (await isolated.runtime.pool.query<{ followed_at: Date; profile_id: string }>(`
      select followed_at,actor_profile_id profile_id from follows
       where target_profile_id='p00000'
       order by followed_at desc,actor_profile_id desc offset $1 limit 1`, [offset])).rows[0];
    assert.ok(row);
    return { followedAt: row.followed_at, profileId: row.profile_id };
  }

  async function seedBaseline(): Promise<void> {
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status)
      select 'p'||lpad(i::text,5,'0'),'subject-p'||lpad(i::text,5,'0'),'active'
        from generate_series(0,9999) i`);
    await isolated.runtime.pool.query(`insert into profiles(account_id,display_name)
      select id,id from accounts where id like 'p%'`);
    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
      select 'p'||lpad(actor::text,5,'0'),
             'p'||lpad(((actor+distance)%10000)::text,5,'0'),
             '2026-01-01T00:00:00Z'::timestamptz + ((actor*10+distance)||' seconds')::interval
        from generate_series(0,9999) actor cross join generate_series(1,10) distance`);
    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
      select 'p00000','p'||lpad(target::text,5,'0'),
             '2026-02-01T00:00:00Z'::timestamptz + (target||' seconds')::interval
        from generate_series(11,9999) target`);
    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
      select 'p'||lpad(actor::text,5,'0'),'p00000',
             '2026-03-01T00:00:00Z'::timestamptz + (actor||' seconds')::interval
        from generate_series(11,9999) actor
      on conflict do nothing`);
    await isolated.runtime.pool.query(`analyze follows`);
    const counts = (await isolated.runtime.pool.query<{ profiles: number; follows: number }>(`
      select (select count(*)::int from profiles where account_id like 'p%') profiles,
             (select count(*)::int from follows) follows`)).rows[0];
    assert.ok((counts?.profiles ?? 0) >= 10_000);
    assert.ok((counts?.follows ?? 0) >= 100_000);
  }
});

interface FollowBoundary {
  readonly followedAt: Date;
  readonly profileId: string;
}
